import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ok, problems, read, ROOT } from './lib.mjs';

// 97. Who may export readings, at every entry point (0279; check 90 holds the roles themselves). A
// file that opens TelemetryExportModal holds the gate: mayExportReadings() to turn its button off and
// EXPORT_DENIED_TITLE to say who may. One that opens the dialog without them offers Export CSV to a
// role export_telemetry() refuses, an error on every click. The entry points are found by their
// import, so a sixth is held to the gate the day it is written.
export default function check() {
  const sourceFiles = (dir) => readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : sourceFiles(rel);
    return /\.jsx?$/.test(e.name) ? [rel] : [];
  });
  const modal = 'frontend/src/components/modals/TelemetryExportModal.jsx';
  const entries = sourceFiles('frontend/src').filter((f) => f !== modal && /from '(\.\.?\/)+modals\/TelemetryExportModal'/.test(read(f)));
  if (entries.length === 0) {
    problems.push('exportGate: found no file that opens TelemetryExportModal -- the dialog moved or was renamed, so this check is no longer checking anything');
  }
  for (const file of entries) {
    const code = read(file);
    const missing = ['mayExportReadings(', 'EXPORT_DENIED_TITLE'].filter((name) => !code.includes(name));
    if (missing.length) problems.push(`exportGate: ${file} opens the export dialog without ${missing.join(' and ')}, so Export CSV is offered to a role export_telemetry() refuses`);
    else ok.push(`exportGate: ${file} holds the role gate`);
  }
}
