import { fail, pass, read, readDoc } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 307. The Cell tab's heatmap names the window it allows as api.js holds the bound. The read refuses
// more than HOUR_OF_DAY_MAX_ROWS hours times devices (mirror check 79), so a cell of 20 machines
// reads at most that many hours over 20, in days. History's help says the figure, frontend/README.md
// names the constant and the figure, and the 0265 section says the bound; a page naming another
// tells a reader which windows the heatmap draws, wrongly.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const max = Number(read('frontend/src/api.js').match(/^export const HOUR_OF_DAY_MAX_ROWS = (\d+);$/m)?.[1]);
  const problems307 = [];
  if (!Number.isInteger(max)) problems307.push('could not read HOUR_OF_DAY_MAX_ROWS out of frontend/src/api.js');
  const days = Math.floor(max / 20 / 24);
  const words = max.toLocaleString('en-GB');
  if (!problems307.length) {
    const claims = [
      ['help/pages/history.md', `at most ${words} in all. For a cell of 20 machines, that is at most ${days} days`],
      ['frontend/README.md', `\`HOUR_OF_DAY_MAX_ROWS\` (${words})`],
      ['frontend/README.md', `for 20 machines it covers at most ${days} days`],
      ['supabase/README.md', `more than ${words} hours times devices`],
    ];
    // Read as one line, so a rewrapped paragraph still says it.
    for (const [file, said] of claims) if (!readDoc(file).replace(/\s+/g, ' ').includes(said)) problems307.push(`${file} does not say "${said}"`);
  }
  if (problems307.length) {
    fail('The Cell tab\'s docs name the heatmap\'s bound otherwise than api.js holds it:\n' +
      problems307.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`History's help and both READMEs say the heatmap reads at most ${words} hours times machines, ${days} days for a cell of 20, as api.js holds it`);
  }
}
