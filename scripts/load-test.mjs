#!/usr/bin/env node
/**
 * Provision a synthetic fleet, run the load generator against it, and take it away again.
 *
 *   node scripts/load-test.mjs up   --gateways 8 --devices-per-gateway 50
 *   node scripts/load-test.mjs run  --plan 100x90,250x90,500x90,1000x90 [--soak 1200] [--compress]
 *   node scripts/load-test.mjs run  --plan 500x300 --restart-ingestion-at 60 [--restart-hold 150]
 *   node scripts/load-test.mjs down [--purge-telemetry]
 *   node scripts/load-test.mjs status
 *
 * `up` writes rows straight into Supabase's database as the owner and issues one broker account per
 * synthetic gateway through the Dynamic Security plugin, the same commands
 * `scripts/mosquitto-provision-gateway.mjs` sends. `run` renders the chart's load-test Job and
 * applies it on its own, so no `helm upgrade` is involved and nothing is left enabled afterwards.
 *
 * The fleet is marked `is_simulated`, which is what that column means: telemetry generated rather
 * than observed. See test-harness/README.md for the method and what the run measures.
 *
 * `--restart-ingestion-at S` restarts the ingestion Deployment S seconds into the first step, as an
 * upgrade does, and afterwards compares the readings the generator took with the rows the historian
 * holds for the fleet between the first and the last of them (ingestion/README.md, "Loss model").
 * The generator's edge nodes wait for the primary host as an appliance does: while the daemon's
 * STATE is offline they buffer, and after it is back they birth again and replay with is_historical.
 * `--restart-hold H` scales the Deployment to zero for H seconds instead, a long gap such as an
 * image pull, so the buffers hold H seconds of readings.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertSafePassword, generatePassword } from './lib/mosquitto-credentials.mjs';
import { issueWithControl } from './lib/mosquitto-dynsec.mjs';
import { controlSender } from './lib/mosquitto-control.mjs';
import { NAMESPACE, RELEASE, missingCredentialAdvice, stackCredentials } from './lib/stack-credentials.mjs';

const CHART = 'deploy/helm/aber';
const DB_USER_NAME = process.env.DB_USER_NAME || 'postgres';
const DB_NAME = process.env.DB_NAME || 'postgres';
// `aber.fullname`: the release name when it already contains the chart's, otherwise both.
const FULLNAME = RELEASE.includes('aber') ? RELEASE : `${RELEASE}-aber`;
const SECRET = `${FULLNAME}-load-test`;
const JOB = `${FULLNAME}-load-test`;

const argv = process.argv.slice(2);
const command = argv.find((a) => !a.startsWith('-')) || '';

function option (name, fallback = null) {
  const exact = argv.indexOf(`--${name}`);
  if (exact >= 0 && argv[exact + 1] && !argv[exact + 1].startsWith('--')) return argv[exact + 1];
  const joined = argv.find((a) => a.startsWith(`--${name}=`));
  return joined ? joined.slice(name.length + 3) : fallback;
}
const flag = (name) => argv.includes(`--${name}`);

const die = (message) => { console.error(message); process.exit(1); };
const step = (message) => console.log(`\n=== ${message}`);

// The prefix reaches the database inside a LIKE pattern and names the broker accounts' gateways,
// so it is constrained rather than escaped.
const PREFIX = option('prefix', process.env.LOADGEN_PREFIX || 'LOADGEN');
if (!/^[A-Za-z0-9-]+$/.test(PREFIX)) die(`--prefix '${PREFIX}' must be letters, digits or '-'.`);
// `_` is a LIKE wildcard, and every fixture name carries three of them.
const LIKE = `${PREFIX}\\_%' ESCAPE '\\`;

// Node has no synchronous sleep, and this script is deliberately sequential.
function sleepSync (ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function kubectl (args, opts = {}) {
  return spawnSync('kubectl', ['-n', NAMESPACE, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
}

/** psql inside the Supabase database pod, as the owner, over the socket. */
function psql (sql) {
  const r = kubectl(['exec', 'statefulset/supabase-db', '-c', 'supabase-db', '--',
    'psql', '-U', DB_USER_NAME, '-d', DB_NAME, '-t', '-A', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
  if (r.status !== 0) die(`psql failed: ${(r.stderr || '').trim().split('\n').slice(-4).join(' ')}`);
  return r.stdout.trim();
}

/** The same, against the historian. It holds no directory, only rows keyed by sparkplug_id. */
function historian (sql) {
  const r = kubectl(['exec', 'statefulset/timescaledb', '-c', 'timescaledb', '--',
    'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * Statements fed to one historian session on stdin. psql autocommits each, so every statement is
 * its own transaction, and one that fails does not stop the rest. Returns the errors psql printed.
 */
function historianEach (statements) {
  const r = kubectl(['exec', '-i', 'statefulset/timescaledb', '-c', 'timescaledb', '--',
    'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=0'],
  { input: `${statements.join('\n')}\n` });
  if (r.status !== 0) return [`psql exited ${r.status}: ${(r.stderr || '').trim().split('\n').pop()}`];
  return (r.stderr || '').split('\n').filter((line) => line.includes('ERROR'));
}

const rows =(out) => (out ? out.split('\n').filter(Boolean).map((line) => line.split('\t')) : []);

/** The broker's control plane, reached inside the broker pod the way the break-glass CLI reaches it. */
function brokerControl () {
  const creds = stackCredentials(['MQTT_DYNSEC_ADMIN_USER', 'MQTT_DYNSEC_ADMIN_PASSWORD']);
  if (!creds.MQTT_DYNSEC_ADMIN_PASSWORD) die(missingCredentialAdvice('MQTT_DYNSEC_ADMIN_PASSWORD'));
  const names = kubectl(['get', 'pods', '-l', 'app.kubernetes.io/component=mosquitto',
    '--field-selector=status.phase=Running', '-o', 'jsonpath={.items[*].metadata.name}']).stdout || '';
  const pod = names.split(/\s+/).filter(Boolean)[0];
  if (!pod) die(`No Running mosquitto pod in namespace '${NAMESPACE}'.`);
  return controlSender(
    {
      host: '127.0.0.1',
      port: 1883,
      username: creds.MQTT_DYNSEC_ADMIN_USER || 'dynsec-admin',
      password: creds.MQTT_DYNSEC_ADMIN_PASSWORD,
    },
    ['kubectl', '-n', NAMESPACE, 'exec', pod, '-c', 'mosquitto', '--'],
  );
}

/** What the fixture currently is: its gateways, and how many devices each holds. */
function fleet () {
  return rows(psql(
    'SELECT g.sparkplug_id, g.name, count(d.id), g.sparkplug_group FROM gateways g ' +
    'LEFT JOIN devices d ON d.gateway_id = g.id ' +
    `WHERE g.name LIKE '${LIKE}' ` +
    'GROUP BY g.id, g.sparkplug_id, g.name, g.sparkplug_group ORDER BY g.name'
  )).map(([sparkplugId, name, devices, group]) => ({ sparkplugId, name, devices: Number(devices), group }));
}

/** The hypertable's size, which on a stack being load-tested is very nearly the fixture's. */
function historianSize () {
  const out = historian(
    "SELECT pg_size_pretty(hypertable_size('telemetry')), " +
    "(SELECT count(*) FROM timescaledb_information.chunks WHERE hypertable_name = 'telemetry')"
  );
  return out ? rows(out)[0] : null;
}

/**
 * The telemetry chunks the fixture's rows can be in: every chunk whose range ends after the first
 * fixture gateway was made. Each with its compressed relation where it has one: TimescaleDB 2.29
 * keeps a compressed chunk's rows beside it as <chunk>_compressed. `compressed` is '' for a chunk
 * that is not compressed, and undefined for a compressed one whose relation is not found that way.
 */
function fixtureChunks () {
  const since = psql(`SELECT min(created_at) FROM gateways WHERE name LIKE '${LIKE}'`);
  if (!/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?[+-]\d\d(:\d\d)?$/.test(since)) return null;
  const where = `WHERE c.hypertable_name = 'telemetry' AND c.range_end > '${since}'::timestamptz ORDER BY c.range_start`;
  const name = "format('%I.%I', c.chunk_schema, c.chunk_name)";
  const out = historian(
    `SELECT ${name}, c.is_compressed, ` +
    `coalesce(to_regclass(format('%I.%I', c.chunk_schema, c.chunk_name || '_compressed'))::text, '') ` +
    `FROM timescaledb_information.chunks c ${where}`);
  if (out === null) return null;
  const found = rows(out).map(([chunk, isCompressed, compressed]) =>
    ({ chunk, compressed: compressed || (isCompressed === 't' ? undefined : '') }));
  // Each becomes an identifier in a statement; format('%I') made them, the pattern holds them to it.
  return found.filter(({ chunk, compressed }) => [chunk, compressed].every((r) => !r || /^[A-Za-z0-9_."]+$/.test(r)));
}

/** pg_total_relation_size of each relation, as {name: pretty size}. */
function relationSizes (relations) {
  const list = relations.map((r) => `'${r.replaceAll("'", "''")}'`).join(',');
  const out = historian(`SELECT r, pg_size_pretty(pg_total_relation_size(r::regclass)) FROM unnest(ARRAY[${list}]) r`);
  return Object.fromEntries(rows(out));
}

/**
 * VACUUM FULL on the chunks the fixture wrote, and on their compressed relations: a DELETE returns
 * no disk, only a rewrite or a dropped chunk does. Each relation is locked while it is rewritten,
 * so ingestion into the current chunk waits for it.
 */
function vacuumFull (chunks) {
  if (chunks === null) {
    console.log('  NOT VACUUMED: the fixture\'s chunks could not be listed (its first gateway has no readable ' +
      'created_at, or the historian did not answer), so the deleted rows keep their disk. ' +
      'VACUUM FULL telemetry; rewrites every chunk.');
    return;
  }
  if (!chunks.length) {
    console.log('  no telemetry chunk was written after the fixture was made; nothing to VACUUM');
    return;
  }
  const relations = chunks.flatMap(({ chunk, compressed }) => (compressed ? [chunk, compressed] : [chunk]));
  const before = relationSizes(relations);
  console.log(`  VACUUM FULL on ${relations.length} relation(s); each is locked while it is rewritten`);
  const errors = historianEach(relations.map((r) => `VACUUM FULL ${r};`));
  const after = relationSizes(relations);
  for (const r of relations) console.log(`    ${r}: ${before[r] ?? '?'} -> ${after[r] ?? '?'}`);
  for (const { chunk } of chunks.filter(({ compressed }) => compressed === undefined)) {
    console.log(`    ${chunk}: compressed, but no ${chunk}_compressed relation was found beside it, ` +
      'so deleted compressed rows keep their disk until retention drops the chunk');
  }
  if (errors.length) {
    for (const error of errors.slice(0, 5)) console.error(`  ${error}`);
    process.exitCode = 1;
  }
}

// -------------------------------------------------------------------------------------------

function up () {
  const gateways = Number(option('gateways', '8'));
  const perGateway = Number(option('devices-per-gateway', '50'));
  if (!Number.isInteger(gateways) || gateways < 1) die('--gateways must be a positive integer');
  if (!Number.isInteger(perGateway) || perGateway < 1) die('--devices-per-gateway must be a positive integer');

  step(`Provisioning ${gateways} gateways x ${perGateway} devices as '${PREFIX}_...'`);
  // Idempotent by name: re-running to a larger shape adds what is missing and re-issues the
  // accounts, rather than doubling the fleet. `is_simulated` forbids a cell and requires
  // deployment 'host'; both are constraints on the table, not preferences.
  const gatewayName = `format('${PREFIX}_Gateway_%s', lpad(g::text, 3, '0'))`;
  psql(
    'INSERT INTO gateways (name, deployment, is_simulated) ' +
    `SELECT ${gatewayName}, 'host', true FROM generate_series(1, ${gateways}) g ` +
    `WHERE NOT EXISTS (SELECT 1 FROM gateways x WHERE x.name = ${gatewayName})`
  );
  psql(
    `WITH gw AS (SELECT id, name FROM gateways WHERE name LIKE '${LIKE}'), ` +
    "wanted AS (SELECT gw.id AS gateway_id, format('%s_Device_%s', gw.name, lpad(d::text, 4, '0')) AS name " +
    `FROM gw, generate_series(1, ${perGateway}) d) ` +
    'INSERT INTO devices (name, gateway_id) SELECT w.name, w.gateway_id FROM wanted w ' +
    'WHERE NOT EXISTS (SELECT 1 FROM devices x WHERE x.name = w.name)'
  );

  const provisioned = fleet();
  console.log(`  ${provisioned.length} gateways, ${provisioned.reduce((n, g) => n + g.devices, 0)} devices`);
  console.log(`  Sparkplug group: ${provisioned[0]?.group || '(none)'}`);

  step('Issuing one broker account per gateway');
  // ONE PASSWORD FOR THE WHOLE FIXTURE. These accounts are issued and deleted by this script
  // against a stack being deliberately loaded; a password each would have to travel to the Job as
  // a manifest rather than as one Secret key, and would protect nothing that outlives the run.
  const password = option('password') || generatePassword();
  try { assertSafePassword(password); } catch (err) { die(err.message); }
  const send = brokerControl();
  for (const gateway of provisioned) {
    try {
      const { replaced } = issueWithControl(send, gateway.sparkplugId, password);
      console.log(`  ${replaced ? 're-issued' : 'issued  '} ${gateway.sparkplugId}  (${gateway.name})`);
    } catch (err) {
      die(`Failed to issue '${gateway.sparkplugId}': ${err.message}`);
    }
  }

  step(`Storing the password in Secret ${SECRET}`);
  const manifest = kubectl(['create', 'secret', 'generic', SECRET,
    `--from-literal=LOADGEN_PASSWORD=${password}`, '--dry-run=client', '-o', 'json']);
  if (manifest.status !== 0) die(`could not render the Secret: ${manifest.stderr}`);
  const applied = kubectl(['apply', '-f', '-'], { input: manifest.stdout });
  if (applied.status !== 0) die(`could not apply the Secret: ${applied.stderr}`);
  console.log(`  ${applied.stdout.trim()}`);

  console.log(
    '\nThe fleet is provisioned and OFFLINE; nothing publishes until a run starts.\n' +
    '  node scripts/load-test.mjs run --plan 100x90,250x90,500x90,1000x90\n'
  );
}

// -------------------------------------------------------------------------------------------

/** The release's own values, so the rendered Job matches the stack it will load. */
function releaseValues () {
  const values = spawnSync('helm', ['get', 'values', RELEASE, '-n', NAMESPACE, '-a', '-o', 'json'],
    { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (values.status !== 0) {
    die(`helm get values ${RELEASE} -n ${NAMESPACE}: ${(values.stderr || '').trim()}\n` +
      '  Is the kube context right, and is the release installed?');
  }
  return values.stdout;
}

function run () {
  const plan = option('plan', '100x90,250x90,500x90,1000x90,2000x90');
  const metrics = Number(option('metrics-per-message', '10'));
  const settle = Number(option('settle', '15'));
  const soak = Number(option('soak', '0'));
  const compress = flag('compress');
  const restartAt = option('restart-ingestion-at') === null ? null : Number(option('restart-ingestion-at'));
  if (restartAt !== null && !(Number.isFinite(restartAt) && restartAt > 0)) {
    die('--restart-ingestion-at must be a number of seconds after the first step starts');
  }
  const hold = Number(option('restart-hold', '0'));
  if (!(Number.isFinite(hold) && hold >= 0)) die('--restart-hold must be a number of seconds, 0 or more');
  if (hold && restartAt === null) die('--restart-hold needs --restart-ingestion-at');
  if (!/^\s*\d+(\.\d+)?x\d+(\.\d+)?(\s*,\s*\d+(\.\d+)?x\d+(\.\d+)?)*\s*$/.test(plan)) {
    die(`--plan '${plan}' must be <rate>x<seconds> steps, comma separated`);
  }
  if (!Number.isFinite(soak) || soak < 0) die('--soak must be a number of seconds, 0 or more');
  const present = fleet();
  if (present.length === 0) die(`No '${PREFIX}_' fleet exists. Run: node scripts/load-test.mjs up`);

  const seconds = plan.split(',').reduce((total, part) => total + Number(part.split('x')[1]), 0) + soak;
  console.log(`Fleet: ${present.length} gateways, ${present.reduce((n, g) => n + g.devices, 0)} devices`);
  console.log(`Plan:  ${plan}${soak ? `, then a ${soak} s soak of the last step that held` : ''}` +
    `  (${Math.round(seconds / 60)} minutes of steps)${compress ? '; the run\'s chunks are compressed after it' : ''}`);

  step('Rendering the load-test Job from the chart');
  const scratch = mkdtempSync(join(tmpdir(), 'aber-load-'));
  const valuesPath = join(scratch, 'release-values.json');
  const overridePath = join(scratch, 'load-test.yaml');
  writeFileSync(valuesPath, releaseValues());
  writeFileSync(overridePath,
    'loadTest:\n' +
    '  enabled: true\n' +
    `  plan: ${JSON.stringify(plan)}\n` +
    `  metricsPerMessage: ${metrics}\n` +
    `  settleSeconds: ${settle}\n` +
    `  soakSeconds: ${soak}\n` +
    `  compress: ${compress}\n` +
    `  prefix: ${JSON.stringify(PREFIX)}\n` +
    `  credentialSecret: ${JSON.stringify(SECRET)}\n`);

  const rendered = spawnSync('helm', ['template', RELEASE, CHART, '-n', NAMESPACE,
    '-f', valuesPath, '-f', overridePath,
    '--show-only', 'templates/jobs/load-test-job.yaml'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (rendered.status !== 0) die(`helm template failed: ${(rendered.stderr || '').trim()}`);

  // A Job's pod template is immutable, so a previous run left in place refuses the apply with
  // `field is immutable` rather than starting.
  kubectl(['delete', 'job', JOB, '--ignore-not-found']);
  const applied = kubectl(['apply', '-f', '-'], { input: rendered.stdout });
  if (applied.status !== 0) die(`could not apply the Job: ${applied.stderr}`);
  console.log(`  ${applied.stdout.trim()}`);

  step('Waiting for the generator to start');
  // `kubectl wait` on a LABEL SELECTOR exits non-zero the moment it matches nothing, rather than
  // waiting for something to match -- and the Job controller has not created the pod yet when the
  // apply returns. The first run of this script raced exactly there and printed the Job's events
  // for a pod that was starting normally. So wait for the pod to EXIST first, by name.
  let podName = '';
  const appears = Date.now() + 120_000;
  while (Date.now() < appears) {
    const found = kubectl(['get', 'pods', '-l', `job-name=${JOB}`,
      '-o', 'jsonpath={.items[0].metadata.name}']);
    podName = (found.stdout || '').trim();
    if (podName) break;
    sleepSync(2000);
  }
  if (!podName) {
    console.error(`  no pod was created for the Job within 120s; the Job's events:`);
    kubectl(['describe', 'job', JOB], { stdio: 'inherit' });
    process.exit(1);
  }
  const ready = kubectl(['wait', '--for=condition=ready', `pod/${podName}`, '--timeout=10m'],
    { stdio: 'inherit' });
  if (ready.status !== 0) {
    console.error('  the pod did not become ready; the Job\'s events:');
    kubectl(['describe', 'job', JOB], { stdio: 'inherit' });
    process.exit(1);
  }

  step('Load run (the generator streams its own report)');
  if (restartAt === null) {
    spawnSync('kubectl', ['-n', NAMESPACE, 'logs', '-f', `job/${JOB}`], { stdio: 'inherit' });
    return finish(seconds);
  }
  return streamWithRestart(restartAt, hold).then(({ output, restart }) => {
    finish(seconds);
    compareWithHistorian(output, restart);
  });
}

function finish (seconds) {
  const finished = kubectl(['wait', '--for=condition=complete', `job/${JOB}`,
    `--timeout=${Math.ceil(seconds / 60) + 20}m`]);
  if (finished.status !== 0) {
    console.error(`\nThe run did not complete. kubectl -n ${NAMESPACE} logs job/${JOB}`);
    process.exit(1);
  }
  console.log(
    `\nThe Job is kept for its output: kubectl -n ${NAMESPACE} logs job/${JOB}\n` +
    '  node scripts/load-test.mjs down   to take the fleet away\n'
  );
}

/** A command run to completion without blocking the log stream. */
function runAsync (cmd, args) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Restart the ingestion Deployment as an upgrade does (Recreate: the old pod stops, then the new one
 * starts), or with `hold` keep it at zero that many seconds, and time it to the line the new daemon
 * logs once it is subscribed.
 */
async function restartIngestion (hold) {
  const started = Date.now();
  if (hold) {
    console.log(`\n=== Stopping the ingestion Deployment for ${hold} s (${new Date(started).toISOString()})`);
    const down = await runAsync('kubectl', ['-n', NAMESPACE, 'scale', 'deployment/ingestion', '--replicas=0']);
    if (down.status !== 0) return { error: `scaling to 0 failed: ${down.stderr.trim()}` };
    await sleep(hold * 1000);
    const up = await runAsync('kubectl', ['-n', NAMESPACE, 'scale', 'deployment/ingestion', '--replicas=1']);
    if (up.status !== 0) return { error: `scaling back to 1 failed: ${up.stderr.trim()}` };
  } else {
    console.log(`\n=== Restarting the ingestion Deployment (${new Date(started).toISOString()})`);
    const restarted = await runAsync('kubectl', ['-n', NAMESPACE, 'rollout', 'restart', 'deployment/ingestion']);
    if (restarted.status !== 0) return { error: `rollout restart failed: ${restarted.stderr.trim()}` };
  }
  while (Date.now() - started < 600_000 + hold * 1000) {
    await sleep(2000);
    const pods = await runAsync('kubectl', ['-n', NAMESPACE, 'get', 'pods',
      '-l', 'app.kubernetes.io/component=ingestion', '-o',
      'jsonpath={range .items[*]}{.metadata.name}{" "}{.metadata.creationTimestamp}{"\\n"}{end}']);
    const fresh = pods.stdout.split('\n').map((l) => l.trim().split(' '))
      .filter(([name, created]) => name && Date.parse(created) >= started - 1000);
    for (const [name] of fresh) {
      const logs = await runAsync('kubectl', ['-n', NAMESPACE, 'logs', name]);
      if (logs.stdout.includes("Subscribed to 'spBv1.0/#'")) {
        const seconds = (Date.now() - started) / 1000;
        console.log(`=== The new daemon (${name}) is subscribed, ${seconds.toFixed(0)} s after the restart ` +
          '(to within the 2 s poll)\n');
        return { pod: name, seconds };
      }
    }
  }
  return { error: 'the new ingestion pod did not log that it subscribed within 10 minutes' };
}

/** Stream the generator's output, and restart ingestion `restartAt` seconds into its first step. */
function streamWithRestart (restartAt, hold) {
  return new Promise((done) => {
    const logs = spawn('kubectl', ['-n', NAMESPACE, 'logs', '-f', `job/${JOB}`],
      { stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    let restart = null;
    let timer = null;
    logs.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      output += chunk;
      if (!timer && output.includes('Step: ')) {
        timer = setTimeout(() => { restart = restartIngestion(hold); }, restartAt * 1000);
      }
    });
    logs.on('close', async () => {
      if (timer && !restart) clearTimeout(timer);
      done({ output, restart: restart ? await restart : { error: 'the run ended before the restart was due' } });
    });
  });
}

/** Readings the generator took, against the rows the historian holds for the fleet in that window. */
function compareWithHistorian (output, restart) {
  step('Readings sent against readings stored');
  const line = output.split('\n').find((l) => l.startsWith('TOTALS '));
  if (!line) die('the generator printed no TOTALS line, so there is nothing to compare (is its image from this checkout?)');
  const totals = JSON.parse(line.slice('TOTALS '.length));
  if (restart?.error) console.log(`  the restart: ${restart.error}`);
  if (!Number.isFinite(totals.first_ms) || !Number.isFinite(totals.last_ms)) die('the generator published no DDATA');
  const ids = rows(psql(
    'SELECT d.sparkplug_id FROM devices d JOIN gateways g ON g.id = d.gateway_id ' +
    `WHERE g.name LIKE '${LIKE}' AND d.sparkplug_id IS NOT NULL`
  )).map(([id]) => id).filter((id) => /^[A-Za-z0-9]+$/.test(id));
  const counted = historian(
    `SELECT count(*) FROM telemetry WHERE asset_id IN (${ids.map((id) => `'${id}'`).join(',')}) ` +
    `AND time >= to_timestamp(${totals.first_ms} / 1000.0) AND time <= to_timestamp(${totals.last_ms} / 1000.0)`
  );
  const stored = counted === null ? NaN : Number(counted);
  if (!Number.isFinite(stored)) die('the historian did not answer the count');
  // Every reading the edge nodes took, whether published at once or buffered and replayed.
  const sent = totals.readings_taken;
  const lost = sent - stored;
  const each = totals.metrics_per_message;
  console.log(`  taken   ${sent.toLocaleString()} readings (${totals.ddata_taken.toLocaleString()} DDATA x ${each})`);
  console.log(`  stored  ${stored.toLocaleString()}`);
  console.log(`  lost    ${lost.toLocaleString()} (${sent ? ((100 * lost) / sent).toFixed(3) : '0'} %)`);
  if (restart?.seconds !== undefined) {
    console.log(`  gap     ${restart.seconds.toFixed(0)} s from the restart to the new daemon subscribed`);
  }
  console.log(`  edge    primary host ${totals.primary_host || '(none: the edge nodes did not wait for one)'}; ` +
    `${totals.sessions_restarted} session(s) restarted, ${totals.host_departures ?? 0} of them on an offline STATE`);
  console.log(`          ${(totals.ddata_buffered * each).toLocaleString()} readings buffered, ` +
    `${(totals.ddata_replayed * each).toLocaleString()} replayed with is_historical, ` +
    `${(totals.ddata_dropped_from_buffer * each).toLocaleString()} dropped from a full buffer, ` +
    `${(totals.ddata_still_buffered * each).toLocaleString()} still buffered at the end`);
  console.log(lost === 0
    ? '\nVERDICT: the restart of ingestion under load lost nothing.'
    : `\nVERDICT: ${lost.toLocaleString()} readings were lost across the restart.`);
  if (lost !== 0) process.exitCode = 1;
}

// -------------------------------------------------------------------------------------------

function down () {
  const present = fleet();
  if (present.length === 0) { console.log(`No '${PREFIX}_' fleet exists.`); return; }

  step(`Removing ${present.length} gateways and ${present.reduce((n, g) => n + g.devices, 0)} devices`);
  if (flag('purge-telemetry')) {
    // Generated by the database as letters and hex; checked anyway, since each becomes a literal.
    const ids = rows(psql(
      'SELECT d.sparkplug_id FROM devices d JOIN gateways g ON g.id = d.gateway_id ' +
      `WHERE g.name LIKE '${LIKE}' AND d.sparkplug_id IS NOT NULL`
    )).map(([id]) => id).filter((id) => /^[A-Za-z0-9]+$/.test(id));
    if (ids.length) {
      // Read before the delete: the chunks written since the fixture was provisioned.
      const chunks = fixtureChunks();
      // One asset per statement, each its own transaction, the id a literal: TimescaleDB
      // decompresses only the batches whose asset_id segment matches a constant, and caps what one
      // transaction may decompress (docs/testing.md, "What validate.py leaves behind").
      const list = ids.map((id) => `'${id}'`).join(',');
      const errors = historianEach([
        ...ids.map((id) => `DELETE FROM telemetry WHERE asset_id = '${id}';`),
        `DELETE FROM assets a WHERE a.asset_id IN (${list}) ` +
          'AND NOT EXISTS (SELECT 1 FROM telemetry t WHERE t.asset_id = a.asset_id);',
      ]);
      const kept = Number(historian(`SELECT count(*) FROM assets WHERE asset_id IN (${list})`) ?? ids.length);
      if (errors.length || kept) {
        for (const error of errors.slice(0, 5)) console.error(`  ${error}`);
        console.error(`  ${kept} of ${ids.length} fixture assets still hold historian rows`);
        process.exitCode = 1;
      } else {
        console.log(`  the fixture's telemetry is deleted (${ids.length} assets)`);
      }
      vacuumFull(chunks);
    }
  } else {
    const size = historianSize();
    if (size) {
      console.log(`  the historian keeps its rows: telemetry is ${size[0]} across ${size[1]} chunks`);
      console.log('  --purge-telemetry deletes the fixture\'s; retention drops them on its own schedule');
    }
  }

  psql(`DELETE FROM devices WHERE gateway_id IN (SELECT id FROM gateways WHERE name LIKE '${LIKE}')`);
  psql(`DELETE FROM gateways WHERE name LIKE '${LIKE}'`);

  step('Deleting the broker accounts');
  // deleteClient, not disableClient: a disabled account with no gateway row reads as an orphan on
  // the Access Control page forever. The per-gateway ROLE is left behind -- nothing in this
  // repository sends deleteRole, which takes a 2.0.x broker down (mosquitto/README.md).
  const send = brokerControl();
  for (const gateway of present) {
    const response = send({ command: 'deleteClient', username: gateway.sparkplugId });
    console.log(`  ${response.error ? `${gateway.sparkplugId}: ${response.error}` : `deleted ${gateway.sparkplugId}`}`);
  }

  kubectl(['delete', 'secret', SECRET, '--ignore-not-found']);
  kubectl(['delete', 'job', JOB, '--ignore-not-found']);
  console.log('\nThe fixture is gone.');
}

function status () {
  const present = fleet();
  if (present.length === 0) { console.log(`No '${PREFIX}_' fleet exists.`); return; }
  console.log(`${present.length} gateways under '${PREFIX}_', Sparkplug group ${present[0].group}:`);
  for (const gateway of present) {
    console.log(`  ${gateway.sparkplugId}  ${gateway.name}  ${gateway.devices} devices`);
  }
  const size = historianSize();
  if (size) console.log(`\nHistorian: telemetry is ${size[0]} across ${size[1]} chunks.`);
  const job = kubectl(['get', 'job', JOB, '-o', 'jsonpath={.status.conditions[*].type}']);
  if (job.status === 0) console.log(`\nJob ${JOB}: ${job.stdout || 'running'}`);
}

const commands = { up, run, down, status };
if (!commands[command]) {
  console.error(
    'Usage: node scripts/load-test.mjs <up|run|down|status> [options]\n\n' +
    '  up    --gateways N --devices-per-gateway M [--prefix LOADGEN] [--password ...]\n' +
    '  run   --plan 100x90,250x90 [--metrics-per-message 10] [--settle 15] [--soak SECONDS] [--compress]\n' +
    '        [--restart-ingestion-at SECONDS [--restart-hold SECONDS]]\n' +
    '  down  [--purge-telemetry]\n' +
    '  status\n'
  );
  process.exit(2);
}
const result = commands[command]();
if (result instanceof Promise) result.catch((err) => die(err.stack || String(err)));
