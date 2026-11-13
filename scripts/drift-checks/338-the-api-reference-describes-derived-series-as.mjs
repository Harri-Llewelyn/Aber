import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 338. The API reference describes derived_series() as 0282 declares it: the arguments the body
// requires are the function's, and a row has the columns it returns. A reader building on the reference
// sends an argument the function does not take, or looks for a column it does not return.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const sql = read('supabase/migrations/0282_history_draws_a_derived_metric_from_the_minutes.sql')
    .match(/public\.derived_series\(([\s\S]*?)\) RETURNS TABLE \(([\s\S]*?)\)\s+LANGUAGE/);
  const spec = read('docs/openapi.yaml');
  const path = spec.match(/\n {2}\/rest\/v1\/rpc\/derived_series:\n[\s\S]*?required: \[([^\]]*)\]/)?.[1];
  const row = spec.match(/\n {4}DerivedSeriesBucket:\n[\s\S]*?properties:\n([\s\S]*?)\n\n/)?.[1];
  const problems338 = [];
  if (!sql) problems338.push('could not read derived_series() out of 0282');
  if (!path) problems338.push('docs/openapi.yaml has no /rest/v1/rpc/derived_series with its required arguments');
  if (!row) problems338.push('docs/openapi.yaml has no DerivedSeriesBucket');
  if (!problems338.length) {
    const names = (text, re) => [...text.matchAll(re)].map((m) => m[1]).sort().join(', ');
    const args = names(sql[1], /^\s*(\w+) [a-z]/gm);
    const columns = names(sql[2], /^\s*(\w+) [a-z]/gm);
    const required = names(path, /(\w+)/g);
    const described = names(row, /^ {8}(\w+):/gm);
    if (required !== args) problems338.push(`docs/openapi.yaml requires ${required}; derived_series() takes ${args}`);
    if (described !== columns) problems338.push(`docs/openapi.yaml's DerivedSeriesBucket has ${described}; the function returns ${columns}`);
  }
  if (problems338.length) {
    fail('The API reference describes derived_series() otherwise than 0282 declares it:\n' +
      problems338.map((p) => `        ${p}`).join('\n'));
  } else {
    pass('the API reference names the arguments and the columns of derived_series() as 0282 declares them');
  }
}
