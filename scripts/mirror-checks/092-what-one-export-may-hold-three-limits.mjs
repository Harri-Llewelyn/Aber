import { compare, lastDefinition, need, read } from './lib.mjs';

// 92. What one export may hold, three limits and one list in two places (0279): export_telemetry()'s
// rows, devices and metrics, and the resolutions it admits, against the dashboard's. A page that
// says another cap trusts a file to hold rows it cannot; one that offers a resolution the function
// refuses meets an error on its own button; one that lets a selection past the device or metric
// limit finds out when the dialog is refused.
export default function check() {
  const fn = lastDefinition('CREATE OR REPLACE FUNCTION public.export_telemetry(', '$fn$;', 'export_telemetry()');
  const sqlRows = fn && need(fn.body, /c_max_rows\s+CONSTANT integer := (\d+);/, `the row bound in ${fn.file}`);
  const sqlAssets = fn && need(fn.body, /c_max_assets\s+CONSTANT integer := (\d+);/, `the device bound in ${fn.file}`);
  const sqlMetrics = fn && need(fn.body, /c_max_metrics\s+CONSTANT integer := (\d+);/, `the metric bound in ${fn.file}`);
  const sqlRes = fn && need(fn.body, /NOT v_res = ANY \(ARRAY\[([^\]]*)\]\)/, `the resolutions export_telemetry() admits (${fn.file})`);
  const rowsJs = need(read('frontend/src/api.js'), /^export const TELEMETRY_EXPORT_MAX_ROWS = (\d+);$/m, 'TELEMETRY_EXPORT_MAX_ROWS in frontend/src/api.js');
  const js = read('frontend/src/utils/telemetryExport.js');
  const jsAssets = need(js, /export const EXPORT_MAX_DEVICES = (\d+)$/m, 'EXPORT_MAX_DEVICES in utils/telemetryExport.js');
  const jsMetrics = need(js, /export const EXPORT_MAX_METRICS = (\d+)$/m, 'EXPORT_MAX_METRICS in utils/telemetryExport.js');
  const block = need(js, /export const EXPORT_RESOLUTIONS = \[([\s\S]*?)\n\]/, 'EXPORT_RESOLUTIONS in utils/telemetryExport.js');
  const jsRes = block && [...block[1].matchAll(/\{ key: '([^']+)'/g)].map((m) => m[1]);
  if (sqlRows && rowsJs) compare('exportBounds', `the rows one export holds, export_telemetry() (${fn.file}) and the dashboard`, rowsJs[1], sqlRows[1]);
  if (sqlAssets && jsAssets) compare('exportBounds', `the devices one export names, export_telemetry() (${fn.file}) and the dashboard`, jsAssets[1], sqlAssets[1]);
  if (sqlMetrics && jsMetrics) compare('exportBounds', `the metrics one export names, export_telemetry() (${fn.file}) and the dashboard`, jsMetrics[1], sqlMetrics[1]);
  if (sqlRes && jsRes) {
    compare('exportBounds', `the resolutions export_telemetry() (${fn.file}) admits and the dialog offers`,
      jsRes.join(', '), [...sqlRes[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).join(', '));
  }
}
