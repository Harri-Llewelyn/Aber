import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 377. A capture or playback job has one address, captureJobUrl() in routes.js, and the page reads
// the parameter it writes. alertPage() links a job's alert by it, the Capture page's toasts do, the
// tab reads `job` from the address and passes it to api.jobHistory(), and frontend/README.md's routing
// table lists `job` for Capture.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const routes = read('frontend/src/routes.js');
  const tab = read('frontend/src/components/tabs/CaptureTab.jsx');
  const api = read('frontend/src/api.js');
  const history = read('frontend/src/components/tabs/CaptureHistory.jsx');
  const problems377 = [];
  const param = routes.match(/export const captureJobUrl = \(kind, id\) => pageUrl\('capture', \{ (\w+): id \}, `\$\{kind\}s`\)/)?.[1];
  if (!param) problems377.push('routes.js declares no captureJobUrl(kind, id) in the shape this check reads');
  if (param && !tab.includes(`useUrlState('${param}'`)) problems377.push(`CaptureTab.jsx does not read the "${param}" captureJobUrl() writes`);
  if (param && !/\bjob = null\b/.test(api) && !api.includes(`${param} = null`)) problems377.push(`api.jobHistory() takes no "${param}"`);
  if (param && !history.includes(`jobHistory(kind, { ${param}: jobId`)) problems377.push(`CaptureHistory.jsx does not read the one job through jobHistory(kind, { ${param} })`);
  const alertPage = routes.match(/export const alertPage = [\s\S]*?\n}\n/)?.[0] ?? '';
  if (!alertPage.includes('captureJobUrl(')) problems377.push('alertPage() does not link a job alert by captureJobUrl()');
  if (/tabUrl\('capture', `\$\{kind\}s`\)/.test(alertPage)) problems377.push('alertPage() still opens the whole tab for a job alert');
  const row = read('frontend/README.md').split('\n').find((l) => l.startsWith('| Capture |')) ?? '';
  if (param && !row.includes(`\`${param}\``)) problems377.push(`frontend/README.md's routing table does not list \`${param}\` for Capture`);
  for (const piece of ["captureJobUrl('capture'", "captureJobUrl('playback'"]) {
    if (!tab.includes(piece)) problems377.push(`CaptureTab.jsx no longer links a toast by ${piece}`);
  }
  if (problems377.length) {
    for (const p of problems377) fail(`capture job address: ${p}`);
  } else {
    pass(`a capture or playback job has one address, captureJobUrl(), written by the alert and the toasts and read as ?${param}= by the tab`);
  }
}
