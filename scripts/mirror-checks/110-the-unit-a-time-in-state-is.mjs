import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compare, lastDefinition, need, read, ROOT } from './lib.mjs';

// 110. The unit an exported time in state carries, SQL and JavaScript (0296). History draws it as
// SHARE_UNIT, "% of the time", although its value is a fraction from 0 to 1 as data; export_telemetry()
// writes the same unit in the unit column (c_share_unit), and the file's comment row says what the
// value is. The kind that earns it is a time in state in both: the function's CASE and derivedRows().
// A unit the file writes that History does not draw is a column that says one thing where the chart
// says another.
export default async function check() {
  const fn = lastDefinition('CREATE OR REPLACE FUNCTION public.export_telemetry(', '$fn$;', 'export_telemetry()');
  const { SHARE_UNIT, DERIVATION_KINDS } = await import(pathToFileURL(join(ROOT, 'frontend/src/utils/derivedMetric.js')).href);
  const exportJs = read('frontend/src/utils/telemetryExport.js');
  const unit = fn && need(fn.body, /c_share_unit\s+CONSTANT text := '([^']*)';/, `c_share_unit in export_telemetry() (${fn.file})`);
  const sqlKind = fn && need(fn.body, /CASE WHEN c\.derivation ->> 'kind' = '(\w+)' THEN c_share_unit/, `the kind that takes c_share_unit in export_telemetry() (${fn.file})`);
  const jsKind = need(exportJs, /d\.kind === '(\w+)' \? `; the unit is/, "the kind derivedRows() says is a fraction in utils/telemetryExport.js");
  if (unit) compare('shareUnit', `the unit of a time in state, SHARE_UNIT and export_telemetry()'s c_share_unit (${fn.file})`, SHARE_UNIT, unit[1]);
  if (sqlKind && jsKind) compare('shareUnit', `the kind that is a time in state, derivedRows() and export_telemetry() (${fn.file})`, jsKind[1], sqlKind[1]);
  if (jsKind) compare('shareUnit', 'the kind derivedRows() says is a fraction and the dashboard\'s time-in-state kind', jsKind[1], DERIVATION_KINDS.find((k) => k.label === 'Time in state')?.id);
}
