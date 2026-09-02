-- =============================================================================================
-- 0040_retire_demonstration_seed.sql
--
-- Retires the demonstration shopfloor from the seed, so a fresh install comes up with no assets
-- at all and the four-cell floor becomes something a reader ASKS for.
--
-- The request came out of a demonstration: a participant asked whether the simulated devices
-- appear on every start, and said they polluted the Digital Thread.
--
-- WHAT GOES: the four `Sim_Gateway_*` rows and the six `Sim_*` devices that
-- `0002_seed_data.sql` used to seed, their birth parameters, and the cells they were the only
-- occupants of.
--
-- WHAT STAYS, and it is most of the demonstration's value:
--
--   * THE SCHEMAS -- UNTIL 0073, WHICH RETIRED THEM TOO. This entry was right while
--     `provision-gateways.mjs` existed to rebuild the floor; that script is gone and the
--     demonstrator is a walkthrough in `tutorial/` now. The reasoning below is kept as the record
--     of why they outlived the assets by one release.
--     `Simulated_CNC_01_Schema` and the four class schemas 0022 defined are
--     contracts, not assets. They cost nothing when unattached, they are what makes provisioning
--     the floor again a matter of creating rows rather than re-authoring five JSON Schemas, and
--     `prevent_active_schema_mutation()` makes an `active` schema effectively immutable anyway --
--     so deleting and re-creating one is a versioning event, not a cleanup.
--   * `digital_thread`. Append-only and immutable by design, and the deletes below APPEND to it
--     (trg_devices_digital_thread fires on DELETE). See the honesty note at the bottom.
--   * `metric_catalog`, `metric_groups` and the three vocabularies. Those are the platform's
--     vocabulary and have never been demonstration data.
--   * Historical telemetry in TimescaleDB, which is a different database reached over
--     postgres_fdw, is keyed by `sparkplug_id`, and ages out under its own retention policy.
--
-- WHERE THE FLOOR LIVED NEXT: `scripts/provision-gateways.mjs`, which created every one of these
-- rows when absent and was the only thing that COULD own them end to end, because a gateway row is
-- useless without the Mosquitto account it issues alongside. That script has since been retired
-- with the rest of the demonstrator -- `tutorial/README.md` walks a reader through building one
-- machine by hand instead, which is the same knowledge without the four-cell floor.
--
-- ---------------------------------------------------------------------------------------------
-- WHY A MIGRATION AND NOT JUST AN EDIT TO 0002 -- 0020's argument, unchanged
--
-- 0002 is `ON CONFLICT ... DO NOTHING` throughout: it inserts what is missing and never touches
-- what exists. Deleting the rows from that file alone would build a fresh database correctly and
-- leave every EXISTING one exactly as it was -- the demonstration floor still present, and now
-- with nothing in the repository explaining where it came from. So 0002's block is removed AND
-- this file exists; neither alone is sufficient.
--
-- ---------------------------------------------------------------------------------------------
-- WHY THIS ONE CANNOT BE IDEMPOTENT THE WAY EVERY OTHER MIGRATION HERE IS, WHICH IS THE WHOLE
-- REASON `one_shot_migrations` EXISTS
--
-- db-init replays every /migrations/*.sql on every boot and there is no applied-migrations
-- ledger, so the house rule is that a migration must match no rows on its second run rather than
-- fail. 0020 satisfies that trivially: it deleted assets that were dead, and nothing was ever
-- going to re-create them.
--
-- THIS DELETE IS DIFFERENT IN KIND, because the rows it removes are rows an operator may
-- deliberately want back -- that is the entire point of making the floor opt-in. A delete
-- replayed on every boot would make `npm run provision:gateways` USELESS: provision the floor,
-- restart the stack, and it is gone again, with the migration that removed it reporting success
-- both times. "Idempotent" would be satisfied and the feature would be destroyed.
--
-- WHY NOT INFER IT FROM STATE INSTEAD. Two candidates were considered and both are wrong:
--
--   * `digital_thread` already records a DELETE for these ids, so "have I deleted this before?"
--     looks answerable without a new table. It is not: on a FRESH install there is nothing to
--     delete, so this migration leaves no trace, and the operator's first provisioning run would
--     then be purged by the next boot. The marker has to be written whether or not any row was
--     removed, which is precisely what "a ledger" means.
--   * "Only delete rows that look untouched" (no cell, never seen a birth) distinguishes seeded
--     rows from provisioned ones only by accident -- provisioning happens to set `cell_id` at
--     INSERT. A guard that works for a reason nobody intended is a guard that stops working.
--
-- So the marker is explicit, and the claim is what BRANCHES: the INSERT below either writes a row
-- (first run -- do the work) or conflicts (already applied -- do nothing). Both halves are in one
-- DO block and therefore one transaction, so a delete that fails rolls the claim back with it and
-- the next boot retries. A claim committed separately from the work it guards would be a
-- migration that can silently half-apply exactly once.
--
-- ---------------------------------------------------------------------------------------------
-- THE ORDER IS A DEPENDENCY, and it is not the one 0020 gives
--
--   1. CAPTURE the sparkplug ids and cell ids first, off the rows themselves. `sparkplug_id` is a
--      GENERATED column and deriving it here would duplicate the derivation in a second place --
--      the mistake `provision-gateways.mjs` documents at length and refuses to make.
--   2. DEVICES, then GATEWAYS. 0020 says the reverse order fails on the foreign key; on this
--      constraint it does not -- `devices_gateway_id_fkey` is ON DELETE SET NULL, so deleting a
--      gateway first SUCCEEDS and rewrites every device's `gateway_id` to NULL on the way. That
--      is worse than an error: each rewrite fires log_digital_thread_event() and appends an
--      UPDATE row to an append-only audit table, so the wrong order leaves six spurious "gateway
--      unbound" events in the Digital Thread immediately before the deletes that made them
--      meaningless.
--   3. BIRTH PARAMETERS. `asset_config` is keyed by the TEXT `sparkplug_id` and not by a foreign
--      key, so nothing cascades and these rows would otherwise outlive the devices forever --
--      invisible, because every reader joins through a device row that no longer exists. This is
--      0020's closing trap and it applies here unchanged.
--   4. THE CELLS, and ONLY where the rows just deleted were their last occupants. Addressed by
--      the ids captured in step 1, never by name: the cells were created BY NAME by provisioning
--      and an operator may have renamed one, and a name-matched delete would remove whatever
--      happened to be called `Cell 1 -- Precision Machining` today. Guarded on emptiness so a
--      cell into which real plant has been placed is left exactly as it is.
--
-- `device_submodels` and `device_nameplate` both cascade from the device row and need no step.
--
-- ---------------------------------------------------------------------------------------------
-- THE BROKER ACCOUNTS OUTLIVE THE ROWS, AND THAT IS NOT AN OVERSIGHT
--
-- 0038 makes deleting a gateway revoke its broker credential, and `trg_gateways_revoke_credential_
-- delete` fires BEFORE DELETE -- so the obvious reading is that this migration rotates four
-- Mosquitto accounts on its way past. IT DOES NOT: `gateway_holds_a_credential()` is
-- `NOT is_virtual AND enrolled_at IS NOT NULL`, and every one of these rows is `is_virtual = true`
-- with no enrolment. The guard is there so revocation cannot CREATE an account by rotating one
-- that never existed, and by that definition a simulator gateway holds nothing.
--
-- So four accounts remain in the password file with no row behind them. They are harmless --
-- `mosquitto.acl` confines each to `spBv1.0/+/+/%u/#`, which is now a subtree nothing publishes to
-- and no device is bound to -- and SQL could not remove them anyway: the credential service is
-- add-only by design, which is exactly why 0038 revokes by ROTATING rather than deleting.
--
-- THE CONSEQUENCE THAT WILL BE FELT is on the way back. `npm run provision:gateways` re-creates
-- these rows at the same pinned ids, so it sees a NEW gateway and issues a NEW password for each,
-- replacing the account. Node-RED is then holding four passwords the broker no longer accepts, and
-- nothing fails at that moment -- the rows are all correct and provisioning reports success. The
-- symptom arrives later as four `Connection failed to broker` lines with no CONNACK code. Fold
-- `.env.gateways` into `.env` and restart Node-RED, which is what `scripts/stack-reset.mjs` does.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT THIS DOES NOT PROMISE, stated because it would otherwise be assumed
--
-- Retiring the seed does not make an EXISTING Digital Thread quieter. The log is immutable and
-- these deletes append to it, so on a stack that has already run, this makes the log slightly
-- longer before it makes it shorter -- the purge is itself recorded, which is what an audit trail
-- is for. The improvement is to every install FROM NOW ON, which is what was actually asked for.
-- =============================================================================================

SET search_path TO public;

-- ---------------------------------------------------------------------------------------------
-- The ledger
-- ---------------------------------------------------------------------------------------------
-- Deliberately not `system_settings`. That table is a CLOSED set of keys an Administrator can
-- edit from the Settings page, and 0031's rule is that every key has a code consumer -- a row no
-- code reads "is not configuration, it is a note that looks like configuration". A one-shot
-- marker is neither: nothing in the application reads it, and rendering it as a toggle would
-- offer an operator a switch labelled "un-retire the demonstration seed" that does nothing of the
-- kind.
--
-- `key` is the FILENAME of the migration that claims it. Anything shorter invites two migrations
-- to pick the same word.
CREATE TABLE IF NOT EXISTS public.one_shot_migrations (
    key        text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now(),
    note       text
);

COMMENT ON TABLE public.one_shot_migrations IS
  'Ledger for migrations that must run exactly once, rather than on every boot like the rest of '
  'the chain. Claimed by INSERT ... ON CONFLICT DO NOTHING inside the same transaction as the '
  'work it guards.';

-- RLS with no policy at all, which denies every request that does not bypass it. This table is
-- infrastructure: no page reads it, PostgREST has no business exposing it, and a SELECT policy
-- would be inventing a consumer to justify a grant.
ALTER TABLE public.one_shot_migrations ENABLE ROW LEVEL SECURITY;

-- REVOKE BEFORE ANYTHING ELSE, for the reason 0031 spells out: this database carries a blanket
-- GRANT to anon and authenticated on the public schema, so a new table arrives already reachable
-- and "granted nothing" is not the default state.
REVOKE ALL ON public.one_shot_migrations FROM anon;
REVOKE ALL ON public.one_shot_migrations FROM authenticated;
GRANT ALL ON public.one_shot_migrations TO service_role;


-- ---------------------------------------------------------------------------------------------
-- The retirement
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  -- The floor, by pinned id. These are `provision-gateways.mjs`'s GATEWAYS literal, and
  -- scripts/check-docs-drift.mjs asserts the two lists are the same set -- a gateway added there
  -- and missed here would survive a retirement that reported success.
  v_gateway_ids CONSTANT uuid[] := ARRAY[
    '12000000-0000-4000-8000-000000000001',  -- Sim_Gateway_Cell1_Machining
    '13000000-0000-4000-8000-000000000001',  -- Sim_Gateway_Cell2_Robotics
    '14000000-0000-4000-8000-000000000001',  -- Sim_Gateway_Cell3_OEE
    '15000000-0000-4000-8000-000000000001'   -- Sim_Gateway_Site_BMS
  ]::uuid[];
  v_device_ids CONSTANT uuid[] := ARRAY[
    '22000000-0000-4000-8000-000000000001',  -- Sim_CNC_Mill_01
    '23000000-0000-4000-8000-000000000001',  -- Sim_CNC_Mill_02
    '27000000-0000-4000-8000-000000000001',  -- Sim_Tool_Changer_01
    '24000000-0000-4000-8000-000000000001',  -- Sim_Robot_Arm_01
    '25000000-0000-4000-8000-000000000001',  -- Sim_Cell3_Aggregator
    '26000000-0000-4000-8000-000000000001'   -- Sim_BMS_Zone_HVAC
  ]::uuid[];

  v_claimed   INTEGER;
  v_applied   timestamptz;
  v_spids     text[];
  v_cell_ids  uuid[];
  v_devices   INTEGER;
  v_gateways  INTEGER;
  v_config    INTEGER;
  v_cells     INTEGER;
BEGIN
  -- THE CLAIM, AND THE BRANCH. See the header: this is the one migration in the chain whose
  -- second run must do nothing because it ALREADY RAN, not because it happens to match no rows.
  INSERT INTO public.one_shot_migrations (key, note)
  VALUES (
    '0040_retire_demonstration_seed',
    'Removed the seeded four-cell demonstration floor. Re-create it with '
    '`npm run provision:gateways`.'
  )
  ON CONFLICT (key) DO NOTHING;
  GET DIAGNOSTICS v_claimed = ROW_COUNT;

  IF v_claimed = 0 THEN
    SELECT applied_at INTO v_applied
      FROM public.one_shot_migrations WHERE key = '0040_retire_demonstration_seed';
    RAISE NOTICE '0040: already applied at %; the demonstration floor is now owned by '
                 'provision-gateways.mjs and is not touched again.', v_applied;
    RETURN;
  END IF;

  -- 1. CAPTURE. Read back rather than derived -- `sparkplug_id` is GENERATED, and a second
  -- derivation of it is how the two drift. Cell ids are captured from both tables because a
  -- gateway and its devices are placed independently; `location_scope = 'site_wide'` rows have
  -- none, which array_agg simply omits.
  SELECT coalesce(array_agg(sparkplug_id), '{}'::text[]),
         coalesce(array_agg(cell_id) FILTER (WHERE cell_id IS NOT NULL), '{}'::uuid[])
    INTO v_spids, v_cell_ids
    FROM public.devices WHERE id = ANY(v_device_ids);

  SELECT v_cell_ids || coalesce(array_agg(cell_id) FILTER (WHERE cell_id IS NOT NULL), '{}'::uuid[])
    INTO v_cell_ids
    FROM public.gateways WHERE id = ANY(v_gateway_ids);

  -- 2. DEVICES BEFORE GATEWAYS -- see the header. Not because the reverse fails, but because it
  -- succeeds and appends six pointless UPDATE rows to the audit trail on the way past.
  DELETE FROM public.devices WHERE id = ANY(v_device_ids);
  GET DIAGNOSTICS v_devices = ROW_COUNT;

  DELETE FROM public.gateways WHERE id = ANY(v_gateway_ids);
  GET DIAGNOSTICS v_gateways = ROW_COUNT;

  -- 3. THE ORPHANED BIRTH PARAMETERS. Scoped to the captured ids and run AFTER the delete, so it
  -- cannot remove the birth parameters of a device that still exists.
  DELETE FROM public.asset_config WHERE asset_id = ANY(v_spids);
  GET DIAGNOSTICS v_config = ROW_COUNT;

  -- 4. THE CELLS THE FLOOR LEFT EMPTY. By captured id, and only if nothing is left in them.
  DELETE FROM public.cells c
   WHERE c.id = ANY(v_cell_ids)
     AND NOT EXISTS (SELECT 1 FROM public.devices  d WHERE d.cell_id = c.id)
     AND NOT EXISTS (SELECT 1 FROM public.gateways g WHERE g.cell_id = c.id);
  GET DIAGNOSTICS v_cells = ROW_COUNT;

  RAISE NOTICE '0040: retired the demonstration floor -- % device(s), % gateway(s), '
               '% orphaned asset_config row(s), % now-empty cell(s).',
               v_devices, v_gateways, v_config, v_cells;
END;
$$;


-- ---------------------------------------------------------------------------------------------
-- Self-check
-- ---------------------------------------------------------------------------------------------
-- Asserts the END STATE, which is what the next boot has to be able to assume -- and it is
-- CONDITIONAL ON THE CLAIM, which is the one thing that distinguishes this file from every other
-- self-check in the chain.
--
-- The condition is not defensive vagueness. Once the marker exists, the floor is the operator's:
-- `npm run provision:gateways` puts every one of these rows back at the same pinned ids, and that
-- is a SUPPORTED state, not a failed retirement. An unconditional "these ids must not exist"
-- would turn using the feature into a failed boot -- which is the same mistake as an unconditional
-- delete, just discovered one migration later.
--
-- So it asserts the retirement happened at all, exactly once, and says nothing about what the
-- operator has done since.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.one_shot_migrations WHERE key = '0040_retire_demonstration_seed'
  ) THEN
    RAISE EXCEPTION
      '0040 self-check: the retirement was never claimed, so the DO block above neither deleted '
      'the demonstration floor nor recorded that it had. A fresh install would come up seeded.';
  END IF;

  RAISE NOTICE '0040 self-check passed: the demonstration floor is opt-in from here on.';
END;
$$;

NOTIFY pgrst, 'reload schema';
