import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 222. History's help names the refresh timer's choices as utils/history.js holds them
// (HISTORY_REFRESH_EVERY), in order, and says it starts at the first. A help page offering another
// interval sends a reader looking for a choice the list does not have.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const util = read('frontend/src/utils/history.js');
  const help = read('help/pages/history.md');
  const block = util.match(/export const HISTORY_REFRESH_EVERY = \[([\s\S]*?)\]/)?.[1] ?? '';
  const labels = [...block.matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
  const problems222 = [];
  if (labels.length < 2) problems222.push('could not read the labels of HISTORY_REFRESH_EVERY out of frontend/src/utils/history.js');
  else {
    const said = `${labels.slice(0, -1).map((l) => `**${l}**`).join(', ')} or **${labels[labels.length - 1]}**`;
    if (!help.includes(said)) problems222.push(`help/pages/history.md does not offer ${said}`);
    if (!help.includes(`It starts at **${labels[0]}**.`)) problems222.push(`help/pages/history.md does not say "It starts at **${labels[0]}**."`);
  }
  if (problems222.length) {
    fail('History\'s help states its refresh choices otherwise than utils/history.js holds them:\n' +
      problems222.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`History's help offers the refresh timer's ${labels.length} choices, ${labels.join(', ')}, as utils/history.js holds them`);
  }
}
