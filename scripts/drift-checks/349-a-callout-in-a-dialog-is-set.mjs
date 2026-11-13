import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 349. A callout in a dialog is set off from what follows it by the gap it leaves above itself, and
// an offline replay lane is explained rather than warned of, as frontend/README.md's *Words and
// rules* says. App.css gives a `.callout` followed by anything but another callout, in a dialog
// body, a bottom margin equal to the callout's own top margin; the README states that gap in
// pixels. The Device Configuration Parameters dialog tells a replay lane by isShadowDevice(), the
// predicate every page uses, and draws it an info callout beside the machine's warning.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems349 = [];
  const css = read('frontend/src/App.css').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
  const above = Number(css.match(/\n\.callout \{[^}]*\bmargin:\s*(\d+)px\b/)?.[1]);
  const below = Number(css.match(/\n\.modal-body > \.callout:has\(\+ :not\(\.callout\)\) \{[^}]*\bmargin-bottom:\s*(\d+)px\b/)?.[1]);
  if (!Number.isInteger(above)) problems349.push('frontend/src/App.css has no ".callout" rule with a "margin: <N>px" top margin');
  if (!Number.isInteger(below)) problems349.push('frontend/src/App.css has no ".modal-body > .callout:has(+ :not(.callout))" rule with a margin-bottom');
  else if (Number.isInteger(above) && below !== above) problems349.push(`a callout in a dialog leaves ${below}px under it and ${above}px above it`);
  const rule = read('frontend/README.md').match(/\n- \*\*Callouts in a dialog\.\*\*([\s\S]*?)\n- \*\*/)?.[1]?.replace(/\s+/g, ' ');
  if (!rule) problems349.push('frontend/README.md has no "Callouts in a dialog." rule under Words and rules');
  else {
    if (Number.isInteger(above) && !rule.includes(`(${above}px)`)) problems349.push(`frontend/README.md's Callouts in a dialog does not say the gap is (${above}px), as App.css has it`);
    if (!/offline replay lane|replay lane that is offline/.test(rule) || !/info callout/.test(rule)) problems349.push('frontend/README.md\'s Callouts in a dialog does not say an offline replay lane gets an info callout');
  }
  const modal = read('frontend/src/components/modals/AssetConfigModal.jsx');
  for (const [piece, what] of [
    ['isShadowDevice', 'tells a replay lane with isShadowDevice()'],
    ['callout callout-info', 'draws a replay lane an info callout'],
    ['callout callout-warning', 'keeps the warning for a machine'],
  ]) {
    if (!modal.includes(piece)) problems349.push(`AssetConfigModal.jsx no longer ${what} (${piece})`);
  }
  if (problems349.length) {
    fail('A dialog\'s callouts are drawn otherwise than frontend/README.md says:\n' + problems349.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`a callout in a dialog leaves ${above}px under it as above it, and the Configuration Parameters dialog explains an offline replay lane in an info callout`);
  }
}
