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
 * Images built from this repository rather than pulled. They have no tag in docker-compose at all
 * (Compose uses `build:`), so there is nothing to compare and their absence is not drift.
 */
const LOCALLY_BUILT = new Set([
  'factoryplus/frontend',
  'factoryplus/ingestion',
  'factoryplus/node-red',
  'factoryplus/edge-runtime',
  'factoryplus/test-runner',
]);

/**
 * Images one target legitimately uses and the other does not. Each needs a REASON, so that adding a
 * name here is a decision rather than a way to silence the check.
 */
const TARGET_SPECIFIC = new Map([
  ['alpine', 'Compose: supabase-kong-init. Kubernetes: the same work is an initContainer using the Kong image.'],
  ['node', 'Compose: supabase-storage-init / node-red-init. Kubernetes: node:20-alpine, pinned inline in the Job.'],
  ['busybox', 'Kubernetes only: the wait-for initContainers.'],
  ['curlimages/curl', 'Kubernetes only: readiness waits that need an HTTP client.'],
  ['bitnami/kubectl', 'Kubernetes only: the AAS Job waits on the validate Job.'],
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
      const tagMatch = lines[j].match(/^\s*tag:\s*["']?([^"'\s#]+)["']?/);
      if (tagMatch) {
        out.set(repoMatch[1], tagMatch[1]);
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
  // varies -- `alpine` is Compose-only, `bitnami/kubectl` and the mosquitto exporter are
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

if (failed) process.exit(1);

console.log(`\nImage tags agree across both targets (${shared.length} shared image(s)).`);
