-- =============================================================================================
-- 0020_cleanup_legacy_simulator_seed.sql
--
-- Retires the introductory single-device simulator (`Virtual_Gateway_NodeRED` and
-- `Simulated_CNC_01`) and moves its schema attachment and nameplate onto `Sim_CNC_Mill_01`. A
-- migration rather than an edit to 0002 because 0002 is ON CONFLICT DO NOTHING throughout.
--
-- Order is a dependency: 1. attach the schema to the new device (so it is never attached to
-- nothing); 2. seed the nameplate here, because `device_nameplate` does not exist when 0002
-- runs; 3. delete the legacy device, then the gateway (`devices.gateway_id` references it);
-- 4. purge the orphaned birth parameters, since `asset_config` is keyed by the text
-- `sparkplug_id` and nothing cascades.
--
-- Not deleted: `digital_thread` (the deletes append to it, which is the purge being recorded),
-- the schema row (re-pointed, not retired), and historical telemetry in TimescaleDB.
--
-- Idempotent: the second run matches no rows.
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
  -- 1. The attachment, guarded on both rows existing: a database can be mid-upgrade, and an
  -- INSERT against a missing row would raise a foreign-key violation and fail the boot.
  IF EXISTS (SELECT 1 FROM public.devices WHERE id = v_target_device)
     AND EXISTS (SELECT 1 FROM public.schemas WHERE id = v_schema) THEN

    INSERT INTO public.device_submodels (device_id, schema_id, submodel_key)
    VALUES (v_target_device, v_schema, NULL)
    ON CONFLICT (device_id, schema_id) DO NOTHING;
    GET DIAGNOSTICS v_attached = ROW_COUNT;

    -- The 1:1 fallback arm as well as the join row: `device_schemas` unions the two, and setting both
    -- means the attachment survives an operator detaching one. IS DISTINCT FROM, so a boot that
    -- changes nothing writes nothing.
    UPDATE public.devices
       SET schema_id = v_schema
     WHERE id = v_target_device
       AND schema_id IS DISTINCT FROM v_schema;
    GET DIAGNOSTICS v_fallback = ROW_COUNT;

    -- 2. The nameplate. The exporter prefers what the device publishes and falls back to this table,
    -- so on a stack without a broker (every CI run) this is the difference between a Nameplate
    -- submodel and an empty one. ON CONFLICT DO NOTHING: an operator who has edited it owns it.
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

  -- 3. The deletes. Device before gateway. By pinned id, never by name: a name is a display label
  -- an operator may have changed. device_submodels and device_nameplate cascade.
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

-- Self-check: asserts the end state. The legacy rows must be gone unconditionally; the
-- attachment can only be asserted where there is something to attach to.
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
    -- Gated on the schema still existing: 0073 retires it, so on a stack provisioned before the
    -- retirement the device outlives its schema.
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
