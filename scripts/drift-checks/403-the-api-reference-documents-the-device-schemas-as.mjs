import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 403. The API reference documents the device schemas calls as 0295 declares them: each function
// granted to authenticated under its own path with the arguments it declares and no others, and the
// result's schema. No Audit Trail action is added: the rows are the schemas table's own.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const SPEC = 'docs/openapi.yaml';
  const FUNCTIONS = 'supabase/migrations/0295_a_document_of_device_schemas_is_checked_and_applied_in_one_call.sql';
  const spec = read(SPEC);
  const sql = read(FUNCTIONS);
  const problems403 = [];
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
  const callable = granted.filter(([name]) => !/^device_schema_(document_of|stored_document)$/.test(name));
  if (callable.length !== 2) problems403.push(`${FUNCTIONS}: expected two functions for the page and the API, found ${callable.map(([n]) => n).join(', ') || 'none'}`);
  for (const [name] of callable) {
    const block = pathBlock(`/rest/v1/rpc/${name}`);
    if (!block) {
      problems403.push(`${SPEC} has no /rest/v1/rpc/${name}`);
      continue;
    }
    const head = `CREATE OR REPLACE FUNCTION public.${name}(`;
    const from = sql.indexOf(head);
    const args = from < 0 ? '' : sql.slice(from + head.length, sql.indexOf(')', from));
    const declared = [...args.matchAll(/\b(p_\w+)\b/g)].map((m) => m[1]).sort().join(', ');
    const properties = block.match(/\n {14}properties:\n([\s\S]*?)(?=\n {6}responses:)/)?.[1] ?? '';
    const documented = [...properties.matchAll(/^ {16}(p_\w+):/gm)].map((m) => m[1]).sort().join(', ');
    if (declared !== documented) problems403.push(`${SPEC}: /rest/v1/rpc/${name} documents the arguments "${documented}", ${FUNCTIONS} declares "${declared}"`);
  }
  if (!/^ {4}DeviceSchemaResult:/m.test(spec)) problems403.push(`${SPEC} has no DeviceSchemaResult schema`);
  const result = spec.match(/^ {4}DeviceSchemaResult:\n([\s\S]*?)(?=^ {4}\S)/m)?.[1] ?? '';
  const keys = [...sql.matchAll(/'(index|name|status|id|version|schema_name|changes|metrics|reasons)', /g)].map((m) => m[1]);
  for (const key of new Set(keys.filter((k) => k !== 'name' || sql.includes("'name', v_item -> 'key'")))) {
    if (!new RegExp(`^ {8}${key}:`, 'm').test(result)) problems403.push(`${SPEC}: DeviceSchemaResult does not describe the result's ${key}`);
  }
  if (sql.includes("'AUTOMATION_") || /action\s*=\s*'[A-Z_]*SCHEMA[A-Z_]*'/.test(sql)) {
    problems403.push(`${FUNCTIONS} writes an audit action of its own, which this check and the API reference do not expect: the rows are the schemas table's trigger's`);
  }
  if (problems403.length) {
    fail(`the API reference does not document the device schemas calls as 0295 declares them:\n${problems403.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`docs/openapi.yaml documents ${callable.map(([n]) => n).join(' and ')} with their arguments, and the result of an apply`);
  }
}
