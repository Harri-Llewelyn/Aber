import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 218. History's help names its bucket sizes and its row cap as api.js holds them. The page says
// which resolution it shows in HISTORY_RESOLUTIONS' words, and the row cap (TELEMETRY_MAX_ROWS)
// decides which; a help page naming another size, or another cap, explains a page nobody sees.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const api = read('frontend/src/api.js');
  const help = read('help/pages/history.md');
  const block = api.match(/export const HISTORY_RESOLUTIONS = Object\.freeze\(\[([\s\S]*?)\]\);/)?.[1] ?? '';
  const words = [...block.matchAll(/words: '([^']+)'/g)].map((m) => m[1]);
  const cap = Number(api.match(/^const TELEMETRY_MAX_ROWS = (\d+);$/m)?.[1]);
  const problems218 = [];
  if (!words.length) problems218.push('could not read the words of HISTORY_RESOLUTIONS out of frontend/src/api.js');
  if (!/export const HISTORY_MAX_ROWS = TELEMETRY_MAX_ROWS;/.test(api)) {
    problems218.push('frontend/src/api.js no longer sets HISTORY_MAX_ROWS to TELEMETRY_MAX_ROWS');
  }
  if (!Number.isFinite(cap)) problems218.push('could not read TELEMETRY_MAX_ROWS out of frontend/src/api.js');
  const listed = [...help.matchAll(/^- \*\*(\d+-(?:minute|hour|day) buckets)\*\*$/gm)].map((m) => m[1]);
  if (words.length && listed.join(', ') !== words.join(', ')) {
    problems218.push(`help/pages/history.md lists ${listed.join(', ') || 'no bucket sizes'}; api.js has ${words.join(', ')}`);
  }
  if (Number.isFinite(cap) && !help.includes(`at most ${cap.toLocaleString('en-GB')} points`)) {
    problems218.push(`help/pages/history.md does not say "at most ${cap.toLocaleString('en-GB')} points"`);
  }
  if (problems218.length) {
    fail('History\'s help states its bucket sizes or row cap otherwise than api.js holds them:\n' +
      problems218.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`History's help names its ${words.length} bucket sizes and its ${cap.toLocaleString('en-GB')}-point cap as api.js holds them`);
  }
}
