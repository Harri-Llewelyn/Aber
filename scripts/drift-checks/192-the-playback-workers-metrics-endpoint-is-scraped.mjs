import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 192. The playback worker's metrics endpoint is scraped. The worker serves PLAYBACK_METRICS_PORT,
// whose default is values.yaml's playback.metrics.port; playback.yaml passes the port, or 0 when
// playback.metrics.enabled is false, and annotates the pod for Alloy's scrape on it; and the network
// policy admits alloy to playback on it. Any one missing and the outcome count is never collected,
// with the endpoint answering and nothing failing.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const worker = read('ingestion/playback_worker.py');
  const template = read('deploy/helm/aber/templates/apps/playback.yaml');
  const policy = read('deploy/helm/aber/templates/networkpolicy.yaml');
  const values = read('deploy/helm/aber/values.yaml');
  const defaultPort = worker.match(/^PLAYBACK_METRICS_PORT = int\(os\.getenv\("PLAYBACK_METRICS_PORT", "(\d+)"\)\)/m)?.[1];
  const valuesPort = values.slice(values.indexOf('\nplayback:\n')).match(/\n {2}metrics:\n {4}enabled: \w+\n {4}port: (\d+)\n/)?.[1];
  const wrong = [];
  if (!defaultPort) wrong.push('ingestion/playback_worker.py does not read PLAYBACK_METRICS_PORT');
  if (!valuesPort) wrong.push('values.yaml declares no playback.metrics.enabled and playback.metrics.port');
  if (defaultPort && valuesPort && defaultPort !== valuesPort) {
    wrong.push(`the worker's default port is ${defaultPort} and the chart's is ${valuesPort}`);
  }
  if (!/- name: PLAYBACK_METRICS_PORT\n\s+value: \{\{ ternary \(\.Values\.playback\.metrics\.port \| toString\) "0" \.Values\.playback\.metrics\.enabled \| quote \}\}/.test(template)) {
    wrong.push('playback.yaml does not pass PLAYBACK_METRICS_PORT from playback.metrics, 0 when it is disabled');
  }
  if (!/\{\{- if \.Values\.playback\.metrics\.enabled \}\}\n\s+\{\{- include "aber\.scrapeAnnotations" \(dict "port" \.Values\.playback\.metrics\.port "path" "\/metrics"\)/.test(template)) {
    wrong.push("playback.yaml does not annotate the pod for Alloy's scrape on playback.metrics.port");
  }
  if (!/\(dict "from" "alloy"\s+"to" "playback"\s+"port" \(int \.Values\.playback\.metrics\.port\)/.test(policy)) {
    wrong.push('networkpolicy.yaml has no alloy -> playback edge on playback.metrics.port, so under default-deny the scrape is dropped');
  }
  if (wrong.length) {
    fail(`the playback worker's outcome count would not be collected:\n      ${wrong.join('\n      ')}`);
  } else {
    pass(`the playback worker serves :${defaultPort}/metrics, and the chart passes the port, annotates the pod and admits alloy to it`);
  }
}
