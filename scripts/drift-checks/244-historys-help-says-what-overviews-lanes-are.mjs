import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 244. History's help says what Overview's lanes are and what a selection may see, as the code has
// it: the key's words (COVERAGE_KEY), the lanes past which every group starts closed
// (OVERVIEW_OPEN_LANES_MAX), and the selection that may take any block width and the longest window
// a larger one sees (COVERAGE_SMALL_SELECTION, COVERAGE_LARGE_MAX_HOURS in api.js).
// -------------------------------------------------------------------------------------------------
export default function check() {
  const util = read('frontend/src/utils/history.js');
  const api = read('frontend/src/api.js');
  const help = read('help/pages/history.md');
  const key = util.match(/fewer: '([^']+)', more: '([^']+)', none: '([^']+)'/);
  const lanes = util.match(/^export const OVERVIEW_OPEN_LANES_MAX = (\d+)$/m)?.[1];
  const small = api.match(/^export const COVERAGE_SMALL_SELECTION = (\d+);$/m)?.[1];
  const hours = api.match(/^export const COVERAGE_LARGE_MAX_HOURS = (\d+);$/m)?.[1];
  const problems244 = [];
  if (!key || !lanes || !small || !hours) {
    problems244.push('could not read COVERAGE_KEY, OVERVIEW_OPEN_LANES_MAX, COVERAGE_SMALL_SELECTION or COVERAGE_LARGE_MAX_HOURS');
  } else {
    if (!help.includes(`**${key[3]}**, then **${key[1]} → ${key[2]}**`)) problems244.push(`the key is not "**${key[3]}**, then **${key[1]} → ${key[2]}**"`);
    if (!help.includes(`unless there are more than ${lanes} devices`)) problems244.push(`it does not say every group starts closed past ${lanes} devices`);
    if (!help.includes(`**${small} devices or fewer**`) || !help.includes(`**More than ${small}**`)) problems244.push(`it does not name ${small} devices as the small selection`);
    // A large selection's longest window is a week and an hour, a week across a clock change.
    const days = Math.floor(Number(hours) / 24);
    if (!help.includes(`1-hour blocks up to ${days} days`)) problems244.push(`it does not say a large selection sees ${days} days at most`);
  }
  if (problems244.length) {
    fail("History's help describes Overview otherwise than the code:\n" + problems244.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`History's help names Overview's key, its ${lanes}-lane first visit, and the ${small}-device selection that sees past ${Math.floor(Number(hours) / 24)} days`);
  }
}
