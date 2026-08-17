-- =============================================================================================
-- 0022_complete_device_schemas.sql
--
-- One schema per MACHINE CLASS on the simulated shopfloor, attached to every device that belongs
-- to that class. Before this, five of the six simulated devices carried no schema at all.
--
-- WHY THAT MATTERED, beyond a blank column in the Devices table:
--
--   * A device with no schema is NEVER flagged as publishing outside its model. That is
--     deliberate -- "publishes beyond its model" and "has no model" are different findings, and
--     conflating them would flag every device on the floor on its first birth. But it also means
--     unmodelled detection, the platform's one automated check that a machine is publishing what
--     it was provisioned to publish, was inert for five of six devices.
--   * The AAS export composes one Submodel per attached schema. A device with none exports a
--     shell carrying its nameplate and nothing else -- no telemetry aspect, no KPI aspect.
--   * The Configuration Parameters modal reads the schema's properties. With none, it has nothing
--     to show and the operator cannot see the contract they are meant to be holding the machine to.
--
-- ---------------------------------------------------------------------------------------------
-- THE PROPERTY SETS ARE WHAT THE DEVICES ACTUALLY PUBLISH, read off their DBIRTHs rather than
-- invented here. Every name below is a row in `metric_catalog` -- which is what gives each one a
-- datatype, a unit and a published semantic id, and what the Configuration Parameters modal joins
-- against to render anything at all. A property naming a metric the catalog does not carry would
-- render as a bare string and export with no semanticId.
--
-- The JSON types follow the catalog's Sparkplug datatypes: 10 (Double) -> number, 11 (Boolean) ->
-- boolean, 12 (String) -> string. A type disagreement here is not cosmetic -- it is what the
-- payload validator checks a candidate DDATA against.
--
-- ---------------------------------------------------------------------------------------------
-- WHY Sim_CNC_Mill_01 ENDS UP WITH TWO
--
-- It keeps `Simulated_CNC_01_Schema` as well as gaining `Machining_Cell_Schema`, and that is
-- deliberate rather than a missed cleanup. That schema is the AAS handover contract: it is the
-- only one carrying the ISO 22400 factors AND the nameplate identity metrics, so it is what gives
-- the exported shell its KeyPerformanceIndicators aspect -- which the conformance suite asserts,
-- and which `Machining_Cell_Schema` correctly does not provide, because a milling machine does
-- not publish OEE. The KPIs for that cell are computed by Sim_Cell3_Aggregator, which is where
-- ISO22400_OEE_Schema is attached.
--
-- Carrying two is not a workaround; it is the arrangement `device_submodels` exists for, and one
-- AAS Submodel is emitted per schema. Over-modelling costs nothing: the unmodelled finding is
-- (declared) - (modelled), so a schema that models more than the device publishes flags nothing.
--
-- ---------------------------------------------------------------------------------------------
-- Sim_Tool_Changer_01 IS BOUND TO Robotics_Cell_Schema, WHICH IS WORTH A SECOND LOOK. It sits on
-- the MACHINING gateway, in Cell 1, and publishes MTConnect names throughout -- so by both
-- topology and vocabulary it is a machining-cell device. It is grouped here as requested, and the
-- schema is therefore the UNION of the robot's OPC UA metrics and the tool changer's MTConnect
-- ones, so that each device's contract is complete rather than half-declared. If the intent was
-- to group by cell rather than by "articulated machinery", moving these four properties into
-- Machining_Cell_Schema and re-binding is a one-line change to the attachment block below.
--
-- ---------------------------------------------------------------------------------------------
-- INSERT ... ON CONFLICT DO NOTHING throughout, never UPDATE. `prevent_active_schema_mutation()`
-- (0001) freezes every column but `status` on an `active` schema, for service_role as well as for
-- authenticated -- a trusted key is still not a reason to redefine a contract devices are
-- provisioned against. Editing one of these is a VERSIONING event: publish a v2 through the UI.
-- That also makes this migration safe to replay, which db-init does on every boot.
-- =============================================================================================

SET search_path TO public;

-- ---------------------------------------------------------------------------------------------
-- The schemas.
--
-- Pinned UUIDs, for the same reason every other seeded row has one: the attachment block below
-- references them, and a database-allocated id would differ between a fresh stack and an upgraded
-- one -- so the attachments could not be written in the same migration that creates them.
--
-- `status = 'active'` and `version = 1` with a NULL parent: the version-lineage CHECK requires
-- exactly that pairing, and seeding them as drafts would leave every device attached to a
-- contract the UI presents as not yet published.
-- ---------------------------------------------------------------------------------------------
INSERT INTO public.schemas (
  id, schema_name, description, schema_definition, created_at,
  semantic_id, semantic_id_type, version, parent_schema_id, status, change_description
) VALUES
  (
    'aa000000-0000-4000-8000-000000000001',
    'Machining_Cell_Schema',
    'MTConnect 2.x contract for a 3-axis machining centre: axis positions, spindle-side thermal state and controller/E-stop condition.',
    '{
       "type": "object",
       "required": ["Controller/EXECUTION", "Controller/EMERGENCY_STOP"],
       "properties": {
         "Axes/X/POSITION":            {"type": "number"},
         "Axes/Y/POSITION":            {"type": "number"},
         "Systems/TEMPERATURE":        {"type": "number"},
         "Controller/EXECUTION":       {"type": "string"},
         "Controller/EMERGENCY_STOP":  {"type": "string"}
       }
     }'::jsonb,
    '2026-08-02 05:44:47.407135+00',
    'https://acs-cymru.local/semantics/schema/MachiningCell', 'IRI', 1, NULL, 'active',
    'Initial release'
  ),
  (
    'aa000000-0000-4000-8000-000000000002',
    'Robotics_Cell_Schema',
    'Articulated machinery: OPC 40010 Robotics motion and 40001-4 Energy media for the arm, plus the MTConnect condition and count metrics an automatic tool changer publishes.',
    '{
       "type": "object",
       "required": ["Machine/OperationalMode"],
       "properties": {
         "MotionDevice/ActualPosition": {"type": "number"},
         "MotionDevice/ActualSpeed":    {"type": "number"},
         "MotionDevice/EmergencyStop":  {"type": "boolean"},
         "Machine/OperationalMode":     {"type": "string"},
         "Energy/VolumeFlowRate":       {"type": "number"},
         "Controller/PART_COUNT":       {"type": "number"},
         "Controller/CONTROLLER_MODE":  {"type": "string"},
         "Systems/AVAILABILITY":        {"type": "string"},
         "Axes/S/LOAD":                 {"type": "number"}
       }
     }'::jsonb,
    '2026-08-02 05:44:47.407135+00',
    'https://acs-cymru.local/semantics/schema/RoboticsCell', 'IRI', 1, NULL, 'active',
    'Initial release'
  ),
  (
    'aa000000-0000-4000-8000-000000000003',
    'BMS_Facility_Schema',
    'ASHRAE 223P contract for a conditioned zone: air temperature, relative humidity, supply air flow and CO2 concentration.',
    '{
       "type": "object",
       "required": ["BMS/ZONE_TEMPERATURE"],
       "properties": {
         "BMS/ZONE_TEMPERATURE":   {"type": "number"},
         "BMS/ZONE_HUMIDITY":      {"type": "number"},
         "BMS/SUPPLY_AIR_FLOW":    {"type": "number"},
         "BMS/CO2_CONCENTRATION":  {"type": "number"}
       }
     }'::jsonb,
    '2026-08-02 05:44:47.407135+00',
    'https://acs-cymru.local/semantics/schema/BmsFacility', 'IRI', 1, NULL, 'active',
    'Initial release'
  ),
  (
    -- OEE/PERFORMANCE, not OEE/EFFECTIVENESS. Both are catalogued and both carry the ISO 22400
    -- effectiveness semantic id, but PERFORMANCE is the name the aggregator publishes, and
    -- `metric_catalog.name` is unique and immutable -- declaring the other spelling here would
    -- model a metric no device sends while leaving the one it does send unmodelled.
    'aa000000-0000-4000-8000-000000000004',
    'ISO22400_OEE_Schema',
    'ISO 22400 effectiveness factors accumulated at the edge from a machine''s own execution state: availability, performance, quality and their product.',
    '{
       "type": "object",
       "required": ["OEE/OEE"],
       "properties": {
         "OEE/AVAILABILITY": {"type": "number"},
         "OEE/PERFORMANCE":  {"type": "number"},
         "OEE/QUALITY":      {"type": "number"},
         "OEE/OEE":          {"type": "number"}
       }
     }'::jsonb,
    '2026-08-02 05:44:47.407135+00',
    'https://acs-cymru.local/semantics/schema/Iso22400Oee', 'IRI', 1, NULL, 'active',
    'Initial release'
  )
ON CONFLICT (schema_name) DO NOTHING;


-- ---------------------------------------------------------------------------------------------
-- The attachments.
--
-- Through `device_submodels`, not `devices.schema_id`. The 1:1 column is the legacy fallback arm
-- and `device_schemas` only consults it for devices with NO join rows -- so writing both would be
-- redundant for a device with one schema and impossible for a device with two.
--
-- Guarded on both sides existing. The devices come from 0002, which runs first on every boot, but
-- a database mid-upgrade may not have replayed it yet -- and an INSERT against a missing device
-- raises a foreign-key violation that db-init reports as a failed migration rather than as a
-- skipped attachment.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  v_pair   RECORD;
  v_added  INTEGER := 0;
  v_total  INTEGER := 0;
BEGIN
  FOR v_pair IN
    SELECT * FROM (VALUES
      ('22000000-0000-4000-8000-000000000001'::uuid, 'aa000000-0000-4000-8000-000000000001'::uuid),
      ('23000000-0000-4000-8000-000000000001'::uuid, 'aa000000-0000-4000-8000-000000000001'::uuid),
      ('24000000-0000-4000-8000-000000000001'::uuid, 'aa000000-0000-4000-8000-000000000002'::uuid),
      ('27000000-0000-4000-8000-000000000001'::uuid, 'aa000000-0000-4000-8000-000000000002'::uuid),
      ('26000000-0000-4000-8000-000000000001'::uuid, 'aa000000-0000-4000-8000-000000000003'::uuid),
      ('25000000-0000-4000-8000-000000000001'::uuid, 'aa000000-0000-4000-8000-000000000004'::uuid)
    ) AS t(device_id, schema_id)
  LOOP
    v_total := v_total + 1;

    IF NOT EXISTS (SELECT 1 FROM public.devices  WHERE id = v_pair.device_id) THEN CONTINUE; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.schemas  WHERE id = v_pair.schema_id) THEN CONTINUE; END IF;

    INSERT INTO public.device_submodels (device_id, schema_id, submodel_key)
    VALUES (v_pair.device_id, v_pair.schema_id, NULL)
    ON CONFLICT (device_id, schema_id) DO NOTHING;

    v_added := v_added + (CASE WHEN FOUND THEN 1 ELSE 0 END);
  END LOOP;

  RAISE NOTICE '0022: % of % class-schema attachment(s) newly written.', v_added, v_total;
END;
$$;


-- Self-check. Asserts the END STATE -- that every simulated device present carries at least one
-- schema, which is the property the Configuration Parameters modal and the AAS export both
-- depend on, and the one this migration exists to establish.
--
-- Through the VIEW rather than the join table: `device_schemas` is what those readers consult, and
-- asserting on device_submodels alone would pass while the union a consumer actually sees was
-- empty.
DO $$
DECLARE
  v_orphan TEXT;
BEGIN
  SELECT string_agg(d.name, ', ' ORDER BY d.name) INTO v_orphan
    FROM public.devices d
   WHERE d.name LIKE 'Sim\_%'
     AND NOT d.is_archived
     AND NOT EXISTS (
       SELECT 1 FROM public.device_schemas ds
        WHERE ds.device_id = d.id AND ds.schema_id IS NOT NULL
     );

  IF v_orphan IS NOT NULL THEN
    RAISE EXCEPTION
      '0022 self-check: simulated device(s) with no schema attached: %. They would export an AAS '
      'shell with no telemetry aspect and would never be checked for unmodelled metrics.', v_orphan;
  END IF;

  RAISE NOTICE '0022 self-check passed: every simulated device carries at least one schema.';
END;
$$;

NOTIFY pgrst, 'reload schema';
