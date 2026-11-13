import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 48. An appliance keeps readings exactly as long as ingestion accepts them as historical.
//
// The appliance drops buffered readings older than MAX_AGE_DAYS and counts them as lost; ingestion
// refuses a replayed reading older than TELEMETRY_MAX_HISTORICAL_AGE_SECONDS. If the appliance kept
// longer, it would replay readings ingestion refuses; if shorter, it would drop ones ingestion takes.
// The playback worker and capture.py judge a replay by the same bound, so the playback pod is given
// the chart's value and capture.py restates the daemon's default.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const flow = JSON.parse(read('forge/gateway-platform/appliance/flows.template.json'));
  const gate = (flow.find((n) => n.id === 'aber-sf') || {}).func || '';
  const days = Number((gate.match(/const MAX_AGE_DAYS = (\d+);/) || [])[1]);
  const chart = Number((read('deploy/helm/aber/values.yaml').match(/\n {2}historicalMaxAgeSeconds: (\d+)/) || [])[1]);
  const daemon = (read('ingestion/ingestion.py')
    .match(/TELEMETRY_MAX_HISTORICAL_AGE_SECONDS = int\(\s*os\.getenv\("TELEMETRY_MAX_HISTORICAL_AGE_SECONDS", str\(([\d *]+)\)\)\)/) || [])[1];
  const daemonSeconds = daemon ? daemon.split('*').reduce((p, f) => p * Number(f.trim()), 1) : NaN;
  const restated = (read('ingestion/capture.py')
    .match(/TELEMETRY_MAX_HISTORICAL_AGE_SECONDS = int\(\s*os\.getenv\("TELEMETRY_MAX_HISTORICAL_AGE_SECONDS", str\(([\d *]+)\)\)\)/) || [])[1];
  const restatedSeconds = restated ? restated.split('*').reduce((p, f) => p * Number(f.trim()), 1) : NaN;
  const fromChart = /name: TELEMETRY_MAX_HISTORICAL_AGE_SECONDS\s*\n\s*value: \{\{ \.Values\.ingestion\.historicalMaxAgeSeconds \| int \| quote \}\}/;
  const unwired = ['ingestion', 'playback']
    .filter((app) => !fromChart.test(read(`deploy/helm/aber/templates/apps/${app}.yaml`)));
  if (!Number.isFinite(days) || !Number.isFinite(chart) || !Number.isFinite(daemonSeconds)) {
    fail('check 48 could not read MAX_AGE_DAYS (store and forward), ingestion.historicalMaxAgeSeconds or '
      + "the daemon's TELEMETRY_MAX_HISTORICAL_AGE_SECONDS default");
  } else if (days * 86400 !== chart || chart !== daemonSeconds) {
    fail(`the appliance keeps buffered readings ${days} day(s), the chart accepts historical readings for `
      + `${chart} s and the daemon's default is ${daemonSeconds} s; they must agree`);
  } else if (restatedSeconds !== daemonSeconds) {
    fail(`ingestion/capture.py restates the historical bound as ${restatedSeconds} s, the daemon's default `
      + `is ${daemonSeconds} s; a playback would be judged by a different window than the daemon applies`);
  } else if (unwired.length) {
    fail(`the ${unwired.join(' and ')} template(s) do not set TELEMETRY_MAX_HISTORICAL_AGE_SECONDS from `
      + 'ingestion.historicalMaxAgeSeconds, so a site that changes it is judged by a different bound there');
  } else {
    pass(`the appliance buffer, the chart, the daemon, the playback worker and capture.py all keep historical readings ${days} days`);
  }
}
