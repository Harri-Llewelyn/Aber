import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 327. The API reference describes telemetry_carried_by_group() as 0276 declares it: the arguments
// the body requires are the function's, and a row has the columns it returns. A reader building on
// the reference sends an argument the function does not take, or looks for a column it does not return.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const sql = read('supabase/migrations/0276_history_folds_one_metric_across_the_devices_of_each_group.sql')
    .match(/telemetry_carried_by_group\(([\s\S]*?)\) RETURNS TABLE \(([\s\S]*?)\)\s+LANGUAGE/);
  const spec = read('docs/openapi.yaml');
  const path = spec.match(/\n {2}\/rest\/v1\/rpc\/telemetry_carried_by_group:\n[\s\S]*?required: \[([^\]]*)\]/)?.[1];
  const row = spec.match(/\n {4}TelemetryGroupRow:\n[\s\S]*?properties:\n([\s\S]*?)\n\n/)?.[1];
  const problems327 = [];
  if (!sql) problems327.push('could not read telemetry_carried_by_group() out of 0276');
  if (!path) problems327.push('docs/openapi.yaml has no /rest/v1/rpc/telemetry_carried_by_group with its required arguments');
  if (!row) problems327.push('docs/openapi.yaml has no TelemetryGroupRow');
  if (!problems327.length) {
    const names = (text, re) => [...text.matchAll(re)].map((m) => m[1]).sort().join(', ');
    const args = names(sql[1], /^\s*(\w+) [a-z]/gm);
    const columns = names(sql[2], /^\s*(\w+) [a-z]/gm);
    const required = names(path, /(\w+)/g);
    const described = names(row, /^ {8}(\w+):/gm);
    if (required !== args) problems327.push(`docs/openapi.yaml requires ${required}; telemetry_carried_by_group() takes ${args}`);
    if (described !== columns) problems327.push(`docs/openapi.yaml's TelemetryGroupRow has ${described}; the function returns ${columns}`);
  }
  if (problems327.length) {
    fail('The API reference describes telemetry_carried_by_group() otherwise than 0276 declares it:\n' +
      problems327.map((p) => `        ${p}`).join('\n'));
  } else {
    pass('the API reference names the arguments and the columns of telemetry_carried_by_group() as 0276 declares them');
  }
}
