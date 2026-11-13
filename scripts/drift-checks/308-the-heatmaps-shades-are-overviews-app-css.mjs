import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 308. The heatmap's shades are Overview's. App.css draws .heatmap-step-N from --coverage-N for each
// of Overview's COVERAGE_STEPS steps and no other, and the page steps through that many
// (HEAT_STEPS), so the ramp themeContrast.test.js holds to the ordered-ramp rule in both themes is
// the one the heatmap is coloured with. A step the CSS lacks is a cell with no colour; a ramp of its
// own is one nobody has checked.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const css = read('frontend/src/App.css');
  const history = read('frontend/src/utils/history.js');
  const steps = Number(history.match(/^export const COVERAGE_STEPS = (\d+)$/m)?.[1]);
  const heat = history.match(/^export const HEAT_STEPS = (\w+)$/m)?.[1];
  const drawn = [...css.matchAll(/^\.heatmap-step-(\d+) \{ background: var\(--coverage-(\d+)\); \}$/gm)].map((m) => [Number(m[1]), Number(m[2])]);
  const problems308 = [];
  if (!Number.isInteger(steps)) problems308.push('could not read COVERAGE_STEPS out of frontend/src/utils/history.js');
  if (heat !== 'COVERAGE_STEPS') problems308.push(`HEAT_STEPS is ${heat ?? 'not declared'} in frontend/src/utils/history.js, not COVERAGE_STEPS`);
  for (let i = 1; i <= steps; i++) {
    if (!drawn.some(([step, token]) => step === i && token === i)) problems308.push(`frontend/src/App.css has no ".heatmap-step-${i} { background: var(--coverage-${i}); }"`);
  }
  if (Number.isInteger(steps) && drawn.length !== steps) problems308.push(`frontend/src/App.css draws ${drawn.length} heatmap steps, Overview has ${steps}`);
  if (problems308.length) {
    fail('The heatmap is coloured otherwise than Overview\'s ramp:\n' + problems308.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the heatmap's ${steps} shades are Overview's --coverage-1 to --coverage-${steps}, which themeContrast.test.js holds in both themes`);
  }
}
