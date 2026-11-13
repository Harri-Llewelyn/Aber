import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 326. The four drawers' History actions are alike. The Devices, Cells, Areas and Metrics drawers each
// say View History, with the same icon, and go to their own tab's path: deviceHistoryUrl, cellHistoryUrl,
// areaHistoryUrl and metricHistoryUrl, whose paths are the tabs' (the Area tab's is utils/history.js's
// AREA_PATH, the Metric tab's its METRIC_PATH). The help names the Areas drawer's action as it does the
// Cells drawer's, and the Metrics help names the Metrics drawer's. A drawer that says another word for
// the same act is two names for one thing.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const action = (file) => read(file).match(/label: '(View History)', icon: <(\w+) size=\{13\} \/>,\s*to: (\w+)\(/);
  const drawers = [
    ['Devices', 'frontend/src/components/tabs/DevicesTab.jsx', 'deviceHistoryUrl'],
    ['Cells', 'frontend/src/components/tabs/CellsTab.jsx', 'cellHistoryUrl'],
    ['Areas', 'frontend/src/components/tabs/AreasTab.jsx', 'areaHistoryUrl'],
    ['Metrics', 'frontend/src/components/tabs/MetricsTab.jsx', 'metricHistoryUrl'],
  ];
  const found = drawers.map(([name, file, url]) => ({ name, url, match: action(file) }));
  const problems326 = [];
  for (const d of found) if (!d.match) problems326.push(`the ${d.name} drawer has no View History action (label, a size-13 icon, to) in its tab`);
  const have = found.filter((d) => d.match);
  if (new Set(have.map((d) => d.match[2])).size > 1) {
    problems326.push(`the drawers' History actions draw ${have.map((d) => `${d.name}: ${d.match[2]}`).join(', ')}; they draw one icon`);
  }
  for (const d of have) if (d.match[3] !== d.url) problems326.push(`the ${d.name} drawer's History action goes to ${d.match[3]}, not ${d.url}`);
  const routes = read('frontend/src/routes.js');
  const areaPath = read('frontend/src/utils/history.js').match(/^export const AREA_PATH = '([^']+)'$/m)?.[1];
  if (!areaPath) problems326.push('could not read AREA_PATH out of frontend/src/utils/history.js');
  else if (!routes.includes(`export const areaHistoryUrl = (id) => \`${areaPath}/\${encodeURIComponent(id)}\``)) {
    problems326.push(`frontend/src/routes.js's areaHistoryUrl does not build ${areaPath}/<id>`);
  }
  const metricPath = read('frontend/src/utils/history.js').match(/^export const METRIC_PATH = '([^']+)'$/m)?.[1];
  if (!metricPath) problems326.push('could not read METRIC_PATH out of frontend/src/utils/history.js');
  else if (!routes.includes(`export const metricHistoryUrl = (name) => \`${metricPath}/\${encodeURIComponent(name)}\``)) {
    problems326.push(`frontend/src/routes.js's metricHistoryUrl does not build ${metricPath}/<name>`);
  }
  if (!read('help/pages/history.md').includes('open the area on the Areas page and select **View History**')) {
    problems326.push('help/pages/history.md does not say View History opens an area from the Areas page');
  }
  if (!read('help/pages/metrics.md').includes("**View History** opens the History page's Metric tab on the metric")) {
    problems326.push('help/pages/metrics.md does not say View History opens the Metric tab on the metric');
  }
  if (problems326.length) {
    fail('The drawers\' History actions are named or reached otherwise than each other\'s:\n' + problems326.map((p) => `        ${p}`).join('\n'));
  } else {
    pass('the Devices, Cells, Areas and Metrics drawers all say View History with one icon, each to its own tab, and the help names the Areas and Metrics drawers\'');
  }
}
