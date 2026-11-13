import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 309. The Cell tab is named and reached as the Device tab is. The Cells drawer's History action has
// the Devices drawer's label and icon, and each goes to its own tab's path; History's tabs list
// Cell after Device with a description of its own; the search index offers it; and the help
// page names it. A drawer that says another word for the same act is two names for one thing.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const action = (file) => read(file).match(/label: '(View History)', icon: <(\w+) size=\{13\} \/>,\s*to: (\w+)\(/);
  const devices = action('frontend/src/components/tabs/DevicesTab.jsx');
  const cells = action('frontend/src/components/tabs/CellsTab.jsx');
  const routes = read('frontend/src/routes.js');
  const history = read('frontend/src/utils/history.js');
  const tabs = read('frontend/src/navigation.jsx').match(/export const HISTORY_TABS = \[([\s\S]*?)\n\]/)?.[1] ?? '';
  const ids = [...tabs.matchAll(/\{ id: '([a-z]+)', label: '([^']+)', description: ["'`]([^"'`]+)/g)];
  const problems309 = [];
  if (!devices) problems309.push('could not read the Devices drawer\'s View History action out of DevicesTab.jsx');
  if (!cells) problems309.push('the Cells drawer has no View History action like the Devices drawer\'s in CellsTab.jsx (label, icon, to)');
  if (devices && cells) {
    if (devices[2] !== cells[2]) problems309.push(`the Cells drawer's History action draws ${cells[2]}, the Devices drawer's ${devices[2]}`);
    if (devices[3] !== 'deviceHistoryUrl' || cells[3] !== 'cellHistoryUrl') problems309.push(`the drawers' History actions go to ${devices[3]} and ${cells[3]}, not deviceHistoryUrl and cellHistoryUrl`);
  }
  const cellPath = history.match(/^export const CELL_PATH = '([^']+)'$/m)?.[1];
  if (!cellPath) problems309.push('could not read CELL_PATH out of frontend/src/utils/history.js');
  else if (!routes.includes(`export const cellHistoryUrl = (id) => \`${cellPath}/\${encodeURIComponent(id)}\``)) {
    problems309.push(`frontend/src/routes.js's cellHistoryUrl does not build ${cellPath}/<id>`);
  }
  const order = ids.map((m) => m[1]);
  if (order.indexOf('cell') < 0 || order.indexOf('cell') <= order.indexOf('device')) problems309.push(`HISTORY_TABS lists ${order.join(', ')}; Cell goes after Device`);
  if (!ids.find((m) => m[1] === 'cell')?.[3]) problems309.push('HISTORY_TABS gives the Cell tab no description');
  if (!read('frontend/src/searchIndex.js').includes("...tabCard('history', 'cell')")) problems309.push('frontend/src/searchIndex.js has no card for the Cell tab');
  const help = read('help/pages/history.md');
  if (!help.includes('\n## The Cell tab: comparing the machines in a cell\n')) problems309.push('help/pages/history.md has no "The Cell tab" section');
  if (!help.includes('open the cell on the Cells page and select **View History**')) problems309.push('help/pages/history.md does not say View History opens a cell from the Cells page');
  if (problems309.length) {
    fail('The Cell tab is named or reached otherwise than the Device tab is:\n' + problems309.map((p) => `        ${p}`).join('\n'));
  } else {
    pass('the Cells drawer says View History as the Devices drawer does, to /history/cell, and History lists, searches and documents the Cell tab after Device');
  }
}
