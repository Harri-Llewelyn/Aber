import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 226. History's help names its chart groups' order as utils/history.js holds it (GROUP_ORDER),
// each type by the name the Metrics page gives it (SPARKPLUG_TYPES, constants.js). A help page in
// another order sends a reader looking for a group where it is not.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const order = (read('frontend/src/utils/history.js').match(/^const GROUP_ORDER = \[([\d, ]+)\]$/m)?.[1] ?? '')
    .split(',').map((c) => Number(c.trim())).filter(Number.isFinite);
  const block = read('frontend/src/constants.js').match(/export const SPARKPLUG_TYPES = \{([\s\S]*?)\};/)?.[1] ?? '';
  const types = Object.fromEntries([...block.matchAll(/(\d+): '(\w+)'/g)].map((m) => [Number(m[1]), m[2]]));
  const SHAPE = [10, 9, 1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 14];
  const problems226 = [];
  if (order.join(',') !== SHAPE.join(',')) {
    problems226.push(`utils/history.js's GROUP_ORDER is [${order.join(', ')}]; the help states [${SHAPE.join(', ')}], so change both`);
  } else {
    const n = (code) => types[code];
    const said = `**${n(10)}**, **${n(9)}**, the whole numbers (**${n(1)}** to **${n(8)}**), **${n(11)}**, **${n(12)}** and **${n(14)}**, then any other type`;
    if (!read('help/pages/history.md').includes(said)) problems226.push(`help/pages/history.md does not say "${said}"`);
  }
  if (problems226.length) {
    fail('History\'s help orders its chart groups otherwise than utils/history.js does:\n' +
      problems226.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`History's help orders its chart groups as GROUP_ORDER does, ${order.map((c) => types[c]).join(', ')}, then Other`);
  }
}
