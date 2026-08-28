#!/usr/bin/env node
/**
 * Asserts that the migration chain COMPLETED, by checking the objects a partial run leaves missing.
 *
 * =================================================================================================
 * WHY THIS EXISTS -- GitHub issue #40
 * =================================================================================================
 *
 * `docker compose up -d` prints `service "supabase-db-init" didn't complete successfully: exit 3`
 * exactly once, and then the stack runs. Nothing else notices. There is no applied-migrations
 * ledger by design, so there is also nothing that says the chain got to the end.
 *
 * That would be survivable if an aborted chain left the database merely out of date. It does not,
 * and the reason is `0001` section 3:
 *
 *     DROP SERVER IF EXISTS timescaledb_server CASCADE;
 *
 * The CASCADE takes every foreign table in the `timescale` schema with it, AND the `public` views
 * that select from them. They are recreated further down the chain -- `public.telemetry` later in
 * `0001`, the rollups in `0010`, `storage_footprint` in `0027`. So a migration that aborts anywhere
 * between them leaves the read surface DROPPED rather than stale.
 *
 * Observed on this stack: a deadlock at `0023` aborted the chain, `0027` never ran, and
 * `public.storage_footprint` stayed dropped. Grafana's datasource health check reported
 * `{"message":"Database Connection OK","status":"OK"}` throughout while every data-lifecycle panel
 * queried a view that no longer existed -- which is the trap timescaledb/roles.sql already names:
 * "A connection test is not a permission test."
 *
 * =================================================================================================
 * WHAT IT CHECKS, AND WHY NOT SOMETHING BROADER
 * =================================================================================================
 *
 * Only the objects downstream of that CASCADE. A full schema comparison would be a second, drifting
 * description of the migration chain -- the thing this repository refuses to keep in two places --
 * and it would fail on every legitimate schema change. This list is different: it is not "what the
 * schema looks like" but "what `0001` destroys and a later file must put back". It changes only
 * when the FDW projection changes.
 *
 * EACH IS SELECTED, NOT MERELY LOOKED UP IN THE CATALOG. `to_regclass` returning non-null says a
 * relation exists; it does not say the foreign table behind it can be reached, that the user
 * mapping authenticates, or that the remote still has the table. Those are exactly the failures
 * that present as a healthy stack with broken panels, so the check issues a real query.
 *
 * Usage:
 *   node scripts/check-schema-surface.mjs
 *
 * Environment: DB_CONTAINER (default supabase-db), DB_USER_NAME (postgres), DB_NAME (postgres).
 */

import { spawnSync } from 'node:child_process';

const DB_CONTAINER = process.env.DB_CONTAINER || 'supabase-db';
const DB_USER_NAME = process.env.DB_USER_NAME || 'postgres';
const DB_NAME = process.env.DB_NAME || 'postgres';

let failed = false;
const fail = (m) => { failed = true; console.log(`  FAIL  ${m}`); };
const pass = (m) => console.log(`  ok    ${m}`);
const note = (m) => console.log(`        ${m}`);

/**
 * Everything `0001`'s `DROP SERVER ... CASCADE` removes, with the migration that must put it back.
 * The `created_by` column is the diagnostic: it turns "storage_footprint is missing" into "the
 * chain did not reach 0027", which is the sentence somebody can act on.
 */
const SURFACE = [
  { relation: 'public.telemetry',            created_by: '0001' },
  { relation: 'timescale.telemetry',         created_by: '0001' },
  { relation: 'timescale.telemetry_latest',  created_by: '0010' },
  { relation: 'timescale.telemetry_1m',      created_by: '0010' },
  { relation: 'timescale.telemetry_5m',      created_by: '0010' },
  { relation: 'timescale.telemetry_1h',      created_by: '0010' },
  { relation: 'public.telemetry_1h',         created_by: '0010' },
  { relation: 'timescale.storage_footprint', created_by: '0027' },
  { relation: 'public.storage_footprint',    created_by: '0027' },
];

function psql(sql) {
  const r = spawnSync('docker', [
    'compose', 'exec', '-T', DB_CONTAINER, 'psql', '-U', DB_USER_NAME, '-d', DB_NAME,
    '-t', '-A', '-c', sql,
  ], { encoding: 'utf8', maxBuffer: 1 << 26 });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

console.log('Schema surface: the objects 0001 drops and later migrations must recreate.\n');

if (spawnSync('docker', ['version'], { stdio: 'ignore' }).status !== 0) {
  console.log('  skip   docker is not available; this check needs a running stack.');
  process.exit(0);
}
if (spawnSync('docker', ['compose', 'ps', '-q', DB_CONTAINER], { encoding: 'utf8' })
      .stdout.trim() === '') {
  console.log(`  skip   ${DB_CONTAINER} is not running; bring the stack up first.`);
  process.exit(0);
}

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
  console.log(`The migration chain did not complete. The earliest missing object is created by ${earliest},`);
  console.log('so the chain aborted before it — and 0001 had already dropped the whole read surface');
  console.log('by then. The stack will otherwise look healthy: PostgREST answers, Grafana\'s');
  console.log('datasource reports OK, and only the panels fail.');
  console.log('');
  console.log('  docker compose logs supabase-db-init | grep -i error');
  console.log('  docker compose up supabase-db-init        # replaying is safe; every file is idempotent');
  process.exit(1);
}

console.log(`The read surface is complete (${SURFACE.length} relations), so the chain reached the end.`);
