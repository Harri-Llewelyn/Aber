#!/usr/bin/env node
/**
 * Run the database suites against a throwaway Postgres, so they stop writing to the live stack.
 *
 * =================================================================================================
 * THE PROBLEM THIS EXISTS FOR, MEASURED RATHER THAN ASSUMED
 *
 * Every suite under supabase/migrations/ defaults to port 54322, and docker-compose.yml publishes
 * the LIVE Supabase database on exactly that port. So the documented way to run them --
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
 * `CREATE DATABASE acs_test` then pointing SUPABASE_DB_NAME at it is the obvious shape, and it does
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
 * to 54322, because .env sets it, validate.py derives from it and both backup scripts read it, so
 * changing the default here would be overridden by the environment in the common case and would
 * fight four other consumers in the rest. This makes the clean path a one-liner and documents the
 * dirty one. It is a paved road, not a fence.
 *
 * Usage:
 *   node scripts/test-db.mjs              # bring up, migrate, run every suite, tear down
 *   node scripts/test-db.mjs --keep       # leave the container running afterwards
 *   node scripts/test-db.mjs --no-run     # bring up and migrate only, then stop
 *   node scripts/test-db.mjs -k test_role # run only suites whose filename contains this
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { MIGRATION_VARS } from './migration-vars.mjs'
import { suitesInLane } from './python-suites.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// PINNED TO THE SAME TAG THE STACK RUNS. The bootstrap above is a list of things that are true of
// 17.6.1.160 specifically -- `postgres` not being superuser is the loudest -- so a floating tag
// would break this script on an image bump with an error about schema ownership that names nothing.
const IMAGE = 'supabase/postgres:17.6.1.160'
const CONTAINER = 'acs-cymru_test_db'

// NOT 54322. That is the live stack's published port, and the entire point of this script is to
// not be there. Overridable for the case of two checkouts running at once.
const PORT = process.env.ACS_TEST_DB_PORT || '54329'
const PASSWORD = 'postgres'

const args = process.argv.slice(2)
const keep = args.includes('--keep')
const noRun = args.includes('--no-run')
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
  // LOOPBACK ONLY, matching what docker-compose.yml now does with 5433 and 54322. This one is
  // throwaway and short-lived, which changes how long the exposure lasts and not what it is:
  // a Postgres with a known password, published on every interface. Every consumer is the
  // suite runner on this machine.
  '-p', `127.0.0.1:${PORT}:5432`,
  IMAGE
])
if (up.status !== 0) die('could not start the container.', up.stderr)

// pg_isready ALONE IS NOT ENOUGH on this image: it reports ready during the init scripts' own
// restart, and a migration applied in that window dies mid-file. The SELECT is what compose's
// healthcheck adds for the same reason -- see docker-compose.yml's supabase-db healthcheck.
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

console.log(`Applying ${migrations.length} migrations…`)
for (const file of migrations) {
  process.stdout.write(c.dim(`  ${file} `))
  const result = psql(['-f', `/migrations/${file}`])
  if (result.status !== 0) {
    console.log('')
    die(`migration ${file} did not apply.`, result.stderr || result.stdout)
  }
  console.log(c.green('ok'))
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
// This used to readdirSync `supabase/migrations` and run whatever it found, which was right about
// discovery and wrong about scope: three suites needing exactly this database live under
// `supabase/functions/`, and a rule shaped like "the migrations directory" could never reach them.
// They ran in CI and not here, so `npm run test:db` passing locally did not mean the db-lane job
// would pass -- which is the specific way a local runner stops being trusted.
//
// The manifest is now the one place that answers "which suites need a migrated Postgres", and both
// callers read it. It is also checked against the tree in both directions, so a new suite added to
// this directory and forgotten fails the runner by name instead of silently not running.
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
  // sourced .env carries DB_PORT=5433 -- the HISTORIAN. Leaving it set sends those suites to a
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
