/**
 * Every Compose service has a chart workload, and every chart workload has a Compose service, or is
 * listed here with the reason it does not. It catches a service that exists on one target and
 * nowhere on the other, the class the other guards miss.
 *
 * It parses templates rather than rendering the chart: half the workloads are behind an `enabled`
 * flag, so a render answers what one values file switches on, and the question is what the chart
 * knows how to deploy. Two idioms are read, `{{- $component := "name" -}}` and a literal
 * `app.kubernetes.io/component:`.
 *
 * `SHAPED_DIFFERENTLY` is a service the other target does the same job for by another mechanism.
 * `KNOWN_GAPS` is a service genuinely absent; the check passes with them present and prints them on
 * every run. Both lists are checked for staleness in the other direction.
 *
 * Usage: node scripts/check-compose-chart-parity.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const problems = [];
const ok = [];
const outstanding = [];

/**
 * A Compose service name and the chart component that is the same thing under another name.
 * Recorded rather than renamed because a chart component name is in the labels of a running cluster
 * and a Compose service name is in shell history.
 */
const ALIASES = {
  'supabase-realtime': 'realtime',
  'supabase-db-init': 'db-init',
  'supabase-db-roles-init': 'db-roles-init',
  'supabase-storage-init': 'storage-init',
  'supabase-storage-policies': 'storage-policies'
};

/** Compose services the chart deliberately does not have a workload for. */
const SHAPED_DIFFERENTLY = {
  'supabase-envoy-init': 'the chart substitutes envoy.yaml in an initContainer on the supabase-envoy pod rather than in a separate one-shot service',
  'mosquitto-tls-init': 'an initContainer on the mosquitto pod; the chart also has cert-manager available, which Compose does not',
  'mosquitto-init': 'an initContainer on the mosquitto pod, so the password file is written into the same volume that pod mounts',
  'gitea-init': 'an initContainer on the gitea pod, so the administrator is created against the same volume that pod mounts -- the same arrangement as mosquitto-init',
  'node-red-init': 'an initContainer on the node-red pod -- see sync-helm-chart-files.mjs, which mirrors node-red-init.mjs for exactly that use',
  'prometheus': 'Kubernetes uses the Prometheus Operator: the chart ships ServiceMonitors and expects a cluster Prometheus rather than running its own',
  'node-exporter': 'node metrics are the cluster operator\'s concern on Kubernetes, and a DaemonSet here would collide with whatever is already scraping nodes'
};

/** Chart components with no Compose service. */
const CHART_ONLY = {
  'supabase-kong': 'both targets run Envoy; the chart keeps its Kong template off (supabaseKong.enabled=false) as the revert path, so the component exists in the chart and nowhere on Compose',
  'backup': 'the chart\'s tier-1 backup CronJob. Compose does the same job with scripts/backup-databases.sh on the host, which is a script rather than a service',
  'e2e-validate': 'a Helm test Job wrapping validate.py. On Compose CI runs the script directly, so there is nothing to declare as a service',
  'e2e-aas-export': 'a Helm test Job, for the same reason as e2e-validate',
  'test-fdw': 'a Helm test Job asserting the postgres_fdw cross-database path, which Compose exercises from validate.py'
};

/**
 * Genuinely absent, with the reason and where it is tracked. Not silent: these print on every run.
 */
const KNOWN_GAPS = {
  'cold-archiver': 'cold telemetry archival ships on Compose only. The chart applies cold_archive.sql so the manifest exists and db-init succeeds, but no workload exports or drops -- the catalogue is permanently empty on Kubernetes. See supabase/README.md "Cold telemetry archival"',
  'loki': 'the log store ships on Compose only, by the same decision that gives the chart no Prometheus: Compose owns its whole observability stack, a cluster is assumed to have one already, and a second store would duplicate every line and give an operator two places to configure retention. The chart provisions the DATASOURCE either way, pointed at `grafana.lokiUrl`. See the divergence table in deploy/k8s/README.md',
  'alloy': 'the log collector, absent for the same reason as loki. On Kubernetes the equivalent is a DaemonSet reading /var/log/pods, which the cluster log stack already runs -- and which needs no socket proxy, because the kubelet supplies the pod and container labels this has to ask Docker for',
  'docker-socket-proxy': 'exists only to narrow the Docker API for alloy, so it is absent wherever alloy is. It has no Kubernetes analogue at all: there is no Docker socket to front, and pod metadata comes from the kubelet rather than from a container runtime API'
};

// The Compose side. Parsed by shape rather than with a YAML dependency, matching
// check-docs-drift.mjs. Bounded to the `services:` block, because `volumes:` uses the same mapping
// shape.
const composeServices = new Set();
{
  let inServices = false;
  for (const line of read('docker-compose.yml').split('\n')) {
    if (/^services:\s*$/.test(line)) { inServices = true; continue; }
    if (inServices && /^\S/.test(line)) break;
    const m = line.match(/^ {2}([a-z0-9][a-z0-9._-]*):\s*$/);
    if (inServices && m) composeServices.add(m[1]);
  }
}

// The chart side.
const chartComponents = new Set();
{
  const walk = (dir) => {
    for (const entry of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${entry}`;
      if (statSync(join(ROOT, rel)).isDirectory()) { walk(rel); continue; }
      if (!/\.(yaml|tpl)$/.test(entry)) continue;
      const body = read(rel);
      for (const [, name] of body.matchAll(/\$component\s*:=\s*"([a-z0-9-]+)"/g)) chartComponents.add(name);
      for (const [, name] of body.matchAll(/^\s*app\.kubernetes\.io\/component:\s*([a-z0-9-]+)\s*$/gm)) {
        chartComponents.add(name);
      }
    }
  };
  walk('deploy/helm/acs-cymru/templates');
}

if (composeServices.size === 0 || chartComponents.size === 0) {
  console.error(
    'parity check could not parse one side: ' +
      `${composeServices.size} compose service(s), ${chartComponents.size} chart component(s). ` +
      'The file shape changed, so this check is no longer checking anything.'
  );
  process.exit(1);
}

const asComponent = (service) => ALIASES[service] || service;

// 1. Compose -> chart.
{
  const unaccounted = [];
  for (const service of composeServices) {
    if (chartComponents.has(asComponent(service))) continue;
    if (SHAPED_DIFFERENTLY[service] || KNOWN_GAPS[service]) continue;
    unaccounted.push(service);
  }
  if (unaccounted.length) {
    problems.push(
      `Compose runs ${unaccounted.map((s) => `\`${s}\``).join(', ')} and the chart has no workload for ` +
        `${unaccounted.length === 1 ? 'it' : 'them'}.\n` +
        '    If the chart does the same job another way, add it to SHAPED_DIFFERENTLY with the\n' +
        '    mechanism. If it is genuinely absent, add it to KNOWN_GAPS with where it is tracked --\n' +
        '    that is not a way of silencing this, it is printed on every run.'
    );
  } else {
    ok.push(`all ${composeServices.size} Compose services are accounted for on the chart`);
  }
}

// 2. Chart -> Compose, the direction that catches a workload nobody can run locally.
{
  const composeAsComponents = new Set([...composeServices].map(asComponent));
  const unaccounted = [...chartComponents].filter(
    (c) => !composeAsComponents.has(c) && !CHART_ONLY[c]
  );
  if (unaccounted.length) {
    problems.push(
      `the chart deploys ${unaccounted.map((c) => `\`${c}\``).join(', ')} and Compose has no service for ` +
        `${unaccounted.length === 1 ? 'it' : 'them'}.\n` +
        '    A workload only Kubernetes runs cannot be exercised by anybody developing locally, and\n' +
        '    the e2e Compose job never sees it. Add a Compose service, or list it in CHART_ONLY.'
    );
  } else {
    ok.push(`all ${chartComponents.size} chart components are accounted for on Compose`);
  }
}

// 3. The lists themselves, in the other direction: an exemption that has stopped describing a real
// difference fails.
{
  const stale = [];
  for (const service of [...Object.keys(SHAPED_DIFFERENTLY), ...Object.keys(KNOWN_GAPS)]) {
    if (!composeServices.has(service)) {
      stale.push(`${service} (listed as a Compose service, and Compose has no such service)`);
    } else if (chartComponents.has(asComponent(service))) {
      stale.push(`${service} (listed as absent from the chart, and the chart now deploys it)`);
    }
  }
  for (const component of Object.keys(CHART_ONLY)) {
    if (!chartComponents.has(component)) {
      stale.push(`${component} (listed as a chart component, and the chart has no such component)`);
    } else if ([...composeServices].map(asComponent).includes(component)) {
      stale.push(`${component} (listed as chart-only, and Compose now runs it)`);
    }
  }
  for (const service of Object.keys(ALIASES)) {
    if (!composeServices.has(service)) stale.push(`alias ${service} (no such Compose service)`);
  }

  if (stale.length) {
    problems.push(`these entries no longer describe a real difference:\n    ${stale.join('\n    ')}`);
  } else {
    ok.push(
      `all ${Object.keys(SHAPED_DIFFERENTLY).length + Object.keys(CHART_ONLY).length + Object.keys(KNOWN_GAPS).length} ` +
        'recorded differences still describe a real one'
    );
  }
}

// 4. The gaps, stated every time.
for (const [service, why] of Object.entries(KNOWN_GAPS)) {
  outstanding.push(`${service}: ${why}`);
}

for (const line of ok) console.log(`  ok    ${line}`);

if (outstanding.length) {
  console.log('');
  console.log(`  OUTSTANDING -- ${outstanding.length} service(s) run on Compose and nowhere on Kubernetes:`);
  for (const line of outstanding) console.log(`    ${line}`);
}

if (problems.length) {
  console.error('\nCompose and the chart have diverged:');
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    '\nSix defects in one branch had this shape: work landed on Compose and the chart did not\n' +
      'follow. Three were caught by other guards; three were found by installing the chart and\n' +
      'watching a pod crash. This is the check that compares the two as sets.'
  );
  process.exit(1);
}

console.log(
  `\nCompose and the chart agree: ${composeServices.size} services, ${chartComponents.size} components, ` +
    `${outstanding.length} known gap(s).`
);
