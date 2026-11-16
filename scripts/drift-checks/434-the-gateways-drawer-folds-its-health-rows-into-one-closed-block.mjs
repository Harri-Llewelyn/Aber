import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 434. The Gateways drawer folds the seven appliance rows into one closed Health block, and the
// documents say so. Every row the block holds is marked `health: true` in GatewaysTab.jsx and is a
// row a kind can never fill (NEVER_FILLED_ROWS), so no kind shows part of the block; the two rows a
// heartbeat fills stay outside it. The rows are folded through foldHealthRows(), their colours come
// from gatewayHealthProblems(), and ContextPanel draws the group with a GroupHeading. The help names
// the block and its rows, and the README states the rule beside the drawer's other rules.
// -------------------------------------------------------------------------------------------------
export default async function check() {
  const { NEVER_FILLED_ROWS, GATEWAY_TYPES } = await import(pathToFileURL(join(REPO, 'frontend/src/utils/gatewayType.js')).href);
  const tab = read('frontend/src/components/tabs/GatewaysTab.jsx');
  const panel = read('frontend/src/components/common/ContextPanel.jsx');
  const help = read('help/pages/gateways.md');
  const readme = read('frontend/README.md');
  const problems434 = [];
  const BLOCK = ['CA Expires', 'Disk Free', 'Memory Available', 'Load (1m)', 'Flow', 'Platform', 'Custom'];
  const OUTSIDE = ['Health Reported', 'Runtime Uptime'];

  // The rows marked `health: true`, read from the source: `label: 'X',` then `health: true,`.
  const marked = [...tab.matchAll(/label: '([^']+)',\n\s+health: true,/g)].map((m) => m[1]);
  if ([...marked].sort().join('|') !== [...BLOCK].sort().join('|')) {
    problems434.push(`GatewaysTab.jsx marks [${marked.join(', ')}] as health rows, not [${BLOCK.join(', ')}]`);
  }
  for (const label of OUTSIDE) {
    // The row's own object, from its label to the next row's, found as text.
    const at = tab.indexOf(`label: '${label}',`);
    const row = tab.slice(at, tab.indexOf('label:', at + 1));
    if (at < 0 || row.includes('health: true')) problems434.push(`GatewaysTab.jsx folds "${label}" into the Health block, which a heartbeat fills and which stays outside it`);
  }
  // A block row is hidden for the same kinds together, so no kind shows half of it.
  for (const [kind, hidden] of Object.entries(NEVER_FILLED_ROWS)) {
    const some = BLOCK.filter((l) => hidden.includes(l));
    if (some.length !== 0 && some.length !== BLOCK.length) problems434.push(`NEVER_FILLED_ROWS for ${kind} hides only some of the Health block's rows (${some.join(', ')})`);
  }
  if (NEVER_FILLED_ROWS[GATEWAY_TYPES.REMOTE].length !== 0) problems434.push('NEVER_FILLED_ROWS hides a row from a Remote gateway, so its Health block is no longer whole');

  if (!tab.includes('foldHealthRows(')) problems434.push('GatewaysTab.jsx does not fold its health rows through foldHealthRows()');
  if (!/danger: rowTone\(healthProblems, 'CA Expires'\) === TONE_DANGER/.test(tab)) problems434.push('GatewaysTab.jsx does not colour its CA Expires row from gatewayHealthProblems()');
  const fieldGroup = panel.slice(panel.indexOf('function FieldGroup('), panel.indexOf('function Field('));
  if (!fieldGroup.includes('<GroupHeading')) problems434.push('ContextPanel.jsx does not draw a group of fields with a GroupHeading');
  if (!fieldGroup.includes('useState(false)')) problems434.push('ContextPanel.jsx does not close a group of fields to start with');

  const drawer = help.slice(help.indexOf('- **The Health block**'), help.indexOf('- **Publishes under group X'));
  for (const label of BLOCK) {
    if (!drawer.includes(`**${label}**`)) problems434.push(`help/pages/gateways.md does not name ${label} in the Health block's paragraph`);
  }
  if (!drawer.includes('It is closed when the drawer opens')) problems434.push('help/pages/gateways.md does not say the Health block is closed when the drawer opens');
  if (!drawer.includes('"Nothing needs attention"')) problems434.push('help/pages/gateways.md does not say what the block\'s heading reads when nothing needs attention');

  for (const phrase of ['A group of rows a reader seldom needs opens on request', '`foldHealthRows()`', '`gatewayHealthProblems()`', '`health: true`']) {
    if (!readme.includes(phrase)) problems434.push(`frontend/README.md does not say ${phrase}`);
  }
  if (problems434.length) {
    fail('the Gateways drawer\'s Health block and the documents disagree:\n' + problems434.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the Gateways drawer folds its ${BLOCK.length} appliance rows into one closed Health block, outside it ${OUTSIDE.join(' and ')}, and the help and the README say so`);
  }
}
