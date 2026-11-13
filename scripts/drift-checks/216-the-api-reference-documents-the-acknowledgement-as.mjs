import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 216. The API reference documents the acknowledgement as the migration declares it: both
// functions under their own paths, each column on DeviceAlert, and both actions on
// AuditTrailEntry. A function missing from the reference is one an API client never learns of.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const SPEC = 'docs/openapi.yaml';
  const MIGRATION = 'supabase/migrations/0231_a_person_acknowledges_an_alert.sql';
  const spec = read(SPEC);
  const sql = read(MIGRATION);
  const problems216 = [];
  const granted = new Set([...sql.matchAll(/GRANT EXECUTE ON FUNCTION public\.(\w+)\([^)]*\) TO authenticated/g)].map((m) => m[1]));
  const functions = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map((m) => m[1])
    .filter((fn) => granted.has(fn));
  if (functions.length !== 2) problems216.push(`${MIGRATION}: expected two functions granted to authenticated, found ${functions.join(', ') || 'none'}`);
  for (const fn of functions) {
    if (!spec.includes(`\n  /rest/v1/rpc/${fn}:\n`)) problems216.push(`${SPEC} has no /rest/v1/rpc/${fn}`);
  }
  const columns = [...(sql.match(/-- 1\. The columns[\s\S]*?-- 2\./)?.[0] ?? '')
    .matchAll(/COMMENT ON COLUMN public\.platform_alerts\.(\w+) IS/g)].map((m) => m[1]);
  if (columns.length !== 5) problems216.push(`${MIGRATION}: expected five column comments, found ${columns.length}`);
  const schema = spec.match(/^ {4}DeviceAlert:\n([\s\S]*?)(?=^ {4}\S)/m)?.[1] ?? '';
  for (const c of columns) {
    if (!new RegExp(`^ {8}${c}:`, 'm').test(schema)) problems216.push(`${SPEC}: DeviceAlert does not document ${c}`);
  }
  const actions = spec.match(/^ {4}AuditTrailEntry:\n([\s\S]*?)(?=^ {4}\S)/m)?.[1] ?? '';
  for (const action of ['ALERT_ACKNOWLEDGED', 'ALERT_ACKNOWLEDGEMENT_WITHDRAWN']) {
    if (!actions.includes(action)) problems216.push(`${SPEC}: AuditTrailEntry does not list ${action}`);
  }
  if (problems216.length) {
    fail('the API reference does not document the acknowledgement as 0231 declares it:\n' +
      problems216.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`docs/openapi.yaml documents ${functions.join(' and ')}, the ${columns.length} acknowledgement columns and both audit actions`);
  }
}
