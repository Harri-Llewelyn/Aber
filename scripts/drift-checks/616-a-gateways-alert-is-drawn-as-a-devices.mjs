import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 616. A gateway's firing alert is drawn as a device's: the Devices and Gateways rows draw it with
// AlertBadge beside the status, sort their status column with statusSortRank(), and hand their drawer
// the alert, so its banner heads the warnings. The Gateways help names the words AlertBadge draws.
// -------------------------------------------------------------------------------------------------
const BADGE = 'frontend/src/components/common/AlertBadge.jsx';
const PAGES = {
  Devices: 'frontend/src/components/tabs/DevicesTab.jsx',
  Gateways: 'frontend/src/components/tabs/GatewaysTab.jsx',
};
const HELP = 'help/pages/gateways.md';

export default function check() {
  const problems616 = [];
  const words = [...read(BADGE).matchAll(/'([A-Z]{4,})'|>\s*([A-Z]{4,})\s*</g)].map((m) => m[1] ?? m[2]);
  if (words.join() !== 'ACKNOWLEDGED,ALARM,WARNING') problems616.push(`${BADGE} draws ${words.join(', ') || 'no words this check can read'}, not ACKNOWLEDGED, ALARM and WARNING`);

  for (const [page, file] of Object.entries(PAGES)) {
    const tab = read(file).replace(/\r\n/g, '\n');
    if (!/<AlertBadge alert=\{/.test(tab)) problems616.push(`${file} does not draw its row's alert with AlertBadge, as the ${page === 'Devices' ? 'Gateways' : 'Devices'} page does`);
    if (!/status: \{[\s\S]{0,120}?statusSortRank\(/.test(tab)) problems616.push(`${file} does not sort its status column with statusSortRank()`);
    if (!/<ContextPanel\n(?:\s+\w+=[^\n]*\n)*?\s+alert=\{/.test(tab)) problems616.push(`${file} does not hand its drawer the alert, whose banner heads its warnings`);
  }

  const help = read(HELP);
  for (const word of words) if (!help.includes(`**${word}**`)) problems616.push(`${HELP} does not name **${word}**, which a gateway's row draws`);

  if (problems616.length) {
    fail("A gateway's alert is not drawn as a device's:\n" + problems616.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the Devices and Gateways rows draw an alert with AlertBadge (${words.join(', ')}), sort it with statusSortRank() and hand it to the drawer, and ${HELP} names its words`);
  }
}
