import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 224. History's help names the readings export's resolutions and its row cap as the code holds
// them: EXPORT_RESOLUTIONS' labels (utils/telemetryExport.js), raw first, and TELEMETRY_EXPORT_MAX_ROWS
// (api.js). The dialog shows those labels and stops at that cap; help naming another sends a reader
// looking for a choice that is not there, or trusting a file to hold rows it cannot.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const help = read('help/pages/history.md');
  const block = read('frontend/src/utils/telemetryExport.js').match(/export const EXPORT_RESOLUTIONS = \[([\s\S]*?)\n\]/)?.[1] ?? '';
  const labels = [...block.matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
  const cap = Number(read('frontend/src/api.js').match(/^export const TELEMETRY_EXPORT_MAX_ROWS = (\d+);$/m)?.[1]);
  const problems224 = [];
  if (labels.length < 2) problems224.push('could not read the labels of EXPORT_RESOLUTIONS out of frontend/src/utils/telemetryExport.js');
  else {
    const [raw, ...summaries] = labels;
    const first = `- **${raw}**, the one the dialog starts on,`;
    const rest = `${summaries.slice(0, -1).map((l) => `**${l}**`).join(', ')} and **${summaries[summaries.length - 1]}** are summaries`;
    if (!help.includes(first)) problems224.push(`help/pages/history.md does not say "${first}"`);
    if (!help.includes(rest)) problems224.push(`help/pages/history.md does not say "${rest}"`);
  }
  if (!Number.isFinite(cap)) problems224.push('could not read TELEMETRY_EXPORT_MAX_ROWS out of frontend/src/api.js');
  else if (!help.includes(`at most ${cap.toLocaleString('en-GB')} rows`)) {
    problems224.push(`help/pages/history.md does not say "at most ${cap.toLocaleString('en-GB')} rows"`);
  }
  if (problems224.length) {
    fail('History\'s help states the readings export otherwise than the code holds it:\n' +
      problems224.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`History's help names the export's ${labels.length} resolutions, ${labels[0]} first, and its ${cap.toLocaleString('en-GB')}-row cap as the code holds them`);
  }
}
