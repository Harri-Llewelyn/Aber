import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 472. History's help and frontend/README.md name a group's bucket switch as utils/history.js builds
// it: Auto, then each size of HISTORY_RESOLUTIONS (api.js) by its short name (BUCKET_SEGMENT_LABELS),
// in that order, and the address form of its choices, one `Group:size` entry each. A page naming a
// segment the switch does not have sends a reader looking for it; a link written in another form
// reads as nothing.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const util = read('frontend/src/utils/history.js');
  const api = read('frontend/src/api.js');
  const ids = [...(api.match(/export const HISTORY_RESOLUTIONS = Object\.freeze\(\[([\s\S]*?)\]\);/)?.[1] ?? '').matchAll(/id: '(\w+)'/g)].map((m) => m[1]);
  const block = util.match(/export const BUCKET_SEGMENT_LABELS = Object\.freeze\(\{([^}]*)\}\)/)?.[1] ?? '';
  const names = Object.fromEntries([...block.matchAll(/'(\w+)': '([^']+)'/g)].map((m) => [m[1], m[2]]));
  const problems472 = [];
  if (!ids.length) problems472.push('could not read the ids of HISTORY_RESOLUTIONS out of frontend/src/api.js');
  const labels = ids.map((id) => names[id]);
  if (labels.some((l) => !l)) problems472.push(`BUCKET_SEGMENT_LABELS (utils/history.js) names ${Object.keys(names).join(', ')}; HISTORY_RESOLUTIONS has ${ids.join(', ')}`);
  else {
    const said = `On the switch, after **Auto**, they are ${labels.slice(0, -1).map((l) => `**${l}**`).join(', ')} and **${labels[labels.length - 1]}**.`;
    if (!read('help/pages/history.md').includes(said)) problems472.push(`help/pages/history.md does not say "${said}"`);
    const named = `by \`BUCKET_SEGMENT_LABELS\` (${labels.map((l) => `"${l}"`).join(', ')})`;
    if (!read('frontend/README.md').replace(/\s+/g, ' ').includes(named)) problems472.push(`frontend/README.md does not say "${named}"`);
  }
  const form = '?bucket=Double:5m,String:1h';
  if (!read('help/pages/history.md').includes(`\`${form}\``)) problems472.push(`help/pages/history.md does not show the address form \`${form}\``);
  if (!read('frontend/README.md').includes(`\`${form}\``)) problems472.push(`frontend/README.md does not show the address form \`${form}\``);
  if (problems472.length) {
    fail('History\'s docs name a group\'s bucket switch otherwise than utils/history.js builds it:\n' +
      problems472.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`History's help and the README name a group's bucket switch as Auto, ${labels.join(', ')}, and its address as ${form}`);
  }
}
