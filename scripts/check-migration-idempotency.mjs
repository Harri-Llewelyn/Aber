#!/usr/bin/env node
/**
 * Replays the migration chain a second time against the same database and asserts nothing moved.
 *
 * =================================================================================================
 * WHY THIS EXISTS
 * =================================================================================================
 *
 * This repository has no migrations ledger. `supabase-db-init` replays EVERY file in
 * `supabase/migrations/*.sql` on EVERY boot, in filename order, so idempotency is not a nicety --
 * it is the property the whole schema model rests on. The house rule is "a second run must match no
 * rows".
 *
 * Until this script, that rule was enforced by review and by self-checks authors remembered to
 * write. CI booted the stack ONCE. Nothing replayed the chain twice against the same database and
 * compared, which is precisely the test that would have caught the failures the repository records
 * having found the hard way:
 *
 *   * 0040's "provision, then restart" landmine -- a one-shot purge that would run again;
 *   * the 0033 time-window false positive;
 *   * and, most recently, 0037 and 0038's self-checks appending nine audit rows per boot to a table
 *     that is append-only to every application role and cannot be pruned. By the time it was found,
 *     `migration` was the LARGEST actor_source in `digital_thread` -- 517 rows against 135 from real
 *     users -- with 496 of them pointing at probe gateways long since deleted.
 *
 * Every one of those is a one-line assertion once something actually runs the chain twice.
 *
 * =================================================================================================
 * WHAT IS ASSERTED, AND WHAT IS ONLY REPORTED
 * =================================================================================================
 *
 * A live stack is not quiet. The ingestion daemon writes telemetry and audit rows throughout, the
 * simulator publishes continuously, and the watchdog moves device statuses. A blunt "nothing changed
 * at all" assertion would fail on a healthy system and get disabled within a week.
 *
 * So the checks are chosen to be things ONLY A MIGRATION CAN MOVE:
 *
 *   STRICT   the schema itself -- a filtered `pg_dump --schema-only` digest. Nothing but DDL moves
 *            it, and DDL between two replays of the same chain is drift by definition.
 *
 *   STRICT   `digital_thread` rows with `actor_source = 'migration'`. The daemon writes 'ingestion',
 *            users write 'user', edge functions write 'service'. Only a migration writes this lane,
 *            so any increase across a replay is a migration writing to the audit trail on every
 *            boot -- the F4 class, exactly.
 *
 *   REPORTED operator-facing row counts. A RISE is ordinary -- a device can be discovered mid-run --
 *            but a FALL across a replay is the signature of a destructive one-shot re-running, which
 *            is what `one_shot_migrations` exists to prevent and what makes 0040 dangerous if its
 *            claim row is ever deleted. Reported as a failure when it falls, ignored when it rises.
 *
 * =================================================================================================
 * THE DUMP NEEDS FILTERING, AND FINDING THAT OUT WAS THE FIRST THING THIS SCRIPT DID
 * =================================================================================================
 *
 * Two consecutive `pg_dump --schema-only` runs with NOTHING between them produce different bytes:
 * modern pg_dump wraps its output in `\restrict <nonce>` / `\unrestrict <nonce>` with a fresh random
 * token each time. Digesting the dump raw would have made this guard fail on every run -- a flaky
 * check, which is worse than no check, because it teaches people to ignore it.
 *
 * THE DIGEST INCLUDES FUNCTION BODIES VERBATIM, WHITESPACE AND ALL, and that is deliberate: an
 * edited function body is exactly the drift this is looking for. One consequence is worth knowing
 * before it surprises somebody -- it is sensitive to LINE ENDINGS, because Postgres stores the
 * source text as given. Replaying the same migration from a CRLF working tree and then from an LF
 * checkout genuinely changes what is stored, and this reports it. That is correct, if startling;
 * it is not a reason to normalise the dump, since doing so would blind the check to real edits.
 *
 * Usage:
 *   node scripts/check-migration-idempotency.mjs
 *
 * Environment:
 *   DB_CONTAINER      compose service running Postgres        (default: supabase-db)
 *   DB_INIT_SERVICE   compose service that replays the chain  (default: supabase-db-init)
 *   DB_USER_NAME      role to inspect as                      (default: postgres)
 *   DB_NAME           database                                (default: postgres)
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const DB_CONTAINER = process.env.DB_CONTAINER || 'supabase-db';
const DB_INIT_SERVICE = process.env.DB_INIT_SERVICE || 'supabase-db-init';
const DB_USER_NAME = process.env.DB_USER_NAME || 'postgres';
const DB_NAME = process.env.DB_NAME || 'postgres';

let failed = false;
const fail = (m) => { failed = true; console.log(`  FAIL  ${m}`); };
const pass = (m) => console.log(`  ok    ${m}`);
const note = (m) => console.log(`        ${m}`);

function compose(args, opts = {}) {
  return spawnSync('docker', ['compose', ...args], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    ...opts,
  });
}

function psql(sql) {
  const r = compose(['exec', '-T', DB_CONTAINER, 'psql', '-U', DB_USER_NAME, '-d', DB_NAME,
                     '-t', '-A', '-F', '', '-c', sql]);
  if (r.status !== 0) {
    throw new Error(`psql failed: ${(r.stderr || '').trim().split('\n').slice(-3).join(' ')}`);
  }
  return r.stdout.trim();
}

/**
 * The schema, as a digest.
 *
 * FILTERED, see the header: pg_dump emits a random `\restrict` nonce on every run, so the raw bytes
 * never match themselves. Dropping those two lines is the whole difference between a guard and a
 * flake.
 */
function schemaDigest() {
  const r = compose(['exec', '-T', DB_CONTAINER, 'pg_dump', '-U', DB_USER_NAME, '-d', DB_NAME,
                     '--schema-only', '--schema=public']);
  if (r.status !== 0) {
    throw new Error(`pg_dump failed: ${(r.stderr || '').trim().split('\n').slice(-3).join(' ')}`);
  }
  const body = r.stdout
    .split('\n')
    .filter((l) => !/^\\(un)?restrict\s/.test(l))
    .join('\n');
  return { digest: createHash('sha256').update(body).digest('hex'), body };
}

const AUDIT_SQL =
  "SELECT count(*) FROM public.digital_thread WHERE actor_source = 'migration'";

// Operator-facing tables whose rows a replay must never DELETE. `one_shot_migrations` is here
// because it is the thing that decides whether the destructive ones run at all -- losing its claim
// row is the failure, not a symptom of one.
const ROW_TABLES = ['devices', 'gateways', 'cells', 'links', 'schemas', 'one_shot_migrations'];

function rowCounts() {
  const parts = ROW_TABLES.map((t) => `SELECT '${t}' AS t, count(*) AS n FROM public.${t}`);
  const out = psql(parts.join(' UNION ALL '));
  const counts = new Map();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [t, n] = line.split('');
    counts.set(t, Number(n));
  }
  return counts;
}

function fingerprint() {
  return {
    schema: schemaDigest(),
    migrationAuditRows: Number(psql(AUDIT_SQL)),
    rows: rowCounts(),
  };
}

// -------------------------------------------------------------------------------------------------

console.log('Migration idempotency: replaying the chain a second time and comparing.\n');

if (spawnSync('docker', ['version'], { stdio: 'ignore' }).status !== 0) {
  console.log('  skip   docker is not available; this check needs a running stack.');
  process.exit(0);
}
if (compose(['ps', '-q', DB_CONTAINER]).stdout.trim() === '') {
  console.log(`  skip   ${DB_CONTAINER} is not running; bring the stack up first.`);
  process.exit(0);
}

let before;
try {
  before = fingerprint();
} catch (err) {
  console.log(`  skip   could not fingerprint the database: ${err.message}`);
  process.exit(0);
}
note(`before: schema ${before.schema.digest.slice(0, 12)}, ` +
     `${before.migrationAuditRows} migration audit row(s)`);

console.log(`\nReplaying ${DB_INIT_SERVICE}...\n`);
const replay = compose(['up', '--force-recreate', DB_INIT_SERVICE], { stdio: 'inherit' });
if (replay.status !== 0) {
  fail(`${DB_INIT_SERVICE} exited ${replay.status}. The chain does not replay cleanly, which is a ` +
       `larger problem than idempotency: db-init runs on every boot.`);
  process.exit(1);
}

const after = fingerprint();
console.log('');

// -- 1. The schema ---------------------------------------------------------------------------------
if (before.schema.digest !== after.schema.digest) {
  fail('the public schema changed across a replay of the same migration chain.');
  note('Only DDL moves this, and DDL between two runs of the same files is drift by definition.');
  note('Compare with:  docker compose exec -T supabase-db pg_dump -U postgres --schema-only ' +
       '--schema=public');
} else {
  pass(`the public schema is unchanged (${before.schema.digest.slice(0, 12)})`);
}

// -- 2. The audit trail ----------------------------------------------------------------------------
const delta = after.migrationAuditRows - before.migrationAuditRows;
if (delta > 0) {
  fail(`a replay appended ${delta} row(s) to digital_thread as 'migration'.`);
  note('digital_thread is append-only to every application role and cannot be pruned, so a ' +
       'migration that writes to it on every boot grows the audit trail forever and fills it with ');
  note('synthetic entities. This is what 0037 and 0038 did before their self-checks were wrapped ' +
       'in a rolled-back sub-block -- see 0048 for the idiom.');
} else if (delta < 0) {
  fail(`a replay REMOVED ${-delta} row(s) from digital_thread. That table is append-only; ` +
       `something bypassed the trigger that enforces it.`);
} else {
  pass("a replay wrote no 'migration' rows to digital_thread");
}

// -- 3. Operator data ------------------------------------------------------------------------------
// A RISE is ordinary on a live stack -- a device can be discovered between the two fingerprints.
// A FALL is the signature of a destructive one-shot running a second time.
const lost = [];
for (const t of ROW_TABLES) {
  const b = before.rows.get(t);
  const a = after.rows.get(t);
  if (b === undefined || a === undefined) continue;
  if (a < b) lost.push(`${t}: ${b} -> ${a}`);
}
if (lost.length) {
  fail(`a replay DELETED operator data: ${lost.join(', ')}.`);
  note('This is what one_shot_migrations exists to prevent -- 0040 retires the demonstration seed ' +
       'by deleting rows, and its claim row is the only thing stopping a second run.');
  note('If one_shot_migrations itself fell, the claim was lost and every one-shot is re-armed.');
} else {
  pass(`no operator rows were deleted (${ROW_TABLES.length} tables checked)`);
}

console.log('');
if (failed) {
  console.log('The chain is NOT idempotent. Every migration replays on every boot, so this is a ');
  console.log('defect that reaches every deployment on its next restart.');
  process.exit(1);
}
console.log('The migration chain replays cleanly: same schema, no new audit rows, no data lost.');
