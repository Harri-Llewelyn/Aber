import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 237. The help names the Suppression windows section's controls as the drawer draws them. The
// labels are SuppressionWindows.jsx's and the dialog's; devices.md holds the section, and the
// gateway and cell pages and the Site Map's counter link to it. The counter's help says a
// suppressed alert is not counted, and the Site Map's states that one colours nothing.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const SECTION = 'frontend/src/components/common/SuppressionWindows.jsx';
  const DIALOG = 'frontend/src/components/modals/SuppressionWindowModal.jsx';
  const code = read(SECTION) + read(DIALOG);
  const devices = read('help/pages/devices.md');
  const problems237 = [];
  const help = devices.slice(devices.indexOf('## Suppression windows'));
  if (!devices.includes('## Suppression windows')) problems237.push('help/pages/devices.md has no "## Suppression windows" section');
  for (const label of ['Schedule window…', 'Change…', 'End now', 'Cancel window', 'From cell', 'NOW']) {
    if (!code.includes(label)) problems237.push(`${SECTION}: no longer draws "${label}"`);
    if (!help.includes(`**${label}**`)) problems237.push(`help/pages/devices.md: the section does not name **${label}**`);
  }
  if (!code.includes("'Schedule window'") || !help.includes('Select **Schedule window**.')) {
    problems237.push("the dialog's confirm and the help's last step do not both say Schedule window");
  }
  for (const page of ['help/pages/gateways.md', 'help/pages/cells.md', 'help/pages/site-map.md']) {
    if (!read(page).includes('(devices.md#suppression-windows)')) problems237.push(`${page} does not link to devices.md#suppression-windows`);
  }
  const siteMap = read('help/pages/site-map.md');
  const states = siteMap.slice(siteMap.indexOf('## What the states mean'), siteMap.indexOf('## The alert counter'));
  const counter = siteMap.slice(siteMap.indexOf('## The alert counter'));
  if (!states.includes('A suppressed alert colours nothing.')) problems237.push('help/pages/site-map.md: the states do not say a suppressed alert colours nothing');
  if (!counter.includes('A suppressed alert is not counted')) problems237.push("help/pages/site-map.md: the counter's help does not say a suppressed alert is not counted");
  if (problems237.length) {
    fail('the help and the Suppression windows section disagree:\n' + problems237.map((p) => `        ${p}`).join('\n'));
  } else {
    pass('the help names the Suppression windows controls as the drawer draws them, and says a suppressed alert is not counted and colours nothing');
  }
}
