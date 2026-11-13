import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 291. The API reference documents the automations as 0255 and 0256 declare them: the three tables
// under their own paths, each function granted to authenticated under its own path with the
// arguments it declares and no others, the result's schema and the five actions on AuditTrailEntry.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const SPEC = 'docs/openapi.yaml';
  const TABLES = 'supabase/migrations/0255_automations_are_kept_as_rows.sql';
  const FUNCTIONS = 'supabase/migrations/0256_a_document_of_automations_is_checked_and_applied_in_one_call.sql';
  const spec = read(SPEC);
  const sql = read(FUNCTIONS);
  const problems291 = [];
  // A path's block in the spec: from its key to the next path key, or the end of the paths.
  const pathBlock = (name) => {
    const start = spec.indexOf(`\n  ${name}:\n`);
    if (start < 0) return undefined;
    const rest = spec.slice(start + name.length + 5);
    const end = rest.search(/\n {2}\/|\n[a-z]/);
    return end < 0 ? rest : rest.slice(0, end);
  };
  for (const table of [...read(TABLES).matchAll(/CREATE TABLE IF NOT EXISTS public\.(\w+)/g)].map((m) => m[1])) {
    if (!pathBlock(`/rest/v1/${table}`)) problems291.push(`${SPEC} has no /rest/v1/${table}`);
  }
  const granted = [...sql.matchAll(/GRANT EXECUTE ON FUNCTION public\.(\w+)\(([^)]*)\) TO authenticated;/g)]
    .map((m) => [m[1], m[2]]);
  const callable = granted.filter(([name]) => !/^automation_(duration_text|document_of|stored_document)$/.test(name));
  if (callable.length !== 5) problems291.push(`${FUNCTIONS}: expected five functions for the page and the API, found ${callable.map(([n]) => n).join(', ') || 'none'}`);
  for (const [name] of callable) {
    const block = pathBlock(`/rest/v1/rpc/${name}`);
    if (!block) {
      problems291.push(`${SPEC} has no /rest/v1/rpc/${name}`);
      continue;
    }
    const head = `CREATE OR REPLACE FUNCTION public.${name}(`;
    const from = sql.indexOf(head);
    const args = from < 0 ? '' : sql.slice(from + head.length, sql.indexOf(')', from));
    const declared = [...args.matchAll(/\b(p_\w+)\b/g)].map((m) => m[1]).sort().join(', ');
    const properties = block.match(/\n {14}properties:\n([\s\S]*?)(?=\n {6}responses:)/)?.[1] ?? '';
    const documented = [...properties.matchAll(/^ {16}(p_\w+):/gm)].map((m) => m[1]).sort().join(', ');
    if (declared !== documented) problems291.push(`${SPEC}: /rest/v1/rpc/${name} documents the arguments "${documented}", ${FUNCTIONS} declares "${declared}"`);
  }
  for (const schema of ['Automation', 'AutomationTrigger', 'AutomationAction', 'AutomationResult']) {
    if (!new RegExp(`^ {4}${schema}:`, 'm').test(spec)) problems291.push(`${SPEC} has no ${schema} schema`);
  }
  const entry = spec.match(/^ {4}AuditTrailEntry:\n([\s\S]*?)(?=^ {4}\S)/m)?.[1] ?? '';
  const acts = [...new Set([...sql.matchAll(/'(AUTOMATION_[A-Z]+)'/g)].map((m) => m[1]))];
  if (acts.length !== 5) problems291.push(`${FUNCTIONS}: expected five AUTOMATION_ actions, found ${acts.join(', ') || 'none'}`);
  for (const act of acts) {
    if (!entry.includes(act)) problems291.push(`${SPEC}: AuditTrailEntry does not list ${act}`);
  }
  if (!/entity_type:[\s\S]*?enum:[^\]]*\bautomations\b/.test(entry)) problems291.push(`${SPEC}: AuditTrailEntry's entity_type does not list automations`);
  if (problems291.length) {
    fail(`the API reference does not document the automations as 0255 and 0256 declare them:\n${problems291.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`docs/openapi.yaml documents the three automations tables, ${callable.map(([n]) => n).join(', ')} with their arguments, and the five AUTOMATION_ actions`);
  }
}
