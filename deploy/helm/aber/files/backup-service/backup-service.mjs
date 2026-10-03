#!/usr/bin/env node
// The backup service: a queued backup_jobs row becomes a tier 1 backup on the backup volume. It is the
// one process beside the volumes holding a superuser credential, so it can pg_dump both databases,
// tar the storage objects and the broker's document, copy the forge consistently and archive the
// keys. It serves nothing but /healthz and hands no bytes to anybody: restore is a runbook run from
// a shell against the volume or the bucket. When the Backups page names an S3 destination it copies
// every backup there, each file encrypted with age. Runs on an image built from the database's own,
// so pg_dump is at least the server's version. Reasoning: supabase/README.md, "Backup and Recovery",
// "How the service takes a backup", "An encrypted copy off site".
import { spawnSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync,
  rmSync, statSync, writeFileSync, copyFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

const BACKUP_DIR = process.env.BACKUP_DIR || '/backups';
const RETENTION_DAYS = Number.parseInt(process.env.BACKUP_RETENTION_DAYS || '14', 10);
const SCHEDULE = (process.env.BACKUP_SCHEDULE ?? '30 2 * * *').trim();
const POLL_SECONDS = Math.max(2, Number.parseInt(process.env.BACKUP_POLL_SECONDS || '15', 10));
const PORT = Number.parseInt(process.env.BACKUP_SERVICE_PORT || '9020', 10);
// plain: .sql.gz, what restore-databases.sh replays with psql. custom: .dump (pg_dump -Fc),
// restorable selectively with pg_restore.
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
// Optional components: a directory not mounted is absent from the backup and the manifest says so.
// An empty string disables one deliberately.
const STORAGE_PATH = process.env.STORAGE_PATH ?? '/storage';
const FORGE_PATH = process.env.FORGE_PATH ?? '/forge';
const BROKER_PATH = process.env.BROKER_PATH ?? '/broker';
// The CA behind the broker's and the databases' certificates, read from its Secret through the API
// with the pod's ServiceAccount. Either empty: no CA to keep (an ACME issuer, or no TLS).
const CA_SECRET_NAME = process.env.CA_SECRET_NAME || '';
const CA_SECRET_NAMESPACE = process.env.CA_SECRET_NAMESPACE || '';
const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
// pgsodium's root key, relative to the data directory where the chart's getkey script keeps it.
// Vault's rows are ciphertext under it and nothing else. Empty: not archived.
const VAULT_KEY_FILE = process.env.VAULT_KEY_FILE ?? 'pgsodium_root.key';
// false while pgBackRest backs the historian up (timescaledb.physicalBackup). The manifest then
// records timescaledb=physical, and restore-databases.sh expects the historian restored already.
const DUMP_TIMESCALE = process.env.DUMP_TIMESCALE !== 'false';
// An encrypted file up to this size is one PUT; a larger one is a multipart upload of parts this
// size. S3 takes at most 10,000 parts, so 64 MiB bounds one file at 640 GiB.
const OFFSITE_PART_BYTES = Math.max(5 * 1024 * 1024,
  Number.parseInt(process.env.BACKUP_OFFSITE_PART_BYTES || String(64 * 1024 * 1024), 10));
// The ciphertext of the file being uploaded, on the backup volume; removed after each copy.
const OFFSITE_STAGE = join(BACKUP_DIR, '.offsite-stage');

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

// One statement as supabase_admin, the session pg_dump needs anyway, with values passed as psql
// variables and interpolated as quoted literals, so nothing here concatenates a value into SQL. On
// stdin, because psql substitutes variables in a script it reads and not in a -c command.
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
    // The ERROR line says what failed; the CONTEXT after it can run to many lines of SQL.
    const lines = (r.stderr || '').trim().split('\n');
    const error = lines.find((line) => /\bERROR:/.test(line));
    const detail = error ? [error, lines.at(-1)].filter((l, i, all) => all.indexOf(l) === i) : lines.slice(-3);
    throw new Error(`psql: ${detail.join(' ').trim() || `exit ${r.status}`}`);
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
  // The destination carries the secret key: it is parsed here and handed to the aws CLI's
  // environment, and never logged.
  offsiteDestination: () => {
    const out = sql('SELECT public.backup_offsite_destination()');
    return out ? JSON.parse(out) : null;
  },
  offsiteNext: () => {
    const out = sql('SELECT public.backup_offsite_next()');
    return out ? JSON.parse(out) : null;
  },
  offsiteRecord: (id, location, objects, error) => sql(
    "SELECT public.backup_offsite_record(:'id'::uuid, NULLIF(:'location', ''), NULLIF(:'objects', '')::jsonb, NULLIF(:'error', ''))",
    { id, location: location || '', objects: objects ? JSON.stringify(objects) : '', error: error || '' }
  ),
};

const STAMP_RE = /^\d{8}T\d{6}Z$/;
const stampNow = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

function sha256Raw(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    createReadStream(path).on('data', (d) => hash.update(d)).on('end', () => resolvePromise(hash.digest())).on('error', reject);
  });
}
const sha256 = async (path) => (await sha256Raw(path)).toString('hex');

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

// run(), keeping stdout: the aws CLI answers in JSON.
function capture(cmd, args, env = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolvePromise({ status, stdout, stderr: stderr.trim() }));
    child.on('error', (err) => resolvePromise({ status: -1, stdout: '', stderr: err.message }));
  });
}

// So a prune can never remove anything outside BACKUP_DIR.
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

// GNU tar exits 1 for "file changed as we read it", which an upload landing mid-run produces and
// which is acceptable for immutable blobs: the archive is complete except for that one object.
// Anything else is a failure.
async function tarDirectory(name, sourceDir, dir, stamp, extraArgs = [], appended = []) {
  const file = `${name}-${stamp}.tar.gz`;
  const out = join(dir, file);
  const r = await run('tar', ['-czf', out, ...extraArgs, '-C', sourceDir, '.', ...appended]);
  if (r.status !== 0 && r.status !== 1) throw new Error(`tar ${name} failed: ${r.stderr.split('\n').slice(-2).join(' ')}`);
  if (r.status === 1) log(`  ${name}: tar warned (a file changed while it was read): ${r.stderr.split('\n').pop()}`);
  const size = statSync(out).size;
  return { name, file, size_bytes: size, sha256: await sha256(out) };
}

// Everything under /data except the SQLite files and the logs, with a consistent copy of gitea.db
// appended from a staging directory (tar's second -C lands it at gitea/gitea.db, where a restore
// expects it). sqlite3's online backup is consistent while Gitea writes; on a read-only volume it
// falls back to a raw copy of db, -wal and -shm with a checkpoint and an integrity check on the
// copy. The method used is in manifest.json.
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

// Through the API with the pod's ServiceAccount. The token is read on every call: a projected
// token is short-lived and rotated in place.
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

// The CA's key pair as cert-manager keeps it (tls.crt, tls.key, ca.crt), staged at 0600. A named
// CA that cannot be read fails the backup rather than going absent: the values named it, and a
// backup without it is a fleet-wide re-enrolment.
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

// Read through the dump's own superuser session: pg_read_file resolves a relative path against the
// data directory. A dump without it restores a Vault nothing can decrypt, since a fresh server mints
// its own key. Written as read, with no newline, so a restore puts it back byte for byte.
async function archiveVaultKey(dir, stamp) {
  const key = sql("SELECT pg_read_file(:'path')", { path: VAULT_KEY_FILE });
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error(`${VAULT_KEY_FILE} does not hold a 32-byte hex key`);
  const file = `vault-key-${stamp}.txt`;
  const out = join(dir, file);
  writeFileSync(out, key, { mode: 0o600 });
  return { name: 'vault-key', file, size_bytes: statSync(out).size, sha256: await sha256(out) };
}

let current = null; // { job, stamp, partialDir }
let lastRun = null;

// One directory per backup, named by the UTC stamp, written under .partial-<stamp> and renamed on
// success, so a directory named by a stamp is a complete backup or absent.
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

  const byName = Object.fromEntries(components.map((c) => [c.name, c]));
  // The text manifest restore-databases.sh reads, in its format, and a JSON one with the digests.
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
  // From here a failure removes the renamed directory: a finalise that throws leaves no row for it.
  current.partialDir = finalDir;
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

// ---------------------------------------------------------------------------------------------
// The off-site copy
// ---------------------------------------------------------------------------------------------
let copying = null; // the stamp being copied, for /healthz

// The aws CLI's whole environment for one destination: the credential, the region, the addressing
// style, and no second source of either (no shared credentials file, no instance metadata).
// Checksums only where asked for: the explicit ChecksumSHA256 goes as a header, which every S3
// implementation reads, rather than as the trailer the CLI would otherwise add.
function awsEnv(dest) {
  const config = join(tmpdir(), 'aber-backup-aws-config');
  writeFileSync(config, `[default]\ns3 =\n  addressing_style = ${dest.path_style ? 'path' : 'virtual'}\n`);
  return {
    AWS_ACCESS_KEY_ID: dest.access_key_id,
    AWS_SECRET_ACCESS_KEY: dest.secret_key,
    AWS_REGION: dest.region,
    AWS_DEFAULT_REGION: dest.region,
    AWS_CONFIG_FILE: config,
    AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
    AWS_EC2_METADATA_DISABLED: 'true',
    AWS_PAGER: '',
    AWS_RETRY_MODE: 'standard',
    AWS_MAX_ATTEMPTS: '5',
    AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required',
    AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required',
  };
}

async function aws(dest, env, args) {
  const r = await capture('aws', ['--endpoint-url', dest.endpoint, '--output', 'json', ...args], env);
  if (r.status !== 0) {
    throw new Error(`aws ${args.slice(0, 2).join(' ')}: ${r.stderr.split('\n').filter(Boolean).slice(-2).join(' ') || `exit ${r.status}`}`);
  }
  return r.stdout.trim() ? JSON.parse(r.stdout) : {};
}

async function copyRange(src, dest, start, length) {
  await pipeline(createReadStream(src, { start, end: start + length - 1 }), createWriteStream(dest));
}

// Parts of OFFSITE_PART_BYTES, each sent with its own ChecksumSHA256. Returns the digest S3 keeps
// for such an object: the SHA-256 of the parts' digests, then -<parts>.
async function multipartUpload(dest, env, staged, size, key) {
  const { UploadId } = await aws(dest, env, [
    's3api', 'create-multipart-upload', '--bucket', dest.bucket, '--key', key, '--checksum-algorithm', 'SHA256',
  ]);
  const parts = [];
  const digests = [];
  const part = join(OFFSITE_STAGE, 'part');
  try {
    for (let n = 1, offset = 0; offset < size; n += 1, offset += OFFSITE_PART_BYTES) {
      await copyRange(staged, part, offset, Math.min(OFFSITE_PART_BYTES, size - offset));
      const digest = await sha256Raw(part);
      const { ETag } = await aws(dest, env, [
        's3api', 'upload-part', '--bucket', dest.bucket, '--key', key, '--upload-id', UploadId,
        '--part-number', String(n), '--body', part, '--checksum-sha256', digest.toString('base64'),
      ]);
      parts.push({ PartNumber: n, ETag, ChecksumSHA256: digest.toString('base64') });
      digests.push(digest);
      rmSync(part, { force: true });
    }
    const manifest = join(OFFSITE_STAGE, 'parts.json');
    writeFileSync(manifest, JSON.stringify({ Parts: parts }));
    await aws(dest, env, [
      's3api', 'complete-multipart-upload', '--bucket', dest.bucket, '--key', key, '--upload-id', UploadId,
      '--multipart-upload', `file://${manifest}`,
    ]);
  } catch (err) {
    await capture('aws', ['--endpoint-url', dest.endpoint, 's3api', 'abort-multipart-upload',
      '--bucket', dest.bucket, '--key', key, '--upload-id', UploadId], env);
    throw err;
  }
  return `${createHash('sha256').update(Buffer.concat(digests)).digest('base64')}-${digests.length}`;
}

// One file: encrypted to every recipient, uploaded with the digest the store checks on write, then
// a HEAD that confirms the size and the digest the store computed for itself. An implementation
// that returns no checksum has still checked it on write, so absent is not a mismatch.
async function uploadEncrypted(dest, env, src, key) {
  const staged = join(OFFSITE_STAGE, 'object.age');
  const enc = await capture('age', [...dest.recipients.flatMap((r) => ['-r', r]), '-o', staged, src]);
  if (enc.status !== 0) throw new Error(`age could not encrypt ${basename(src)}: ${enc.stderr.split('\n').pop()}`);
  const size = statSync(staged).size;
  const digest = await sha256Raw(staged);
  let expected = digest.toString('base64');
  if (size <= OFFSITE_PART_BYTES) {
    await aws(dest, env, [
      's3api', 'put-object', '--bucket', dest.bucket, '--key', key, '--body', staged,
      '--checksum-sha256', expected, '--content-type', 'application/octet-stream',
    ]);
  } else {
    expected = await multipartUpload(dest, env, staged, size, key);
  }
  const head = await aws(dest, env, [
    's3api', 'head-object', '--bucket', dest.bucket, '--key', key, '--checksum-mode', 'ENABLED',
  ]);
  if (Number(head.ContentLength) !== size) {
    throw new Error(`${key} is ${head.ContentLength} bytes on the store, ${size} were sent`);
  }
  if (head.ChecksumSHA256 && head.ChecksumSHA256 !== expected) {
    throw new Error(`${key}: the store holds checksum ${head.ChecksumSHA256}, ${expected} was sent`);
  }
  rmSync(staged, { force: true });
  return { file: basename(src), key, size_bytes: size, sha256: digest.toString('hex') };
}

// The manifests last, so a copy holding manifest.json.age holds every file the manifest names.
const uploadOrder = (name) => (name === 'manifest.json' ? 2 : name.startsWith('manifest-') ? 1 : 0);

// The next backup without a copy at the current destination, if there is one: one per idle poll,
// so a requested backup waits behind one upload at most. A failure is recorded and retried after
// a backoff; it never touches the backup itself.
async function copyOffsite() {
  let dest;
  let backup;
  try {
    dest = db.offsiteDestination();
    backup = dest && db.offsiteNext();
  } catch (err) { log(`off-site: ${err.message}`); return; }
  if (!backup) return;

  const location = `${dest.base}${backup.stamp}/`;
  copying = backup.stamp;
  log(`off-site: copying ${backup.stamp} to ${location}`);
  try {
    if (!STAMP_RE.test(backup.stamp) || !insideBackupDir(backup.location) || !existsSync(backup.location)) {
      throw new Error(`${backup.location} is not a backup directory on this volume`);
    }
    mkdirSync(OFFSITE_STAGE, { recursive: true });
    const env = awsEnv(dest);
    const files = readdirSync(backup.location)
      .filter((f) => statSync(join(backup.location, f)).isFile())
      .sort((a, b) => uploadOrder(a) - uploadOrder(b) || a.localeCompare(b));
    const objects = [];
    for (const file of files) {
      objects.push(await uploadEncrypted(dest, env, join(backup.location, file), `${dest.prefix}/${backup.stamp}/${file}.age`));
    }
    db.offsiteRecord(backup.id, location, objects, null);
    log(`  off-site ok ${backup.stamp}: ${objects.length} object(s), ${objects.reduce((n, o) => n + o.size_bytes, 0)} bytes`);
  } catch (err) {
    log(`off-site: ${backup.stamp} failed: ${err.message}`);
    try { db.offsiteRecord(backup.id, null, null, err.message); } catch (e) { log(`off-site: could not record the failure: ${e.message}`); }
  } finally {
    copying = null;
    rmSync(OFFSITE_STAGE, { recursive: true, force: true });
  }
}

// A pruned backup's copy, deleted where the current destination reaches it. It never holds back
// the local prune: a credential that may not delete (Object Lock, or no s3:DeleteObject, with a
// lifecycle rule expiring copies instead) is a supported arrangement, and the reason says so.
async function pruneOffsite(row, dest) {
  if (!dest) {
    return row.offsite_location ? `; its off-site copy at ${row.offsite_location} was left: no destination is set` : '';
  }
  const here = `${dest.base}${row.stamp}/`;
  let said = row.offsite_location && !row.offsite_location.startsWith(dest.base)
    ? `; its off-site copy at ${row.offsite_location} was left: the destination has changed since` : '';
  try {
    const env = awsEnv(dest);
    const listing = await aws(dest, env, ['s3api', 'list-objects-v2', '--bucket', dest.bucket, '--prefix', `${dest.prefix}/${row.stamp}/`]);
    const keys = (listing.Contents || []).map((o) => o.Key);
    for (const key of keys) await aws(dest, env, ['s3api', 'delete-object', '--bucket', dest.bucket, '--key', key]);
    if (keys.length) said += `; its off-site copy at ${here} was deleted`;
  } catch (err) {
    log(`prune: the off-site copy of ${row.stamp}: ${err.message}`);
    said += `; its off-site copy at ${here} was not deleted: ${err.message.slice(0, 300)}`;
  }
  return said;
}

// Retention: a scheduled backup older than the window is deleted and the row forgotten only after
// the files are gone; a requested one is pinned until an Administrator releases it, and
// backup_prunable() never returns the newest three. Runs after a failed job too: when the failure
// was a full volume, the prune is what lets the next run succeed. A pruned backup's off-site copy
// goes with it, so the copies follow the same rules.
async function prune() {
  let rows;
  try { rows = db.prunable(RETENTION_DAYS); } catch (err) { log(`prune: ${err.message}`); return; }
  if (!rows.length) return;
  let dest = null;
  try { dest = db.offsiteDestination(); } catch (err) { log(`prune: the off-site destination: ${err.message}`); }
  for (const row of rows) {
    if (!STAMP_RE.test(row.stamp) || !insideBackupDir(row.location)) {
      log(`prune: refusing ${row.id}: location ${row.location} is not a backup directory`);
      continue;
    }
    const offsite = await pruneOffsite(row, dest);
    rmSync(row.location, { recursive: true, force: true });
    db.forget(row.id, `older than the ${RETENTION_DAYS}-day retention window${offsite}`);
    log(`pruned ${row.stamp}${offsite}`);
  }
}

// A .partial-* directory at start is a backup the previous process did not finish, and a staged
// ciphertext is a copy it did not finish.
function sweepPartials() {
  for (const entry of readdirSync(BACKUP_DIR)) {
    if (entry.startsWith('.partial-') || entry === basename(OFFSITE_STAGE)) {
      rmSync(join(BACKUP_DIR, entry), { recursive: true, force: true });
      log(`removed incomplete ${entry}`);
    }
  }
}

let stopping = false;

// pg_cron does not run a slot that passed while supabase-db was down, so a missed scheduled backup
// is queued late, once: when no scheduled job was queued in the last 25 hours, a day plus an hour
// so it never races pg_cron for the normal slot. That assumes a schedule that runs every day, as
// the stale alerts do; any other leaves catch-up off. enqueue_scheduled_backup() refuses while a
// job is queued or running.
const CATCH_UP_EVERY_MS = 5 * 60 * 1000;
const CATCH_UP = /^\S+\s+\S+\s+\*\s+\*\s+\*$/.test(SCHEDULE);
let caughtUpAt = 0;

// Empty when a scheduled job was queued in the last 25 hours; 't' queued now; 'f' refused because
// another job is queued or running, so asked again on the next check. The first check says which.
function catchUp() {
  const first = caughtUpAt === 0;
  caughtUpAt = Date.now();
  try {
    const queued = sql(
      'SELECT public.enqueue_scheduled_backup() WHERE NOT EXISTS (SELECT 1 FROM public.backup_jobs '
      + "WHERE origin = 'scheduled' AND created_at > now() - interval '25 hours')"
    );
    if (queued === 't') log(`missed the scheduled backup (${SCHEDULE}): none was queued in the last 25 hours; queueing it now`);
    else if (first && queued === 'f') log('catch-up: a scheduled backup is due and another job is in flight; checking again in 5 minutes');
    else if (first) log('catch-up: nothing missed; a scheduled backup was queued in the last 25 hours');
  } catch (err) { log(`catch-up: ${err.message}`); }
}

// A RUNNING row while this process runs nothing is a job no process is running: a previous
// process's, or restored with the database from a backup taken while it ran. Failed before each
// claim, not only at start; left standing it would refuse every new backup.
async function tick() {
  if (stopping || current) return;
  let job;
  try {
    const stale = db.reconcile('no backup service was running this job: the service restarted, or the database was restored from a backup taken while it ran');
    if (Number(stale) > 0) log(`failed ${stale} job(s) that no service was running`);
    if (CATCH_UP && Date.now() - caughtUpAt >= CATCH_UP_EVERY_MS) catchUp();
    job = db.claim();
  } catch (err) { log(`claim: ${err.message}`); return; }
  if (!job) {
    await copyOffsite();
    return;
  }
  try {
    await takeBackup(job);
  } catch (err) {
    log(`backup failed: ${err.message}`);
    abandon(err.message);
  }
  await prune();
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
  // The schedule is this process's: registered with pg_cron at start, or removed when empty, so a
  // stack with no service queues nothing nobody will take.
  const scheduled = db.schedule(SCHEDULE);
  log(scheduled === 't' ? `scheduled backups: ${SCHEDULE}` : 'scheduled backups: off (BACKUP_SCHEDULE is empty)');
  if (scheduled === 't') {
    log(CATCH_UP
      ? 'a missed scheduled backup is queued late: checked now and every 5 minutes'
      : 'missed scheduled backups are not caught up: BACKUP_SCHEDULE does not run every day');
  }
  log(`retention: ${RETENTION_DAYS > 0 ? `${RETENTION_DAYS} days` : 'off'}; format: ${FORMAT}; polling every ${POLL_SECONDS}s`);
  await prune();

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
    res.end(JSON.stringify({ ok: true, in_flight: current ? current.stamp : null, copying, last_run: lastRun }));
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
