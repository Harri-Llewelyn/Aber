import { fail, pass, read, upgradingGuide } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 342. The help says what a derived metric is and is not, as the issue settled it. History's help
// says a time in state is resolved to the minute, a counter that resets and passes its old value inside
// one minute is counted short, and a derived sum at a wide bucket need not equal its inputs' averages;
// the Metrics help no longer says its values are not drawn; the upgrade guide names both calls and says
// the automation now fires. A page that still says "not drawn in History yet" is wrong about the page
// it describes.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const history = read('help/pages/history.md').match(/\n## Derived metrics\n([\s\S]*?)\n## /)?.[1];
  const metrics = read('help/pages/metrics.md');
  const upgrading = upgradingGuide().match(/\n### From 1\.8\.0, History draws a derived metric, and an automation can read one\n([\s\S]*?)\n### /)?.[1];
  const problems342 = [];
  if (!history) problems342.push('help/pages/history.md has no "Derived metrics" section');
  if (!upgrading) problems342.push('help/site/upgrading.md has no "From 1.8.0, History draws a derived metric" section');
  if (!problems342.length) {
    for (const [phrase, what] of [
      ['resolved to the minute', 'that time in state is resolved to the minute'],
      ['counted short by that old value', 'that a counter that resets and passes its old value inside one minute is counted short'],
      ["need not equal the sum of its inputs' averages", "that a wide bucket's derived sum need not equal the sum of its inputs' averages"],
      ['Export CSV', 'that Export leaves a derived metric out'],
    ]) {
      if (!history.includes(phrase)) problems342.push(`help/pages/history.md's Derived metrics does not say ${what}`);
    }
    for (const call of ['derived_series', 'derived_current']) {
      if (!upgrading.includes(call)) problems342.push(`the upgrade guide's From 1.8.0 note on derived metrics does not name ${call}`);
    }
    if (!/An automation on a derived metric now fires/.test(upgrading)) problems342.push('the upgrade guide does not say an automation on a derived metric now fires');
  }
  if (/not drawn in History yet/i.test(metrics)) problems342.push('help/pages/metrics.md still says a derived metric is not drawn in History yet');
  if (problems342.length) {
    fail('The help says a derived metric otherwise than the issue settled it:\n' +
      problems342.map((p) => `        ${p}`).join('\n'));
  } else {
    pass("History's help says a derived metric is resolved to the minute, may count a reset short and need not equal its inputs' averages; the Metrics help no longer says it is not drawn; the upgrade guide names both calls");
  }
}
