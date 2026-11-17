#!/usr/bin/env node
/**
 * Generate the OPC UA companion-specification vocabulary rows from the published NodeSet2 XML.
 *
 *   node scripts/generate-opcua-vocabulary.mjs
 *
 * Source: https://github.com/OPCFoundation/UA-Nodeset -- every NodeSet in that repository carries
 * the **OPC Foundation MIT License 1.00** in its own header ("permission to use, copy, modify,
 * merge, publish, distribute"), which permits redistributing these values in a derived work. That
 * is the same footing scripts/generate-mtconnect-vocabulary.mjs relies on for Apache-2.0. As there,
 * adopting the vocabulary is NOT a conformance claim: OPC UA compliance is a certification process
 * about a server's behaviour, not about knowing the browse names.
 *
 * WHAT THIS GENERATES, AND WHAT IT DOES NOT.
 *
 * It does not dump the NodeSets. That was the obvious design and it is wrong here, for a reason
 * worth writing down because it is not obvious until you count: **the NodeSets carry almost no
 * descriptions.** MachineTool declares 356 UAVariable nodes and 18 of them have a Description
 * element; Machinery/Energy has 87 and zero. A bulk extraction would therefore produce hundreds of
 * rows with a NULL description, and `VocabularyPanel` matches a search against the tooltip as well
 * as the name -- so the bulk import would make the vocabulary *less* findable than a curated
 * list. The raw node lists are also dominated by modelling scaffolding
 * (`IsNamespaceSubset`, `StaticNodeIdTypes`, `EngineeringUnits`) rather than by anything a device
 * publishes.
 *
 * So ENTRIES below is a curated list -- the selection and the prose are human -- and this script's
 * job is to **verify it against the NodeSet and fill in what the NodeSet is authoritative for**:
 *
 *   * the ObjectType named by `type` must exist in the target namespace;
 *   * the variable at `browsePath` below it (default: `[name]`) must exist, each step a component
 *     or property the NodeSet declares;
 *   * `datatype` is read from that variable, never typed here;
 *   * `node_id` and `semantic_id` are that variable's NodeId, written as the ExpandedNodeId
 *     `nsu=<namespace URI>;i=<id>` through the NodeSet's NamespaceUris table: the identifier OPC UA
 *     itself publishes, in the specification's own namespace;
 *   * the model's namespace URI, version and publication date must match the pins below.
 *
 * A rename, a retype, a renumbering or a version bump upstream therefore fails the build or shows in
 * the seed's diff, instead of silently shipping a vocabulary that describes a specification nobody
 * publishes any more. Every opcua_vocabulary row comes from here; none is hand-written. The script
 * also writes each entry's metric group to frontend/src/utils/opcuaGroups.generated.js, which the
 * Add Metric form suggests.
 *
 * WHERE THE ROWS ARE SEEDED: IN BLOCKS, ONE PER MIGRATION THAT GROWS THE VOCABULARY.
 *
 * 0002_seed_data.sql is released and is never rewritten, so an expansion seeds its rows in a block
 * of its own migration, and each entry says which block seeds it. `since: '0300'` on an entry means
 * migration 0300's block; an entry with no `since` belongs to 0002's. The since() helper stamps a
 * list. scripts/lib/opcua-seed-blocks.mjs lists the blocks (BLOCKS), states the rules and builds
 * what each holds; its header is the design. In short:
 *
 *   * each block is written from its own entries and no others;
 *   * a block is WRITTEN only while its migration is unreleased (its note is in unreleased/migrations/),
 *     and otherwise only VERIFIED: a released block that would now read differently stops the run, so a
 *     moved NodeSet or an edited entry can never rewrite a migration that has shipped. The correction
 *     goes in the next block, whose rows replace the installed ones (`ON CONFLICT ... DO UPDATE`);
 *   * a group reworded after it was registered says so in its definition (`{ description, was, since }`),
 *     and the block named by `since` carries an UPDATE guarded on the old text.
 *
 * To add the next expansion: add its block to BLOCKS, put `since('<number>', [...])` entries in SPECS,
 * create the migration with the three marked regions (0300 is the model) and its note in
 * unreleased/migrations/, and run this script.
 *
 * A DataType or a reference type the target NodeSet takes from another specification is resolved in
 * that specification's own NodeSet, which DEPENDENCIES pins like a target: a Machine Tools
 * stacklight's mode is an enumeration of IA, and Machinery Energy's statistics hang from IA's
 * HasStatisticComponent, a subtype of HasComponent.
 *
 * An entry that carries `values` names the members of the enumeration its variable is typed as. The
 * script checks them against the NodeSet's definition of that enumeration and requires the description
 * to name each one: a device publishes an enumeration as the member's name, a String, and the names
 * are what a person enters as the metric's permitted values.
 *
 *   node scripts/generate-opcua-vocabulary.mjs --print-map   also prints each row's former id
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BLOCKS, applyPlan, isUnreleased, planBlocks, sqlString } from './lib/opcua-seed-blocks.mjs';

/**
 * Pinned to a branch rather than a commit, matching the MTConnect generator's use of `master`.
 * The version/publicationDate assertions below are what actually protect against upstream moving:
 * a branch that advances is caught by the pin check, not silently absorbed.
 */
const REF = 'latest';
const BASE = `https://raw.githubusercontent.com/OPCFoundation/UA-Nodeset/${REF}`;

/**
 * NodeSets that a target NodeSet's DataTypes and reference types are defined in, pinned as a target
 * is. No row comes from them. IA is "OPC Foundation MIT License 1.00", as every NodeSet here is.
 */
const DEPENDENCIES = [
  {
    namespaceUri: 'http://opcfoundation.org/UA/IA/',
    path: 'IA/Opc.Ua.IA.NodeSet2.xml',
    version: '1.01.4',
    publicationDate: '2025-05-23T00:00:00Z'
  }
];

/** The entries of a block the generator writes after 0002's: they name the migration that seeds them. */
const since = (block, entries) => entries.map((entry) => ({ ...entry, since: block }));

/**
 * ProcessValue is one group for two specifications. OPC 40540 registered it in 0002 with the first
 * description; OPC 40001-2's rows joined it in 0300, and the text now covers both. Both specs list it
 * with this one definition, and the generator refuses two that differ. The first description is
 * `was`: it is what 0002's block registers, and what 0300's UPDATE replaces on an installed database.
 */
const PROCESS_VALUE_GROUP = {
  description: 'OPC UA process values -- OPC 40001-2 Machinery Process Values (the reading, setpoint, limits and status) and OPC 40540 Additive Manufacturing\'s classification of them',
  was: 'OPC UA Additive Manufacturing (OPC 40540) in-process sensor readings',
  since: '0300'
};

/**
 * Written to the seed as-is, except what the NodeSet supplies: `datatype` and the identifiers. A
 * group whose description is null is registered by the hand-written metric_groups rows above the
 * generated block, whose ids are fixed; the script checks that row exists.
 *
 * Descriptions: where an entry's text is the NodeSet's own, lightly edited, it follows the NodeSet's
 * Description element; where the NodeSet has none, the specification's reference page (the NodeSet's
 * Documentation link) or the entry's own enumeration is what it is written from. A description that
 * is wholly ours says so in a comment on the entry.
 */
const SPECS = [
  {
    companionSpec: 'OPC 40001 Machinery',
    namespaceUri: 'http://opcfoundation.org/UA/Machinery/',
    path: 'Machinery/Opc.Ua.Machinery.NodeSet2.xml',
    version: '1.04.2',
    publicationDate: '2026-11-02T00:00:00Z',
    groups: { Machine: null },
    // Not here: OperationalTime, which no Machinery NodeSet declares. A machine's identification
    // object is a MachineIdentificationType, which inherits all but ProductInstanceUri from
    // MachineryItemIdentificationType and redeclares that one as mandatory.
    entries: [
      { group: 'Machine', type: 'MachineryItemIdentificationType', name: 'Manufacturer',
        description: 'Name of the machine manufacturer.' },
      { group: 'Machine', type: 'MachineryItemIdentificationType', name: 'Model',
        description: 'Manufacturer-assigned model name of the machine.' },
      { group: 'Machine', type: 'MachineryItemIdentificationType', name: 'SerialNumber',
        description: 'Serial number uniquely identifying this machine instance for its manufacturer.' },
      { group: 'Machine', type: 'MachineIdentificationType', name: 'ProductInstanceUri',
        description: 'Globally unique URI for this machine instance. The closest OPC UA equivalent to an AAS globalAssetId, and the natural anchor when cross-referencing a shell.' },
      { group: 'Machine', type: 'MachineryItemIdentificationType', name: 'SoftwareRevision',
        description: 'Software or firmware revision of the machine.' },
      { group: 'Machine', type: 'MachineryItemIdentificationType', name: 'YearOfConstruction',
        description: 'Year the machine was built.' },
      { group: 'Machine', type: 'MonitoringType', name: 'MachineryItemState',
        browsePath: ['Status', 'MachineryItemState', 'CurrentState'],
        description: 'Lifecycle state of the machine: Executing, NotExecuting, NotAvailable or OutOfService. The OPC UA analogue of the execution state a controller reports -- a discrete state, so a String metric rather than a numeric one.' },
      { group: 'Machine', type: 'MonitoringType', name: 'MachineryOperationMode',
        browsePath: ['Status', 'MachineryOperationMode', 'CurrentState'],
        description: 'Operating mode of the machine: Processing, Setup, Maintenance or None.' },
      { group: 'Machine', type: 'MachineryOperationCounterType', name: 'PowerOnDuration', unit: 'MILLISECOND',
        description: 'Accumulated time the machine has been powered on. The specification types it as Duration, which OPC UA counts in milliseconds.' },

      // Each description below follows the NodeSet's own, edited.
      ...since('0300', [
        { group: 'Machine', type: 'MachineryOperationCounterType', name: 'OperationCycleCounter', unit: 'COUNT',
          description: 'How many times the component switches from not performing an activity to performing one: each time a valve starts moving is one. It only increases over the component\'s life and is not reset when it restarts, so it is a counter to difference rather than a value to read.' },
        { group: 'Machine', type: 'MachineryOperationCounterType', name: 'OperationDuration', unit: 'MILLISECOND',
          description: 'Time the machine has been powered and performing an activity, in milliseconds (the specification types it as Duration). Unlike PowerOnDuration it leaves out time spent switched on and idle: a drive can be powered without operating. It only increases and is not reset on a restart. A server may update it as seldom as once an hour.' },
        { group: 'Machine', type: 'MachineryItemIdentificationType', name: 'HardwareRevision',
          description: 'Revision level of the machine\'s hardware, as text. Many machines do not provide one, because they are modular and configurable.' },
        { group: 'Machine', type: 'MachineryItemIdentificationType', name: 'ProductCode',
          description: 'Machine-readable code for the machine\'s model, which may include options such as the hardware configuration. It may come from the vendor\'s ERP system, so it can serve as order information.' },
        { group: 'Machine', type: 'MachineryItemIdentificationType', name: 'DeviceClass',
          description: 'The domain, or the purpose, the machine is used for.' },
        { group: 'Machine', type: 'MachineryItemIdentificationType', name: 'ManufacturerUri',
          description: 'Globally unique identifier of the machine\'s manufacturer. Manufacturer is the name a person reads.' },
        { group: 'Machine', type: 'MachineryItemIdentificationType', name: 'AssetId',
          description: 'Identification the end user stores to make the machine unique in their own application. The site assigns it, where SerialNumber is the manufacturer\'s. A server must accept at least 40 characters.' },
        { group: 'Machine', type: 'MachineryItemIdentificationType', name: 'InitialOperationDate',
          description: 'Date the machine was first switched on after it left the manufacturer\'s plant.' },
        { group: 'Machine', type: 'MachineryItemIdentificationType', name: 'MonthOfConstruction',
          description: 'Month in which the machine\'s manufacture was completed: a number from 1 (January) to 12 (December). With YearOfConstruction it dates the build.' },
        { group: 'Machine', type: 'MachineIdentificationType', name: 'Location',
          description: 'Where the end user keeps the machine, in whatever scheme the end user uses. Free text, separate from the area this platform places the machine in. A server must accept at least 60 characters.' }
      ])
    ]
  },
  {
    companionSpec: 'OPC 40010 Robotics',
    namespaceUri: 'http://opcfoundation.org/UA/Robotics/',
    path: 'Robotics/Opc.Ua.Robotics.NodeSet2.xml',
    version: '1.02',
    publicationDate: '2025-09-08T00:00:00Z',
    groups: { MotionDevice: null },
    entries: [
      { group: 'MotionDevice', type: 'AxisType', name: 'ActualPosition', browsePath: ['ParameterSet', 'ActualPosition'], unit: 'MILLIMETER',
        description: 'Current position of an axis. Units follow the axis type -- MILLIMETER for a linear axis, DEGREE for a rotary one -- so the unit is a choice at metric-creation time, not a property of the browse name.' },
      { group: 'MotionDevice', type: 'AxisType', name: 'ActualSpeed', browsePath: ['ParameterSet', 'ActualSpeed'], unit: 'MILLIMETER/SECOND',
        description: 'Current speed of an axis. On a rotary axis this is the angular velocity; pick DEGREE/SECOND rather than MILLIMETER/SECOND for those.' },
      { group: 'MotionDevice', type: 'AxisType', name: 'ActualAcceleration', browsePath: ['ParameterSet', 'ActualAcceleration'],
        description: 'Current acceleration of an axis.' },
      { group: 'MotionDevice', type: 'AxisType', name: 'MotionProfile',
        description: 'Kind of motion the axis performs -- rotary, linear or spindle.' },
      { group: 'MotionDevice', type: 'MotionDeviceType', name: 'SpeedOverride', browsePath: ['ParameterSet', 'SpeedOverride'], unit: 'PERCENT',
        description: 'Operator speed override applied to programmed motion, as a percentage. The robotics counterpart of a machine tool feed-rate override.' },
      { group: 'MotionDevice', type: 'MotionDeviceType', name: 'InControl', browsePath: ['ParameterSet', 'InControl'],
        description: 'Whether the motion device is under control of its controller.' },
      { group: 'MotionDevice', type: 'MotionDeviceType', name: 'OnPath', browsePath: ['ParameterSet', 'OnPath'],
        description: 'Whether the motion device is on its programmed path.' },
      { group: 'MotionDevice', type: 'MotionDeviceType', name: 'MotionDeviceCategory',
        description: 'Kind of motion device -- articulated robot, cartesian robot, AGV and so on.' },
      { group: 'MotionDevice', type: 'LoadType', name: 'Mass', unit: 'KILOGRAM',
        description: 'Mass of a load carried by the motion device -- the payload weight, including the tool where the tool is modelled as part of the load.' },
      { group: 'MotionDevice', type: 'SafetyStateType', name: 'EmergencyStop', browsePath: ['ParameterSet', 'EmergencyStop'],
        description: 'Emergency stop state of the motion device. Note the sense: this asserts the stop is active, the inverse of a "safety OK" boolean.' },
      { group: 'MotionDevice', type: 'SafetyStateType', name: 'ProtectiveStop', browsePath: ['ParameterSet', 'ProtectiveStop'],
        description: 'Protective stop state -- a guard, light curtain or safety-rated sensor has halted motion.' },
      { group: 'MotionDevice', type: 'SafetyStateType', name: 'OperationalMode', browsePath: ['ParameterSet', 'OperationalMode'],
        description: 'Safety-relevant operating mode of the motion device -- automatic, manual reduced speed, manual high speed.' },
      { group: 'MotionDevice', type: 'TaskControlType', name: 'TaskProgramName', browsePath: ['ParameterSet', 'TaskProgramName'],
        description: 'Name of the task program currently loaded on the controller.' },
      { group: 'MotionDevice', type: 'TaskControlType', name: 'ExecutionMode', browsePath: ['ParameterSet', 'ExecutionMode'],
        description: 'Execution mode of the loaded task program -- continuous, step or cycle.' },
      { group: 'MotionDevice', type: 'ControllerType', name: 'TotalPowerOnTime', browsePath: ['ParameterSet', 'TotalPowerOnTime'],
        description: 'Accumulated controller power-on time. The specification types it as DurationString, an ISO 8601 duration such as P12DT3H, so it is text rather than a number of seconds.' },

      // Each description below follows the NodeSet's own, edited. The specification fixes no unit
      // for a fan speed or an energy total: the device's EngineeringUnits property carries it.
      ...since('0300', [
        { group: 'MotionDevice', type: 'ControllerType', name: 'Temperature', browsePath: ['ParameterSet', 'Temperature'], unit: 'CELSIUS',
          description: 'Temperature given by a sensor inside the controller. A motor has its own, MotorTemperature.' },
        { group: 'MotionDevice', type: 'ControllerType', name: 'CabinetFanSpeed', browsePath: ['ParameterSet', 'CabinetFanSpeed'],
          description: 'Speed of the controller cabinet\'s fan. The specification fixes no unit, so choose one when the metric is created.' },
        { group: 'MotionDevice', type: 'ControllerType', name: 'CPUFanSpeed', browsePath: ['ParameterSet', 'CPUFanSpeed'],
          description: 'Speed of the controller\'s CPU fan. The specification fixes no unit, so choose one when the metric is created.' },
        { group: 'MotionDevice', type: 'ControllerType', name: 'InputVoltage', browsePath: ['ParameterSet', 'InputVoltage'], unit: 'VOLT',
          description: 'Input voltage of the controller, which can be a configured value rather than a measured one. Whether the supply is AC or DC is not in the value: the specification names the optional Definition property of the data item for that.' },
        { group: 'MotionDevice', type: 'ControllerType', name: 'TotalEnergyConsumption', browsePath: ['ParameterSet', 'TotalEnergyConsumption'],
          description: 'Total energy consumed by the motion devices that belong to this controller, accumulated. Monotonic, so it is a counter to difference rather than a value to read. The specification fixes no unit, so choose one when the metric is created, such as KILOWATT_HOUR or JOULE.' },
        { group: 'MotionDevice', type: 'ControllerType', name: 'StartUpTime', browsePath: ['ParameterSet', 'StartUpTime'],
          description: 'Date and time of the controller\'s last start-up. A moment, not a length of time: TotalPowerOnTime is how long the controller has been on.' },
        { group: 'MotionDevice', type: 'ControllerType', name: 'UpsState', browsePath: ['ParameterSet', 'UpsState'],
          description: 'Status of an integrated UPS or accumulator system in the controller. The status is the vendor\'s own, so its values come from the controller\'s manual.' },
        { group: 'MotionDevice', type: 'MotorType', name: 'MotorTemperature', browsePath: ['ParameterSet', 'MotorTemperature'], unit: 'CELSIUS',
          description: 'Temperature of the motor. A motor with no temperature sensor reports null. The controller has its own, Temperature.' },
        { group: 'MotionDevice', type: 'MotorType', name: 'EffectiveLoadRate', browsePath: ['ParameterSet', 'EffectiveLoadRate'], unit: 'PERCENT',
          description: 'Load on the motor as a percentage of its maximum continuous load. The specification suggests the Joule integral as the way to calculate it, over a duration the vendor defines and documents, so two vendors\' figures are not strictly comparable.' },
        { group: 'MotionDevice', type: 'MotorType', name: 'BrakeReleased', browsePath: ['ParameterSet', 'BrakeReleased'],
          description: 'Whether the motor\'s brake is released. Only a motor with a brake publishes it. TRUE means the motor is free to run and FALSE means the brake locks the shaft. Note the sense: this asserts the brake is off.' },
        { group: 'MotionDevice', type: 'TaskControlType', name: 'TaskProgramLoaded', browsePath: ['ParameterSet', 'TaskProgramLoaded'],
          description: 'Whether a task program is loaded in the task control. TaskProgramName says which.' }
      ])
    ]
  },
  {
    companionSpec: 'OPC 40501 Machine Tools',
    namespaceUri: 'http://opcfoundation.org/UA/MachineTool/',
    // NOTE THE CAPITALISATION. Upstream spells this file `NodeSet2` and the Additive one
    // `Nodeset2`; guessing either way round produces a 404 that reads as a network problem.
    path: 'MachineTool/Opc.Ua.MachineTool.NodeSet2.xml',
    version: '1.02.0',
    publicationDate: '2024-11-01T00:00:00Z',
    groups: {
      Channel: 'OPC UA Machine Tools (OPC 40501) channel monitoring -- overrides, channel state and the program modifiers',
      Spindle: 'OPC UA Machine Tools (OPC 40501) spindle monitoring',
      MachineOperation: 'OPC UA Machine Tools (OPC 40501) machine-level operation mode and power-on time',
      Production: 'OPC UA Machine Tools (OPC 40501) production counters, part quality and process irregularities',
      Tool: 'OPC UA Machine Tools (OPC 40501) tool management state',
      Laser: 'OPC UA Machine Tools (OPC 40501) laser monitoring -- the laser device\'s state and its controller',
      EDMGenerator: 'OPC UA Machine Tools (OPC 40501) EDM spark generator monitoring -- its state and whether it is on',
      Stacklight: 'OPC UA Machine Tools (OPC 40501) stacklight -- how the signal tower is used'
    },
    entries: [
      { group: 'Channel', type: 'ChannelMonitoringType', name: 'FeedOverride', unit: 'PERCENT',
        description: 'Operator feed-rate override applied to the programmed feed on this channel, as a percentage. The machine-tool counterpart of Robotics SpeedOverride; a channel is one independent NC program stream, so a machine with two channels reports two of these.' },
      { group: 'Channel', type: 'ChannelMonitoringType', name: 'RapidOverride', unit: 'PERCENT',
        description: 'Operator override applied to rapid traverse moves on this channel, as a percentage. Separate from FeedOverride because controls override the two independently.' },
      { group: 'Channel', type: 'ChannelMonitoringType', name: 'ChannelState',
        description: 'Execution state of the channel. The MachineTool enumeration, whose values are Interrupted, Reset, Running and Waiting -- the closest OPC UA analogue of MTConnect Controller/EXECUTION.' },
      { group: 'Channel', type: 'ChannelMonitoringType', name: 'ChannelMode',
        description: 'Operating mode of the channel: Auto, MDI or Manual. What the operator selected, as opposed to what the channel is currently doing.' },
      { group: 'Channel', type: 'ChannelModifierType', name: 'DryRun',
        description: 'Whether dry-run is active on this channel -- the program is executed without cutting. Production counted while this is true is not saleable output, which is exactly the distinction an OEE calculation must not lose.' },
      { group: 'Channel', type: 'ChannelModifierType', name: 'SingleStep',
        description: 'Whether the channel is executing one program block per start command rather than running continuously.' },
      { group: 'Channel', type: 'ChannelModifierType', name: 'OptionalStop',
        description: 'Whether programmed optional stops (M01) are honoured on this channel.' },
      { group: 'Channel', type: 'ChannelModifierType', name: 'BlockSkip',
        description: 'Whether program blocks marked as skippable are being skipped on this channel.' },
      { group: 'Channel', type: 'ChannelModifierType', name: 'TestMode',
        description: 'Whether the channel is in test mode. Like DryRun, this marks output that should not be counted as production.' },

      { group: 'Spindle', type: 'SpindleMonitoringType', name: 'IsRotating',
        description: 'Whether the spindle is turning. A cheap cutting-versus-idle discriminator where no power or load metric is published.' },
      { group: 'Spindle', type: 'SpindleMonitoringType', name: 'Override', unit: 'PERCENT',
        description: 'Operator override applied to the programmed spindle speed, as a percentage. The browse name is bare `Override` in the specification; it is spindle-scoped by the type that declares it, not by its name.' },

      { group: 'MachineOperation', type: 'MachineOperationMonitoringType', name: 'OperationMode',
        description: 'Machine-level operating mode: Auto, Manual, MDI or Setup. Distinct from ChannelMode, which is per NC channel -- a machine has one of these and may have several of those.' },
      { group: 'MachineOperation', type: 'MachineOperationMonitoringType', name: 'PowerOnDuration', unit: 'SECOND',
        description: 'Accumulated time this machine has been powered on. OPC 40001 Machinery defines a metric of the same name as a Double; this is the MachineTool declaration and is a UInt32 count of seconds.' },
      { group: 'MachineOperation', type: 'MachineOperationMonitoringType', name: 'IsWarmUp',
        description: 'Whether the machine is running a warm-up cycle. Warm-up is neither downtime nor production, and conflating it with either distorts availability.' },

      { group: 'Production', type: 'ProductionJobType', name: 'PartsCompleted', unit: 'COUNT',
        description: 'Parts completed by the active job, good and bad together. Pair with PartsGood to get scrap; on its own it is throughput, not yield.' },
      { group: 'Production', type: 'ProductionJobType', name: 'PartsGood', unit: 'COUNT',
        description: 'Parts completed by the active job that met quality requirements. This is the good-count an ISO 22400 quality ratio needs, published by the machine rather than inferred.' },
      { group: 'Production', type: 'ProductionJobType', name: 'RunsCompleted', unit: 'COUNT',
        description: 'Runs of the active job completed so far. A run may produce several parts -- see ProductionPartSetType.' },
      { group: 'Production', type: 'ProductionJobType', name: 'RunsPlanned', unit: 'COUNT',
        description: 'Runs the active job is planned to perform. Note this is a property of the job the machine was given, not a schedule this platform stores.' },
      { group: 'Production', type: 'ProductionStatisticsType', name: 'PartsProducedInLifetime', unit: 'COUNT',
        description: 'Parts produced by this machine over its lifetime. Monotonic across jobs and power cycles, so it is a counter to difference rather than a value to read.' },
      { group: 'Production', type: 'ProductionPartType', name: 'PartQuality',
        description: 'Quality disposition of a produced part: Bad, Good, Scrap or Unclassified. The disposition an MES would otherwise have to supply, published here by the machine itself.' },
      { group: 'Production', type: 'ProductionPartType', name: 'ProcessIrregularity',
        description: 'Whether an irregularity occurred while producing the part: Irregularity, NoIrregularity or Unknown. A machine-asserted reason to distrust the part, distinct from PartQuality, which is the verdict.' },

      { group: 'Tool', type: 'ToolType', name: 'Locked',
        description: 'Whether the tool is locked out of use. A locked tool in a magazine is capacity the machine cannot use, which is a common and otherwise invisible cause of a stoppage.' },
      { group: 'Tool', type: 'ToolType', name: 'PlannedForOperating',
        description: 'Whether the tool is planned for use by the current setup.' },

      // The NodeSet describes only StacklightMode. The others are written from the specification's
      // reference page for each type (the Documentation link in the NodeSet) and from the
      // enumeration's own definitions.
      ...since('0300', [
        { group: 'Spindle', type: 'SpindleMonitoringType', name: 'IsUsedAsAxis',
          description: 'Whether the monitored element is used as an axis (TRUE) or as a spindle (FALSE). When it is TRUE the specification says a client shall not use IsRotating or Override on the same element.' },
        { group: 'Laser', type: 'LaserMonitoringType', name: 'LaserState',
          description: 'State of the laser device: Undefined (it cannot be indicated), Ready (no error, and emission is prohibited), Active (safety clearances have to be set and emission can be activated, or a program is running on the laser device) or Error. The MachineTool enumeration LaserState, carried as the member name.' },
        { group: 'Laser', type: 'LaserMonitoringType', name: 'ControllerIsOn',
          description: 'Whether the laser device\'s controller is running. It says nothing about whether laser light is being emitted: LaserState is the state of the laser.' },
        { group: 'EDMGenerator', type: 'EDMGeneratorMonitoringType', name: 'EDMGeneratorState',
          description: 'State of the EDM spark generator: Undefined, Ready (initialised, and can receive a set of technology parameters), Active_Low_Voltage (supplying pulses within the ISO 28881 low-voltage limits, 25 V AC or 60 V DC), Active_High_Voltage (supplying pulses above them) or Error. The MachineTool enumeration EDMGeneratorState, carried as the member name.' },
        { group: 'EDMGenerator', type: 'EDMGeneratorMonitoringType', name: 'IsOn',
          description: 'Whether the EDM spark generator has a valid set of technology parameters, meets every safety condition required and is switched on.' },
        { group: 'Production', type: 'ProductionPartSetType', name: 'PartsCompletedPerRun', unit: 'COUNT',
          description: 'Parts of this group completed in the current run of the job. It says nothing about their quality: PartQuality does.' },
        { group: 'Production', type: 'ProductionPartSetType', name: 'PartsPlannedPerRun', unit: 'COUNT',
          description: 'Parts of this group meant to be produced in one run of the job. Compare PartsCompletedPerRun.' },
        { group: 'Production', type: 'ProductionPartSetType', name: 'ContainsMixedParts',
          description: 'Whether the parts in this group may differ from each other (TRUE) or are all of one type (FALSE).' },
        { group: 'Tool', type: 'ToolType', name: 'LastUsage',
          description: 'When the tool was last the active tool on a tool carrier while the machine was in an automatic mode.' },
        { group: 'Stacklight', type: 'MonitoringType', name: 'StacklightMode', browsePath: ['Stacklight', 'StacklightMode'],
          description: 'How the stacklight (signal tower) is used: Segmented (a stack of individual lights), Levelmeter (a level meter), Running_Light (the whole stack acts as a running light) or Other. The IA enumeration StacklightOperationMode, carried as the member name.' }
      ])
    ]
  },
  {
    companionSpec: 'OPC 40540 Additive Manufacturing',
    namespaceUri: 'http://opcfoundation.org/UA/AdditiveManufacturing/',
    path: 'AdditiveManufacturing/Opc.Ua.AdditiveManufacturing.Nodeset2.xml',
    version: '1.0.0',
    publicationDate: '2025-02-01T00:00:00Z',
    groups: {
      Feedstock: 'OPC UA Additive Manufacturing (OPC 40540) feedstock -- the powder, filament or resin a printer consumes',
      Machine: null,
      ProcessValue: PROCESS_VALUE_GROUP
    },
    entries: [
      { group: 'Feedstock', type: 'FeedstockType', name: 'RemainingQuantity',
        description: 'Quantity of this feedstock remaining. The specification types it as the abstract Number, so the concrete Sparkplug type is a choice at metric-creation time; the unit follows the feedstock -- KILOGRAM for powder, MILLIMETER of filament, MILLILITER of resin.' },
      { group: 'Feedstock', type: 'FeedstockType', name: 'ReadyForProduction',
        description: 'Whether this feedstock is ready to be consumed. A printer with a full hopper that is not ready -- unconditioned powder, an unpurged nozzle -- is unavailable for a reason no quantity metric shows.' },
      { group: 'Feedstock', type: 'FeedstockType', name: 'Cycle', unit: 'COUNT',
        description: 'How many times this feedstock has been through the machine. Recycled powder degrades with each cycle, so this is a quality input rather than an inventory one.' },
      { group: 'Feedstock', type: 'FeedstockType', name: 'Manufacturer',
        description: 'Manufacturer of the feedstock. Part of the material traceability an additive part needs and a subtractive one usually does not.' },

      { group: 'ProcessValue', type: 'ProcessValueAMType', name: 'Category',
        description: 'Category of an in-process sensor reading, from the SensorCategory enumeration -- what kind of thing is being measured.' },
      { group: 'ProcessValue', type: 'ProcessValueAMType', name: 'Severity',
        description: 'Severity attached to an in-process sensor reading, from the SensorSeverity enumeration. The machine grading its own measurement, which is not the same as an alarm.' },

      // The NodeSet describes none of these. Each is written from the specification's reference page
      // for its type (the Documentation link in the NodeSet), and Function's from its enumeration.
      ...since('0300', [
        { group: 'Feedstock', type: 'FeedstockType', name: 'Function',
          values: ['Undefined', 'Main', 'Ancillary', 'Consumable'],
          description: 'What the feedstock is used for: Main (used for production and part of the finished part), Ancillary (used for production but removed before the part is finished), Consumable (consumed during production, such as process gas) or Undefined. A device publishes the member name as a String, so those four names are the permitted values to give the metric.' },
        { group: 'Feedstock', type: 'FeedstockType', name: 'Identifier',
          description: 'Identifier of the feedstock. The specification uses it to determine the type of feedstock and requires it to be unique. A particular load of it is told apart by ExternalIdentifier.' },
        { group: 'Feedstock', type: 'FeedstockType', name: 'ExternalIdentifier',
          description: 'Identifies the feedstock instance in use, such as its lot or batch ID, and is unique per Identifier. It is what traces a part back to the material it was made from.' },
        { group: 'Feedstock', type: 'FeedstockType', name: 'Name',
          description: 'Human-readable name of the feedstock in use, for example PLA_Black.' },
        { group: 'Machine', type: 'MachineIdentificationAMType', name: 'AMTechnologyIdentifier',
          description: 'The machine\'s main additive manufacturing technology category, as ISO/ASTM 52900 names them: BJT (binder jetting), DED (directed energy deposition), MEX (material extrusion), MJT (material jetting), PBF (powder bed fusion), SHL (sheet lamination) or VPP (vat photopolymerization). The specification says these values should be used but may be extended, so they are a guide and not a closed list.' }
      ])
    ]
  },
  {
    // PackML reaches this vocabulary as an OPC UA companion specification rather than as a
    // standard of its own, and that is a provenance decision, not a shortcut. ISA-TR88.00.02 is
    // paywalled and publishes no concept identifiers; OPC 30050 is the same state model under the
    // OPC Foundation MIT licence, with a published namespace. Seeding from 30050 and then labelling the
    // rows `PackML` would assert a source nobody read, so `standard` stays 'OPC UA' and the
    // companion spec says which document.
    //
    // NOTE WHAT IS NOT HERE: the current PackML state. It is `CurrentState` on the inherited
    // StateMachineType, not a member this NodeSet declares, so there is nothing to verify against
    // and no honest row to emit. Its VALUES -- the 17 TR88 states, which OPC 30050 does declare
    // with their canonical StateNumbers -- are a value domain, and belong in `permitted_values`
    // rather than in a table of data points.
    companionSpec: 'OPC 30050 PackML',
    namespaceUri: 'http://opcfoundation.org/UA/PackML/',
    path: 'PackML/Opc.Ua.PackML.NodeSet2.xml',
    version: '1.01',
    publicationDate: '2020-10-08T11:08:00Z',
    groups: {
      PackML: 'OPC UA for PackML (OPC 30050) unit status, mode and the state/mode time accumulators'
    },
    entries: [
      { group: 'PackML', type: 'PackMLStatusObjectType', name: 'CurMachSpeed',
        description: 'Current operating speed of the unit. The units belong to the machine -- parts, containers or metres per minute -- so the unit is a choice at metric-creation time rather than a property of the browse name.' },
      { group: 'PackML', type: 'PackMLStatusObjectType', name: 'MachSpeed',
        description: 'Speed the unit has been commanded to run at. Paired with CurMachSpeed it separates "running slowly" from "asked to run slowly", which an availability figure alone cannot.' },
      { group: 'PackML', type: 'PackMLAdminObjectType', name: 'MachDesignSpeed',
        description: 'Nameplate design speed of the unit. The denominator an ISO 22400 performance ratio needs, published by the machine rather than configured by hand.' },
      { group: 'PackML', type: 'PackMLStatusObjectType', name: 'EquipmentBlocked',
        description: 'Whether the unit is blocked by equipment downstream. A stoppage this unit did not cause -- the distinction between its own downtime and downtime belonging to the line.' },
      { group: 'PackML', type: 'PackMLStatusObjectType', name: 'EquipmentStarved',
        description: 'Whether the unit is starved by equipment upstream. The other half of EquipmentBlocked, and just as important for attributing a stoppage.' },
      { group: 'PackML', type: 'PackMLStatusObjectType', name: 'MaterialInterlocked',
        description: 'Whether the unit is held by a material interlock.' },
      { group: 'PackML', type: 'PackMLStatusObjectType', name: 'UnitModeCurrent',
        description: 'Current unit mode -- Production, Maintenance or Manual in the base model. Mode and state are orthogonal in PackML: a unit can be executing in Maintenance, and counting that as production is exactly the error the two fields exist to prevent.' },
      { group: 'PackML', type: 'PackMLStatusObjectType', name: 'StateRequested',
        description: 'State number the unit has been asked to move to. Requested, not reached -- StateChangeInProcess says whether the transition is still running.' },
      { group: 'PackML', type: 'PackMLStatusObjectType', name: 'StateChangeInProcess',
        description: 'Whether a state transition is currently in progress.' },
      { group: 'PackML', type: 'PackMLStatusObjectType', name: 'UnitModeChangeInProcess',
        description: 'Whether a unit mode change is currently in progress.' },
      { group: 'PackML', type: 'PackMLAdminObjectType', name: 'StateCurrentTime', unit: 'SECOND',
        description: 'Time spent in the current state. With StateCumulativeTime this is the state-time accumulation that lets an OEE figure be arithmetic over reported values rather than an inference -- the reason PackML is worth adopting at all here.' },
      { group: 'PackML', type: 'PackMLAdminObjectType', name: 'StateCumulativeTime', unit: 'SECOND',
        description: 'Accumulated time in each state since the last reset. Monotonic, so it is a counter to difference rather than a value to read.' },
      { group: 'PackML', type: 'PackMLAdminObjectType', name: 'ModeCurrentTime', unit: 'SECOND',
        description: 'Time spent in the current unit mode.' },
      { group: 'PackML', type: 'PackMLAdminObjectType', name: 'ModeCumulativeTime', unit: 'SECOND',
        description: 'Accumulated time in each unit mode since the last reset.' },
      { group: 'PackML', type: 'PackMLAdminObjectType', name: 'AccTimeSinceReset', unit: 'SECOND',
        description: 'Time since the accumulators were last reset. Without it the cumulative counters have no denominator and cannot be turned into a ratio.' },
      { group: 'PackML', type: 'PackMLBaseObjectType', name: 'PackMLVersion',
        description: 'Which PackML version the unit implements. Worth catalogue space because the state model changed between editions.' },

      // The NodeSet describes none of these. Each is written from the specification's reference page
      // for its type (the Documentation link in the NodeSet). The three count arrays
      // (ProdProcessedCount, ProdDefectiveCount, ProdConsumedCount) are not here: they are arrays of
      // the PackMLCountDataType structure, which Sparkplug B cannot carry.
      ...since('0300', [
        { group: 'PackML', type: 'PackMLStatusObjectType', name: 'UnitModeRequested',
          description: 'Whether a unit mode change has been requested; it reflects the status of the command of the same name. It is a Boolean, so it says a change was asked for and not which mode. UnitModeCurrent is the mode the unit is in.' },
        { group: 'PackML', type: 'PackMLAdminObjectType', name: 'StopReasonExtent',
          description: 'Maximum number of stop reason elements the unit holds. A size, not a reading.' },
        { group: 'PackML', type: 'PackMLBaseObjectType', name: 'TagID',
          description: 'An additional name for the PackML system, in which a third-party cross reference or any other string can be stored.' }
      ])
    ]
  },
  {
    companionSpec: 'OPC 40001-4 Machinery Energy',
    namespaceUri: 'http://opcfoundation.org/UA/Machinery/Energy/',
    path: 'Machinery/Energy/Opc.Ua.Machinery.Energy.NodeSet2.xml',
    version: '1.00',
    publicationDate: '2025-11-01T00:00:00Z',
    groups: {
      Energy: 'OPC UA Machinery Energy Management (OPC 40001-4) utility flow measurements -- compressed air, water, gas and the like'
    },
    entries: [
      { group: 'Energy', type: 'IBaseFlowType', name: 'Pressure', unit: 'PASCAL',
        description: 'Pressure of a measured utility flow. Declared on the base flow interface, so it applies to a mass flow and a volume flow alike.' },
      { group: 'Energy', type: 'IBaseFlowType', name: 'Temperature', unit: 'CELSIUS',
        description: 'Temperature of a measured utility flow.' },
      { group: 'Energy', type: 'IMassFlowType', name: 'Mass', unit: 'KILOGRAM',
        description: 'Accumulated mass of a utility that has flowed. OPC 40010 Robotics defines an unrelated `Mass` -- a payload weight -- which is why this vocabulary is keyed on (companion_spec, name).' },
      { group: 'Energy', type: 'IMassFlowType', name: 'MassFlowRate',
        description: 'Instantaneous mass flow rate of a utility. No unit is offered because the MTConnect unit vocabulary this platform draws on has no mass-per-time entry; pick one at metric-creation time and record it in the metric description.' },
      { group: 'Energy', type: 'IVolumeFlowType', name: 'Volume', unit: 'LITER',
        description: 'Accumulated volume of a utility that has flowed. Monotonic, so it is a counter to difference rather than a value to read.' },
      { group: 'Energy', type: 'IVolumeFlowType', name: 'VolumeFlowRate', unit: 'LITER/SECOND',
        description: 'Instantaneous volume flow rate of a utility -- compressed air consumption being the usual reason to model this on a shopfloor.' },

      // The NodeSet describes neither. They hang from the interface by IA's HasStatisticComponent
      // and carry no unit of their own here: the carrier decides it.
      ...since('0300', [
        { group: 'Energy', type: 'INonElectricalEnergyType', name: 'NeEnergyImportHp',
          description: 'Accumulated non-electrical energy the machine takes in, for example as heat or gas, in double precision (Hp is the specification\'s suffix for that form). Monotonic, so it is a counter to difference rather than a value to read. No unit is offered because it follows the carrier: choose one when the metric is created.' },
        { group: 'Energy', type: 'INonElectricalEnergyType', name: 'NeEnergyExportHp',
          description: 'Accumulated non-electrical energy the machine gives out, the other direction of NeEnergyImportHp, in double precision. A counter to difference, and its unit is chosen when the metric is created.' }
      ])
    ]
  },
  {
    // OPC 40001-2 is the shape of a process value, which OPC 40540's ProcessValueAMType subtypes: a
    // printer's chamber temperature is an instance of it that the vendor names. The generic
    // reading, setpoint, limits and status are therefore worth a row each, and the rows share
    // OPC 40540's ProcessValue group (PROCESS_VALUE_GROUP above). The NodeSet describes every one;
    // each description follows its text, edited.
    companionSpec: 'OPC 40001-2 Machinery Process Values',
    namespaceUri: 'http://opcfoundation.org/UA/Machinery/ProcessValues/',
    path: 'Machinery/ProcessValues/Opc.Ua.Machinery.ProcessValues.NodeSet2.xml',
    version: '1.00.0',
    publicationDate: '2023-05-01T00:00:00Z',
    groups: { ProcessValue: PROCESS_VALUE_GROUP },
    entries: since('0300', [
      { group: 'ProcessValue', type: 'ProcessValueType', name: 'AnalogSignal',
        description: 'The process value itself: the reading. The specification puts its unit and range in the signal\'s EngineeringUnits and EURange properties, so here the unit is chosen when the metric is created. Its limits and its percentage are rows of their own below.' },
      { group: 'ProcessValue', type: 'ProcessValueType', name: 'ProcessValueSetpoint',
        description: 'The desired value, which the server may or may not control. AnalogSignal is the reading it is compared with.' },
      { group: 'ProcessValue', type: 'ProcessValueType', name: 'Status',
        description: 'Whether a limit has been reached, as a number from the specification: 0 not monitoring, 1 status not known, 2 below LowLowLimit, 3 below LowLimit, 4 below LowLowDeviation, 5 below LowDeviation, 6 within tolerance, 7 above HighDeviation, 8 above HighHighDeviation, 9 above HighLimit, 10 above HighHighLimit.' },
      { group: 'ProcessValue', type: 'ProcessValueType', name: 'PercentageValue', browsePath: ['AnalogSignal', 'PercentageValue'], unit: 'PERCENT',
        description: 'The process value as a percentage, for a signal that provides one.' },
      { group: 'ProcessValue', type: 'ProcessValueType', name: 'HighHighLimit', browsePath: ['AnalogSignal', 'HighHighLimit'],
        description: 'Absolute high-high limit of the process value, in its unit. Status reports above HighHighLimit when the reading passes it.' },
      { group: 'ProcessValue', type: 'ProcessValueType', name: 'HighLimit', browsePath: ['AnalogSignal', 'HighLimit'],
        description: 'Absolute high limit of the process value, in its unit. Status reports above HighLimit when the reading passes it.' },
      { group: 'ProcessValue', type: 'ProcessValueType', name: 'LowLimit', browsePath: ['AnalogSignal', 'LowLimit'],
        description: 'Absolute low limit of the process value, in its unit. Status reports below LowLimit when the reading falls under it.' },
      { group: 'ProcessValue', type: 'ProcessValueType', name: 'LowLowLimit', browsePath: ['AnalogSignal', 'LowLowLimit'],
        description: 'Absolute low-low limit of the process value, in its unit. Status reports below LowLowLimit when the reading falls under it.' }
    ])
  }
];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The dashboard's group suggestion per data point, which no opcua_vocabulary column carries. */
const GROUPS_MODULE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'frontend', 'src', 'utils', 'opcuaGroups.generated.js'
);

/** Namespace index 0 of every NodeSet: the base OPC UA namespace, never listed in NamespaceUris. */
const OPC_UA_NAMESPACE = 'http://opcfoundation.org/UA/';

/**
 * A deliberately narrow reader for UANodeSet documents, rather than an XML dependency.
 *
 * package.json has no dependencies at all and several scripts go out of their way to keep it that
 * way (check-broker-config.mjs parses YAML by hand for the same reason). These files are
 * machine-generated with one element per node and attributes on the opening tag, so scanning for
 * element boundaries is sound here in a way it would not be for arbitrary XML. It is used only to
 * read attributes and References -- never to round-trip or rewrite the document.
 */
function parseNodeSet(xml) {
  const nodes = new Map();
  const byBrowseName = new Map();
  const model = {};

  // A NodeSet may write a DataType either as a raw NodeId (`i=11`) or as an alias declared in its
  // own <Aliases> block (`Double`). Both forms appear across these four files, so resolving the
  // alias table is not optional -- without it every aliased DataType looks like an unknown type.
  const aliases = new Map();
  for (const m of xml.matchAll(/<Alias\b[^>]*Alias="([^"]+)"[^>]*>([^<]*)<\/Alias>/g)) {
    aliases.set(m[1], m[2].trim());
  }

  const modelMatch = xml.match(/<Model\b([^>]*)>/);
  if (modelMatch) {
    const attrs = readAttrs(modelMatch[1]);
    model.uri = attrs.ModelUri;
    model.version = attrs.Version;
    model.publicationDate = attrs.PublicationDate;
  }

  // A NodeId's `ns=<index>` counts from this document's own table, so the same index names a
  // different namespace in each file: Robotics is ns=3 in its NodeSet, Machinery ns=1 in its.
  const table = xml.match(/<NamespaceUris>([\s\S]*?)<\/NamespaceUris>/);
  const namespaceUris = table
    ? [...table[1].matchAll(/<Uri>([^<]*)<\/Uri>/g)].map((m) => m[1].trim())
    : [];

  const element = /<(UAObjectType|UAVariable|UADataType|UAObject|UAVariableType|UAReferenceType)\b([^>]*?)(\/)?>/g;
  let match;
  while ((match = element.exec(xml)) !== null) {
    const [full, tag, attrText, selfClosing] = match;
    const attrs = readAttrs(attrText);
    let body = '';
    if (!selfClosing) {
      const close = xml.indexOf(`</${tag}>`, element.lastIndex);
      body = close < 0 ? '' : xml.slice(element.lastIndex, close);
    }
    const node = {
      tag,
      nodeId: attrs.NodeId,
      browseName: stripNs(attrs.BrowseName),
      dataType: attrs.DataType,
      parentNodeId: attrs.ParentNodeId,
      references: [...body.matchAll(/<Reference\b([^>]*)>([^<]*)<\/Reference>/g)].map((r) => {
        const refAttrs = readAttrs(r[1]);
        return {
          type: referenceTypeName(refAttrs.ReferenceType, aliases),
          // The NodeId the document names the type by, which a type from another namespace is found by.
          typeId: aliases.get(refAttrs.ReferenceType) ?? refAttrs.ReferenceType,
          forward: refAttrs.IsForward !== 'false',
          target: r[2].trim()
        };
      }),
      // The members of an enumeration, in the order the DataType defines them.
      fields: tag === 'UADataType' ? [...body.matchAll(/<Field\b([^>]*)>/g)].map((f) => readAttrs(f[1]).Name) : []
    };
    if (node.nodeId) nodes.set(node.nodeId, node);
    if (node.browseName) {
      if (!byBrowseName.has(node.browseName)) byBrowseName.set(node.browseName, []);
      byBrowseName.get(node.browseName).push(node);
    }
    void full;
  }
  const doc = { nodes, byBrowseName, model, aliases, namespaceUris };
  // A node is read in the document that defines it: its NodeIds count namespaces from that table.
  for (const node of nodes.values()) node.doc = doc;
  return doc;
}

/**
 * A NodeId as this document writes it (`ns=3;i=16662`, or `i=2255` in namespace 0) in the
 * ExpandedNodeId string form of OPC 10000-6 5.3.1.11, `nsu=<namespace URI>;i=16662`, which holds
 * outside the document. The identifier keeps its own type (`i=`, `s=`, `g=`, `b=`); `%` and `;` in
 * the URI are percent-encoded, as that form requires.
 */
function expandedNodeId(nodeId, doc, where) {
  const m = /^(?:ns=(\d+);)?([isgb])=(.+)$/.exec(nodeId || '');
  if (!m) throw new Error(`${where}: ${nodeId} is not a NodeId this script can read`);
  const index = Number(m[1] ?? 0);
  const uri = index === 0 ? OPC_UA_NAMESPACE : doc.namespaceUris[index - 1];
  if (!uri) throw new Error(`${where}: ${nodeId} names namespace ${index}, which NamespaceUris does not list`);
  return `nsu=${uri.replace(/%/g, '%25').replace(/;/g, '%3B')};${m[2]}=${m[3]}`;
}

/**
 * A ReferenceType is written either as an alias (`HasProperty`) or as the raw namespace-0 NodeId
 * (`i=46`): Machinery 1.04.2 dropped its <Aliases> block and writes every one raw. Both are read as
 * the standard name, which is what the walks below compare against.
 */
const REFERENCE_TYPES = { 'i=45': 'HasSubtype', 'i=46': 'HasProperty', 'i=47': 'HasComponent' };
const referenceTypeName = (type, aliases) => REFERENCE_TYPES[aliases.get(type) ?? type] ?? type;

function readAttrs(text) {
  const attrs = {};
  for (const m of text.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/g)) attrs[m[1]] = m[2];
  return attrs;
}

/** BrowseNames are namespace-index prefixed (`1:FeedOverride`); the index is per-document. */
const stripNs = (value) => (value && value.includes(':') ? value.slice(value.indexOf(':') + 1) : value);

/**
 * Built-in DataTypes are referenced as bare `i=NNN` ids that this document does not define, so the
 * numeric ids of the ones we care about are spelled out. Anything else resolves through the
 * document, which is how a specification-defined enumeration is recognised.
 */
const BUILT_IN = {
  'i=1': 'Boolean', 'i=2': 'SByte', 'i=3': 'Byte', 'i=4': 'Int16', 'i=5': 'UInt16',
  'i=6': 'Int32', 'i=7': 'UInt32', 'i=8': 'Int64', 'i=9': 'UInt64', 'i=10': 'Float',
  'i=11': 'Double', 'i=12': 'String', 'i=13': 'DateTime', 'i=17': 'NodeId',
  'i=21': 'LocalizedText', 'i=26': 'Number', 'i=28': 'UInteger', 'i=294': 'UtcTime',
  // Double in milliseconds, and an ISO 8601 duration string.
  'i=290': 'Duration', 'i=12879': 'DurationString',
  // The abstract Enumeration base, used where a variable accepts any enumeration member.
  'i=29': 'Enumeration'
};

/** The two OPC UA base types a specification-defined DataType can subtype. */
const ENUMERATION_BASE = 'i=29';
const STRUCTURE_BASE = 'i=22';

/**
 * Two curation rules, applied here so they are applied identically to every row.
 *
 * ENUMERATIONS BECOME `String`. A specification-defined enumeration (ChannelState, PartQuality)
 * has no Sparkplug equivalent, and a device publishing one over Sparkplug B publishes the member
 * name as a string. The enumeration's own name is named in the description instead, so the
 * information is not lost.
 *
 * ABSTRACT `Number` BECOMES `Double`. `Number` is not instantiable; a device publishes a concrete
 * type, and Double is the only one that cannot lose range against the alternatives. `Duration` is a
 * Double and `DurationString` a String, so each becomes its base; the description says what it holds.
 * The abstract `UInteger` becomes `UInt64` for the same reason, and `UtcTime`, a DateTime, its base.
 *
 * STRUCTURES ARE REFUSED, AND A STRUCTURE STOPS THE BUILD. Treating any specification-defined
 * DataType as an enumeration holds for MachineTool and Additive and fails for OPC 30050, which
 * carries PackMLCountDataType, PackMLProductDataType and three more structures. Flattening one to a
 * string produces a vocabulary row that looks ordinary and cannot be published: Sparkplug B has no
 * composite type, so a device has to decompose it into separate metrics, and which decomposition is
 * a modelling decision no generator should make silently. The curated list leaves them out.
 */
function resolveDataType(node, doc, where) {
  const declared = node.dataType;
  if (!declared) throw new Error(`${where}: member has no DataType attribute`);
  const raw = doc.aliases.get(declared) ?? declared;
  if (BUILT_IN[raw]) {
    const builtIn = BUILT_IN[raw];
    if (builtIn === 'Number' || builtIn === 'Duration') return 'Double';
    if (builtIn === 'UInteger') return 'UInt64';
    if (builtIn === 'UtcTime') return 'DateTime';
    if (builtIn === 'Enumeration' || builtIn === 'DurationString') return 'String';
    return builtIn;
  }
  const target = doc.nodes.get(raw) ?? externalNode(raw, doc);
  if (!target) throw new Error(`${where}: DataType ${raw} is neither built-in nor defined in this NodeSet`);
  if (target.tag !== 'UADataType') throw new Error(`${where}: DataType ${raw} resolves to a ${target.tag}`);

  // Which base it subtypes is the discriminator, and it is recorded as a REVERSE HasSubtype
  // reference on the type itself.
  const base = target.references.find((r) => r.type === 'HasSubtype' && !r.forward)?.target;
  if (base === ENUMERATION_BASE) return 'String';
  if (base === STRUCTURE_BASE) {
    throw new Error(
      `${where}: ${target.browseName} is a STRUCTURE, which Sparkplug B cannot carry. Decompose it ` +
      `into scalar metrics deliberately, or leave it out of ENTRIES -- do not let it become a String.`
    );
  }
  throw new Error(
    `${where}: ${target.browseName} subtypes ${base ?? 'nothing this file declares'}, which is ` +
    `neither Enumeration (${ENUMERATION_BASE}) nor Structure (${STRUCTURE_BASE})`
  );
}

/** The members of an enumeration the variable is typed as, in the order its DataType defines them. */
function enumerationMembers(node, doc, where) {
  const raw = doc.aliases.get(node.dataType) ?? node.dataType;
  const target = doc.nodes.get(raw) ?? externalNode(raw, doc);
  const base = target?.references.find((r) => r.type === 'HasSubtype' && !r.forward)?.target;
  if (target?.tag !== 'UADataType' || base !== ENUMERATION_BASE) {
    throw new Error(`${where}: the entry names values, but ${node.dataType} is not an enumeration this NodeSet or a pinned dependency defines`);
  }
  return target.fields;
}

/**
 * A node this document names but another NodeSet defines. `ns=6;i=3002` in Machine Tools is `i=3002`
 * of IA, and IA writes it `ns=1;i=3002`, counting from its own table. Null when the namespace is none
 * of DEPENDENCIES, so the caller's own message says what could not be resolved.
 */
function externalNode(nodeId, doc) {
  const m = /^ns=(\d+);(.+)$/.exec(nodeId || '');
  const uri = m && doc.namespaceUris[Number(m[1]) - 1];
  const dependency = uri && dependencyDocs.get(uri);
  return dependency?.nodes.get(`ns=${dependency.namespaceUris.indexOf(uri) + 1};${m[2]}`) ?? null;
}

/**
 * Whether a reference links a member to its type: HasComponent, HasProperty, or a reference type that
 * subtypes one. Machinery Energy hangs `NeEnergyImportHp` from its interface by IA's
 * HasStatisticComponent, which IA declares as a subtype of HasComponent; the chain is followed in the
 * NodeSet that declares each type.
 */
function linksAMember(ref, doc) {
  let typeId = ref.typeId;
  let owner = doc;
  for (let hops = 0; hops < 8; hops += 1) {
    const known = REFERENCE_TYPES[typeId];
    if (known === 'HasComponent' || known === 'HasProperty') return true;
    const type = owner.nodes.get(typeId) ?? externalNode(typeId, owner);
    if (!type) return false;
    owner = type.doc;
    typeId = type.references.find((r) => r.type === 'HasSubtype' && !r.forward)?.target;
    if (!typeId) return false;
  }
  return false;
}

/**
 * The variable at `path` below the ObjectType, one BrowseName per step. Each step is a component or
 * property the NodeSet declares on the node before it, and must name exactly one node: the NodeId
 * becomes the row's identifier, so a step that could mean two nodes stops the build.
 */
function memberAt(objectType, path, doc, where) {
  let node = objectType;
  path.forEach((name, step) => {
    const found = node.references
      .filter((ref) => ref.forward && linksAMember(ref, doc))
      .map((ref) => doc.nodes.get(ref.target))
      .filter((target) => target && target.browseName === name &&
        (step === path.length - 1 ? target.tag === 'UAVariable' : ['UAObject', 'UAVariable'].includes(target.tag)));
    if (found.length !== 1) {
      throw new Error(`${where}: ${node.browseName} declares ${found.length} members named ${name}, expected one ` +
        `(path ${objectType.browseName}/${path.join('/')})`);
    }
    node = found[0];
  });
  return node;
}


/** The pinned NodeSets of DEPENDENCIES, parsed, by namespace URI. */
const dependencyDocs = new Map();

/** A NodeSet read from the pinned branch, with its ModelUri, version and publication date held to the pin. */
async function readNodeSet(source, label) {
  const url = `${BASE}/${source.path}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch failed: ${response.status} ${url}`);
  const doc = parseNodeSet(await response.text());

  // THE PIN CHECK. Everything below is only as trustworthy as the document it was read from, so a
  // NodeSet that is not the one this vocabulary was curated against must stop the build rather than
  // quietly re-stamp the seed against a specification nobody reviewed.
  const { uri, version, publicationDate } = doc.model;
  if (uri !== source.namespaceUri) {
    throw new Error(`${label}: ModelUri is ${uri}, expected ${source.namespaceUri}`);
  }
  if (version !== source.version || publicationDate !== source.publicationDate) {
    throw new Error(
      `${label}: upstream moved to ${version} (${publicationDate}), pinned to ` +
      `${source.version} (${source.publicationDate}). Review the diff, update the pin and the entries, ` +
      `then re-run -- do not just bump the pin.`
    );
  }
  return doc;
}

const rows = [];
const groups = new Map();
const groupOwner = new Map();
const groupsByPoint = new Map();
const formerIds = [];
const seenIds = new Map();
const summary = [];

for (const dependency of DEPENDENCIES) {
  dependencyDocs.set(dependency.namespaceUri, await readNodeSet(dependency, dependency.namespaceUri));
}

for (const spec of SPECS) {
  const doc = await readNodeSet(spec, spec.companionSpec);

  for (const entry of spec.entries) {
    const where = `${spec.companionSpec}/${entry.name}`;
    const candidates = (doc.byBrowseName.get(entry.type) || []).filter((n) => n.tag === 'UAObjectType');
    if (candidates.length !== 1) {
      throw new Error(`${where}: expected exactly one ObjectType named ${entry.type}, found ${candidates.length}`);
    }
    const member = memberAt(candidates[0], entry.browsePath ?? [entry.name], doc, where);
    const datatype = resolveDataType(member, doc, where);
    if (entry.values) {
      // The names a person enters as the metric's permitted values, held to the NodeSet's own.
      const members = enumerationMembers(member, doc, where);
      if (members.join() !== entry.values.join()) {
        throw new Error(`${where}: the entry names the values ${entry.values.join(', ')}, the NodeSet defines ${members.join(', ')}`);
      }
      const unnamed = entry.values.filter((value) => !entry.description.includes(value));
      if (unnamed.length) throw new Error(`${where}: the description does not name ${unnamed.join(', ')}`);
    }
    // The id the specification publishes for this variable, as both the node and the concept.
    const nodeId = expandedNodeId(member.nodeId, doc, where);
    if (!nodeId.startsWith(`nsu=${spec.namespaceUri};`)) {
      throw new Error(`${where}: ${nodeId} is outside ${spec.namespaceUri}; a row names a node its own specification declares`);
    }
    if (seenIds.has(nodeId)) throw new Error(`${where}: ${nodeId} is already ${seenIds.get(nodeId)}`);
    seenIds.set(nodeId, where);
    const semanticId = nodeId;
    // What 0171 repoints: the namespace plus the name, the id this vocabulary carried before 1.2.0.
    formerIds.push([`${spec.namespaceUri}${entry.name}`, semanticId]);

    rows.push({
      since: entry.since,
      spec: spec.companionSpec,
      group: entry.group,
      statement:
        `INSERT INTO public.opcua_vocabulary VALUES (${sqlString(entry.name)}, ` +
        `${sqlString(spec.companionSpec)}, ${sqlString(nodeId)}, ${sqlString(entry.description)}, ` +
        `${sqlString(datatype)}, ${entry.unit ? sqlString(entry.unit) : 'NULL'}, ${sqlString(semanticId)})\n` +
        `ON CONFLICT (companion_spec, name) DO UPDATE SET\n` +
        `  node_id     = EXCLUDED.node_id,\n` +
        `  description = EXCLUDED.description,\n` +
        `  datatype    = EXCLUDED.datatype,\n` +
        `  unit        = EXCLUDED.unit,\n` +
        `  semantic_id = EXCLUDED.semantic_id;`
    });
    if (!(entry.group in spec.groups)) throw new Error(`${where}: no description registered for group ${entry.group}`);
    // Two specifications may list one group, with one definition: a second text for it would be
    // silently replacing the first.
    if (groups.has(entry.group) && JSON.stringify(groups.get(entry.group)) !== JSON.stringify(spec.groups[entry.group])) {
      throw new Error(`group ${entry.group} is described one way by ${groupOwner.get(entry.group)} and another by ${spec.companionSpec}; give both the same definition`);
    }
    groups.set(entry.group, spec.groups[entry.group]);
    groupOwner.set(entry.group, spec.companionSpec);
    if (!groupsByPoint.has(spec.companionSpec)) groupsByPoint.set(spec.companionSpec, new Map());
    groupsByPoint.get(spec.companionSpec).set(entry.name, entry.group);
  }
  summary.push(`${spec.companionSpec}: ${spec.entries.length} rows from ${spec.path}`);
}

const plans = planBlocks({ rows, groups, generatedSpecs: SPECS.map((spec) => spec.companionSpec) });

// Normalised for the same reason the MTConnect generator normalises: git checks the seed out as
// CRLF on Windows, and splicing an LF block in would digest over neither ending consistently.
const read = (file) => readFileSync(join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
const current = new Map(BLOCKS.map((block) => [block.file, read(block.file)]));

// A group with no description here is registered by a hand-written metric_groups row in a block's
// file, with the id every database already holds.
for (const [name, definition] of groups) {
  if (definition !== null) continue;
  const quoted = name.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
  const registered = new RegExp(`^INSERT INTO public\\.metric_groups VALUES \\('[^']+', '${quoted}', .*'OPC UA'\\)$`, 'm');
  if (![...current.values()].some((text) => registered.test(text))) {
    throw new Error(`group ${name} has no description here and no hand-written OPC UA metric_groups row in ${BLOCKS.map((b) => b.file).join(' or ')}`);
  }
}

// Every block is worked out before any file is written, so a released block that has moved stops the
// run with nothing changed.
const results = plans.map((plan) => ({ plan, ...applyPlan(current.get(plan.block.file), plan) }));
for (const { plan, changed } of results) {
  if (changed.length && !isUnreleased(plan.block, ROOT)) {
    throw new Error(
      `${plan.block.file} is released (no unreleased/migrations/${plan.block.since}.md) and its ${changed.join(', ')} ` +
      `would now read differently. A released block is verified, never rewritten. Find what moved, a ` +
      `NodeSet under its pin or an entry or a group description edited since the block shipped, and ` +
      `undo it. A new data point goes in a new block: add the block to scripts/lib/opcua-seed-blocks.mjs ` +
      `and give the entry since: '<its migration>'.`
    );
  }
}
for (const { plan, text, changed } of results) {
  if (changed.length) writeFileSync(join(ROOT, plan.block.file), text, 'utf8');
  console.log(`  ${plan.block.since}: ${plan.vocabulary.rows} opcua_vocabulary rows, ${plan.groups.rows} metric_groups statements` +
    (changed.length ? ` (wrote ${changed.join(', ')})` : ' (unchanged)'));
}

// The dashboard's group suggestion for each data point, keyed as the table is.
const groupsBody = [...groupsByPoint.keys()].sort().map((spec) => {
  const names = [...groupsByPoint.get(spec).entries()].sort(([a], [b]) => a.localeCompare(b));
  const key = (name) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : `'${name}'`);
  return `  '${spec}': {\n${names.map(([name, group]) => `    ${key(name)}: '${group}'`).join(',\n')}\n  }`;
}).join(',\n');
const groupsDigest = createHash('sha256').update(groupsBody).digest('hex').slice(0, 16);
writeFileSync(GROUPS_MODULE,
  `// GENERATED by scripts/generate-opcua-vocabulary.mjs -- ${seenIds.size} points, sha256:${groupsDigest}\n` +
  '// Do not edit: change ENTRIES in that script and re-run it. scripts/check-opcua-seed-sync.mjs\n' +
  '// holds every key to an opcua_vocabulary row and every group to an OPC UA metric_groups row.\n' +
  '//\n' +
  '// The metric group Add Metric suggests for each OPC UA data point, by companion specification\n' +
  '// and name. node_id is a NodeId, so no column of the row says it.\n' +
  `export const OPCUA_GROUPS = {\n${groupsBody}\n}\n`, 'utf8');

console.log(`${rows.length} opcua_vocabulary rows in ${BLOCKS.length} blocks`);
for (const { plan } of results) {
  console.log(`  ${plan.block.since}  vocabulary ${plan.vocabulary.header.match(/sha256:([0-9a-f]+)/)[1]}  groups ${plan.groups.header.match(/sha256:([0-9a-f]+)/)[1]}`);
}
console.log(`  dashboard groups  sha256:${groupsDigest}`);
for (const line of summary) console.log(`  ${line}`);
if (process.argv.includes('--print-map')) {
  for (const [former, id] of formerIds) console.log(`${former}\t${id}`);
}
