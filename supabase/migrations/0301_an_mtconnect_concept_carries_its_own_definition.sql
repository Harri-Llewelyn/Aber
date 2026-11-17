-- 0301: An MTConnect concept carries its own definition.
--
-- An exported ConceptDescription takes its IEC 61360 definition from `concept_definitions`, the view
-- of the vocabularies' own text (0169). MTConnect had no arm in it, because `mtconnect_vocabulary`
-- had no description column, so a data item type was defined by catalog text: by the one
-- description every live metric carrying it agreed on, or else by a sentence naming it ("POSITION,
-- as MTConnect defines it."). Catalog text is a site's own words, which is what the other
-- vocabularies moved away from.
--
--   * mtconnect_vocabulary.description is added. It holds the text MTConnect publishes for a data
--     item type, in `DataItemEnumEnum` of MTConnectDevices_2.7.xsd, rendered to plain words. The
--     other kinds (subtypes, units, components) have none and keep NULL, as does ELEVATION, which
--     2.8 added and the 2.7 XSD does not document.
--   * The values arrive in this file's generated block below, not in 0002: 0002 is released, so its
--     rows cannot gain a column in place. scripts/generate-mtconnect-vocabulary.mjs writes the block
--     and scripts/check-mtconnect-seed-sync.mjs checks it.
--   * concept_definitions is redeclared with an MTConnect arm after ISO 22400's. 0169 orders the arms
--     by how far from this deployment each vocabulary's ids are issued, and MTConnect's are minted
--     under aber.local, as ISO 22400's are. The view's columns do not change, so its grants and
--     security_invoker stay. (A view, so not a `-- Redefines` line: those mark functions.)
--
-- ⚠ VERIFY. The text is the MTConnect model's own, read from the XSD that scripts/vocabularies/
-- keeps whole and pins by SHA-256. AMT publishes it under a BSD-style licence whose notice NOTICE.md
-- carries. The XSD is 2.7, the newest published; the 2.8 files are JSON Schemas with no type
-- documentation. Adopting the text is not an MTConnect compliance claim.
--
-- Reasoning: supabase/README.md, "An MTConnect concept carries its own definition (0301)". Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The column
-- -------------------------------------------------------------------------------------------------
ALTER TABLE public.mtconnect_vocabulary ADD COLUMN IF NOT EXISTS description text;

COMMENT ON COLUMN public.mtconnect_vocabulary.description IS
  'What MTConnect says the entry is, from the XSD''s documentation of the data item type, in plain '
  'words. NULL for every other kind of row and for a type the XSD does not document. Generated; '
  'concept_definitions serves it as the concept''s definition (0301).';

-- -------------------------------------------------------------------------------------------------
-- 2. The text
-- -------------------------------------------------------------------------------------------------
-- >>> BEGIN GENERATED mtconnect_descriptions -- MTConnect 2.7, 248 of 249 data item types, sha256:c4209917912319a0
-- GENERATED from scripts/vocabularies/MTConnectDevices_2.7.xsd by scripts/generate-mtconnect-vocabulary.mjs.
-- Do not edit these rows by hand: change the script and re-run it. CI verifies the digest above.
UPDATE public.mtconnect_vocabulary AS v
   SET description = d.description
  FROM (VALUES
  ('ACCELERATION', 'positive rate of change of velocity.'),
  ('ACCUMULATED_TIME', 'accumulated time for an activity or event.'),
  ('ACTIVATION_COUNT', 'accumulation of the number of times a function has attempted to, or is planned to attempt to, activate or be performed.'),
  ('ACTIVE_AXES', 'set of axes currently associated with a Path or Controller.'),
  ('ACTIVE_POWER_SOURCE', 'active energy source for the Component.'),
  ('ACTUATOR', 'indication of a fault associated with an actuator.'),
  ('ACTUATOR_STATE', 'operational state of an apparatus for moving or controlling a mechanism or system.'),
  ('ADAPTER_SOFTWARE_VERSION', 'originator’s software version of the adapter.'),
  ('ADAPTER_URI', 'URI of the adapter.'),
  ('ALARM', 'DEPRECATED: Replaced with CONDITION category data items in Version 1.1.0.'),
  ('ALARM_LIMIT', 'set of limits used to trigger warning or alarm indicators. DEPRECATED in Version 2.5. Replaced by ALARM_LIMITS.'),
  ('ALARM_LIMITS', 'set of limits used to trigger warning or alarm indicators.'),
  ('AMPERAGE', 'strength of electrical current. DEPRECATED in Version 1.6. Replaced by AMPERAGE_AC and AMPERAGE_DC.'),
  ('AMPERAGE_AC', 'electrical current that reverses direction at regular short intervals.'),
  ('AMPERAGE_DC', 'electric current flowing in one direction only.'),
  ('ANGLE', 'angular position.'),
  ('ANGULAR_ACCELERATION', 'positive rate of change of angular velocity.'),
  ('ANGULAR_DECELERATION', 'negative rate of change of angular velocity.'),
  ('ANGULAR_VELOCITY', 'rate of change of angular position.'),
  ('APPLICATION', 'application on a Component.'),
  ('ASSET_ADDED', 'assetId of the Asset that has been added.'),
  ('ASSET_CHANGED', 'assetId of the Asset that has been changed.'),
  ('ASSET_COUNT', 'data set of the number of Assets of a given type for a Device.'),
  ('ASSET_REMOVED', 'assetId of the Asset that has been removed.'),
  ('ASSET_UPDATE_RATE', 'average rate of change of values for assets in the MTConnect streams. The average is computed over a rolling window defined by the implementation.'),
  ('ASSOCIATED_ASSET_ID', 'assetId of the Assets associated with a Component.'),
  ('AVAILABILITY', 'agent''s ability to communicate with the data source.'),
  ('AXIS_COUPLING', 'describes the way the axes will be associated to each other. This is used in conjunction with COUPLED_AXES to indicate the way they are interacting.'),
  ('AXIS_FEEDRATE', 'feedrate of a linear axis.'),
  ('AXIS_FEEDRATE_OVERRIDE', 'value of a signal or calculation issued to adjust the feedrate of an individual linear type axis.'),
  ('AXIS_INTERLOCK', 'state of the axis lockout function when power has been removed and the axis is allowed to move freely.'),
  ('AXIS_STATE', 'state of a Linear or Rotary component representing an axis.'),
  ('BATTERY_CAPACITY', 'maximum rated charge a battery is capable of maintaining based on the battery discharging at a specified current over a specified time period.'),
  ('BATTERY_CHARGE', 'value of the battery''s present capacity expressed as a percentage of the battery''s maximum rated capacity.'),
  ('BATTERY_STATE', 'present status of the battery.'),
  ('BINDING_STATE', 'state of the binding process when Component participates in a task as a collaborator'),
  ('BLOCK', 'line of code or command being executed by a Controller entity.'),
  ('BLOCK_COUNT', 'total count of the number of blocks of program code that have been executed since execution started.'),
  ('CAPACITY_FLUID', 'maximum amount of fluid that can be held by a container.'),
  ('CAPACITY_SPATIAL', 'maximum amount of material that can be held by a container.'),
  ('CHARACTERISTIC_PERSISTENT_ID', 'UUID of the characteristic.'),
  ('CHARACTERISTIC_STATUS', 'pass/fail result of the measurement.'),
  ('CHARGE_RATE', 'value of the current being supplied to the Component for the purpose of charging.'),
  ('CHUCK_INTERLOCK', 'state of an interlock function or control logic state intended to prevent the associated Chuck component from being operated.'),
  ('CHUCK_STATE', 'operating state of a mechanism that holds a part or stock material during a manufacturing process. It may also represent a mechanism that holds any other mechanism in place within a piece of equipment.'),
  ('CLOCK_TIME', 'time provided by a timing device at a specific point in time.'),
  ('CODE', 'programmatic code being executed. DEPRECATED in Version 1.1.'),
  ('COMMUNICATIONS', 'indication that the piece of equipment has experienced a communications failure.'),
  ('COMPONENT_DATA', 'Event that represents a Component where the EntryDefinition identifies the Component and the CellDefinitions define the Component''s observed DataItems.'),
  ('COMPOSITION_STATE', 'operating state of a mechanism represented by a Composition entity.'),
  ('CONCENTRATION', 'percentage of one component within a mixture of components.'),
  ('CONDUCTIVITY', 'ability of a material to conduct electricity.'),
  ('CONNECTION_STATUS', 'status of the connection between an adapter and an agent.'),
  ('CONTROL_LIMIT', 'set of limits used to indicate whether a process variable is stable and in control. DEPRECATED in Version 2.5. Replaced by CONTROL_LIMITS.'),
  ('CONTROL_LIMITS', 'set of limits used to indicate whether a process variable is stable and in control.'),
  ('CONTROLLER_MODE', 'current mode of the Controller component.'),
  ('CONTROLLER_MODE_OVERRIDE', 'setting or operator selection that changes the behavior of a piece of equipment.'),
  ('COUPLED_AXES', 'set of associated axes.'),
  ('CUTTING_SPEED', 'speed difference (relative velocity) between the cutting mechanism and the surface of the workpiece it is operating on.'),
  ('CYCLE_COUNT', 'accumulation of the number of times a cyclic function has attempted to, or is planned to attempt to execute.'),
  ('DATA_RANGE', 'indication that the value of the data associated with a measured value or a calculation is outside of an expected range.'),
  ('DATE_CODE', 'time and date code associated with a material or other physical item.'),
  ('DEACTIVATION_COUNT', 'accumulation of the number of times a function has attempted to, or is planned to attempt to, deactivate or cease.'),
  ('DECELERATION', 'negative rate of change of velocity.'),
  ('DENSITY', 'volumetric mass of a material per unit volume of that material.'),
  ('DEPOSITION_ACCELERATION_VOLUMETRIC', 'rate of change in spatial volume of material deposited in an additive manufacturing process.'),
  ('DEPOSITION_DENSITY', 'density of the material deposited in an additive manufacturing process per unit of volume.'),
  ('DEPOSITION_MASS', 'mass of the material deposited in an additive manufacturing process.'),
  ('DEPOSITION_RATE_VOLUMETRIC', 'rate at which a spatial volume of material is deposited in an additive manufacturing process.'),
  ('DEPOSITION_VOLUME', 'spatial volume of material to be deposited in an additive manufacturing process.'),
  ('DEPTH', 'dimension or distance as measured downwards from the top'),
  ('DEVICE_ADDED', 'UUID of new device added to an MTConnect Agent.'),
  ('DEVICE_CHANGED', 'UUID of the device whose metadata has changed.'),
  ('DEVICE_REMOVED', 'UUID of a device removed from an MTConnect Agent.'),
  ('DEVICE_UUID', 'identifier of another piece of equipment that is temporarily associated with a component of this piece of equipment to perform a particular function.'),
  ('DEW_POINT', 'temperature at which moisture begins to condense, corresponding to saturation for a given absolute humidity.'),
  ('DIAMETER', 'dimension of a diameter.'),
  ('DIRECTION', 'direction of motion.'),
  ('DISCHARGE_RATE', 'value of current being drawn from the Component.'),
  ('DISPLACEMENT', 'change in position of an object.'),
  ('DISPLACEMENT_ANGULAR', 'absolute value of the change in angular position around a vector'),
  ('DISPLACEMENT_LINEAR', 'absolute value of the change in position along a vector.'),
  ('DOOR_STATE', 'operational state of a Door component or composition element.'),
  ('ELECTRICAL_ENERGY', 'Wattage used or generated by a component over an interval of time.'),
  ('EMERGENCY_STOP', 'state of the emergency stop signal for a piece of equipment, controller path, or any other component or subsystem of a piece of equipment.'),
  ('END_OF_BAR', 'indication of whether the end of a piece of bar stock being feed by a bar feeder has been reached.'),
  ('EQUIPMENT_MODE', 'indication that a piece of equipment, or a sub-part of a piece of equipment, is performing specific types of activities.'),
  ('EQUIPMENT_TIMER', 'amount of time a piece of equipment or a sub-part of a piece of equipment has performed specific activities.'),
  ('EXECUTION', 'operating state of a Component.'),
  ('FEATURE_MEASUREMENT', 'assessing elements of a feature.'),
  ('FEATURE_PERSISTENT_ID', 'UUID of a feature. [ISO 10303 AP 242/239].'),
  ('FILL_HEIGHT', 'amount of a substance in a container.'),
  ('FILL_LEVEL', 'amount of a substance remaining compared to the planned maximum amount of that substance.'),
  ('FIRMWARE', 'embedded software of a Component .'),
  ('FIXTURE_ASSET_ID', 'assetId of the Fixture that is associated with a Component'),
  ('FIXTURE_ID', 'identifier for the current workholding or part clamp in use by a piece of equipment.'),
  ('FLOW', 'rate of flow of a fluid.'),
  ('FOLLOWING_ERROR', 'difference between actual and commanded position at any specific point in time during a motion.'),
  ('FOLLOWING_ERROR_ANGULAR', 'angular difference between the commanded encoder/resolver position and the actual encoder/resolver position at any specified point in time during a motion.'),
  ('FOLLOWING_ERROR_LINEAR', 'difference between the commanded encoder/resolver position and the actual encoder/resolver position at any specified point in time during a motion.'),
  ('FREQUENCY', 'number of occurrences of a repeating event per unit time.'),
  ('FUNCTIONAL_MODE', 'current intended production status of the Component.'),
  ('GLOBAL_POSITION', 'position in three-dimensional space. DEPRECATED in Version 1.1.'),
  ('GRAVITATIONAL_ACCELERATION', 'acceleration relative to Earth''s gravity of 9.80665 METER/SECOND^2.'),
  ('GRAVITATIONAL_FORCE', 'force relative to earth''s gravity.'),
  ('HARDNESS', 'hardness of a material.'),
  ('HARDWARE', 'hardware of a Component.'),
  ('HOST_NAME', 'name of the host computer supplying data.'),
  ('HUMIDITY_ABSOLUTE', 'amount of water vapor expressed in grams per cubic meter.'),
  ('HUMIDITY_RELATIVE', 'amount of water vapor present expressed as a percent to reach saturation at the same temperature.'),
  ('HUMIDITY_SPECIFIC', 'ratio of the water vapor present over the total weight of the water vapor and air present expressed as a percent.'),
  ('LEAK_DETECT', 'indication designating whether a leak has been detected.'),
  ('LENGTH', 'length of an object.'),
  ('LEVEL', 'level of a resource. DEPRECATED in Version 1.2. See FILL_LEVEL.'),
  ('LIBRARY', 'software library on a Component'),
  ('LINE', 'current line of code being executed. DEPRECATED in Version 1.4.0.'),
  ('LINE_LABEL', 'identifier for a Block of code in a Program.'),
  ('LINE_NUMBER', 'position of a block of program code within a control program.'),
  ('LINEAR_FORCE', 'force applied to a mass in one direction only.'),
  ('LOAD', 'actual versus the standard rating of a piece of equipment.'),
  ('LOAD_COUNT', 'accumulation of the number of times an operation has attempted to, or is planned to attempt to, load materials, parts, or other items.'),
  ('LOCATION_ADDRESS', 'structured information that allows the unambiguous determination of an object for purposes of identification and location. [ISO 19160-4:2017]'),
  ('LOCATION_NARRATIVE', 'textual description of the location of an object or activity.'),
  ('LOCATION_SPATIAL_GEOGRAPHIC', 'absolute geographic location defined by two coordinates, longitude and latitude and an elevation.'),
  ('LOCK_STATE', 'state or operating mode of a Lock.'),
  ('LOGIC_PROGRAM', 'indication that an error occurred in the logic program or programmable logic controller (PLC) associated with a piece of equipment.'),
  ('MAINTENANCE_LIST', 'actions or activities to be performed in support of a piece of equipment.'),
  ('MASS', 'mass of an object(s) or an amount of material.'),
  ('MATERIAL', 'identifier of a material used or consumed in the manufacturing process'),
  ('MATERIAL_LAYER', 'identifies the layers of material applied to a part or product as part of an additive manufacturing process.'),
  ('MEASUREMENT_TYPE', 'class of measurement being performed. [QIF 3:2018 Section 6.3]'),
  ('MEASUREMENT_UNITS', 'engineering units of the measurement.'),
  ('MEASUREMENT_VALUE', 'measurement based on the measurement type.'),
  ('MESSAGE', 'information to be transferred from a piece of equipment to a client software application.'),
  ('MOTION_PROGRAM', 'indication that an error occurred in the motion program associated with a piece of equipment.'),
  ('MTCONNECT_VERSION', 'reference version of the MTConnect Standard supported by the adapter.'),
  ('NETWORK', 'network details of a Component.'),
  ('NETWORK_PORT', 'number of the TCP/IP or UDP/IP port for the connection endpoint.'),
  ('OBSERVATION_UPDATE_RATE', 'average rate of change of values for data items in the MTConnect streams. The average is computed over a rolling window defined by the implementation.'),
  ('OPENNESS', 'percentage open where 100% is fully open and 0% is fully closed.'),
  ('OPERATING_MODE', 'state of Component or Composition that describes the automatic or manual operation of the entity.'),
  ('OPERATING_SYSTEM', 'Operating System (OS) of a Component.'),
  ('OPERATOR_ID', 'identifier of the person currently responsible for operating the piece of equipment.'),
  ('ORIENTATION', 'angular position of a plane or vector relative to a cartesian coordinate system'),
  ('PALLET_ID', 'identifier for a pallet.'),
  ('PART_COUNT', 'aggregate count of parts.'),
  ('PART_COUNT_TYPE', 'interpretation of PART_COUNT.'),
  ('PART_DETECT', 'indication designating whether a part or work piece has been detected or is present.'),
  ('PART_GROUP_ID', 'identifier given to a collection of individual parts.'),
  ('PART_ID', 'identifier of a part in a manufacturing operation.'),
  ('PART_INDEX', 'sequence of a part in a group of parts.'),
  ('PART_KIND_ID', 'identifier given to link the individual occurrence to a class of parts, typically distinguished by a particular part design.'),
  ('PART_NUMBER', 'identifier of a part or product moving through the manufacturing process. DEPRECATED in Version 1.7. PART_NUMBER is now a subType of PART_KIND_ID.'),
  ('PART_PROCESSING_STATE', 'particular condition of the part occurrence at a specific time.'),
  ('PART_STATUS', 'state or condition of a part.'),
  ('PART_UNIQUE_ID', 'identifier given to a distinguishable, individual part.'),
  ('PARTICLE_COUNT', 'number of particles counted by their size or other characteristics.'),
  ('PARTICLE_SIZE', 'size of particles counted by their size or other characteristics.'),
  ('PATH_FEEDRATE', 'feedrate for the axes, or a single axis, associated with a Path component.'),
  ('PATH_FEEDRATE_OVERRIDE', 'value of a signal or calculation issued to adjust the feedrate for the axes associated with a Path component that may represent a single axis or the coordinated movement of multiple axes.'),
  ('PATH_FEEDRATE_PER_REVOLUTION', 'feedrate for the axes, or a single axis.'),
  ('PATH_MODE', 'describes the operational relationship between a Path entity and another Path entity for pieces of equipment comprised of multiple logical groupings of controlled axes or other logical operations.'),
  ('PATH_POSITION', 'position of a control point associated with a Controller or a Path.'),
  ('PH', 'acidity or alkalinity of a solution.'),
  ('POSITION', 'point along an axis in a cartesian coordinate system.'),
  ('POSITION_CARTESIAN', 'point in a cartesian coordinate system.'),
  ('POWER_FACTOR', 'ratio of real power flowing to a load to the apparent power in that AC circuit.'),
  ('POWER_STATE', 'indication of the status of the source of energy for an entity to allow it to perform its intended function or the state of an enabling signal providing permission for the entity to perform its functions.'),
  ('POWER_STATUS', 'status of the Component. DEPRECATED in Version 1.1.0.'),
  ('PRESSURE', 'force per unit area measured relative to atmospheric pressure. Commonly referred to as gauge pressure.'),
  ('PRESSURE_ABSOLUTE', 'force per unit area measured relative to a vacuum.'),
  ('PRESSURIZATION_RATE', 'change of pressure per unit time.'),
  ('PROCESS_AGGREGATE_ID', 'identifier given to link the individual occurrence to a group of related occurrences, such as a process step in a process plan.'),
  ('PROCESS_KIND_ID', 'identifier given to link the individual occurrence to a class of processes or process definition.'),
  ('PROCESS_OCCURRENCE_ID', 'identifier of a process being executed by the device.'),
  ('PROCESS_STATE', 'particular condition of the process occurrence at a specific time.'),
  ('PROCESS_TIME', 'time and date associated with an activity or event.'),
  ('PROCESS_TIMER', 'amount of time a piece of equipment has performed different types of activities associated with the process being performed at that piece of equipment.'),
  ('PROGRAM', 'name of the logic or motion program being executed by the Controller component.'),
  ('PROGRAM_COMMENT', 'comment or non-executable statement in the control program.'),
  ('PROGRAM_EDIT', 'indication of the status of the Controller components program editing mode. A program may be edited while another is executed.'),
  ('PROGRAM_EDIT_NAME', 'name of the program being edited. This is used in conjunction with ProgramEdit when in ACTIVE state.'),
  ('PROGRAM_HEADER', 'non-executable header section of the control program.'),
  ('PROGRAM_LOCATION', 'URI for the source file associated with Program.'),
  ('PROGRAM_LOCATION_TYPE', 'defines whether the logic or motion program defined by Program is being executed from the local memory of the controller or from an outside source.'),
  ('PROGRAM_NEST_LEVEL', 'indication of the nesting level within a control program that is associated with the code or instructions that is currently being executed.'),
  ('RESISTANCE', 'degree to which a substance opposes the passage of an electric current.'),
  ('RESISTIVITY', 'inability of a material to conduct electricity.'),
  ('ROTARY_MODE', 'current operating mode for a Rotary type axis.'),
  ('ROTARY_VELOCITY', 'rotational speed of a rotary axis.'),
  ('ROTARY_VELOCITY_OVERRIDE', 'percentage change to the velocity of the programmed velocity for a Rotary axis.'),
  ('ROTATION', 'three space angular displacement of an object or coordinate system relative to a cartesian coordinate system.'),
  ('SENSOR_ATTACHMENT', 'attachment between a sensor and an entity.'),
  ('SENSOR_STATE', 'detection result of a sensor.'),
  ('SERIAL_NUMBER', 'serial number associated with a Component, Asset, or Device.'),
  ('SETTLING_ERROR', 'difference between actual and commanded position at the end of a motion.'),
  ('SETTLING_ERROR_ANGULAR', 'angular difference between the commanded encoder/resolver position, and the actual encoder/resolver position when motion is complete.'),
  ('SETTLING_ERROR_LINEAR', 'difference between the commanded encoder/resolver position, and the actual encoder/resolver position when motion is complete.'),
  ('SOUND_LEVEL', 'sound level or sound pressure level relative to atmospheric pressure.'),
  ('SPECIFICATION_LIMIT', 'set of limits defining a range of values designating acceptable performance for a variable. DEPRECATED in Version 2.5. Replaced by SPECIFICATION_LIMITS.'),
  ('SPECIFICATION_LIMITS', 'set of limits defining a range of values designating acceptable performance for a variable.'),
  ('SPINDLE_INTERLOCK', 'indication of the status of the spindle for a piece of equipment when power has been removed and it is free to rotate.'),
  ('SPINDLE_SPEED', 'rotational speed of the rotary axis. DEPRECATED in Version 1.2. Replaced by ROTARY_VELOCITY.'),
  ('STRAIN', 'amount of deformation per unit length of an object when a load is applied.'),
  ('SWING_ANGLE', 'angular range over which the object is designed to move about a fixed axis or pivot'),
  ('SWING_DIAMETER', 'maximal linear width (diameter) of the area described by the object’s movement about an axis'),
  ('SWING_RADIUS', 'maximal linear distance from the pivot or axis to the furthest point reached by the object’s swing'),
  ('SYSTEM', 'general purpose indication associated with an electronic component of a piece of equipment or a controller that represents a fault that is not associated with the operator, program, or hardware.'),
  ('TASK_ASSET_ID', 'assetId of the Task that the Component binds to'),
  ('TEMPERATURE', 'degree of hotness or coldness measured on a definite scale.'),
  ('TENSION', 'force that stretches or elongates an object.'),
  ('THICKNESS', 'dimension between two surfaces of an object, usually the dimension of smallest measure, for example an additive layer, or a depth of cut.'),
  ('TILT', 'angular displacement.'),
  ('TOOL_ASSET_ID', 'identifier of an individual tool asset.'),
  ('TOOL_CUTTING_ITEM', 'references the CuttingToolLifeCycle CuttingItem index related to the indices of the currently active cutting tool edge.'),
  ('TOOL_GROUP', 'identifier for the tool group associated with a specific tool. Commonly used to designate spare tools.'),
  ('TOOL_ID', 'identifier of the tool currently in use for a given Path. DEPRECATED in Version 1.2.0. See TOOL_NUMBER.'),
  ('TOOL_NUMBER', 'identifier assigned by the Controller component to a cutting tool when in use by a piece of equipment.'),
  ('TOOL_OFFSET', 'reference to the tool offset variables applied to the active cutting tool.'),
  ('TOOL_OFFSETS', 'properties of each addressable tool offset.'),
  ('TORQUE', 'turning force exerted on an object or by an object.'),
  ('TRANSFER_COUNT', 'accumulation of the number of times an operation has attempted to, or is planned to attempt to, transfer materials, parts, or other items from one location to another.'),
  ('TRANSLATION', 'three space linear displacement of an object or coordinate system relative to a cartesian coordinate system.'),
  ('UNCERTAINTY', 'uncertainty specified by UncertaintyType.'),
  ('UNCERTAINTY_TYPE', 'method used to compute standard uncertainty.'),
  ('UNLOAD_COUNT', 'accumulation of the number of times an operation has attempted to, or is planned to attempt to, unload materials, parts, or other items.'),
  ('USER', 'identifier of the person currently responsible for operating the piece of equipment.'),
  ('VALVE_STATE', 'state of a valve is one of open, closed, or transitioning between the states.'),
  ('VARIABLE', 'data whose meaning may change over time due to changes in the operation of a piece of equipment or the process being executed on that piece of equipment.'),
  ('VELOCITY', 'rate of change of position of a Component.'),
  ('VISCOSITY', 'fluid''s resistance to flow.'),
  ('VOLT_AMPERE', 'apparent power in an electrical circuit, equal to the product of root-mean-square (RMS) voltage and RMS current (commonly referred to as VA).'),
  ('VOLT_AMPERE_REACTIVE', 'reactive power in an AC electrical circuit (commonly referred to as VAR).'),
  ('VOLTAGE', 'electrical potential between two points. DEPRECATED in Version 1.6. Replaced by VOLTAGE_AC and VOLTAGE_DC.'),
  ('VOLTAGE_AC', 'electrical potential between two points in an electrical circuit in which the current periodically reverses direction.'),
  ('VOLTAGE_DC', 'electrical potential between two points in an electrical circuit in which the current is unidirectional.'),
  ('VOLUME_FLUID', 'fluid volume of an object or container.'),
  ('VOLUME_SPATIAL', 'geometric volume of an object or container.'),
  ('WAIT_STATE', 'indication of the reason that Execution is reporting a value of WAIT.'),
  ('WATER_HARDNESS', 'concentration of calcium carbonate (CaCO3) in water'),
  ('WATTAGE', 'power flowing through or dissipated by an electrical circuit or piece of equipment.'),
  ('WIRE', 'identifier for the type of wire used as the cutting mechanism in Electrical Discharge Machining or similar processes.'),
  ('WORK_OFFSET', 'reference to offset variables for a work piece or part.'),
  ('WORK_OFFSETS', 'properties of each addressable work offset.'),
  ('WORKHOLDING_ID', 'identifier for the current workholding or part clamp in use by a piece of equipment. DEPRECATION WARNING: Recommend using FIXTURE_ID instead.'),
  ('X_DIMENSION', 'dimension of an entity relative to the X direction of the referenced coordinate system.'),
  ('Y_DIMENSION', 'dimension of an entity relative to the Y direction of the referenced coordinate system.'),
  ('Z_DIMENSION', 'dimension of an entity relative to the Z direction of the referenced coordinate system.')
  ) AS d (name, description)
 WHERE v.kind = 'DATA_ITEM_TYPE'
   AND v.name = d.name
   AND v.description IS DISTINCT FROM d.description;
-- <<< END GENERATED mtconnect_descriptions

-- -------------------------------------------------------------------------------------------------
-- 3. The view
-- -------------------------------------------------------------------------------------------------
-- 0169's view with the fifth arm. An id held by two vocabularies takes the first in this order:
-- IDTA (issued by IDTA, IEC CDD and ECLASS), ASHRAE 223P (the ontology's own IRIs), OPC UA (derived
-- from a published namespace), ISO 22400 and MTConnect (minted under aber.local). Within one
-- vocabulary, the first by its key. A row with no text defines nothing, so it is left out and the
-- exporter falls back as it would for an id no vocabulary holds.
CREATE OR REPLACE VIEW public.concept_definitions WITH (security_invoker='true') AS
 SELECT DISTINCT ON (c.semantic_id)
    c.semantic_id,
    c.name,
    c.definition,
    c.standard
   FROM ( SELECT 1 AS precedence, t.template_id || ' ' || t.id_short AS tiebreak,
            t.semantic_id, t.id_short AS name, t.description AS definition, 'IDTA'::text AS standard
           FROM public.idta_submodel_templates t
        UNION ALL
         SELECT 2, v.name, v.semantic_id, v.name, v.description, 'ASHRAE 223P'::text
           FROM public.ashrae223_vocabulary v
        UNION ALL
         SELECT 3, v.companion_spec || ' ' || v.name, v.semantic_id, v.name, v.description,
            'OPC UA'::text
           FROM public.opcua_vocabulary v
        UNION ALL
         SELECT 4, v.name, v.semantic_id, v.name, v.description, 'ISO 22400'::text
           FROM public.iso22400_vocabulary v
        UNION ALL
         SELECT 5, v.kind || ' ' || v.name, v.semantic_id, v.name, v.description, 'MTConnect'::text
           FROM public.mtconnect_vocabulary v) c
  WHERE (NULLIF(btrim(c.semantic_id), '') IS NOT NULL)
    AND (NULLIF(btrim(c.definition), '') IS NOT NULL)
  ORDER BY c.semantic_id, c.precedence, c.tiebreak;

ALTER VIEW public.concept_definitions OWNER TO postgres;

COMMENT ON VIEW public.concept_definitions IS 'One row per semantic id a vocabulary defines: the concept''s name and its vocabulary''s own definition text. IDTA, ASHRAE 223P, OPC UA, ISO 22400 and MTConnect. An id held by two vocabularies takes the first in that order. The AAS exporter reads it for ConceptDescription definitions.';

-- Reference data, read as the vocabularies are: security_invoker applies their SELECT policies to
-- the caller, so aas-api's caller-bound client reads it as itself.
REVOKE ALL ON TABLE public.concept_definitions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.concept_definitions TO authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'mtconnect_vocabulary'
                    AND column_name = 'description') THEN
    RAISE EXCEPTION '0301: mtconnect_vocabulary has no description column';
  END IF;
  -- POSITION is the concept whose definition catalog text used to get wrong: each metric
  -- carrying it describes its own axis.
  IF NOT EXISTS (SELECT 1 FROM public.mtconnect_vocabulary
                  WHERE kind = 'DATA_ITEM_TYPE' AND name = 'POSITION'
                    AND NULLIF(btrim(description), '') IS NOT NULL) THEN
    RAISE EXCEPTION '0301: the POSITION data item type has no description';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.concept_definitions c
                   JOIN public.mtconnect_vocabulary v ON v.semantic_id = c.semantic_id
                  WHERE v.kind = 'DATA_ITEM_TYPE' AND v.name = 'POSITION'
                    AND c.standard = 'MTConnect' AND c.definition = v.description) THEN
    RAISE EXCEPTION '0301: concept_definitions does not define POSITION by its MTConnect text';
  END IF;
  IF has_table_privilege('anon', 'public.concept_definitions', 'SELECT') THEN
    RAISE EXCEPTION '0301: anon may read concept_definitions';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.concept_definitions', 'SELECT') THEN
    RAISE EXCEPTION '0301: authenticated may not read concept_definitions; aas-api reads it as the caller';
  END IF;
  IF EXISTS (SELECT 1 FROM public.concept_definitions GROUP BY semantic_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION '0301: concept_definitions holds a semantic id twice';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
