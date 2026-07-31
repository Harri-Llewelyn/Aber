-- Migration: 20260101000033_cnc_tri_standard_schema.sql
-- Description: Replace the two seeded demo schemas with one tri-standard schema for the demo CNC,
-- and add the catalog metrics it needs.
--
-- WHY ONE SCHEMA RATHER THAN TWO. `devices.schema_id` is 1:1, so the split between
-- `SparkplugB-Telemetry-Standard-Schema` (MTConnect observations) and `ISO-22400-OEE-Schema` (the
-- KPIs) meant a device could be modelled by one or the other, never both -- and every derived
-- feature reads the assigned schema: device tags, the unmodelled-metric finding, the tag filters on
-- the Devices, Telemetry and Digital Thread pages. A real asset publishes across standards, so the
-- default has to as well.
--
-- ============================================================================
-- TWO DEVIATIONS FROM THE REQUESTED METRIC LIST -- both deliberate.
-- ============================================================================
--
-- 1. `Execution/EXECUTION` is recorded as `Controller/EXECUTION`.
--    `Execution` is not an MTConnect component; `Controller` is, and `Controller/EXECUTION` already
--    exists in the catalog, is what node_red_flow.json publishes, and is read by name in three
--    other places: grafana/provisioning/dashboards/json/factoryplus-overview.json, and
--    OverviewTab's getDeviceStatusColor. Adding a second metric for the same concept under a
--    non-standard group would fork the taxonomy against an immutable name, and would leave
--    `Controller/EXECUTION` reporting as Unmodelled on the very device this schema is for.
--
-- 2. The OPC UA metrics keep the requested *names* but carry the companion specification's *own*
--    concept as their semantic id -- `Machine/OperatingMode` is bound to
--    `…/Machinery/MachineryOperationMode`, and `MotionDevice/OverridePercent` to
--    `…/Robotics/SpeedOverride`, which are the actual browse names in opcua_vocabulary. This is
--    precisely what a semanticId is for: a locally-chosen name bound to a standard concept. The
--    vocabulary panel matches on semantic id first, so both show as adopted despite the names
--    differing from the browse names.
--
-- ============================================================================
-- WHY THE SCHEMA IS A SUPERSET OF THE EIGHT REQUESTED METRICS
-- ============================================================================
-- The brief asks that Simulated_CNC_01 resolve its schema "without reporting unmodelled metrics".
-- Unmodelled is derived at read time as (metrics the device declared) minus (metrics the schema
-- models), so that requirement is only satisfiable if the schema also covers what the device
-- actually publishes. node_red_flow.json's DBIRTH declares eight metrics, six of which are not in
-- the requested list. They are included here for that reason, and the requested eight are all
-- present -- the brief says the schema must *include* a balanced mix across the three standards,
-- which it does.
--
-- The converse gap is worth stating plainly: the ISO 22400 and OPC UA metrics below are modelled
-- but never published, because the Node-RED simulator does not emit them. They will show in the
-- schema and in device tags, and will have no telemetry behind them until the flow is extended.
-- That is a deliberate stopping point, not an oversight -- changing the flow means re-running
-- node-red-init, and was not part of this brief.

-- ============================================================================
-- 1. The catalog metrics the schema needs that do not exist yet
-- ============================================================================
-- Groups: `Axes` comes from MTConnect's component types (0018); `Machine` and `MotionDevice` were
-- registered by 0031. enforce_metric_group_spelling() therefore accepts all three as-is.
INSERT INTO public.metric_catalog
  (id, name, datatype, category, units, sub_type, standard, semantic_id, semantic_id_type, description)
VALUES
  ('c0000001-0000-4000-8000-000000000011', 'Axes/C/ANGLE', 10, 'SAMPLE', 'DEGREE', NULL,
   'MTConnect', 'https://factoryplus.local/semantics/mtconnect/v2.0/Axes/C/ANGLE', 'IRI',
   'Angular position of the C axis (MTConnect ANGLE on the Axes component)'),

  ('c0000001-0000-4000-8000-000000000012', 'Machine/OperatingMode', 12, 'EVENT', NULL, NULL,
   'OPC UA', 'http://opcfoundation.org/UA/Machinery/MachineryOperationMode', 'IRI',
   'Machine operating mode -- Processing, Setup, Maintenance or Normal. OPC 40001 calls this browse name MachineryOperationMode; the semantic id binds this metric to that concept.'),

  ('c0000001-0000-4000-8000-000000000013', 'MotionDevice/OverridePercent', 10, 'SAMPLE', 'PERCENT', NULL,
   'OPC UA', 'http://opcfoundation.org/UA/Robotics/SpeedOverride', 'IRI',
   'Operator speed override applied to programmed motion. OPC 40010 calls this browse name SpeedOverride; the semantic id binds this metric to that concept.')
ON CONFLICT (name) DO NOTHING;

-- The two local extensions are in this schema because the demo device publishes them, and the brief
-- requires every metric in the schema to carry a semantic id. 0032 deliberately left them unmapped
-- on the grounds that no standard describes them -- which is still true, and is exactly why these
-- ids sit under `/local/` rather than in a standard's namespace. A local concept getting a local
-- identifier is the honest case, not an exception to the rule.
UPDATE public.metric_catalog
   SET semantic_id      = 'https://factoryplus.local/semantics/local/' || name,
       semantic_id_type = 'IRI'
 WHERE name IN ('safety_interlock', 'max_temp_threshold')
   AND semantic_id IS NULL;

-- ============================================================================
-- 2. The tri-standard schema
-- ============================================================================
-- `required` is only the three metrics the simulator reliably publishes and that the Grafana alert
-- rule and Overview tab depend on. Requiring a metric no device sends would fail the Validate
-- Candidate Payload check for a conforming device; `properties` is what modelledMetrics() reads for
-- the unmodelled finding, and it covers everything.
INSERT INTO public.schemas (id, schema_name, description, schema_definition, semantic_id, semantic_id_type)
VALUES (
  'e3333333-4444-5555-6666-777777777777',
  'Simulated_CNC_01_Schema',
  'Default tri-standard schema for the demo CNC: MTConnect observations, ISO 22400 KPIs and OPC UA companion-specification data points.',
  '{
    "type": "object",
    "properties": {
      "Systems/TEMPERATURE":           {"type": "number"},
      "Axes/C/ANGLE":                  {"type": "number"},
      "Axes/DISPLACEMENT":             {"type": "number"},
      "Controller/EXECUTION":          {"type": "string"},
      "Controller/EMERGENCY_STOP":     {"type": "string"},
      "Controller/FIRMWARE":           {"type": "string"},
      "SERIAL_NUMBER":                 {"type": "string"},
      "OEE/AVAILABILITY":              {"type": "number"},
      "OEE/EFFECTIVENESS":             {"type": "number"},
      "OEE/QUALITY":                   {"type": "number"},
      "Machine/OperatingMode":         {"type": "string"},
      "MotionDevice/OverridePercent":  {"type": "number"},
      "safety_interlock":              {"type": "boolean"},
      "max_temp_threshold":            {"type": "number"}
    },
    "required": ["Systems/TEMPERATURE", "Controller/EXECUTION", "Controller/EMERGENCY_STOP"]
  }'::jsonb,
  'https://factoryplus.local/semantics/schema/SimulatedCNC01',
  'IRI'
)
ON CONFLICT (schema_name) DO UPDATE SET
  description       = EXCLUDED.description,
  schema_definition = EXCLUDED.schema_definition,
  semantic_id       = EXCLUDED.semantic_id,
  semantic_id_type  = EXCLUDED.semantic_id_type;

-- Guarded so this is a genuine no-op on replay. 0021 now resolves the same schema by name, so it
-- normally arrives here already correct; without the guard, log_digital_thread_event() would append
-- an audit row to an append-only table on every boot.
UPDATE public.devices
   SET schema_id = 'e3333333-4444-5555-6666-777777777777'
 WHERE name = 'Simulated_CNC_01'
   AND schema_id IS DISTINCT FROM 'e3333333-4444-5555-6666-777777777777';

-- ============================================================================
-- 3. Remove the superseded demo schemas
-- ============================================================================
-- Both are re-created by 0002's seed on every boot and then removed again here; migrations replay
-- in filename order, so the end state after any boot is stable. 0002's seed is deliberately left
-- intact rather than trimmed, because 0021 needs a schema to fall back to on a database that has
-- not reached this migration yet.
--
-- Safe: devices.schema_id and directory_services.registered_schema_id are both ON DELETE SET NULL,
-- and the demo device has already been re-pointed above. Nothing else references schemas.
DELETE FROM public.schemas
 WHERE schema_name IN ('SparkplugB-Telemetry-Standard-Schema', 'ISO-22400-OEE-Schema');

-- ============================================================================
-- 4. Assert the brief's invariant rather than merely claiming it
-- ============================================================================
-- Every metric named in the schema must exist in metric_catalog, must not be deprecated, and must
-- carry a semantic id. Checked here so that editing the schema definition above without adding the
-- corresponding catalog entry fails the migration, instead of silently producing a schema whose
-- metrics no device could be provisioned against.
DO $$
DECLARE
  missing TEXT;
BEGIN
  SELECT string_agg(k.name, ', ' ORDER BY k.name) INTO missing
    FROM (
      SELECT jsonb_object_keys(schema_definition -> 'properties') AS name
        FROM public.schemas
       WHERE schema_name = 'Simulated_CNC_01_Schema'
    ) AS k
    LEFT JOIN public.metric_catalog mc ON mc.name = k.name
   WHERE mc.id IS NULL OR mc.semantic_id IS NULL OR mc.deprecated;

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'Simulated_CNC_01_Schema names metrics that are missing from metric_catalog, deprecated, or have no semantic_id: %',
      missing;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
