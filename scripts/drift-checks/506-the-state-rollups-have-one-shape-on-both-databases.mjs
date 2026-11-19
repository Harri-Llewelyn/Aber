import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 506. The state rollups have one shape on both databases. History marks a text or flag bucket past
// raw retention from telemetry_state_1m, _5m and _1h (timescaledb/aggregates.sql). The platform reads
// them through foreign tables of the same names, which persist across boots, so a column the
// historian adds, drops or reorders needs a statement in a migration. Each foreign table must state
// the rollup's columns in its order; telemetry_changes(), as the last migration declares it, may name
// only those three; fdw_reader, whom the foreign tables connect as, must be granted each in roles.sql.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const agg = read('timescaledb/aggregates.sql');
  const roles = read('timescaledb/roles.sql');
  const migrations = allFiles.filter((f) => /^supabase\/migrations\/\d{4}_[^/]*\.sql$/.test(f)).sort();
  const problems506 = [];

  // The historian's: each CREATE's SELECT list, up to its FROM, by alias.
  const rollups = new Map([...agg.matchAll(
    /CREATE MATERIALIZED VIEW IF NOT EXISTS (telemetry_state_\w+)\s+WITH \(timescaledb\.continuous\) AS\s+SELECT ([\s\S]*?)\n\s*FROM /g,
  )].map(([, name, list]) => [name, list.split(/,\s*\n/).map((item) => {
    const alias = item.trim().match(/\bAS (\w+)$/);
    return alias ? alias[1] : item.trim();
  })]));
  if (rollups.size !== 3) {
    problems506.push(`timescaledb/aggregates.sql creates ${rollups.size} state rollup(s) in a shape this check reads, not 3, so it is no longer checking them`);
  }

  for (const [name, columns] of rollups) {
    const declared = migrations.filter((f) => read(f).includes(`CREATE FOREIGN TABLE IF NOT EXISTS timescale.${name} (`));
    if (declared.length !== 1) {
      problems506.push(`timescale.${name} is declared as a foreign table in ${declared.length} migrations, not one`);
      continue;
    }
    const sql = read(declared[0]);
    const at = sql.indexOf(`CREATE FOREIGN TABLE IF NOT EXISTS timescale.${name} (`);
    const body = sql.slice(sql.indexOf('(', at) + 1, sql.indexOf('\n)', at));
    const foreign = body.split(',').map((c) => c.trim().split(/\s+/)[0]).filter(Boolean);
    if (foreign.join(',') !== columns.join(',')) {
      problems506.push(`${declared[0]} declares timescale.${name} with ${foreign.join(', ')}; the historian's rollup selects ${columns.join(', ')}`);
    }
    if (!sql.slice(at, sql.indexOf(';', at)).includes(`table_name '${name}'`)) {
      problems506.push(`${declared[0]}: timescale.${name} does not name the historian's ${name}`);
    }
  }

  const fdw = roles.slice(roles.indexOf("v_role     CONSTANT text := 'fdw_reader'"));
  const grant = fdw.match(/GRANT SELECT ON (public\.telemetry_state_1m, public\.telemetry_state_5m, '\s*'public\.telemetry_state_1h) TO %I/);
  if (!grant) problems506.push("timescaledb/roles.sql does not grant fdw_reader SELECT on the three state rollups in its block");

  const needle = 'CREATE OR REPLACE FUNCTION public.telemetry_changes(';
  const last = migrations.findLast((f) => read(f).includes(needle));
  if (last) {
    const sql = read(last);
    const fn = sql.slice(sql.lastIndexOf(needle), sql.indexOf('$fn$;', sql.lastIndexOf(needle)));
    const named = [...new Set([...fn.matchAll(/'(telemetry_state_\w+)'/g)].map((m) => m[1]))].sort();
    const unknown = named.filter((n) => !rollups.has(n));
    if (!named.length) problems506.push(`${last} declares telemetry_changes() last, and it reads no state rollup`);
    if (unknown.length) problems506.push(`${last}: telemetry_changes() reads ${unknown.join(', ')}, which the historian does not create`);
  } else {
    problems506.push('no migration declares telemetry_changes(), so this check is no longer checking it');
  }

  if (problems506.length) {
    for (const p of problems506) fail(p);
  } else {
    pass(`the ${rollups.size} state rollups have the same columns on the historian and as the platform's foreign tables, `
      + 'fdw_reader may read each, and telemetry_changes() reads only them');
  }
}
