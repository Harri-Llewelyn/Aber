import { need, ok, problems, read, SCHEMA } from './lib.mjs';

// 114. A Submodel key is an idShort in the database and in the exporter. The CHECK on
// device_submodels.submodel_key (0298) admits what toIdShort() in shell.ts can make from a name: one
// letter first, then letters, digits and underscores. A key the database admitted that the exporter
// would not have made is an id no AAS tool accepts as an idShort; one the exporter makes that the
// database would refuse could never be written back as an override. The API reference states the same
// pattern for the column on both of its descriptions.
export default function check() {
  const before = problems.length;
  const shell = read('supabase/functions/_shared/aas/shell.ts');
  const body = shell.slice(shell.indexOf('export function toIdShort'), shell.indexOf('export function property'));
  const keeps = need(body, /\.replace\(\/\[\^([A-Za-z0-9_-]+)\]\/g, "_"\)/, 'the characters toIdShort() keeps');
  const first = need(body, /if \(!\/\^\[([A-Za-z-]+)\]\/\.test\(cleaned\)\) cleaned = `Id_\$\{cleaned\}`/, 'the first character toIdShort() requires');
  const check = SCHEMA.split('\n').filter((line) => line.includes('device_submodels_key_starts_with_a_letter CHECK')).pop() ?? '';
  const sql = need(check, /submodel_key ~ '\^\[([A-Za-z-]+)\]\[([A-Za-z0-9_-]+)\]\*\$'/, 'the CHECK device_submodels_key_starts_with_a_letter');
  if (keeps && first && sql) {
    if (sql[1] !== first[1]) problems.push(`idShortKey: the CHECK starts a key with [${sql[1]}] and toIdShort() with [${first[1]}]`);
    if (sql[2] !== keeps[1]) problems.push(`idShortKey: the CHECK admits [${sql[2]}] after the first character and toIdShort() keeps [${keeps[1]}]`);
  }
  const openapi = read('docs/openapi.yaml');
  const patterns = [...openapi.matchAll(/submodel_key:[^\n]*?pattern: '([^']+)'/g)].map((m) => m[1]);
  const wanted = sql ? `^[${sql[1]}][${sql[2]}]*$` : null;
  const detail = openapi.match(/submodel_key:\n\s+type: string\n\s+nullable: true\n\s+pattern: '([^']+)'/)?.[1];
  const found = [...patterns, detail].filter(Boolean);
  if (found.length < 2) problems.push('idShortKey: docs/openapi.yaml states the pattern of submodel_key in fewer than its two places (the attach request and DeviceSubmodel)');
  if (wanted) for (const p of found) if (p !== wanted) problems.push(`idShortKey: docs/openapi.yaml gives submodel_key the pattern ${p}, not the CHECK's ${wanted}`);
  if (problems.length === before) ok.push('idShortKey: the CHECK on device_submodels.submodel_key admits what toIdShort() makes, a letter and then letters, digits and underscores, and the API reference states the same pattern twice');
}
