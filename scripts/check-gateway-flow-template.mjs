#!/usr/bin/env node
/**
 * Assert the Remote gateway's flow template is one an appliance can run. `flows.template.json` is
 * JavaScript inside JSON inside a template, shipped to hardware nobody here can log into;
 * `bootstrap.mjs` parses it on the appliance after the token is spent, and Node-RED evaluates a
 * function node's body at the first tick. Checks: 1. every function node's body compiles, in the
 * wrapper Node-RED puts around it; 2. no metric is typed by `{ type, value }`, which reaches the
 * platform untyped, and no byte count travels in the 32-bit `int_value`; 3. every placeholder is one `bootstrap.mjs` substitutes; 4. every wire resolves, the
 * heartbeat is driven only by its injects, and all three collector branches terminate in the cache;
 * 5. every `env.get()` the flow reads is a variable `bootstrap.mjs` writes into /data/gateway.env;
 * 6. the deployed-flow branch reads the file `bootstrap.mjs` and `flow-sync.mjs` agree on, and the
 * broker-root branch the one `bootstrap.mjs` and `aber-gateway-converge` agree on; 7. the heartbeat,
 * the example reading and the exception publisher, run in a stub of Node-RED's function sandbox,
 * share one Sparkplug seq, birth before data, publish only what moved, and refresh inside the
 * daemon's device-offline timeout; 8. store and forward, run against a clock the check moves, holds
 * the Sparkplug session (each CONNECT's NDEATH will carries the next bdSeq; the NBIRTH waits for the
 * primary host and its offline STATE ends the session), buffers readings while they cannot be
 * delivered, replays them in order with is_historical, bounds and persists the buffer, reports each
 * outage, and encodes protobuf. Payloads are decoded here with a reader independent of the flow's
 * encoder. It does not check the flow against a broker; that needs an enrolment and hardware.
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

// Sparkplug B protobuf, read back: the Payload and Metric fields an appliance sends. Numbers are
// summed rather than shifted, so a millisecond timestamp survives; unknown fields are skipped.
function decodeSparkplug(buf) {
  const bytes = Buffer.from(buf);
  const read = (from, to, onField) => {
    let i = from;
    const varint = () => {
      let n = 0;
      let scale = 1;
      for (;;) {
        const b = bytes[i];
        i += 1;
        n += (b % 128) * scale;
        if (b < 128) return n;
        scale *= 128;
      }
    };
    while (i < to) {
      const key = varint();
      const field = Math.floor(key / 8);
      const wire = key % 8;
      if (wire === 0) onField(field, varint());
      else if (wire === 1) { onField(field, bytes.readDoubleLE(i)); i += 8; }
      else if (wire === 5) { onField(field, bytes.readFloatLE(i)); i += 4; }
      else if (wire === 2) {
        const len = varint();
        onField(field, [i, i + len]);
        i += len;
      } else throw new Error(`wire type ${wire} at byte ${i}`);
    }
  };
  const METRIC = {
    1: ['name', (r) => bytes.toString('utf8', r[0], r[1])], 3: ['timestamp'], 4: ['datatype'],
    5: ['is_historical', Boolean], 7: ['is_null', Boolean], 10: ['int_value'], 11: ['long_value'],
    12: ['float_value'], 13: ['double_value'], 14: ['boolean_value', Boolean],
    15: ['string_value', (r) => bytes.toString('utf8', r[0], r[1])],
  };
  const payload = { metrics: [] };
  read(0, bytes.length, (field, value) => {
    if (field === 1) payload.timestamp = value;
    else if (field === 3) payload.seq = value;
    else if (field === 2) {
      const metric = {};
      read(value[0], value[1], (f, v) => {
        const [name, as] = METRIC[f] || [];
        if (name) metric[name] = as ? as(v) : v;
      });
      payload.metrics.push(metric);
    }
  });
  return payload;
}

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

// 2. Every metric is typed the way the platform reads a type.
{
  // json_metric_value() takes the type only from `datatype`: it reads a bare `value` by what the
  // JSON holds and ignores `type`.
  const legacy = [...raw.matchAll(/\{\s*name:\s*'([^']+)',\s*type:\s*'(String|Int64|Int32|Float|Double|Boolean)'/g)];
  if (legacy.length) {
    fail(
      `${legacy.length} metric(s) use the \`{ name, type, value }\` encoding: `
      + `${legacy.map((m) => m[1]).join(', ')}.\n`
      + '         The daemon ignores `type`, so the metric arrives with no datatype.\n'
      + '         Send `datatype` and the typed field, as the rest of the flow does.'
    );
  } else {
    pass('every metric declares `datatype` rather than the { name, type, value } encoding');
  }

  // `int_value` is a 32-bit field, and the daemon drops a metric whose value does not fit it.
  const ints = [...raw.matchAll(/name:\s*'([A-Za-z_]*Bytes)',[^}]*int_value/g)];
  if (ints.length) {
    fail(
      `${ints.map((m) => m[1]).join(', ')} sent as \`int_value\`, a 32-bit field (max 4.29 GB) that\n`
      + '         cannot hold a memory or disk figure; the daemon drops the metric once it\n'
      + '         overflows. Use `double_value`, exact for integers to 2^53, or `long_value`.'
    );
  } else {
    pass('byte counts avoid int_value, a 32-bit field too small for them');
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
    // reads instead of being chained into its path. The rebirth handler and store and forward are
    // the other feeders, and the only two that ask for an NBIRTH: store and forward once a session,
    // the rebirth handler when the host asks. An inject of its own would be a second each start.
    const feeds = flow.filter((n) => (n.wires || []).some((port) => port.includes(HEARTBEAT))).map((n) => n.id).sort();
    const expected = ['aber-cmd', 'aber-data-tick', 'aber-sf'];
    if (JSON.stringify(feeds) !== JSON.stringify(expected)) {
      fail(
        `the heartbeat is fed by [${feeds.join(', ')}]; expected only its NDATA inject, the rebirth handler and store and forward `
        + `[${expected.join(', ')}].\n`
        + '         Anything else on that path can delay or fail the heartbeat, and a gateway that\n'
        + '         stops beating is reported STALE and then OFFLINE -- a worse failure than any\n'
        + '         metric it could be collecting.'
      );
    } else {
      pass('the heartbeat is driven by its NDATA inject, the rebirth handler and store and forward, and nothing else');
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
    // Every output port's messages, as arrays. `run` keeps the first port, which is the one the
    // broker node hangs off for every function here.
    const runAll = (node, msg, body = node.func) => {
      if (!contexts.has(node.id)) contexts.set(node.id, store());
      const fn = new vm.Script(`(function (msg, node, context, flow, global, env, RED) {\n${body}\n})`)
        .runInNewContext({ Date, Math, Number, Object, JSON, String, Buffer });
      const stub = { warn: (w) => warnings.push(w), status: () => {}, log: () => {} };
      const res = fn(msg, stub, contexts.get(node.id), flowCtx, store(), { get: () => undefined }, {});
      if (res == null) return [];
      const ports = Array.isArray(res) ? res : [res];
      return ports.map((p) => (p == null ? [] : Array.isArray(p) ? p : [p]));
    };
    const run = (node, msg, body) => runAll(node, msg, body)[0] || [];
    // Store and forward stamps the seq on everything bound for the broker, so the heartbeat's and
    // publish by exception's messages are passed through it, as wired, with the platform reachable.
    const gateNode = byId['aber-sf'];
    // Its connect and disconnect actions are for the broker node; what it publishes is protobuf.
    const live = (msgs) => (gateNode
      ? msgs.flatMap((m) => (runAll(gateNode, m)[0] || []).filter((x) => x.topic)
        .map((x) => ({ topic: x.topic, payload: decodeSparkplug(x.payload) })))
      : msgs);
    const toBroker = (node, msg, body) => live(run(node, msg, body));
    // No buffer files, then the session it opens; with no primary host it may birth at once.
    if (gateNode) {
      runAll(gateNode, { sf: 'tick' });
      runAll(gateNode, { sf: 'state', error: 'ENOENT' });
      runAll(gateNode, { sf: 'state', error: 'ENOENT' });
      runAll(gateNode, { sf: 'tick' });
      runAll(gateNode, { status: { text: 'node-red:common.status.connected' } });
    }
    const click = () => toBroker(rbe, run(example, {})[0]);
    const kinds = (msgs) => msgs.map((m) => `${m.topic.split('/')[2]}#${m.payload.seq}`);
    const names = (m) => m.payload.metrics.map((x) => x.name).sort();
    const checks = [];
    const expect = (label, got, want) => checks.push([label, JSON.stringify(got) === JSON.stringify(want), got, want]);

    expect('NBIRTH starts the seq', kinds(toBroker(heartbeat, { payload: 'NBIRTH' })), ['NBIRTH#0']);
    const first = click();
    expect('the first reading births the device, on the next seq', kinds(first), ['DBIRTH#1']);
    expect('the birth declares every metric and Device Control/Rebirth', first[0] && names(first[0]),
      ['CycleCount', 'Device Control/Rebirth', 'Properties/Manufacturer', 'Running', 'Temperature']);
    const reading = run(rbe, run(example, {})[0]);
    const second = live(reading);
    expect('the next reading is DDATA on the next seq', kinds(second), ['DDATA#2']);
    expect('a metric that did not move is not published', second[0]
      && ['Running', 'Properties/Manufacturer'].some((n) => names(second[0]).includes(n)), false);
    expect('every published metric carries the reading\'s timestamp', second[0]
      && second[0].payload.metrics.every((m) => m.timestamp === reading[0].payload.timestamp), true);
    expect('the heartbeat continues the same seq', kinds(toBroker(heartbeat, { payload: 'NDATA' })), ['NDATA#3']);
    const refreshed = toBroker(rbe, { payload: refresh.payload });
    expect('a refresh republishes every metric', refreshed[0] && names(refreshed[0]),
      ['CycleCount', 'Properties/Manufacturer', 'Running', 'Temperature']);
    // A second NBIRTH in a session is published only as the answer to the host's rebirth request.
    toBroker(heartbeat, { payload: 'NBIRTH', rebirth: true });
    expect('after an NBIRTH the refresh re-births the device', kinds(toBroker(rbe, { payload: 'refresh' })), ['DBIRTH#1']);
    expect('a new metric name needs a new birth', kinds(toBroker(rbe, { payload: { device: 'press-01', metrics: { Vibration: 1.5 } } })), ['DBIRTH#2']);
    expect('a malformed reading is refused, not published', toBroker(rbe, { payload: { device: 'a/b', metrics: {} } }), []);

    const banded = rbe.func.replace('const DEADBAND = {', 'const DEADBAND = {\n    Level: { absolute: 0.5 },');
    const level = (v) => kinds(toBroker(rbe, { payload: { device: 'tank-01', metrics: { Level: v } } }, banded));
    level(10.0);
    expect('a move inside the deadband is suppressed', level(10.3), []);
    expect('a move past it, measured from the last PUBLISHED value, is not', level(10.6).length, 1);

    // Rebirth requests (#414), in the bytes the platform sends: these are build_rebirth_payload()'s
    // output with its timestamp pinned, and protobuf messages built the same way for the rest.
    const cmd = byId['aber-cmd'];
    if (!cmd) {
      checks.push(['the rebirth handler exists', false, 'missing', 'aber-cmd']);
    } else {
      const hex = (h) => Buffer.from(h, 'hex');
      const NCMD = 'spBv1.0/__SPARKPLUG_GROUP__/NCMD/__SPARKPLUG_ID__';
      const DCMD = (d) => `spBv1.0/__SPARKPLUG_GROUP__/DCMD/__SPARKPLUG_ID__/${d}`;
      const DAEMON_NCMD = hex('0880d8c1a28c34121a0a144e6f646520436f6e74726f6c2f52656269727468200b7001');
      const DCMD_REBIRTH = hex('0880d8c1a28c34120b0a05626453657120045803121c0a1644657669636520436f6e74726f6c2f52656269727468200b70011807');
      const NCMD_REBOOT = hex('0880d8c1a28c3412190a134e6f646520436f6e74726f6c2f5265626f6f74200b70011807');
      const NCMD_FALSE = hex('0880d8c1a28c34121a0a144e6f646520436f6e74726f6c2f52656269727468200b70001807');

      const asked = runAll(cmd, { topic: NCMD, payload: DAEMON_NCMD });
      expect('the daemon\'s NCMD asks the heartbeat for an NBIRTH, marked as the rebirth it answers',
        asked[0] && asked[0].map((m) => [m.payload, m.rebirth]), [['NBIRTH', true]]);
      const [births, refreshes] = runAll(heartbeat, asked[0][0]);
      expect('the NBIRTH restarts the seq', kinds(live(births)), ['NBIRTH#0']);
      expect('and asks publish by exception for a refresh', refreshes.map((m) => m.payload), ['refresh']);
      expect('which re-births every device at its last values, in seq order',
        kinds(toBroker(rbe, refreshes[0])), ['DBIRTH#1', 'DBIRTH#2']);
      expect('the NDATA after it continues that seq', kinds(toBroker(heartbeat, { payload: 'NDATA' })), ['NDATA#3']);
      expect('an NDATA asks for no refresh', runAll(heartbeat, { payload: 'NDATA' })[1], []);

      const one = runAll(cmd, { topic: DCMD('press-01'), payload: DCMD_REBIRTH });
      expect('a DCMD rebirth goes to publish by exception for that device', one[1] && one[1].map((m) => m.payload), [{ rebirth: 'press-01' }]);
      const reborn = toBroker(rbe, one[1][0]);
      expect('and re-births that device alone', reborn.map((m) => m.topic.split('/').slice(2).join('/')),
        ['DBIRTH/__SPARKPLUG_ID__/press-01']);
      expect('with every metric it has published', reborn[0] && names(reborn[0]),
        ['CycleCount', 'Device Control/Rebirth', 'Properties/Manufacturer', 'Running', 'Temperature', 'Vibration']);
      expect('a rebirth of a device that has published nothing is refused', toBroker(rbe, { payload: { rebirth: 'ghost-01' } }), []);

      expect('any other command is ignored', runAll(cmd, { topic: NCMD, payload: NCMD_REBOOT }), []);
      expect('Rebirth = false is not a request', runAll(cmd, { topic: NCMD, payload: NCMD_FALSE }), []);
      expect('bytes that are not Sparkplug are ignored', runAll(cmd, { topic: NCMD, payload: hex('0a7f') }), []);
      expect('the JSON encoding is read too', runAll(cmd, {
        topic: NCMD,
        payload: Buffer.from(JSON.stringify({ metrics: [{ name: 'Node Control/Rebirth', boolean_value: true }] })),
      })[0].map((m) => m.payload), ['NBIRTH']);

      const inputs = flow.filter((n) => n.type === 'mqtt in' && (n.wires?.[0] || []).includes('aber-cmd'));
      expect('the handler hears this node\'s NCMD and its devices\' DCMD, as buffers',
        inputs.map((n) => `${n.topic} ${n.datatype}`).sort(), [`${DCMD('+')} buffer`, `${NCMD} buffer`]);
    }

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

// 8. Store and forward, run rather than read, against a clock this check moves. It holds the
// Sparkplug session and every message bound for the broker passes through it: the CONNECT and its
// NDEATH will, births only once the primary host is online, readings buffered while they cannot be
// delivered and replayed in order flagged is_historical, the outage report, and protobuf on the wire.
{
  const gateNode = byId['aber-sf'];
  const broker = flow.find((n) => n.type === 'mqtt-broker');
  if (!gateNode || !broker) {
    fail('the store-and-forward node or the broker node is gone; nothing holds the session or buffers an outage.');
  } else {
    const checks = [];
    const expect = (label, got, want) => checks.push([label, JSON.stringify(got) === JSON.stringify(want), got, want]);
    const store = () => { const m = new Map(); return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) }; };
    const clock = { t: Date.UTC(2026, 9, 8, 12) };
    class CheckDate extends Date {
      static now() { return clock.t; }
    }
    // Math.random() places the replay's start inside its jitter window; 0 starts it at once.
    const steady = Object.assign(Object.create(Math), { random: () => 0 });
    const makeGate = (vars = {}, body = gateNode.func) => {
      const flowCtx = store();
      const fn = new vm.Script(`(function (msg, node, context, flow, global, env, RED) {\n${body}\n})`)
        .runInNewContext({ Date: CheckDate, Math: steady, Number, Object, JSON, String, Buffer });
      const stub = { warn: () => {}, status: () => {}, log: () => {}, error: () => {} };
      const gate = (msg) => fn(msg, stub, store(), flowCtx, store(), { get: (k) => vars[k] }, {})
        .map((p) => (p == null ? [] : Array.isArray(p) ? p : [p]));
      gate.sf = () => flowCtx.get('sf');
      return gate;
    };
    const HOST = 'Check-Site';
    const NDEATH = 'spBv1.0/__SPARKPLUG_GROUP__/NDEATH/__SPARKPLUG_ID__';
    const CONNECTED = { status: { text: 'node-red:common.status.connected' } };
    const DISCONNECTED = { status: { text: 'node-red:common.status.disconnected' } };
    const STATE = (online, ts, host = HOST) => ({ topic: `spBv1.0/STATE/${host}`, payload: JSON.stringify({ online, timestamp: ts }) });
    const NBIRTH = () => ({ topic: 'spBv1.0/G/NBIRTH/N', payload: { timestamp: clock.t, metrics: [{ name: 'Gateway_Status', datatype: 12, string_value: 'ONLINE' }] } });
    const NDATA = () => ({ topic: 'spBv1.0/G/NDATA/N', payload: { timestamp: clock.t, metrics: [{ name: 'Gateway_Status', datatype: 12, string_value: 'ONLINE' }] } });
    const ddata = (value, ts) => ({
      topic: 'spBv1.0/G/DDATA/N/press-01',
      payload: { timestamp: ts, metrics: [{ name: 'Temperature', datatype: 10, double_value: value, timestamp: ts }] },
    });
    const pubs = (res) => res[0].filter((m) => m.topic).map((m) => Object.assign({ topic: m.topic }, decodeSparkplug(m.payload)));
    const actions = (res) => res[0].filter((m) => m.action).map((m) => m.action);
    const kinds = (msgs) => msgs.map((m) => `${m.topic.split('/')[2]}#${m.seq}`);
    const metric = (m, name) => m && m.metrics.find((x) => x.name === name);
    const outage = (m) => {
      const r = Object.fromEntries(((m && m.metrics) || []).filter((x) => x.name.startsWith('Outage/') && !x.is_null)
        .map((x) => [x.name.slice(7), x.long_value ?? x.double_value ?? x.boolean_value]));
      return Object.keys(r).length ? r : null;
    };
    // Load the (absent) state files, then connect; with a primary host, hear it online.
    const up = (gate, host) => {
      gate({ sf: 'tick' });
      gate({ sf: 'state', error: 'ENOENT' });
      gate({ sf: 'state', error: 'ENOENT' });
      const opened = gate({ sf: 'tick' });
      const linked = gate(CONNECTED);
      const heard = host ? gate(STATE(true, 1000)) : [[], [], [], [], [], []];
      return { opened, asked: linked[5].length + heard[5].length };
    };
    const SEGMENT_1 = '/data/buffer/segment-1.jsonl';

    // Without a primary host: the session, a link drop, a new session, the report and the replay.
    const g = makeGate();
    const first = up(g);
    const connect = first.opened[0].find((m) => m.action === 'connect');
    const will = connect && decodeSparkplug(connect.broker.will.payload);
    expect('the first CONNECT is asked of the broker node, with an NDEATH will carrying bdSeq 0 and no seq',
      connect && [connect.broker.force, connect.broker.will.topic, connect.broker.will.qos, connect.broker.will.retain,
        will.metrics.map((x) => [x.name, x.datatype, x.long_value]), will.seq],
      [true, NDEATH, 1, false, [['bdSeq', 4, 0]], undefined]);
    expect('the same NDEATH is the message sent before a deliberate disconnect',
      connect && decodeSparkplug(connect.broker.close.payload).metrics[0].long_value, 0);
    expect('without a primary host, a connection asks the heartbeat for an NBIRTH at once', first.asked, 1);
    const birth = pubs(g(NBIRTH()))[0];
    expect('the NBIRTH is protobuf, seq 0, with the CONNECT\'s bdSeq and Node Control/Rebirth = false',
      birth && [birth.seq, metric(birth, 'bdSeq').long_value, metric(birth, 'bdSeq').datatype,
        metric(birth, 'Node Control/Rebirth').boolean_value, metric(birth, 'Node Control/Rebirth').datatype],
      [0, 0, 4, false, 11]);
    expect('it declares the outage report, null with nothing to report',
      birth && birth.metrics.filter((x) => x.name.startsWith('Outage/')).map((x) => [x.name, Boolean(x.is_null)]),
      [['Outage/Started_At', true], ['Outage/Ended_At', true], ['Outage/Readings_Buffered', true],
        ['Outage/Readings_Dropped', true], ['Outage/Buffering', true]]);
    expect('every metric carries a timestamp', birth && birth.metrics.every((x) => x.timestamp > 0), true);
    const startedAt = clock.t;
    expect('live: a reading is published at once, on the next seq', kinds(pubs(g(ddata(1, clock.t)))), ['DDATA#1']);
    clock.t += 1000;
    const dead = g(DISCONNECTED);
    expect('a dropped link stops the broker node retrying with the old will', actions(dead), ['disconnect']);
    expect('what was published within the keepalive window is buffered again: the link may have been dead',
      dead[1].map((m) => [m.filename, JSON.parse(m.payload).metrics.map((x) => x.double_value)]), [[SEGMENT_1, [1]]]);
    const kept = g(ddata(2, clock.t + 100));
    expect('a reading is then appended to a segment, not published',
      [kept[0].length, kept[1].map((m) => m.filename)], [0, [SEGMENT_1]]);
    clock.t += 1000;
    const lines = [dead[1][0], kept[1][0], g(ddata(3, clock.t))[1][0]].filter(Boolean).map((m) => m.payload);
    expect('a heartbeat is dropped while there is no session, and takes no seq', g(NDATA())[0], []);
    clock.t += 5000;
    const again = g({ sf: 'tick' });
    const reconnect = again[0].find((m) => m.action === 'connect');
    expect('the next CONNECT carries the next bdSeq',
      reconnect && decodeSparkplug(reconnect.broker.will.payload).metrics[0].long_value, 1);
    clock.t += 1000;
    expect('a new session asks for an NBIRTH', g(CONNECTED)[5].map((m) => m.payload), ['NBIRTH']);
    const endedAt = clock.t;
    const rebirth = pubs(g(NBIRTH()))[0];
    expect('which restarts the seq and carries the new bdSeq', rebirth && [rebirth.seq, metric(rebirth, 'bdSeq').long_value], [0, 1]);
    const beat = pubs(g(NDATA()))[0];
    expect('the next heartbeat reports the outage from the oldest reading sent again, counting it', [kinds([beat]), outage(beat)],
      [['NDATA#1'], { Started_At: startedAt, Ended_At: endedAt, Readings_Buffered: 3, Readings_Dropped: 0, Buffering: true }]);
    expect('the report rides three node messages, then stops',
      [pubs(g(NDATA()))[0], pubs(g(NDATA()))[0], pubs(g(NDATA()))[0]].map((m) => Boolean(outage(m))), [true, true, false]);
    clock.t += 2000;
    const ask = g({ sf: 'tick' });
    expect('after the births the replay reads the oldest segment', ask[3].map((m) => m.filename), [SEGMENT_1]);
    g({ sf: 'segment', segment: g.sf().queue[0].n, filename: SEGMENT_1, payload: `${lines.join('\n')}\n` });
    const replayed = g({ sf: 'tick' });
    expect('the replay publishes every buffered reading, oldest first, each flagged is_historical',
      pubs(replayed).flatMap((m) => m.metrics.map((x) => [x.double_value, Boolean(x.is_historical)])), [[1, true], [2, true], [3, true]]);
    expect('in one message per device, continuing the live seq', kinds(pubs(replayed)), ['DDATA#5']);
    expect('and the replayed segment is deleted', replayed[4].map((m) => m.filename), [SEGMENT_1]);

    // Only the window is sent again: 1.5 keepalives and the margin, 60 s at the defaults.
    const win = makeGate();
    up(win);
    win(NBIRTH());
    win(ddata(10, clock.t));
    clock.t += 61000;
    win(ddata(11, clock.t));
    clock.t += 1000;
    expect('a reading published before the window is not sent again',
      win(DISCONNECTED)[1].map((m) => JSON.parse(m.payload).metrics[0].double_value), [11]);

    // One NBIRTH a session: a second only answers the host's Node Control/Rebirth.
    const once = makeGate({ GATEWAY_PRIMARY_HOST_ID: HOST });
    up(once);
    expect('two online STATEs before the birth ask the heartbeat once',
      [once(STATE(true, 1000))[5].length, once(STATE(true, 1001))[5].length], [1, 0]);
    expect('the NBIRTH asked for is published', kinds(pubs(once(NBIRTH()))), ['NBIRTH#0']);
    expect('a second in the same session is not, whatever sent it', pubs(once(NBIRTH())), []);
    expect('one answering the host\'s rebirth request is, and restarts the seq',
      kinds(pubs(once(Object.assign(NBIRTH(), { rebirth: true })))), ['NBIRTH#0']);
    const unanswered = makeGate();
    up(unanswered);
    clock.t += 11000;
    expect('a birth asked for and never answered is asked for again', unanswered({ sf: 'tick' })[5].map((m) => m.payload), ['NBIRTH']);

    // With a primary host: the NBIRTH waits for its STATE, and its going offline ends the session.
    const h = makeGate({ GATEWAY_PRIMARY_HOST_ID: HOST });
    const waiting = up(h);
    expect('with a primary host, a connection does not birth until STATE says it is online', waiting.asked, 0);
    expect('another host\'s STATE is not this node\'s primary host', h(STATE(true, 1000, 'Someone-Else'))[5], []);
    expect('nor is an NBIRTH the heartbeat sends of its own accord published', pubs(h(NBIRTH())), []);
    expect('an online STATE from the primary host asks for the NBIRTH', h(STATE(true, 1000))[5].map((m) => m.payload), ['NBIRTH']);
    h(NBIRTH());
    expect('then readings are published', kinds(pubs(h(ddata(4, clock.t)))), ['DDATA#1']);
    expect('a death older than the birth it follows is a previous session\'s, and ignored', actions(h(STATE(false, 999))), []);
    const offline = h(STATE(false, 1000));
    expect('a valid offline STATE disconnects (the broker node sends the NDEATH first)', actions(offline), ['disconnect']);
    expect('and sends nothing again: the link was alive', offline[1], []);
    expect('and readings wait on disk', [h(ddata(5, clock.t))[1].length, h.sf().queue.length], [1, 1]);
    clock.t += 5000;
    const next = h({ sf: 'tick' }).flatMap((r) => r).find((m) => m.action === 'connect');
    expect('it connects again with the next bdSeq', next && decodeSparkplug(next.broker.will.payload).metrics[0].long_value, 1);
    expect('and does not birth on the connection alone', h(CONNECTED)[5], []);
    expect('nor on the retained offline STATE', h(STATE(false, 1000))[5], []);
    expect('only when the host is back', h(STATE(true, 2000))[5].map((m) => m.payload), ['NBIRTH']);

    // An attempt that never connected sent no CONNECT packet, so its bdSeq is not used up.
    const slow = makeGate();
    slow({ sf: 'tick' });
    slow({ sf: 'state', error: 'ENOENT' });
    slow({ sf: 'state', error: 'ENOENT' });
    slow({ sf: 'tick' });
    clock.t += 16000;
    expect('an attempt with no session after 15 s is abandoned', actions(slow({ sf: 'tick' })), ['disconnect']);
    clock.t += 5000;
    const retried = slow({ sf: 'tick' })[0].find((m) => m.action === 'connect');
    expect('and the next attempt carries the same bdSeq: none reached the broker',
      retried && decodeSparkplug(retried.broker.will.payload).metrics[0].long_value, 0);
    expect('once a CONNECT is accepted, a redeploy starts the next session with the next bdSeq', (() => {
      slow(CONNECTED);
      slow({ sf: 'start' });
      const after = slow({ sf: 'tick' })[0].find((m) => m.action === 'connect');
      return after && decodeSparkplug(after.broker.will.payload).metrics[0].long_value;
    })(), 1);

    // A full buffer drops its oldest segment and counts it.
    const small = makeGate({}, gateNode.func
      .replace('const MAX_BYTES = 256 * 1024 * 1024;', 'const MAX_BYTES = 600;')
      .replace('const SEGMENT_BYTES = 1024 * 1024;', 'const SEGMENT_BYTES = 200;'));
    up(small);
    small(NBIRTH());
    small(DISCONNECTED);
    let evicted = 0;
    for (let i = 0; i < 8; i += 1) {
      clock.t += 1000;
      evicted += small(ddata(i, clock.t))[4].length;
    }
    clock.t += 5000;
    small({ sf: 'tick' });
    small(CONNECTED);
    small(NBIRTH());
    const full = outage(pubs(small(NDATA()))[0]);
    expect('a full buffer drops its oldest segment, and the report counts what it held',
      [evicted, full && full.Readings_Buffered, full && full.Readings_Dropped], [4, 8, 4]);

    // An appliance set not to buffer still says what an outage cost.
    const off = makeGate({}, gateNode.func.replace('const BUFFER_ENABLED = true;', 'const BUFFER_ENABLED = false;'));
    up(off);
    off(NBIRTH());
    off(DISCONNECTED);
    expect('with buffering off nothing is written', off(ddata(1, clock.t))[1], []);
    clock.t += 5000;
    off({ sf: 'tick' });
    off(CONNECTED);
    off(NBIRTH());
    const lost = outage(pubs(off(NDATA()))[0]);
    expect('and the report says it does not buffer, and what was lost', [lost && lost.Buffering, lost && lost.Readings_Dropped], [false, 1]);

    // A line a power cut tore is counted, and the lines before it are replayed.
    const torn = makeGate();
    up(torn);
    torn(NBIRTH());
    torn(DISCONNECTED);
    const whole = torn(ddata(7, clock.t))[1][0].payload;
    clock.t += 61000;
    torn({ sf: 'tick' });
    torn(CONNECTED);
    torn(NBIRTH());
    clock.t += 2000;
    torn({ sf: 'tick' });
    torn({ sf: 'segment', segment: 1, payload: `${whole}\n{"topic":"spBv1.0/G/DDATA/N/press-01","metr` });
    expect('a torn line is counted as dropped and the whole ones are replayed',
      [pubs(torn({ sf: 'tick' })).length, torn.sf().carry], [1, 1]);

    // A restart finds the buffer and the bdSeq again, from the newer state file that parses.
    const before = makeGate();
    let saved = [];
    const keep = (res) => { saved = saved.concat(res[2]); return res; };
    keep(before({ sf: 'tick' }));
    keep(before({ sf: 'state', error: 'ENOENT' }));
    keep(before({ sf: 'state', error: 'ENOENT' }));
    keep(before({ sf: 'tick' }));
    keep(before(CONNECTED));
    keep(before(ddata(8, clock.t)));
    clock.t += 6000;
    keep(before({ sf: 'tick' }));
    const latest = saved[saved.length - 1];
    const after = makeGate();
    after({ sf: 'tick' });
    after({ sf: 'state', filename: latest.filename, payload: latest.payload });
    after({ sf: 'state', filename: 'older', payload: '{"gen":' });
    expect('the index alternates between two state files', saved.map((m) => m.filename).slice(-2).sort(),
      ['/data/buffer/state-0.json', '/data/buffer/state-1.json']);
    expect('a restart restores the buffered segment and the outage in progress',
      [after.sf().queue.length, Boolean(after.sf().outage)], [1, true]);
    const resumed = after({ sf: 'tick' })[0].find((m) => m.action === 'connect');
    expect('and goes on past the bdSeq its last accepted CONNECT used',
      resumed && decodeSparkplug(resumed.broker.will.payload).metrics[0].long_value, 1);
    const unused = makeGate();
    unused({ sf: 'tick' });
    unused({ sf: 'state', filename: latest.filename, payload: JSON.stringify(Object.assign(JSON.parse(latest.payload), { bdSeqUsed: false })) });
    unused({ sf: 'state', error: 'ENOENT' });
    const reused = unused({ sf: 'tick' })[0].find((m) => m.action === 'connect');
    expect('while one no broker accepted is used again',
      reused && decodeSparkplug(reused.broker.will.payload).metrics[0].long_value, 0);

    // The wire, byte for byte. These are what the daemon's protobuf module (sparkplug_b_pb2)
    // serialises for the same values, so the encoder here is checked against the reader there.
    clock.t = Date.UTC(2026, 9, 8, 12);
    const T0 = clock.t;
    const wire = makeGate();
    const opened = up(wire).opened[0].find((m) => m.action === 'connect');
    const wireBirth = wire({
      topic: 'spBv1.0/G/NBIRTH/N',
      payload: { timestamp: T0, metrics: [
        { name: 'Gateway_Status', datatype: 12, string_value: 'ONLINE' },
        { name: 'Uptime_s', datatype: 4, long_value: 4210 },
        { name: 'Load_1m', datatype: 10, double_value: 0.42 },
        { name: 'Agent_Version', datatype: 12, is_null: true },
      ] },
    })[0][0];
    const wireLive = wire({
      topic: 'spBv1.0/G/DDATA/N/press-01',
      payload: { timestamp: T0 - 1000, metrics: [
        { name: 'Temperature', datatype: 10, double_value: 21.5, timestamp: T0 - 1000 },
        { name: 'CycleCount', datatype: 7, int_value: 3 },
        { name: 'Running', datatype: 11, boolean_value: true, timestamp: T0 - 1000 },
      ] },
    })[0][0];
    wire(DISCONNECTED);
    clock.t += 1000;
    const wireLine = wire(ddata(22.5, clock.t))[1][0].payload;
    clock.t += 5000;
    wire({ sf: 'tick' });
    wire(CONNECTED);
    wire({ topic: 'spBv1.0/G/NBIRTH/N', payload: { timestamp: clock.t, metrics: [] } });
    clock.t += 2000;
    wire({ sf: 'tick' });
    wire({ sf: 'segment', segment: 1, payload: `${wireLine}\n` });
    const wireReplay = wire({ sf: 'tick' })[0][0];
    const hex = (m) => m && Buffer.from(m.payload).toString('hex');
    expect('the NDEATH is the bytes sparkplug_b_pb2 builds', hex(opened && opened.broker.will),
      '0880ec89db913412120a0562645365711880ec89db913420045800');
    expect('the NBIRTH, with a null and the declared outage report, is too', hex(wireBirth),
      '0880ec89db913412210a0e476174657761795f5374617475731880ec89db9134200c7a064f4e4c494e4512160a08557074696d655f731880ec89db9134200458f220121b0a074c6f61645f316d1880ec89db9134200a69e17a14ae47e1da3f121a0a0d4167656e745f56657273696f6e1880ec89db9134200c380112120a0562645365711880ec89db91342004580012210a144e6f646520436f6e74726f6c2f526562697274681880ec89db9134200b7000121e0a114f75746167652f537461727465645f41741880ec89db9134200d3801121c0a0f4f75746167652f456e6465645f41741880ec89db9134200d380112250a184f75746167652f52656164696e67735f42756666657265641880ec89db9134200a380112240a174f75746167652f52656164696e67735f44726f707065641880ec89db9134200a3801121d0a104f75746167652f427566666572696e671880ec89db9134200b38011800');
    expect('a live DDATA, every metric stamped with its reading\'s time, is too', hex(wireLive),
      '0880ec89db9134121f0a0b54656d70657261747572651898e489db9134200a69000000000080354012170a0a4379636c65436f756e741898e489db91342007500312140a0752756e6e696e671898e489db9134200b70011801');
    expect('and a replayed one, flagged is_historical, is too', hex(wireReplay),
      '08c0aa8adb913412210a0b54656d706572617475726518e8f389db9134200a28016900000000008036401801');

    // The wiring the behaviour above depends on.
    const node = (id) => byId[id] || {};
    expect('the broker node speaks MQTT 3.1.1 with a clean session, and does not connect on its own',
      [broker.protocolVersion, broker.cleansession, broker.autoConnect, broker.willTopic], ['4', true, false, '']);
    const keepaliveS = (gateNode.func.match(/const KEEPALIVE_S = (\d+);/) || [])[1];
    expect('its keepalive is the one store and forward sizes the re-send window by', broker.keepalive, keepaliveS);
    expect('commands and the primary host\'s STATE are subscribed at QoS 1',
      ['aber-ncmd-in', 'aber-dcmd-in', 'aber-state-in'].map((id) => node(id).qos), ['1', '1', '1']);
    expect('only store and forward is wired to the broker node, so one place stamps the seq',
      flow.filter((n) => (n.wires || []).some((p) => p.includes('aber-mqtt-out'))).map((n) => n.id), ['aber-sf']);
    expect('it hears the primary host\'s STATE', [node('aber-state-in').topic, node('aber-state-in').wires],
      ['spBv1.0/STATE/+', [['aber-sf']]]);
    expect('it hears the broker link', [node('aber-link-status').scope, node('aber-link-status').wires], [['aber-mqtt-out'], [['aber-sf']]]);
    expect('it hears the flow start', [node('aber-sf-start').once, node('aber-sf-start').wires], [true, [['aber-sf']]]);
    expect('a buffer file that is not there comes back to it',
      [node('aber-sf-catch').scope, node('aber-sf-catch').wires, node('aber-sf-read').wires], [['aber-sf-read'], [['aber-sf']], [['aber-sf']]]);
    expect('the file nodes append, overwrite and delete what they are named',
      ['aber-sf-append', 'aber-sf-save', 'aber-sf-delete'].map((id) => [node(id).overwriteFile, node(id).filenameType]),
      [['false', 'msg'], ['true', 'msg'], ['delete', 'msg']]);
    expect('its outputs reach the broker, the three file nodes, the reader and the heartbeat',
      gateNode.wires, [['aber-mqtt-out'], ['aber-sf-append'], ['aber-sf-save'], ['aber-sf-read'], ['aber-sf-delete'], ['aber-node-msg']]);

    const failed = checks.filter(([, good]) => !good);
    for (const [label, , got, want] of failed) {
      fail(`store and forward: ${label}\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`);
    }
    if (!failed.length) pass(`store and forward behaves as documented (${checks.length} assertions)`);
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
  `\n${TEMPLATE} compiles, types its metrics the way the daemon reads them, and is wired so the collector `
  + 'cannot take the heartbeat with it.'
);
