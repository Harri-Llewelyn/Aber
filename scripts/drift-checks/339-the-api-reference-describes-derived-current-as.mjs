import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 339. The API reference describes derived_current() as 0282 declares it, and says its windows as
// derived_window_minutes() holds them: the arguments the body requires, the columns of a value, and
// the two numbers window_minutes takes.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const migration = read('supabase/migrations/0282_history_draws_a_derived_metric_from_the_minutes.sql');
  const sql = migration.match(/public\.derived_current\(([^)]*)\)\s*RETURNS TABLE \(([\s\S]*?)\)\s+LANGUAGE/);
  const windows = [...new Set([...migration.matchAll(/WHEN '[a-z_]+' THEN (\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => b - a);
  const spec = read('docs/openapi.yaml');
  const path = spec.match(/\n {2}\/rest\/v1\/rpc\/derived_current:\n[\s\S]*?required: \[([^\]]*)\]/)?.[1];
  const row = spec.match(/\n {4}DerivedCurrentValue:\n[\s\S]*?properties:\n([\s\S]*?)\n\n/)?.[1];
  const problems339 = [];
  if (!sql) problems339.push('could not read derived_current() out of 0282');
  if (windows.length === 0) problems339.push('could not read derived_window_minutes() out of 0282');
  if (!path) problems339.push('docs/openapi.yaml has no /rest/v1/rpc/derived_current with its required arguments');
  if (!row) problems339.push('docs/openapi.yaml has no DerivedCurrentValue');
  if (!problems339.length) {
    const names = (text, re) => [...text.matchAll(re)].map((m) => m[1]).sort().join(', ');
    const args = names(sql[1], /(\w+) text\[\]/g);
    const columns = names(sql[2], /^\s*(\w+) [a-z]/gm);
    const required = names(path, /(\w+)/g);
    const described = names(row, /^ {8}(\w+):/gm);
    const enumerated = row.match(/window_minutes: \{[^}]*enum: \[([^\]]*)\]/)?.[1].split(',').map((n) => Number(n.trim())).sort((a, b) => b - a);
    if (required !== args) problems339.push(`docs/openapi.yaml requires ${required}; derived_current() takes ${args}`);
    if (described !== columns) problems339.push(`docs/openapi.yaml's DerivedCurrentValue has ${described}; the function returns ${columns}`);
    if (String(enumerated) !== String(windows)) {
      problems339.push(`docs/openapi.yaml's window_minutes takes ${enumerated}; derived_window_minutes() answers ${windows}`);
    }
  }
  if (problems339.length) {
    fail('The API reference describes derived_current() otherwise than 0282 declares it:\n' +
      problems339.map((p) => `        ${p}`).join('\n'));
  } else {
    pass('the API reference names the arguments, the columns and the windows of derived_current() as 0282 declares them');
  }
}
