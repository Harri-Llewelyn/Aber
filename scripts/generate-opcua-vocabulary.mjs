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
 * as the name -- so the bulk import would make the vocabulary *less* findable than the 19
 * hand-written rows it joined. The raw node lists are also dominated by modelling scaffolding
 * (`IsNamespaceSubset`, `StaticNodeIdTypes`, `EngineeringUnits`) rather than by anything a device
 * publishes.
 *
 * So ENTRIES below is a curated list -- the selection and the prose are human -- and this script's
 * job is to **verify it against the NodeSet and fill in what the NodeSet is authoritative for**:
 *
 *   * the ObjectType named by `type` must exist in the target namespace;
 *   * it must declare a member variable whose BrowseName is `name`;
 *   * `datatype` is read from that member, never typed here;
 *   * the model's namespace URI, version and publication date must match the pins below.
 *
 * A rename, a retype or a version bump upstream therefore fails the build instead of silently
 * shipping a vocabulary that describes a specification nobody publishes any more. That is the
 * property the ⚠ VERIFY blocks ask for, and it is stronger than what a transcription can offer:
 * the seed's existing OPC UA header says the browse names "are transcribed and still want
 * confirming against those files", and for these four specs this script is that confirmation.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Pinned to a branch rather than a commit, matching the MTConnect generator's use of `master`.
 * The version/publicationDate assertions below are what actually protect against upstream moving:
 * a branch that advances is caught by the pin check, not silently absorbed.
 */
const REF = 'latest';
const BASE = `https://raw.githubusercontent.com/OPCFoundation/UA-Nodeset/${REF}`;

/** Written to the seed as-is. Only `datatype` is taken from the NodeSet. */
const SPECS = [
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
        path: 'MachineTool/Monitoring/Channels/<Channel>/FeedOverride',
        description: 'Operator feed-rate override applied to the programmed feed on this channel, as a percentage. The machine-tool counterpart of Robotics SpeedOverride; a channel is one independent NC program stream, so a machine with two channels reports two of these.' },
      { group: 'Channel', type: 'ChannelMonitoringType', name: 'RapidOverride', unit: 'PERCENT',
        path: 'MachineTool/Monitoring/Channels/<Channel>/RapidOverride',
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
    // OPC Foundation MIT licence WITH resolvable ids. Seeding from 30050 and then labelling the
    // rows `PackML` would assert a source nobody read, so `standard` stays 'OPC UA' and the
    // companion spec says which document.
    //
    // NOTE WHAT IS NOT HERE: the current PackML state. It is `CurrentState` on the inherited
    // StateMachineType, not a member this NodeSet declares, so there is nothing to verify against
    // and no honest row to emit. Its VALUES -- the 17 TR88 states, which OPC 30050 does declare
    // with their canonical StateNumbers -- are a value domain, and belong in `permitted_values`
    // (Phase 3b) rather than in a table of data points.
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
const VOCAB_BEGIN = '-- >>> BEGIN GENERATED opcua_vocabulary_companion_extensions';
const VOCAB_END = '-- <<< END GENERATED opcua_vocabulary_companion_extensions';
const GROUP_BEGIN = '-- >>> BEGIN GENERATED opcua_metric_groups_companion_extensions';
const GROUP_END = '-- <<< END GENERATED opcua_metric_groups_companion_extensions';

const sqlString = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * A deliberately narrow reader for UANodeSet documents, rather than an XML dependency.
 *
 * package.json has no dependencies at all and several scripts go out of their way to keep it that
 * way (check-image-tag-parity.mjs parses YAML by hand for the same reason). These files are
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
  return { nodes, byBrowseName, model, aliases };
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
 * name as a string -- which is what the existing hand-written rows already assume when they type
 * MotionProfile as String. The enumeration's own name is named in the description instead, so the
 * information is not lost.
 *
 * ABSTRACT `Number` BECOMES `Double`. `Number` is not instantiable; a device publishes a concrete
 * type, and Double is the only one that cannot lose range against the alternatives.
 *
 * STRUCTURES ARE REFUSED, which is the rule PackML forced. This function used to map ANY
 * specification-defined DataType to `String` on the assumption it was an enumeration -- true for
 * MachineTool and Additive, and false the moment OPC 30050 arrived with PackMLCountDataType,
 * PackMLProductDataType and three more structures. Flattening a structure to a string would have
 * produced a vocabulary row that looks ordinary and cannot be published: Sparkplug B has no
 * composite type, so a device has to decompose it into separate metrics, and which decomposition
 * is a modelling decision no generator should make silently. A structure therefore stops the
 * build, and the curated list leaves it out.
 */
function resolveDataType(node, doc, where) {
  const declared = node.dataType;
  if (!declared) throw new Error(`${where}: member has no DataType attribute`);
  const raw = doc.aliases.get(declared) ?? declared;
  if (BUILT_IN[raw]) {
    const builtIn = BUILT_IN[raw];
    if (builtIn === 'Number') return 'Double';
    if (builtIn === 'Enumeration') return 'String';
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

/** The ObjectType's own members, by BrowseName. Both HasComponent and HasProperty count. */
function memberOf(objectType, name, doc, where) {
  const found = [];
  for (const ref of objectType.references) {
    if (!ref.forward) continue;
    if (ref.type !== 'HasComponent' && ref.type !== 'HasProperty') continue;
    const target = doc.nodes.get(ref.target);
    if (target && target.tag === 'UAVariable' && target.browseName === name) found.push(target);
  }
  if (found.length === 0) {
    throw new Error(`${where}: ${objectType.browseName} declares no member variable named ${name}`);
  }
  if (found.length > 1) {
    const types = new Set(found.map((f) => f.dataType));
    if (types.size > 1) throw new Error(`${where}: ${name} is declared more than once with different DataTypes`);
  }
  return found[0];
}

const vocabRows = [];
const groupRows = new Map();
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
    const member = memberOf(candidates[0], entry.name, doc, where);
    const datatype = resolveDataType(member, doc, where);
    const semanticId = `${spec.namespaceUri}${entry.name}`;
    const nodeId = `nsu=${spec.namespaceUri};s=${entry.path ?? `${entry.type}/${entry.name}`}`;

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
    if (!spec.groups[entry.group]) throw new Error(`${where}: no description registered for group ${entry.group}`);
    groupRows.set(entry.group, spec.groups[entry.group]);
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
 * uq_metric_groups_name_ci, so a group that already exists -- `Machine`, shared with OPC 40001 --
 * is left exactly as it is rather than being restated with this file's description.
 */
const groupUuid = (name) => {
  const hex = createHash('sha256').update(`factoryplus.metric_group.${name}`).digest('hex');
  return [
    hex.slice(0, 8), hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    ((parseInt(hex.slice(16, 17), 16) & 0x3 | 0x8).toString(16)) + hex.slice(17, 20),
    hex.slice(20, 32)
  ].join('-');
};

const groupStatements = [...groupRows.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, description]) =>
    `INSERT INTO public.metric_groups (id, name, description, standard) VALUES ` +
    `(${sqlString(groupUuid(name))}, ${sqlString(name)}, ${sqlString(description)}, 'OPC UA')\n` +
    `ON CONFLICT DO NOTHING;`);

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

const vocabBody = vocabRows.join('\n');
const vocabDigest = createHash('sha256').update(vocabBody).digest('hex').slice(0, 16);
seed = splice(seed, VOCAB_BEGIN, VOCAB_END,
  `${VOCAB_BEGIN} -- ${vocabRows.length} rows, sha256:${vocabDigest}\n` +
  `-- GENERATED from the OPC Foundation NodeSet2 XML by scripts/generate-opcua-vocabulary.mjs.\n` +
  `-- Do not edit these rows by hand: change ENTRIES in that script and re-run it. Browse names\n` +
  `-- and datatypes are verified against the NodeSet; the selection, prose and units are curated.\n` +
  `-- CI verifies the digest above.`,
  vocabBody);

const groupBody = groupStatements.join('\n');
const groupDigest = createHash('sha256').update(groupBody).digest('hex').slice(0, 16);
seed = splice(seed, GROUP_BEGIN, GROUP_END,
  `${GROUP_BEGIN} -- ${groupStatements.length} rows, sha256:${groupDigest}\n` +
  `-- GENERATED by scripts/generate-opcua-vocabulary.mjs. CI verifies the digest above.`,
  groupBody);

writeFileSync(SEED, seed, 'utf8');

console.log(`wrote ${vocabRows.length} opcua_vocabulary rows and ${groupStatements.length} metric_groups rows`);
console.log(`  opcua_vocabulary  sha256:${vocabDigest}`);
console.log(`  metric_groups     sha256:${groupDigest}`);
for (const line of summary) console.log(`  ${line}`);
