import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 395. The time control says why a span is unavailable. A page that cannot read a long window passes
// TimeWindowControl a `limit` ({ maxSpanMs, reason }) instead of a message of its own: History's
// Overview, for a selection of more than COVERAGE_SMALL_SELECTION devices, with COVERAGE_LARGE_MAX_HOURS
// as its longest window, and System › Logs, with the 169 hours service-logs reads (LONGEST_WINDOW_HOURS
// in logs.ts). SegmentedControl offers the unavailable state, the README states both props, and the
// History help says the choices are greyed and why.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems395 = [];
  const control = read('frontend/src/components/common/TimeWindowControl.jsx');
  const segmented = read('frontend/src/components/common/SegmentedControl.jsx');
  const overview = read('frontend/src/components/tabs/HistoryOverview.jsx');
  const logsTab = read('frontend/src/components/tabs/SystemLogs.jsx');
  const history = read('frontend/src/utils/history.js');
  const logs = read('frontend/src/utils/serviceLogs.js');
  const fn = read('supabase/functions/service-logs/logs.ts');
  const api = read('frontend/src/api.js');
  const readme = read('frontend/README.md');
  const helpHistory = read('help/pages/history.md');

  if (!/limit = null/.test(control)) problems395.push('TimeWindowControl takes no `limit` prop');
  if (!/unavailable: limit\.reason/.test(control)) problems395.push('TimeWindowControl does not mark a span over the limit unavailable with the limit\'s reason');
  if (!/onRefuse=/.test(control)) problems395.push('TimeWindowControl does not hand a refused span to SegmentedControl\'s onRefuse');
  if (!/aria-disabled=\{o\.unavailable/.test(segmented)) problems395.push('SegmentedControl does not mark an unavailable option aria-disabled');
  if (/(?<!aria-)disabled=\{o\.unavailable/.test(segmented)) problems395.push('SegmentedControl disables an unavailable option, which would take it out of the tab order');
  if (!/limit=\{limit\}/.test(overview)) problems395.push('HistoryOverview does not pass the time control a limit');
  if (!/limit=\{LOG_LIMIT\}/.test(logsTab)) problems395.push('SystemLogs does not pass the time control a limit');

  const fnHours = fn.match(/export const LONGEST_WINDOW_HOURS = (\d+)/)?.[1];
  const logHours = logs.match(/export const LOG_WINDOW_HOURS = (\d+)/)?.[1];
  if (!fnHours || !logHours) problems395.push('found no LONGEST_WINDOW_HOURS in service-logs/logs.ts or no LOG_WINDOW_HOURS in serviceLogs.js');
  else if (fnHours !== logHours) problems395.push(`System › Logs limits the window to ${logHours} hours and service-logs reads ${fnHours}`);

  const largeHours = api.match(/export const COVERAGE_LARGE_MAX_HOURS = (\d+)/)?.[1];
  if (!largeHours) problems395.push('found no COVERAGE_LARGE_MAX_HOURS in api.js');
  else if (!/maxSpanMs: COVERAGE_LARGE_MAX_HOURS \* HOUR/.test(history)) problems395.push('Overview\'s limit is not COVERAGE_LARGE_MAX_HOURS, the longest window a large selection reads');

  for (const [what, found] of [
    ['`limit` prop', /`limit=\{\{ maxSpanMs, reason \}\}`/.test(readme)],
    ['SegmentedControl\'s `unavailable` and `onRefuse`', /`unavailable`[\s\S]{0,400}`onRefuse\(option\)`/.test(readme)],
  ]) {
    if (!found) problems395.push(`frontend/README.md does not state the ${what}`);
  }
  if (!/greyed in the time window/.test(helpHistory)) problems395.push('help/pages/history.md does not say the choices past 7 days are greyed in the time window');
  if (/A longer window is not shown, and the page says why/.test(helpHistory)) problems395.push('help/pages/history.md still describes a message in place of the greyed choices');

  if (problems395.length) {
    for (const p of problems395) fail(`time control limit: ${p}`);
  } else {
    pass(`the time control takes a limit, Overview passes the ${largeHours} hours a large selection reads and System › Logs the ${fnHours} service-logs reads, SegmentedControl offers an unavailable option, and the README and the History help say so`);
  }
}
