#!/usr/bin/env node
/**
 * Asserts that the migration chain completed, by checking the objects a partial run leaves missing.
 * `docker compose up -d` prints db-init's failure once and the stack runs; there is no
 * applied-migrations ledger. An aborted chain does not leave the database merely stale: `0001` runs
 * `DROP SERVER IF EXISTS timescaledb_server CASCADE`, which drops every foreign table in the
 * `timescale` schema and the `public` views over them, recreated further down the chain. Grafana's
 * datasource health check reports OK throughout, since a connection test is not a permission test.
 * Only the objects downstream of that CASCADE are checked, and each is selected, not merely looked
 * up in the catalog: `to_regclass` does not say the foreign table can be reached.
 *
 * Usage: node scripts/check-schema-surface.mjs. Environment: DB_CONTAINER (default supabase-db),
 * DB_USER_NAME (postgres), DB_NAME (postgres).
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
 * The `created_by` column turns "storage_footprint is missing" into "the chain did not reach 0027".
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
