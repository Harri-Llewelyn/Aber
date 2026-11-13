import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 235. The API reference documents the suppression windows as 0240 declares them: each writer
// granted to authenticated under its own path, the table's path, the view's four columns and the
// stamp on DeviceAlert, and the four actions on AuditTrailEntry.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const SPEC = 'docs/openapi.yaml';
  const MIGRATION = 'supabase/migrations/0240_an_alert_stays_quiet_during_planned_work.sql';
  const spec = read(SPEC);
  const sql = read(MIGRATION);
  const problems235 = [];
  const writers = [...sql.matchAll(/GRANT EXECUTE ON FUNCTION public\.(\w+)\([^)]*\) TO authenticated/g)].map((m) => m[1]);
  if (writers.length !== 3) problems235.push(`${MIGRATION}: expected three writers granted to authenticated, found ${writers.join(', ') || 'none'}`);
  for (const fn of writers) {
    if (!spec.includes(`\n  /rest/v1/rpc/${fn}:\n`)) problems235.push(`${SPEC} has no /rest/v1/rpc/${fn}`);
  }
  if (!spec.includes('\n  /rest/v1/alert_suppression_windows:\n')) problems235.push(`${SPEC} has no /rest/v1/alert_suppression_windows`);
  const schema = spec.match(/^ {4}DeviceAlert:\n([\s\S]*?)(?=^ {4}\S)/m)?.[1] ?? '';
  const documented = new Set(schema.split('\n').filter((l) => /^ {8}\w+:/.test(l)).map((l) => l.trim().split(':')[0]));
  for (const column of ['suppression_window_id', 'suppressed', 'suppressing_window_id', 'suppression_reason', 'suppressed_until']) {
    if (!documented.has(column)) problems235.push(`${SPEC}: DeviceAlert does not document ${column}`);
  }
  const actions = spec.match(/^ {4}AuditTrailEntry:\n([\s\S]*?)(?=^ {4}\S)/m)?.[1] ?? '';
  const written = [...new Set([...sql.matchAll(/'(SUPPRESSION_WINDOW_[A-Z]+)'/g)].map((m) => m[1]))];
  if (written.length !== 4) problems235.push(`${MIGRATION}: expected four SUPPRESSION_WINDOW_ actions, found ${written.join(', ') || 'none'}`);
  for (const action of written) {
    if (!actions.includes(action)) problems235.push(`${SPEC}: AuditTrailEntry does not list ${action}`);
  }
  if (problems235.length) {
    fail('the API reference does not document the suppression windows as 0240 declares them:\n' +
      problems235.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`docs/openapi.yaml documents ${writers.join(', ')}, the windows table, the five suppression columns and the four window actions`);
  }
}
