import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 104. Grafana's Alerting > History has a history to show.
//
// The dashboard's record of what fired is History's Alerts tab, which the alert counter's footer
// links to. Grafana keeps its own for its own pages, and Alerting > History answers only from Loki:
// on Grafana's default annotations backend it shows an error. So grafana.ini sends state history
// to Loki, the chart gives Grafana the Loki URL the logs datasource uses, and grafana/README.md
// says why.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const INI = 'grafana/grafana.ini';
  const TEMPLATE = 'deploy/helm/aber/templates/obs/grafana.yaml';
  const README = 'grafana/README.md';
  const ENV = 'GF_UNIFIED_ALERTING_STATE_HISTORY_LOKI_REMOTE_URL';

  const ini = {};
  let section = '';
  for (const line of read(INI).split(/\r?\n/)) {
    const header = line.match(/^\[([^\]]+)\]\s*$/);
    if (header) { section = header[1]; continue; }
    const kv = line.match(/^([a-z_]+)\s*=\s*(.*?)\s*$/);
    if (kv) ini[`${section}.${kv[1]}`] = kv[2];
  }
  const problems104 = [];
  if (ini['unified_alerting.state_history.enabled'] !== 'true') problems104.push(`${INI}: [unified_alerting.state_history] enabled is not true`);
  if (ini['unified_alerting.state_history.backend'] !== 'loki') problems104.push(`${INI}: [unified_alerting.state_history] backend is ${ini['unified_alerting.state_history.backend'] ?? 'unset'}, want loki`);
  const env = read(TEMPLATE).split('\n').findIndex(l => l.trim() === `- name: ${ENV}`);
  const value = env < 0 ? '' : read(TEMPLATE).split('\n')[env + 1].trim();
  if (value !== 'value: {{ include "aber.lokiUrl" . | quote }}') problems104.push(`${TEMPLATE}: ${ENV} is not set from aber.lokiUrl, the logs datasource's URL`);
  if (!read(README).includes('\n## Alert state history\n')) problems104.push(`${README}: no "Alert state history" section`);

  if (problems104.length) {
    fail(
      'alert state history: Grafana\'s Alerting > History needs:\n' +
        problems104.map(p => `      - ${p}`).join('\n')
    );
  } else {
    pass('Grafana keeps alert state history in the logs datasource\'s Loki, so its Alerting > History has a page to show');
  }
}
