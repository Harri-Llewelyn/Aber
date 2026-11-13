import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 329. History's tabs are the issue's, in its order: Overview, Device, Metric, Cell, Area, Alerts. Each
// has a description of its own and a card in the search index, and the page gives each an address
// (TAB_PATHS in HistoryTab.jsx), so a tab the strip lists is one the page can open and the search can
// find. A tab in one list and not another is a link that opens the Overview.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const tabs = read('frontend/src/navigation.jsx').match(/export const HISTORY_TABS = \[([\s\S]*?)\n\]/)?.[1] ?? '';
  const ids = [...tabs.matchAll(/\{ id: '([a-z]+)', label: '([^']+)', description: ["'`]([^"'`]+)/g)];
  const order = ids.map((m) => m[1]);
  const want = ['overview', 'device', 'metric', 'cell', 'area', 'alerts'];
  const problems329 = [];
  if (order.join(', ') !== want.join(', ')) problems329.push(`HISTORY_TABS lists ${order.join(', ')}; the issue's order is ${want.join(', ')}`);
  for (const m of ids) if (!m[3]) problems329.push(`HISTORY_TABS gives the ${m[2]} tab no description`);
  const search = read('frontend/src/searchIndex.js');
  for (const id of ['overview', 'metric', 'cell', 'area', 'alerts']) {
    if (!search.includes(`...tabCard('history', '${id}')`)) problems329.push(`frontend/src/searchIndex.js has no card for the ${id} tab`);
  }
  const page = read('frontend/src/components/tabs/HistoryTab.jsx');
  const paths = page.match(/const TAB_PATHS = \{([\s\S]*?)\n\}/)?.[1] ?? '';
  for (const key of ['overview', 'device', 'METRIC_TAB', 'CELL_TAB', 'AREA_TAB', 'ALERTS_TAB']) {
    if (!new RegExp(`\\b${key}\\b`).test(paths)) problems329.push(`TAB_PATHS in HistoryTab.jsx gives the ${key} tab no path`);
  }
  const util = read('frontend/src/utils/history.js');
  for (const [name, path] of [['METRIC_PATH', '/history/metric'], ['AREA_PATH', '/history/area']]) {
    if (!util.includes(`export const ${name} = '${path}'`)) problems329.push(`utils/history.js's ${name} is not ${path}`);
  }
  if (problems329.length) {
    fail('History\'s tabs are listed, searched or opened otherwise than the issue has them:\n' + problems329.map((p) => `        ${p}`).join('\n'));
  } else {
    pass('History lists Overview, Device, Metric, Cell, Area and Alerts in that order, each described, searched and given an address');
  }
}
