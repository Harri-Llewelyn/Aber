-- =============================================================================================
-- 0040_retire_demonstration_seed.sql
--
-- Removes the demonstration shopfloor (four `Sim_Gateway_*` rows, six `Sim_*` devices, their
-- birth parameters, and the cells they were the only occupants of) from databases that were
-- seeded before 0002 stopped seeding them. The demonstrator is a walkthrough in `tutorial/`.
--
-- WHY A MIGRATION AND NOT JUST AN EDIT TO 0002. 0002 is `ON CONFLICT ... DO NOTHING`
-- throughout, so deleting the rows from that file alone would leave every existing database
-- exactly as it was.
--
-- WHY THIS IS A ONE-SHOT. db-init replays every migration on every boot, and these rows are
-- rows an operator may deliberately recreate; a delete replayed on every boot would remove
-- them again while reporting success. So `one_shot_migrations` records that this file has run,
-- and the claim and the work are in one transaction: a delete that fails rolls the claim back
-- and the next boot retries. The marker is written whether or not any row was removed, which
-- is what makes it a ledger rather than an inference from state.
--
-- ORDER. 1. Capture the sparkplug ids and cell ids off the rows (`sparkplug_id` is generated;
-- deriving it here would duplicate the derivation). 2. Devices, then gateways:
-- `devices_gateway_id_fkey` is ON DELETE SET NULL, so the reverse order succeeds and appends a
-- spurious "gateway unbound" audit row per device first. 3. Birth parameters: `asset_config` is
-- keyed by the text `sparkplug_id` and nothing cascades. 4. The cells, by captured id and only
-- where empty, never by name. `device_submodels` and `device_nameplate` cascade.
--
-- The broker accounts outlive the rows: `gateway_holds_a_credential()` is false for a virtual,
-- unenrolled gateway, so the revoke trigger rotates nothing, and the credential service is
-- add-only. The accounts are confined by mosquitto.acl to a subtree nothing publishes to.
--
-- The deletes append to `digital_thread` (the purge is itself recorded); the improvement is to
-- every install from now on.
-- =============================================================================================

SET search_path TO public;

-- ---------------------------------------------------------------------------------------------
-- The ledger
-- ---------------------------------------------------------------------------------------------
-- Not `system_settings`: that is a closed set of keys an Administrator edits from the Settings
-- page, and a one-shot marker is not configuration. `key` is the filename of the migration that
-- claims it.
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
-- Asserts the end state, conditional on the claim: once the marker exists the floor is the
-- operator's, and recreating it is a supported state. So it asserts the retirement happened
-- exactly once and says nothing about what the operator has done since.
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
