import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 471. The time axis stays in view while a page's rows scroll under it, on History's Device tab and on
// the Audit Trail alike: both rules pin it (`position: sticky; top: 0`) on the base surface, in App.css,
// and the help and the README say so. The two pages decide together: an axis that scrolls away on one
// page and stays on the other is a page that looks broken.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const css = read('frontend/src/App.css');
  const rule = (selector) => {
    const at = css.indexOf(`\n${selector} {`);
    return at < 0 ? null : css.slice(at, css.indexOf('}', at));
  };
  const problems471 = [];
  for (const [page, selector] of [['History\'s Device tab', '.chart-axis'], ['the Audit Trail', '.trail-lane.trail-axis']]) {
    const body = rule(selector);
    if (body === null) problems471.push(`App.css has no rule for ${selector}, ${page}'s axis`);
    else {
      if (!/position: sticky;/.test(body)) problems471.push(`App.css's ${selector} is not position: sticky, so ${page}'s axis scrolls away`);
      if (!/top: 0;/.test(body)) problems471.push(`App.css's ${selector} does not pin at top: 0, so ${page}'s axis does not sit under the toolbar`);
      if (!/background: var\(--bg-base\);/.test(body)) problems471.push(`App.css's ${selector} is not opaque on the base surface, so rows show through ${page}'s axis`);
    }
  }
  if (!read('help/pages/history.md').includes('It stays in view while the charts scroll under it')) {
    problems471.push('help/pages/history.md does not say the time axis stays in view while the charts scroll under it');
  }
  if (!read('frontend/README.md').includes('`position: sticky; top: 0` on the base surface, as the Audit Trail\'s `.trail-axis` is')) {
    problems471.push('frontend/README.md does not say the Device tab\'s axis is pinned as the Audit Trail\'s `.trail-axis` is');
  }
  if (problems471.length) {
    fail('the Device tab\'s time axis and the Audit Trail\'s are not pinned alike, or the docs do not say so:\n' +
      problems471.map((p) => `        ${p}`).join('\n'));
  } else {
    pass('History\'s time axis and the Audit Trail\'s are both position: sticky at top: 0 on the base surface, and the help and the README say the axis stays in view');
  }
}
