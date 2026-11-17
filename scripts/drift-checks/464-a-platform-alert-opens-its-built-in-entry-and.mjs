import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 464. A platform alert opens its rule's entry on Automations > Built-in, from every surface that shows
// one, and only the Built-in tab (the rule's drawer, and its notice for a uid no built-in rule has)
// builds a Grafana address for it. The surfaces are the toast
// (usePlatformAlerts), the alert counter (AlertPill), the drawer's alert banner (ContextPanel), the
// message about an alert (alertAcknowledgement) and the desktop notification (desktopNotifications).
// A vitest reads the whole source tree for the second half; this reads the five and the README that
// says it, so `npm run lint` finds a surface sent back to Grafana before the suite runs.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const SURFACES = [
    'frontend/src/hooks/usePlatformAlerts.js',
    'frontend/src/components/common/AlertPill.jsx',
    'frontend/src/components/common/ContextPanel.jsx',
    'frontend/src/utils/alertAcknowledgement.js',
    'frontend/src/utils/desktopNotifications.js',
  ];
  const README = 'frontend/README.md';
  const problems464 = [];
  const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  for (const file of SURFACES) {
    const source = read(file);
    if (!/builtInAlertUrl/.test(source)) problems464.push(`${file} does not open a platform alert's Built-in entry (builtInAlertUrl)`);
    if (/grafanaAlertUrl|GRAFANA_URL|\/alerting\//.test(code(source))) {
      problems464.push(`${file} builds a Grafana address: only the Built-in tab does (BuiltInAlertDrawer.jsx, BuiltInAlerts.jsx), as View in Grafana`);
    }
  }
  const readme = read(README);
  if (!/builtInAlertUrl/.test(readme)) problems464.push(`${README} does not say a platform alert goes to its Built-in entry (builtInAlertUrl)`);
  if (/A Grafana\s+alert goes to its rule \(`grafanaAlertUrl`\)/.test(readme)) problems464.push(`${README} still says a Grafana alert goes to its rule in Grafana`);
  if (!/View in Grafana/.test(readme)) problems464.push(`${README} does not say View in Grafana is the Built-in tab's, in the rule's drawer and the notice for an unlisted uid`);
  for (const file of ['frontend/src/components/tabs/BuiltInAlertDrawer.jsx', 'frontend/src/components/tabs/BuiltInAlerts.jsx']) {
    if (!/grafanaAlertUrl/.test(read(file))) problems464.push(`${file} no longer offers View in Grafana, which the Built-in tab keeps for the rule's drawer and an unlisted uid`);
  }

  if (problems464.length) {
    fail(`a platform alert is sent somewhere other than its Built-in entry:\n${problems464.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`the ${SURFACES.length} surfaces that show a platform alert open its Built-in entry, none builds a Grafana address, and ${README} says so`);
  }
}
