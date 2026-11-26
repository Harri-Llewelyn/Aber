import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROOT, compare, lastDefinition, need, ok, problems, read } from './lib.mjs';

// 173. The derived metrics a device has, one rule in three languages (0336): device_derived_metrics() in
// the database, derivedMetricsOfDevice() in the dashboard and derivedMetricsFor() in the AAS exporter. A
// device has the ones its schemas name, and a replay lane its original's. The dashboard's is run here
// over test-harness/fixtures/device-derived-metrics.json, and each of the three suites must read that
// file: a rule whose suite stopped reading it is a rule nothing holds. A page that offered a derived
// metric the database refuses a threshold on, or a shell that listed one the page does not, is the drift.
export default async function check() {
  const FIXTURE = 'test-harness/fixtures/device-derived-metrics.json';
  const rule = JSON.parse(read(FIXTURE));
  const sql = lastDefinition('CREATE OR REPLACE FUNCTION public.device_derived_metrics(', '$$;', 'device_derived_metrics()');
  const js = read('frontend/src/utils/derivedMetric.js');
  const api = read('frontend/src/api.js');
  const shell = read('supabase/functions/_shared/aas/shell.ts');
  if (!sql) return;

  // Whose schemas: the original's for a lane, else the device's own.
  const sqlOwner = need(sql.body, /ds\.device_id = coalesce\(d\.(\w+), d\.id\)/, `whose schemas device_derived_metrics() reads (${sql.file})`);
  const jsOwner = need(js, /export const derivedSchemaIds = \(device, idsByDevice\) => idsByDevice\.get\(device\.(\w+) \?\? device\.id\)/, 'derivedSchemaIds() in derivedMetric.js');
  const tsOwner = need(shell, /if \(device\.(\w+)\) \{\s+const \{ data: originalLinks \}/, "the lane's schemas in the exporter's loader");
  need(api, /derived_schema_ids: derivedSchemaIds\(d, schemasByDevice\)/, 'the ids api.js gives each device');
  if (sqlOwner && jsOwner && tsOwner) {
    compare('deviceDerivedMetrics', 'the column that names whose derived metrics a replay lane has', [jsOwner[1], tsOwner[1]].join(' and '), `${sqlOwner[1]} and ${sqlOwner[1]}`);
  }
  // What of them: the version's list, where the catalogue holds the name as a derived metric.
  const sqlColumn = need(sql.body, /unnest\(s\.(\w+)\) AS n\(name\)\s+JOIN public\.metric_catalog c ON c\.name = n\.name AND c\.derivation IS NOT NULL/, `the list device_derived_metrics() reads (${sql.file})`);
  const jsColumn = need(js, /\.flatMap\(s => s\.(\w+) \|\| \[\]\)\)\s+return \[\.\.\.named\]\.filter\(name => known\.has\(name\)\)/, 'the list derivedMetricsOfDevice() reads');
  const tsColumn = need(shell, /schemas\.flatMap\(\(s\) => \(Array\.isArray\(s\.(\w+)\) \? s\.\1 : \[\]\)\)/, 'the list derivedMetricsFor() reads');
  if (sqlColumn && jsColumn && tsColumn) {
    compare('deviceDerivedMetrics', 'the column of a schema version that names the derived metrics its devices get', [jsColumn[1], tsColumn[1]].join(' and '), `${sqlColumn[1]} and ${sqlColumn[1]}`);
  }

  // The dashboard's rule, run over the fixture.
  const { derivedMetricsOfDevice, derivedSchemaIds } = await import(pathToFileURL(join(ROOT, 'frontend/src/utils/derivedMetric.js')).href);
  const schemas = rule.schemas.map((s) => ({ schema_uuid: s.key, derived_metrics: s.derived_metrics }));
  const bound = new Map(rule.devices.map((d) => [d.key, d.schemas]));
  for (const d of rule.devices) {
    const device = { derived_schema_ids: derivedSchemaIds({ id: d.key, shadow_of: d.shadow_of ?? null }, bound) };
    const got = derivedMetricsOfDevice(device, schemas, rule.catalog).join(', ');
    if (got !== d.expected.join(', ')) problems.push(`deviceDerivedMetrics: ${FIXTURE}: ${d.key} has ${got || 'none'} in the dashboard and ${d.expected.join(', ') || 'none'} in the fixture`);
  }
  if (!rule.devices.some((d) => d.shadow_of) || rule.devices.length < 6) problems.push(`deviceDerivedMetrics: ${FIXTURE} holds too few devices, or no replay lane, to hold the rule`);

  // Every runner reads the file.
  const name = 'device-derived-metrics.json';
  for (const suite of [
    'frontend/src/__tests__/deviceDerivedMetrics.test.js',
    'supabase/migrations/test_a_device_has_the_derived_metrics_its_schemas_name.py',
    'supabase/functions/_shared/aas/derived_metrics_test.ts',
  ]) {
    if (!read(suite).includes(name)) problems.push(`deviceDerivedMetrics: ${suite} no longer reads ${FIXTURE}, so nothing holds its rule to the others`);
  }
  // The rule this one replaced is gone from the dashboard and the exporter.
  for (const [file, text] of [['frontend/src/utils/derivedMetric.js', js], ['supabase/functions/_shared/aas/shell.ts', shell]]) {
    if (/derivedReportedBy|inputs\.every\(/.test(text)) problems.push(`deviceDerivedMetrics: ${file} decides by what a device reports again: a schema names it`);
  }
  ok.push(`deviceDerivedMetrics: ${rule.devices.length} devices of ${FIXTURE} have the fixture's derived metrics in the dashboard, and three suites read it`);
}
