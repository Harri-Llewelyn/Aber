#!/usr/bin/env node
/**
 * Assert the Remote gateway's flow template is one an appliance can run. `flows.template.json` is
 * JavaScript inside JSON inside a template, shipped to hardware nobody here can log into;
 * `bootstrap.mjs` parses it on the appliance after the token is spent, and Node-RED evaluates a
 * function node's body at the first tick. Checks: 1. every function node's body compiles, in the
 * wrapper Node-RED puts around it; 2. no metric uses the `{ type, value }` encoding the daemon
 * discards; 3. every placeholder is one `bootstrap.mjs` substitutes; 4. every wire resolves, the
 * heartbeat is driven only by its injects, and all three collector branches terminate in the cache;
 * 5. every `env.get()` the flow reads is a variable `bootstrap.mjs` writes into /data/gateway.env;
 * 6. the deployed-flow branch reads the file `bootstrap.mjs` and `flow-sync.mjs` agree on, and the
 * broker-root branch the one `bootstrap.mjs` and `aber-gateway-converge` agree on; 7. the heartbeat,
 * the example reading and the exception publisher, run in a stub of Node-RED's function sandbox,
 * share one Sparkplug seq, birth before data, publish only what moved, and refresh inside the
 * daemon's device-offline timeout. It does not check the flow against a broker; that needs an
 * enrolment and hardware.
 *
 * Usage: node scripts/check-gateway-flow-template.mjs [--verbose]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import vm from 'node:vm';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verbose = process.argv.includes('--verbose');
const read = (p) => readFileSync(join(REPO, p), 'utf8');
const log = (m) => verbose && console.log(`       ${m}`);

const problems = [];
const ok = [];
const fail = (m) => problems.push(m);
const pass = (m) => ok.push(m);

const TEMPLATE = 'forge/gateway-platform/appliance/flows.template.json';
const BOOTSTRAP = 'forge/gateway-platform/appliance/bootstrap.mjs';

const raw = read(TEMPLATE);
let flow;
try {
  flow = JSON.parse(raw);
} catch (e) {
  console.error(`\n${TEMPLATE} is not valid JSON: ${e.message}\n`);
  console.error('Node-RED starts with NO FLOWS on an unparseable file, which presents as an\n'
    + 'appliance that enrolled successfully and publishes nothing.\n');
  process.exit(1);
}

const byId = Object.fromEntries(flow.map((n) => [n.id, n]));
const functions = flow.filter((n) => n.type === 'function');
log(`${flow.length} nodes, ${functions.length} function node(s)`);

// 1. Every function body compiles, in the wrapper Node-RED builds around it.
{
  if (!functions.length) {
    fail(`${TEMPLATE} declares no function nodes, which cannot be right -- the heartbeat is one.`);
  }
  let broken = 0;
  for (const n of functions) {
    try {
      // The same parameter list the runtime supplies, so a body referencing `env` or `flow`
      // compiles here as it does there. One reaching for `process` or `require` still compiles,
      // since that is a ReferenceError at run time; assertion 5 covers the reachable half.
      new vm.Script(`(function (msg, node, context, flow, global, env, RED) {\n${n.func}\n})`);
    } catch (e) {
      broken += 1;
      fail(
        `function node '${n.name || n.id}' does not compile: ${e.message}\n`
        + '         Node-RED evaluates a function body at its FIRST TICK, not at deploy, so this\n'
        + '         reaches an appliance as "enrolled, connected, publishing nothing".'
      );
    }
  }
  if (!broken) pass(`all ${functions.length} function nodes compile`);
}

// 2. No metric uses the encoding the daemon cannot read.
{
  const legacy = [...raw.matchAll(/\{\s*name:\s*'([^']+)',\s*type:\s*'(String|Int64|Int32|Float|Double|Boolean)'/g)];
  if (legacy.length) {
    fail(
      `${legacy.length} metric(s) use the \`{ name, type, value }\` encoding: `
      + `${legacy.map((m) => m[1]).join(', ')}.\n`
      + '         parse_sparkplug_payload()\'s JSON branch reads `string_value`, `double_value`,\n'
      + '         `boolean_value` or `int_value`. A metric carrying none of them arrives with a\n'
      + '         name and NO VALUE, and is discarded without an error at either end.'
    );
  } else {
    pass('no metric uses the { name, type, value } encoding the daemon discards');
  }

  // `int_value` is a uint32 in Sparkplug and the daemon's JSON branch does not read `long_value`,
  // so any byte count has to travel as a double.
  const ints = [...raw.matchAll(/name:\s*'([A-Za-z_]*(?:Bytes|_s))',[^}]*int_value/g)];
  if (ints.length) {
    fail(
      `${ints.map((m) => m[1]).join(', ')} sent as \`int_value\`, which is a uint32 (max 4.29 GB)\n`
      + '         and cannot hold a memory or disk figure. `long_value` is not read by the JSON\n'
      + '         branch at all; use `double_value`, exact for integers to 2^53.'
    );
  } else {
    pass('byte counts avoid int_value, which is a uint32 and too small for them');
  }
}

// 2b. On MQTT 5 the session-expiry trap is reachable, so it is asserted shut. `sessionExpiry` and
// will delay both look like resilience settings, and NDEATH is the Last Will: delaying it leaves a
// dead gateway reading ONLINE. Under 3.1.1 the fields did nothing.
{
  const brokers = flow.filter((n) => n.type === 'mqtt-broker');
  const offenders = brokers.filter((b) =>
    (b.sessionExpiry !== undefined && String(b.sessionExpiry).trim() !== '')
    || (b.willDelay !== undefined && String(b.willDelay).trim() !== '')
  );

  if (offenders.length) {
    fail(
      `${offenders.length} broker node(s) set an MQTT 5 session-expiry or will-delay interval: `
      + `${offenders.map((b) => b.name || b.id).join(', ')}.\n`
      + '         NDEATH IS the Last Will. Delaying it, or letting a session outlive the\n'
      + '         connection, leaves a dead gateway reading ONLINE and every device beneath it\n'
      + '         apparently live. Take the v5 diagnostics; leave its timing knobs alone.'
    );
  } else if (brokers.length) {
    pass(`no broker node sets a v5 session-expiry or will-delay interval (${brokers.length} checked)`);
  }
}

// 3. Placeholders are exactly what bootstrap substitutes.
{
  const bootstrap = read(BOOTSTRAP);
  const substituted = [...new Set(
    [...bootstrap.matchAll(/replaceAll\('(__[A-Z0-9_]+__)'/g)].map((m) => m[1])
  )].sort();
  const inTemplate = [...new Set(raw.match(/__[A-Z0-9_]+__/g) || [])].sort();
  const orphans = inTemplate.filter((p) => !substituted.includes(p));

  if (!substituted.length) {
    fail(`no \`replaceAll('__…__')\` calls found in ${BOOTSTRAP}; the comparison examined nothing.`);
  } else if (orphans.length) {
    fail(
      `${TEMPLATE} uses placeholder(s) bootstrap.mjs does not substitute: ${orphans.join(', ')}.\n`
      + '         bootstrap dies on a survivor -- ON THE APPLIANCE, after the single-use enrolment\n'
      + '         token has already been spent, so recovering means issuing a new bundle.'
    );
  } else {
    pass(`all ${inTemplate.length} placeholders are ones bootstrap.mjs substitutes`);
  }
}

// 4. The wiring: nothing dangling, and the collector cannot take the heartbeat down with it.
{
  const ids = new Set(flow.map((n) => n.id));
  const dangling = [];
  for (const n of flow) {
    for (const port of n.wires || []) {
      for (const target of port) if (!ids.has(target)) dangling.push(`${n.id} -> ${target}`);
    }
  }
  if (dangling.length) fail(`wire(s) pointing at nothing: ${dangling.join(', ')}`);
  else pass('every wire resolves to a declared node');

  const HEARTBEAT = 'aber-node-msg';
  if (!byId[HEARTBEAT]) {
    fail(`the heartbeat node '${HEARTBEAT}' is gone; it is what makes a gateway show ONLINE.`);
  } else {
    // Anything wired into the heartbeat can delay or fail it, and a gateway that stops beating is
    // reported STALE and then OFFLINE. A host-metric collector writes to a cache the heartbeat
    // reads instead of being chained into its path.
    const feeds = flow.filter((n) => (n.wires?.[0] || []).includes(HEARTBEAT)).map((n) => n.id).sort();
    const expected = ['aber-birth-tick', 'aber-data-tick'];
    if (JSON.stringify(feeds) !== JSON.stringify(expected)) {
      fail(
        `the heartbeat is fed by [${feeds.join(', ')}]; expected only its two injects `
        + `[${expected.join(', ')}].\n`
        + '         Anything else on that path can delay or fail the heartbeat, and a gateway that\n'
        + '         stops beating is reported STALE and then OFFLINE -- a worse failure than any\n'
        + '         metric it could be collecting.'
      );
    } else {
      pass('the heartbeat is driven by its two injects and nothing else');
    }
  }

  // Both collector branches write a cache the heartbeat reads. A wire out of either would be a
  // second path to the broker, or a way to make the heartbeat wait on a collector.
  for (const [cache, what] of [
    ['aber-host-parse', 'host-metric'],
    ['aber-deployed-parse', 'deployed-flow'],
    ['aber-ca-parse', 'broker-root'],
  ]) {
    if (!byId[cache]) {
      fail(`the ${what} cache node '${cache}' is gone; the heartbeat reads what it writes.`);
    } else if (JSON.stringify(byId[cache].wires) !== '[[]]') {
      fail(`'${cache}' has an outgoing wire; it must terminate in the flow cache, not publish.`);
    } else {
      pass(`the ${what} branch terminates in the cache rather than reaching the broker`);
    }
  }
}

// 6. The deployed-flow branch reads the record flow-sync.mjs writes, at the path both scripts name.
// The heartbeat reports the hash out of it, and the platform compares that with the head of main;
// a branch reading some other file would report a hash that matches nothing, forever.
{
  const FLOW_SYNC = 'forge/gateway-platform/appliance/flow-sync.mjs';
  // BY ID, not by type: there are two `file in` nodes and the other one reads the broker root.
  const reader = byId['aber-deployed-read'];
  const placeholder = '__DEPLOYED_FILE__';
  if (!reader) {
    fail('no `file in` node reads deployed.json, so the heartbeat cannot report what was deployed.');
  } else if (reader.filename !== placeholder || reader.filenameType !== 'str') {
    fail(`the \`file in\` node reads '${reader.filename}' (${reader.filenameType}); expected the `
      + `placeholder ${placeholder}, which bootstrap.mjs resolves to the path flow-sync.mjs writes.`);
  } else {
    const named = (source) => (source.match(/const DEPLOYED = join\(GITOPS_DIR, '([^']+)'\)/) || [])[1];
    const inBootstrap = named(read(BOOTSTRAP));
    const inSync = named(read(FLOW_SYNC));
    if (!inBootstrap || !inSync || inBootstrap !== inSync) {
      fail(`bootstrap.mjs and flow-sync.mjs disagree on the deployed record's file name `
        + `('${inBootstrap}' vs '${inSync}'); the flow would read one and the puller write the other.`);
    } else {
      pass(`the deployed-flow branch reads ${inBootstrap}, which bootstrap.mjs and flow-sync.mjs both name`);
    }
  }
}

// 6b. The broker-root branch reads the record bootstrap.mjs writes at enrolment and the converge
// script rewrites when the platform publishes a new bundle. The heartbeat reports the expiry out
// of it, and the Gateways page puts that beside the platform root's own: a branch reading some
// other file would report the enrolment root's date forever, which is the case this replaced.
{
  const CONVERGE = 'forge/gateway-platform/roles/converge/files/aber-gateway-converge';
  const reader = byId['aber-ca-read'];
  const placeholder = '__CA_JSON_FILE__';
  if (!reader) {
    fail('no `file in` node reads ca.json, so the heartbeat cannot report when the root expires.');
  } else if (reader.filename !== placeholder || reader.filenameType !== 'str') {
    fail(`the broker-root \`file in\` node reads '${reader.filename}' (${reader.filenameType}); `
      + `expected the placeholder ${placeholder}.`);
  } else {
    // bootstrap names it as a path segment; the converge script builds the same path from $CERTS.
    const inBootstrap = (read(BOOTSTRAP).match(/const CA_JSON = join\(DATA_DIR, 'certs', '([^']+)'\)/) || [])[1];
    const inConverge = (read(CONVERGE).match(/^CA_JSON="\$CERTS\/([^"]+)"$/m) || [])[1];
    if (!inBootstrap || !inConverge || inBootstrap !== inConverge) {
      fail(`bootstrap.mjs and aber-gateway-converge disagree on the root record's file name `
        + `('${inBootstrap}' vs '${inConverge}'); the flow would read one and the converge script `
        + 'write the other, so a re-issued root would never be reported.');
    } else {
      pass(`the broker-root branch reads certs/${inBootstrap}, which bootstrap.mjs and the converge script both name`);
    }
  }
}

// 5. Every env.get() the flow reads is a variable bootstrap actually exports.
{
  const bootstrap = read(BOOTSTRAP);
  const wanted = [...new Set(
    (raw.match(/env\.get\(\\?'([A-Z0-9_]+)\\?'\)/g) || [])
      .map((m) => m.replace(/.*?([A-Z0-9_]{2,}).*/, '$1'))
  )].sort();
  const exported = [...new Set(
    (bootstrap.match(/export ([A-Z0-9_]+)=/g) || []).map((m) => m.slice(7, -1))
  )].sort();

  const missing = wanted.filter((v) => !exported.includes(v));
  if (!wanted.length) {
    log('the flow reads no environment variables');
    pass('the flow reads no environment variables');
  } else if (missing.length) {
    fail(
      `the flow reads ${missing.join(', ')}, which bootstrap.mjs does not write to `
      + '/data/gateway.env.\n         env.get() returns undefined and the metric is simply '
      + 'omitted -- indistinguishable,\n         from the platform, from an appliance that has '
      + 'nothing to report.'
    );
  } else {
    pass(`all ${wanted.length} environment variables the flow reads are exported by bootstrap`);
  }
}


// 7. Report by exception, run rather than read. The function bodies are executed in a stub of the
// sandbox Node-RED gives them (msg, node, context, flow, env), wired as the template wires them, and
// the messages reaching the broker node are asserted in order.
{
  const heartbeat = byId['aber-node-msg'];
  const example = byId['aber-device-fn'];
  const rbe = byId['aber-rbe'];
  const refresh = byId['aber-rbe-refresh'];
  if (!heartbeat || !example || !rbe || !refresh) {
    fail('the heartbeat, example reading, publish-by-exception or refresh node is gone; the device '
      + 'path cannot be exercised.');
  } else {
    const store = () => { const m = new Map(); return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) }; };
    const flowCtx = store();
    const contexts = new Map();
    const warnings = [];
    const run = (node, msg, body = node.func) => {
      if (!contexts.has(node.id)) contexts.set(node.id, store());
      const fn = new vm.Script(`(function (msg, node, context, flow, global, env, RED) {\n${body}\n})`)
        .runInNewContext({ Date, Math, Number, Object, JSON, String });
      const stub = { warn: (w) => warnings.push(w), status: () => {}, log: () => {} };
      const res = fn(msg, stub, contexts.get(node.id), flowCtx, store(), { get: () => undefined }, {});
      if (res == null) return [];
      const first = Array.isArray(res) ? res[0] : res;
      return Array.isArray(first) ? first : [first];
    };
    const click = () => run(rbe, run(example, {})[0]);
    const kinds = (msgs) => msgs.map((m) => `${m.topic.split('/')[2]}#${m.payload.seq}`);
    const names = (m) => m.payload.metrics.map((x) => x.name).sort();
    const checks = [];
    const expect = (label, got, want) => checks.push([label, JSON.stringify(got) === JSON.stringify(want), got, want]);

    expect('NBIRTH starts the seq', kinds(run(heartbeat, { payload: 'NBIRTH' })), ['NBIRTH#0']);
    const first = click();
    expect('the first reading births the device, on the next seq', kinds(first), ['DBIRTH#1']);
    expect('the birth declares every metric and Device Control/Rebirth', first[0] && names(first[0]),
      ['CycleCount', 'Device Control/Rebirth', 'Properties/Manufacturer', 'Running', 'Temperature']);
    const second = click();
    expect('the next reading is DDATA on the next seq', kinds(second), ['DDATA#2']);
    expect('a metric that did not move is not published', second[0]
      && ['Running', 'Properties/Manufacturer'].some((n) => names(second[0]).includes(n)), false);
    expect('every published metric carries the reading\'s timestamp', second[0]
      && second[0].payload.metrics.every((m) => m.timestamp === second[0].payload.timestamp), true);
    expect('the heartbeat continues the same seq', kinds(run(heartbeat, { payload: 'NDATA' })), ['NDATA#3']);
    const refreshed = run(rbe, { payload: refresh.payload });
    expect('a refresh republishes every metric', refreshed[0] && names(refreshed[0]),
      ['CycleCount', 'Properties/Manufacturer', 'Running', 'Temperature']);
    run(heartbeat, { payload: 'NBIRTH' });
    expect('after an NBIRTH the refresh re-births the device', kinds(run(rbe, { payload: 'refresh' })), ['DBIRTH#1']);
    expect('a new metric name needs a new birth', kinds(run(rbe, { payload: { device: 'press-01', metrics: { Vibration: 1.5 } } })), ['DBIRTH#2']);
    expect('a malformed reading is refused, not published', run(rbe, { payload: { device: 'a/b', metrics: {} } }), []);

    const banded = rbe.func.replace('const DEADBAND = {', 'const DEADBAND = {\n    Level: { absolute: 0.5 },');
    const level = (v) => kinds(run(rbe, { payload: { device: 'tank-01', metrics: { Level: v } } }, banded));
    level(10.0);
    expect('a move inside the deadband is suppressed', level(10.3), []);
    expect('a move past it, measured from the last PUBLISHED value, is not', level(10.6).length, 1);

    const timeout = Number((read('ingestion/ingestion.py').match(/DEVICE_OFFLINE_TIMEOUT_SECONDS", "(\d+)"/) || [])[1]);
    const every = Number(refresh.repeat);
    expect(`the refresh (${every}s) is well inside the device-offline timeout (${timeout}s)`,
      Number.isFinite(timeout) && every > 0 && every <= timeout / 2, true);

    const failed = checks.filter(([, good]) => !good);
    for (const [label, , got, want] of failed) {
      fail(`report by exception: ${label}\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`);
    }
    if (!failed.length) pass(`report by exception behaves as documented (${checks.length} assertions)`);
  }
}

// =================================================================================================
for (const line of ok) console.log(`  ok   ${line}`);
if (problems.length) {
  console.error('\nThe gateway flow template would not do what it appears to:\n');
  for (const p of problems) console.error(`  ${p}\n`);
  console.error(
    'This file is JavaScript inside JSON inside a template, running on hardware nobody here can\n'
    + 'log into. Both readers see it too late to help: bootstrap parses it on the appliance after\n'
    + 'the enrolment token is spent, and Node-RED evaluates a function body at its first tick.\n'
  );
  process.exit(1);
}
console.log(
  `\n${TEMPLATE} compiles, uses an encoding the daemon reads, and is wired so the collector `
  + 'cannot take the heartbeat with it.'
);
