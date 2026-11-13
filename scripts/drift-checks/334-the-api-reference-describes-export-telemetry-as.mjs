import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 334. The API reference describes export_telemetry() as 0279 declares it: the arguments the body
// requires are the function's own, the resolution's choices are the ones it admits, and the document
// has the keys it returns. A reader building on the reference sends an argument the function does not
// take, or looks for a key it does not return.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const migration = read('supabase/migrations/0279_an_export_of_readings_is_bounded_and_recorded_in_the_database.sql');
  const sql = migration.match(/FUNCTION public\.export_telemetry\(([\s\S]*?)\) RETURNS jsonb/);
  const spec = read('docs/openapi.yaml');
  const path = spec.match(/\n {2}\/rest\/v1\/rpc\/export_telemetry:\n[\s\S]*?required: \[([^\]]*)\][\s\S]*?resolution: \{ type: string, enum: \[([^\]]*)\]/);
  const document = spec.match(/\n {4}TelemetryExport:\n[\s\S]*?properties:\n([\s\S]*?)\n\n/)?.[1];
  const keys = migration.match(/RETURN jsonb_build_object\(([\s\S]*?)\);\nEND;/)?.[1];
  const problems334 = [];
  if (!sql) problems334.push('could not read export_telemetry() out of 0279');
  if (!path) problems334.push('docs/openapi.yaml has no /rest/v1/rpc/export_telemetry with its required arguments and resolutions');
  if (!document) problems334.push('docs/openapi.yaml has no TelemetryExport');
  if (!keys) problems334.push('could not read the keys export_telemetry() returns out of 0279');
  if (!problems334.length) {
    const names = (text, re) => [...text.matchAll(re)].map((m) => m[1]).sort().join(', ');
    // The arguments with no default are the required ones; resolution has one.
    const args = names(sql[1].replace(/DEFAULT\s+'[^']*'/g, '').split('\n').filter((l) => !/resolution text/.test(l)).join('\n'), /^\s*(\w+) [a-z]/gm);
    const required = names(path[1], /(\w+)/g);
    const admitted = [...migration.matchAll(/NOT v_res = ANY \(ARRAY\[([^\]]*)\]\)/g)].map((m) => names(m[1], /'([^']+)'/g))[0];
    const offered = names(path[2], /(\w+)/g);
    const returned = names(keys, /^\s*'(\w+)',/gm);
    const described = names(document, /^ {8}(\w+):/gm);
    if (required !== args) problems334.push(`docs/openapi.yaml requires ${required}; export_telemetry() requires ${args}`);
    if (offered !== admitted) problems334.push(`docs/openapi.yaml offers the resolutions ${offered}; export_telemetry() admits ${admitted}`);
    if (described !== returned) problems334.push(`docs/openapi.yaml's TelemetryExport has ${described}; the function returns ${returned}`);
  }
  if (problems334.length) {
    fail('The API reference describes export_telemetry() otherwise than 0279 declares it:\n' +
      problems334.map((p) => `        ${p}`).join('\n'));
  } else {
    pass('the API reference names the arguments, the resolutions and the document of export_telemetry() as 0279 declares them');
  }
}
