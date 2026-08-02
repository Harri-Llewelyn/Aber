-- Migration: 20260101000019_mtconnect_catalog_migration.sql
-- Description: Move the starter catalog from ad-hoc names onto the MTConnect vocabulary, and the
-- OEE metrics onto ISO 22400.
--
-- This is NOT a rename. metric_catalog.name is immutable (enforce_metric_catalog_immutability,
-- migration 0013) because a physical device is already configured to publish under that exact
-- string. The designed path for changing a metric is to deprecate the old entry and create a new
-- one, with superseded_by pointing at the replacement -- which is what happens below. The old
-- entries stay visible in the Schemas tab, struck through, so an integrator migrating a real
-- device can see what a name became rather than finding it silently gone.
--
-- New UUIDs are pinned rather than generated so re-applying this migration is stable.
--
-- ============================================================================================
-- THE MAPPING, AND HOW CONFIDENT EACH ONE IS
-- ============================================================================================
--
-- Clean -- the standard has exactly this concept:
--   temperature        -> Systems/TEMPERATURE      SAMPLE, CELSIUS
--   firmware_version   -> Controller/FIRMWARE      EVENT
--   serial_number      -> SERIAL_NUMBER            EVENT   (device-level identity, so no component)
--
-- Judgement calls -- defensible, but worth confirming against the real asset:
--   vibration          -> Axes/DISPLACEMENT        SAMPLE, MILLIMETER
--       MTConnect has no VIBRATION type. The catalog described this as "Vibration amplitude", and
--       amplitude is a displacement. If what is actually measured is rate of change rather than
--       amplitude, ACCELERATION is the correct type instead.
--   status             -> Controller/EXECUTION     EVENT
--   safety_ok          -> Controller/EMERGENCY_STOP EVENT
--       These two change the VALUE vocabulary as well as the name, which is the part that is easy
--       to miss. MTConnect constrains EXECUTION to READY/ACTIVE/INTERRUPTED/FEED_HOLD/STOPPED/...
--       and EMERGENCY_STOP to ARMED/TRIGGERED. Renaming without moving the values would produce a
--       metric that looks standard and is not, which is worse than leaving it alone -- so
--       node_red_flow.json publishes the new vocabularies too. Note EMERGENCY_STOP also inverts
--       the sense: safety_ok = true becomes EMERGENCY_STOP = ARMED (armed and not tripped).
--
-- Deliberately NOT moved to MTConnect:
--   availability       -> OEE/AVAILABILITY         ISO 22400, PERCENT
--   performance        -> OEE/PERFORMANCE          ISO 22400, PERCENT
--   quality            -> OEE/QUALITY              ISO 22400, PERCENT
--       MTConnect reports raw machine state and deliberately excludes computed KPIs, so these stay
--       on ISO 22400 -- which is what the original seed comments already cited.
--       CRITICAL: MTConnect *does* define AVAILABILITY, as an EVENT meaning "the device is
--       connected and reporting". It is NOT the OEE availability ratio. Mapping the OEE metric
--       onto it would silently corrupt every OEE dashboard and alert. They are different things
--       that share a word.
--
-- Retained as local extensions -- MTConnect has no equivalent, and that is not a defect:
--   safety_interlock   EVENT      no generic interlock type exists (only AXIS_/CHUCK_/SPINDLE_)
--   max_temp_threshold SAMPLE     MTConnect models limits as Constraints on a data item, not as a
--                                 data item, and our catalog has no constraint concept yet
--       Both keep their names and gain standard = NULL, which is a legitimate state: MTConnect
--       explicitly permits extension.
-- ============================================================================================

-- 1. The replacements. ON CONFLICT keeps this idempotent; datatype is deliberately not touched in
--    the DO UPDATE branch, since the immutability trigger would reject a change to it.
INSERT INTO public.metric_catalog (id, name, datatype, category, units, sub_type, standard, description) VALUES
  ('c0000001-0000-4000-8000-000000000001', 'Systems/TEMPERATURE',     10, 'SAMPLE', 'CELSIUS',    NULL, 'MTConnect', 'Machine system temperature'),
  ('c0000001-0000-4000-8000-000000000002', 'Axes/DISPLACEMENT',       10, 'SAMPLE', 'MILLIMETER', NULL, 'MTConnect', 'Axis displacement amplitude (was: vibration)'),
  ('c0000001-0000-4000-8000-000000000003', 'Controller/EXECUTION',    12, 'EVENT',  NULL,         NULL, 'MTConnect', 'Controller execution state: READY / ACTIVE / INTERRUPTED / FEED_HOLD / STOPPED'),
  ('c0000001-0000-4000-8000-000000000004', 'Controller/EMERGENCY_STOP', 12, 'EVENT', NULL,        NULL, 'MTConnect', 'Emergency stop circuit: ARMED (healthy) or TRIGGERED'),
  ('c0000001-0000-4000-8000-000000000005', 'Controller/FIRMWARE',     12, 'EVENT',  NULL,         NULL, 'MTConnect', 'Controller firmware version'),
  ('c0000001-0000-4000-8000-000000000006', 'SERIAL_NUMBER',           12, 'EVENT',  NULL,         NULL, 'MTConnect', 'Manufacturer serial number'),
  ('c0000001-0000-4000-8000-000000000007', 'OEE/AVAILABILITY',        10, NULL,     'PERCENT',    NULL, 'ISO 22400', 'ISO 22400 availability ratio -- NOT MTConnect AVAILABILITY, which means "device connected"'),
  ('c0000001-0000-4000-8000-000000000008', 'OEE/PERFORMANCE',         10, NULL,     'PERCENT',    NULL, 'ISO 22400', 'ISO 22400 performance ratio'),
  ('c0000001-0000-4000-8000-000000000009', 'OEE/QUALITY',             10, NULL,     'PERCENT',    NULL, 'ISO 22400', 'ISO 22400 quality ratio')
ON CONFLICT (name) DO UPDATE SET
  category    = EXCLUDED.category,
  units       = EXCLUDED.units,
  sub_type    = EXCLUDED.sub_type,
  standard    = EXCLUDED.standard,
  description = EXCLUDED.description;

-- 2. Deprecate the originals, pointing each at what replaced it. The UI renders these struck
--    through with the successor named, which is the migration instruction for anyone with a
--    device still publishing the old name.
UPDATE public.metric_catalog SET deprecated = TRUE, superseded_by = replacement.id
  FROM (VALUES
    ('temperature',      'c0000001-0000-4000-8000-000000000001'::uuid),
    ('vibration',        'c0000001-0000-4000-8000-000000000002'::uuid),
    ('status',           'c0000001-0000-4000-8000-000000000003'::uuid),
    ('safety_ok',        'c0000001-0000-4000-8000-000000000004'::uuid),
    ('firmware_version', 'c0000001-0000-4000-8000-000000000005'::uuid),
    ('serial_number',    'c0000001-0000-4000-8000-000000000006'::uuid),
    ('availability',     'c0000001-0000-4000-8000-000000000007'::uuid),
    ('performance',      'c0000001-0000-4000-8000-000000000008'::uuid),
    ('quality',          'c0000001-0000-4000-8000-000000000009'::uuid)
  ) AS replacement(old_name, id)
 WHERE public.metric_catalog.name = replacement.old_name;

-- 3. The two retained local extensions gain their facets. standard stays NULL: MTConnect permits
--    extension, so this records "deliberately not standard", not "not yet classified".
UPDATE public.metric_catalog SET category = 'EVENT'
 WHERE name = 'safety_interlock' AND category IS NULL;
UPDATE public.metric_catalog SET category = 'SAMPLE', units = 'CELSIUS'
 WHERE name = 'max_temp_threshold' AND category IS NULL;

-- 4. Move the seeded schemas onto the new names. Done here rather than only in migration 0002
--    because that seed is ON CONFLICT DO NOTHING, so editing it alone would never reach a database
--    that had already been started. 0002 carries the same definitions for a fresh install.
UPDATE public.schemas SET
  description = 'Standard Sparkplug B metric schema using MTConnect data item types',
  schema_definition = '{"type": "object", "properties": {"Systems/TEMPERATURE": {"type": "number"}, "Controller/EXECUTION": {"type": "string"}, "Controller/EMERGENCY_STOP": {"type": "string"}}, "required": ["Systems/TEMPERATURE", "Controller/EXECUTION"]}'::jsonb
 WHERE schema_name = 'SparkplugB-Telemetry-Standard-Schema';

UPDATE public.schemas SET
  schema_definition = '{"type": "object", "properties": {"OEE/AVAILABILITY": {"type": "number"}, "OEE/PERFORMANCE": {"type": "number"}, "OEE/QUALITY": {"type": "number"}}, "required": ["OEE/AVAILABILITY"]}'::jsonb
 WHERE schema_name = 'ISO-22400-OEE-Schema';

NOTIFY pgrst, 'reload schema';
