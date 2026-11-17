import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 411. A custom MTConnect type asks for its category. Add Metric offers the three categories from
// MTCONNECT_CATEGORIES, in that order, with the first chosen to begin with, and a custom type's
// category is the chosen one rather than the empty string it once was. The metrics help names the
// three in the same order and says SAMPLE is chosen first.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems411 = [];
  const tab = read('frontend/src/components/tabs/MetricsTab.jsx');
  const vocab = read('frontend/src/utils/mtconnect.js');
  const declared = /export const MTCONNECT_CATEGORIES = \[([^\]]*)\]/.exec(vocab);
  const categories = declared ? [...declared[1].matchAll(/'([A-Z]+)'/g)].map((m) => m[1]) : [];
  if (categories.join(',') !== 'SAMPLE,EVENT,CONDITION') {
    problems411.push(`utils/mtconnect.js declares MTCONNECT_CATEGORIES as [${categories.join(', ')}], not SAMPLE, EVENT, CONDITION`);
  }
  if (!tab.includes('customCategory: MTCONNECT_CATEGORIES[0]')) {
    problems411.push('MetricsTab.jsx does not start a custom type on the first category');
  }
  if (!tab.includes('MTCONNECT_CATEGORIES.map(')) {
    problems411.push('MetricsTab.jsx does not offer the categories from MTCONNECT_CATEGORIES');
  }
  if (!/usingCustomType \? newMetric\.customCategory :/.test(tab)) {
    problems411.push("MetricsTab.jsx does not take a custom type's category from the choice");
  }
  if (tab.includes('outside MTConnect has no category')) {
    problems411.push('MetricsTab.jsx still says a type outside MTConnect has no category');
  }
  const help = read('help/pages/metrics.md').replace(/\s+/g, ' ');
  const bullet = /\*\*A custom MTConnect type asks for its category\.\*\*[^\n]*/.exec(help);
  if (!bullet) {
    problems411.push('help/pages/metrics.md does not say what a custom MTConnect type asks for');
  } else {
    const named = [...bullet[0].matchAll(/\*\*(SAMPLE|EVENT|CONDITION)\*\*/g)].map((m) => m[1]);
    if (named.slice(0, 3).join(',') !== categories.join(',')) {
      problems411.push(`help/pages/metrics.md names the categories as [${named.slice(0, 3).join(', ')}], not the code's order`);
    }
    if (!bullet[0].includes(`${categories[0]} is chosen to begin with`)) {
      problems411.push(`help/pages/metrics.md does not say ${categories[0]} is chosen to begin with`);
    }
  }
  if (problems411.length) {
    fail('the custom MTConnect type category is not kept as the help says:\n' + problems411.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`Add Metric offers a custom MTConnect type ${categories.join(', ')} with ${categories[0]} chosen first, and the metrics help says so`);
  }
}
