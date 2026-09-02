-- =============================================================================================
-- 0020_cleanup_legacy_simulator_seed.sql
--
-- Retires the introductory single-device simulator -- `Virtual_Gateway_NodeRED` and
-- `Simulated_CNC_01` -- and moves what hung off it onto `Sim_CNC_Mill_01`, the machining cell's
-- first CNC on the `Simulated Shopfloor` flow.
--
-- WHY THEY GO AT ALL. They described a stack that no longer exists. The flow was consolidated onto
-- one tab of four cell gateways and six `Sim_`-prefixed devices, and nothing has published under
-- `dev200000000000400080000` since. What was left was a gateway permanently OFFLINE and a device
-- permanently quarantined, sitting at the top of the shopfloor map and the quarantine queue,
-- describing hardware that was never there -- and, worse, a device the AAS conformance suite
-- still targeted by name, so the one asset the export was proved against was the one asset that
-- had stopped receiving a DBIRTH.
--
-- ---------------------------------------------------------------------------------------------
-- WHY A MIGRATION AND NOT JUST AN EDIT TO 0002
--
-- 0002 uses ON CONFLICT ... DO NOTHING throughout: it inserts what is missing and never touches
-- what exists. Deleting the rows from that file alone would build a fresh database correctly and
-- leave every existing one exactly as it was -- the legacy pair still present, and now with
-- nothing in the repository explaining where they came from.
--
-- ---------------------------------------------------------------------------------------------
-- FOUR THINGS, IN THIS ORDER, AND THE ORDER IS A DEPENDENCY
--
--   1. ATTACH the tri-standard schema to Sim_CNC_Mill_01. Before the delete, so that at no point
--      between the two is the schema attached to nothing.
--   2. SEED the device's IDTA Digital Nameplate. This CANNOT live in 0002: `device_nameplate` is
--      created by 0011, and 0002 runs nine migrations earlier against a table that does not yet
--      exist. Seeding it here is the only ordering that works on a fresh database.
--   3. DELETE the legacy device, then the legacy gateway. Device first: `devices.gateway_id`
--      references the gateway, so the reverse order fails on the foreign key.
--   4. PURGE the orphaned birth parameters. `asset_config` is keyed by the TEXT `sparkplug_id`,
--      not by a foreign key to `devices`, so nothing cascades and those rows would otherwise
--      outlive the device forever -- invisible, since every reader joins through a device row
--      that no longer exists.
--
-- WHAT IS DELIBERATELY NOT DELETED:
--
--   * `digital_thread`. It is append-only and immutable by design, and the history of a device
--      that once existed is exactly what an audit trail is for. The deletes below APPEND to it
--      (trg_devices_digital_thread fires on DELETE), which is the correct outcome: the purge is
--      itself recorded.
--   * The `Simulated_CNC_01_Schema` row. It is being re-pointed, not retired -- see 0002.
--   * Historical telemetry in TimescaleDB. It lives in a different database reached over
--      postgres_fdw and is keyed by `dev200000000000400080000`; a Supabase migration cannot
--      transactionally delete it, and it ages out under the retention policy on its own.
--
-- Idempotent: db-init replays every migration on every boot with ON_ERROR_STOP=1 and there is no
-- applied-migrations ledger, so the second run must match no rows rather than fail.
-- =============================================================================================

SET search_path TO public;

DO $$
DECLARE
  v_legacy_gateway CONSTANT uuid := '10000000-0000-4000-8000-000000000001';
  v_legacy_device  CONSTANT uuid := '20000000-0000-4000-8000-000000000002';
  v_legacy_spid    CONSTANT text := 'dev200000000000400080000';
  v_target_device  CONSTANT uuid := '22000000-0000-4000-8000-000000000001';
  v_schema         CONSTANT uuid := 'e3333333-4444-5555-6666-777777777777';
  v_attached       INTEGER := 0;
  v_fallback       INTEGER := 0;
  v_nameplate      INTEGER := 0;
  v_devices        INTEGER;
  v_gateways       INTEGER;
  v_config         INTEGER;
BEGIN
  -- 1. THE ATTACHMENT, guarded on both rows existing.
  --
  -- The device may legitimately be absent: 0002 seeds it, but a database can be mid-upgrade, and
  -- a missing device here is not a reason to fail a boot. The schema may be absent for the same
  -- reason. Both are checked rather than assumed, because an INSERT against either would raise a
  -- foreign-key violation that db-init reports as a failed migration.
  IF EXISTS (SELECT 1 FROM public.devices WHERE id = v_target_device)
     AND EXISTS (SELECT 1 FROM public.schemas WHERE id = v_schema) THEN

    INSERT INTO public.device_submodels (device_id, schema_id, submodel_key)
    VALUES (v_target_device, v_schema, NULL)
    ON CONFLICT (device_id, schema_id) DO NOTHING;
    GET DIAGNOSTICS v_attached = ROW_COUNT;

    -- The 1:1 fallback arm as well as the join row. `device_schemas` unions the two, so either
    -- alone is sufficient for the exporter -- but a device provisioned by provision-gateways.mjs
    -- carries neither, and setting both means the attachment survives an operator detaching one.
    --
    -- IS DISTINCT FROM, so a boot that changes nothing writes nothing. log_digital_thread_event()
    -- has had a change guard since 0005 and would suppress the audit row anyway; this makes the
    -- statement itself a no-op rather than relying on the trigger to clean up after it.
    UPDATE public.devices
       SET schema_id = v_schema
     WHERE id = v_target_device
       AND schema_id IS DISTINCT FROM v_schema;
    GET DIAGNOSTICS v_fallback = ROW_COUNT;

    -- 2. THE NAMEPLATE.
    --
    -- WHY SEED ONE AT ALL, when the exporter prefers what the device publishes. Precisely because
    -- it prefers it: `nameplateProperty()` resolves published-value-first and falls back to this
    -- table, so seeding it changes nothing on a running stack where the CNC has sent its DBIRTH,
    -- and is the difference between a Nameplate submodel and an empty one on a stack where it has
    -- not. That second case is not hypothetical -- it is every CI run that brings up the database
    -- without the broker, and the AAS suite asserts SerialNumber and FirmwareVersion are present.
    --
    -- ON CONFLICT DO NOTHING: an operator who has edited this device's nameplate through the UI
    -- owns it from then on, and a migration replayed on every boot must not overwrite them.
    INSERT INTO public.device_nameplate (
      device_id, manufacturer_name, manufacturer_product_designation, manufacturer_product_type,
      serial_number, year_of_construction, hardware_version, firmware_version, country_of_origin
    ) VALUES (
      v_target_device,
      'ACS-Cymru Simulation',
      'Sim_CNC_Mill_01',
      '3-Axis Vertical Machining Centre (simulated)',
      'SIM-CNC-0001',
      '2026',
      'v1.0',
      'v2.4.1',
      'GB'
    )
    ON CONFLICT (device_id) DO NOTHING;
    GET DIAGNOSTICS v_nameplate = ROW_COUNT;
  END IF;

  -- 3. THE DELETES. Device before gateway -- devices.gateway_id references gateways(id).
  --
  -- BY PINNED ID, never by name. A name is a display label an operator may have changed, and
  -- deleting by one would purge whatever happened to be called `Simulated_CNC_01` today.
  -- device_submodels and device_nameplate both cascade from the device row.
  DELETE FROM public.devices WHERE id = v_legacy_device;
  GET DIAGNOSTICS v_devices = ROW_COUNT;

  DELETE FROM public.gateways WHERE id = v_legacy_gateway;
  GET DIAGNOSTICS v_gateways = ROW_COUNT;

  -- 4. THE ORPHANED BIRTH PARAMETERS.
  --
  -- Scoped to the legacy device's sparkplug_id and run AFTER the delete, so it cannot remove the
  -- birth parameters of a device that still exists.
  DELETE FROM public.asset_config WHERE asset_id = v_legacy_spid;
  GET DIAGNOSTICS v_config = ROW_COUNT;

  RAISE NOTICE '0020: attached % submodel row(s), set % schema fallback(s), seeded % nameplate(s); '
               'deleted % legacy device(s), % legacy gateway(s), % orphaned asset_config row(s).',
               v_attached, v_fallback, v_nameplate, v_devices, v_gateways, v_config;
END;
$$;


-- Self-check. The DO block reports what it changed; this asserts the END STATE, which is what the
-- next boot -- and the AAS conformance suite -- have to be able to assume.
--
-- The attachment assertion is CONDITIONAL on the device existing, and only that one is. The
-- legacy rows must be gone unconditionally; the attachment can only be asserted where there is
-- something to attach to, and a database mid-upgrade has not run 0002 yet.
DO $$
DECLARE
  v_target_device CONSTANT uuid := '22000000-0000-4000-8000-000000000001';
  v_schema        CONSTANT uuid := 'e3333333-4444-5555-6666-777777777777';
  v_left          INTEGER;
  v_schemas       INTEGER;
BEGIN
  SELECT count(*) INTO v_left
    FROM public.devices
   WHERE id = '20000000-0000-4000-8000-000000000002';
  IF v_left > 0 THEN
    RAISE EXCEPTION '0020 self-check: the legacy device Simulated_CNC_01 is still registered';
  END IF;

  SELECT count(*) INTO v_left
    FROM public.gateways
   WHERE id = '10000000-0000-4000-8000-000000000001';
  IF v_left > 0 THEN
    RAISE EXCEPTION '0020 self-check: the legacy gateway Virtual_Gateway_NodeRED is still registered';
  END IF;

  IF EXISTS (SELECT 1 FROM public.devices WHERE id = v_target_device) THEN
    -- THE ATTACHMENT ASSERTION IS GATED ON THE SCHEMA STILL EXISTING, exactly as the attach block
    -- above is, and 0073 is why. That migration retires `Simulated_CNC_01_Schema` along with the
    -- rest of the demonstration seed, so on a stack that was provisioned before the retirement the
    -- device outlives its schema -- and this check ran BEFORE 0073 in the chain, failing db-init on
    -- the second boot over a row the chain itself had deliberately removed on the first.
    --
    -- Asserted where the schema is present, which is the case it was written for: a database
    -- mid-upgrade that has 0002's schema and must not lose the attachment to it.
    IF EXISTS (SELECT 1 FROM public.schemas WHERE id = v_schema) THEN
      -- Through the VIEW, not the table: `device_schemas` is what the exporter reads, and asserting
      -- on device_submodels alone would pass while the union the consumer actually sees was empty.
      SELECT count(*) INTO v_schemas
        FROM public.device_schemas
       WHERE device_id = v_target_device AND schema_id IS NOT NULL;
      IF v_schemas < 1 THEN
        RAISE EXCEPTION
          '0020 self-check: Sim_CNC_Mill_01 has no schema attached, so an AAS export would carry '
          'no telemetry or KPI submodel';
      END IF;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.device_nameplate WHERE device_id = v_target_device) THEN
      RAISE EXCEPTION '0020 self-check: Sim_CNC_Mill_01 has no nameplate row';
    END IF;
  END IF;

  RAISE NOTICE '0020 self-check passed: legacy simulator seed gone, Sim_CNC_Mill_01 carries its '
               'schema and nameplate.';
END;
$$;

NOTIFY pgrst, 'reload schema';
