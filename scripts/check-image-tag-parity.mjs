#!/usr/bin/env node
/**
 * Assert that docker-compose.yml and the Helm chart pin the same tag for every shared image.
 * Several pins hold a coupling between components (realtime and storage-api migrate shared schemas
 * on boot, studio is coupled to postgres-meta, node-red's settings.js depends on release internals,
 * postgres ships the extension set), and two targets on different tags break those couplings
 * asymmetrically, days later, on whichever target is bumped second.
 *
 * Usage: node scripts/check-image-tag-parity.mjs [--verbose]. No YAML dependency: this runs in CI
 * before any `npm install`. Compose uses `image: repo:tag`; the chart uses a `repository:`/`tag:`
 * pair under an `image:` key.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE = join(REPO_ROOT, 'docker-compose.yml');
const VALUES = join(REPO_ROOT, 'deploy', 'helm', 'acs-cymru', 'values.yaml');

const verbose = process.argv.includes('--verbose');

/**
 * The registry namespace the built images are published under, by .github/workflows/release.yml.
 * Lowercase because OCI reference names are case-sensitive and must be lowercase.
 */
const IMAGE_NAMESPACE = 'ghcr.io/harri-llewelyn/acs-cymru';

/**
 * Images built from this repository rather than pulled. They have no tag in docker-compose (Compose
 * uses `build:`), so their absence there is not drift; their published tag is checked in the
 * release-surface section below. In values.yaml their tag is deliberately empty, resolved to
 * Chart.AppVersion by the `acs-cymru.image` helper.
 */
const BUILT_IMAGES = [
  'edge-runtime', 'ingestion', 'node-red', 'frontend', 'test-runner', 'i3x-service',
  // Built FROM eclipse-mosquitto so it carries the broker's own mosquitto_passwd, which makes its
  // base subject to the same pin as the broker's.
  'gateway-credential',
  // Built FROM supabase/postgres for a pg_dump at least the server's version; its base is coupled
  // to the supabase-db tag below.
  'backup-service',
  // supabase/postgres with supabase/migrations/*.sql copied in, because the chain cannot reach a
  // cluster through the chart (a ConfigMap and Helm's release Secret are capped at 1 MiB). Its tag
  // is the schema version, and pinning an older one is a database rollback, which is why it is
  // listed here rather than pinned in values.yaml.
  'db-init',
];
const LOCALLY_BUILT = new Set(BUILT_IMAGES.map((n) => `${IMAGE_NAMESPACE}/${n}`));

/**
 * Images one target legitimately uses and the other does not. Each needs a reason, so adding a name
 * here is a decision rather than a way to silence the check.
 */
const TARGET_SPECIFIC = new Map([
  [
    'alpine',
    'Compose: supabase-envoy-init, which substitutes the API keys and the CORS origins into ' +
      'envoy.yaml. Kubernetes: the same work is an initContainer on the gateway Deployment, using ' +
      'the gateway image rather than a second one.',
  ],
  [
    'kong',
    'KUBERNETES ONLY, AND ONLY WHEN ASKED FOR. Envoy is the gateway on Compose, so Kong is gone ' +
      'from docker-compose.yml entirely -- but the chart keeps it ' +
      'behind `supabaseKong.enabled` so a cluster can roll back to the gateway it was installed ' +
      'with, and _helpers.tpl fails the render if both are enabled under one Service name. ' +
      'Retiring the pin means deleting that rollback, which is a separate decision from ' +
      'promoting Envoy and should be taken separately. Recorded here rather than left to fail: ' +
      'the parity check went red the moment Kong left Compose, and with CI minutes exhausted ' +
      'until September 2026 nothing said so.',
  ],
  ['node', 'Compose: supabase-storage-init / node-red-init. Kubernetes: node:20-alpine, pinned inline in the Job.'],
  ['busybox', 'Kubernetes only: the wait-for initContainers.'],
  ['curlimages/curl', 'Kubernetes only: readiness waits that need an HTTP client.'],
  [
    'bitnamilegacy/kubectl',
    'Kubernetes only: the AAS Job waits on the validate Job. `bitnamilegacy` rather than ' +
      '`bitnami` because Bitnami withdrew its tagged Docker Hub catalogue -- every semver tag on ' +
      'bitnami/kubectl now 404s and only `latest` and digests remain, so the old pin stopped ' +
      'resolving with nothing here having changed. See the initContainer for why this is a ' +
      'stopgap.',
  ],
  [
    'sapcc/mosquitto-exporter',
    'Kubernetes only: the broker metrics sidecar. Mosquitto publishes its statistics to $SYS MQTT ' +
      'topics and has no HTTP endpoint, so scraping it needs a translator. This used to say there ' +
      'was nothing on the Compose path to scrape INTO, which stopped being true when Prometheus ' +
      'was added there -- so it is now a gap rather than a decision, and prometheus/prometheus.yml ' +
      'records it as a follow-up rather than pretending otherwise.',
  ],
  [
    'prom/prometheus',
    'Compose only: the metrics store. Kubernetes defers to the cluster\'s own Operator-managed ' +
      'Prometheus and ships ServiceMonitors instead -- a second one in the chart would duplicate ' +
      'every series and give an operator two places to configure retention.',
  ],
  [
    'prom/node-exporter',
    'Compose only, for the same reason: a cluster running the Prometheus Operator already collects ' +
      'node metrics from every node through its own DaemonSet, and this would be a second, ' +
      'partial copy of that. On Compose the host IS the deployment -- typically a Debian VM under ' +
      'Proxmox -- and nothing else is watching its disk.',
  ],
]);

/** repo -> tag, from `image: repo:tag` lines in docker-compose.yml. */
function composeImages() {
  const out = new Map();
  for (const raw of readFileSync(COMPOSE, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#')) continue;
    const m = line.match(/^image:\s*["']?([^"'\s]+)["']?/);
    if (!m) continue;
    const ref = m[1];
    // Skip anything interpolated -- `${VAR}` is not a pin and cannot be compared.
    if (ref.includes('${')) continue;
    const idx = ref.lastIndexOf(':');
    // No colon, or the colon belongs to a registry port (`host:5000/img`), means no tag: `latest`.
    const hasTag = idx > ref.lastIndexOf('/');
    const repo = hasTag ? ref.slice(0, idx) : ref;
    const tag = hasTag ? ref.slice(idx + 1) : 'latest';
    out.set(repo, tag);
  }
  return out;
}

/**
 * repo -> tag, from the chart's values. Matched as a `repository:`/`tag:` pair on proximity, which
 * is robust to the nesting depth changing.
 */
function chartImages() {
  const out = new Map();
  const lines = readFileSync(VALUES, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const repoMatch = lines[i].match(/^\s*repository:\s*["']?([^"'\s#]+)["']?/);
    if (!repoMatch) continue;
    // The tag is within the next few lines; comments between them are normal in this file.
    for (let j = i + 1; j < Math.min(i + 12, lines.length); j += 1) {
      if (/^\s*repository:/.test(lines[j])) break;
      // An empty tag (`tag: ""`) must be captured as '' rather than skipped: it is how the built
      // images say "resolve me to Chart.AppVersion", and dropping those entries would remove them
      // from the comparison.
      const tagMatch = lines[j].match(/^\s*tag:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*(?:#.*)?$/);
      if (tagMatch) {
        out.set(repoMatch[1], tagMatch[1] ?? tagMatch[2] ?? tagMatch[3] ?? '');
        break;
      }
    }
  }
  return out;
}

/**
 * A locally built image whose base is pinned by Compose too. `supabase/functions/Dockerfile` builds
 * `FROM supabase/edge-runtime:<tag>` and docker-compose runs that base directly, so the tag appears
 * in two places the repository-level comparison cannot see; bumped in one, the two targets run
 * different runtimes against identical function code.
 */
const BASE_IMAGE_COUPLINGS = [
  {
    dockerfile: join('supabase', 'functions', 'Dockerfile'),
    base: 'supabase/edge-runtime',
    why: 'Compose runs this image directly; the chart bakes the functions into an image built FROM it.',
  },
  {
    dockerfile: join('supabase', 'db-init', 'Dockerfile'),
    base: 'supabase/postgres',
    // The same shape one layer deeper: Compose applies the migrations with the psql inside
    // supabase/postgres, and this image bakes them into a copy of it. Drift means identical SQL
    // parsed by different psql clients.
    why: 'Compose runs this image directly (supabase-db, supabase-db-init); the chart bakes the migrations into an image built FROM it.',
  },
  {
    dockerfile: join('backup-service', 'Dockerfile'),
    base: 'supabase/postgres',
    // pg_dump must be at least the server's version, so the service is built from the server's
    // image; a drift here is a dumping client older than the database it dumps.
    why: 'Compose runs this image directly (supabase-db); the backup service is built FROM it for its pg_dump.',
  },
  {
    dockerfile: join('gateway-credential', 'Dockerfile'),
    base: 'eclipse-mosquitto',
    // The hash mosquitto_passwd writes is verified by the broker, and mosquitto_rr speaks to the
    // broker's plugin; both come from this image so they cannot disagree with the broker.
    why: 'Compose runs this image directly (mosquitto); the credential service and the boot reconcile are built FROM it for its mosquitto_passwd and mosquitto_rr.',
  },
];

/** repo -> tag, from the FROM lines of a Dockerfile. ARG-parameterised bases are skipped. */
function dockerfileBases(relPath) {
  const out = new Map();
  for (const raw of readFileSync(join(REPO_ROOT, relPath), 'utf8').split('\n')) {
    const m = raw.trim().match(/^FROM\s+([^\s]+)/i);
    if (!m) continue;
    const ref = m[1];
    if (ref.includes('${')) continue;
    const idx = ref.lastIndexOf(':');
    const hasTag = idx > ref.lastIndexOf('/');
    out.set(hasTag ? ref.slice(0, idx) : ref, hasTag ? ref.slice(idx + 1) : 'latest');
  }
  return out;
}

const compose = composeImages();
const chart = chartImages();

const mismatches = [];
const onlyCompose = [];
const onlyChart = [];

for (const [repo, chartTag] of chart) {
  if (LOCALLY_BUILT.has(repo)) continue;
  // TARGET_SPECIFIC applies in both directions: which target an entry's image belongs to varies
  // (`alpine` is Compose-only, the kubectl and mosquitto exporter images Kubernetes-only).
  if (TARGET_SPECIFIC.has(repo)) continue;
  if (!compose.has(repo)) {
    onlyChart.push(`${repo}:${chartTag}`);
    continue;
  }
  const composeTag = compose.get(repo);
  if (composeTag !== chartTag) {
    mismatches.push({ repo, composeTag, chartTag });
  }
}

for (const [repo, composeTag] of compose) {
  if (chart.has(repo) || TARGET_SPECIFIC.has(repo)) continue;
  onlyCompose.push(`${repo}:${composeTag}`);
}

// Bases pinned in a Dockerfile AND run directly by Compose -- invisible to the comparison above.
const baseIssues = [];
for (const { dockerfile, base, why } of BASE_IMAGE_COUPLINGS) {
  const bases = dockerfileBases(dockerfile);
  const dockerTag = bases.get(base);
  const composeTag = compose.get(base);
  if (!dockerTag) {
    baseIssues.push(`${dockerfile} no longer builds FROM ${base} -- update BASE_IMAGE_COUPLINGS.`);
    continue;
  }
  if (!composeTag) {
    baseIssues.push(`docker-compose.yml no longer pins ${base} -- update BASE_IMAGE_COUPLINGS.`);
    continue;
  }
  if (dockerTag !== composeTag) {
    baseIssues.push(
      `${base}: ${dockerfile} builds FROM :${dockerTag} but docker-compose.yml runs :${composeTag}.\n` +
        `    ${why}`
    );
  } else {
    console.log(`  ok   ${base}:${dockerTag}  (base of ${dockerfile})`);
  }
  // Remove from the "compose only" noise -- it IS compared, just not by repository name.
  const i = onlyCompose.indexOf(`${base}:${composeTag}`);
  if (i !== -1) onlyCompose.splice(i, 1);
}

const shared = [...chart.keys()].filter((r) => !LOCALLY_BUILT.has(r) && compose.has(r));
for (const repo of shared.sort()) {
  const tag = chart.get(repo);
  const ok = compose.get(repo) === tag;
  console.log(`  ${ok ? 'ok  ' : 'MISMATCH'} ${repo}:${tag}`);
}

if (verbose) {
  if (onlyChart.length) {
    console.log(`\n  chart only: ${onlyChart.join(', ')}`);
  }
  if (onlyCompose.length) {
    console.log(`\n  compose only: ${onlyCompose.join(', ')}`);
  }
}

let failed = false;

if (baseIssues.length) {
  failed = true;
  console.error('\nBase-image coupling FAILED:\n');
  for (const issue of baseIssues) console.error(`  ${issue}`);
  console.error(
    '\nThe two targets would run different runtimes against identical function code. Bump both.\n'
  );
}

if (mismatches.length) {
  failed = true;
  console.error('\nImage tag parity FAILED:\n');
  for (const { repo, composeTag, chartTag } of mismatches) {
    console.error(`  ${repo}`);
    console.error(`    docker-compose.yml : ${composeTag}`);
    console.error(`    chart values.yaml  : ${chartTag}`);
  }
  console.error(
    '\nSeveral of these pins hold a COUPLING, not a preference -- supabase/realtime and\n' +
      'supabase/storage-api migrate shared schemas on boot, supabase/studio is Zod-coupled to a\n' +
      'postgres-meta version, and nodered/node-red:5.0.2 is what settings.js depends on. Two targets\n' +
      'on different tags break exactly those couplings, and asymmetrically: the failure shows up on\n' +
      'whichever target was bumped second and looks like that target\'s fault.\n' +
      '\nBump both, or record the divergence in TARGET_SPECIFIC with a reason.\n'
  );
}

/**
 * An image the chart pins and Compose does not know about is drift in the other direction: a
 * service added to Kubernetes and never added to Compose.
 */
if (onlyChart.length) {
  failed = true;
  console.error(`\nPinned by the chart but absent from docker-compose.yml:\n`);
  for (const ref of onlyChart) console.error(`  ${ref}`);
  console.error(
    '\nEither add the service to docker-compose.yml, add its repository to LOCALLY_BUILT if it is\n' +
      'built from this repository, or record it in TARGET_SPECIFIC with a reason.\n'
  );
}

/* The release surface. The four places that must agree about the images this repository builds and
   publishes: values.yaml (what the chart tells a cluster to pull), release.yml (what gets pushed to
   GHCR), ci.yml (what k8s-validation builds and imports into k3d), and test-harness/Dockerfile
   (which ingestion image the conformance runner extends). Each disagreement fails quietly: a chart
   naming an unpushed image installs into ImagePullBackOff, a CI build of the wrong reference falls
   through to pulling the last release, and a drifted ARG default extends a different ingestion
   image. release.yml's matrix is templated, so what is read is its literal `for img in ...`
   verification lists. */
const RELEASE_WF = join(REPO_ROOT, '.github', 'workflows', 'release.yml');
const CI_WF = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
const CHART_YAML = join(REPO_ROOT, 'deploy', 'helm', 'acs-cymru', 'Chart.yaml');
const TESTS_DOCKERFILE = join(REPO_ROOT, 'test-harness', 'Dockerfile');

const releaseIssues = [];
const expected = [...BUILT_IMAGES].sort();
const fmt = (names) => (names.length ? names.join(', ') : '(none)');

/** The chart's appVersion -- the tag every built image resolves to. */
const chartYaml = readFileSync(CHART_YAML, 'utf8');
const appVersionMatch = chartYaml.match(/^appVersion:\s*["']?([^"'\s#]+)["']?/m);
const appVersion = appVersionMatch ? appVersionMatch[1] : null;
if (!appVersion) {
  releaseIssues.push('Chart.yaml has no readable appVersion -- every built image resolves to it.');
}

// 1. values.yaml: the built images are exactly those whose tag is empty.
const emptyTagged = [...chart.entries()]
  .filter(([, tag]) => tag === '')
  .map(([repo]) => repo)
  .sort();
const expectedRefs = expected.map((n) => `${IMAGE_NAMESPACE}/${n}`).sort();
if (emptyTagged.join('|') !== expectedRefs.join('|')) {
  releaseIssues.push(
    'values.yaml images with an empty tag do not match the published set.\n' +
      `    values.yaml : ${fmt(emptyTagged)}\n` +
      `    expected    : ${fmt(expectedRefs)}\n` +
      '    An empty tag means "resolve to Chart.AppVersion", so it marks exactly the images this\n' +
      '    repository builds. A third-party image must keep its explicit pin -- several of them\n' +
      '    carry a schema migration or a version coupling and must not float onto our appVersion.'
  );
}

// 2. release.yml: the literal verification lists, and the namespace it pushes to.
const releaseSrc = readFileSync(RELEASE_WF, 'utf8');
const nsMatch = releaseSrc.match(/^\s*IMAGE_NAMESPACE:\s*(\S+)/m);
if (!nsMatch) {
  releaseIssues.push('release.yml declares no IMAGE_NAMESPACE.');
} else if (nsMatch[1] !== IMAGE_NAMESPACE) {
  releaseIssues.push(
    `release.yml pushes to ${nsMatch[1]} but the chart and this script expect ${IMAGE_NAMESPACE}.`
  );
}
// What release.yml builds, as opposed to what its verification lists claim: the independent images
// ride a matrix, while ingestion and test-runner share a runner. An image dropped from the list but
// left in the build publishes something nothing checks, and one in neither leaves the chart naming
// a tag that does not exist.
const matrixBuilt = [...releaseSrc.matchAll(/^\s+- name:\s*([a-z0-9-]+)\s*\n\s+dockerfile:/gm)].map(
  (m) => m[1]
);
const scriptBuilt = [...releaseSrc.matchAll(/-t\s+"\$IMAGE_NAMESPACE\/([a-z0-9-]+):\$V"/g)].map(
  (m) => m[1]
);
const actuallyBuilt = [...new Set([...matrixBuilt, ...scriptBuilt])].sort();
if (actuallyBuilt.join('|') !== expected.join('|')) {
  releaseIssues.push(
    'release.yml does not build the published set of images.\n' +
      `    matrix        : ${fmt(matrixBuilt.sort())}\n` +
      `    shared runner : ${fmt(scriptBuilt.sort())}\n` +
      `    expected      : ${fmt(expected)}`
  );
}

const forLists = [...releaseSrc.matchAll(/for img in ([a-z0-9 -]+);\s*do/g)].map((m) =>
  m[1].trim().split(/\s+/).sort()
);
if (!forLists.length) {
  releaseIssues.push(
    'release.yml has no `for img in ...` list -- the verification and summary steps are what this\n' +
      '    check reads to learn which images a release actually publishes.'
  );
}
forLists.forEach((list, i) => {
  if (list.join('|') !== expected.join('|')) {
    releaseIssues.push(
      `release.yml image list #${i + 1} does not match the published set.\n` +
        `    release.yml : ${fmt(list)}\n` +
        `    expected    : ${fmt(expected)}`
    );
  }
});

// 3. ci.yml: what k8s-validation builds and imports, under the same namespace and appVersion.
const ciSrc = readFileSync(CI_WF, 'utf8');
// IMG_NS, not NS: the k8s-validation job already uses NS for the Kubernetes namespace, and reading
// that one instead compares the chart's registry namespace against the string "acs-cymru".
const ciNs = ciSrc.match(/^\s*IMG_NS:\s*(\S+)/m);
if (!ciNs) {
  releaseIssues.push('ci.yml no longer declares an IMG_NS for the local image builds.');
} else if (ciNs[1] !== IMAGE_NAMESPACE) {
  releaseIssues.push(
    `ci.yml builds under ${ciNs[1]} but the chart resolves ${IMAGE_NAMESPACE}. The pods would not\n` +
      '    find the imported images and would fall through to pulling the published ones, so the\n' +
      '    job would stop testing this working tree without failing.'
  );
}
const ciBuilt = [...ciSrc.matchAll(/-t\s+"\$IMG_NS\/([a-z0-9-]+):\$V"/g)].map((m) => m[1]).sort();
if (ciBuilt.join('|') !== expected.join('|')) {
  releaseIssues.push(
    'ci.yml does not build the published set of images.\n' +
      `    ci.yml   : ${fmt(ciBuilt)}\n` +
      `    expected : ${fmt(expected)}`
  );
}

// Every image reference in those steps must interpolate IMG_NS. Checked separately from the `-t`
// list because the test-runner's `--build-arg INGESTION_IMAGE=...` is a different shape, and once
// read $NS, the Kubernetes namespace.
for (const stray of ciSrc.matchAll(/(INGESTION_IMAGE=|[-]t\s+")\$NS\//g)) {
  releaseIssues.push(
    `ci.yml has an image reference using $NS rather than $IMG_NS: "${stray[0]}".\n` +
      '    $NS is the Kubernetes namespace in that job, not the registry namespace.'
  );
}

// 4. test-harness/Dockerfile: the ARG default names a published image at the chart's appVersion.
const testsSrc = readFileSync(TESTS_DOCKERFILE, 'utf8');
const argMatch = testsSrc.match(/^ARG\s+INGESTION_IMAGE=(\S+)/m);
if (!argMatch) {
  releaseIssues.push('test-harness/Dockerfile no longer declares ARG INGESTION_IMAGE.');
} else {
  const wanted = `${IMAGE_NAMESPACE}/ingestion:${appVersion}`;
  if (argMatch[1] !== wanted) {
    releaseIssues.push(
      `test-harness/Dockerfile defaults INGESTION_IMAGE to ${argMatch[1]}, expected ${wanted}.\n` +
        "    CI and release.yml both pass this explicitly, so the default only bites a bare\n" +
        '    `docker build` -- which is exactly when nobody is watching for it.'
    );
  }
}

if (releaseIssues.length) {
  failed = true;
  console.error('\nRelease surface FAILED:\n');
  for (const issue of releaseIssues) console.error(`  ${issue}\n`);
  console.error(
    'values.yaml, release.yml, ci.yml and test-harness/Dockerfile must agree on which images this\n' +
      'repository publishes, under which namespace, at which version. None of these disagreements\n' +
      'produces a failed install -- they produce a stack that comes up two thirds healthy.\n'
  );
}

if (failed) process.exit(1);

console.log(`\nImage tags agree across both targets (${shared.length} shared image(s)).`);
console.log(
  `Release surface agrees: ${expected.length} built image(s) under ${IMAGE_NAMESPACE}, ` +
    `tagged ${appVersion} by the chart.`
);
