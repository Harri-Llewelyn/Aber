#!/usr/bin/env node
/**
 * Replays the migration chain a second time against the same database and asserts nothing moved.
 * There is no migrations ledger: db-init replays every file on every install and upgrade, so a
 * second run must match no rows. A live stack is not quiet, so the checks are things only a
 * migration can move. Strict: the schema itself, as a filtered `pg_dump --schema-only` digest; and
 * `digital_thread` rows with `actor_source = 'migration'`, which only a migration writes. Reported:
 * operator-facing row counts, where a fall across a replay is the signature of a destructive
 * one-shot re-running. The dump is filtered because modern pg_dump wraps its output in a `\restrict
 * <nonce>` pair that differs every run. The digest includes function bodies verbatim, so it is
 * sensitive to line endings: replaying from a CRLF tree and then an LF checkout genuinely changes
 * what is stored.
 *
 * The replay is the db-init hook Job as Helm rendered it for the installed release (`helm get
 * hooks`), re-created under a new name, so it runs the same image with the same environment. The
 * live Job cannot be cloned: it is gone once its TTL expires. The clone is deleted afterwards.
 *
 * Usage: node scripts/check-migration-idempotency.mjs, against the cluster the kube context points
 * at. Environment: ACS_CYMRU_NAMESPACE (default acs-cymru), ACS_CYMRU_RELEASE (acs-cymru),
 * DB_USER_NAME (postgres), DB_NAME (postgres).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const NAMESPACE = process.env.ACS_CYMRU_NAMESPACE || 'acs-cymru';
const RELEASE = process.env.ACS_CYMRU_RELEASE || 'acs-cymru';
const DB_USER_NAME = process.env.DB_USER_NAME || 'postgres';
const DB_NAME = process.env.DB_NAME || 'postgres';
const DB_INIT_JOB = `${RELEASE}-db-init`;
const REPLAY_JOB = `${RELEASE}-db-init-replay`;

let failed = false;
const fail = (m) => { failed = true; console.log(`  FAIL  ${m}`); };
const pass = (m) => console.log(`  ok    ${m}`);
const note = (m) => console.log(`        ${m}`);

function kubectl(args, opts = {}) {
  return spawnSync('kubectl', ['-n', NAMESPACE, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
}

/** psql inside the database pod, as the owner, over the socket. */
function psql(sql) {
  const r = kubectl(['exec', 'statefulset/supabase-db', '--', 'psql', '-U', DB_USER_NAME, '-d', DB_NAME,
    '-t', '-A', '-F', '', '-c', sql]);
  if (r.status !== 0) {
    throw new Error(`psql failed: ${(r.stderr || '').trim().split('\n').slice(-3).join(' ')}`);
  }
  return r.stdout.trim();
}

/** The schema, as a digest. Filtered: pg_dump emits a random `\restrict` nonce on every run. */
function schemaDigest() {
  const r = kubectl(['exec', 'statefulset/supabase-db', '--', 'pg_dump', '-U', DB_USER_NAME, '-d', DB_NAME,
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

// Operator-facing tables whose rows a replay must never delete. `one_shot_migrations` decides
// whether the destructive ones run at all, so losing its claim row is the failure.
const ROW_TABLES = ['devices', 'gateways', 'cells', 'links', 'schemas', 'one_shot_migrations'];

function rowCounts() {
  const parts = ROW_TABLES.map((t) => `SELECT '${t}' AS t, count(*) AS n FROM public.${t}`);
  const out = psql(parts.join(' UNION ALL '));
  const counts = new Map();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [t, n] = line.split('');
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

/** The db-init Job as Helm rendered it for the installed release, or null with the reason. */
function renderedDbInitJob() {
  const hooks = spawnSync('helm', ['-n', NAMESPACE, 'get', 'hooks', RELEASE], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (hooks.status !== 0) return { job: null, reason: (hooks.stderr || '').trim() };
  // kubectl turns the multi-document YAML into one JSON object per document, concatenated.
  const rendered = kubectl(['create', '--dry-run=client', '-o', 'json', '-f', '-'], { input: hooks.stdout });
  if (rendered.status !== 0) return { job: null, reason: (rendered.stderr || '').trim() };
  const objects = [];
  let buf = '';
  for (const line of rendered.stdout.split('\n')) {
    buf += line + '\n';
    if (line === '}') { objects.push(JSON.parse(buf)); buf = ''; }
  }
  const job = objects.find((o) => o.kind === 'Job' && o.metadata?.name === DB_INIT_JOB);
  return job ? { job } : { job: null, reason: `job/${DB_INIT_JOB} is not among the release's hooks` };
}

/** Run db-init again from the rendered hook and return its outcome. */
function replayChain(job) {
  kubectl(['delete', 'job', REPLAY_JOB, '--ignore-not-found', '--wait=true']);
  const clone = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: REPLAY_JOB, namespace: NAMESPACE, labels: { 'acs-cymru.io/replay-of': DB_INIT_JOB } },
    spec: { backoffLimit: job.spec.backoffLimit ?? 0, ttlSecondsAfterFinished: 600, template: job.spec.template },
  };
  const created = kubectl(['create', '-f', '-'], { input: JSON.stringify(clone) });
  if (created.status !== 0) {
    return { outcome: 'not started', detail: (created.stderr || '').trim() };
  }
  const deadline = Date.now() + 15 * 60 * 1000;
  let outcome = 'timeout';
  while (Date.now() < deadline) {
    if (kubectl(['get', `job/${REPLAY_JOB}`, '-o', 'jsonpath={.status.succeeded}']).stdout.trim() === '1') { outcome = 'succeeded'; break; }
    if (kubectl(['get', `job/${REPLAY_JOB}`, '-o', 'jsonpath={.status.conditions[?(@.type=="Failed")].status}']).stdout.trim() === 'True') { outcome = 'failed'; break; }
    spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
  }
  const logs = kubectl(['logs', `job/${REPLAY_JOB}`, '--tail=-1']).stdout || '';
  kubectl(['delete', 'job', REPLAY_JOB, '--ignore-not-found']);
  return { outcome, detail: logs };
}

// -------------------------------------------------------------------------------------------------
console.log('Migration idempotency: replaying the chain a second time and comparing.\n');

const ready = kubectl(['get', 'statefulset/supabase-db', '-o', 'jsonpath={.status.readyReplicas}']);
if (ready.status !== 0 || ready.stdout.trim() !== '1') {
  console.log(`  skip   supabase-db is not running in namespace ${NAMESPACE}; bring the stack up first.`);
  process.exit(0);
}
const { job, reason } = renderedDbInitJob();
if (!job) {
  console.log(`  skip   the release ${RELEASE} has no db-init hook to replay (${reason}); install it first.`);
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

console.log(`\nReplaying ${DB_INIT_JOB} as ${REPLAY_JOB}...\n`);
const replay = replayChain(job);
if (replay.outcome !== 'succeeded') {
  fail(`the replay ${replay.outcome}. The chain does not replay cleanly, which is a larger problem ` +
       `than idempotency: db-init runs on every install and upgrade.`);
  const tail = replay.detail.split('\n').filter(Boolean).slice(-20);
  for (const line of tail) note(`    ${line.slice(0, 160)}`);
  note('The last "Executing migration ..." line above the ERROR names the file.');
  note('Nothing below this point is meaningful -- a chain that aborts changes nothing, so the');
  note('schema, audit and data comparisons would all agree and all be vacuous.');
  process.exit(1);
}

const after = fingerprint();
console.log('');

// -- 1. The schema ---------------------------------------------------------------------------------
if (before.schema.digest !== after.schema.digest) {
  fail('the public schema changed across a replay of the same migration chain.');
  note('Only DDL moves this, and DDL between two runs of the same files is drift by definition.');
  // The diff, not just the verdict: both dumps exist here, so what moved is printed. Bounded,
  // because the useful signal is in the first few lines; GRANT and REVOKE lines are what this has
  // caught.
  const beforeLines = before.schema.body.split('\n');
  const afterLines = after.schema.body.split('\n');
  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);
  const gone = beforeLines.filter((l) => l.trim() && !afterSet.has(l));
  const added = afterLines.filter((l) => l.trim() && !beforeSet.has(l));

  const show = (label, lines) => {
    if (!lines.length) return;
    note(`${label} (${lines.length}):`);
    for (const line of lines.slice(0, 15)) note(`    ${line.slice(0, 160)}`);
    if (lines.length > 15) note(`    ... and ${lines.length - 15} more`);
  };
  show('only in the FIRST dump', gone);
  show('only in the SECOND dump', added);
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

// 3. Operator data. A rise is ordinary on a live stack; a fall is the signature of a destructive
// one-shot running a second time.
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
  console.log('The chain is NOT idempotent. Every migration replays on every install and upgrade, so');
  console.log('this is a defect that reaches every deployment on its next upgrade.');
  process.exit(1);
}
console.log('The migration chain replays cleanly: same schema, no new audit rows, no data lost.');
