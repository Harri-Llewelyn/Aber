import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 170. grafana-alert-webhook knows a rule Grafana could not evaluate by the alertname Grafana gives
// it (NOT_EVALUATED in index.ts), and records it as a platform alert naming the rule. Grafana
// renames the instance, firing and resolving, only under `execErrState: Error`: under `Alerting`
// the error arrives under the rule's own name and is stored as the condition holding. So every rule
// is `execErrState: Error`, and none is titled as one of those names or declares a `rulename` label,
// which would read as an error, or give the error row a wrong name.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const RULES = 'grafana/provisioning/alerting/alert-rules.yaml';
  const WEBHOOK = 'supabase/functions/grafana-alert-webhook/index.ts';
  const renamed = new Set([...(read(WEBHOOK).match(/const NOT_EVALUATED = new Set\(\[([^\]]*)\]\)/)?.[1] ?? '')
    .matchAll(/"(\w+)"/g)].map((m) => m[1]));

  const wrong = [];
  const rules = read(RULES).split(/^ {6}- uid: /m).slice(1);
  for (const block of rules) {
    const uid = block.split('\n')[0].trim();
    const title = block.match(/^ {8}title: (.+)$/m)?.[1].trim().replace(/^(['"])(.*)\1$/, '$2');
    const errState = block.match(/^ {8}execErrState: (\S+)$/m)?.[1];
    const labels = block.match(/^ {8}labels:\n((?: {10}\S.*\n)+)/m)?.[1] ?? '';
    if (errState !== 'Error') wrong.push(`${uid}: execErrState is ${errState ?? 'unset'}`);
    if (renamed.has(title)) wrong.push(`${uid}: titled "${title}", the name Grafana gives an evaluation error`);
    if (/^ {10}rulename:/m.test(labels)) wrong.push(`${uid}: declares a \`rulename\` label, which Grafana sets on an evaluation error`);
  }

  if (rules.length < 30 || renamed.size < 2) {
    fail(`check 170 read ${rules.length} rule(s) from ${RULES} and ${renamed.size} name(s) from ${WEBHOOK}'s `
      + 'NOT_EVALUATED; the parse has stopped matching one of them');
  } else if (wrong.length) {
    fail(`${wrong.length} alert rule(s) would reach the dashboard as the wrong thing when Grafana cannot `
      + `evaluate them (${WEBHOOK} knows an evaluation error by Grafana's ${[...renamed].join(' and ')}):\n      `
      + wrong.join('\n      '));
  } else {
    pass(`all ${rules.length} alert rules are execErrState: Error, so an evaluation error reaches the webhook `
      + `renamed and is recorded as the rule not evaluated`);
  }
}
