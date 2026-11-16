import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 431. The API reference documents the derived metrics calls as 0297 declares them: each function
// granted to authenticated for a caller under its own path with the arguments it declares and no others,
// and the result's schema with every key the function answers. No Audit Trail action is added: the rows
// are the catalogue's own.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const SPEC = 'docs/openapi.yaml';
  const FUNCTIONS = 'supabase/migrations/0297_a_document_of_derived_metrics_is_checked_and_added_in_one_call.sql';
  const spec = read(SPEC);
  const sql = read(FUNCTIONS);
  const problems431 = [];
  // A path's block in the spec: from its key to the next path key, or the end of the paths.
  const pathBlock = (name) => {
    const start = spec.indexOf(`\n  ${name}:\n`);
    if (start < 0) return undefined;
    const rest = spec.slice(start + name.length + 5);
    const end = rest.search(/\n {2}\/|\n[a-z]/);
    return end < 0 ? rest : rest.slice(0, end);
  };
  const granted = [...sql.matchAll(/GRANT EXECUTE ON FUNCTION public\.(\w+)\(([^)]*)\) TO authenticated;/g)]
    .map((m) => [m[1], m[2]]);
  // The two shapers the reader runs as the caller are granted so it can, and are no one's to call.
  const callable = granted.filter(([name]) => !/^derived_metric_(document_of|description)$/.test(name));
  if (callable.length !== 2) problems431.push(`${FUNCTIONS}: expected two functions for the page and the API, found ${callable.map(([n]) => n).join(', ') || 'none'}`);
  for (const [name] of callable) {
    const block = pathBlock(`/rest/v1/rpc/${name}`);
    if (!block) {
      problems431.push(`${SPEC} has no /rest/v1/rpc/${name}`);
      continue;
    }
    const head = `CREATE OR REPLACE FUNCTION public.${name}(`;
    const from = sql.indexOf(head);
    const args = from < 0 ? '' : sql.slice(from + head.length, sql.indexOf(')', from));
    const declared = [...args.matchAll(/\b(p_\w+)\b/g)].map((m) => m[1]).sort().join(', ');
    const properties = block.match(/\n {14}properties:\n([\s\S]*?)(?=\n {6}responses:)/)?.[1] ?? '';
    const documented = [...properties.matchAll(/^ {16}(p_\w+):/gm)].map((m) => m[1]).sort().join(', ');
    if (declared !== documented) problems431.push(`${SPEC}: /rest/v1/rpc/${name} documents the arguments "${documented}", ${FUNCTIONS} declares "${declared}"`);
  }
  if (!/^ {4}DerivedMetricResult:/m.test(spec)) problems431.push(`${SPEC} has no DerivedMetricResult schema`);
  const result = spec.match(/^ {4}DerivedMetricResult:\n([\s\S]*?)(?=^ {4}\S)/m)?.[1] ?? '';
  // The keys apply_derived_metrics() gives each result, from the object it builds (it keeps `canon` to itself).
  const built = sql.match(/v_work := v_work \|\| jsonb_build_object\(([\s\S]*?)'canon', v_canon\);/)?.[1] ?? '';
  for (const key of ['index', 'name', 'status', 'id', 'units', 'derivation', 'reasons']) {
    if (!built.includes(`'${key}', `)) problems431.push(`${FUNCTIONS}: apply_derived_metrics() no longer gives a result its ${key}`);
    if (!result.split('\n').some((line) => line.startsWith(`${' '.repeat(8)}${key}:`))) problems431.push(`${SPEC}: DerivedMetricResult does not describe the result's ${key}`);
  }
  const statuses = [...new Set([...sql.matchAll(/'(new|unchanged|refused)'/g)].map((m) => m[1]))].sort().join(', ');
  const spoken = result.match(/status: \{ type: string, enum: \[([^\]]*)\] \}/)?.[1].split(',').map((s) => s.trim()).sort().join(', ');
  if (statuses !== spoken) problems431.push(`${SPEC}: DerivedMetricResult gives the statuses ${spoken}, ${FUNCTIONS} gives ${statuses}`);
  if (sql.includes("'AUTOMATION_") || /action\s*=\s*'[A-Z_]*METRIC[A-Z_]*'/.test(sql)) {
    problems431.push(`${FUNCTIONS} writes an audit action of its own, which this check and the API reference do not expect: the rows are the catalogue's trigger's`);
  }
  if (problems431.length) {
    fail(`the API reference does not document the derived metrics calls as 0297 declares them:\n${problems431.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`docs/openapi.yaml documents ${callable.map(([n]) => n).join(' and ')} with their arguments, and the result of an apply`);
  }
}
