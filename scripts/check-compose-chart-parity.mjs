/**
 * Every Compose service has a chart workload, and every chart workload has a Compose service --
 * or is listed here with the reason it does not.
 *
 * =================================================================================================
 * WHY THIS EXISTS, WHICH IS SIX FAILURES AND NOT A HYPOTHESIS
 *
 * When CI came back after the August 2026 billing outage, `main` was red and every failure had the
 * same shape: work landed on Compose and the chart did not follow. In one branch:
 *
 *   1. four chart file copies stale since cold archival merged  -- caught by sync-helm-chart-files
 *   2. `values-dev.yaml` missing the two historian secrets      -- caught by validateSecrets
 *   3. `cold_archive.sql` never added to the mirror allow-list  -- db-init FAILED on Kubernetes
 *   4. the storage ceiling never split from the model limit     -- storage-init FAILED
 *   5. the two machine-principal keys left empty                -- ingestion CrashLoopBackOff
 *   6. METRICS_JWT_SECRET carried in the Secret, never passed   -- realtime CrashLoopBackOff
 *
 * Three of those six were caught by an existing guard. The other three were found by installing the
 * chart, ten minutes at a time, one pod per CI round. Nothing compared the two targets as SETS.
 *
 * THIS DOES NOT CATCH ALL SIX. It catches the class the others miss: a service that exists on one
 * target and nowhere on the other. `cold-archiver` is the standing example -- it ships
 * on Compose, the chart has no workload for it, and the only reason anybody noticed is that
 * `0068`'s self-check made db-init fail loudly. A subsystem that failed QUIETLY would still be
 * undiscovered.
 *
 * =================================================================================================
 * WHY IT PARSES TEMPLATES RATHER THAN RENDERING THE CHART
 *
 * `helm template` is the accurate answer and the wrong one here. Half these workloads are behind an
 * `enabled` flag -- `playback` is off by default deliberately, `supabase-envoy` is off until the
 * Kong migration finishes -- so a render answers "what does THIS values file switch on", and the
 * question is "what does the chart KNOW HOW TO DEPLOY". A render would report `playback` as missing
 * from the chart, which is false, and would need helm on the path for a check that is otherwise a
 * string comparison.
 *
 * TWO IDIOMS, because the chart uses both. Most templates declare `{{- $component := "name" -}}` and
 * build their labels from it; `messaging/gateway-credential.yaml` writes
 * `app.kubernetes.io/component:` literally. Reading only the first misses it, and a check that
 * silently missed a workload would be worse than none -- it would certify a parity it had not
 * examined.
 *
 * =================================================================================================
 * TWO KINDS OF DIFFERENCE, AND CONFLATING THEM IS THE FAILURE MODE
 *
 * `SHAPED_DIFFERENTLY` is a service the other target does the same job for by another mechanism: an
 * initContainer instead of a one-shot container, the Prometheus Operator instead of a Prometheus
 * pod. Those are decisions, they are permanent, and listing them costs one line.
 *
 * `KNOWN_GAPS` is a service that is genuinely absent. Those are NOT exemptions in the ordinary
 * sense: the check passes with them present, and PRINTS THEM ON EVERY RUN, because the failure this
 * guard exists to prevent is a gap nobody is looking at. A gap silently reclassified as a design
 * difference is this check lying, which is worse than not having it.
 *
 * Both lists are checked for staleness in the other direction: an entry that no longer describes a
 * real difference fails, so a gap that gets closed cannot leave its excuse behind.
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
 *
 * SHORT AND IT SHOULD STAY SHORT. Every entry is a place the two targets disagree about what to
 * call one workload, and each one is a small tax on anybody reading both. They are recorded rather
 * than renamed because a chart component name is in the labels of a running cluster and a Compose
 * service name is in every `docker compose` command anybody has in their shell history.
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
  'node-red-init': 'an initContainer on the node-red pod -- see sync-helm-chart-files.mjs, which mirrors node-red-init.mjs for exactly that use',
  'prometheus': 'Kubernetes uses the Prometheus Operator: the chart ships ServiceMonitors and expects a cluster Prometheus rather than running its own',
  'node-exporter': 'node metrics are the cluster operator\'s concern on Kubernetes, and a DaemonSet here would collide with whatever is already scraping nodes'
};

/** Chart components with no Compose service. */
const CHART_ONLY = {
  'supabase-kong': 'Compose migrated to Envoy; the chart still deploys Kong by default until its Envoy templates are fully verified. This entry retires with that migration',
  'backup': 'the chart\'s tier-1 backup CronJob. Compose does the same job with scripts/backup-databases.sh on the host, which is a script rather than a service',
  'e2e-validate': 'a Helm test Job wrapping validate.py. On Compose CI runs the script directly, so there is nothing to declare as a service',
  'e2e-aas-export': 'a Helm test Job, for the same reason as e2e-validate',
  'test-fdw': 'a Helm test Job asserting the postgres_fdw cross-database path, which Compose exercises from validate.py'
};

/**
 * Genuinely absent, with the reason and where it is tracked.
 *
 * NOT SILENT. These print on every run. An entry here is a promise that somebody knows, not
 * permission to stop noticing.
 */
const KNOWN_GAPS = {
  'cold-archiver': 'cold telemetry archival ships on Compose only. The chart applies cold_archive.sql so the manifest exists and db-init succeeds, but no workload exports or drops -- the catalogue is permanently empty on Kubernetes. See supabase/README.md "Cold telemetry archival"',
  'loki': 'the log store ships on Compose only, by the same decision that gives the chart no Prometheus: Compose owns its whole observability stack, a cluster is assumed to have one already, and a second store would duplicate every line and give an operator two places to configure retention. The chart provisions the DATASOURCE either way, pointed at `grafana.lokiUrl`. See docs/roadmap.md 13',
  'alloy': 'the log collector, absent for the same reason as loki. On Kubernetes the equivalent is a DaemonSet reading /var/log/pods, which the cluster log stack already runs -- and which needs no socket proxy, because the kubelet supplies the pod and container labels this has to ask Docker for',
  'docker-socket-proxy': 'exists only to narrow the Docker API for alloy, so it is absent wherever alloy is. It has no Kubernetes analogue at all: there is no Docker socket to front, and pod metadata comes from the kubelet rather than from a container runtime API'
};

// -------------------------------------------------------------------------------------------------
// The Compose side.
//
// Parsed by SHAPE rather than with a YAML dependency, matching check-docs-drift.mjs -- this
// repository deliberately carries none for its guards. Bounded to the `services:` block, because
// `volumes:` uses the same two-space mapping shape and would otherwise arrive as a dozen services
// the chart is obviously missing.
// -------------------------------------------------------------------------------------------------
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

// -------------------------------------------------------------------------------------------------
// The chart side.
// -------------------------------------------------------------------------------------------------
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

// -------------------------------------------------------------------------------------------------
// 1. Compose -> chart.
// -------------------------------------------------------------------------------------------------
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

// -------------------------------------------------------------------------------------------------
// 2. Chart -> Compose. The direction that catches a workload nobody can run locally.
// -------------------------------------------------------------------------------------------------
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

// -------------------------------------------------------------------------------------------------
// 3. The lists themselves, in the other direction.
//
// An exemption that has stopped describing a real difference is worse than a missing one: it is a
// note explaining why something is absent, sitting next to the thing, present.
// -------------------------------------------------------------------------------------------------
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

// -------------------------------------------------------------------------------------------------
// 4. The gaps, stated every time.
// -------------------------------------------------------------------------------------------------
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
