#!/usr/bin/env node
/**
 * Rehearse the historian's physical backup and point-in-time restore at a stated size, and time it.
 *
 *   node scripts/rehearse-historian-restore.mjs                          # the default fleet, 14 days
 *   node scripts/rehearse-historian-restore.mjs --devices 1000 --days 2  # a larger fleet, fewer days
 *   node scripts/rehearse-historian-restore.mjs --keep-data              # leave the synthetic rows
 *   node scripts/rehearse-historian-restore.mjs --backup-first           # recovery replays the fill
 *
 * Against the cluster kubectl points at, with timescaledb.physicalBackup on. DESTRUCTIVE: it wipes
 * the historian's data directory and restores it, so everything written after the target moment is
 * lost. A development stack, never a site.
 *
 *   1. Fill: synthetic telemetry for --devices x --metrics every --step-seconds over the last --days,
 *      under asset ids REHEARSAL-*, then compress it as the policy would and materialise the rollups.
 *   2. Back up: a full backup through the sidecar, timed, with the repository's size. With
 *      --backup-first it is taken before the fill instead, so recovery replays every row of it
 *      from the archived WAL: the measure of replay, which bounds a restore to a moment long after
 *      the last backup.
 *   3. Mark: a row before a target moment and a row after it; the WAL holding both is archived.
 *   4. Lose it: the historian stops and its data volume is emptied.
 *   5. Restore to the target with scripts/restore-historian.mjs, timed.
 *   6. Verify: the synthetic rows and the rollups are as they were, the first marker is back, the
 *      second is not.
 *
 * Prints the figures, and writes them as JSON with --out FILE. Results and method:
 * test-harness/README.md, "Restoring the historian".
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const NAMESPACE = process.env.ABER_NAMESPACE || 'aber';
const POD = 'timescaledb-0';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
};
const flag = (name) => argv.includes(`--${name}`);
const int = (name, fallback) => {
  const v = Number(option(name, fallback));
  if (!Number.isInteger(v) || v <= 0) die(`--${name} must be a positive integer.`);
  return v;
};
const die = (message) => { console.error(`\n${message}`); process.exit(1); };
const step = (message) => console.log(`\n=== ${message}`);
const seconds = (from) => Math.round((Date.now() - from) / 100) / 10;

const DAYS = int('days', 14);
const DEVICES = int('devices', 100);
const METRICS = int('metrics', 10);
const STEP = int('step-seconds', 30);
const ROWS_PER_DAY = DEVICES * METRICS * Math.floor(86400 / STEP);

function kubectl (args, { input, allowFail = false } = {}) {
  const r = spawnSync('kubectl', ['-n', NAMESPACE, ...args], {
    input, encoding: 'utf8', maxBuffer: 1 << 26, env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
  if (r.status !== 0 && !allowFail) die(`kubectl ${args.slice(0, 6).join(' ')} failed:\n${r.stderr || r.stdout}`);
  return r;
}

/** One script through psql in the server's container; -At output. Variables via -v, SQL on stdin. */
function sql (text, vars = {}) {
  const v = Object.entries(vars).flatMap(([k, val]) => ['-v', `${k}=${val}`]);
  return kubectl(['exec', '-i', POD, '-c', 'timescaledb', '--', 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1',
    '-U', 'postgres', '-d', 'postgres', '-At', ...v, '-f', '-'], { input: text }).stdout.trim();
}
const pgbackrest = (...args) =>
  kubectl(['exec', POD, '-c', 'pgbackrest', '--', 'pgbackrest', '--stanza=historian', ...args]);

const sts = JSON.parse(kubectl(['get', 'statefulset', 'timescaledb', '-o', 'json']).stdout);
if (!sts.spec.template.spec.containers.some((c) => c.name === 'pgbackrest')) {
  die('timescaledb has no pgbackrest container: install with timescaledb.physicalBackup.enabled=true.');
}

// Sums as numeric, which is exact: a float8 sum depends on the order rows are read in, and that
// order is not the same after a restore.
const FINGERPRINT = `
SELECT count(*) || ' rows, sum ' || sum(val_double::numeric)
  FROM telemetry WHERE asset_id LIKE 'REHEARSAL-%' AND asset_id <> 'REHEARSAL-MARKER';
SELECT 'telemetry_1m ' || count(*) || ' buckets, sum ' || sum(sum_double::numeric)
  FROM telemetry_1m WHERE asset_id LIKE 'REHEARSAL-%' AND asset_id <> 'REHEARSAL-MARKER';
SELECT 'telemetry_1h ' || count(*) || ' buckets' FROM telemetry_1h WHERE asset_id LIKE 'REHEARSAL-%' AND asset_id <> 'REHEARSAL-MARKER';
`;

const result = { devices: DEVICES, metrics: METRICS, step_seconds: STEP, days: DAYS, rows_per_day: ROWS_PER_DAY, backup_first: flag('backup-first') };
if (flag('backup-first')) fullBackup();
const walBefore = sql('SELECT pg_current_wal_lsn()');

step(`fill: ${DEVICES} devices x ${METRICS} metrics every ${STEP}s for ${DAYS} days = ${(ROWS_PER_DAY * DAYS).toLocaleString()} rows`);
sql(`INSERT INTO assets (asset_id, asset_name)
     SELECT 'REHEARSAL-' || lpad(d::text, 5, '0'), 'restore rehearsal ' || d FROM generate_series(1, :devices) d
     ON CONFLICT (asset_id) DO NOTHING;
     INSERT INTO assets (asset_id, asset_name) VALUES ('REHEARSAL-MARKER', 'restore rehearsal marker')
     ON CONFLICT (asset_id) DO NOTHING;`, { devices: DEVICES });
const fillStarted = Date.now();
// Whole days back from the last whole hour, so every chunk but the newest is closed and compressible.
const end = sql("SELECT date_trunc('hour', now()) - interval '1 hour'");
for (let d = DAYS; d >= 1; d -= 1) {
  const t = Date.now();
  sql(`INSERT INTO telemetry (time, asset_id, metric_name, val_double)
       SELECT t, 'REHEARSAL-' || lpad(dev::text, 5, '0'), 'metric_' || m,
              dev * 10 + m + sin(extract(epoch FROM t) / 600.0)
         FROM generate_series(:'end'::timestamptz - (:day * interval '1 day'),
                              :'end'::timestamptz - ((:day - 1) * interval '1 day') - interval '1 microsecond',
                              make_interval(secs => :step)) t,
              generate_series(1, :devices) dev, generate_series(1, :metrics) m;`,
  { end, day: d, step: STEP, devices: DEVICES, metrics: METRICS });
  console.log(`  day ${DAYS - d + 1}/${DAYS}: ${seconds(t)}s`);
}
result.fill_seconds = seconds(fillStarted);

step('materialise the rollups, and compress what each policy would');
let t = Date.now();
for (const view of ['telemetry_1m', 'telemetry_5m', 'telemetry_1h']) {
  sql(`CALL refresh_continuous_aggregate('${view}', :'end'::timestamptz - (:days * interval '1 day') - interval '1 hour', :'end'::timestamptz);`,
    { end, days: DAYS });
}
result.rollup_seconds = seconds(t);
// The raw hypertable and, where their policies exist, the rollups.
t = Date.now();
sql(`SELECT count(compress_chunk(c, if_not_compressed => true))
       FROM timescaledb_information.jobs j,
            show_chunks(format('%I.%I', j.hypertable_schema, j.hypertable_name)::regclass,
                        older_than => now() - (j.config ->> 'compress_after')::interval) c
      WHERE j.proc_name = 'policy_compression';`);
result.compress_seconds = seconds(t);
result.database_bytes = Number(sql('SELECT pg_database_size(current_database())'));
result.database = sql('SELECT pg_size_pretty(pg_database_size(current_database()))');
const before = sql(FINGERPRINT);
console.log(`  historian is ${result.database}\n  ${before.split('\n').join('\n  ')}`);

function fullBackup () {
  step('full backup');
  const t = Date.now();
  pgbackrest('--type=full', 'backup');
  result.backup_seconds = seconds(t);
  const info = JSON.parse(pgbackrest('--output=json', 'info').stdout)[0];
  const last = info.backup.at(-1);
  result.backup_label = last.label;
  result.backup_repository_bytes = last.info.repository.delta;
  result.backup_database_bytes = last.info.size;
  console.log(`  ${last.label}: ${result.backup_seconds}s, ${(last.info.size / 2 ** 30).toFixed(2)} GiB read, `
    + `${(last.info.repository.delta / 2 ** 30).toFixed(2)} GiB written`);
}
if (!flag('backup-first')) fullBackup();

step('mark a moment, and write past it');
sql("INSERT INTO telemetry (time, asset_id, metric_name, val_double) VALUES (now(), 'REHEARSAL-MARKER', 'before_target', 1);");
const target = sql("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'");
spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 2000)']);
sql("INSERT INTO telemetry (time, asset_id, metric_name, val_double) VALUES (now(), 'REHEARSAL-MARKER', 'after_target', 1);");
result.wal_bytes = Number(sql(`SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), '${walBefore}')`));
const segment = sql('SELECT pg_walfile_name(pg_switch_wal())');
for (let i = 0; ; i += 1) {
  const archived = sql('SELECT last_archived_wal FROM pg_stat_archiver');
  if (archived && archived >= segment) break;
  if (i > 60) die(`WAL segment ${segment} was not archived within two minutes; the restore could not reach the target.`);
  spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 2000)']);
}
console.log(`  target ${target}; WAL up to ${segment} archived`);
const timelineBefore = Number(sql('SELECT timeline_id FROM pg_control_checkpoint()'));

step('lose it: stop the historian and empty its data volume');
kubectl(['scale', 'statefulset', 'timescaledb', '--replicas=0']);
kubectl(['wait', '--for=delete', `pod/${POD}`, '--timeout=300s'], { allowFail: true });
const wipe = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'timescaledb-rehearsal-wipe' },
  spec: {
    restartPolicy: 'Never',
    securityContext: { runAsUser: 70, runAsGroup: 70, fsGroup: 70 },
    containers: [{
      name: 'wipe', image: sts.spec.template.spec.containers[0].image,
      command: ['/bin/sh', '-c', 'rm -rf /var/lib/postgresql/data/pgdata /var/lib/postgresql/data/pgbackrest-spool && ls -A /var/lib/postgresql/data'],
      volumeMounts: [{ name: 'data', mountPath: '/var/lib/postgresql/data' }],
    }],
    volumes: [{ name: 'data', persistentVolumeClaim: { claimName: `data-${POD}` } }],
  },
};
kubectl(['delete', 'pod', wipe.metadata.name, '--ignore-not-found', '--wait=true']);
kubectl(['apply', '-f', '-'], { input: JSON.stringify(wipe) });
kubectl(['wait', '--for=jsonpath={.status.phase}=Succeeded', `pod/${wipe.metadata.name}`, '--timeout=300s']);
kubectl(['delete', 'pod', wipe.metadata.name, '--wait=false']);
console.log('  the data directory is gone');

step(`restore to ${target}`);
t = Date.now();
const restore = spawnSync(process.execPath, ['scripts/restore-historian.mjs', '--target', target, '--yes'], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], env: process.env,
});
process.stdout.write(restore.stdout);
if (restore.status !== 0) die('the restore failed; see above.');
result.restore_total_seconds = seconds(t);
result.restore_seconds = Number(restore.stdout.match(/restore\s+(\d+)s/)?.[1]);
result.recovery_seconds = Number(restore.stdout.match(/recovery\s+(\d+)s/)?.[1]);

step('verify');
const after = sql(FINGERPRINT);
const markers = sql("SELECT string_agg(metric_name, ',' ORDER BY metric_name) FROM telemetry WHERE asset_id = 'REHEARSAL-MARKER'");
const timelineAfter = Number(sql('SELECT timeline_id FROM pg_control_checkpoint()'));
const checks = [
  ['the synthetic rows and rollups are as they were', after === before, `${after}`],
  ['the row written before the target is back', markers.includes('before_target'), markers || '(none)'],
  ['the row written after the target is not', !markers.includes('after_target'), markers || '(none)'],
  ['recovery promoted onto a new timeline', timelineAfter > timelineBefore, `${timelineBefore} -> ${timelineAfter}`],
];
for (const [what, ok, detail] of checks) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}: ${detail}`);
result.verified = checks.every(([, ok]) => ok);

if (!flag('keep-data')) {
  step('remove the synthetic rows');
  sql(`DELETE FROM telemetry WHERE asset_id LIKE 'REHEARSAL-%';
       CALL refresh_continuous_aggregate('telemetry_1m', :'end'::timestamptz - (:days * interval '1 day') - interval '1 hour', now());
       CALL refresh_continuous_aggregate('telemetry_5m', :'end'::timestamptz - (:days * interval '1 day') - interval '1 hour', now());
       CALL refresh_continuous_aggregate('telemetry_1h', :'end'::timestamptz - (:days * interval '1 day') - interval '1 hour', now());
       DELETE FROM assets WHERE asset_id LIKE 'REHEARSAL-%';`, { end, days: DAYS });
}

const gib = (b) => (b / 2 ** 30).toFixed(2);
console.log(`
Historian ${result.database} (${gib(result.database_bytes)} GiB), ${(ROWS_PER_DAY * DAYS).toLocaleString()} synthetic rows over ${DAYS} days
  full backup   ${result.backup_seconds}s, ${gib(result.backup_repository_bytes)} GiB in the repository
  restore       ${result.restore_seconds}s writing the data directory
  recovery      ${result.recovery_seconds}s replaying WAL to the target and promoting${result.backup_first ? ` (${gib(result.wal_bytes)} GiB of WAL, written after the backup)` : ''}
  end to end    ${result.restore_total_seconds}s from the decision to restore to a writable historian
  ${result.verified ? 'verified' : 'NOT VERIFIED'}`);
const out = option('out', null);
if (out) writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
process.exit(result.verified ? 0 : 1);
