#!/usr/bin/env node
/**
 * Mirror repository-owned config files into the Helm chart's `files/` directory.
 *
 * WHY THIS EXISTS. Helm cannot read anything outside its own chart directory: `.Files.Glob` is
 * scoped to the chart, and `..` is rejected outright. But the files the chart needs are the SAME
 * files docker-compose.yml bind-mounts -- the TimescaleDB bootstrap scripts, and in later phases
 * the Kong template, the Grafana datasource template, the Mosquitto config and the Node-RED flow.
 * Two hand-maintained copies of those is exactly the drift this whole migration is trying to avoid.
 *
 * So: ONE source of truth in the repository, mirrored into the chart mechanically, with a
 * `--check` mode CI runs to prove the copies are current. Same guard-rail discipline as
 * `check-mtconnect-seed-sync.mjs` and the isUuid/metric-group checks in ci.yml.
 *
 * THE MIRRORED COPIES ARE COMMITTED, deliberately. A chart has to be installable from a packaged
 * .tgz with no build step -- `helm install ./deploy/helm/acs-cymru` must work on a machine that
 * has never run this script. Generating them at package time would make the repository and the
 * artefact disagree about what is deployable.
 *
 * Usage:
 *   node scripts/sync-helm-chart-files.mjs            # write the copies
 *   node scripts/sync-helm-chart-files.mjs --check    # exit 1 if any copy is stale (CI)
 *
 * Cross-platform via node:fs, no POSIX shell required -- same constraint scripts/setup.mjs has.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHART_FILES = join(REPO_ROOT, 'deploy', 'helm', 'acs-cymru', 'files');

/**
 * source: a repository directory, relative to the repo root.
 * dest:   a directory under the chart's files/, which this script OWNS -- anything in it that is
 *         not produced from `source` is deleted, so a renamed source file does not leave a stale
 *         copy behind that the chart would happily go on mounting.
 */
const MIRRORS = [
  {
    source: join('timescaledb', 'init'),
    dest: 'timescaledb-init',
    match: (name) => name.endsWith('.sql'),
    why: 'TimescaleDB bootstrap; Compose bind-mounts the same directory at /docker-entrypoint-initdb.d',
  },
  {
    source: 'timescaledb',
    dest: 'timescaledb-maintenance',
    // NOT part of the initdb mirror above, and the separation is the point. Everything in
    // timescaledb/init runs ONLY on an empty data directory; these run on EVERY boot, which is
    // what makes the compression, retention and rollup definitions settings rather than constants
    // fixed before the first row was written. Mounting them into the initdb ConfigMap would
    // silently restore the old behaviour.
    match: (name) => name === 'retention.sql' || name === 'aggregates.sql',
    why: 'Telemetry lifecycle: compression/retention policies and the rollup views, reconciled on every boot',
  },
  {
    source: join('supabase', 'migrations'),
    dest: 'migrations',
    // Top level only -- readdirSync does not recurse, which is what keeps
    // supabase/migrations/archive/ out. Those are the pre-beta chain, preserved as reasoning and
    // deliberately never executed; mounting them would replay 38 superseded migrations.
    match: (name) => name.endsWith('.sql'),
    why: 'Applied in order by the db-init Job on every boot, exactly as supabase-db-init does',
  },
  {
    source: 'supabase',
    dest: 'seed',
    match: (name) => name === 'seed.sql',
    why: 'GoTrue demo accounts and user_roles; runs after the migrations',
  },
  {
    source: 'supabase',
    dest: 'storage-policies',
    match: (name) => name === 'storage-policies.sql',
    why: 'RLS on storage.objects; runs after storage-api has migrated the schema into existence',
  },
  {
    source: 'supabase',
    dest: 'kong',
    match: (name) => name === 'kong.yml',
    why: 'Gateway declarative config; a TEMPLATE, rendered into a Secret by the chart',
  },
  {
    source: 'scripts',
    dest: 'scripts',
    match: (name) => name === 'storage-init.mjs',
    why: 'Creates the asset-3d-models bucket through the Storage REST API',
  },
  {
    source: 'docs',
    dest: 'docs',
    // TWO specs, because they describe two different origins. openapi.yaml is everything behind
    // Kong on :54321; i3x-openapi.yaml is the i3X server on :8090, which has no Kong route, takes
    // no `apikey`, and would collide on /v1/schema if it were merged in. swagger-ui serves both
    // from one dropdown.
    match: (name) => name === 'openapi.yaml' || name === 'i3x-openapi.yaml',
    why: 'The curated API specs swagger-ui serves',
  },
  {
    source: '.',
    dest: 'mosquitto',
    // mosquitto.conf declares `acl_file`, `allow_anonymous` and `password_file` ONCE in its global
    // section, which is what guarantees the TCP, WebSocket and TLS listeners are authorised
    // identically -- and, on 2.0.x, is the difference between a broker that starts and one that
    // exits 3 on "Duplicate password_file value". The three files are one policy and must travel
    // together.
    //
    // mosquitto-tls.conf is the 8883 listener, APPENDED to mosquitto.conf only where certificates
    // exist. It is mirrored unconditionally because the chart decides whether to append it at
    // render time; a missing file would fail the render instead of turning the listener off.
    match: (name) =>
      name === 'mosquitto.conf' || name === 'mosquitto.acl' || name === 'mosquitto-tls.conf',
    why: 'Broker config, topic ACL and the optional MQTTS listener; repository-managed policy, mounted read-only on both targets',
  },
  {
    source: '.',
    dest: 'node-red',
    match: (name) => name === 'node_red_flow.json',
    why: 'The canonical flow node-red-init seeds and deploy-nodered pushes',
  },
  {
    source: 'scripts',
    dest: 'node-red-scripts',
    match: (name) => name === 'node-red-init.mjs',
    why: 'Provisions /data -- settings.js, the credentials and the seeded flow. Runs as an initContainer',
  },
  {
    source: 'grafana',
    dest: 'grafana',
    // The OAuth block only. Everything else Grafana needs comes from GF_* env vars, which is where
    // this stack has always configured it -- grafana.ini exists because the [auth.generic_oauth]
    // section is too long to express readably as environment variables.
    match: (name) => name === 'grafana.ini',
    why: 'Grafana SSO configuration; the browser-facing URLs inside it are overridden by GF_* env',
  },
  {
    source: join('grafana', 'provisioning', 'datasources'),
    dest: 'grafana-datasources',
    match: (name) => name === 'datasources.template.yml',
    why: 'A TEMPLATE -- __DB_PASSWORD__ is substituted by an initContainer, as with kong.yml',
  },
  {
    source: join('grafana', 'provisioning', 'dashboards'),
    dest: 'grafana-dashboards',
    match: (name) => name.endsWith('.yml'),
    why: 'Dashboard provider definition',
  },
  {
    source: join('grafana', 'provisioning', 'dashboards', 'json'),
    dest: 'grafana-dashboards-json',
    match: (name) => name.endsWith('.json'),
    why: 'The dashboards themselves',
  },
  {
    source: join('grafana', 'provisioning', 'alerting'),
    dest: 'grafana-alerting',
    match: (name) => name.endsWith('.yml'),
    why: 'Alert rules. These read val_string on Controller/EXECUTION and EMERGENCY_STOP -- a stale val_bool test compares NULL and stops alerting silently',
  },
];

/**
 * A ConfigMap cannot exceed 1 MiB -- it is an etcd object limit, not a Kubernetes preference, and
 * exceeding it fails at APPLY time with "Request entity too large", naming the object rather than
 * the file that grew.
 *
 * The migrations are the group that matters: `0002_seed_data.sql` alone is over 200 KB because it
 * carries three generated reference vocabularies, and it only ever grows. Warn well before the
 * cliff so the choice of what to do about it (split the ConfigMap, gzip, or bake an image) is made
 * deliberately rather than under a failing deploy.
 */
const CONFIGMAP_LIMIT = 1024 * 1024;
const CONFIGMAP_WARN_AT = 0.75;

const HEADER_NOTE =
  'Generated by scripts/sync-helm-chart-files.mjs -- do not edit. Edit the source listed above.';

let stale = 0;
let oversize = 0;
const checkOnly = process.argv.includes('--check');

for (const mirror of MIRRORS) {
  let groupBytes = 0;
  const sourceDir = join(REPO_ROOT, mirror.source);
  const destDir = join(CHART_FILES, mirror.dest);

  if (!existsSync(sourceDir)) {
    console.error(`Source directory missing: ${mirror.source}`);
    process.exit(1);
  }

  const sourceNames = readdirSync(sourceDir).filter(mirror.match).sort();
  if (sourceNames.length === 0) {
    console.error(`No matching files in ${mirror.source}`);
    process.exit(1);
  }

  if (!checkOnly) mkdirSync(destDir, { recursive: true });

  for (const name of sourceNames) {
    // Normalise line endings. Git may check the source out as CRLF on Windows; a byte comparison
    // would then report drift on every developer machine and report nothing useful in CI.
    const content = readFileSync(join(sourceDir, name), 'utf8').replace(/\r\n/g, '\n');
    groupBytes += Buffer.byteLength(content, 'utf8');
    const destPath = join(destDir, name);
    const current = existsSync(destPath)
      ? readFileSync(destPath, 'utf8').replace(/\r\n/g, '\n')
      : null;

    if (current === content) continue;

    stale += 1;
    const rel = relative(REPO_ROOT, destPath).replace(/\\/g, '/');
    if (checkOnly) {
      console.error(`STALE: ${rel} differs from ${mirror.source}/${name}`);
    } else {
      writeFileSync(destPath, content, 'utf8');
      console.log(`updated ${rel}`);
    }
  }

  // Each mirror becomes ONE ConfigMap, so the group total is what has to stay under the limit.
  const pct = groupBytes / CONFIGMAP_LIMIT;
  if (pct >= 1) {
    oversize += 1;
    console.error(
      `OVERSIZE: ${mirror.dest} is ${(groupBytes / 1024).toFixed(0)} KiB, over the 1 MiB ConfigMap ` +
        `limit. This fails at apply time with "Request entity too large", naming the ConfigMap and ` +
        `not the file that grew. Split the ConfigMap, gzip the contents, or bake an image.`
    );
  } else if (pct >= CONFIGMAP_WARN_AT) {
    console.warn(
      `WARNING: ${mirror.dest} is ${(groupBytes / 1024).toFixed(0)} KiB — ` +
        `${(pct * 100).toFixed(0)}% of the 1 MiB ConfigMap limit.`
    );
  }

  // Remove copies whose source no longer exists.
  if (existsSync(destDir)) {
    for (const name of readdirSync(destDir)) {
      if (sourceNames.includes(name)) continue;
      stale += 1;
      const rel = relative(REPO_ROOT, join(destDir, name)).replace(/\\/g, '/');
      if (checkOnly) {
        console.error(`ORPHAN: ${rel} has no counterpart in ${mirror.source}`);
      } else {
        rmSync(join(destDir, name));
        console.log(`removed ${rel}`);
      }
    }
  }
}

if (oversize > 0) process.exit(1);

if (checkOnly && stale > 0) {
  console.error(
    `\n${stale} chart file(s) out of sync. Run:  node scripts/sync-helm-chart-files.mjs\n` +
      `\nThe chart mounts these into the cluster, so a stale copy provisions a DIFFERENT database\n` +
      `than Docker Compose does -- which is precisely the drift the two-target arrangement exists\n` +
      `to prevent, and it would only surface as a schema error at first write.\n`
  );
  process.exit(1);
}

console.log(
  checkOnly
    ? 'Helm chart files are in sync with their repository sources.'
    : `Synced ${MIRRORS.length} mirror(s). ${HEADER_NOTE}`
);
