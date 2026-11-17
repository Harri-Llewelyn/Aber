import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 419. frontend/README.md names a state band's two widths and its hue gap as the code holds them:
// NAMED_RUN_PX and DIVIDED_RUN_PX (StateBand.jsx), the pixels under which a run has no name and takes
// no hairline, and NEAR_HUE_DEG (utils/history.js), the gap under which two neighbours do. A page
// naming other figures describes a band nobody sees, and themeContrast.test.js measures NEAR_HUE_DEG
// in both themes, so a change to it has to meet that test and this page together.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const band = read('frontend/src/components/common/StateBand.jsx');
  const util = read('frontend/src/utils/history.js');
  const named = Number(band.match(/^const NAMED_RUN_PX = (\d+)$/m)?.[1]);
  const divided = Number(band.match(/^const DIVIDED_RUN_PX = (\d+)$/m)?.[1]);
  const near = Number(util.match(/^export const NEAR_HUE_DEG = (\d+)$/m)?.[1]);
  const problems419 = [];
  for (const [name, n, file] of [['NAMED_RUN_PX', named, 'StateBand.jsx'], ['DIVIDED_RUN_PX', divided, 'StateBand.jsx'], ['NEAR_HUE_DEG', near, 'utils/history.js']]) {
    if (!Number.isInteger(n)) problems419.push(`could not read ${name} out of frontend/src/${file === 'StateBand.jsx' ? 'components/common/' : ''}${file}`);
  }
  if (!problems419.length) {
    // Read as one line, so a rewrapped paragraph still says it.
    const readme = read('frontend/README.md').replace(/\s+/g, ' ');
    const claims = [
      `\`NEAR_HUE_DEG\` (${near}°)`,
      `never on a run under ${divided}px`,
      `A run under ${named}px has no name`,
    ];
    for (const said of claims) if (!readme.includes(said)) problems419.push(`frontend/README.md does not say "${said}"`);
  }
  if (problems419.length) {
    fail('frontend/README.md names a state band\'s widths otherwise than StateBand.jsx and utils/history.js hold them:\n' +
      problems419.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`frontend/README.md names a state band's widths as the code holds them: a name from ${named}px, a hairline from ${divided}px, neighbours within ${near} degrees`);
  }
}
