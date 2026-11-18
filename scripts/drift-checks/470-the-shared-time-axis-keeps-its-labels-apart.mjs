import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 470. History's help and frontend/README.md say how far apart the shared time axis keeps its labels,
// as utils/timelineAxis.js holds it (TICK_GAP_PX), and the axis's tick ladder and its measuring are
// the ones the README names. A page that promises a gap the code does not keep tells a reader a
// label can run into the next when it cannot, or the reverse.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const util = read('frontend/src/utils/timelineAxis.js');
  const px = Number(util.match(/^export const TICK_GAP_PX = (\d+)$/m)?.[1]);
  const problems470 = [];
  if (!Number.isInteger(px)) problems470.push('could not read TICK_GAP_PX out of frontend/src/utils/timelineAxis.js');
  else {
    if (!read('help/pages/history.md').includes(`No two labels are closer than ${px} pixels`)) {
      problems470.push(`help/pages/history.md does not say "No two labels are closer than ${px} pixels"`);
    }
    if (!read('frontend/README.md').includes(`closer than \`TICK_GAP_PX\` (${px}px)`)) {
      problems470.push(`frontend/README.md does not say labels are no closer than \`TICK_GAP_PX\` (${px}px)`);
    }
  }
  const units = [...util.matchAll(/unit: '(\w+)'/g)].map((m) => m[1]);
  const ladder = [...new Set(units)];
  for (const unit of ['second', 'minute', 'hour', 'day', 'week', 'month', 'year']) {
    if (!ladder.includes(unit)) problems470.push(`utils/timelineAxis.js has no step of a ${unit}, which the README's ladder names`);
  }
  if (problems470.length) {
    fail('History\'s docs state the shared time axis\'s label gap otherwise than utils/timelineAxis.js holds it:\n' +
      problems470.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`History's help and the README keep the shared time axis's labels ${px}px apart, as TICK_GAP_PX does, over a ladder of ${ladder.join(', ')}`);
  }
}
