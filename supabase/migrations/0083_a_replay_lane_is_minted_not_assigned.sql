-- 0083: a device cannot be posted onto the replay lane by hand.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- =================================================================================================
-- WHAT WAS WRONG (#144)
--
-- The dashboard offered the Playback gateway in its "Assigned Edge Gateway" pickers -- three of
-- them, on the Devices tab, the quarantine approval modal and the schema builder. Choosing it did
-- exactly what the operator asked: it wrote `devices.gateway_id`, and the device appeared, badged
-- Shadow, on the replay lane.
--
-- The badge was not wrong. `is_shadow` is a property of the GATEWAY and devices inherit it through
-- `gateway_id` (archived migration 0052 forbids a device-level copy), so a device on that gateway
-- IS on the shadow lane and every reader was right to say so. What was wrong is that it had no
-- `shadow_of`, and archived migration 0060 names that state precisely while explaining why a
-- capture naming an unknown device is refused rather than given an anonymous lane:
--
--     "a shadow with no `shadow_of` is an asset with no provenance, which is the thing this
--      design exists to avoid creating."
--
-- The dashboard was creating it. Not through the playback path, which cannot -- ensure_shadow_devices()
-- sets `gateway_id` and `shadow_of` in one INSERT and has no branch that omits the second -- but
-- around it, through the ordinary device form, which knew nothing about any of this.
--
-- WHY THAT IS WORSE THAN AN UNTIDY ROW. A replay lane is what a playback publishes as, and the
-- lane's whole claim is "these readings are genuine but were observed elsewhere, at another time".
-- A lane standing in for nothing makes that claim about no machine. Downstream:
--
--   * `device_locations` resolves it to the Shadow lane, so it is a thing on no shopfloor which
--     nothing on the shopfloor explains;
--   * the AAS export emits a shell for it -- an Asset Administration Shell asserting an asset
--     identity that corresponds to no asset, which is the one thing AAS identity exists to prevent;
--   * `uq_devices_shadow_per_gateway` is partial (`WHERE shadow_of IS NOT NULL`), so the row is not
--     even covered by the index that makes lanes one-per-machine. Any number of them can pile up.
--
-- None of that raises. The stack behaves; the model quietly stops meaning what it says.
--
-- =================================================================================================
-- THE GATE IS ON ARRIVAL, AND ONLY ON ARRIVAL. THIS IS THE SUBTLE PART.
--
-- The obvious rule -- "a device on a shadow gateway must have shadow_of" -- is WRONG, and enforcing
-- it would break a deletion that archived migration 0060 deliberately allows. `devices_shadow_of_fkey`
-- is ON DELETE SET NULL, chosen over CASCADE with its reasoning stated:
--
--     "A shadow outliving its original is a lane whose label has gone vague, which is recoverable;
--      CASCADE would delete the lane and orphan every telemetry row keyed on its sparkplug_id in
--      TimescaleDB, which is not."
--
-- So a lane whose original has been deleted has `shadow_of IS NULL` while sitting on the shadow
-- gateway, and that is a LEGAL, INTENDED state. The FK reaches it by UPDATE-ing the referencing
-- row, which fires triggers -- so a blanket check would have made deleting any shadowed device
-- fail, with an error about provenance pointing at a delete that had nothing to do with it.
--
-- The invariant is therefore narrower than it first looks, and it is about the ACT rather than the
-- state: a device may not be MOVED ONTO the replay lane without provenance. Arriving there is
-- minted, by ensure_shadow_devices(); ending up there is not something an operator does.
--
--   INSERT                          -> checked.
--   UPDATE that changes gateway_id  -> checked.
--   UPDATE that leaves it alone     -> not our business (this is the FK's path, and the operator
--                                      editing a lane's name or schema).
--
-- =================================================================================================
-- WHY A TRIGGER AND NOT A CHECK CONSTRAINT
--
-- A CHECK cannot see another table, and `is_shadow` lives on `gateways`. The alternative is a
-- denormalised copy of the flag onto `devices`, which archived migrations 0052 and 0059 both
-- forbid for the reason that a stored copy can disagree with its source -- and a guard reading a
-- stale copy is worse than no guard, because it reports having checked.
--
-- WHY NOT ONLY FIX THE THREE PICKERS. They are fixed too, and should be: an operator should not be
-- offered a choice that will be refused. But `devices` is writable through PostgREST by any
-- Administrator or Shopfloor_Manager (`devices_update_privileged`), so the pickers are three of an
-- unbounded number of doors. This is the one that holds for the fourth. It is the same argument
-- archived migration 0060 made for putting its own gate on `playback_jobs` in a trigger rather than
-- inside start_playback_job(): "it holds for a future writer that forgets".
--
-- INVOKER RIGHTS, NOT SECURITY DEFINER, and deliberately: `gateways_select_authenticated` is
-- `USING (true)`, so every authenticated caller can already read every gateway row and the lookup
-- below cannot be blinded by RLS. SECURITY DEFINER would buy nothing and would widen what this
-- function can reach.
--
-- Related: archived migration 0052 (devices carry no synthetic flag of their own),
--          archived migration 0059 (is_shadow and the Shadow lane),
--          archived migration 0060 (the Playback gateway, ensure_shadow_devices(), shadow_of),
--          supabase/migrations/test_shadow_lane_is_not_assignable.py (this file's suite),
--          frontend/src/utils/gatewayType.js gatewayAcceptsDevices() (the picker half).
-- =================================================================================================


-- -------------------------------------------------------------------------------------------
-- The gate
-- -------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refuse_hand_assigning_a_replay_lane() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
    v_gateway public.gateways;
BEGIN
    -- NOT AN ARRIVAL. `BEFORE UPDATE OF gateway_id` fires when the column is MENTIONED, not when
    -- it changes -- and PostgREST sends the whole row on a PATCH, so an operator renaming a lane
    -- mentions gateway_id every time. Without this the rename would be refused.
    IF TG_OP = 'UPDATE' AND NEW.gateway_id IS NOT DISTINCT FROM OLD.gateway_id THEN
        RETURN NEW;
    END IF;

    -- Unassigned is not a lane, and a device that HAS provenance is exactly what a lane is.
    IF NEW.gateway_id IS NULL OR NEW.shadow_of IS NOT NULL THEN
        RETURN NEW;
    END IF;

    SELECT * INTO v_gateway FROM public.gateways WHERE id = NEW.gateway_id;

    -- NOT FOUND IS LET THROUGH ON PURPOSE. `devices_gateway_id_fkey` is about to refuse this row
    -- and will name the missing gateway; raising here first would replace a precise foreign-key
    -- error with a confusing one about playback.
    IF NOT FOUND OR NOT v_gateway.is_shadow THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION
      'devices: % is a playback gateway, and a device cannot be assigned to one. Its devices are '
      'REPLAY LANES -- each stands in for a real machine, and which machine is recorded in '
      'shadow_of. A device placed here by hand would stand in for nothing: an asset with no '
      'provenance, exporting an Asset Administration Shell for a machine that does not exist. '
      'Lanes are minted by ensure_shadow_devices() when a capture is played, one per recorded '
      'device and reused across runs. To replay onto this gateway, start a playback from the '
      'capture instead.',
      v_gateway.name
        USING ERRCODE = 'check_violation';
END;
$$;

-- THE ACL, WHICH IS NOT OPTIONAL AND IS EASY TO FORGET. A new function is EXECUTE-able by PUBLIC
-- unless its migration revokes it, so without these two lines `anon` -- the unauthenticated role
-- PostgREST uses before any login -- holds EXECUTE on it. test_anon_privilege_baseline.py asserts
-- the whole public schema against an allow-list and caught precisely that on this file's first run,
-- which is a fair demonstration of why it now runs in CI (#147) rather than only by hand.
--
-- service_role ALONE IS ENOUGH, and this is the same grant log_digital_thread_event() and
-- sync_gateway_deployment() carry -- both of which fire on writes made by `authenticated`. A
-- trigger function is invoked by the trigger machinery, which does not check the writing role's
-- EXECUTE privilege; the privilege is checked when the trigger is CREATED, by the owner, above.
REVOKE ALL ON FUNCTION public.refuse_hand_assigning_a_replay_lane() FROM PUBLIC;
GRANT ALL ON FUNCTION public.refuse_hand_assigning_a_replay_lane() TO service_role;

COMMENT ON FUNCTION public.refuse_hand_assigning_a_replay_lane() IS
  'Refuses a device ARRIVING on a shadow gateway without shadow_of -- an INSERT, or an UPDATE that '
  'changes gateway_id. Deliberately silent about a device already there whose shadow_of has become '
  'NULL: devices_shadow_of_fkey is ON DELETE SET NULL, so that is the legal state of a lane whose '
  'original was deleted, and checking it would make that deletion fail. See 0083''s header.';


-- -------------------------------------------------------------------------------------------
-- Attach it
-- -------------------------------------------------------------------------------------------
-- `UPDATE OF gateway_id` rather than a bare UPDATE: the FK's ON DELETE SET NULL writes shadow_of
-- alone, so narrowing the event means the deletion path does not enter this function at all. The
-- distinctness check inside is still required -- see its comment -- but this keeps the FK's write
-- off the trigger entirely rather than relying on an early return.
DROP TRIGGER IF EXISTS trg_devices_replay_lane_is_minted ON public.devices;
CREATE TRIGGER trg_devices_replay_lane_is_minted
    BEFORE INSERT OR UPDATE OF gateway_id ON public.devices
    FOR EACH ROW EXECUTE FUNCTION public.refuse_hand_assigning_a_replay_lane();


-- -------------------------------------------------------------------------------------------
-- Self-check
-- -------------------------------------------------------------------------------------------
-- WHAT THIS ASSERTS AND WHY IT IS NOT THE SUITE. The Python suite exercises the behaviour; this
-- runs on every boot and asserts the gate is ATTACHED. A migration that applied cleanly while its
-- trigger failed to attach -- a rename upstream, a DROP in a later file -- would leave the door
-- open with every test still passing in CI, because CI applies the same chain and would be equally
-- wrong. 0053 and 0082 both put a self-check here for the same reason.
--
-- A NOTICE, NOT AN EXCEPTION, for the pre-existing rows: a stack that already has hand-assigned
-- lanes from before this migration must still boot. They are reported, not deleted -- deciding what
-- a provenance-less lane should become is an operator's call (it may have telemetry against it),
-- and a migration that silently removed device rows would be a far worse failure than the one it
-- is fixing.
DO $$
DECLARE
    v_orphans integer;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgname = 'trg_devices_replay_lane_is_minted'
           AND tgrelid = 'public.devices'::regclass
           AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION '0083 self-check: trg_devices_replay_lane_is_minted is not attached to '
                        'public.devices. A device could be posted onto the replay lane by hand.';
    END IF;

    SELECT count(*) INTO v_orphans
      FROM public.devices d
      JOIN public.gateways g ON g.id = d.gateway_id
     WHERE g.is_shadow AND d.shadow_of IS NULL;

    IF v_orphans > 0 THEN
        RAISE NOTICE '0083: % device(s) already sit on a playback gateway with no shadow_of. They '
                     'are left as found -- one may be a lane whose original was deleted, which is '
                     'legitimate. Review them on the Devices tab, filtered to the Playback '
                     'gateway.', v_orphans;
    ELSE
        RAISE NOTICE '0083 self-check: the gate is attached and no provenance-less replay lane exists.';
    END IF;
END $$;
