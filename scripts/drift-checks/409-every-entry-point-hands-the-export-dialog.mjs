import { EXPORT_ENTRY_FILES, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 409. Every file that opens the export dialog hands it the catalog. The dialog tells a derived metric
// from a measured one by the catalog: without it a derived metric is taken for a measured one, so
// the Raw note is not said and a file of derived metrics alone is called raw samples. The entry points
// are found by their import (EXPORT_ENTRY_FILES), so a sixth is held to it the day it is written.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems409 = [];
  if (EXPORT_ENTRY_FILES.length === 0) problems409.push('found no file that opens TelemetryExportModal -- the dialog moved or was renamed, so this check is no longer checking anything');
  for (const f of EXPORT_ENTRY_FILES) {
    const tag = read(f).match(/<TelemetryExportModal\b[\s\S]*?\/>/)?.[0];
    if (!tag) problems409.push(`${f} imports TelemetryExportModal and does not render it`);
    else if (!/\bcatalog=\{/.test(tag)) problems409.push(`${f} opens the export dialog without catalog={...}, so a derived metric is exported as if it were measured`);
  }
  if (problems409.length) {
    fail('A file that opens the export dialog does not hand it the metric catalog:\n' + problems409.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the ${EXPORT_ENTRY_FILES.length} files that open the export dialog hand it the metric catalog`);
  }
}
