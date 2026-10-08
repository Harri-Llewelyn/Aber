#!/usr/bin/env node
/**
 * Rehearse the platform database's physical backup and point-in-time restore, and time it.
 *
 *   node scripts/rehearse-platform-restore.mjs                    # the database as it is
 *   node scripts/rehearse-platform-restore.mjs --fill-mib 2048    # grown by 2 GiB of synthetic rows first
 *   node scripts/rehearse-platform-restore.mjs --out rehearsal.json
 *
 * Against the cluster kubectl points at, with supabaseDb.physicalBackup on. DESTRUCTIVE: it wipes
 * the platform database's data directory and restores it, so everything written after the target
 * moment is lost, sign-ins included. A development stack, never a site. The historian's
 * counterpart is scripts/rehearse-historian-restore.mjs.
 *
 *   1. Seed: a schema of its own (`rehearsal`), with --fill-mib of padding rows, and a Vault
 *      secret, the canary, whose plaintext only this run knows.
 *   2. Back up: a full backup through the sidecar's own script, timed, with the repository's size.
 *   3. Mark: a row before a target moment and a row after it; the WAL holding both is archived.
 *   4. Lose it: the server stops and its data volume is emptied, pgsodium's root key with it.
 *   5. Restore to the target with scripts/restore-platform-db.mjs, timed.
 *   6. Verify: the first marker is back and the second is not, the canary decrypts to its
 *      plaintext under the root key the backup carried, and recovery promoted onto a new timeline.
 *
 * Prints the figures, and writes them as JSON with --out FILE. Results and method:
 * test-harness/README.md, "Restoring the platform database".
 */
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const NAMESPACE = process.env.ABER_NAMESPACE || 'aber';
const STS = 'supabase-db';
const POD = `${STS}-0`;

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
};
const flag = (name) => argv.includes(`--${name}`);
const die = (message) => { console.error(`\n${message}`); process.exit(1); };
const step = (message) => console.log(`\n=== ${message}`);
const seconds = (from) => Math.round((Date.now() - from) / 100) / 10;
const pause = (ms) => spawnSync(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`]);

const FILL_MIB = Number(option('fill-mib', '0'));
if (!Number.isInteger(FILL_MIB) || FILL_MIB < 0) die('--fill-mib must be a whole number of MiB, 0 or more.');

function kubectl (args, { input, allowFail = false } = {}) {
  const r = spawnSync('kubectl', ['-n', NAMESPACE, ...args], {
    input, encoding: 'utf8', maxBuffer: 1 << 26, env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
  if (r.status !== 0 && !allowFail) die(`kubectl ${args.slice(0, 6).join(' ')} failed:\n${r.stderr || r.stdout}`);
  return r;
}

/** One script through psql in the server's container, as supabase_admin; -At output, SQL on stdin. */
function sql (text, vars = {}) {
  const v = Object.entries(vars).flatMap(([k, val]) => ['-v', `${k}=${val}`]);
  return kubectl(['exec', '-i', POD, '-c', STS, '--', 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1',
    '-h', '/var/run/postgresql', '-U', 'supabase_admin', '-d', 'postgres', '-At', ...v, '-f', '-'], { input: text }).stdout.trim();
}
const pgbackrest = (...args) =>
  kubectl(['exec', POD, '-c', 'pgbackrest', '--', 'pgbackrest', '--stanza=platform', ...args]);

const sts = JSON.parse(kubectl(['get', 'statefulset', STS, '-o', 'json']).stdout);
const server = sts.spec.template.spec.containers.find((c) => c.name === STS);
if (!sts.spec.template.spec.containers.some((c) => c.name === 'pgbackrest')) {
  die(`${STS} has no pgbackrest container: install with supabaseDb.physicalBackup.enabled=true.`);
}

const result = { fill_mib: FILL_MIB };
const canary = randomBytes(18).toString('base64url');
const canaryName = `rehearsal_canary_${Date.now()}`;

step(`seed: the rehearsal schema${FILL_MIB ? `, ${FILL_MIB} MiB of padding` : ''} and a Vault canary`);
sql(`CREATE SCHEMA IF NOT EXISTS rehearsal;
     CREATE TABLE IF NOT EXISTS rehearsal.marks (what text PRIMARY KEY, at timestamptz NOT NULL DEFAULT clock_timestamp());
     CREATE TABLE IF NOT EXISTS rehearsal.padding (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, body text NOT NULL);
     TRUNCATE rehearsal.marks;`);
let t = Date.now();
// About 1 KiB a row after the tuple header, in batches the WAL can keep up with.
for (let done = 0; done < FILL_MIB; done += 64) {
  const mib = Math.min(64, FILL_MIB - done);
  sql(`INSERT INTO rehearsal.padding (body)
       SELECT repeat(md5(g::text), 32) FROM generate_series(1, :rows) g;`, { rows: mib * 1024 });
}
result.fill_seconds = seconds(t);
sql('SELECT vault.create_secret(:\'plain\', :\'name\');', { plain: canary, name: canaryName });
result.database_bytes = Number(sql('SELECT pg_database_size(current_database())'));
result.database = sql('SELECT pg_size_pretty(pg_database_size(current_database()))');
const walBefore = sql('SELECT pg_current_wal_lsn()');
console.log(`  the platform database is ${result.database}`);

step('full backup, through the sidecar\'s own script');
t = Date.now();
kubectl(['exec', POD, '-c', 'pgbackrest', '--', '/bin/sh', '/opt/aber/platform-backup.sh', 'full']);
result.backup_seconds = seconds(t);
const last = JSON.parse(pgbackrest('--output=json', 'info').stdout)[0].backup.at(-1);
result.backup_label = last.label;
result.backup_repository_bytes = last.info.repository.delta;
console.log(`  ${last.label}: ${result.backup_seconds}s, ${(last.info.size / 2 ** 20).toFixed(1)} MiB read, `
  + `${(last.info.repository.delta / 2 ** 20).toFixed(1)} MiB written`);

step('mark a moment, and write past it');
sql("INSERT INTO rehearsal.marks (what) VALUES ('before_target');");
const target = sql("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'");
pause(2000);
sql("INSERT INTO rehearsal.marks (what) VALUES ('after_target');");
result.wal_bytes = Number(sql(`SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), '${walBefore}')`));
const segment = sql('SELECT pg_walfile_name(pg_switch_wal())');
for (let i = 0; ; i += 1) {
  const archived = sql('SELECT last_archived_wal FROM pg_stat_archiver');
  if (archived && archived >= segment) break;
  if (i > 60) die(`WAL segment ${segment} was not archived within two minutes; the restore could not reach the target.`);
  pause(2000);
}
console.log(`  target ${target}; WAL up to ${segment} archived`);
const timelineBefore = Number(sql('SELECT timeline_id FROM pg_control_checkpoint()'));

step('lose it: stop the server and empty its data volume, the root key with it');
kubectl(['scale', 'statefulset', STS, '--replicas=0']);
kubectl(['wait', '--for=delete', `pod/${POD}`, '--timeout=300s'], { allowFail: true });
const wipe = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: `${STS}-rehearsal-wipe` },
  spec: {
    restartPolicy: 'Never',
    securityContext: { runAsUser: 100, runAsGroup: 101, fsGroup: 101, seccompProfile: { type: 'RuntimeDefault' } },
    containers: [{
      name: 'wipe', image: server.image,
      command: ['/bin/sh', '-c', 'rm -rf /var/lib/postgresql/data/* /var/lib/postgresql/data/.[!.]*; ls -A /var/lib/postgresql/data | wc -l'],
      securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
      volumeMounts: [{ name: 'data', mountPath: '/var/lib/postgresql/data' }],
    }],
    volumes: [{ name: 'data', persistentVolumeClaim: { claimName: `data-${POD}` } }],
  },
};
kubectl(['delete', 'pod', wipe.metadata.name, '--ignore-not-found', '--wait=true']);
kubectl(['apply', '-f', '-'], { input: JSON.stringify(wipe) });
kubectl(['wait', '--for=jsonpath={.status.phase}=Succeeded', `pod/${wipe.metadata.name}`, '--timeout=300s']);
const left = kubectl(['logs', wipe.metadata.name], { allowFail: true }).stdout.trim();
kubectl(['delete', 'pod', wipe.metadata.name, '--wait=false']);
if (left !== '0') die(`the data volume still holds ${left} entries; the rehearsal would prove nothing.`);
console.log('  the data directory and pgsodium_root.key are gone');

step(`restore to ${target}`);
t = Date.now();
const restore = spawnSync(process.execPath, ['scripts/restore-platform-db.mjs', '--target', target, '--yes'], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], env: process.env,
});
process.stdout.write(restore.stdout);
if (restore.status !== 0) die('the restore failed; see above.');
result.restore_total_seconds = seconds(t);
result.restore_seconds = Number(restore.stdout.match(/restore\s+(\d+)s/)?.[1]);
result.recovery_seconds = Number(restore.stdout.match(/recovery\s+(\d+)s/)?.[1]);

step('verify');
const markers = sql("SELECT string_agg(what, ',' ORDER BY what) FROM rehearsal.marks");
const decrypted = kubectl(['exec', '-i', POD, '-c', STS, '--', 'psql', '-X', '-q', '-At', '-h', '/var/run/postgresql',
  '-U', 'supabase_admin', '-d', 'postgres', '-v', `name=${canaryName}`, '-f', '-'],
{ input: "SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = :'name';", allowFail: true });
const timelineAfter = Number(sql('SELECT timeline_id FROM pg_control_checkpoint()'));
const recorded = sql(`SELECT count(*) FROM public.physical_backup_runs WHERE label = '${result.backup_label}'`);
const checks = [
  ['the row written before the target is back', markers.includes('before_target'), markers || '(none)'],
  ['the row written after the target is not', !markers.includes('after_target'), markers || '(none)'],
  ['the Vault canary decrypts under the restored root key', decrypted.status === 0 && decrypted.stdout.trim() === canary,
    decrypted.status === 0 ? 'decrypted' : (decrypted.stderr || '').trim().split('\n').pop()],
  ['the full backup taken before the target is in the restored run record', recorded === '1', `${recorded} row(s)`],
  ['recovery promoted onto a new timeline', timelineAfter > timelineBefore, `${timelineBefore} -> ${timelineAfter}`],
];
for (const [what, ok, detail] of checks) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}: ${detail}`);
result.verified = checks.every(([, ok]) => ok);

if (!flag('keep-data')) {
  step('remove the rehearsal schema and the canary');
  sql('DROP SCHEMA IF EXISTS rehearsal CASCADE; DELETE FROM vault.secrets WHERE name = :\'name\';', { name: canaryName });
}

const mib = (b) => (b / 2 ** 20).toFixed(1);
console.log(`
Platform database ${result.database} (${mib(result.database_bytes)} MiB)${FILL_MIB ? `, ${FILL_MIB} MiB of it padding` : ''}
  full backup   ${result.backup_seconds}s, ${mib(result.backup_repository_bytes)} MiB in the repository
  restore       ${result.restore_seconds}s writing the data directory
  recovery      ${result.recovery_seconds}s replaying ${mib(result.wal_bytes)} MiB of WAL to the target and promoting
  end to end    ${result.restore_total_seconds}s from the decision to restore to a writable database
  ${result.verified ? 'verified' : 'NOT VERIFIED'}`);
const out = option('out', null);
if (out) writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
process.exit(result.verified ? 0 : 1);
