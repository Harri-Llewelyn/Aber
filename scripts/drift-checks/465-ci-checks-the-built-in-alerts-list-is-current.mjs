import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 465. CI checks that the Built-in alerts list is current. The list is committed, as the chart's mirrors
// are, so the guard is the script run with --check in the frontend job, beside the vocabulary seeds.
// A step dropped from the workflow leaves a stale list that nothing finds, so this holds the step, the
// script and the file it writes.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const CI = '.github/workflows/ci.yml';
  const SCRIPT = 'scripts/generate-built-in-alerts.mjs';
  const problems465 = [];
  if (!/run: node scripts\/generate-built-in-alerts\.mjs --check\s*$/m.test(read(CI))) problems465.push(`${CI} does not run node scripts/generate-built-in-alerts.mjs --check`);
  const script = read(SCRIPT);
  if (!script.includes("'--check'")) problems465.push(`${SCRIPT} has no --check mode`);
  const target = /const TARGET = '([^']+)'/.exec(script)?.[1];
  const source = /const SOURCE = '([^']+)'/.exec(script)?.[1];
  if (target !== 'frontend/src/utils/builtInAlerts.generated.json') problems465.push(`${SCRIPT} writes ${target}, and the dashboard bundles frontend/src/utils/builtInAlerts.generated.json`);
  if (source !== 'grafana/provisioning/alerting/alert-rules.yaml') problems465.push(`${SCRIPT} reads ${source}, and the rules are provisioned from grafana/provisioning/alerting/alert-rules.yaml`);
  if (!read('frontend/src/utils/builtInAlerts.js').includes("'./builtInAlerts.generated.json'")) problems465.push('frontend/src/utils/builtInAlerts.js does not import the generated list');
  if (problems465.length) {
    fail(`the Built-in alerts list has no guard in CI:\n${problems465.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass('CI runs scripts/generate-built-in-alerts.mjs --check, which holds the Built-in tab\'s list to the rules file');
  }
}
