import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 312. The Metrics help names the page's tabs as navigation.jsx lists them (METRICS_TABS): how many
// there are, and each by its label, in order. A tab the help leaves out is one nobody is told about;
// a label it misspells is one nobody finds.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const block = read('frontend/src/navigation.jsx').match(/^export const METRICS_TABS = \[([\s\S]*?)\n\]/m)?.[1] ?? '';
  const labels = [...block.matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
  const numbers = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  const problems312 = [];
  if (labels.length < 2) problems312.push('could not read METRICS_TABS out of frontend/src/navigation.jsx');
  else {
    const bold = labels.map((l) => `**${l}**`);
    const said = `${bold.slice(0, -1).join(', ')} and ${bold[bold.length - 1]} are the ${numbers[labels.length]} tabs of the page's one card`;
    if (!read('help/pages/metrics.md').includes(said)) problems312.push(`help/pages/metrics.md does not say "${said}"`);
  }
  if (problems312.length) {
    fail('the Metrics help names the page\'s tabs otherwise than navigation.jsx lists them:\n' +
      problems312.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the Metrics help names the page's ${labels.length} tabs, ${labels.join(', ')}, as METRICS_TABS lists them`);
  }
}
