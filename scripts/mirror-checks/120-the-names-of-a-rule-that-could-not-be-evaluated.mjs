import { compare, need, read } from './lib.mjs';

// 120. How an instance of a rule Grafana could not evaluate is told, in the webhook and in the dashboard.
// Grafana sends such an instance under the alertname DatasourceError (or DatasourceNoData), with the
// rule's title in a rulename label; grafana-alert-webhook records it as a platform alert named "<rule>
// could not be evaluated" and keeps the labels as sent. The Built-in tab reads `labels.alertname` of an
// open row to say a rule could not be evaluated, so its two names are the webhook's, and the label it
// reads is the one the webhook keeps. A name one side lacks is a rule Grafana could not run that the
// tab calls firing, or a firing rule it calls unevaluated.
export default function check() {
  const webhook = read('supabase/functions/grafana-alert-webhook/index.ts');
  const tab = read('frontend/src/utils/builtInAlerts.js');
  const names = (list) => [...list.matchAll(/["']([A-Za-z]+)["']/g)].map((m) => m[1]).sort().join(', ');
  const webhookNames = need(webhook, /const NOT_EVALUATED = new Set\(\[([^\]]*)\]\)/, 'NOT_EVALUATED in grafana-alert-webhook/index.ts');
  const tabNames = need(tab, /export const NOT_EVALUATED_NAMES = \[([^\]]*)\]/, 'NOT_EVALUATED_NAMES in frontend/src/utils/builtInAlerts.js');
  if (webhookNames && tabNames) {
    compare('notEvaluated', 'the alertnames of a rule that could not be evaluated, NOT_EVALUATED_NAMES and the webhook\'s NOT_EVALUATED', names(tabNames[1]), names(webhookNames[1]));
  }
  const webhookLabel = need(webhook, /const alertName = \(labels\.(\w+) \?\? ""\)\.trim\(\);/, 'the label the webhook reads the alert\'s name from');
  const tabLabel = need(tab, /export const isNotEvaluated = \(row\) => NOT_EVALUATED_NAMES\.includes\(row\?\.labels\?\.(\w+)\)/, 'the label isNotEvaluated() reads');
  if (webhookLabel && tabLabel) {
    compare('notEvaluated', 'the label that carries the alertname, the one the webhook reads and the dashboard reads back', tabLabel[1], webhookLabel[1]);
  }
}
