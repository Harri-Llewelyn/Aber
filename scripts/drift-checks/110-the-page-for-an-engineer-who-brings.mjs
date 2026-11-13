import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 110. The page for an engineer who brings an edge node states Aber's limits as the code sets them.
//
// help/site/bring-your-own-edge-node.md says which readings are refused for their timestamp, and how
// quiet a node may be before it reads STALE and its devices OFFLINE. An engineer configures
// equipment Aber does not manage by it, so each number is read from where it is set: ingestion.py's
// three windows, the dashboard's staleness (mirrored to gateway_status by check-mirror-drift) and the
// chart's device timeout.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const PAGE = 'help/site/bring-your-own-edge-node.md';
  const page = read(PAGE).replace(/\s+/g, ' ');
  const py = read('ingestion/ingestion.py');
  const product = (expr) => (expr ? expr.split('*').reduce((p, f) => p * Number(f.trim()), 1) : NaN);
  const maxAge = product((py.match(/^TELEMETRY_MAX_AGE_SECONDS = ([\d *]+?)\s*(?:#|$)/m) || [])[1]);
  const maxFuture = product((py.match(/^TELEMETRY_MAX_FUTURE_SECONDS = ([\d *]+?)\s*(?:#|$)/m) || [])[1]);
  const historical = product((py.match(/TELEMETRY_MAX_HISTORICAL_AGE_SECONDS = int\(\s*os\.getenv\("TELEMETRY_MAX_HISTORICAL_AGE_SECONDS", str\(([\d *]+)\)\)\)/) || [])[1]);
  const staleSeconds = Number(((read('frontend/src/utils/gatewayStatus.js').match(/HEARTBEAT_STALE_MS\s*=\s*([\d_]+)/) || [])[1] || '').replace(/_/g, '')) / 1000;
  const deviceSeconds = Number((read('deploy/helm/aber/values.yaml').match(/\n {2}deviceOfflineTimeoutSeconds: (\d+)/) || [])[1]);

  const claims = [
    ['ingestion.py TELEMETRY_MAX_AGE_SECONDS', maxAge / 3600, (n) => `more than ${n} hours old`],
    ['ingestion.py TELEMETRY_MAX_FUTURE_SECONDS', maxFuture / 60, (n) => `more than ${n} minutes in the future`],
    ['ingestion.py TELEMETRY_MAX_HISTORICAL_AGE_SECONDS', historical / 86400, (n) => `up to ${n} days old`],
    ['gatewayStatus.js HEARTBEAT_STALE_MS', staleSeconds, (n) => `a node message at least every ${n} seconds`],
    ['values.yaml ingestion.deviceOfflineTimeoutSeconds', deviceSeconds / 60, (n) => `at least every ${n} minutes by default`],
  ];
  const unread = claims.filter(([, n]) => !Number.isInteger(n) || n <= 0).map(([source]) => source);
  const wrong = claims.filter(([, n]) => Number.isInteger(n) && n > 0)
    .map(([source, n, phrase]) => [source, phrase(n)])
    .filter(([, phrase]) => !page.includes(phrase));
  if (unread.length) {
    fail(`check 110 could not read a whole number of hours, minutes, days or seconds from: ${unread.join(', ')}`);
  } else if (wrong.length) {
    fail(`${PAGE} does not state Aber's limits as the code sets them; it should say:\n`
      + wrong.map(([source, phrase]) => `        "${phrase}" (${source})`).join('\n')
      + '\n      An engineer configures a node Aber does not manage by this page, so a stale number is a node\n'
      + '      whose readings are refused, or that reads STALE, for a reason nothing on the page explains.');
  } else {
    pass(`${PAGE} states the ${claims.length} limits a node is held to as ingestion.py, the dashboard and the chart set them`);
  }
}
