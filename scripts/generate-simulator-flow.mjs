#!/usr/bin/env node
/**
 * Generate the multi-cell shopfloor tab in `node_red_flow.json`.
 *
 * WHY GENERATED. Five devices across four gateways, each with a phase offset, an RBE deadband set
 * and a metric list, is about 1,200 lines of Node-RED JSON in which every id must agree with every
 * `wires` entry. Hand-editing that is how a device ends up wired to the wrong gateway's MQTT node
 * -- which authenticates fine and is then dropped by the broker's ACL, silently. This is the same
 * arrangement `generate-opcua-vocabulary.mjs` has with its migration: the generator is the source
 * of truth, the JSON is committed, and the JSON is what runs.
 *
 * ONE TAB. The introductory single-device "Gateway Simulator" tab has been folded in: two tabs
 * both publishing simulated Sparkplug meant two places to look and two conventions for what a
 * simulated asset is called. Every simulated gateway and device is now prefixed `Sim_`, which is
 * what makes them distinguishable from real plant in the same tables.
 *
 * FOUR NODES FROM THAT TAB SURVIVE, because they are not simulation: the `POST /hooks/quarantine`
 * receiver (three nodes) that migration 0006 posts to and `validate.py` check 7 asserts, and the
 * NCMD listener that makes a rebirth request visible. They are relocated, not re-authored -- see
 * RELOCATE at the bottom of this file.
 *
 * Usage:
 *   node scripts/generate-simulator-flow.mjs           # rewrite node_red_flow.json
 *   node scripts/generate-simulator-flow.mjs --check   # fail if it is out of date (CI)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const FLOW_PATH = path.join(rootDir, 'node_red_flow.json');

const checkOnly = process.argv.includes('--check');

const TAB_ID = 'tab-shopfloor';
const GROUP_ID_PREFIX = 'grp-';

// The introductory single-device tab this consolidation replaces, and its broker node. Both are
// dropped from the merged flow; four non-simulation nodes are lifted off it first -- see RELOCATE.
const LEGACY_TAB_ID = 'tab-gateway-sim';
const LEGACY_BROKER_ID = 'mqtt-broker-config';

/** Sparkplug group. Matches `gateways.sparkplug_group`'s default (migration 0015). */
const SPARKPLUG_GROUP = 'ACS-Cymru';

/**
 * The floor.
 *
 * `sparkplugId` values are the GENERATED ids `provision-gateways.mjs` created from its pinned
 * UUIDs -- read back from the database, not derived here. They are literals in this file because
 * the flow is a static artefact; the guard against them drifting is that provisioning pins the
 * UUIDs they come from.
 *
 * `credentialsEnv` names the variable pair node-red-init resolves for that gateway's broker node,
 * and matches what provision-gateways.mjs emits.
 */
const GATEWAYS = [
  {
    key: 'cnc',
    name: 'Sim_Gateway_Cell1_Machining',
    sparkplugId: 'gwy120000000000400080000',
    credentialsEnv: 'MQTT_GW_CNC_MACHINING',
    cell: 'Cell 1 — Precision Machining',
    devices: [
      { key: 'mill01', name: 'Sim_CNC_Mill_01', sparkplugId: 'dev220000000000400080000', kind: 'cnc' },
      { key: 'mill02', name: 'Sim_CNC_Mill_02', sparkplugId: 'dev230000000000400080000', kind: 'cnc' },
      { key: 'tool01', name: 'Sim_Tool_Changer_01', sparkplugId: 'dev270000000000400080000', kind: 'toolchanger' },
    ],
  },
  {
    key: 'robot',
    name: 'Sim_Gateway_Cell2_Robotics',
    sparkplugId: 'gwy130000000000400080000',
    credentialsEnv: 'MQTT_GW_ROBOTIC_ASSEMBLY',
    cell: 'Cell 2 — Robotic Assembly',
    devices: [
      { key: 'arm01', name: 'Sim_Robot_Arm_01', sparkplugId: 'dev240000000000400080000', kind: 'robot' },
    ],
  },
  {
    // The KPI aggregator gets its own gateway and cell, which is a modelling choice rather than a
    // cosmetic one: ISO 22400 KPIs are computed, not measured, so they do not belong on the same
    // edge node as the instruments. Keeping them separate makes "this number was derived" visible
    // on the shopfloor map instead of implied.
    key: 'oee',
    name: 'Sim_Gateway_Cell3_OEE',
    sparkplugId: 'gwy140000000000400080000',
    credentialsEnv: 'MQTT_GW_AGV_FLEET',
    cell: 'Cell 3 — Production KPIs',
    devices: [
      {
        key: 'agg01', name: 'Sim_Cell3_Aggregator', sparkplugId: 'dev250000000000400080000',
        kind: 'oee',
        // The machine whose state time it accumulates.
        sourceSparkplugId: 'dev220000000000400080000',
      },
    ],
  },
  {
    key: 'bms',
    name: 'Sim_Gateway_Site_BMS',
    sparkplugId: 'gwy150000000000400080000',
    credentialsEnv: 'MQTT_GW_FACILITY_BMS',
    cell: 'Site-Wide',
    devices: [
      { key: 'zone01', name: 'Sim_BMS_Zone_HVAC', sparkplugId: 'dev260000000000400080000', kind: 'bms' },
    ],
  },
];

// =================================================================================================
// The simulation body, shared by every device subflow.
//
// EVERY METRIC NAME BELOW IS IN `metric_catalog`. That is not a style preference: ingestion never
// writes the catalog (it has no reference to that table at all), so a name published here that is
// not registered there creates a telemetry series with NO standard and NO semantic id -- which then
// exports into an AAS shell with no semanticId and shows as unmodelled against the device schema.
// Migrations 0018 and 0019 are what put them there. Publish `BMS/ZoneAirTemperature` instead of
// `BMS/ZONE_TEMPERATURE` and the series is orphaned, permanently and silently.
// =================================================================================================

const SIMULATE = `
// ---------------------------------------------------------------------------------------------
// Sparkplug B device simulation with report-by-exception.
//
// THE RBE CACHE LIVES IN NODE CONTEXT, WHICH IS PER SUBFLOW INSTANCE. flow.* and global.* are
// shared across every instance on the tab, so a cache kept there would have all five devices
// reading and writing one another's last-published values: four of them would publish nothing and
// the fifth would publish nonsense. It would look like a broker fault.
//
// The sandbox name is \`context\`, NOT \`node.context()\` -- the latter is the runtime API and is
// not exposed to a function node, where it throws "node.context is not a function".
// ---------------------------------------------------------------------------------------------
const DEVICE_ID   = env.get('DEVICE_ID');
const DEVICE_NAME = env.get('DEVICE_NAME');
const GATEWAY_ID  = env.get('GATEWAY_ID');
const KIND        = env.get('KIND');
const GROUP       = env.get('SPARKPLUG_GROUP') || 'ACS-Cymru';

const BIRTH_EVERY_SCANS = Number(env.get('BIRTH_EVERY_SCANS') || 180);   // 15 min at a 5s scan
const MAX_SILENCE_MS    = 5 * 60 * 1000;

const cache   = context.get('rbe')   || {};
const lastPub = context.get('lastAt') || {};
let   scan    = Number(context.get('scan') || 0);
let   seq     = Number(context.get('seq')  || 0);

scan += 1;

// Fault flags are GLOBAL on purpose -- they are set by inject nodes outside the subflow and are a
// property of the scenario, not of one device. Only the targeted device reads its own.
const thermalFault = global.get('fault_thermal') === true;
const estopFault   = global.get('fault_estop') === true;

const t = Date.now();
const wave = (periodMs, phase) => Math.sin((t / periodMs) * 2 * Math.PI + (phase || 0));
const noise = (amp) => (Math.random() - 0.5) * 2 * amp;

// ---------------------------------------------------------------------------------------------
// Per-class metric sets. Deadbands sit ABOVE the simulated noise floor -- a deadband smaller than
// the noise is tripped by the noise alone and suppresses nothing, which is report-by-exception in
// name only.
// ---------------------------------------------------------------------------------------------
let metrics = [];

if (KIND === 'cnc') {
  const running = !estopFault && wave(90000) > -0.6;
  const temp = thermalFault && DEVICE_NAME === 'Sim_CNC_Mill_01'
    ? 95 + noise(0.4)
    : 42 + wave(120000) * 3 + noise(0.15);

  // THE MACHINE DECLARES ITS OWN THERMAL LIMIT, and the Grafana alert rule reads it rather than
  // comparing against a constant. max_temp_threshold has been in metric_catalog since 0002
  // ('Configured maximum temperature threshold -- local extension') and nothing had ever published
  // or read it, which is how the dashboard ended up with a hardcoded 80.0 for every machine on the
  // floor regardless of what it was rated for.
  //
  // THE TWO MILLS DIFFER, AND NEITHER VALUE IS THE FALLBACK. 90 and 75 rather than 85, so the join
  // is provably in use: if the rule were silently comparing against COALESCE's default both mills
  // would behave identically. The thermal fault drives Mill_01 to ~95, which breaches 90; Mill_02
  // runs at ~42 and never approaches 75. The devices that publish no limit at all -- the robot, the
  // tool changer, the BMS zone -- are what exercise the fallback arm.
  //
  // CONFIGURATION, NOT MEASUREMENT, so the deadband is effectively infinite -- it moves only when
  // somebody reconfigures the machine -- but it carries its OWN SHORT KEEPALIVE, and that pairing is
  // the point.
  //
  // On the default 5-minute keepalive this metric does not reach the historian until five minutes
  // after a birth, and telemetry_latest is where the alert rule joins it from. So for the first five
  // minutes of every stack life the rule found nothing and fell back to the fleet default: a machine
  // rated to 75 was judged against 85, silently, in exactly the window after a restart when someone
  // is most likely to be watching. Measured on a clean boot -- asset_config had 90 and 75 while
  // telemetry_latest had neither.
  //
  // 45s costs two rows a minute across both mills, against position metrics publishing on a 0.5 mm
  // deadband several times a scan. A threshold the alerting cannot see is worth more than that.
  const tempLimit = DEVICE_NAME === 'Sim_CNC_Mill_02' ? 75 : 90;

  metrics = [
    { name: 'Axes/X/POSITION',        type: 'double', value: 150 + wave(30000) * 120 + noise(0.02), band: 0.5 },
    { name: 'Axes/Y/POSITION',        type: 'double', value: 100 + wave(41000, 1.1) * 80 + noise(0.02), band: 0.5 },
    { name: 'Systems/TEMPERATURE',    type: 'double', value: temp, band: 0.5 },
    { name: 'Controller/EXECUTION',   type: 'string', value: estopFault ? 'INTERRUPTED' : (running ? 'ACTIVE' : 'READY') },
    { name: 'Controller/EMERGENCY_STOP', type: 'string', value: estopFault ? 'TRIGGERED' : 'ARMED' },
    { name: 'max_temp_threshold',     type: 'double', value: tempLimit, band: 1000, keepalive: 45000 },
  ];

  // Published for the OEE aggregator, which is a different device and cannot read this instance's
  // context. A global keyed by device id is the narrowest thing that crosses that boundary.
  global.set('state_' + DEVICE_ID, metrics.find(m => m.name === 'Controller/EXECUTION').value);
}

if (KIND === 'robot') {
  const stopped = estopFault;
  metrics = [
    { name: 'MotionDevice/ActualPosition', type: 'double', value: 400 + wave(25000) * 350 + noise(0.02), band: 1.0 },
    { name: 'MotionDevice/ActualSpeed',    type: 'double', value: stopped ? 0 : 180 + wave(25000, 1.6) * 150, band: 5.0 },
    { name: 'MotionDevice/EmergencyStop',  type: 'boolean', value: stopped },
    { name: 'Machine/OperationalMode',     type: 'string', value: stopped ? 'STOPPED' : 'AUTOMATIC' },
    // Compressed air, not electricity. OPC 40001-4 as seeded models energy MEDIA -- pressure,
    // volume, flow -- and carries no active-power concept, so this is the energy metric that has
    // a published semantic id behind it. See the note in scripts/generate-simulator-flow.mjs.
    { name: 'Energy/VolumeFlowRate',       type: 'double', value: stopped ? 0.4 : 12 + wave(60000) * 3 + noise(0.05), band: 0.25 },
  ];
}

if (KIND === 'toolchanger') {
  // An automatic tool changer serving the machining cell. MTConnect names throughout, because it
  // is a machine-tool component and that is the vocabulary the cell already speaks.
  //
  // PART_COUNT IS MONOTONIC, which makes it the one metric here a deadband must not smooth: a
  // counter that only publishes every Nth increment is a counter nobody can difference. Its band
  // is 1, i.e. every change.
  const changes = context.get('toolChanges') || 0;
  const cycling = !estopFault && wave(75000) > 0.2;
  if (cycling) context.set('toolChanges', changes + 1);

  metrics = [
    { name: 'Controller/PART_COUNT',      type: 'double', value: changes, band: 1 },
    { name: 'Controller/CONTROLLER_MODE', type: 'string', value: estopFault ? 'MANUAL' : 'AUTOMATIC' },
    { name: 'Systems/AVAILABILITY',       type: 'string', value: estopFault ? 'UNAVAILABLE' : 'AVAILABLE' },
    { name: 'Axes/S/LOAD',                type: 'double', value: cycling ? 34 + wave(20000) * 12 + noise(0.2) : 2 + noise(0.2), band: 2.0 },
  ];
}

if (KIND === 'bms') {
  metrics = [
    { name: 'BMS/ZONE_TEMPERATURE',   type: 'double', value: 21.5 + wave(600000) * 1.5 + noise(0.1), band: 0.3 },
    { name: 'BMS/ZONE_HUMIDITY',      type: 'double', value: 45 + wave(900000, 0.8) * 6 + noise(0.2), band: 1.0 },
    { name: 'BMS/SUPPLY_AIR_FLOW',    type: 'double', value: 320 + wave(300000) * 40 + noise(0.5), band: 5.0 },
    { name: 'BMS/CO2_CONCENTRATION',  type: 'double', value: 620 + wave(1200000) * 120 + noise(2), band: 15 },
  ];
}

const valueField = (m) => {
  if (m.type === 'double') return { datatype: 10, double_value: Number(m.value.toFixed(3)) };
  if (m.type === 'boolean') return { datatype: 11, boolean_value: Boolean(m.value) };
  return { datatype: 12, string_value: String(m.value) };
};

// ---------------------------------------------------------------------------------------------
// DBIRTH -- the birth certificate, carrying LIVE readings rather than nominal placeholders, so the
// cache it seeds is the real baseline and the first DDATA has nothing to correct.
//
// EVERY 15 MINUTES, not every 60 seconds. A rebirth is a metadata write on the ingestion side, and
// nothing here needs one more often: this flow publishes metric NAMES, not aliases, so the daemon
// never needs a rebirth to decode it.
// ---------------------------------------------------------------------------------------------
if (scan === 1 || scan % BIRTH_EVERY_SCANS === 0) {
  const birth = {
    timestamp: t,
    seq: seq,
    metrics: [
      { name: 'Asset_ID',   datatype: 12, string_value: DEVICE_ID },
      { name: 'Asset_Name', datatype: 12, string_value: DEVICE_NAME },
      ...metrics.map(m => Object.assign({ name: m.name }, valueField(m))),
    ],
  };
  seq = (seq + 1) % 256;
  for (const m of metrics) { cache[m.name] = m.value; lastPub[m.name] = t; }

  context.set('rbe', cache);
  context.set('lastAt', lastPub);
  context.set('scan', scan);
  context.set('seq', seq);

  node.status({ fill: 'blue', shape: 'dot', text: 'DBIRTH ' + new Date(t).toLocaleTimeString() });
  return { topic: 'spBv1.0/' + GROUP + '/DBIRTH/' + GATEWAY_ID + '/' + DEVICE_ID, payload: birth };
}

// ---------------------------------------------------------------------------------------------
// DDATA -- only what moved. A fixed-interval payload carrying every metric whether it changed or
// not is not DDATA; it is polling with extra steps, and it writes a row per metric per tick into
// the historian for readings nobody took.
//
// MAX_SILENCE_MS is the keepalive and is not a betrayal of RBE -- it is what makes RBE safe to
// consume. A genuinely constant value is indistinguishable from a dead device, and every staleness
// check downstream reads absence as failure.
// ---------------------------------------------------------------------------------------------
const changed = [];
for (const m of metrics) {
  const previous = cache[m.name];
  const silentFor = t - (lastPub[m.name] || 0);
  let publish = false;

  if (previous === undefined) publish = true;
  else if (m.type === 'double') publish = Math.abs(m.value - previous) >= m.band;
  else publish = m.value !== previous;

  // PER-METRIC KEEPALIVE, defaulting to the global one. A measurement wants a long keepalive -- it
  // is only there to distinguish "unchanged" from "dead". A CONFIGURATION metric is different: it is
  // read as a join key by things that cannot wait for it, so it declares a shorter one.
  if (!publish && silentFor >= (m.keepalive || MAX_SILENCE_MS)) publish = true;

  if (publish) {
    changed.push(Object.assign({ name: m.name }, valueField(m)));
    cache[m.name] = m.value;
    lastPub[m.name] = t;
  }
}

context.set('rbe', cache);
context.set('lastAt', lastPub);
context.set('scan', scan);

if (changed.length === 0) {
  node.status({ fill: 'grey', shape: 'ring', text: 'no change' });
  return null;
}

const payload = { timestamp: t, seq: seq, metrics: changed };
seq = (seq + 1) % 256;
context.set('seq', seq);

node.status({ fill: 'green', shape: 'dot', text: changed.length + ' metric(s) @ ' + new Date(t).toLocaleTimeString() });
return { topic: 'spBv1.0/' + GROUP + '/DDATA/' + GATEWAY_ID + '/' + DEVICE_ID, payload: payload };
`.trim();

// =================================================================================================
// OEE aggregator -- ISO 22400 by ARITHMETIC OVER STATE TIME, not by inference.
// =================================================================================================
const OEE_BODY = `
// ---------------------------------------------------------------------------------------------
// ISO 22400 KPIs, accumulated at the edge.
//
// WHY THIS IS HERE AND NOT IN THE PLATFORM. Computing OEE needs planned busy time, planned run
// time per item and good/scrap disposition. None of those are telemetry, and storing them is what
// would turn the platform into an MES -- docs/vocabularies.md settles that. What CAN be done
// honestly is what this node does: accumulate time-in-state from the machine's own execution
// metric, which makes availability arithmetic rather than inference, and take the other two
// factors from the edge's own counters.
//
// PUBLISHED ON A FIXED 60s HEARTBEAT, NOT REPORT-BY-EXCEPTION. These are computed values, so a
// steady cadence is honest -- and it means the series has no RBE gaps for a BI tool to have to
// read through telemetry_gapfill().
//
// The names are the REGISTERED ones: OEE/AVAILABILITY, OEE/PERFORMANCE, OEE/QUALITY, OEE/OEE.
// Not OEE/Availability or OEE/Overall -- metric_catalog.name is unique and immutable, and a second
// spelling would be a second permanent series for the same concept.
//
// IT BIRTHS BEFORE IT REPORTS, and that is a FIX rather than a refinement. This node used to emit
// DDATA and nothing else -- no DBIRTH, ever. Sparkplug's whole contract is that a device announces
// its metric set before it sends values, and the ingestion daemon keys three things off that
// announcement: the device's ONLINE status, its asset_config birth parameters, and the declared
// metric set that unmodelled detection compares against. With no birth, this device sat OFFLINE on
// the shopfloor map forever while its telemetry landed in the historian -- reporting values from a
// machine the platform believed was not running, which is the one inconsistency an operator cannot
// explain and cannot act on.
// ---------------------------------------------------------------------------------------------
const DEVICE_ID    = env.get('DEVICE_ID');
const DEVICE_NAME  = env.get('DEVICE_NAME');
const GATEWAY_ID   = env.get('GATEWAY_ID');
const SOURCE_ID    = env.get('SOURCE_DEVICE_ID');
const GROUP        = env.get('SPARKPLUG_GROUP') || 'ACS-Cymru';
const BIRTH_EVERY  = Number(env.get('BIRTH_EVERY_SCANS') || 15);

const acc = context.get('acc') || { productive: 0, total: 0, good: 0, made: 0 };
let seq = Number(context.get('seq') || 0);
const scan = Number(context.get('scan') || 0) + 1;

const state = global.get('state_' + SOURCE_ID) || 'READY';
const INTERVAL_S = 60;

// NOT ON THE FIRST TICK. The inject fires 0.1s after start and every 60s after that, so crediting
// a full interval to the first one would book 60 seconds of observation that had not happened --
// and since availability is productive/total, that lands as a denominator this node can never
// work off. Time is accumulated for the interval that has ELAPSED, which is none of it yet.
if (scan > 1) acc.total += INTERVAL_S;
if (scan > 1 && state === 'ACTIVE') {
  acc.productive += INTERVAL_S;
  // Parts are only made while running. Scrap rises sharply when the machine is in trouble, which
  // is what makes the quality factor move during the thermal excursion rather than staying flat.
  const overheating = global.get('fault_thermal') === true;
  const made = 4;
  acc.made += made;
  acc.good += overheating ? Math.round(made * 0.72) : made - (Math.random() < 0.08 ? 1 : 0);
}

// A -- availability: productive time over the time this aggregator has been watching.
const availability = acc.total > 0 ? (acc.productive / acc.total) * 100 : 0;

// P -- performance: actual against ideal output for the productive time. The ideal rate is a
// fixed nominal for this machine, which is the edge's to know; the platform is deliberately not
// told it.
const IDEAL_PARTS_PER_MIN = 4;
const idealParts = (acc.productive / 60) * IDEAL_PARTS_PER_MIN;
const performance = idealParts > 0 ? Math.min(100, (acc.made / idealParts) * 100) : 0;

// Q -- quality: good against made.
const quality = acc.made > 0 ? (acc.good / acc.made) * 100 : 100;

const oee = (availability / 100) * (performance / 100) * (quality / 100) * 100;

context.set('acc', acc);
context.set('scan', scan);

const round = (v) => Number(v.toFixed(2));
const factors = [
  { name: 'OEE/AVAILABILITY', datatype: 10, double_value: round(availability) },
  { name: 'OEE/PERFORMANCE',  datatype: 10, double_value: round(performance) },
  { name: 'OEE/QUALITY',      datatype: 10, double_value: round(quality) },
  { name: 'OEE/OEE',          datatype: 10, double_value: round(oee) },
];

// ---------------------------------------------------------------------------------------------
// DBIRTH on the first tick, and every BIRTH_EVERY ticks after it.
//
// Asset_ID and Asset_Name ride along exactly as they do on the instrument subflows: the daemon
// resolves the device by the topic's id and uses Asset_ID to detect a device publishing under an
// identity that is not its own, which is what quarantines an IDENTITY_MISMATCH rather than
// silently accepting it.
//
// NO SEPARATE DDATA ON A BIRTH TICK. The birth carries current values for every metric, so
// following it with a DDATA repeating them would write each series twice at the same timestamp.
// ---------------------------------------------------------------------------------------------
if (scan === 1 || scan % BIRTH_EVERY === 0) {
  const birth = {
    timestamp: Date.now(),
    seq: seq,
    metrics: [
      { name: 'Asset_ID',   datatype: 12, string_value: DEVICE_ID },
      { name: 'Asset_Name', datatype: 12, string_value: DEVICE_NAME },
      ...factors,
    ],
  };
  seq = (seq + 1) % 256;
  context.set('seq', seq);

  node.status({ fill: 'blue', shape: 'dot', text: 'DBIRTH ' + new Date().toLocaleTimeString() });
  return { topic: 'spBv1.0/' + GROUP + '/DBIRTH/' + GATEWAY_ID + '/' + DEVICE_ID, payload: birth };
}

const payload = { timestamp: Date.now(), seq: seq, metrics: factors };
seq = (seq + 1) % 256;
context.set('seq', seq);

node.status({ fill: 'blue', shape: 'dot', text: 'OEE ' + round(oee) + '% (' + state + ')' });
return { topic: 'spBv1.0/' + GROUP + '/DDATA/' + GATEWAY_ID + '/' + DEVICE_ID, payload: payload };
`.trim();

const gatewayHeartbeatBody = (gw) => `
// NBIRTH once, then NDATA every 30s. The gateway's own birth certificate and heartbeat --
// \`gateways.last_heartbeat\` is stamped from it, and public.gateway_status derives staleness from
// that column at read time, so a gateway that stops beating shows STALE rather than going quiet.
//
// THE IDS ARE LITERALS, NOT env.get(). \`env\` inside a function node resolves against the flow,
// group and subflow environment -- an \`env\` array on a plain function node on a tab is not a
// documented input and did not resolve here, which surfaced as the ids being undefined and the
// topic reading "spBv1.0/ACS-Cymru/NBIRTH/undefined". A generated file has no reason to be
// indirect about a constant.
const GATEWAY_ID = ${JSON.stringify(gw.sparkplugId)};
const GATEWAY_NAME = ${JSON.stringify(gw.name)};
const GROUP = ${JSON.stringify(SPARKPLUG_GROUP)};

let born = context.get('born') || false;
let seq = Number(context.get('seq') || 0);
const type = born ? 'NDATA' : 'NBIRTH';

const payload = {
  timestamp: Date.now(),
  seq: seq,
  metrics: [{ name: 'Gateway_Status', datatype: 12, string_value: 'ONLINE' }],
};

seq = (seq + 1) % 256;
context.set('seq', seq);
context.set('born', true);
node.status({ fill: 'green', shape: 'dot', text: type + ' ' + GATEWAY_NAME });

return { topic: 'spBv1.0/' + GROUP + '/' + type + '/' + GATEWAY_ID, payload: payload };
`.trim();

// =================================================================================================
// Node construction
// =================================================================================================
const nodes = [];
const push = (n) => { nodes.push(n); return n; };

push({
  id: TAB_ID,
  type: 'tab',
  label: 'Simulated Shopfloor',
  disabled: false,
  info: [
    '# Simulated Shopfloor',
    '',
    'Five devices across four cell gateways, each publishing a different companion standard over',
    'Sparkplug B.',
    '',
    '| Cell | Device | Standard |',
    '| --- | --- | --- |',
    '| Cell 1 — Precision Machining | Sim_CNC_Mill_01, Sim_CNC_Mill_02 | MTConnect 2.x |',
    '| Cell 1 — Precision Machining | Sim_Tool_Changer_01 | MTConnect 2.x |',
    '| Cell 2 — Robotic Assembly | Sim_Robot_Arm_01 | OPC 40010 Robotics + 40001-4 Energy |',
    '| Cell 3 — Production KPIs | Sim_Cell3_Aggregator | ISO 22400 (60s heartbeat) |',
    '| Site-Wide | Sim_BMS_Zone_HVAC | ASHRAE 223P |',
    '',
    '**One MQTT connection per gateway.** `mosquitto.acl` pins the topic\'s edge-node segment to the',
    'connecting username, so devices cannot share a broker node across cells.',
    '',
    '**Every metric name is registered in `metric_catalog`** (migrations 0018, 0019) with its',
    'standard and published semantic id. Publishing an unregistered name creates an orphaned series.',
    '',
    'Generated by `scripts/generate-simulator-flow.mjs` -- edit that, not this tab.',
  ].join('\n'),
  env: [],
});

// --- broker config nodes, one per gateway -------------------------------------------------------
for (const gw of GATEWAYS) {
  push({
    id: `mqtt-broker-${gw.key}`,
    type: 'mqtt-broker',
    name: `${gw.name} (${gw.sparkplugId})`,
    broker: 'mosquitto',
    port: '1883',
    // A DISTINCT CLIENT ID PER GATEWAY. MQTT requires client ids to be unique on a broker: two
    // connections sharing one take turns evicting each other, which presents as both gateways
    // flapping between ONLINE and STALE rather than as a configuration error.
    clientid: `node-red-${gw.key}`,
    autoConnect: true,
    usetls: false,
    // MQTT 5. Node-RED's encoding: '4' is 3.1.1, '5' is v5.
    //
    // NO FUNCTIONAL BENEFIT ON THIS SIDE, and that is recorded rather than glossed. Three were
    // proposed and all three were tested and refused: PUBACK reason codes need QoS >= 1 and
    // Sparkplug mandates QoS 0; the broker's DISCONNECT reason code IS sent under v5 and mqtt.js
    // receives it, but Node-RED's broker node registers only connect/close/error and drops it; and
    // `$share` is honoured by Mosquitto 2.0.22 for 3.1.1 clients anyway. This is on the current
    // protocol version because that is where protocol work happens, not because it does anything
    // today.
    //
    // NO SESSION EXPIRY AND NO WILL DELAY, and this is the one v5 feature that must stay unset:
    // NDEATH *is* the Last Will, process_node_message() marks the edge node OFFLINE on it, and a
    // will delay would leave dead gateways reading ONLINE with every device beneath them
    // apparently live.
    protocolVersion: '5',
    keepalive: '60',
    cleansession: true,
    // Read by scripts/node-red-init.mjs to pick this node's credential pair out of the
    // environment. Declared rather than derived from the id: a naming convention that broke would
    // move this node onto a different account, or none, and report only "Connection failed".
    acsCredentialsEnv: gw.credentialsEnv,
  });
}

// --- subflow definitions -------------------------------------------------------------------------
const DEVICE_SUBFLOWS = [
  { id: 'sf-cnc',   name: 'CNC_Machining_Subflow',  colour: '#3FADB5', body: SIMULATE },
  { id: 'sf-robot', name: 'Robotics_Subflow',       colour: '#87A980', body: SIMULATE },
  { id: 'sf-toolchanger', name: 'Tool_Changer_Subflow', colour: '#DEBD5C', body: SIMULATE },
  { id: 'sf-bms',   name: 'BMS_Facility_Subflow',   colour: '#E2D96E', body: SIMULATE },
  { id: 'sf-oee',   name: 'OEE_Aggregator_Subflow', colour: '#C0DEED', body: OEE_BODY },
];

for (const sf of DEVICE_SUBFLOWS) {
  const fnId = `${sf.id}-fn`;
  push({
    id: sf.id,
    type: 'subflow',
    name: sf.name,
    info: `${sf.name} -- generated by scripts/generate-simulator-flow.mjs`,
    category: 'ACS-Cymru',
    in: [{ x: 60, y: 60, wires: [{ id: fnId }] }],
    out: [{ x: 420, y: 60, wires: [{ id: fnId, port: 0 }] }],
    env: [
      { name: 'DEVICE_ID', type: 'str', value: '' },
      { name: 'DEVICE_NAME', type: 'str', value: '' },
      { name: 'GATEWAY_ID', type: 'str', value: '' },
      { name: 'KIND', type: 'str', value: '' },
      { name: 'SPARKPLUG_GROUP', type: 'str', value: SPARKPLUG_GROUP },
      // The subflow's own declaration -- the default an instance inherits when it overrides
      // nothing. Both kinds take BIRTH_EVERY_SCANS; the counts differ because the tick rates do
      // (5s vs 60s), and both work out to a rebirth every 15 minutes.
      ...(sf.id === 'sf-oee'
        ? [
            { name: 'SOURCE_DEVICE_ID', type: 'str', value: '' },
            { name: 'BIRTH_EVERY_SCANS', type: 'num', value: '15' },
          ]
        : [{ name: 'BIRTH_EVERY_SCANS', type: 'num', value: '180' }]),
    ],
    color: sf.colour,
  });

  push({
    id: fnId,
    type: 'function',
    z: sf.id,
    name: 'Simulate & encode',
    func: sf.body,
    outputs: 1,
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [],
    x: 240,
    y: 60,
    wires: [[]],
  });
}

// --- per-gateway heartbeat + per-device instances -----------------------------------------------
let y = 80;
let deviceIndex = 0;

for (const gw of GATEWAYS) {
  const groupNodes = [];
  const gwY = y;

  // One MQTT out node per gateway. Every device in the cell publishes through it, which is what
  // makes the canvas show the ACL boundary rather than hiding it.
  const outId = `mqtt-out-${gw.key}`;
  push({
    id: outId,
    type: 'mqtt out',
    z: TAB_ID,
    name: `Publish via ${gw.name}`,
    topic: '',
    qos: '0',
    retain: 'false',
    respTopic: '',
    contentType: '',
    userProps: '',
    correl: '',
    expiry: '',
    broker: `mqtt-broker-${gw.key}`,
    x: 900,
    y: gwY,
    wires: [],
  });
  groupNodes.push(outId);

  // Gateway heartbeat: NBIRTH then NDATA every 30s.
  const hbInject = `inject-hb-${gw.key}`;
  const hbFn = `fn-hb-${gw.key}`;
  push({
    id: hbInject,
    type: 'inject',
    z: TAB_ID,
    name: `${gw.name} heartbeat (30s)`,
    props: [{ p: 'payload' }],
    repeat: '30',
    crontab: '',
    once: true,
    onceDelay: '1',
    topic: '',
    payload: '',
    payloadType: 'date',
    x: 220,
    y: gwY,
    wires: [[hbFn]],
  });
  push({
    id: hbFn,
    type: 'function',
    z: TAB_ID,
    name: 'NBIRTH / NDATA',
    func: gatewayHeartbeatBody(gw),
    outputs: 1,
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [],
    x: 560,
    y: gwY,
    wires: [[outId]],
  });
  groupNodes.push(hbInject, hbFn);

  y += 60;

  for (const dev of gw.devices) {
    const isOee = dev.kind === 'oee';
    // The KPI aggregator runs on a FIXED 60-SECOND HEARTBEAT, not the 5-second RBE scan. These are
    // computed values, so a steady cadence is honest -- and it leaves the series free of the
    // report-by-exception gaps a BI tool would otherwise have to read through telemetry_gapfill().
    const phaseMs = isOee ? 0 : deviceIndex * 350;
    const injectId = `inject-${dev.key}`;
    const instId = `inst-${dev.key}`;
    const kindSubflow = {
      cnc: 'sf-cnc', robot: 'sf-robot', toolchanger: 'sf-toolchanger',
      bms: 'sf-bms', oee: 'sf-oee',
    }[dev.kind];
    if (!kindSubflow) throw new Error(`no subflow for device kind '${dev.kind}' (${dev.name})`);

    // PHASE STAGGER. `onceDelay` starts this device's 5-second cycle `index * 350ms` after the
    // previous one, so five devices do not evaluate and publish on the same tick. Done with the
    // inject node's own start delay rather than a timer inside the function, because a timer in a
    // function node survives a deploy and quietly doubles up.
    push({
      id: injectId,
      type: 'inject',
      z: TAB_ID,
      name: isOee ? `${dev.name} KPI heartbeat (60s)` : `${dev.name} scan (5s, +${phaseMs}ms)`,
      props: [{ p: 'payload' }],
      repeat: isOee ? '60' : '5',
      crontab: '',
      once: true,
      // THE AGGREGATOR FIRES ALMOST IMMEDIATELY (0.1s), the instruments stagger by 350ms each.
      //
      // It used to wait 10 seconds, which combined with the missing DBIRTH to make this device the
      // slowest thing on the floor to appear and then never appear at all. Its first tick is now
      // its birth certificate, and there is nothing to wait for: the KPI accumulator starts empty
      // whenever it starts, and delaying only delays the moment the device is registered.
      onceDelay: isOee ? '0.1' : String((phaseMs / 1000).toFixed(2)),
      topic: '',
      payload: '',
      payloadType: 'date',
      x: 220,
      y,
      wires: [[instId]],
    });

    push({
      id: instId,
      type: `subflow:${kindSubflow}`,
      z: TAB_ID,
      name: dev.name,
      env: [
        { name: 'DEVICE_ID', value: dev.sparkplugId, type: 'str' },
        { name: 'DEVICE_NAME', value: dev.name, type: 'str' },
        { name: 'GATEWAY_ID', value: gw.sparkplugId, type: 'str' },
        { name: 'KIND', value: dev.kind, type: 'str' },
        { name: 'SPARKPLUG_GROUP', value: SPARKPLUG_GROUP, type: 'str' },
        // BIRTH_EVERY_SCANS on both, but counted in that subflow's OWN ticks: the instruments
        // scan every 5s so 180 is a rebirth every 15 minutes, and the aggregator ticks every 60s
        // so 15 is the same 15 minutes. A shared number would have meant three hours for one of
        // them.
        ...(isOee
          ? [
              { name: 'SOURCE_DEVICE_ID', value: dev.sourceSparkplugId, type: 'str' },
              { name: 'BIRTH_EVERY_SCANS', value: '15', type: 'num' },
            ]
          : [{ name: 'BIRTH_EVERY_SCANS', value: '180', type: 'num' }]),
      ],
      x: 560,
      y,
      wires: [[outId]],
    });

    groupNodes.push(injectId, instId);
    y += 60;
    if (!isOee) deviceIndex += 1;

  }

  push({
    id: `${GROUP_ID_PREFIX}${gw.key}`,
    type: 'group',
    z: TAB_ID,
    name: `${gw.cell} -- ${gw.name}`,
    style: { label: true, 'label-position': 'nw', color: '#3b3b3b' },
    nodes: groupNodes,
    x: 180,
    y: gwY - 30,
    w: 800,
    h: y - gwY + 40,
  });

  y += 40;
}

// --- fault injection ------------------------------------------------------------------------------
const faults = [
  {
    id: 'inject-fault-thermal',
    name: '🔥 Thermal Fault',
    body: "global.set('fault_thermal', true); node.warn('THERMAL EXCURSION injected on Sim_CNC_Mill_01 -- Systems/TEMPERATURE will read ~95 degC and OEE quality will fall.'); return null;",
  },
  {
    id: 'inject-fault-estop',
    name: '🛑 E-Stop',
    body: "global.set('fault_estop', true); node.warn('EMERGENCY STOP injected -- Sim_Robot_Arm_01 goes STOPPED, CNC controllers report INTERRUPTED/TRIGGERED.'); return null;",
  },
  {
    id: 'inject-fault-reset',
    name: '✅ Reset',
    body: "global.set('fault_thermal', false); global.set('fault_estop', false); node.warn('Faults cleared -- devices return to nominal on their next scan.'); return null;",
  },
];

let faultY = y + 20;
for (const f of faults) {
  push({
    id: f.id,
    type: 'inject',
    z: TAB_ID,
    name: f.name,
    props: [{ p: 'payload' }],
    repeat: '',
    crontab: '',
    once: false,
    onceDelay: 0.1,
    topic: '',
    payload: '',
    payloadType: 'date',
    x: 220,
    y: faultY,
    wires: [[`${f.id}-fn`]],
  });
  push({
    id: `${f.id}-fn`,
    type: 'function',
    z: TAB_ID,
    name: 'Set scenario flag',
    func: f.body,
    outputs: 0,
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [],
    x: 560,
    y: faultY,
    wires: [],
  });
  faultY += 50;
}

push({
  id: 'comment-faults',
  type: 'comment',
  z: TAB_ID,
  name: 'FAULT INJECTION -- click the button on the left of a node to fire it',
  info: [
    'These set a GLOBAL flag that every device subflow reads on its next scan. They are global',
    'rather than wired because a fault is a property of the scenario, not of one node -- and the',
    'thermal excursion has to be visible to both Sim_CNC_Mill_01 and the KPI aggregator, which are',
    'different subflow instances and cannot see one another\'s context.',
    '',
    'Effects, all within one 5-second scan:',
    '',
    '- Thermal: `Systems/TEMPERATURE` on Sim_CNC_Mill_01 -> ~95 degC. OEE quality falls because scrap',
    '  rises, so `OEE/OEE` follows on the next 60-second KPI publish.',
    '- E-stop: `MotionDevice/EmergencyStop` true, `Machine/OperationalMode` STOPPED,',
    '  `Controller/EXECUTION` INTERRUPTED, `Controller/EMERGENCY_STOP` TRIGGERED. Availability',
    '  falls because the machine stops accumulating productive time.',
    '- Reset clears both.',
  ].join('\n'),
  x: 300,
  y: y - 10,
  wires: [],
});

// =================================================================================================
// Merge into the existing flow, preserving every node this generator does not own.
// =================================================================================================
const existing = JSON.parse(fs.readFileSync(FLOW_PATH, 'utf8'));
const ownedIds = new Set(nodes.map((n) => n.id));
const ownedSubflows = new Set(DEVICE_SUBFLOWS.map((s) => s.id));

/**
 * THE LEGACY TAB IS REMOVED, BUT FOUR OF ITS NODES ARE NOT SIMULATION AND MUST SURVIVE.
 *
 * `POST /hooks/quarantine` is the receiver migration 0006's `dispatch_device_quarantine_webhook()`
 * posts to, and `validate.py` check 7 asserts it answers 401 to an unauthenticated caller. The
 * NCMD listener is how a rebirth request from the ingestion daemon becomes visible on the canvas.
 * Neither is a simulated device, and deleting the tab wholesale would have taken both -- turning a
 * consolidation into a silent regression of the webhook path and a failing E2E check.
 *
 * They are RELOCATED, not re-authored: their `z` moves to the unified tab and their position is
 * reset, but their bodies and their comments come across untouched. Rewriting them here would fork
 * logic that already works and is already covered.
 */
const RELOCATE = ['quarantine-hook-in', 'quarantine-hook-log', 'quarantine-hook-response',
                  'ncmd-listener'];
const RELOCATE_POSITIONS = {
  'quarantine-hook-in': { x: 220, y: faultY + 40 },
  'quarantine-hook-log': { x: 560, y: faultY + 40 },
  'quarantine-hook-response': { x: 860, y: faultY + 40 },
  'ncmd-listener': { x: 220, y: faultY + 100 },
};

const relocated = [];
for (const id of RELOCATE) {
  const node = existing.find((n) => n.id === id);
  if (!node) continue;
  node.z = TAB_ID;
  Object.assign(node, RELOCATE_POSITIONS[id]);
  // The NCMD listener subscribed through the legacy broker node, which this consolidation removes.
  // Cell 1's gateway is the correct home: mosquitto.acl grants a gateway read on its OWN edge-node
  // subtree, so it receives the rebirth requests addressed to it and no other node's.
  if (id === 'ncmd-listener') node.broker = `mqtt-broker-${GATEWAYS[0].key}`;
  relocated.push(node);
}

/**
 * OWNERSHIP IS BY NAMESPACE, NOT BY THE CURRENT ID LIST, and the difference is what this run
 * exposed. Renaming a gateway key (`agv` -> `oee`) changed its node ids, so the previous run's
 * `mqtt-broker-agv` and `sf-agv` matched nothing in the new set and were "preserved" -- leaving an
 * orphaned broker config and a dead subflow in the file. Both would have loaded, and the broker
 * would have sat there failing to authenticate against an account nothing publishes through.
 *
 * Anything under these prefixes belongs to this generator and is rebuilt from scratch every run.
 */
const isGeneratorOwned = (id) =>
  typeof id === 'string' && (id.startsWith('mqtt-broker-') || id.startsWith('sf-'));

const preserved = existing.filter((n) => {
  if (n.id === TAB_ID || n.z === TAB_ID) return false;          // the tab this script owns
  if (ownedSubflows.has(n.id) || ownedSubflows.has(n.z)) return false;  // its subflows
  if (ownedIds.has(n.id)) return false;                        // its config nodes
  if (n.id === LEGACY_TAB_ID || n.z === LEGACY_TAB_ID) return false;    // the tab it replaces
  if (n.id === LEGACY_BROKER_ID) return false;                 // and that tab's broker node
  if (isGeneratorOwned(n.id) || isGeneratorOwned(n.z)) return false;    // anything left from a
                                                                       // previous shape of this file
  return true;
});

const merged = [...preserved, ...nodes, ...relocated];
const serialised = `${JSON.stringify(merged, null, 4)}\n`;

if (checkOnly) {
  const current = fs.readFileSync(FLOW_PATH, 'utf8');
  if (current !== serialised) {
    console.error(
      'node_red_flow.json is out of date with scripts/generate-simulator-flow.mjs.\n' +
      'Regenerate it with:  node scripts/generate-simulator-flow.mjs'
    );
    process.exit(1);
  }
  console.log('node_red_flow.json matches the generator.');
  process.exit(0);
}

fs.writeFileSync(FLOW_PATH, serialised);
console.log(
  `Wrote ${FLOW_PATH}\n` +
  `  ${nodes.length} generated node(s): ${GATEWAYS.length} gateways, ` +
  `${GATEWAYS.reduce((n, g) => n + g.devices.length, 0)} devices, ` +
  `${DEVICE_SUBFLOWS.length} subflows\n` +
  `  ${relocated.length} relocated node(s) (quarantine webhook + NCMD listener)\n` +
  `  ${preserved.length} untouched node(s)`
);
