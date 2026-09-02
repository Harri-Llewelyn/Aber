#!/usr/bin/env node
// =================================================================================================
// Tear the local stack down to nothing and bring it back blank.
//
// WHY THIS EXISTS. `digital_thread` is append-only against every application role, so there is no
// way to clear demo noise from it short of dropping the volume -- and dropping the volume means
// re-running migrations, re-seeding accounts, and re-issuing four gateway credentials that
// `mosquitto_passwd` cannot read back. Done by hand that is a ten-minute sequence with three places
// to forget a step; the one that gets forgotten is the credentials, and the symptom is a gateway
// that authenticates against nothing at 9am.
//
// -------------------------------------------------------------------------------------------------
// WHY THIS IS NODE AND NOT BASH (issue #106)
//
// It was `scripts/stack-reset.sh`, and on Windows `npm` resolves `bash` to the WSL distribution,
// where Docker Desktop's integration is off by default. The failure is not that it refuses to
// start: THE FIRST ACTION IS `docker compose down -v`, so it exits after the teardown line and
// before anything is rebuilt, leaving the operator to work out which `docker` the shell found and
// whether the volumes are gone. A recovery tool whose failure mode is a half-destroyed stack is
// worse than no tool.
//
// That mattered more than it looks: README.md presents `npm run stack:reset` as the one-command
// reset, and `0040_retire_demonstration_seed.sql` names it as the way back from a retired
// demonstration floor. So the command a Windows operator is pointed at to RECOVER a stack was the
// one that could not run there -- on the path nobody exercises until something has already gone
// wrong.
//
// Every other entry in package.json is `node scripts/...`, and setup.mjs states the constraint this
// follows: "Cross-platform via node:fs, no POSIX shell required". Nothing here needs a shell.
// Subprocess environment is passed as an object rather than as a `VAR=x cmd` prefix, arguments are
// passed as an array rather than interpolated into a command line, and the `.env` fold that was an
// awk one-liner is a string transform.
//
// -------------------------------------------------------------------------------------------------
// THIS IS DESTRUCTIVE AND THE GUARDS ARE THE POINT.
//
//   * --yes is required. No interactive confirmation: a prompt is something people learn to hit
//     without reading, and this script is most dangerous when it is familiar.
//   * NODE_ENV=production refuses outright, and cannot be overridden by --yes.
//   * The compose project name must match this repository's, so a stray shell in the wrong
//     directory cannot take down a different stack that happens to be running.
//   * Docker must answer BEFORE the teardown runs. New here, and it is the specific defect above:
//     the tool must not destroy anything until it knows it can rebuild it.
//
// `docker compose down -v` drops supabase_db_data, and with it auth.sessions -- every logged-in
// browser is signed out. That is expected behaviour, documented in the README, and worth knowing
// before you run this against a stack someone else is demoing on.
// =================================================================================================
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `Usage: npm run stack:reset -- --yes [--timeout=SECONDS]

Destroys and rebuilds the local Docker Compose stack:

  1. docker compose down -v          (DROPS EVERY VOLUME -- all telemetry, all audit history)
  2. docker compose up -d
  3. wait for the telemetry hypertable, then for migrations and seeds to have been applied
  4. print the seeded accounts

WHAT COMES BACK IS BLANK -- no cells, no gateways, no devices, no schemas, and an empty Node-RED
editor. That is the same state a new install comes up in, and tutorial/README.md walks through
building the first machine by hand.

  --yes             required; there is no interactive prompt
  --timeout=N       seconds to wait for readiness (default 600)

  --discard-cold-archive
                    proceed even though telemetry exists ONLY on cold storage.
                    Those chunks were dropped from the hypertable because their
                    Parquet objects were verified; this destroys the objects and
                    the manifest together. Separate from --yes on purpose: it is
                    the one loss here that nothing can re-derive.
`;

// --- arguments ------------------------------------------------------------------------------
let confirmed = false;
let timeoutSeconds = Number(process.env.STACK_RESET_TIMEOUT || 600);

for (const arg of process.argv.slice(2)) {
  if (arg === '--yes') confirmed = true;
  // Read directly where it is used rather than into a variable here: it is a confirmation for one
  // guard, not a mode the rest of the script branches on.
  else if (arg === '--discard-cold-archive') { /* see the cold archive guard below */ }
  else if (arg.startsWith('--timeout=')) timeoutSeconds = Number(arg.slice('--timeout='.length));
  else if (arg === '-h' || arg === '--help') { process.stdout.write(USAGE); process.exit(0); }
  else { console.error(`Unknown argument '${arg}'. See --help.`); process.exit(2); }
}

if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
  console.error(`REFUSING: --timeout must be a positive number of seconds (got ${timeoutSeconds}).`);
  process.exit(2);
}

// --- guards ---------------------------------------------------------------------------------

// CHECKED BEFORE --yes, and not overridable by it. If this variable says production, the operator's
// intent and their environment disagree, and the environment is the one that cannot be a typo.
if (process.env.NODE_ENV === 'production') {
  console.error('REFUSING: NODE_ENV=production.');
  console.error('This script drops every volume in the stack. It is a local development tool.');
  process.exit(1);
}

if (!confirmed) {
  console.error(`REFUSING: --yes is required.

This destroys ALL local data:
  * every telemetry row in TimescaleDB
  * the entire digital_thread audit history, which is append-only and has no other way back
  * every logged-in browser session
  * every Mosquitto gateway credential (mosquitto_passwd stores hashes; they are NOT recoverable)

Re-run with --yes when that is what you mean.`);
  process.exit(1);
}

// A stray shell in the wrong directory must not take down a different stack. The project name is
// derived from the directory unless COMPOSE_PROJECT_NAME overrides it, so this checks the thing
// `docker compose down` will actually act on.
const expectedProject = basename(ROOT).toLowerCase().replace(/[^a-z0-9_-]/g, '');
const actualProject = process.env.COMPOSE_PROJECT_NAME || expectedProject;
if (actualProject !== expectedProject) {
  console.error(`REFUSING: COMPOSE_PROJECT_NAME is '${actualProject}' but this repository is '${expectedProject}'.`);
  console.error('That would tear down a stack this script does not own.');
  process.exit(1);
}

if (!existsSync(join(ROOT, '.env'))) {
  console.error(`REFUSING: no .env in ${ROOT}. Run 'npm run setup' first.`);
  process.exit(1);
}

// --- running things -------------------------------------------------------------------------

/**
 * Run a command, inheriting stdio. Arguments are an ARRAY and never a string: nothing here is
 * parsed by a shell, so a path containing a space is not a second argument.
 */
function run(command, args, { env, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    // `shell: true` would reintroduce exactly what this port removes. It is needed on Windows only
    // for shims like `npm.cmd`, and this script calls node and docker directly for that reason.
    shell: false,
    env: env ? { ...process.env, ...env } : process.env,
  });
  if (result.error) {
    if (allowFailure) return false;
    console.error(`\nFailed to run ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0 && !allowFailure) {
    console.error(`\n${command} ${args.join(' ')} exited ${result.status}.`);
    process.exit(1);
  }
  return result.status === 0;
}

/** Run a command and capture stdout, without inheriting stdio. Never throws. */
function capture(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', shell: false });
  if (result.error || result.status !== 0) return null;
  return (result.stdout || '').trim();
}

const step = (message) => process.stdout.write(`\n\x1b[1m==> ${message}\x1b[0m\n`);

/** One psql query against a container, returning trimmed stdout or null if anything failed. */
const psql = (container, sql) =>
  capture('docker', ['exec', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-tAc', sql]);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const TIMESCALE = 'acs-cymru_timescaledb';
const SUPABASE = 'acs-cymru_supabase_db';

// --- 0. docker answers ------------------------------------------------------------------------
// BEFORE THE TEARDOWN, WHICH IS THE WHOLE POINT OF #106. The shell version discovered that docker
// was unreachable at the moment it was already destroying volumes. Checking first costs one command
// and converts a half-destroyed stack into a refusal that changed nothing.
if (capture('docker', ['version', '--format', '{{.Server.Version}}']) === null) {
  console.error('REFUSING: docker is not answering.');
  console.error('');
  console.error('Nothing has been changed. This is checked BEFORE the teardown precisely so that a');
  console.error('missing or stopped Docker leaves the stack alone rather than half-destroyed.');
  console.error('');
  console.error('  * Is Docker Desktop running?');
  console.error('  * On Windows, is `docker` on PATH for this shell? (`docker version`)');
  process.exit(1);
}

// --- 0b. cold-archived telemetry is the one thing a reset cannot re-derive -------------------
//
// EVERY OTHER VOLUME THIS DESTROYS HOLDS SOMETHING THAT CAN COME BACK. Telemetry is re-published by
// the audit trail is re-seeded, broker credentials are re-minted from the dashboard, 3D models can
// be re-uploaded and captures re-recorded. That is what makes `down -v` a reasonable thing to offer
// at all.
//
// Cold-archived telemetry is different in kind, and it is the difference `storage-init.mjs` already
// writes on the bucket: "an object here is the ONLY remaining copy". Those chunks were dropped from
// the hypertable BECAUSE the object was verified. `down -v` takes `storage_data` (the objects) and
// the historian volume (the manifest that says where they went), so a reset destroys the data and
// the record of it in one step, leaving nothing to notice afterwards.
//
// ON COMPOSE THE OBJECTS ARE ON THIS HOST, which is what makes this reachable at all: STORAGE_BACKEND
// is `file` over a Docker volume, not a remote bucket. A stack pointed at real S3 would keep its
// archive through a reset -- the manifest would still go, which is its own problem, and one this
// warning names rather than hides.
if (!process.argv.includes('--discard-cold-archive')) {
  const archived = psql(
    TIMESCALE,
    "SELECT count(*) FROM public.telemetry_archive_manifest WHERE dropped_at IS NOT NULL"
  );

  if (archived === null) {
    // NOT SILENT. The check needs the historian running, and a stopped stack still has the volumes
    // -- so "could not ask" is a different answer from "nothing archived" and must not read like it.
    console.log('');
    console.log('NOTE: could not read the cold archive manifest (is the historian running?).');
    console.log('      If this stack has archived telemetry to cold storage, `down -v` will destroy');
    console.log('      both the objects and the manifest. Start the stack and re-run to be told.');
  } else if (Number(archived) > 0) {
    console.error('');
    console.error(`REFUSING: ${archived} telemetry chunk(s) exist ONLY on cold storage.`);
    console.error('');
    console.error('Those chunks were dropped from the hypertable because their Parquet objects were');
    console.error('verified. `docker compose down -v` destroys the storage volume holding those');
    console.error('objects AND the historian volume holding the manifest that says where they went,');
    console.error('so this would delete the data and the record of it together.');
    console.error('');
    console.error('Nothing has been changed. To see what would go:');
    console.error('  docker exec acs-cymru_supabase_db psql -U postgres -d postgres \\');
    console.error('    -c "SELECT chunk_name, range_start, range_end, row_count, object_key');
    console.error('        FROM cold_storage_rows() WHERE on_cold_storage"');
    console.error('');
    console.error('Copy the objects out first (scripts/backup-databases.sh takes STORAGE_HOST_PATH),');
    console.error('or re-run with --discard-cold-archive if that history is genuinely not wanted.');
    process.exit(1);
  }
}

// --- 1. down ------------------------------------------------------------------------------------
step('Tearing down (volumes included)');
run('docker', ['compose', 'down', '-v', '--remove-orphans']);

// --- 2. up --------------------------------------------------------------------------------------
step('Starting the stack');
run('docker', ['compose', 'up', '-d']);

// -------------------------------------------------------------------------------------------------
// AND IMMEDIATELY STOP THE SIMULATOR, WHICH IS A RACE THIS SCRIPT USED TO LOSE EVERY TIME.
//
// If `.env` carries NODE_RED_SEED_SIMULATOR=true -- which it does on any stack that has been reset
// before -- Node-RED comes up here with the simulator flow and sits in a connect-retry loop, because
// the broker has no gateway accounts yet. Provisioning then creates a gateway's broker credential
// BEFORE it inserts that gateway's device rows, and the waiting simulator connects into that gap and
// publishes immediately.
//
// Ingestion behaves correctly and that is what makes it confusing: an unregistered device announcing
// itself is auto-quarantined, so the reset finishes with five phantom rows in the onboarding queue,
// each a duplicate of a real device by `reported_identity` and none of them attached to a gateway.
// Measured on this repository: quarantined at 20:17:24.682, real device inserted at 20:17:25.003 --
// a 321ms window, lost every run.
//
// Stopping it here costs nothing, because step 5 force-recreates it anyway with the new credentials.
// The simulator has no reason to be publishing at any point before the fleet it publishes as exists.
// -------------------------------------------------------------------------------------------------

// --- 3. readiness -------------------------------------------------------------------------------
// WAIT FOR OBJECTS, NOT FOR PORTS. The postgres entrypoint runs its initdb scripts against a
// temporary server that already answers on the socket, so `pg_isready` is true well before the
// schema exists -- the same trap docker-compose.yml's own timescaledb-maintenance entrypoint calls
// out. Every check below names a specific object or row it needs.
const deadline = Date.now() + timeoutSeconds * 1000;

async function waitFor(description, predicate) {
  process.stdout.write(`    waiting for ${description}`);
  for (;;) {
    if (predicate()) { process.stdout.write(' ok\n'); return; }
    if (Date.now() >= deadline) {
      process.stdout.write(' TIMEOUT\n');
      console.error(`Timed out after ${timeoutSeconds}s waiting for ${description}.`);
      console.error('Inspect with: docker compose ps && docker compose logs --tail=50');
      process.exit(1);
    }
    process.stdout.write('.');
    await sleep(3000);
  }
}

step('Waiting for the databases');

await waitFor('the telemetry hypertable', () =>
  psql(TIMESCALE, "SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'telemetry'") === '1');

await waitFor('the telemetry rollups', () =>
  psql(TIMESCALE, "SELECT 1 FROM timescaledb_information.continuous_aggregates WHERE view_name = 'telemetry_1h'") === '1');

// The BI role is the last thing timescaledb-maintenance does, so its presence means that whole
// service completed rather than merely started.
await waitFor('the read-only BI role', () =>
  psql(TIMESCALE, "SELECT 1 FROM pg_roles WHERE rolname = 'powerbi_reader'") === '1');

// --- 4. migrations and seeds --------------------------------------------------------------------
step('Waiting for migrations and seeds');

// The LAST migration's work, not the first: db-init applies them in order, so checking something
// 0018 created proves the whole chain ran rather than that it started.
await waitFor('migrations (through 0018)', () =>
  psql(SUPABASE, "SELECT count(*) >= 4 FROM public.metric_catalog WHERE metric_group = 'BMS'") === 't');

await waitFor('the demo accounts', () =>
  psql(SUPABASE, 'SELECT count(*) >= 4 FROM auth.users') === 't');

// THE CAUSATION DEMONSTRATION, PROBED ONLY WHEN IT CAN EXIST -- AND THIS IS A REAL BUG FIX, NOT A
// TRANSLATION CHOICE.
//
// `seed.sql`'s final block commits one multi-entity act (commissioning Cell 1) so the Digital
// Thread drawer has a causation group to show. It is the file's LAST statement, which is why it
// makes a better completion probe than `auth.users` -- that is inserted at the top and goes true
// while the rest of the file is still running, or has failed.
//
// BUT IT IS CONDITIONAL ON A FLOOR EXISTING. Its subject is the machining gateway and three of its
// devices, and `seed.sql` skips with a NOTICE when that gateway is absent:
//
//     IF NOT EXISTS (SELECT 1 FROM public.gateways WHERE id = '1200...0001') THEN ... RETURN
//
// `down -v` removes the floor every single time, and re-creating it is OPT-IN. So on
// the rebuild there is no floor at this point, the seed correctly writes nothing, and the shell
// version waited 600 seconds for a row that could not appear before timing out the whole reset.
//
// THE CAUSATION DEMONSTRATION IS GONE WITH THE FLOOR, and so is the wait for it. seed.sql only
// commissions Cell 1 when the machining gateway exists, and nothing seeds that gateway any more,
// so the act it demonstrated never happens. Waiting for it here would hang until the timeout on
// every single run -- which is the failure the old conditional was written to dodge, now settled
// by there being no condition left to test.

await waitFor("PostgREST's database", () => psql(SUPABASE, 'SELECT 1') === '1');

// --- 6. summary ----------------------------------------------------------------------------------
step('Ready');

console.log(`Demo accounts (password: acscymru123)

  admin@acs-cymru.local       Administrator       full CRUD
  manager@acs-cymru.local     Shopfloor_Manager   full CRUD
  operator@acs-cymru.local    Operator            read-only + telemetry
  auditor@acs-cymru.local     Auditor             digital thread read-only

Interfaces

  Dashboard        http://localhost:3000
  Supabase Studio  http://127.0.0.1:54323
  Node-RED         http://localhost:1880
  Grafana          http://localhost:3002
  Swagger UI       http://localhost:8088

Sign in to the dashboard FIRST -- Node-RED and Grafana federate to Supabase Auth and the consent
step needs that session.`);


// THE AUDIT TRAIL IS EMPTY AFTER A RESET, and this says so rather than pointing at a
// demonstration that no longer exists. seed.sql used to commit one multi-entity act --
// commissioning Cell 1 -- so the Digital Thread drawer had a causation group to show on a fresh
// stack. It only did that when the machining gateway existed, and nothing seeds one now.
//
// NOTHING IS QUERIED HERE ANY MORE. The old block counted the rows of that act so the number
// could never go stale; with no act to count, a query would return zero on every run and the
// branch that handled zero is the only one left.
console.log('\nThe shopfloor is EMPTY, and that is the finished state rather than a step before');
console.log('provisioning: no cells, no gateways, no devices and no schemas. The only gateway on');
console.log('the stack is the Playback gateway, which exists because recorded captures have');
console.log('nowhere else to publish from. Node-RED opens on an empty editor.');
console.log('\nThe Digital Thread describes only what you do next. Follow tutorial/README.md to');
console.log('build one machine by hand: a cell, a gateway, its broker credential, a device and a');
console.log('schema, then a flow that publishes as it.');
