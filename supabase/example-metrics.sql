-- Example metrics: a starter catalog drawn from the standard vocabularies, for a development or
-- demonstration stack. A fresh install's catalog is empty; db-init applies this file after the
-- migrations only with dbInit.exampleMetrics on (values-dev.yaml), on every install and upgrade.
-- Reasoning: ./README.md, "Example metrics".
--
-- ON CONFLICT (name) DO NOTHING throughout, so a replay inserts nothing and never writes over a row
-- an operator has since edited or deprecated. A row deleted by hand comes back on the next boot
-- while the value is on; deprecate it instead.
--
-- Semantic ids are SELECTed from the vocabulary tables, never typed: a concept missing from its
-- vocabulary inserts no row rather than a guessed id. Plain SQL with no psql meta-commands, because
-- test_metric_catalog_seed.py applies it through psycopg2.

-- MTConnect 2.x: machine tool axes, controller and systems (17 rows). Joined on kind =
-- 'DATA_ITEM_TYPE': the vocabulary also holds COMPONENT, SUB_TYPE, UNIT and NATIVE_UNIT rows under
-- the same names. The concept is the name's last segment; the category is the data item type's.
INSERT INTO public.metric_catalog (name, datatype, description, category, units, standard,
                                   semantic_id, semantic_id_type, permitted_values)
SELECT s.name, s.datatype, s.description, v.category, s.units, 'MTConnect', v.semantic_id, 'IRI',
       s.permitted_values
  FROM (VALUES
    ('Systems/TEMPERATURE', 10, 'Machine system temperature', 'TEMPERATURE', 'CELSIUS', NULL::text[]),
    ('Systems/AVAILABILITY', 12, 'Whether the device is available to report', 'AVAILABILITY', NULL, NULL),
    ('Axes/DISPLACEMENT', 10, 'Axis displacement amplitude', 'DISPLACEMENT', 'MILLIMETER', NULL),
    ('Axes/C/ANGLE', 10, 'Angular position of the C axis (MTConnect ANGLE on the Axes component)', 'ANGLE', 'DEGREE', NULL),
    ('Axes/X/POSITION', 10, 'Linear position of the X axis', 'POSITION', 'MILLIMETER', NULL),
    ('Axes/Y/POSITION', 10, 'Linear position of the Y axis', 'POSITION', 'MILLIMETER', NULL),
    ('Axes/Z/POSITION', 10, 'Linear position of the Z axis', 'POSITION', 'MILLIMETER', NULL),
    ('Axes/S/ROTARY_VELOCITY', 10, 'Spindle rotational velocity', 'ROTARY_VELOCITY', 'REVOLUTION/MINUTE', NULL),
    ('Axes/S/LOAD', 10, 'Spindle load as a percentage of rated load', 'LOAD', 'PERCENT', NULL),
    ('Controller/EXECUTION', 12, 'Controller execution state: READY / ACTIVE / INTERRUPTED / FEED_HOLD / STOPPED',
     'EXECUTION', NULL, ARRAY['READY', 'ACTIVE', 'INTERRUPTED', 'FEED_HOLD', 'STOPPED']),
    ('Controller/EMERGENCY_STOP', 12, 'Emergency stop circuit: ARMED (healthy) or TRIGGERED',
     'EMERGENCY_STOP', NULL, ARRAY['ARMED', 'TRIGGERED']),
    ('Controller/FIRMWARE', 12, 'Controller firmware version', 'FIRMWARE', NULL, NULL),
    ('Controller/PATH_FEEDRATE', 10, 'Commanded feedrate along the tool path', 'PATH_FEEDRATE', 'MILLIMETER/SECOND', NULL),
    ('Controller/CONTROLLER_MODE', 12, 'Controller operating mode', 'CONTROLLER_MODE', NULL, NULL),
    ('Controller/PROGRAM', 12, 'Name of the executing part program', 'PROGRAM', NULL, NULL),
    ('Controller/PART_COUNT', 10, 'Parts completed by this controller', 'PART_COUNT', 'COUNT', NULL),
    ('SERIAL_NUMBER', 12, 'Manufacturer serial number', 'SERIAL_NUMBER', NULL, NULL)
  ) AS s(name, datatype, description, concept, units, permitted_values)
  JOIN public.mtconnect_vocabulary v ON v.name = s.concept AND v.kind = 'DATA_ITEM_TYPE'
ON CONFLICT (name) DO NOTHING;

-- OPC UA companion specifications: robotics, machinery and energy (14 rows). Joined on
-- (companion_spec, name), the vocabulary's key, since `Mass` and `Temperature` appear under more
-- than one specification. `concept` is the browse name the semantic id comes from, and the id is
-- the ExpandedNodeId the specification publishes for it.
INSERT INTO public.metric_catalog (name, datatype, description, category, units, standard,
                                   semantic_id, semantic_id_type)
SELECT s.name, s.datatype, s.description, s.category, s.units, 'OPC UA', v.semantic_id, 'ExpandedNodeId'
  FROM (VALUES
    ('MotionDevice/ActualPosition', 10, 'Current tool-centre-point position', 'SAMPLE', 'MILLIMETER', 'OPC 40010 Robotics', 'ActualPosition'),
    ('MotionDevice/ActualSpeed', 10, 'Current tool-centre-point speed', 'SAMPLE', 'MILLIMETER/SECOND', 'OPC 40010 Robotics', 'ActualSpeed'),
    ('MotionDevice/EmergencyStop', 11, 'Emergency stop circuit engaged', 'EVENT', NULL, 'OPC 40010 Robotics', 'EmergencyStop'),
    ('MotionDevice/ProtectiveStop', 11, 'Protective stop engaged', 'EVENT', NULL, 'OPC 40010 Robotics', 'ProtectiveStop'),
    ('MotionDevice/OnPath', 11, 'Whether the device is on its planned path', 'EVENT', NULL, 'OPC 40010 Robotics', 'OnPath'),
    ('MotionDevice/TaskProgramName', 12, 'Name of the executing task program', 'EVENT', NULL, 'OPC 40010 Robotics', 'TaskProgramName'),
    ('MotionDevice/OverridePercent', 10, 'Operator speed override applied to programmed motion. OPC 40010 calls this browse name SpeedOverride; the semantic id binds this metric to that concept.',
     'SAMPLE', 'PERCENT', 'OPC 40010 Robotics', 'SpeedOverride'),
    ('Machine/OperationalMode', 12, 'Operational mode of the motion device', 'EVENT', NULL, 'OPC 40010 Robotics', 'OperationalMode'),
    ('Machine/SpeedOverride', 10, 'Operator speed override', 'SAMPLE', 'PERCENT', 'OPC 40010 Robotics', 'SpeedOverride'),
    ('Machine/OperatingMode', 12, 'Machine operating mode -- Processing, Setup, Maintenance or None. OPC 40001 calls this browse name MachineryOperationMode; the semantic id binds this metric to that concept.',
     'EVENT', NULL, 'OPC 40001 Machinery', 'MachineryOperationMode'),
    ('Energy/Pressure', 10, 'Compressed-air supply pressure', 'SAMPLE', 'PASCAL', 'OPC 40001-4 Machinery Energy', 'Pressure'),
    ('Energy/Temperature', 10, 'Coolant or medium temperature', 'SAMPLE', 'CELSIUS', 'OPC 40001-4 Machinery Energy', 'Temperature'),
    ('Energy/VolumeFlowRate', 10, 'Medium volumetric flow rate', 'SAMPLE', 'LITER/SECOND', 'OPC 40001-4 Machinery Energy', 'VolumeFlowRate'),
    ('Energy/Volume', 10, 'Cumulative medium volume', 'SAMPLE', 'LITER', 'OPC 40001-4 Machinery Energy', 'Volume')
  ) AS s(name, datatype, description, category, units, spec, concept)
  JOIN public.opcua_vocabulary v ON v.companion_spec = s.spec AND v.name = s.concept
ON CONFLICT (name) DO NOTHING;

-- ASHRAE 223P: facility and BMS ambient telemetry (5 rows). The semantic id names a sensor class,
-- not a quantity: 223P attaches a measured Property to a Sensor, and this catalog has one flat name
-- per series. A metric name forbids the hyphen in `Constituent-CO2`, hence `BMS/CO2_CONCENTRATION`.
INSERT INTO public.metric_catalog (name, datatype, description, category, units, standard,
                                   semantic_id, semantic_id_type)
SELECT s.name, s.datatype, s.description, s.category, s.units, 'ASHRAE 223P', v.semantic_id, 'IRI'
  FROM (VALUES
    ('BMS/ZONE_TEMPERATURE', 10, 'Zone air temperature', 'SAMPLE', 'CELSIUS', 'TemperatureSensor'),
    ('BMS/ZONE_HUMIDITY', 10, 'Zone relative humidity', 'SAMPLE', 'PERCENT', 'HumiditySensor'),
    ('BMS/CO2_CONCENTRATION', 10, 'Zone CO2 concentration', 'SAMPLE', 'PARTS/MILLION', 'Constituent-CO2'),
    ('BMS/STATIC_PRESSURE', 10, 'Duct static pressure', 'SAMPLE', 'PASCAL', 'PressureSensor'),
    ('BMS/SUPPLY_AIR_FLOW', 10, 'Supply air volumetric flow rate', 'SAMPLE', 'LITER/SECOND', 'FlowSensor')
  ) AS s(name, datatype, description, category, units, concept)
  JOIN public.ashrae223_vocabulary v ON v.name = s.concept
ON CONFLICT (name) DO NOTHING;

-- ISO 22400: KPIs a device publishes (8 rows). Registered, not computed: nothing here derives them
-- (docs/vocabularies.md). The unit is the KPI's, and a row with no description takes the KPI's.
INSERT INTO public.metric_catalog (name, datatype, description, category, units, standard,
                                   semantic_id, semantic_id_type)
SELECT s.name, 10, COALESCE(s.description, v.description), 'SAMPLE', v.unit, 'ISO 22400',
       v.semantic_id, 'IRI'
  FROM (VALUES
    ('OEE/AVAILABILITY', 'ISO 22400 availability ratio -- NOT MTConnect AVAILABILITY, which means "device connected"', 'AVAILABILITY'),
    ('OEE/EFFECTIVENESS', 'ISO 22400 effectiveness ratio (E) -- the OEE factor commonly called Performance', 'EFFECTIVENESS'),
    ('OEE/QUALITY', 'ISO 22400 quality ratio', 'QUALITY'),
    ('OEE/OEE', NULL, 'OEE'),
    ('OEE/UTILIZATION', NULL, 'UTILIZATION'),
    ('OEE/SCRAP_RATIO', NULL, 'SCRAP_RATIO'),
    ('OEE/MTBF', NULL, 'MTBF'),
    ('OEE/MTTR', NULL, 'MTTR')
  ) AS s(name, description, concept)
  JOIN public.iso22400_vocabulary v ON v.name = s.concept
ON CONFLICT (name) DO NOTHING;
