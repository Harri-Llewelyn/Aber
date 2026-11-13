import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 318. The API reference documents the evaluator's state table as 0270 declares it: each column is a
// property of AutomationTriggerState and each property is a column. A column left out is one a client
// never learns of; one documented after it is dropped is one it asks for and is refused.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const SPEC = 'docs/openapi.yaml';
  const spec = read(SPEC);
  const sql = read('supabase/migrations/0270_a_threshold_automation_is_read_against_the_historian.sql');
  const problems318 = [];
  const table = sql.match(/^CREATE TABLE IF NOT EXISTS public\.automation_trigger_states \(\n([\s\S]*?)\n\)/m)?.[1] ?? '';
  const columns = new Set();
  for (const line of table.split('\n')) {
    const name = /^ {4}([a-z][a-z0-9_]*) [a-z]/.exec(line)?.[1];
    if (name) columns.add(name);
  }
  if (columns.size < 8) problems318.push(`0270: found ${columns.size} columns of automation_trigger_states, so the table was not parsed`);
  const schema = spec.match(/^ {4}AutomationTriggerState:\n([\s\S]*?)(?=^ {4}\S)/m)?.[1] ?? '';
  const properties = new Set([...schema.matchAll(/^ {8}(\w+):/gm)].map((m) => m[1]));
  for (const c of columns) {
    if (!properties.has(c)) problems318.push(`${SPEC}: AutomationTriggerState does not document automation_trigger_states.${c}`);
  }
  for (const p of properties) {
    if (!columns.has(p)) problems318.push(`${SPEC}: AutomationTriggerState documents ${p}, which automation_trigger_states has no column for`);
  }
  if (!/^ {2}\/rest\/v1\/automation_trigger_states:\n/m.test(spec)) problems318.push(`${SPEC} has no /rest/v1/automation_trigger_states`);
  if (/^ {2}\/rest\/v1\/rpc\/(evaluate_automations|machine_condition_(rows|readings)):/m.test(spec)) {
    problems318.push(`${SPEC} documents a function of 0270 or 0271 that no API role may execute`);
  }
  if (problems318.length) {
    fail(`the API reference does not document the automations' state table as 0270 declares it:\n${problems318.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`docs/openapi.yaml documents the ${columns.size} columns of automation_trigger_states, and none of the functions no API role may execute`);
  }
}
