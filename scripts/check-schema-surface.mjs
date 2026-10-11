#!/usr/bin/env node
/**
 * Asserts that the migration chain completed and that the telemetry read surface answers. db-init
 * is a Helm hook that replays every file on every install and upgrade; there is no
 * applied-migrations ledger, so completion is `schema_bootstrap.completed_at`, which db-init clears
 * before the chain and stamps after it. The surface is every foreign table in the `timescale`
 * schema that `0001` builds on the historian's server, and the `public` views over them. Grafana's
 * datasource health check reports OK throughout, since a connection test is not a permission test.
 * Each is selected, not merely looked up in the catalog: `to_regclass` does not say the foreign
 * table can be reached.
 *
 * Usage: node scripts/check-schema-surface.mjs, against the cluster the kube context points at.
 * Environment: ABER_NAMESPACE (default aber), DB_USER_NAME (postgres), DB_NAME (postgres).
 */
import { spawnSync } from 'node:child_process';

const NAMESPACE = process.env.ABER_NAMESPACE || 'aber';
const RELEASE = process.env.ABER_RELEASE || 'aber';
const DB_USER_NAME = process.env.DB_USER_NAME || 'postgres';
const DB_NAME = process.env.DB_NAME || 'postgres';

let failed = false;
const fail = (m) => { failed = true; console.log(`  FAIL  ${m}`); };
const pass = (m) => console.log(`  ok    ${m}`);

/**
 * Everything `0001` builds on the historian's foreign server, with the live migration that creates
 * it. `created_by` is a label, never read as a filename: the lowest missing one is printed as
 * where the chain stopped. Since the squash before 1.0, `0001` recreates all of them.
 */
const SURFACE = [
  { relation: 'public.telemetry',            created_by: '0001' },
  { relation: 'timescale.telemetry',         created_by: '0001' },
  { relation: 'timescale.telemetry_latest',  created_by: '0001' },
  { relation: 'timescale.telemetry_1m',      created_by: '0001' },
  { relation: 'timescale.telemetry_5m',      created_by: '0001' },
  { relation: 'timescale.telemetry_1h',      created_by: '0001' },
  { relation: 'public.telemetry_1h',         created_by: '0001' },
  { relation: 'timescale.telemetry_horizons', created_by: '0001' },
  { relation: 'public.telemetry_horizons',   created_by: '0001' },
  { relation: 'timescale.storage_footprint', created_by: '0001' },
  { relation: 'public.storage_footprint',    created_by: '0001' },
  { relation: 'timescale.telemetry_raw_window', created_by: '0001' },
];

/** psql inside the database pod, as the owner, over the socket: no password and no port-forward. */
function psql(sql) {
  const r = spawnSync('kubectl', [
    '-n', NAMESPACE, 'exec', 'statefulset/supabase-db', '--',
    'psql', '-U', DB_USER_NAME, '-d', DB_NAME, '-t', '-A', '-c', sql,
  ], { encoding: 'utf8', maxBuffer: 1 << 26 });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

console.log('Schema surface: the chain finished, and the objects 0001 builds over the FDW answer.\n');

const ready = spawnSync('kubectl', ['-n', NAMESPACE, 'get', 'statefulset/supabase-db',
  '-o', 'jsonpath={.status.readyReplicas}'], { encoding: 'utf8' });
if (ready.status !== 0 || ready.stdout.trim() !== '1') {
  console.log(`  skip   supabase-db is not running in namespace ${NAMESPACE}; bring the stack up first.`);
  process.exit(0);
}

const done = psql('SELECT completed_at IS NOT NULL FROM public.schema_bootstrap');
if (done.ok && done.out === 't') pass('schema_bootstrap.completed_at is stamped: the last db-init finished the chain');
else fail('schema_bootstrap.completed_at is not stamped: the last db-init did not finish the chain' +
  (done.ok ? '' : ` (${done.err.split('\n')[0]})`));

const missing = [];
for (const { relation, created_by } of SURFACE) {
  // SELECT rather than to_regclass: existence is the weaker question, and the failures worth
  // catching here reach the remote.
  const r = psql(`SELECT 1 FROM ${relation} LIMIT 1`);
  if (r.ok) {
    pass(`${relation} exists and is selectable`);
  } else {
    const reason = r.err.split('\n').find((l) => /ERROR/.test(l)) || r.err.split('\n')[0] || '';
    missing.push({ relation, created_by, reason });
    fail(`${relation} is not selectable — ${reason}`);
  }
}

console.log('');
if (missing.length) {
  const earliest = missing.map((m) => m.created_by).sort()[0];
  console.log(`The telemetry read surface is incomplete. The earliest missing object is created by ${earliest},`);
  console.log('so a chain stopped before that file finished, or the link to the historian is down. The');
  console.log('stack will otherwise look healthy: PostgREST answers, Grafana\'s');
  console.log('datasource reports OK, and only the panels fail.');
  console.log('');
  console.log(`  kubectl -n ${NAMESPACE} logs job/${RELEASE}-db-init | grep -i error`);
  console.log(`  kubectl -n ${NAMESPACE} create job db-init-replay --from=job/${RELEASE}-db-init   # replaying is safe; every file is idempotent`);
  process.exit(1);
}
console.log(`The read surface is complete (${SURFACE.length} relations).`);
process.exit(failed ? 1 : 0);
