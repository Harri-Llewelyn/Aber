import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 334. The API reference describes export_telemetry() as the last migration to declare it does (0279,
// and 0296 after it): the arguments the body requires are the function's own, the resolution's choices
// are the ones it admits, and the document has the keys it returns. A reader building on the reference
// sends an argument the function does not take, or looks for a key it does not return.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const declaring = allFiles.filter((f) => /^supabase\/migrations\/\d{4}_[^/]*\.sql$/.test(f)
    && read(f).includes('CREATE OR REPLACE FUNCTION public.export_telemetry(')).sort();
  const migration = declaring.length ? read(declaring[declaring.length - 1]) : '';
  const sql = migration.match(/FUNCTION public\.export_telemetry\(([\s\S]*?)\) RETURNS jsonb/);
  const spec = read('docs/openapi.yaml');
  const path = spec.match(/\n {2}\/rest\/v1\/rpc\/export_telemetry:\n[\s\S]*?required: \[([^\]]*)\][\s\S]*?resolution: \{ type: string, enum: \[([^\]]*)\]/);
  const document = spec.match(/\n {4}TelemetryExport:\n[\s\S]*?properties:\n([\s\S]*?)\n\n/)?.[1];
  const keys = migration.match(/RETURN jsonb_build_object\(([\s\S]*?)\);\nEND;/)?.[1];
  const problems334 = [];
  if (!sql) problems334.push('could not read export_telemetry() out of the migrations that declare it');
  if (!path) problems334.push('docs/openapi.yaml has no /rest/v1/rpc/export_telemetry with its required arguments and resolutions');
  if (!document) problems334.push('docs/openapi.yaml has no TelemetryExport');
  if (!keys) problems334.push('could not read the keys export_telemetry() returns out of ' + (declaring[declaring.length - 1] ?? 'a migration'));
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
    fail('The API reference describes export_telemetry() otherwise than its last declaration does:\n' +
      problems334.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the API reference names the arguments, the resolutions and the document of export_telemetry() as ${declaring[declaring.length - 1].replace(/^supabase\/migrations\/(\d{4})_.*$/, '$1')} declares them`);
  }
}
