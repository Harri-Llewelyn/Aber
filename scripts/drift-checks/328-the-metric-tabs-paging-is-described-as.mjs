import { fail, pass, read, readDoc } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 328. The Metric tab's paging is described as the code holds it. History's help says how many devices
// a page holds and the number past which the tab pages whatever the row cap carries; frontend/README.md
// names both constants and their values; the help has a section for each of the Metric and Area tabs; and
// the 0276 section says the bound its read is held to. A page naming another figure tells a reader how
// many charts to expect, wrongly.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const util = read('frontend/src/utils/history.js');
  const size = Number(util.match(/^export const METRIC_PAGE_SIZE = (\d+)$/m)?.[1]);
  const draw = Number(util.match(/^export const METRIC_DRAW_MAX = (\d+)$/m)?.[1]);
  const group = Number(read('frontend/src/api.js').match(/^export const HISTORY_GROUP_READ_ROWS = (\d+);$/m)?.[1]);
  const problems328 = [];
  if (!Number.isInteger(size)) problems328.push('could not read METRIC_PAGE_SIZE out of frontend/src/utils/history.js');
  if (!Number.isInteger(draw)) problems328.push('could not read METRIC_DRAW_MAX out of frontend/src/utils/history.js');
  if (!Number.isInteger(group)) problems328.push('could not read HISTORY_GROUP_READ_ROWS out of frontend/src/api.js');
  if (!problems328.length) {
    const claims = [
      ['help/pages/history.md', `a page at a time, ${size} devices to a page`],
      ['help/pages/history.md', `more than ${draw} devices`],
      ['frontend/README.md', `\`METRIC_PAGE_SIZE\` (${size})`],
      ['frontend/README.md', `\`METRIC_DRAW_MAX\` (${draw})`],
      ['supabase/README.md', `more than ${group.toLocaleString('en-GB')} devices times buckets`],
    ];
    // Read as one line, so a rewrapped paragraph still says it.
    for (const [file, said] of claims) if (!readDoc(file).replace(/\s+/g, ' ').includes(said)) problems328.push(`${file} does not say "${said}"`);
    const help = read('help/pages/history.md');
    for (const heading of ['The Metric tab: one metric across devices', 'The Area tab: comparing the cells in an area']) {
      if (!help.includes(`\n## ${heading}\n`)) problems328.push(`help/pages/history.md has no "${heading}" section`);
    }
  }
  if (problems328.length) {
    fail('History\'s docs describe the Metric and Area tabs otherwise than the code holds them:\n' +
      problems328.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`History's help and both READMEs say the Metric tab pages at ${size} devices a page and past ${draw}, and the 0276 section says its ${group.toLocaleString('en-GB')}-row bound`);
  }
}
