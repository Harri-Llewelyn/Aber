import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 332. History's help names the export file's columns and what one export may name as the code holds
// them: EXPORT_COLUMNS (utils/telemetryExport.js) in order, EXPORT_MAX_DEVICES and EXPORT_MAX_METRICS.
// A reader parsing the file looks for a column that is not there, or builds a selection the dialog
// refuses.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const code = read('frontend/src/utils/telemetryExport.js');
  const columns = code.match(/export const EXPORT_COLUMNS = \[([^\]]*)\]/)?.[1];
  const devices = Number(code.match(/^export const EXPORT_MAX_DEVICES = (\d+)$/m)?.[1]);
  const metrics = Number(code.match(/^export const EXPORT_MAX_METRICS = (\d+)$/m)?.[1]);
  const help = read('help/pages/history.md');
  const problems332 = [];
  if (!columns || !Number.isFinite(devices) || !Number.isFinite(metrics)) {
    problems332.push('could not read EXPORT_COLUMNS, EXPORT_MAX_DEVICES or EXPORT_MAX_METRICS out of frontend/src/utils/telemetryExport.js');
  } else {
    const names = [...columns.matchAll(/'([a-z_]+)'/g)].map((m) => `**${m[1]}**`);
    const list = `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    if (!help.includes(`its ${list}.`)) problems332.push(`help/pages/history.md does not say "its ${list}."`);
    const most = `**At most ${devices.toLocaleString('en-GB')} devices and ${metrics.toLocaleString('en-GB')} metrics.**`;
    if (!help.includes(most)) problems332.push(`help/pages/history.md does not say "${most}"`);
  }
  if (problems332.length) {
    fail('History\'s help states the export file otherwise than the code holds it:\n' + problems332.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`History's help names the export file's ${columns.split(',').length} columns in order and its ${devices.toLocaleString('en-GB')}-device, ${metrics}-metric limit as the code holds them`);
  }
}
