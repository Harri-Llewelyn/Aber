import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 23. Nothing in the stack reports usage or checks for updates by itself.
//
// Each service below does one or the other by default, and each switch is one line that an upgrade
// or a regenerated config file can drop without anything failing. deploy/k8s/README.md,
// "Outbound connections", lists them. Grafana's are also refused as GF_* variables in its
// template, because an environment variable overrides grafana.ini silently.
//
// Aber's own release check is the one exception a site may opt into. It is held off by default:
// false in values.yaml, not turned on by a values file a stack deploys from (scan:config's overlay
// renders it only to scan it), rendered only when on, and named as off by default in the runbook.
// Only its script names api.github.com in the chart, and nothing the browser runs does, so no
// other part of the stack or the page asks GitHub. It compares versions on the pattern
// releaseVersion.js uses, so the menu and the check agree on "newer".
// -------------------------------------------------------------------------------------------------
export default function check() {
  const GRAFANA_INI = 'grafana/grafana.ini';
  const ini = {};
  let section = '';
  for (const line of read(GRAFANA_INI).split(/\r?\n/)) {
    const header = line.match(/^\[([^\]]+)\]\s*$/);
    if (header) { section = header[1]; continue; }
    const kv = line.match(/^([a-z_]+)\s*=\s*(.*?)\s*$/);
    if (kv) ini[`${section}.${kv[1]}`] = kv[2];
  }
  const GRAFANA_OFF = {
    'analytics.reporting_enabled': 'false',
    'analytics.check_for_updates': 'false',
    'analytics.check_for_plugin_updates': 'false',
    'news.news_feed_enabled': 'false',
    'security.disable_gravatar': 'true',
    'plugins.preinstall_auto_update': 'false',
    'plugins.public_key_retrieval_disabled': 'true',
  };
  const grafanaTemplate = read('deploy/helm/aber/templates/obs/grafana.yaml');

  const SWITCHES = [
    ['deploy/helm/aber/templates/obs/alloy.yaml', /^\s*- --disable-reporting\s*$/m, 'Alloy runs with --disable-reporting'],
    ['loki/loki.yaml', /^analytics:\s*\n\s+reporting_enabled:\s*false\s*$/m, 'Loki analytics.reporting_enabled is false'],
    ['node-red/node-red-init.mjs', /telemetry:\s*\{\s*enabled:\s*false,\s*updateNotification:\s*false\s*\}/, "the stack's Node-RED declares telemetry off"],
    ['forge/gateway-platform/appliance/bootstrap.mjs', /telemetry:\s*\{\s*enabled:\s*false,\s*updateNotification:\s*false\s*\}/, "the appliance's Node-RED declares telemetry off"],
    ['deploy/helm/aber/values.yaml', /^\s+telemetryLevel:\s*"off"\s*$/m, 'TimescaleDB telemetryLevel is "off"'],
    ['deploy/helm/aber/templates/apps/gitea.yaml', /GITEA__cron\.update_checker__ENABLED\s*\n\s*value:\s*"false"/, "Gitea's update checker is disabled"],
    ['deploy/helm/aber/templates/obs/swagger-ui.yaml', /name: VALIDATOR_URL\s*\n\s*value:\s*none\s*$/m, "Swagger UI's online validator is disabled"],
  ];

  const offences = [];
  for (const [key, want] of Object.entries(GRAFANA_OFF)) {
    if (ini[key] !== want) offences.push(`${GRAFANA_INI}: [${key.replace('.', '] ')} is ${ini[key] ?? 'unset'}, want ${want}`);
    const env = `GF_${key.replace('.', '_').toUpperCase()}`;
    if (grafanaTemplate.includes(env)) offences.push(`templates/obs/grafana.yaml sets ${env}, which overrides grafana.ini`);
  }
  for (const [file, pattern, what] of SWITCHES) {
    if (!pattern.test(read(file))) offences.push(`${file}: expected ${what}`);
  }

  const CHECK_TEMPLATE = 'deploy/helm/aber/templates/jobs/release-check-cronjob.yaml';
  const CHECK_SCRIPT = 'deploy/helm/aber/files/scripts/release-check.mjs';
  // The lines under `releaseCheck:` up to the next top-level key, read line by line rather than by
  // one regular expression, whose nested repetition backtracks exponentially on blank lines.
  const releaseCheckBlock = (text) => {
    const lines = text.split('\n');
    const start = lines.indexOf('releaseCheck:');
    if (start < 0) return '';
    const end = lines.findIndex((l, i) => i > start && l.trim() !== '' && !l.startsWith('  '));
    return lines.slice(start + 1, end < 0 ? lines.length : end).join('\n');
  };
  if (!/^ {2}enabled: false$/m.test(releaseCheckBlock(read('deploy/helm/aber/values.yaml')))) {
    offences.push('values.yaml: expected releaseCheck.enabled: false');
  }
  for (const file of ['deploy/helm/aber/values-dev.yaml', 'deploy/helm/aber/values-prod.yaml.example']) {
    if (/^ {2}enabled: true$/m.test(releaseCheckBlock(read(file)))) offences.push(`${file} turns the release check on`);
  }
  if (!read(CHECK_TEMPLATE).startsWith('{{- if .Values.releaseCheck.enabled }}')) {
    offences.push(`${CHECK_TEMPLATE}: expected to render nothing unless releaseCheck.enabled`);
  }
  if (!/\n- The release check, only when a site turns it on: `releaseCheck\.enabled` is off by default\./.test(read('deploy/k8s/README.md'))) {
    offences.push('deploy/k8s/README.md: expected "What still leaves Aber" to name the release check as off by default');
  }
  const asksGitHub = allFiles.filter((f) => (f.startsWith('deploy/helm/aber/templates/') || f.startsWith('deploy/helm/aber/files/')
    || (f.startsWith('frontend/src/') && !f.includes('/__tests__/'))) && /api\.github\.com/.test(read(f)));
  for (const f of asksGitHub.filter((f) => f !== CHECK_SCRIPT)) offences.push(`${f} names api.github.com; only the release check may ask GitHub`);
  const corePattern = (file) => read(file).match(/^const CORE = (\/.*\/)$/m)?.[1];
  if (!corePattern(CHECK_SCRIPT) || corePattern(CHECK_SCRIPT) !== corePattern('frontend/src/utils/releaseVersion.js')) {
    offences.push(`${CHECK_SCRIPT} and frontend/src/utils/releaseVersion.js compare versions on different patterns`);
  }

  if (offences.length) {
    fail('a service would report usage or check for updates:\n' + offences.map((o) => `        ${o}`).join('\n'));
  } else {
    pass(`all ${Object.keys(GRAFANA_OFF).length + SWITCHES.length} usage-report and update-check switches are off, and the opt-in release check is off by default`);
  }
}
