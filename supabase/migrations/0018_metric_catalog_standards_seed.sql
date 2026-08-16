-- =============================================================================================
-- Migration: 0018_metric_catalog_standards_seed.sql
-- Pre-register the demonstrator's metric set, each row carrying the standard that defines it
-- =============================================================================================
--
-- WHY. `metric_catalog.name` is UNIQUE and IMMUTABLE (0007). A metric is deprecate-and-supersede,
-- never rename, because a device is configured against that exact string. So the first row to
-- claim a name owns it permanently -- along with whichever `standard` and `semantic_id` it was
-- created with, both of which flow straight into the AAS export and the i3X `sourceTypeId`.
--
-- Nothing auto-creates these rows: `ingestion.py` contains no reference to metric_catalog at all
-- (it writes birth parameters to asset_config and the declared-metric array to devices). The only
-- insert path is the operator-facing form behind POST /api/v1/metric-catalog. That is a good
-- property -- the catalog is curated, not accreted -- but it means a mixed-standard fleet is
-- registered by hand, one form at a time, and a typo is permanent.
--
-- This migration front-runs that: it registers the metrics the multi-standard demonstrator
-- publishes, so an operator never has to, and so no metric is created with `standard = NULL`.
--
-- ---------------------------------------------------------------------------------------------
-- SEMANTIC IDS ARE SELECTED, NOT TYPED. Every row joins the vocabulary table for its standard and
-- takes `semantic_id` from there. Retyping them would create a second, unverified copy of an
-- identity that docs/vocabularies.md went to some trouble to confirm against machine-readable
-- sources -- and a typo would assert an interoperability that does not exist while looking
-- exactly like one that does. A metric whose concept is not in the vocabulary is therefore not
-- inserted at all, rather than inserted with a guessed id: the INNER JOIN is the check.
--
-- MTConnect `category` is taken from the vocabulary for the same reason. `datatype` and `units`
-- are NOT -- those are properties of what a particular device publishes, not of the standard.
--
-- ---------------------------------------------------------------------------------------------
-- THE TAXONOMY EXTENDS WHAT 0002 ALREADY SEEDED. IT DOES NOT REPLACE IT.
--
-- The plan this migration comes from proposed `KPI/…` for ISO 22400 and `Robotics/…` for OPC
-- 40010. Both were rejected on contact with the existing catalog, which already uses `OEE/…`
-- (OEE/AVAILABILITY, OEE/PERFORMANCE, OEE/QUALITY, OEE/EFFECTIVENESS) and `MotionDevice/…` /
-- `Machine/…`. Adding a parallel prefix would create two permanent names for one concept -- which
-- is precisely the collision the naming plan exists to prevent, arriving from the direction of the
-- plan itself. `MotionDevice` is also the better name on its own merits: it is OPC 40010's own
-- browse-name root, where `Robotics` is only the specification's title.
--
-- One top-level segment per standard, so a name cannot collide across standards by construction:
--
--   Axes/… Controller/… Systems/…   MTConnect 2.x
--   MotionDevice/… Machine/…        OPC 40010 Robotics
--   Energy/…                        OPC 40001-4 Machinery Energy
--   BMS/…                           ASHRAE 223P
--   OEE/…                           ISO 22400
--
-- The generated `metric_group` column splits on that first segment, so this is also what groups
-- them in the dashboard.
--
-- ---------------------------------------------------------------------------------------------
-- ON CONFLICT (name) DO NOTHING, for two different reasons that happen to want the same clause:
--   * db-init replays every migration on every boot with ON_ERROR_STOP=1 and no ledger, so a
--     second run must be a no-op rather than a unique-violation that stops the stack booting;
--   * an operator may have already created one of these names by hand, and a restart must not
--     revert their row. Their edit wins; this migration only fills gaps.
--
-- The names must satisfy 0007's format check (^[A-Za-z0-9_]+(/[A-Za-z0-9_]+)*$) -- no dots, no
-- hyphens. OPC UA browse paths and ASHRAE concept names both carry characters that constraint
-- rejects, so they are transliterated here at authoring time, which is the only time it can
-- happen: the name is immutable once written.
--
-- Sparkplug datatypes used below: 10 = Double, 11 = Boolean, 12 = String.
-- =============================================================================================

\set ON_ERROR_STOP on


-- ---------------------------------------------------------------------------------------------
-- 1. MTConnect 2.x -- machine tool axes, controller and systems
-- ---------------------------------------------------------------------------------------------
-- Joined on kind = 'DATA_ITEM_TYPE'. The vocabulary also holds COMPONENT, SUB_TYPE, UNIT and
-- NATIVE_UNIT rows under the same `name` values, so an unqualified join would multiply rows and
-- could attach a component's semantic id to a data item.
INSERT INTO public.metric_catalog (name, datatype, description, category, units, standard,
                                   semantic_id, semantic_id_type)
SELECT s.name, s.datatype, s.description, v.category, s.units, 'MTConnect', v.semantic_id, 'IRI'
  FROM (VALUES
    ('Axes/X/POSITION',          10, 'Linear position of the X axis',              'POSITION',        'MILLIMETER'),
    ('Axes/Y/POSITION',          10, 'Linear position of the Y axis',              'POSITION',        'MILLIMETER'),
    ('Axes/Z/POSITION',          10, 'Linear position of the Z axis',              'POSITION',        'MILLIMETER'),
    ('Axes/S/ROTARY_VELOCITY',   10, 'Spindle rotational velocity',                'ROTARY_VELOCITY', 'REVOLUTION/MINUTE'),
    ('Axes/S/LOAD',              10, 'Spindle load as a percentage of rated load',  'LOAD',            'PERCENT'),
    ('Controller/PATH_FEEDRATE', 10, 'Commanded feedrate along the tool path',      'PATH_FEEDRATE',   'MILLIMETER/SECOND'),
    ('Controller/CONTROLLER_MODE', 12, 'Controller operating mode',                 'CONTROLLER_MODE', NULL),
    ('Controller/PROGRAM',       12, 'Name of the executing part program',          'PROGRAM',         NULL),
    ('Controller/PART_COUNT',    10, 'Parts completed by this controller',          'PART_COUNT',      'COUNT'),
    ('Systems/AVAILABILITY',     12, 'Whether the device is available to report',   'AVAILABILITY',    NULL)
  ) AS s(name, datatype, description, concept, units)
  JOIN public.mtconnect_vocabulary v
    ON v.name = s.concept AND v.kind = 'DATA_ITEM_TYPE'
ON CONFLICT (name) DO NOTHING;


-- ---------------------------------------------------------------------------------------------
-- 2. OPC 40010 Robotics -- the robotic assembly cell
-- ---------------------------------------------------------------------------------------------
-- `MotionDevice/…` and `Machine/…` continue the prefixes 0002 established. `companion_spec` is
-- part of the join because `opcua_vocabulary` is keyed (companion_spec, name) -- `Mass` and
-- `Temperature`, among others, appear under more than one specification.
INSERT INTO public.metric_catalog (name, datatype, description, category, units, standard,
                                   semantic_id, semantic_id_type)
SELECT s.name, s.datatype, s.description, s.category, s.units, 'OPC UA', v.semantic_id, 'IRI'
  FROM (VALUES
    ('MotionDevice/ActualPosition',  10, 'Current tool-centre-point position',        'SAMPLE', 'MILLIMETER'),
    ('MotionDevice/ActualSpeed',     10, 'Current tool-centre-point speed',           'SAMPLE', 'MILLIMETER/SECOND'),
    ('MotionDevice/EmergencyStop',   11, 'Emergency stop circuit engaged',            'EVENT',  NULL),
    ('MotionDevice/ProtectiveStop',  11, 'Protective stop engaged',                   'EVENT',  NULL),
    ('MotionDevice/OnPath',          11, 'Whether the device is on its planned path', 'EVENT',  NULL),
    ('MotionDevice/TaskProgramName', 12, 'Name of the executing task program',        'EVENT',  NULL),
    ('Machine/OperationalMode',      12, 'Operational mode of the motion device',     'EVENT',  NULL),
    ('Machine/SpeedOverride',        10, 'Operator speed override',                   'SAMPLE', 'PERCENT')
  ) AS s(name, datatype, description, category, units)
  JOIN public.opcua_vocabulary v
    ON v.companion_spec = 'OPC 40010 Robotics'
   AND v.name = regexp_replace(s.name, '^[^/]+/', '')
ON CONFLICT (name) DO NOTHING;


-- ---------------------------------------------------------------------------------------------
-- 3. OPC 40001-4 Machinery Energy -- per-cell energy telemetry
-- ---------------------------------------------------------------------------------------------
INSERT INTO public.metric_catalog (name, datatype, description, category, units, standard,
                                   semantic_id, semantic_id_type)
SELECT s.name, s.datatype, s.description, s.category, s.units, 'OPC UA', v.semantic_id, 'IRI'
  FROM (VALUES
    ('Energy/Pressure',       10, 'Compressed-air supply pressure', 'SAMPLE', 'PASCAL'),
    ('Energy/Temperature',    10, 'Coolant or medium temperature',  'SAMPLE', 'CELSIUS'),
    ('Energy/VolumeFlowRate', 10, 'Medium volumetric flow rate',    'SAMPLE', 'LITER/SECOND'),
    ('Energy/Volume',         10, 'Cumulative medium volume',       'SAMPLE', 'LITER')
  ) AS s(name, datatype, description, category, units)
  JOIN public.opcua_vocabulary v
    ON v.companion_spec = 'OPC 40001-4 Machinery Energy'
   AND v.name = regexp_replace(s.name, '^[^/]+/', '')
ON CONFLICT (name) DO NOTHING;


-- ---------------------------------------------------------------------------------------------
-- 4. ASHRAE 223P -- facility / BMS ambient telemetry
-- ---------------------------------------------------------------------------------------------
-- THE SEMANTIC ID HERE NAMES A SENSOR CLASS, NOT A QUANTITY, and that is a real modelling
-- compromise rather than an oversight. 223P models a measurement as a Property attached to a
-- Sensor; this catalog has one flat name per series and nowhere to hang that pair. Pointing at
-- the sensor class is the closest honest statement available -- "this series comes from a
-- temperature sensor as 223P defines one" -- and it is why the ⚠ in docs/vocabularies.md about
-- 223P still being in public review matters more for this standard than for the others.
--
-- `Constituent-CO2` carries a hyphen, which 0007 forbids in a metric name; it is transliterated
-- to `BMS/CO2_CONCENTRATION`, and the join still uses the vocabulary's own unmodified key.
INSERT INTO public.metric_catalog (name, datatype, description, category, units, standard,
                                   semantic_id, semantic_id_type)
SELECT s.name, s.datatype, s.description, s.category, s.units, 'ASHRAE 223P', v.semantic_id, 'IRI'
  FROM (VALUES
    ('BMS/ZONE_TEMPERATURE',  10, 'Zone air temperature',        'SAMPLE', 'CELSIUS',        'TemperatureSensor'),
    ('BMS/ZONE_HUMIDITY',     10, 'Zone relative humidity',      'SAMPLE', 'PERCENT',        'HumiditySensor'),
    ('BMS/CO2_CONCENTRATION', 10, 'Zone CO2 concentration',      'SAMPLE', 'PARTS/MILLION',  'Constituent-CO2'),
    ('BMS/STATIC_PRESSURE',   10, 'Duct static pressure',        'SAMPLE', 'PASCAL',         'PressureSensor')
  ) AS s(name, datatype, description, category, units, concept)
  JOIN public.ashrae223_vocabulary v ON v.name = s.concept
ON CONFLICT (name) DO NOTHING;


-- ---------------------------------------------------------------------------------------------
-- 5. ISO 22400 -- computed KPIs
-- ---------------------------------------------------------------------------------------------
-- THESE ARE REGISTERED, NOT COMPUTED. Nothing in this platform derives them: docs/vocabularies.md
-- records that inferred ISO 22400 KPIs are deferred, because OEE needs planned busy time, planned
-- run time per item and good/scrap disposition, none of which are telemetry and all of which
-- would make this an MES. Registering the names means an edge device that HAS those inputs -- a
-- Node-RED aggregator accumulating PackML state times, say -- can publish them as ordinary
-- Sparkplug metrics and have them land correctly typed and correctly attributed.
--
-- `OEE/AVAILABILITY`, `OEE/PERFORMANCE`, `OEE/QUALITY` and `OEE/EFFECTIVENESS` are already seeded
-- by 0002 and are deliberately not repeated here; the ON CONFLICT would skip them in any case.
INSERT INTO public.metric_catalog (name, datatype, description, category, units, standard,
                                   semantic_id, semantic_id_type)
SELECT s.name, s.datatype, v.description, 'SAMPLE', v.unit, 'ISO 22400', v.semantic_id, 'IRI'
  FROM (VALUES
    ('OEE/OEE',         10, 'OEE'),
    ('OEE/UTILIZATION', 10, 'UTILIZATION'),
    ('OEE/SCRAP_RATIO', 10, 'SCRAP_RATIO'),
    ('OEE/MTBF',        10, 'MTBF'),
    ('OEE/MTTR',        10, 'MTTR')
  ) AS s(name, datatype, concept)
  JOIN public.iso22400_vocabulary v ON v.name = s.concept
ON CONFLICT (name) DO NOTHING;


-- ---------------------------------------------------------------------------------------------
-- 6. Self-check
-- ---------------------------------------------------------------------------------------------
-- Asserts the two properties a silent failure here would take: that the joins actually matched
-- (a renamed vocabulary row would make this migration insert NOTHING and report success), and
-- that nothing it wrote violates the constraints a later boot would trip over.
DO $$
DECLARE
  v_unmapped  integer;
  v_badname   integer;
  v_seeded    integer;
BEGIN
  SELECT count(*) INTO v_seeded
    FROM public.metric_catalog
   WHERE metric_group IN ('Axes', 'Controller', 'Systems', 'MotionDevice', 'Machine',
                          'Energy', 'BMS', 'OEE');

  IF v_seeded = 0 THEN
    RAISE EXCEPTION
      '0018 self-check: no catalog rows are present under any seeded metric group. The joins '
      'above matched nothing, which means a vocabulary table was renamed or re-keyed.';
  END IF;

  -- Every row this migration is responsible for must carry a standard AND a semantic id. A NULL
  -- here is the exact defect the migration exists to prevent, so it fails the boot rather than
  -- warning: a catalog row is immutable, and one created wrong stays wrong.
  SELECT count(*) INTO v_unmapped
    FROM public.metric_catalog
   WHERE metric_group IN ('Axes', 'MotionDevice', 'Energy', 'BMS')
     AND (standard IS NULL OR semantic_id IS NULL);

  IF v_unmapped > 0 THEN
    RAISE EXCEPTION '0018 self-check: % seeded metric(s) carry no standard or semantic_id',
      v_unmapped;
  END IF;

  -- 0007's constraint is NOT VALID, so it enforces on INSERT but has not necessarily back-scanned.
  -- Check the rows this migration owns directly rather than trusting that.
  SELECT count(*) INTO v_badname
    FROM public.metric_catalog
   WHERE metric_group IN ('Axes', 'Controller', 'Systems', 'MotionDevice', 'Machine',
                          'Energy', 'BMS', 'OEE')
     AND name !~ '^[A-Za-z0-9_]+(/[A-Za-z0-9_]+)*$';

  IF v_badname > 0 THEN
    RAISE EXCEPTION '0018 self-check: % catalog name(s) violate the Factory+ metric-name format',
      v_badname;
  END IF;

  RAISE NOTICE '0018 self-check passed: % catalog row(s) across the seeded metric groups, all '
               'carrying a standard and a published semantic id.', v_seeded;
END $$;
