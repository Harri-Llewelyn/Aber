import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 211. How narrow a zoom goes, and how far a press moves to be a drag, are stated as the code holds
// them. Zoom in stops at ZOOM_FLOOR_MS (utils/timeWindow.js), and a press is a drag from
// BAND_DRAG_PX (hooks/useBandDrag.js, which the Audit Trail and History share). Both pages' help,
// frontend/README.md and Zoom in's own tooltip give them; a floor stated wrong reads as a broken
// button.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const UTIL = 'frontend/src/utils/timeWindow.js';
  const TAB = 'frontend/src/hooks/useBandDrag.js';
  const CONTROL = 'frontend/src/components/common/TimeWindowControl.jsx';
  const UNITS = { SECOND: ['second', 1], MINUTE: ['minute', 60], HOUR: ['hour', 3600] };
  const floor = read(UTIL).match(/^export const ZOOM_FLOOR_MS = (?:(\d+) \* )?(SECOND|MINUTE|HOUR)$/m);
  const px = Number(read(TAB).match(/^export const BAND_DRAG_PX = (\d+)$/m)?.[1]);
  const problems211 = [];
  if (!floor || !Number.isFinite(px)) {
    problems211.push(`could not read ZOOM_FLOOR_MS out of ${UTIL} or BAND_DRAG_PX out of ${TAB}; their shape changed`);
  } else {
    const n = Number(floor[1] ?? 1);
    const words = n === 1 ? `one ${UNITS[floor[2]][0]}` : `${n} ${UNITS[floor[2]][0]}s`;
    for (const page of ['help/pages/audit-trail.md', 'help/pages/history.md']) {
      const help = read(page);
      for (const phrase of [`stops at a window of ${words}`, `shorter than ${words} opens as ${words}`,
        `A drag must move at least ${px} pixels`]) {
        if (!help.includes(phrase)) problems211.push(`${page} does not say "${phrase}"`);
      }
    }
    const readme = read('frontend/README.md').replace(/\s+/g, ' ');
    for (const phrase of [`\`ZOOM_FLOOR_MS\` (${words})`, `\`BAND_DRAG_PX\` (${px}px)`]) {
      if (!readme.includes(phrase)) problems211.push(`frontend/README.md does not give ${phrase}`);
    }
    if (!read(CONTROL).includes(`is ${words} long, the narrowest a zoom goes`)) {
      problems211.push(`${CONTROL}'s Zoom in tooltip does not name the floor as ${words}`);
    }
  }
  if (problems211.length) {
    fail('how far the Audit Trail and History zoom is stated otherwise than the code holds it:\n' +
      problems211.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`both pages' help, frontend/README.md and Zoom in's tooltip state the zoom floor and the ${px}px drag as the code holds them`);
  }
}
