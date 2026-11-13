import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 310. The API reference describes telemetry_hour_of_day() as 0265 declares it: the arguments the
// body requires are the function's, and a row has the columns it returns. A reader building on the
// reference sends an argument the function does not take, or looks for a column it does not return.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const sql = read('supabase/migrations/0265_history_averages_a_metric_by_the_hour_of_day.sql')
    .match(/telemetry_hour_of_day\(([\s\S]*?)\) RETURNS TABLE \(([\s\S]*?)\)\s+LANGUAGE/);
  const spec = read('docs/openapi.yaml');
  const path = spec.match(/\n {2}\/rest\/v1\/rpc\/telemetry_hour_of_day:\n[\s\S]*?required: \[([^\]]*)\]/)?.[1];
  const row = spec.match(/\n {4}TelemetryHourOfDayRow:\n[\s\S]*?properties:\n([\s\S]*?)\n\n/)?.[1];
  const problems310 = [];
  if (!sql) problems310.push('could not read telemetry_hour_of_day() out of 0265');
  if (!path) problems310.push('docs/openapi.yaml has no /rest/v1/rpc/telemetry_hour_of_day with its required arguments');
  if (!row) problems310.push('docs/openapi.yaml has no TelemetryHourOfDayRow');
  if (!problems310.length) {
    const names = (text, re) => [...text.matchAll(re)].map((m) => m[1]).sort().join(', ');
    const args = names(sql[1], /^\s*(\w+) [a-z]/gm);
    const columns = names(sql[2], /^\s*(\w+) [a-z]/gm);
    const required = names(path, /(\w+)/g);
    const described = names(row, /^ {8}(\w+):/gm);
    if (required !== args) problems310.push(`docs/openapi.yaml requires ${required}; telemetry_hour_of_day() takes ${args}`);
    if (described !== columns) problems310.push(`docs/openapi.yaml's TelemetryHourOfDayRow has ${described}; the function returns ${columns}`);
  }
  if (problems310.length) {
    fail('The API reference describes telemetry_hour_of_day() otherwise than 0265 declares it:\n' +
      problems310.map((p) => `        ${p}`).join('\n'));
  } else {
    pass('the API reference names the arguments and the columns of telemetry_hour_of_day() as 0265 declares them');
  }
}
