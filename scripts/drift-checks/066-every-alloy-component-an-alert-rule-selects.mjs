import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 66. Every Alloy component an alert rule selects by `component_id` is one the collector config
// declares. Alloy labels a component's own metrics with its id (`loki.write.local`), so a rule
// naming a component that was renamed or never rendered matches no series, and with
// `noDataState: OK` it reads Normal for ever.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const RULES = 'grafana/provisioning/alerting/alert-rules.yaml';
  const ALLOY = 'deploy/helm/aber/templates/obs/alloy.yaml';
  const declared = new Set(
    [...read(ALLOY).matchAll(/^([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+) "([a-z][a-z0-9_]*)" \{/gm)]
      .map((m) => `${m[1]}.${m[2]}`)
  );
  const named = [...new Set([...read(RULES).matchAll(/component_id\s*=~?\s*"([^"]+)"/g)].map((m) => m[1]))];
  const unknown = named.filter((id) => !declared.has(id));
  if (!named.length) {
    fail(`${RULES} selects no Alloy component by component_id; the Log Pipeline rules did, so this check has stopped finding them`);
  } else if (unknown.length) {
    fail(
      `alert rule(s) select Alloy component(s) ${ALLOY} does not declare: ${unknown.join(', ')}.\n` +
        '      Each is a series that never exists, so the rule reads Normal for ever.'
    );
  } else {
    pass(`the alert rules select ${named.length} Alloy component(s) by id, each declared in the collector config`);
  }
}
