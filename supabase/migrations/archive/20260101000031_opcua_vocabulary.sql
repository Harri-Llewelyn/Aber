-- Migration: 20260101000031_opcua_vocabulary.sql
-- Description: A reference vocabulary of OPC UA companion-specification data points -- OPC 40001
-- (Machinery) and OPC 40010 (Robotics) -- as a third source the Add Metric form can build from.
--
-- Same stance as mtconnect_vocabulary (0018) and iso22400_vocabulary (0030): a vocabulary, never a
-- catalog. `ActualPosition` here is a variable the companion spec defines on an axis type; the
-- metric a device publishes is a component path plus that name, e.g. `MotionDevice/J1/ActualPosition`.
-- Which axes exist is per-robot, so the spec can only supply the words.
--
-- WHY THREE STANDARDS RATHER THAN ONE
-- They cover different assets and do not overlap much. MTConnect is the machine-tool vocabulary,
-- OPC UA Robotics is where articulated arms and AGV motion systems are actually modelled, and ISO
-- 22400 supplies the computed KPIs both deliberately exclude. A research fleet of CNCs, robots,
-- AGVs and sensors needs all three. `metric_catalog.standard` records which one a metric came from,
-- and the semantic id is what lets an AAS export state it in a machine-readable way.
--
-- ⚠ NODE IDS ARE BROWSE PATHS, NOT NUMERIC NodeIds -- READ THIS BEFORE USING THEM.
-- A real OPC UA NodeId is namespace-index + identifier, and the numeric identifiers are assigned by
-- the published NodeSet2 XML for each companion spec. Those files are not vendored here, so this
-- migration records the *browse path* under the spec's namespace URI in ExpandedNodeId string form
-- (`nsu=<namespace>;s=<BrowsePath>`) rather than asserting numeric ids it cannot check. That form is
-- valid ExpandedNodeId syntax and unambiguous to a human, but a client cannot resolve it against a
-- live server without the nodeset. Resolve the numeric ids from the official NodeSet2 files before
-- wiring an actual OPC UA client to any of this.
--
-- The browse names themselves are transcribed from the companion specifications and should be
-- confirmed against the published NodeSet2 XML -- OPC 40001 and OPC 40010 have both revised
-- structure across releases. Everything here is reference data used to *suggest* metric names; a
-- wrong browse name produces a badly-named metric, not a runtime failure.
--
-- semantic_id is the namespace URI plus the browse name. That is a well-formed IRI derived from an
-- identifier the OPC Foundation does publish (the namespace), which makes it a defensible AAS
-- semanticId -- but it is not a concept URI the OPC Foundation itself registers or resolves.

CREATE TABLE IF NOT EXISTS public.opcua_vocabulary (
    -- The OPC UA BrowseName of the variable or property.
    name TEXT NOT NULL,
    -- Which companion specification defines it. Part of the key: the same BrowseName legitimately
    -- appears in more than one spec (Machinery and Robotics both define Manufacturer).
    companion_spec TEXT NOT NULL,
    -- ExpandedNodeId string form: `nsu=<namespace URI>;s=<BrowsePath>`. See the warning above --
    -- the identifier is a browse path, not the numeric id from the nodeset.
    node_id TEXT,
    description TEXT,
    -- The OPC UA built-in DataType (Double, Boolean, String, Int32, LocalizedText, ...), not a
    -- Sparkplug datatype code. The form maps it when prefilling.
    datatype TEXT,
    -- Recorded with MTConnect UnitEnum spellings wherever one exists, so a prefilled unit lands on
    -- a value the units picker already offers. OPC UA carries engineering units as a UNECE code on
    -- an AnalogItem's EUInformation; those codes are not transcribed here.
    unit TEXT,
    semantic_id TEXT,
    PRIMARY KEY (companion_spec, name)
);

COMMENT ON TABLE public.opcua_vocabulary IS
  'OPC UA companion specification data points (OPC 40001 Machinery, OPC 40010 Robotics). Reference data, not deployment state. node_id holds a browse path, not a resolvable numeric NodeId -- see the migration header.';

ALTER TABLE public.opcua_vocabulary ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "opcua_vocabulary_select_authenticated" ON public.opcua_vocabulary;
CREATE POLICY "opcua_vocabulary_select_authenticated" ON public.opcua_vocabulary
  FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.opcua_vocabulary FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.opcua_vocabulary TO authenticated;

-- OPC 40001 -- Machinery. Identification and lifecycle state that applies to any machine, which is
-- what makes it the natural companion to a robot- or tool-specific spec rather than a rival to one.
INSERT INTO public.opcua_vocabulary (name, companion_spec, node_id, description, datatype, unit, semantic_id) VALUES
  ('Manufacturer', 'OPC 40001 Machinery',
   'nsu=http://opcfoundation.org/UA/Machinery/;s=Machine/Identification/Manufacturer',
   'Name of the machine manufacturer.', 'LocalizedText', NULL,
   'http://opcfoundation.org/UA/Machinery/Manufacturer'),

  ('Model', 'OPC 40001 Machinery',
   'nsu=http://opcfoundation.org/UA/Machinery/;s=Machine/Identification/Model',
   'Manufacturer-assigned model name of the machine.', 'LocalizedText', NULL,
   'http://opcfoundation.org/UA/Machinery/Model'),

  ('SerialNumber', 'OPC 40001 Machinery',
   'nsu=http://opcfoundation.org/UA/Machinery/;s=Machine/Identification/SerialNumber',
   'Serial number uniquely identifying this machine instance for its manufacturer.', 'String', NULL,
   'http://opcfoundation.org/UA/Machinery/SerialNumber'),

  ('ProductInstanceUri', 'OPC 40001 Machinery',
   'nsu=http://opcfoundation.org/UA/Machinery/;s=Machine/Identification/ProductInstanceUri',
   'Globally unique URI for this machine instance. The closest OPC UA equivalent to an AAS globalAssetId, and the natural anchor when cross-referencing a shell.', 'String', NULL,
   'http://opcfoundation.org/UA/Machinery/ProductInstanceUri'),

  ('SoftwareRevision', 'OPC 40001 Machinery',
   'nsu=http://opcfoundation.org/UA/Machinery/;s=Machine/Identification/SoftwareRevision',
   'Software or firmware revision of the machine.', 'String', NULL,
   'http://opcfoundation.org/UA/Machinery/SoftwareRevision'),

  ('YearOfConstruction', 'OPC 40001 Machinery',
   'nsu=http://opcfoundation.org/UA/Machinery/;s=Machine/Identification/YearOfConstruction',
   'Year the machine was built.', 'UInt16', NULL,
   'http://opcfoundation.org/UA/Machinery/YearOfConstruction'),

  ('MachineryItemState', 'OPC 40001 Machinery',
   'nsu=http://opcfoundation.org/UA/Machinery/;s=Machine/MachineryItemState/CurrentState',
   'Lifecycle state of the machine: Executing, NotExecuting, NotAvailable or OutOfService. The OPC UA analogue of the execution state a controller reports -- a discrete state, so a String metric rather than a numeric one.',
   'LocalizedText', NULL,
   'http://opcfoundation.org/UA/Machinery/MachineryItemState'),

  ('MachineryOperationMode', 'OPC 40001 Machinery',
   'nsu=http://opcfoundation.org/UA/Machinery/;s=Machine/MachineryOperationMode/CurrentState',
   'Operating mode of the machine: Processing, Setup, Maintenance or Normal.', 'LocalizedText', NULL,
   'http://opcfoundation.org/UA/Machinery/MachineryOperationMode'),

  ('OperationalTime', 'OPC 40001 Machinery',
   'nsu=http://opcfoundation.org/UA/Machinery/;s=Machine/MachineryBuildingBlocks/OperationCounters/OperationalTime',
   'Accumulated time the machine has been operational. Feeds the ISO 22400 availability and MTBF calculations rather than replacing them.',
   'Double', 'SECOND',
   'http://opcfoundation.org/UA/Machinery/OperationalTime'),

  ('PowerOnDuration', 'OPC 40001 Machinery',
   'nsu=http://opcfoundation.org/UA/Machinery/;s=Machine/MachineryBuildingBlocks/OperationCounters/PowerOnDuration',
   'Accumulated time the machine has been powered on.', 'Double', 'SECOND',
   'http://opcfoundation.org/UA/Machinery/PowerOnDuration'),

-- OPC 40010 -- Robotics. The motion-device model: this is where articulated arms and AGV drive
-- systems are described, and it is the gap MTConnect leaves for non-machine-tool assets.
  ('ActualPosition', 'OPC 40010 Robotics',
   'nsu=http://opcfoundation.org/UA/Robotics/;s=MotionDevice/Axes/Axis/ActualPosition',
   'Current position of an axis. Units follow the axis type -- MILLIMETER for a linear axis, DEGREE for a rotary one -- so the unit is a choice at metric-creation time, not a property of the browse name.',
   'Double', 'MILLIMETER',
   'http://opcfoundation.org/UA/Robotics/ActualPosition'),

  ('ActualSpeed', 'OPC 40010 Robotics',
   'nsu=http://opcfoundation.org/UA/Robotics/;s=MotionDevice/Axes/Axis/ActualSpeed',
   'Current speed of an axis. On a rotary axis this is the angular velocity; pick DEGREE/SECOND rather than MILLIMETER/SECOND for those.',
   'Double', 'MILLIMETER/SECOND',
   'http://opcfoundation.org/UA/Robotics/ActualSpeed'),

  ('ActualAcceleration', 'OPC 40010 Robotics',
   'nsu=http://opcfoundation.org/UA/Robotics/;s=MotionDevice/Axes/Axis/ActualAcceleration',
   'Current acceleration of an axis.', 'Double', NULL,
   'http://opcfoundation.org/UA/Robotics/ActualAcceleration'),

  ('MotionProfile', 'OPC 40010 Robotics',
   'nsu=http://opcfoundation.org/UA/Robotics/;s=MotionDevice/Axes/Axis/MotionProfile',
   'Kind of motion the axis performs -- rotary, linear or spindle.', 'String', NULL,
   'http://opcfoundation.org/UA/Robotics/MotionProfile'),

  ('SpeedOverride', 'OPC 40010 Robotics',
   'nsu=http://opcfoundation.org/UA/Robotics/;s=MotionDevice/ParameterSet/SpeedOverride',
   'Operator speed override applied to programmed motion, as a percentage. The robotics counterpart of a machine tool feed-rate override.',
   'Double', 'PERCENT',
   'http://opcfoundation.org/UA/Robotics/SpeedOverride'),

  ('InControl', 'OPC 40010 Robotics',
   'nsu=http://opcfoundation.org/UA/Robotics/;s=MotionDevice/ParameterSet/InControl',
   'Whether the motion device is under control of its controller.', 'Boolean', NULL,
   'http://opcfoundation.org/UA/Robotics/InControl'),

  ('OnPath', 'OPC 40010 Robotics',
   'nsu=http://opcfoundation.org/UA/Robotics/;s=MotionDevice/ParameterSet/OnPath',
   'Whether the motion device is on its programmed path.', 'Boolean', NULL,
   'http://opcfoundation.org/UA/Robotics/OnPath'),

  ('MotionDeviceCategory', 'OPC 40010 Robotics',
   'nsu=http://opcfoundation.org/UA/Robotics/;s=MotionDevice/MotionDeviceCategory',
   'Kind of motion device -- articulated robot, cartesian robot, AGV and so on.', 'String', NULL,
   'http://opcfoundation.org/UA/Robotics/MotionDeviceCategory'),

  ('Mass', 'OPC 40010 Robotics',
   'nsu=http://opcfoundation.org/UA/Robotics/;s=MotionDevice/AdditionalLoad/Mass',
   'Mass of a load carried by the motion device -- the payload weight, including the tool where the tool is modelled as part of the load.',
   'Double', 'KILOGRAM',
   'http://opcfoundation.org/UA/Robotics/Mass'),

  ('EmergencyStop', 'OPC 40010 Robotics',
   'nsu=http://opcfoundation.org/UA/Robotics/;s=MotionDevice/SafetyStates/SafetyState/EmergencyStop',
   'Emergency stop state of the motion device. Note the sense: this asserts the stop is active, the inverse of a "safety OK" boolean.',
   'Boolean', NULL,
   'http://opcfoundation.org/UA/Robotics/EmergencyStop'),

  ('ProtectiveStop', 'OPC 40010 Robotics',
   'nsu=http://opcfoundation.org/UA/Robotics/;s=MotionDevice/SafetyStates/SafetyState/ProtectiveStop',
   'Protective stop state -- a guard, light curtain or safety-rated sensor has halted motion.', 'Boolean', NULL,
   'http://opcfoundation.org/UA/Robotics/ProtectiveStop'),

  ('OperationalMode', 'OPC 40010 Robotics',
   'nsu=http://opcfoundation.org/UA/Robotics/;s=MotionDevice/SafetyStates/SafetyState/OperationalMode',
   'Safety-relevant operating mode of the motion device -- automatic, manual reduced speed, manual high speed.',
   'String', NULL,
   'http://opcfoundation.org/UA/Robotics/OperationalMode'),

  ('TaskProgramName', 'OPC 40010 Robotics',
   'nsu=http://opcfoundation.org/UA/Robotics/;s=Controller/TaskControl/TaskProgramName',
   'Name of the task program currently loaded on the controller.', 'String', NULL,
   'http://opcfoundation.org/UA/Robotics/TaskProgramName'),

  ('ExecutionMode', 'OPC 40010 Robotics',
   'nsu=http://opcfoundation.org/UA/Robotics/;s=Controller/TaskControl/ExecutionMode',
   'Execution mode of the loaded task program -- continuous, step or cycle.', 'String', NULL,
   'http://opcfoundation.org/UA/Robotics/ExecutionMode'),

  ('TotalPowerOnTime', 'OPC 40010 Robotics',
   'nsu=http://opcfoundation.org/UA/Robotics/;s=Controller/ParameterSet/TotalPowerOnTime',
   'Accumulated controller power-on time.', 'Double', 'SECOND',
   'http://opcfoundation.org/UA/Robotics/TotalPowerOnTime')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;

-- The components these browse paths hang off, registered as metric groups so the Add Metric form
-- can offer them. `Controller` already exists as an MTConnect component type (0018) and is
-- deliberately reused rather than forked: a controller is a controller in both vocabularies, and
-- enforce_metric_group_spelling would in any case reject a second spelling of it.
INSERT INTO public.metric_groups (name, description, standard) VALUES
  ('Machine',      'OPC UA Machinery (OPC 40001) machine-level identification and state', 'OPC UA'),
  ('MotionDevice', 'OPC UA Robotics (OPC 40010) motion device -- axes, safety states and motion parameters', 'OPC UA')
ON CONFLICT (lower(name)) DO NOTHING;

NOTIFY pgrst, 'reload schema';
