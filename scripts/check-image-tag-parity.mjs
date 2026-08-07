#!/usr/bin/env node
/**
 * Assert that docker-compose.yml and the Helm chart pin the SAME tag for every shared image.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. Several pins in this stack carry a paragraph of reasoning,
 * and every one of them is about a COUPLING between components:
 *
 *   supabase/realtime      migrates the shared `_realtime` schema on boot
 *   supabase/storage-api   migrates the shared `storage` schema on boot
 *   supabase/studio        is Zod-coupled to a specific postgres-meta version
 *   nodered/node-red       settings.js depends on three contracts internal to the release
 *   supabase/postgres      ships the extension set and role scaffolding every service assumes
 *
 * Two targets on different tags therefore break precisely the couplings those pins exist to hold --
 * and worse, they break them ASYMMETRICALLY. A schema migrated by a newer storage-api on Kubernetes
 * is then read by an older one on Compose against the same shape of database; the failure appears on
 * whichever target is bumped second, days later, and looks like that target's fault.
 *
 * Bumping an image is fine. Bumping it in one place is not.
 *
 * Usage:
 *   node scripts/check-image-tag-parity.mjs            # report and exit non-zero on a mismatch
 *   node scripts/check-image-tag-parity.mjs --verbose  # also list images present in only one target
 *
 * No YAML dependency on purpose: this must run in CI before any `npm install`, and the two shapes it
 * has to read are narrow and stable. Compose uses `image: repo:tag`; the chart uses a
 * `repository:`/`tag:` pair under an `image:` key.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE = join(REPO_ROOT, 'docker-compose.yml');
const VALUES = join(REPO_ROOT, 'deploy', 'helm', 'factoryplus', 'values.yaml');

const verbose = process.argv.includes('--verbose');

/**
 * The registry namespace the six built images are published under, by .github/workflows/release.yml.
 *
 * Lowercase because OCI reference names are case-sensitive and must be lowercase -- the GitHub
 * account is `Harri-Llewelyn`, and a reference carrying those capitals pushes without complaint and
 * then cannot be pulled by anything.
 */
const IMAGE_NAMESPACE = 'ghcr.io/harri-llewelyn/acs-cymru';

/**
 * Images built from this repository rather than pulled. They have no tag in docker-compose at all
 * (Compose uses `build:`), so there is nothing to compare against it and their absence is not drift.
 *
 * They are PUBLISHED, so their tag is not compared against Compose but is nonetheless the thing
 * most worth checking here -- see the release-surface section at the bottom of this file. In
 * values.yaml their tag is deliberately EMPTY, resolved to Chart.AppVersion by the
 * `factoryplus.image` helper.
 */
const BUILT_IMAGES = ['edge-runtime', 'ingestion', 'node-red', 'frontend', 'test-runner', 'i3x-service'];
const LOCALLY_BUILT = new Set(BUILT_IMAGES.map((n) => `${IMAGE_NAMESPACE}/${n}`));

/**
 * Images one target legitimately uses and the other does not. Each needs a REASON, so that adding a
 * name here is a decision rather than a way to silence the check.
 */
const TARGET_SPECIFIC = new Map([
  ['alpine', 'Compose: supabase-kong-init. Kubernetes: the same work is an initContainer using the Kong image.'],
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
      'topics and has no HTTP endpoint, so scraping it needs a translator -- and there is nothing ' +
      'on the Compose path to scrape INTO. Adding it there would run a permanent extra container ' +
      'serving an endpoint no one collects.',
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
 * repo -> tag, from the chart's values.
 *
 * Matched as a `repository:`/`tag:` pair rather than by tracking indentation: every image block in
 * values.yaml has that shape, and pairing on proximity is robust to the nesting depth changing.
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
      // An EMPTY tag (`tag: ""`) must be captured as '' rather than skipped. It is how the five
      // built images say "resolve me to Chart.AppVersion", and a pattern requiring at least one
      // character silently drops those entries -- which would let a built image disappear from
      // this comparison entirely, the one class of drift this file exists to catch.
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
 * A locally-built image whose BASE is pinned by Compose too.
 *
 * `supabase/functions/Dockerfile` builds the Kubernetes edge-runtime image `FROM
 * supabase/edge-runtime:<tag>`, and docker-compose runs that same base image directly (it
 * bind-mounts the functions instead of baking them). So the tag appears in two places and the
 * repository-level parity check above cannot see it: the chart pins `factoryplus/edge-runtime`, which
 * is our own tag.
 *
 * Bump one and the two targets run DIFFERENT RUNTIMES against identical function code -- which is
 * exactly the asymmetric drift this script exists to prevent, hiding in the one place a
 * repository-name comparison structurally cannot look.
 */
const BASE_IMAGE_COUPLINGS = [
  {
    dockerfile: join('supabase', 'functions', 'Dockerfile'),
    base: 'supabase/edge-runtime',
    why: 'Compose runs this image directly; the chart bakes the functions into an image built FROM it.',
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
  // TARGET_SPECIFIC applies in BOTH directions. It was originally consulted only in the
  // compose-side loop below, which was an asymmetry rather than a decision: every entry in it names
  // an image that legitimately exists on one target and not the other, and which target that is
  // varies -- `alpine` is Compose-only, `bitnamilegacy/kubectl` and the mosquitto exporter are
  // Kubernetes-only. Checking it on one side meant a Kubernetes-only image could not be declared at
  // all, only worked around.
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
 * An image the chart pins and Compose does not know about is drift in the other direction: a service
 * added to Kubernetes and never added to Compose. Reported, because the whole premise is that both
 * targets stay working.
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

/* =================================================================================================
 * THE RELEASE SURFACE.
 *
 * Everything above compares the two DEPLOYMENT targets. This compares the four places that have to
 * agree about the images this repository BUILDS AND PUBLISHES, which is a different coupling and a
 * newer one:
 *
 *   values.yaml            what the chart tells a cluster to pull
 *   release.yml            what actually gets pushed to GHCR
 *   ci.yml                 what k8s-validation builds locally and imports into k3d
 *   tests/Dockerfile       which ingestion image the conformance runner extends
 *
 * These fail QUIETLY and in different places, which is why they are worth a check rather than a
 * convention:
 *
 *   - values.yaml naming an image release.yml does not push is the worst of them. `helm install`
 *     SUCCEEDS, the databases and broker come up healthy, and the affected workloads sit in
 *     ImagePullBackOff -- there is no failed release to look at, only a partly-running stack.
 *   - ci.yml building a different reference than the chart asks for does not fail either: the pod
 *     falls through to PULLING the published image, so the job silently stops testing the working
 *     tree and starts testing whatever was last released.
 *   - tests/Dockerfile's ARG default drifting means a bare `docker build` extends a different
 *     ingestion image than the chart deploys, and the conformance suite reports on a stack it is
 *     not running beside.
 *
 * The matrix in release.yml is templated (`${{ matrix.name }}`), so what is read here is that
 * workflow's own literal `for img in ...` verification lists -- which is the right thing to read
 * anyway: those lists are what the release asserts the packaged chart references.
 * ============================================================================================= */
const RELEASE_WF = join(REPO_ROOT, '.github', 'workflows', 'release.yml');
const CI_WF = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
const CHART_YAML = join(REPO_ROOT, 'deploy', 'helm', 'factoryplus', 'Chart.yaml');
const TESTS_DOCKERFILE = join(REPO_ROOT, 'tests', 'Dockerfile');

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
// What release.yml actually BUILDS, as opposed to what its verification lists claim. Two shapes,
// because the images are built two ways for a reason: the independent ones ride a matrix, while
// ingestion and test-runner share a runner (test-runner is FROM ingestion, and a base built in a
// different job -- or on a Buildx container driver -- is not resolvable, which fails as a registry
// 403 rather than as a build-order problem).
//
// Checked separately from the `for img in` lists below because those lists are what the release
// ASSERTS it published; this is what it did. An image dropped from the build but left in the list
// fails the release loudly at the verification step, which is fine. An image dropped from the list
// but left in the build publishes something nothing checks -- and the reverse, an image in neither,
// leaves the chart naming a tag that does not exist. That is the ImagePullBackOff-with-no-failed-
// release case, so it is worth its own assertion.
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
// that one instead compares the chart's registry namespace against the string "factoryplus".
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
// list above because it is a different SHAPE and the first version of this file got it wrong: the
// test-runner's `--build-arg INGESTION_IMAGE=...` was left reading $NS, which in that job expands
// to the Kubernetes namespace -- so the build would have gone looking for `factoryplus/ingestion`,
// found nothing, and failed with a pull error naming an image nobody had ever configured.
for (const stray of ciSrc.matchAll(/(INGESTION_IMAGE=|[-]t\s+")\$NS\//g)) {
  releaseIssues.push(
    `ci.yml has an image reference using $NS rather than $IMG_NS: "${stray[0]}".\n` +
      '    $NS is the Kubernetes namespace in that job, not the registry namespace.'
  );
}

// 4. tests/Dockerfile: the ARG default names a published image at the chart's appVersion.
const testsSrc = readFileSync(TESTS_DOCKERFILE, 'utf8');
const argMatch = testsSrc.match(/^ARG\s+INGESTION_IMAGE=(\S+)/m);
if (!argMatch) {
  releaseIssues.push('tests/Dockerfile no longer declares ARG INGESTION_IMAGE.');
} else {
  const wanted = `${IMAGE_NAMESPACE}/ingestion:${appVersion}`;
  if (argMatch[1] !== wanted) {
    releaseIssues.push(
      `tests/Dockerfile defaults INGESTION_IMAGE to ${argMatch[1]}, expected ${wanted}.\n` +
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
    'values.yaml, release.yml, ci.yml and tests/Dockerfile must agree on which images this\n' +
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
