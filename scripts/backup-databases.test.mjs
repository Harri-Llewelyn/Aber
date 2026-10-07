/**
 * What `scripts/backup-databases.sh` refuses to start, what a run leaves behind, and that
 * `scripts/restore-databases.sh` finds every file of that backup through its manifest.
 *
 *     node --test scripts/backup-databases.test.mjs
 *
 * `pg_dump`, `psql` and `pg_restore` are stubs on PATH, so what is asserted is the scripts'
 * decisions and never PostgreSQL. The `pg_dump` stub writes a dump whose first line names the port
 * it was taken from; the `psql` and `pg_restore` stubs answer the restore's queries the way a
 * stack that has booted once would, and record which dump each replay read and which port it went
 * to. `tar` and `gzip` are the host's own.
 *
 * SKIPPED WITHOUT bash, tar and gzip on PATH, loudly rather than as a green tick over nothing.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BACKUP = join(REPO, 'scripts', 'backup-databases.sh').replace(/\\/g, '/');
const RESTORE = join(REPO, 'scripts', 'restore-databases.sh').replace(/\\/g, '/');

const tools = spawnSync('bash', ['-c', 'command -v tar && command -v gzip'], { stdio: 'ignore' });
const SKIP = tools.status === 0 ? false : 'needs bash, tar and gzip on PATH';

const scratch = [];
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

const STUBS = {
  // Fails for the port in PG_DUMP_FAIL_PORT; is interrupted for the one in PG_DUMP_KILL_PORT, by a
  // TERM to the script, and still writes its file. Random bytes keep a plain dump past
  // MIN_DUMP_BYTES once gzipped.
  pg_dump: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$PG_DUMP_LOG"
case "$*" in *-Fp*) compress=gzip ;; *) compress=cat ;; esac
while [ $# -gt 0 ]; do
  case "$1" in -p) port="$2"; shift ;; -f) out="$2"; shift ;; esac
  shift
done
if [ "$port" = "\${PG_DUMP_FAIL_PORT:-}" ]; then echo "pg_dump: connection refused" >&2; exit 1; fi
if [ "$port" = "\${PG_DUMP_KILL_PORT:-}" ]; then kill -TERM "$PPID"; sleep 1; fi
{ echo "-- the database on port $port"; head -c 4096 /dev/urandom; } | $compress > "$out"
`,
  // A query (-tAc) is answered; anything else is a plain replay on stdin, recorded by its first line.
  psql: `#!/usr/bin/env bash
while [ $# -gt 0 ]; do
  case "$1" in -p) port="$2"; shift ;; -tAc) query="$2"; shift ;; esac
  shift
done
case "\${query:-}" in
  '') IFS= read -r first; cat > /dev/null; echo "replay $port $first" >> "$RESTORE_LOG" ;;
  *pg_roles*|*pg_foreign_server*) echo 1 ;;
  *pg_stat_activity*) echo 0 ;;
  *continuous_aggregates*) echo 3 ;;
esac
`,
  // A custom-format replay: the dump is the last argument.
  pg_restore: `#!/usr/bin/env bash
for file; do :; done
while [ $# -gt 0 ]; do case "$1" in -p) port="$2"; shift ;; esac; shift; done
echo "replay $port $(head -n 1 "$file")" >> "$RESTORE_LOG"
`,
};

// The prune, which runs after the manifest is written, interrupted as an operator's Ctrl-C would.
const FIND = `#!/usr/bin/env bash
kill -TERM "$PPID"
sleep 1
`;

/** Every variable either script reads a setting from, so the host's own cannot leak into a case. */
const SETTINGS = [
  'BACKUP_DIR', 'BACKUP_RETENTION_DAYS', 'BACKUP_FORMAT', 'DUMP_TIMESCALE', 'INCLUDE_STORAGE',
  'STORAGE_HOST_PATH', 'MIN_DUMP_BYTES', 'SUPABASE_DB_PORT', 'TIMESCALE_PORT', 'BACKUP_STAMP',
  'ASSUME_YES', 'RESTORE_STORAGE', 'REQUIRED_ROLES',
];

/** The two replays a restore of a complete backup performs, in the order it must perform them. */
const REPLAYS = ['replay 54322 -- the database on port 54322', 'replay 5433 -- the database on port 5433'];

/**
 * One backup in a fresh directory. BACKUP_DIR and STORAGE_HOST_PATH are relative to it, because
 * GNU tar reads a `C:/...` argument as a remote host.
 */
function run(settings = {}, { storage = false, interruptPrune = false } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'aber-backup-'));
  scratch.push(work);
  const bin = join(work, 'bin');
  mkdirSync(bin);
  for (const [name, body] of Object.entries({ ...STUBS, ...(interruptPrune ? { find: FIND } : {}) })) {
    writeFileSync(join(bin, name), body, { mode: 0o755 });
  }
  if (storage) {
    mkdirSync(join(work, 'storage', 'area-plans'), { recursive: true });
    writeFileSync(join(work, 'storage', 'area-plans', 'area-1.png'), 'an object');
  }

  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH' && !SETTINGS.includes(key)),
    ),
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    PG_DUMP_LOG: 'pg_dump.log',
    RESTORE_LOG: 'restore.log',
    BACKUP_DIR: 'backups',
    ...settings,
  };

  const result = spawnSync('bash', [BACKUP], { cwd: work, env, encoding: 'utf8' });
  const backups = join(work, 'backups');
  const log = join(work, 'pg_dump.log');
  return {
    ...result,
    work,
    env,
    dumps: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0,
    written: existsSync(backups) ? readdirSync(backups) : [],
    backups,
  };
}

/** The manifest's entries, each file it names checked to exist beside it. */
function manifest({ backups, written }) {
  const name = written.find((f) => /^manifest-.*\.txt$/.test(f));
  assert.ok(name, `no manifest among ${written.join(', ')}`);
  const entries = Object.fromEntries(
    readFileSync(join(backups, name), 'utf8').trim().split('\n').map((line) => line.split('=')),
  );
  for (const key of ['supabase_db', 'timescaledb', 'storage']) {
    if (entries[key] && entries[key] !== 'physical') {
      assert.ok(written.includes(entries[key]), `the manifest names ${entries[key]}, which was not written`);
    }
  }
  return entries;
}

/** restore-databases.sh against the backup `run` took, and the replays it performed. */
function restore(backup) {
  const env = { ...backup.env, BACKUP_STAMP: manifest(backup).stamp, ASSUME_YES: 'true' };
  const result = spawnSync('bash', [RESTORE], { cwd: backup.work, env, encoding: 'utf8' });
  const log = join(backup.work, 'restore.log');
  return { ...result, replays: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [] };
}

test('with the defaults and no STORAGE_HOST_PATH, it stops before the first dump', { skip: SKIP }, () => {
  const r = run();
  assert.notEqual(r.status, 0);
  assert.equal(r.dumps, 0, 'pg_dump ran');
  assert.deepEqual(r.written, []);
  assert.match(r.stderr, /STORAGE_HOST_PATH=<path> /);
  assert.match(r.stderr, /INCLUDE_STORAGE=false /);
});

test('a STORAGE_HOST_PATH that is not a directory stops it before the first dump', { skip: SKIP }, () => {
  const r = run({ STORAGE_HOST_PATH: 'no-such-volume' });
  assert.notEqual(r.status, 0);
  assert.equal(r.dumps, 0, 'pg_dump ran');
  assert.deepEqual(r.written, []);
  assert.match(r.stderr, /'no-such-volume' is not a readable directory/);
});

for (const [setting, value] of [
  ['INCLUDE_STORAGE', 'yes'],
  ['DUMP_TIMESCALE', '1'],
  ['BACKUP_FORMAT', 'tar'],
  ['MIN_DUMP_BYTES', '2k'],
  ['MIN_DUMP_BYTES', '99999999999999999999'],
  ['BACKUP_RETENTION_DAYS', 'never'],
  ['BACKUP_RETENTION_DAYS', '99999999999999999999'],
]) {
  test(`${setting}=${value} stops it before the first dump`, { skip: SKIP }, () => {
    const r = run({ INCLUDE_STORAGE: 'false', [setting]: value });
    assert.notEqual(r.status, 0);
    assert.equal(r.dumps, 0, 'pg_dump ran');
    assert.deepEqual(r.written, []);
    assert.match(r.stderr, new RegExp(`${setting} must be`));
  });
}

test('with INCLUDE_STORAGE=false, the manifest names both dumps and no archive', { skip: SKIP }, () => {
  const r = run({ INCLUDE_STORAGE: 'false' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.dumps, 2);
  const entries = manifest(r);
  assert.ok(entries.supabase_db && entries.timescaledb);
  assert.equal(entries.storage, undefined);
});

test('with STORAGE_HOST_PATH, the manifest names the archive too', { skip: SKIP }, () => {
  const r = run({ STORAGE_HOST_PATH: 'storage' }, { storage: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(manifest(r).storage, /^storage-objects-.*\.tar\.gz$/);
});

test('a run that fails after the first dump removes what it wrote', { skip: SKIP }, () => {
  const r = run({ INCLUDE_STORAGE: 'false', PG_DUMP_FAIL_PORT: '5433' });
  assert.notEqual(r.status, 0);
  assert.equal(r.dumps, 2, 'the historian dump was never attempted');
  assert.deepEqual(r.written, []);
});

test('a run interrupted during a dump removes what it wrote', { skip: SKIP }, () => {
  const r = run({ INCLUDE_STORAGE: 'false', PG_DUMP_KILL_PORT: '5433' });
  assert.notEqual(r.status, 0);
  assert.equal(r.dumps, 2, 'the historian dump was never attempted');
  assert.deepEqual(r.written, []);
});

test('a run interrupted after its manifest is written keeps the backup whole', { skip: SKIP }, () => {
  const r = run({ INCLUDE_STORAGE: 'false' }, { interruptPrune: true });
  assert.notEqual(r.status, 0, 'the prune was never reached');
  assert.equal(r.dumps, 2);
  manifest(r);
});

for (const [format, storage] of [['plain', true], ['custom', false]]) {
  test(`restore-databases.sh replays each ${format} dump the manifest names, into its own database`, { skip: SKIP }, () => {
    const backup = run(
      storage ? { BACKUP_FORMAT: format, STORAGE_HOST_PATH: 'storage' } : { BACKUP_FORMAT: format, INCLUDE_STORAGE: 'false' },
      { storage },
    );
    assert.equal(backup.status, 0, backup.stderr);
    const r = restore(backup);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.replays, REPLAYS);
    assert.match(r.stdout, /PASS: both databases restored/);
    if (storage) assert.ok(r.stdout.includes(`Untar ${manifest(backup).storage}`), r.stdout);
  });
}

test('restore-databases.sh stops on a truncated plain dump, naming it', { skip: SKIP }, () => {
  const backup = run({ INCLUDE_STORAGE: 'false' });
  assert.equal(backup.status, 0, backup.stderr);
  const dump = join(backup.backups, manifest(backup).supabase_db);
  const bytes = readFileSync(dump);
  writeFileSync(dump, bytes.subarray(0, Math.floor(bytes.length / 2)));
  const r = restore(backup);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /restoring supabase-db from \S*supabase-db-\S+\.sql\.gz failed/);
  assert.ok(!r.replays.some((line) => line.startsWith('replay 5433 ')), 'the historian was replayed after it');
});

test('restore-databases.sh refuses a backup missing a file its manifest names', { skip: SKIP }, () => {
  const backup = run({ INCLUDE_STORAGE: 'false' });
  assert.equal(backup.status, 0, backup.stderr);
  rmSync(join(backup.backups, manifest(backup).timescaledb));
  const r = restore(backup);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /missing .*timescaledb-/);
  assert.deepEqual(r.replays, []);
});
