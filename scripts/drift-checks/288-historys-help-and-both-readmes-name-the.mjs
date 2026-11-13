import { fail, pass, read, readDoc } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 288. History's help and both READMEs name the change read's caps as api.js holds them
// (HISTORY_MAX_CHANGES, HISTORY_CHANGE_READINGS, HISTORY_CHANGE_SERIES), the caps past which a text
// or flag chart shows its buckets instead of every change. Mirror check 69 holds api.js to the
// function; a page naming another cap tells a reader when a chart falls back, wrongly.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const api = read('frontend/src/api.js');
  const held = Object.fromEntries([...api.matchAll(/^export const (HISTORY_MAX_CHANGES|HISTORY_CHANGE_READINGS|HISTORY_CHANGE_SERIES) = (\d+);$/gm)]
    .map((m) => [m[1], Number(m[2])]));
  const caps = ['HISTORY_MAX_CHANGES', 'HISTORY_CHANGE_READINGS', 'HISTORY_CHANGE_SERIES'].map((name) => [name, held[name]]);
  const problems288 = [];
  const [changes, readings, series] = caps.map(([, n]) => n);
  for (const [name, n] of caps) if (!Number.isInteger(n)) problems288.push(`could not read ${name} out of frontend/src/api.js`);
  if (!problems288.length) {
    const words = (n) => n.toLocaleString('en-GB');
    const claims = [
      ['help/pages/history.md', `**More than ${words(changes)} changes**`],
      ['help/pages/history.md', `**More than ${words(readings)} readings**`],
      ['frontend/README.md', `\`HISTORY_MAX_CHANGES\`, ${words(changes)}`],
      ['frontend/README.md', `\`HISTORY_CHANGE_READINGS\`, ${words(readings)}`],
      ['frontend/README.md', `\`HISTORY_CHANGE_SERIES\` (${series})`],
      ['supabase/README.md', `${words(changes)} unless given`],
      ['supabase/README.md', `more than ${words(readings)} readings of one series`],
    ];
    for (const [file, said] of claims) if (!readDoc(file).includes(said)) problems288.push(`${file} does not say "${said}"`);
  }
  if (problems288.length) {
    fail('History\'s docs name the change read\'s caps otherwise than api.js holds them:\n' +
      problems288.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`History's help and both READMEs name the change read's caps, ${changes} changes, ${readings} readings and ${series} series, as api.js holds them`);
  }
}
