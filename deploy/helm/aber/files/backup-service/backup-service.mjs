#!/usr/bin/env node
/**
 * The backup service: a queued backup_jobs row becomes a tier 1 backup on the backup volume.
 *
 * WHY IT EXISTS. request_backup() (archived migration 0101) is a row, and nothing else in the stack can
 * turn a row into a backup: pg_dump against both databases, a tar of the storage objects and a
 * consistent copy of the forge's volume need a process beside the volumes holding a superuser
 * credential, which is neither an edge function nor a browser. This service is that process and
 * does that one thing.
 *
 * WHAT IT IS NOT. It serves nothing but /healthz and hands no bytes to anybody: a dump holds
 * auth.users, every OAuth secret's hash, the whole digital_thread and the historian's password,
 * and "any Administrator session" is a wider audience than "a shell on the host". Restore is a
 * runbook (supabase/README.md, Backup and Recovery) run from that shell against the volume.
 *
 * HOW IT TALKS TO THE DATABASE. Through psql, as supabase_admin, the session pg_dump needs anyway
 * (the event triggers are its; a dump taken as postgres restores as nobody). The gates it calls
 * refuse every PostgREST role and any session that is not a superuser's, so holding this
 * credential is the whole of the authority, and there is no second one to keep in step.
 *
 * THE SCHEDULE IS THIS PROCESS'S. At start it registers enqueue_scheduled_backup() with pg_cron
 * on BACKUP_SCHEDULE, or removes the job when the schedule is empty, so a stack with no service
 * queues nothing nobody will take. Retention is applied here after every run: a scheduled backup
 * older than BACKUP_RETENTION_DAYS is deleted and forgotten; a requested one is pinned until an
 * Administrator releases it.
 *
 * A RUNNING job that no process is running is failed before each claim, not only at start. The
 * service is one replica, so such a row is a previous process's, or it came back in a restore
 * from a backup taken while that job ran; left standing it would refuse every new backup.
 *
 * THE FILES. One directory per backup, named by the UTC stamp, holding what backup-databases.sh
 * writes plus the keys and the volumes: supabase-db-<stamp>.sql.gz, timescaledb-<stamp>.sql.gz,
 * vault-key-<stamp>.txt (pgsodium's root key, read through the dump's own session; Vault is
 * ciphertext under it), storage-objects-<stamp>.tar.gz, forge-<stamp>.tar.gz,
 * broker-<stamp>.tar.gz (the broker's data volume, which is the Dynamic Security document),
 * ca-<stamp>.tar.gz (the internal CA's key pair, read from its Secret through the API),
 * manifest-<stamp>.txt (the text manifest restore-databases.sh reads) and manifest.json
 * (digests). Written under .partial-<stamp> and renamed on success, so a directory named by a
 * stamp is a complete backup or absent.
 *
 * THE FORGE'S SQLITE DATABASE is copied with sqlite3's online backup, which is consistent while
 * Gitea writes, and falls back to a raw copy of the db, -wal and -shm files followed by a
 * checkpoint and an integrity check on the copy. The method used is in manifest.json.
 *
 * The chart projects this file through a ConfigMap over an image built from the database's own
 * (backup-service/Dockerfile), so pg_dump is at least the server's version.
 */
import { spawnSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync,
  writeFileSync, copyFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join, resolve, sep } from 'node:path';

// -------------------------------------------------------------------------------------------------
// Configuration
// -------------------------------------------------------------------------------------------------
const BACKUP_DIR = process.env.BACKUP_DIR || '/backups';
const RETENTION_DAYS = Number.parseInt(process.env.BACKUP_RETENTION_DAYS || '14', 10);
const SCHEDULE = (process.env.BACKUP_SCHEDULE ?? '30 2 * * *').trim();
const POLL_SECONDS = Math.max(2, Number.parseInt(process.env.BACKUP_POLL_SECONDS || '15', 10));
const PORT = Number.parseInt(process.env.BACKUP_SERVICE_PORT || '9020', 10);
// plain -> .sql.gz, what backup-databases.sh writes by default and what restore-databases.sh
// replays with psql. custom -> .dump (pg_dump -Fc), restorable selectively with pg_restore.
const FORMAT = process.env.BACKUP_FORMAT || 'plain';
// A dump smaller than this is a failure, not a backup: an empty database, a wrong -d or a server
// that died mid-write can all produce a well-formed short file.
const MIN_DUMP_BYTES = Number.parseInt(process.env.MIN_DUMP_BYTES || '2048', 10);

const SUPABASE = {
  host: process.env.SUPABASE_DB_HOST || 'supabase-db',
  port: process.env.SUPABASE_DB_PORT || '5432',
  user: process.env.SUPABASE_DB_USER || 'supabase_admin',
  db: process.env.SUPABASE_DB_NAME || 'postgres',
  password: process.env.POSTGRES_PASSWORD || '',
};
const TIMESCALE = {
  host: process.env.TIMESCALE_HOST || 'timescaledb',
  port: process.env.TIMESCALE_PORT || '5432',
  user: process.env.TIMESCALE_USER || 'postgres',
  db: process.env.TIMESCALE_DB || 'postgres',
  password: process.env.TIMESCALE_PASSWORD || '',
};
// Optional: a component whose directory is not mounted is absent from the backup, and the
// manifest says so. An empty string disables one deliberately.
const STORAGE_PATH = process.env.STORAGE_PATH ?? '/storage';
const FORGE_PATH = process.env.FORGE_PATH ?? '/forge';
const BROKER_PATH = process.env.BROKER_PATH ?? '/broker';
// The CA behind the broker's and the databases' certificates, read from its Secret through the
// API with the pod's ServiceAccount. Either empty: no CA to keep (an ACME issuer, or no TLS).
const CA_SECRET_NAME = process.env.CA_SECRET_NAME || '';
const CA_SECRET_NAMESPACE = process.env.CA_SECRET_NAMESPACE || '';
const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
// pgsodium's root key, relative to the database's data directory, where the chart's getkey script
// keeps it. Vault's rows are ciphertext under it and nothing else. Empty: not archived.
const VAULT_KEY_FILE = process.env.VAULT_KEY_FILE ?? 'pgsodium_root.key';
// false while pgBackRest backs the historian up (timescaledb.physicalBackup). The manifest then
// records timescaledb=physical, and restore-databases.sh expects the historian restored already.
const DUMP_TIMESCALE = process.env.DUMP_TIMESCALE !== 'false';

const log = (...args) => console.log(`[backup-service] ${new Date().toISOString()}`, ...args);

if (!SUPABASE.password || !TIMESCALE.password) {
  console.error(
    '[backup-service] POSTGRES_PASSWORD and TIMESCALE_PASSWORD are both required: the service dumps\n'
    + 'both databases as their superuser, and a service that could reach one of them would record a\n'
    + 'backup of half the stack as a backup.'
  );
  process.exit(2);
}
if (FORMAT !== 'plain' && FORMAT !== 'custom') {
  console.error(`[backup-service] BACKUP_FORMAT must be 'plain' or 'custom' (got '${FORMAT}')`);
  process.exit(2);
}
if (!existsSync(BACKUP_DIR)) {
  console.error(`[backup-service] BACKUP_DIR ${BACKUP_DIR} is not mounted; refusing to write backups into the container`);
  process.exit(2);
}

const DUMP_EXT = FORMAT === 'plain' ? 'sql.gz' : 'dump';
// --clean --if-exists on the plain format is what lets a restore replace the auth and storage
// schemas the image ships; the custom format carries the same as a flag at restore time.
const DUMP_ARGS = FORMAT === 'plain' ? ['-Fp', '-Z6', '--clean', '--if-exists'] : ['-Fc'];

// -------------------------------------------------------------------------------------------------
// The database, through psql
// -------------------------------------------------------------------------------------------------
/**
 * One statement, as supabase_admin, with values passed as psql variables and interpolated as
 * quoted literals (`:'name'`), so nothing here concatenates a value into SQL. The statement goes
 * in on stdin: psql substitutes variables in a script it reads, and not in a `-c` command.
 */
function sql(statement, vars = {}) {
  const args = [
    '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1',
    '-h', SUPABASE.host, '-p', SUPABASE.port, '-U', SUPABASE.user, '-d', SUPABASE.db,
  ];
  for (const [name, value] of Object.entries(vars)) args.push('-v', `${name}=${value}`);
  args.push('-f', '-');
  const r = spawnSync('psql', args, {
    encoding: 'utf8',
    input: `${statement};\n`,
    env: { ...process.env, PGPASSWORD: SUPABASE.password, PGCONNECT_TIMEOUT: '10' },
    maxBuffer: 1 << 24,
  });
  if (r.status !== 0) {
    throw new Error(`psql: ${(r.stderr || '').trim().split('\n').slice(-3).join(' ') || `exit ${r.status}`}`);
  }
  return (r.stdout || '').trim();
}

const db = {
  claim: () => {
    const out = sql('SELECT public.backup_claim_job()');
    return out ? JSON.parse(out) : null;
  },
  finalise: (jobId, stamp, location, components, sizeBytes) => sql(
    "SELECT public.backup_finalise(:'job_id'::uuid, :'stamp', :'location', :'components'::jsonb, :'size_bytes'::bigint)",
    { job_id: jobId, stamp, location, components: JSON.stringify(components), size_bytes: String(sizeBytes) }
  ),
  fail: (jobId, error) => sql("SELECT public.backup_fail(:'job_id'::uuid, :'error')", { job_id: jobId, error }),
  reconcile: (reason) => sql("SELECT public.backup_reconcile_jobs(:'reason')", { reason }),
  schedule: (cron) => sql("SELECT public.backup_schedule(:'cron')", { cron }),
  prunable: (days) => JSON.parse(sql("SELECT public.backup_prunable(:'days'::integer)", { days: String(days) }) || '[]'),
  forget: (id, reason) => sql("SELECT public.backup_forget(:'id'::uuid, :'reason')", { id, reason }),
};

// -------------------------------------------------------------------------------------------------
// Files
// -------------------------------------------------------------------------------------------------
const STAMP_RE = /^\d{8}T\d{6}Z$/;
const stampNow = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

function sha256(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    createReadStream(path).on('data', (d) => hash.update(d)).on('end', () => resolvePromise(hash.digest('hex'))).on('error', reject);
  });
}

/** Run a command to completion, capturing stderr; resolves with the exit status. */
function run(cmd, args, { env = {}, stdoutTo = null } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', stdoutTo ? 'pipe' : 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    if (stdoutTo) child.stdout.pipe(stdoutTo);
    child.on('close', (status) => resolvePromise({ status, stderr: stderr.trim() }));
    child.on('error', (err) => resolvePromise({ status: -1, stderr: err.message }));
  });
}

/** A path is inside BACKUP_DIR, so a prune can never remove anything else. */
function insideBackupDir(path) {
  const root = resolve(BACKUP_DIR) + sep;
  return resolve(path).startsWith(root);
}

async function dumpDatabase(name, target, dir, stamp) {
  const file = `${name}-${stamp}.${DUMP_EXT}`;
  const out = join(dir, file);
  log(`dumping ${name} (${target.host}:${target.port}/${target.db} as ${target.user})`);
  const r = await run('pg_dump', [
    ...DUMP_ARGS, '-h', target.host, '-p', target.port, '-U', target.user, '-d', target.db, '-f', out,
  ], { env: { PGPASSWORD: target.password, PGCONNECT_TIMEOUT: '10' } });
  if (r.status !== 0) throw new Error(`pg_dump ${name} failed: ${r.stderr.split('\n').slice(-2).join(' ')}`);
  const size = statSync(out).size;
  if (size < MIN_DUMP_BYTES) throw new Error(`${file} is only ${size} bytes; refusing to record a short dump as a backup`);
  return { name, file, size_bytes: size, sha256: await sha256(out) };
}

/**
 * GNU tar exits 1 for "file changed as we read it", which an upload landing mid-run produces and
 * which is acceptable for immutable blobs: the archive is complete except for that one object.
 * Anything else is a failure.
 */
async function tarDirectory(name, sourceDir, dir, stamp, extraArgs = [], appended = []) {
  const file = `${name}-${stamp}.tar.gz`;
  const out = join(dir, file);
  const r = await run('tar', ['-czf', out, ...extraArgs, '-C', sourceDir, '.', ...appended]);
  if (r.status !== 0 && r.status !== 1) throw new Error(`tar ${name} failed: ${r.stderr.split('\n').slice(-2).join(' ')}`);
  if (r.status === 1) log(`  ${name}: tar warned (a file changed while it was read): ${r.stderr.split('\n').pop()}`);
  const size = statSync(out).size;
  return { name, file, size_bytes: size, sha256: await sha256(out) };
}

/**
 * The forge: everything under /data except the SQLite files and the logs, with a consistent copy
 * of gitea.db appended from a staging directory. GNU tar's second -C makes the copy land at
 * gitea/gitea.db inside the archive, where a restore expects it.
 */
async function archiveForge(dir, stamp) {
  const dbPath = join(FORGE_PATH, 'gitea', 'gitea.db');
  const stage = join(dir, '.forge-stage');
  mkdirSync(join(stage, 'gitea'), { recursive: true });
  const staged = join(stage, 'gitea', 'gitea.db');
  let method = 'sqlite-online-backup';
  try {
    if (existsSync(dbPath)) {
      const r = await run('sqlite3', ['-readonly', dbPath, `.backup '${staged.replace(/'/g, "''")}'`]);
      if (r.status !== 0) {
        // The volume is read-only and SQLite could not open the WAL database for reading. The raw
        // files are copied together and the WAL folded into the copy, then the copy is checked.
        method = 'raw-copy-with-checkpoint';
        log(`  forge: online backup unavailable (${r.stderr.split('\n').pop()}); copying raw files`);
        rmSync(staged, { force: true });
        for (const suffix of ['', '-wal', '-shm']) {
          if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, staged + suffix);
        }
        const c = await run('sqlite3', [staged, 'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA integrity_check;']);
        if (c.status !== 0) throw new Error(`sqlite3 could not checkpoint the copied forge database: ${c.stderr}`);
        rmSync(staged + '-wal', { force: true });
        rmSync(staged + '-shm', { force: true });
      }
      const check = spawnSync('sqlite3', [staged, 'PRAGMA integrity_check;'], { encoding: 'utf8' });
      if (check.status !== 0 || check.stdout.trim() !== 'ok') {
        throw new Error(`the copied forge database failed its integrity check: ${(check.stdout || check.stderr).trim()}`);
      }
    } else {
      method = 'no-database';
    }
    const component = await tarDirectory('forge', FORGE_PATH, dir, stamp, [
      '--exclude=./gitea/gitea.db', '--exclude=./gitea/gitea.db-wal', '--exclude=./gitea/gitea.db-shm',
      '--exclude=./gitea/log',
    ], existsSync(staged) ? ['-C', stage, 'gitea/gitea.db'] : []);
    return { ...component, sqlite: method };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * A Secret, read through the API with the pod's ServiceAccount. The token is read on every call:
 * a projected token is short-lived and rotated in place.
 */
function readSecret(namespace, name) {
  const token = readFileSync(join(SA_DIR, 'token'), 'utf8').trim();
  const ca = readFileSync(join(SA_DIR, 'ca.crt'));
  return new Promise((resolvePromise, reject) => {
    const req = httpsRequest({
      host: process.env.KUBERNETES_SERVICE_HOST || 'kubernetes.default.svc',
      port: process.env.KUBERNETES_SERVICE_PORT || 443,
      path: `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets/${encodeURIComponent(name)}`,
      method: 'GET',
      ca,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) resolvePromise(JSON.parse(data));
        else reject(new Error(`GET secret ${namespace}/${name} -> ${res.statusCode}: ${data.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * The CA's key pair, as the files cert-manager keeps in its Secret (tls.crt, tls.key, ca.crt),
 * staged at 0600 under ca/ and archived. A named CA that cannot be read fails the backup rather
 * than going absent: the values named it, and a backup without it is a fleet-wide re-enrolment.
 */
async function archiveCa(dir, stamp) {
  const secret = await readSecret(CA_SECRET_NAMESPACE, CA_SECRET_NAME);
  const keys = Object.keys(secret.data || {}).filter((k) => /^[A-Za-z0-9._-]+$/.test(k));
  if (!keys.includes('tls.crt') || !keys.includes('tls.key')) {
    throw new Error(`secret ${CA_SECRET_NAMESPACE}/${CA_SECRET_NAME} holds no tls.crt and tls.key, so it is not a CA's key pair`);
  }
  const stage = join(dir, '.ca-stage');
  try {
    mkdirSync(join(stage, 'ca'), { recursive: true });
    for (const key of keys) {
      writeFileSync(join(stage, 'ca', key), Buffer.from(secret.data[key], 'base64'), { mode: 0o600 });
    }
    const component = await tarDirectory('ca', stage, dir, stamp);
    return { ...component, secret: `${CA_SECRET_NAMESPACE}/${CA_SECRET_NAME}`, keys };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * pgsodium's root key, read through the same superuser session the dump uses: pg_read_file
 * resolves a relative path against the data directory. A dump without it restores a Vault that
 * nothing can decrypt, since a fresh server mints its own key; the file is written as read, with
 * no newline, so a restore can put it back byte for byte.
 */
async function archiveVaultKey(dir, stamp) {
  const key = sql("SELECT pg_read_file(:'path')", { path: VAULT_KEY_FILE });
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error(`${VAULT_KEY_FILE} does not hold a 32-byte hex key`);
  const file = `vault-key-${stamp}.txt`;
  const out = join(dir, file);
  writeFileSync(out, key, { mode: 0o600 });
  return { name: 'vault-key', file, size_bytes: statSync(out).size, sha256: await sha256(out) };
}

// -------------------------------------------------------------------------------------------------
// One backup
// -------------------------------------------------------------------------------------------------
let current = null; // { job, stamp, partialDir }
let lastRun = null;

async function takeBackup(job) {
  const stamp = stampNow();
  const partialDir = join(BACKUP_DIR, `.partial-${stamp}`);
  const finalDir = join(BACKUP_DIR, stamp);
  current = { job, stamp, partialDir };
  mkdirSync(partialDir, { recursive: true });
  log(`backup ${stamp} for job ${job.id} (${job.origin}${job.note ? `: ${job.note}` : ''})`);

  const components = [];
  components.push(await dumpDatabase('supabase-db', SUPABASE, partialDir, stamp));
  if (DUMP_TIMESCALE) {
    components.push(await dumpDatabase('timescaledb', TIMESCALE, partialDir, stamp));
  } else {
    log('historian: backed up by pgBackRest; not dumped');
  }

  if (VAULT_KEY_FILE) {
    log('archiving the pgsodium root key');
    components.push(await archiveVaultKey(partialDir, stamp));
  } else {
    log('vault key: no file named; component absent');
  }

  if (STORAGE_PATH && existsSync(STORAGE_PATH) && statSync(STORAGE_PATH).isDirectory()) {
    log('archiving the storage objects');
    components.push(await tarDirectory('storage-objects', STORAGE_PATH, partialDir, stamp));
  } else {
    log('storage objects: no volume mounted; component absent');
  }

  if (FORGE_PATH && existsSync(FORGE_PATH) && statSync(FORGE_PATH).isDirectory()) {
    log('archiving the forge');
    components.push(await archiveForge(partialDir, stamp));
  } else {
    log('forge: no volume mounted; component absent');
  }

  if (BROKER_PATH && existsSync(BROKER_PATH) && statSync(BROKER_PATH).isDirectory()) {
    log("archiving the broker's document");
    components.push(await tarDirectory('broker', BROKER_PATH, partialDir, stamp));
  } else {
    log('broker: no volume mounted; component absent');
  }

  if (CA_SECRET_NAME && CA_SECRET_NAMESPACE) {
    log(`archiving the CA from secret ${CA_SECRET_NAMESPACE}/${CA_SECRET_NAME}`);
    components.push(await archiveCa(partialDir, stamp));
  } else {
    log('ca: no secret named; component absent');
  }

  // The text manifest restore-databases.sh reads, in its format, and a JSON one with the digests.
  const byName = Object.fromEntries(components.map((c) => [c.name, c]));
  const text = [
    `stamp=${stamp}`,
    'mode=direct',
    `format=${FORMAT}`,
    `supabase_db=${byName['supabase-db'].file}`,
    `timescaledb=${byName['timescaledb']?.file ?? 'physical'}`,
    byName['vault-key'] ? `vault_key=${byName['vault-key'].file}` : null,
    byName['storage-objects'] ? `storage=${byName['storage-objects'].file}` : null,
    byName['forge'] ? `forge=${byName['forge'].file}` : null,
    byName['broker'] ? `broker=${byName['broker'].file}` : null,
    byName['ca'] ? `ca=${byName['ca'].file}` : null,
    'created_by=scripts/backup-service.mjs',
  ].filter(Boolean).join('\n') + '\n';
  writeFileSync(join(partialDir, `manifest-${stamp}.txt`), text);
  writeFileSync(join(partialDir, 'manifest.json'), JSON.stringify({
    stamp, format: FORMAT, origin: job.origin, note: job.note ?? null, job_id: job.id, components,
  }, null, 2) + '\n');

  renameSync(partialDir, finalDir);
  const total = components.reduce((n, c) => n + c.size_bytes, 0);
  const backupId = db.finalise(job.id, stamp, finalDir, components, total);
  log(`  ok ${stamp}: ${components.length} component(s), ${total} bytes, backups row ${backupId}`);
  current = null;
  lastRun = { stamp, at: new Date().toISOString(), ok: true };
}

function abandon(reason) {
  if (!current) return;
  const { job, partialDir } = current;
  current = null;
  rmSync(partialDir, { recursive: true, force: true });
  try { db.fail(job.id, reason); } catch (err) { log(`could not record the failure of job ${job.id}: ${err.message}`); }
  lastRun = { at: new Date().toISOString(), ok: false, error: reason };
}

/** Retention. The row is forgotten only after the files are gone. */
function prune() {
  let rows;
  try { rows = db.prunable(RETENTION_DAYS); } catch (err) { log(`prune: ${err.message}`); return; }
  for (const row of rows) {
    if (!STAMP_RE.test(row.stamp) || !insideBackupDir(row.location)) {
      log(`prune: refusing ${row.id}: location ${row.location} is not a backup directory`);
      continue;
    }
    rmSync(row.location, { recursive: true, force: true });
    db.forget(row.id, `older than the ${RETENTION_DAYS}-day retention window`);
    log(`pruned ${row.stamp}`);
  }
}

/** A .partial-* directory at start is a backup the previous process did not finish. */
function sweepPartials() {
  for (const entry of readdirSync(BACKUP_DIR)) {
    if (entry.startsWith('.partial-')) {
      rmSync(join(BACKUP_DIR, entry), { recursive: true, force: true });
      log(`removed incomplete ${entry}`);
    }
  }
}

// -------------------------------------------------------------------------------------------------
// The loop
// -------------------------------------------------------------------------------------------------
let stopping = false;

async function tick() {
  if (stopping || current) return;
  let job;
  try {
    // A RUNNING row while this process runs nothing is a job no process is running: a previous
    // process's, or restored with the database from a backup taken while it ran.
    const stale = db.reconcile('no backup service was running this job: the service restarted, or the database was restored from a backup taken while it ran');
    if (Number(stale) > 0) log(`failed ${stale} job(s) that no service was running`);
    job = db.claim();
  } catch (err) { log(`claim: ${err.message}`); return; }
  if (!job) return;
  try {
    await takeBackup(job);
  } catch (err) {
    log(`backup failed: ${err.message}`);
    abandon(err.message);
  }
  prune();
}

async function waitForDatabase() {
  for (let attempt = 1; ; attempt += 1) {
    try { sql('SELECT 1'); return; } catch (err) {
      if (attempt % 6 === 1) log(`waiting for ${SUPABASE.host}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function main() {
  await waitForDatabase();
  sweepPartials();
  // A job left RUNNING by a previous process is failed by the first tick, with every other.
  const scheduled = db.schedule(SCHEDULE);
  log(scheduled === 't' ? `scheduled backups: ${SCHEDULE}` : 'scheduled backups: off (BACKUP_SCHEDULE is empty)');
  log(`retention: ${RETENTION_DAYS > 0 ? `${RETENTION_DAYS} days` : 'off'}; format: ${FORMAT}; polling every ${POLL_SECONDS}s`);
  prune();

  const loop = async () => {
    await tick();
    if (!stopping) setTimeout(loop, POLL_SECONDS * 1000);
  };
  loop();
}

// Loopback within the container is all a healthcheck needs; nothing publishes this port.
createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, in_flight: current ? current.stamp : null, last_run: lastRun }));
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(PORT, () => log(`healthz on :${PORT}`));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    stopping = true;
    abandon('the backup service was stopped while this backup was running');
    process.exit(0);
  });
}

main().catch((err) => { console.error('[backup-service]', err); process.exit(1); });
