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
 *   node scripts/generate-opcua-vocabulary.mjs --print-map   also prints each row's former id
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { COMMENT_BEGIN, COMMENT_END, tableCommentStatement } from './lib/opcua-vocabulary-comment.mjs';

/**
 * Pinned to a branch rather than a commit, matching the MTConnect generator's use of `master`.
 * The version/publicationDate assertions below are what actually protect against upstream moving:
 * a branch that advances is caught by the pin check, not silently absorbed.
 */
const REF = 'latest';
const BASE = `https://raw.githubusercontent.com/OPCFoundation/UA-Nodeset/${REF}`;

/**
 * Written to the seed as-is, except what the NodeSet supplies: `datatype` and the identifiers. A
 * group whose description is null is registered by the hand-written metric_groups rows above the
 * generated block, whose ids are fixed; the script checks that row exists.
 */
const SPECS = [
  {
    companionSpec: 'OPC 40001 Machinery',
    namespaceUri: 'http://opcfoundation.org/UA/Machinery/',
    path: 'Machinery/Opc.Ua.Machinery.NodeSet2.xml',
    version: '1.04.1',
    publicationDate: '2026-01-01T00:00:00Z',
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
        description: 'Accumulated time the machine has been powered on. The specification types it as Duration, which OPC UA counts in milliseconds.' }
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
        description: 'Accumulated controller power-on time. The specification types it as DurationString, an ISO 8601 duration such as P12DT3H, so it is text rather than a number of seconds.' }
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
      Tool: 'OPC UA Machine Tools (OPC 40501) tool management state'
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
        description: 'Whether the tool is planned for use by the current setup.' }
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
      ProcessValue: 'OPC UA Additive Manufacturing (OPC 40540) in-process sensor readings'
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
        description: 'Severity attached to an in-process sensor reading, from the SensorSeverity enumeration. The machine grading its own measurement, which is not the same as an alarm.' }
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
        description: 'Which PackML version the unit implements. Worth catalogue space because the state model changed between editions.' }
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
        description: 'Instantaneous volume flow rate of a utility -- compressed air consumption being the usual reason to model this on a shopfloor.' }
    ]
  }
];

const SEED = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'supabase', 'migrations', '0002_seed_data.sql'
);
const VOCAB_BEGIN = '-- >>> BEGIN GENERATED opcua_vocabulary_rows';
const VOCAB_END = '-- <<< END GENERATED opcua_vocabulary_rows';
const GROUP_BEGIN = '-- >>> BEGIN GENERATED opcua_metric_groups';
const GROUP_END = '-- <<< END GENERATED opcua_metric_groups';

/** The dashboard's group suggestion per data point, which no opcua_vocabulary column carries. */
const GROUPS_MODULE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'frontend', 'src', 'utils', 'opcuaGroups.generated.js'
);

/** Namespace index 0 of every NodeSet: the base OPC UA namespace, never listed in NamespaceUris. */
const OPC_UA_NAMESPACE = 'http://opcfoundation.org/UA/';

const sqlString = (value) => `'${String(value).replace(/'/g, "''")}'`;

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

  const element = /<(UAObjectType|UAVariable|UADataType|UAObject|UAVariableType)\b([^>]*?)(\/)?>/g;
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
          type: refAttrs.ReferenceType,
          forward: refAttrs.IsForward !== 'false',
          target: r[2].trim()
        };
      })
    };
    if (node.nodeId) nodes.set(node.nodeId, node);
    if (node.browseName) {
      if (!byBrowseName.has(node.browseName)) byBrowseName.set(node.browseName, []);
      byBrowseName.get(node.browseName).push(node);
    }
    void full;
  }
  return { nodes, byBrowseName, model, aliases, namespaceUris };
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
  'i=21': 'LocalizedText', 'i=26': 'Number', 'i=294': 'UtcTime',
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
    if (builtIn === 'Enumeration' || builtIn === 'DurationString') return 'String';
    return builtIn;
  }
  const target = doc.nodes.get(raw);
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

/**
 * The variable at `path` below the ObjectType, one BrowseName per step. Each step is a component or
 * property the NodeSet declares on the node before it, and must name exactly one node: the NodeId
 * becomes the row's identifier, so a step that could mean two nodes stops the build.
 */
function memberAt(objectType, path, doc, where) {
  let node = objectType;
  path.forEach((name, step) => {
    const found = node.references
      .filter((ref) => ref.forward && (ref.type === 'HasComponent' || ref.type === 'HasProperty'))
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

const vocabRows = [];
const groupRows = new Map();
const groupsByPoint = new Map();
const formerIds = [];
const seenIds = new Map();
const summary = [];

for (const spec of SPECS) {
  const url = `${BASE}/${spec.path}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch failed: ${response.status} ${url}`);
  const doc = parseNodeSet(await response.text());

  // THE PIN CHECK. Everything below is only as trustworthy as the document it was read from, so a
  // NodeSet that is not the one this vocabulary was curated against must stop the build rather than
  // quietly re-stamp the seed against a specification nobody reviewed.
  const { uri, version, publicationDate } = doc.model;
  if (uri !== spec.namespaceUri) {
    throw new Error(`${spec.companionSpec}: ModelUri is ${uri}, expected ${spec.namespaceUri}`);
  }
  if (version !== spec.version || publicationDate !== spec.publicationDate) {
    throw new Error(
      `${spec.companionSpec}: upstream moved to ${version} (${publicationDate}), pinned to ` +
      `${spec.version} (${spec.publicationDate}). Review the diff, update the pin and the entries, ` +
      `then re-run -- do not just bump the pin.`
    );
  }

  for (const entry of spec.entries) {
    const where = `${spec.companionSpec}/${entry.name}`;
    const candidates = (doc.byBrowseName.get(entry.type) || []).filter((n) => n.tag === 'UAObjectType');
    if (candidates.length !== 1) {
      throw new Error(`${where}: expected exactly one ObjectType named ${entry.type}, found ${candidates.length}`);
    }
    const member = memberAt(candidates[0], entry.browsePath ?? [entry.name], doc, where);
    const datatype = resolveDataType(member, doc, where);
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

    vocabRows.push(
      `INSERT INTO public.opcua_vocabulary VALUES (${sqlString(entry.name)}, ` +
      `${sqlString(spec.companionSpec)}, ${sqlString(nodeId)}, ${sqlString(entry.description)}, ` +
      `${sqlString(datatype)}, ${entry.unit ? sqlString(entry.unit) : 'NULL'}, ${sqlString(semanticId)})\n` +
      `ON CONFLICT (companion_spec, name) DO UPDATE SET\n` +
      `  node_id     = EXCLUDED.node_id,\n` +
      `  description = EXCLUDED.description,\n` +
      `  datatype    = EXCLUDED.datatype,\n` +
      `  unit        = EXCLUDED.unit,\n` +
      `  semantic_id = EXCLUDED.semantic_id;`
    );
    if (!(entry.group in spec.groups)) throw new Error(`${where}: no description registered for group ${entry.group}`);
    groupRows.set(entry.group, spec.groups[entry.group]);
    if (!groupsByPoint.has(spec.companionSpec)) groupsByPoint.set(spec.companionSpec, new Map());
    groupsByPoint.get(spec.companionSpec).set(entry.name, entry.group);
  }
  summary.push(`${spec.companionSpec}: ${spec.entries.length} rows from ${spec.path}`);
}

/**
 * `metric_groups` rows, registered here rather than created on first use.
 *
 * `enforce_metric_group_spelling()` makes the first spelling of a group permanent, so a group that
 * arrives implicitly -- because someone created a metric called `Channel/FeedOverride` -- fixes
 * whatever casing they typed, forever. Registering the intended spelling in the seed is what makes
 * that trigger a guard rather than a trap.
 *
 * Ids are derived from the name so re-running is stable and the diff stays empty; a random uuid
 * would rewrite every line on every run. `ON CONFLICT DO NOTHING` covers both the primary key and
 * uq_metric_groups_name_ci, so a group that already exists is left exactly as it is rather than
 * being restated with this file's description. `Machine` and `MotionDevice` are registered by the
 * hand-written rows above the block, with the ids every database already holds.
 */
const groupUuid = (name) => {
  // The salt these PRIMARY KEYS are derived from. Changing it changes every id this block seeds,
  // and an installed database keeps the ids it was seeded with, so it is fixed from 1.0 on.
  const hex = createHash('sha256').update(`aber.metric_group.${name}`).digest('hex');
  return [
    hex.slice(0, 8), hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    ((parseInt(hex.slice(16, 17), 16) & 0x3 | 0x8).toString(16)) + hex.slice(17, 20),
    hex.slice(20, 32)
  ].join('-');
};

function splice(seed, begin, end, header, body) {
  const beginAt = seed.indexOf(begin);
  const endAt = seed.indexOf(end);
  if (beginAt < 0 || endAt < 0 || endAt < beginAt) {
    throw new Error(`markers not found in ${SEED}. Expected a block delimited by:\n  ${begin}\n  ${end}`);
  }
  return seed.slice(0, beginAt) + header + '\n' + body + '\n' + seed.slice(endAt);
}

// Normalised for the same reason the MTConnect generator normalises: git checks the seed out as
// CRLF on Windows, and splicing an LF block in would digest over neither ending consistently.
let seed = readFileSync(SEED, 'utf8').replace(/\r\n/g, '\n');

for (const [name, description] of groupRows) {
  if (description !== null) continue;
  const quoted = name.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
  const registered = new RegExp(`^INSERT INTO public\\.metric_groups VALUES \\('[^']+', '${quoted}', .*'OPC UA'\\)$`, 'm');
  if (!registered.test(seed)) {
    throw new Error(`group ${name} has no description here and no hand-written OPC UA metric_groups row in ${SEED}`);
  }
}

const groupStatements = [...groupRows.entries()]
  .filter(([, description]) => description !== null)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, description]) =>
    `INSERT INTO public.metric_groups (id, name, description, standard) VALUES ` +
    `(${sqlString(groupUuid(name))}, ${sqlString(name)}, ${sqlString(description)}, 'OPC UA')\n` +
    `ON CONFLICT DO NOTHING;`);

const vocabBody = vocabRows.join('\n');
const vocabDigest = createHash('sha256').update(vocabBody).digest('hex').slice(0, 16);
seed = splice(seed, VOCAB_BEGIN, VOCAB_END,
  `${VOCAB_BEGIN} -- ${vocabRows.length} rows, sha256:${vocabDigest}\n` +
  `-- GENERATED from the OPC Foundation NodeSet2 XML by scripts/generate-opcua-vocabulary.mjs.\n` +
  `-- Do not edit these rows by hand: change ENTRIES in that script and re-run it. Browse names,\n` +
  `-- datatypes and NodeIds are read from the NodeSet; the selection, prose and units are curated.\n` +
  `-- CI verifies the digest above.`,
  vocabBody);

const groupBody = groupStatements.join('\n');
const groupDigest = createHash('sha256').update(groupBody).digest('hex').slice(0, 16);
seed = splice(seed, GROUP_BEGIN, GROUP_END,
  `${GROUP_BEGIN} -- ${groupStatements.length} rows, sha256:${groupDigest}\n` +
  `-- GENERATED by scripts/generate-opcua-vocabulary.mjs. CI verifies the digest above.`,
  groupBody);

// The table's COMMENT names every specification the seed holds.
seed = splice(seed, COMMENT_BEGIN, COMMENT_END,
  `${COMMENT_BEGIN}\n` +
  `-- GENERATED by scripts/generate-opcua-vocabulary.mjs from every opcua_vocabulary row in this file.`,
  tableCommentStatement(seed, SPECS.map((spec) => spec.companionSpec)));

writeFileSync(SEED, seed, 'utf8');

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

console.log(`wrote ${vocabRows.length} opcua_vocabulary rows and ${groupStatements.length} metric_groups rows`);
console.log(`  opcua_vocabulary  sha256:${vocabDigest}`);
console.log(`  metric_groups     sha256:${groupDigest}`);
console.log(`  dashboard groups  sha256:${groupsDigest}`);
for (const line of summary) console.log(`  ${line}`);
if (process.argv.includes('--print-map')) {
  for (const [former, current] of formerIds) console.log(`${former}\t${current}`);
}
