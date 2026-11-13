import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 223. History's help says how many states a state chart's key names, and the README the same, as
// utils/history.js caps it (STATE_KEY_MAX). A free-text metric has many values, and the cap is what
// keeps its key readable; a page promising another number misleads whoever counts.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const util = read('frontend/src/utils/history.js');
  const help = read('help/pages/history.md');
  const readme = read('frontend/README.md');
  const cap = Number(util.match(/^export const STATE_KEY_MAX = (\d+)$/m)?.[1]);
  const WORDS = ['none', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  const problems223 = [];
  if (!Number.isInteger(cap)) problems223.push('could not read STATE_KEY_MAX out of frontend/src/utils/history.js');
  else {
    const said = `The key names the ${WORDS[cap] ?? cap} states with the most time`;
    if (!help.includes(said)) problems223.push(`help/pages/history.md does not say "${said}"`);
    if (!readme.includes(`\`STATE_KEY_MAX\` (${cap})`)) problems223.push(`frontend/README.md does not name \`STATE_KEY_MAX\` (${cap})`);
  }
  if (problems223.length) {
    fail('History\'s docs state a state key\'s cap otherwise than utils/history.js holds it:\n' +
      problems223.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`History's help and the README say a state chart's key names ${cap} values, as STATE_KEY_MAX holds`);
  }
}
