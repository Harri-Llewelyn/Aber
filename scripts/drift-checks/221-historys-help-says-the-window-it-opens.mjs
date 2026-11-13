import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 221. History's help says the window it opens on, and which spans it offers, as utils/history.js
// has them. The page opens on DEFAULT_HISTORY_WINDOW and offers every span and no All time.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const util = read('frontend/src/utils/history.js');
  const presets = read('frontend/src/utils/timeWindow.js');
  const help = read('help/pages/history.md');
  const range = util.match(/export const DEFAULT_HISTORY_WINDOW = rollingWindow\('(\w+)', HISTORY_RANGES\)/)?.[1];
  const labels = Object.fromEntries([...presets.matchAll(/value: '(\w+)', +label: '([^']+)'/g)].map((m) => [m[1], m[2]]));
  const label = range && labels[range];
  const problems221 = [];
  if (!label) problems221.push('could not read DEFAULT_HISTORY_WINDOW\'s range and its label');
  else if (!help.includes(`It opens on **${label}**.`)) problems221.push(`help/pages/history.md does not say "It opens on **${label}**."`);
  if (!/export const HISTORY_SPANS = SPAN_IDS$/m.test(util)) {
    problems221.push('utils/history.js no longer offers every span (HISTORY_SPANS = SPAN_IDS); the help names all four');
  } else if (!help.includes('Choose **Day**, **Week**, **Month** or **Year**')) {
    problems221.push('help/pages/history.md does not name the four spans');
  }
  if (!help.includes('There is no **All time**')) problems221.push('help/pages/history.md does not say there is no All time');
  if (problems221.length) {
    fail('History\'s help states its window otherwise than utils/history.js has it:\n' +
      problems221.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`History's help says it opens on ${label}, with every span and no All time`);
  }
}
