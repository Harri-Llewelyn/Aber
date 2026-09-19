-- 0083: a device cannot be posted onto the replay lane by hand.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- The device form's gateway pickers offered the Playback gateway, and choosing it wrote
-- `devices.gateway_id` without `shadow_of`: a shadow lane standing in for no machine, which
-- `device_locations` files on the Shadow lane, the AAS export emits a shell for, and
-- `uq_devices_shadow_per_gateway` (partial on `shadow_of IS NOT NULL`) does not cover.
--
-- THE GATE IS ON ARRIVAL ONLY. "A device on a shadow gateway must have shadow_of" is wrong:
-- `devices_shadow_of_fkey` is ON DELETE SET NULL, so a lane whose original was deleted legally
-- has `shadow_of IS NULL`, and the FK reaches that state by an UPDATE that fires triggers. The
-- invariant is about the act: INSERT and an UPDATE that changes gateway_id are checked; an UPDATE
-- that leaves it alone is not. Arriving on the lane is minted by ensure_shadow_devices().
-- Since 0124 a lane is deleted with its original (shadow_follows_its_original(), BEFORE DELETE),
-- so the FK's SET NULL is reached only by a lane whose original went before that, or by hand.
--
-- A trigger, not a CHECK: a CHECK cannot see `gateways.is_shadow`, and a denormalised copy of
-- the flag is forbidden. The pickers are fixed too, but `devices` is writable through PostgREST
-- by any Administrator or Shopfloor_Manager, so the pickers are three of an unbounded number of
-- doors. Invoker rights: `gateways_select_authenticated` is `USING (true)`, so the lookup cannot
-- be blinded by RLS.
--
-- Related: supabase/migrations/test_shadow_lane_is_not_assignable.py (this file's suite),
--          frontend/src/utils/gatewayType.js gatewayAcceptsDevices() (the picker half).

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

-- A new function is EXECUTE-able by PUBLIC (which includes `anon`) unless its migration revokes
-- it; test_anon_privilege_baseline.py asserts the whole public schema against an allow-list.
-- service_role alone is enough: a trigger function is invoked by the trigger machinery, which
-- does not check the writing role's EXECUTE privilege.
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
-- `UPDATE OF gateway_id` rather than a bare UPDATE, so the FK's ON DELETE SET NULL write to
-- shadow_of does not enter this function at all.
DROP TRIGGER IF EXISTS trg_devices_replay_lane_is_minted ON public.devices;
CREATE TRIGGER trg_devices_replay_lane_is_minted
    BEFORE INSERT OR UPDATE OF gateway_id ON public.devices
    FOR EACH ROW EXECUTE FUNCTION public.refuse_hand_assigning_a_replay_lane();

-- -------------------------------------------------------------------------------------------
-- Self-check
-- -------------------------------------------------------------------------------------------
-- Asserts the gate is attached on every boot; the Python suite exercises the behaviour. A
-- NOTICE, not an exception, for pre-existing hand-assigned lanes: they may have telemetry
-- against them, and what they should become is an operator's call.
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
