#!/usr/bin/env node
/**
 * Run the database suites against a throwaway Postgres, so they stop writing to the live stack.
 *
 * =================================================================================================
 * THE PROBLEM THIS EXISTS FOR, MEASURED RATHER THAN ASSUMED
 *
 * Every suite under supabase/migrations/ defaults to port 54322, and the dev loop's port-forward
 * publishes the LIVE Supabase database on exactly that port. So the documented way to run them --
 * `python supabase/migrations/test_audit_domain.py`, no environment set -- points at production
 * data, and always has.
 *
 * Most of them roll back. It does not help as much as it sounds: `digital_thread` is append-only by
 * 0003, and the rows a rolled-back test provokes are the ones a COMMITTED fixture leaves behind.
 * On this stack, at the time this was written:
 *
 *     525 digital_thread rows total
 *     346 of them (66%) stamped actor_source = 'migration'
 *
 * and not one of those 346 was written by a migration. `Test_Host_Run_Gateway` and
 * `Test_Remote_Gateway` -- 52 INSERT/DELETE pairs each, 208 rows -- come from
 * test_gateway_enrollment.py, which commits its fixtures deliberately (it pins their ids so a
 * failed run is reclaimed rather than accumulated) and deletes the rows on the way out. The
 * gateways table ends clean. The audit of their brief existence is permanent.
 *
 * THE `migration` LABEL IS WHY NOBODY NOTICED. 0070's classifier stamps that lane when a session
 * carries no JWT, and a psycopg2 connection as `postgres` carries none -- so test churn is filed
 * under the one actor_source an operator reads as "the schema did this, ignore it". Roughly 44 rows
 * per full run, accumulating for the life of the deployment.
 *
 * =================================================================================================
 * WHY A SEPARATE CONTAINER AND NOT A SECOND DATABASE ON THE LIVE CLUSTER
 *
 * `CREATE DATABASE aber_test` then pointing SUPABASE_DB_NAME at it is the obvious shape, and it does
 * not work. 0001 line 67 creates pg_cron, which refuses outside the one database named by the
 * cluster's `cron.database_name` GUC:
 *
 *     ERROR:  can only create extension in database postgres
 *     DETAIL: Jobs must be scheduled from the database configured in cron.database_name ...
 *
 * IF NOT EXISTS does not save it -- pg_cron raises from inside its own install script, so the
 * chain aborts on the first file. A throwaway cluster has its own `postgres` database and its own
 * GUC pointing at it, so the same line succeeds untouched.
 *
 * =================================================================================================
 * THE FIXTURE IS CI'S, BYTE FOR BYTE
 *
 * This reproduces what .github/workflows/ci.yml's edge-function-auth-test job already does, and
 * deliberately shares its auth bootstrap rather than restating it -- see test-harness/
 * auth-bootstrap.sql, which both callers apply. A local fixture that drifted from CI's would give
 * a suite two different verdicts with no clue which was the real one.
 *
 * seed.sql is NOT applied, for CI's reason: the suites seed their own fixtures, and the base
 * image's legacy auth.users lacks email_confirmed_at, is_sso_user, phone_change and other columns
 * the seed writes.
 *
 * =================================================================================================
 * WHAT THIS DOES NOT DO
 *
 * It does not PREVENT a suite being run against the live stack -- `SUPABASE_DB_PORT` still defaults
 * to 54322, because the dev loop forwards it there, validate.py derives from it and both backup scripts read it, so
 * changing the default here would be overridden by the environment in the common case and would
 * fight four other consumers in the rest. This makes the clean path a one-liner and documents the
 * dirty one. It is a paved road, not a fence.
 *
 * =================================================================================================
 * AN EMPTY DATABASE CANNOT EXERCISE AN ASSERTION ABOUT HISTORY
 *
 * Everything above builds the schema by replaying the chain onto nothing, which is what CI does and
 * what the migrations' own self-checks run against. A migration that asserts over ACCUMULATED ROWS
 * is invisible to all of it. 0120 asserted that no row in `digital_thread` disagreed with the
 * audit-domain classifier -- true of an empty database, false of any deployed stack, because a
 * retired entity type's rows keep the lane they were stamped with and nothing backfills them. It
 * passed 29 suites twice and then failed db-init four times on the dev cluster.
 *
 * `--with-history` closes that: it loads a deployed stack's rows over the migrated schema and
 * REPLAYS THE CHAIN, which is what db-init does on every boot of that stack.
 *
 *   node scripts/test-db.mjs --with-history                 # capture from the k3d dev cluster
 *   node scripts/test-db.mjs --with-history --history-out=h.sql
 *   node scripts/test-db.mjs --history-file=h.sql           # replay a captured one, no cluster
 *
 * The capture is READ-ONLY against the live stack (pg_dump and one COPY TO STDOUT) and writes only
 * to the throwaway container. Use it for any migration that touches existing rows -- anything with
 * an UPDATE, a DELETE, a new CHECK constraint, or a self-check that counts.
 * =================================================================================================
 *
 * Usage:
 *   node scripts/test-db.mjs              # bring up, migrate, run every suite, tear down
 *   node scripts/test-db.mjs --keep       # leave the container running afterwards
 *   node scripts/test-db.mjs --no-run     # bring up and migrate only, then stop
 *   node scripts/test-db.mjs -k test_role # run only suites whose filename contains this
 *   node scripts/test-db.mjs --with-history  # replay the chain against a deployed stack's rows
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { MIGRATION_VARS } from './migration-vars.mjs'
import { suitesInLane } from './python-suites.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// PINNED TO THE SAME TAG THE STACK RUNS. The bootstrap above is a list of things that are true of
// 17.6.1.160 specifically -- `postgres` not being superuser is the loudest -- so a floating tag
// would break this script on an image bump with an error about schema ownership that names nothing.
const IMAGE = 'supabase/postgres:17.6.1.160'
const CONTAINER = 'aber_test_db'

// NOT 54322. That is the live stack's published port, and the entire point of this script is to
// not be there. Overridable for the case of two checkouts running at once.
const PORT = process.env.ABER_TEST_DB_PORT || '54329'
const PASSWORD = 'postgres'

const args = process.argv.slice(2)
const keep = args.includes('--keep')
const noRun = args.includes('--no-run')
// Replay the chain a second time against a deployed stack's rows. See the block below.
const history = args.includes('--with-history') || args.some(a => a.startsWith('--history-file='))
const historyFile = args.find(a => a.startsWith('--history-file='))?.split('=').slice(1).join('=') || null
const historyOut = args.find(a => a.startsWith('--history-out='))?.split('=').slice(1).join('=') || null
const HISTORY_NS = process.env.ABER_NAMESPACE || 'aber'
const HISTORY_POD = process.env.ABER_DB_POD || 'supabase-db-0'
const filterIdx = args.findIndex(a => a === '-k')
const filter = filterIdx !== -1 ? args[filterIdx + 1] : null

const c = { dim: s => `\x1b[2m${s}\x1b[0m`, red: s => `\x1b[31m${s}\x1b[0m`,
            green: s => `\x1b[32m${s}\x1b[0m`, bold: s => `\x1b[1m${s}\x1b[0m` }

function run (cmd, cmdArgs, opts = {}) {
  return spawnSync(cmd, cmdArgs, { encoding: 'utf8', ...opts })
}

// The psql variables db-init passes. They live in scripts/migration-vars.mjs because ci.yml's
// migration loop needs the SAME ones -- it had none, and test_credential_revocation.py duly passed
// here and failed there the first time CI ran it (#147). That module carries the reasoning.

/** psql INSIDE the container, so this script needs no psql on the host -- only Docker. */
function psql (dbArgs, { user = 'postgres' } = {}) {
  const vars = Object.entries(MIGRATION_VARS).flatMap(([k, v]) => ['-v', `${k}=${v}`])
  return run('docker', [
    'exec', '-e', `PGPASSWORD=${PASSWORD}`, CONTAINER,
    'psql', '-v', 'ON_ERROR_STOP=1', ...vars, '-h', 'localhost', '-U', user, '-d', 'postgres', ...dbArgs
  ])
}

function die (message, detail) {
  console.error(`\n${c.red('FAILED')} ${message}`)
  if (detail) console.error(detail.trimEnd())
  if (!keep) teardown()
  process.exit(1)
}

function teardown () {
  run('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' })
}

// -------------------------------------------------------------------------------------------
// Bring it up
// -------------------------------------------------------------------------------------------
if (run('docker', ['info']).status !== 0) {
  console.error(c.red('Docker is not reachable. This script needs it; nothing else.'))
  process.exit(1)
}

// A LEFTOVER FROM --keep IS REPLACED, NOT REUSED. Reusing one would carry the previous run's
// committed fixtures into this one, which is the exact failure mode being escaped.
teardown()

console.log(`${c.bold('Starting')} throwaway ${IMAGE} on port ${PORT}…`)
const up = run('docker', [
  'run', '-d', '--name', CONTAINER,
  '-e', `POSTGRES_PASSWORD=${PASSWORD}`,
  // LOOPBACK ONLY, as the dev loop's forwards are. This one is
  // throwaway and short-lived, which changes how long the exposure lasts and not what it is:
  // a Postgres with a known password, published on every interface. Every consumer is the
  // suite runner on this machine.
  '-p', `127.0.0.1:${PORT}:5432`,
  IMAGE
])
if (up.status !== 0) die('could not start the container.', up.stderr)

// pg_isready ALONE IS NOT ENOUGH on this image: it reports ready during the init scripts' own
// restart, and a migration applied in that window dies mid-file. The SELECT is what the chart's
// readiness probe adds for the same reason -- see templates/supabase/db.yaml.
process.stdout.write('Waiting for Postgres')
let ready = false
for (let i = 0; i < 60; i++) {
  const probe = run('docker', ['exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-d', 'postgres'])
  if (probe.status === 0) {
    const select = psql(['-c', 'SELECT 1;'])
    if (select.status === 0) { ready = true; break }
  }
  process.stdout.write('.')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)
}
console.log('')
if (!ready) die('Postgres never became ready.', run('docker', ['logs', '--tail', '40', CONTAINER]).stderr)

// -------------------------------------------------------------------------------------------
// Bootstrap and migrate
// -------------------------------------------------------------------------------------------
const bootstrap = path.join(REPO, 'test-harness', 'auth-bootstrap.sql')
if (!existsSync(bootstrap)) die(`test-harness/auth-bootstrap.sql is missing.`)

console.log('Applying the GoTrue-shaped auth fixture (as supabase_admin)…')
const bootstrapSql = run('docker', ['cp', bootstrap, `${CONTAINER}:/tmp/auth-bootstrap.sql`])
if (bootstrapSql.status !== 0) die('could not copy the bootstrap in.', bootstrapSql.stderr)
const applied = psql(['-f', '/tmp/auth-bootstrap.sql'], { user: 'supabase_admin' })
if (applied.status !== 0) die('the auth bootstrap did not apply.', applied.stderr)

const searchPath = psql(['-c', 'ALTER ROLE postgres SET search_path TO auth, public, extensions;'])
if (searchPath.status !== 0) die('could not set the search_path.', searchPath.stderr)

const migrationsDir = path.join(REPO, 'supabase', 'migrations')
const migrations = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()
if (migrations.length === 0) die('no migrations found.')

const copied = run('docker', ['cp', migrationsDir, `${CONTAINER}:/migrations`])
if (copied.status !== 0) die('could not copy the migrations in.', copied.stderr)

/**
 * The chain, in filename order, exactly as db-init applies it. A function because `--with-history`
 * runs it TWICE: once onto an empty database to build the schema, and once more after a deployed
 * stack's rows are in -- which is the run that reproduces a boot on that stack.
 */
function applyChain (label) {
  console.log(`Applying ${migrations.length} migrations${label ? ` ${label}` : ''}…`)
  for (const file of migrations) {
    process.stdout.write(c.dim(`  ${file} `))
    const result = psql(['-f', `/migrations/${file}`])
    if (result.status !== 0) {
      console.log('')
      die(`migration ${file} did not apply${label ? ` ${label}` : ''}.`, result.stderr || result.stdout)
    }
    console.log(c.green('ok'))
  }
}

applyChain()

if (history) loadHistoryAndReplay()

// -------------------------------------------------------------------------------------------
// --with-history: replay the chain against a copy of a deployed stack's rows
// -------------------------------------------------------------------------------------------
// WHY THIS EXISTS, AND WHAT IT COST NOT TO HAVE IT. Every verification path in this repository
// replays the chain onto an EMPTY database: CI, this script, and the migrations' own self-checks.
// An assertion whose subject is accumulated data is invisible to all three, and the first thing it
// meets is a deployment. 0120 asserted that no row in digital_thread disagreed with the classifier
// -- true of an empty database, false of any stack with history, because a retired entity type's
// rows keep the lane they were stamped with. It passed 29 suites twice and then failed db-init
// four times on the dev cluster, taking the Helm upgrade with it.
//
// So: build the schema with the chain, put a real stack's rows into it, and REPLAY THE CHAIN. That
// second pass is what db-init does on every boot of a deployed stack, and it is the only thing that
// exercises a migration against history.
//
// WHAT IS COPIED, AND WHAT IS NOT. `public` in full -- the platform's own tables, which is what a
// migration asserts over. From `auth`, only `users`, and only the columns this harness's
// GoTrue-shaped fixture also has: the live schema carries 35 and the fixture 21, so the whole table
// cannot land, and `changed_by` is the column that makes an audit row attributable. The rest of
// `auth` is GoTrue's own bookkeeping, which no migration reads.

function kubectl (kArgs, opts = {}) {
  // MSYS_NO_PATHCONV, because Git Bash rewrites a container-absolute path into a Windows one
  // before kubectl sees it -- `/tmp/x` arrives as `C:/Users/.../tmp/x` and the exec fails naming
  // a path nobody wrote.
  return run('kubectl', ['-n', HISTORY_NS, ...kArgs],
    { ...opts, env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
}

/** One statement against the live stack, through the pod's local socket. No password, no forward. */
function livePsql (sql) {
  const r = kubectl(['exec', HISTORY_POD, '-c', 'supabase-db', '--',
    'psql', '-U', 'postgres', '-d', 'postgres', '-Atc', sql])
  if (r.status !== 0) die(`could not query ${HISTORY_POD}.`, r.stderr)
  return r.stdout.trim()
}

/**
 * The live rows, as SQL this container can run.
 *
 * Streamed with `exec -- cat` rather than `kubectl cp`, which refuses a Windows destination: it
 * reads the drive letter as a remote host spec and rejects the whole command.
 */
function captureHistory () {
  const ctx = run('kubectl', ['config', 'current-context'])
  if (ctx.status !== 0) {
    die('kubectl cannot reach a cluster, so there is no history to capture.',
        'Capture one where there is a cluster and pass it with --history-file=<path>.')
  }
  const context = ctx.stdout.trim()

  // A GUARD ON WHICH CLUSTER, because this copies real rows onto a laptop. The read is harmless
  // to the source; where the data ENDS UP is the thing worth a deliberate act. The dev cluster is
  // recognised by name and anything else has to be asked for.
  if (!/^k3d-/.test(context) && !process.env.ABER_HISTORY_ANY_CONTEXT) {
    die(`refusing to capture history from ${context}: it is not a k3d dev cluster.`,
        'Set ABER_HISTORY_ANY_CONTEXT=1 if that is really what you want.')
  }

  const pod = run('kubectl', ['-n', HISTORY_NS, 'get', 'pod', HISTORY_POD, '-o', 'name'],
    { env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
  if (pod.status !== 0) {
    die(`no ${HISTORY_POD} in ${HISTORY_NS} on ${context}.`,
        'Is the stack up? ABER_NAMESPACE and ABER_DB_POD override both names.')
  }

  console.log(`${c.bold('Capturing history')} from ${context}/${HISTORY_NS}/${HISTORY_POD}...`)

  // The columns BOTH sides have, in the target's order. Asked of each database rather than listed
  // here: the fixture and GoTrue both gain columns, and a list here would be wrong within a
  // quarter.
  const mine = psql(['-Atc',
    "SELECT column_name FROM information_schema.columns" +
    " WHERE table_schema='auth' AND table_name='users' ORDER BY ordinal_position;"])
  if (mine.status !== 0) die('could not read the local auth.users shape.', mine.stderr)
  const theirs = new Set(livePsql(
    "SELECT column_name FROM information_schema.columns" +
    " WHERE table_schema='auth' AND table_name='users';").split('\n').map(s => s.trim()).filter(Boolean))
  const shared = mine.stdout.trim().split('\n').map(s => s.trim()).filter(col => theirs.has(col))
  if (shared.length === 0) die('the two auth.users tables share no columns.')

  // `public` in full, plus auth.users as a TSV through COPY TO STDOUT. GoTrue's migration
  // bookkeeping is excluded explicitly: it is the one auth table pg_dump would otherwise reach.
  const users = kubectl(['exec', HISTORY_POD, '-c', 'supabase-db', '--', 'bash', '-c',
    'pg_dump -U supabase_admin -d postgres --data-only --schema=public ' +
    '--exclude-table=auth.schema_migrations -f /tmp/aber-history.sql 2>/dev/null && ' +
    'psql -U postgres -d postgres -Atc ' +
    '"COPY (SELECT ' + shared.join(', ') + ' FROM auth.users) TO STDOUT"'],
    { maxBuffer: 512 * 1024 * 1024 })
  if (users.status !== 0) die('pg_dump on the live stack failed.', users.stderr)

  const body = kubectl(['exec', HISTORY_POD, '-c', 'supabase-db', '--', 'cat', '/tmp/aber-history.sql'],
    { maxBuffer: 512 * 1024 * 1024 })
  if (body.status !== 0) die('could not read the dump back.', body.stderr)

  return [
    // Triggers and FK checks off for the load. The audit stamp trigger would re-stamp every row
    // from TODAY's classifier -- destroying the very history being reproduced -- and the dump's
    // table order cannot satisfy the circular foreign keys pg_dump warns about on `devices`,
    // `schemas` and `metric_catalog`. `postgres` is not superuser on this image, but Supabase
    // grants it this setting, which is what makes a data-only load possible here at all.
    'SET session_replication_role = replica;',
    // The chain seeds rows the dump also carries, so what it covers is emptied first.
    //
    // BY PRIVILEGE, NOT BY OWNERSHIP. `auth.users` is owned by supabase_auth_admin and `postgres`
    // may still truncate it -- an ownership test skipped it, left the fixture's seeded accounts
    // in place, and the COPY below then collided on users_pkey. Asking what this role MAY EMPTY
    // also excludes auth.schema_migrations, which it may not, without naming either table here.
    // A partition is emptied by its parent, so naming it again would be a second TRUNCATE of
    // nothing.
    'DO $hist$',
    'DECLARE r record;',
    'BEGIN',
    "  FOR r IN SELECT format('%I.%I', n.nspname, c.relname) AS t",
    '             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace',
    "            WHERE n.nspname IN ('public', 'auth')",
    "              AND c.relkind IN ('r', 'p')",
    "              AND pg_catalog.has_table_privilege(c.oid, 'TRUNCATE')",
    '              AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)',
    "  LOOP EXECUTE 'TRUNCATE TABLE ' || r.t || ' CASCADE'; END LOOP;",
    'END $hist$;',
    'COPY auth.users (' + shared.join(', ') + ') FROM stdin;',
    users.stdout.replace(/\r/g, '').replace(/\n$/, ''),
    '\\.',
    '',
    body.stdout.replace(/\r/g, '')
  ].join('\n')
}

function loadHistoryAndReplay () {
  let sql
  if (historyFile) {
    if (!existsSync(historyFile)) die(`${historyFile} does not exist.`)
    console.log(`${c.bold('Loading history')} from ${historyFile}...`)
    sql = readFileSync(historyFile, 'utf8')
  } else {
    sql = captureHistory()
    if (historyOut) {
      writeFileSync(historyOut, sql)
      console.log(c.dim(`  saved to ${historyOut} -- replay it later with --history-file=`))
    }
  }

  const staged = path.join(tmpdir(), 'aber-history-load.sql')
  writeFileSync(staged, sql)
  const copiedIn = run('docker', ['cp', staged, `${CONTAINER}:/tmp/history.sql`])
  if (copiedIn.status !== 0) die('could not copy the history in.', copiedIn.stderr)

  console.log('Loading it over the seeded schema...')
  const loaded = psql(['-f', '/tmp/history.sql'])
  if (loaded.status !== 0) die('the history did not load.', loaded.stderr || loaded.stdout)

  const rows = psql(['-Atc', 'SELECT count(*) FROM public.digital_thread;'])
  console.log(c.dim(`  ${rows.stdout.trim()} audit rows in place`))

  // THE ASSERTION. Everything above is setup; this is a boot of a deployed stack, and a migration
  // whose self-check is wrong about history fails here instead of in db-init.
  applyChain('against that history')
}

if (noRun) {
  console.log(`\n${c.green('Ready.')} Point a suite at it with:`)
  console.log(c.dim(`  SUPABASE_DB_PORT=${PORT} python supabase/migrations/test_audit_domain.py`))
  console.log(keep ? '' : c.dim(`\nTearing down (pass --keep to leave it up).`))
  if (!keep) teardown()
  process.exit(0)
}

// -------------------------------------------------------------------------------------------
// Run the suites
// -------------------------------------------------------------------------------------------
// THE `db` LANE, FROM scripts/python-suites.mjs -- not a second discovery of its own.
//
// NOT A DIRECTORY SCAN. Three suites needing exactly this database live under
// `supabase/functions/`, so a rule shaped like "the migrations directory" cannot reach them, and a
// local runner that misses what CI runs stops being trusted. The manifest is the one place that
// answers "which suites need a migrated Postgres" and both callers read it. It is checked against
// the tree in both directions, so a suite added here and forgotten fails the runner by name
// instead of silently not running.
let suites = suitesInLane('db')
if (filter) suites = suites.filter(f => f.includes(filter))
if (suites.length === 0) die(`no suites matched ${filter}.`)

const python = process.env.PYTHON || 'python'
const env = {
  ...process.env,
  SUPABASE_DB_HOST: 'localhost',
  SUPABASE_DB_PORT: PORT,
  SUPABASE_DB_NAME: 'postgres',
  SUPABASE_DB_USER: 'postgres',
  SUPABASE_DB_PASSWORD: PASSWORD,
  // THE BARE `DB_*` FALLBACKS ARE OVERRIDDEN TOO, not just the SUPABASE_ ones. Half the suites
  // read `os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))`, and a shell that has
  // shell set up for the stack lane carries DB_PORT=5433 -- the HISTORIAN. Leaving it set sends those suites to a
  // TimescaleDB that has none of this schema, and the failure names a missing table rather than
  // the wrong database.
  DB_HOST: 'localhost',
  DB_PORT: PORT,
  DB_NAME: 'postgres',
  DB_USER: 'postgres',
  DB_PASSWORD: PASSWORD
}

console.log(`\n${c.bold(`Running ${suites.length} database suites`)} against localhost:${PORT}\n`)
const failed = []
for (const suite of suites) {
  console.log(c.bold(`── ${suite}`))
  const result = spawnSync(python, [suite], { cwd: REPO, env, stdio: 'inherit' })
  if (result.status !== 0) failed.push(suite)
}

console.log('')
if (failed.length > 0) {
  console.log(c.red(`${failed.length} of ${suites.length} suites failed:`))
  for (const suite of failed) console.log(c.red(`  ${suite}`))
} else {
  console.log(c.green(`All ${suites.length} suites passed.`))
}

if (keep) {
  console.log(c.dim(`\nContainer ${CONTAINER} left running on port ${PORT}.`))
  console.log(c.dim(`  docker rm -f ${CONTAINER}`))
} else {
  teardown()
}

process.exit(failed.length > 0 ? 1 : 0)
