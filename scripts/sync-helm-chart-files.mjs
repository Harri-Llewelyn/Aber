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
    // An explicit allow-list rather than `endsWith('.sql')`, so a new file in timescaledb/ has to
    // be added here deliberately -- and, more to the point, has to be wired into BOTH the Compose
    // service and the Helm Job that run these. A file that mirrored automatically but was never
    // invoked would sit in the ConfigMap looking applied.
    match: (name) =>
      name === 'extension.sql' ||
      name === 'retention.sql' ||
      name === 'aggregates.sql' ||
      name === 'storage.sql' ||
      // ADDED LATE, AND THE DELAY IS THE ARGUMENT FOR THIS LIST BEING EXPLICIT. `cold_archive.sql`
      // shipped with cold telemetry archival and was never added here, so the chart carried no manifest
      // table -- and `0068`'s self-check probes it over the FDW, which meant db-init FAILED on
      // Kubernetes and the whole target could not install. Not a missing feature: a broken
      // deployment path, unreported for a fortnight because CI was down.
      name === 'cold_archive.sql' ||
      name === 'roles.sql',
    why: 'Telemetry lifecycle: the extension update, compression/retention policies, the rollup '
       + 'views, the storage footprint view and the read-only BI roles, reconciled on every boot',
  },
  // THE MIGRATIONS ARE NOT MIRRORED. They are baked into the db-init image by
  // supabase/db-init/Dockerfile and read from its filesystem, so the chart carries none of them.
  //
  // They were mirrored here, gzipped, to fit the 1 MiB ConfigMap limit. That worked and broke the
  // OTHER 1 MiB limit: Helm's release Secret carries the same bytes twice -- once as chart files,
  // once base64-encoded into the rendered ConfigMap -- and gzipped bytes compress no further, so
  // the release reached 1,213,920 bytes against a 1,048,576 cap and `helm install` failed naming
  // only the Secret. No size of file satisfies both limits as the chain grows, because each counts
  // the same bytes. See the Dockerfile for the measurements.
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
    why:
      'STILL MIRRORED, AND ONLY FOR KUBERNETES. Compose no longer reads it -- Envoy is the gateway '
      + 'there -- but the chart still deploys Kong by default, because its Envoy '
      + 'templates have never run in a cluster. Deleting this file breaks helm install outright, '
      + 'which is how it was found. It goes when the chart stops deploying Kong',
  },
  {
    source: 'supabase',
    dest: 'envoy',
    match: (name) => name === 'envoy.yaml',
    why:
      'The Envoy translation of kong.yml. Mirrored for the SAME reason kong.yml is: '
      + 'one file serves both targets, and a route added for Compose and forgotten on Kubernetes '
      + 'is a gateway that behaves differently between environments',
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
    source: 'mosquitto',
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
    source: 'scripts',
    dest: 'gitea-scripts',
    // The provisioning script BOTH targets run: Compose bind-mounts it into a one-shot service,
    // the chart projects it onto an initContainer. It decides which accounts the forge has and
    // what they may do -- the machine account is deliberately not an admin -- and that is policy
    // rather than plumbing, so a hand-copied second version is exactly the drift this exists for.
    match: (name) => name === 'gitea-init.sh',
    why: 'Builds app.ini through the setup script the image ships, migrates the schema, and creates the administrator and the platform machine account. Runs as an initContainer',
  },
  {
    source: 'scripts',
    dest: 'node-red-scripts',
    match: (name) => name === 'node-red-init.mjs',
    why: 'Provisions /data -- settings.js, the credentials and a blank flow. Runs as an initContainer',
  },
  {
    source: 'scripts',
    dest: 'gateway-credential',
    // The service ONLY. Compose bind-mounts these two from scripts/; the chart projects them
    // through a ConfigMap, with the library restored to `lib/` by the volume's `items` -- see
    // templates/messaging/gateway-credential.yaml. The image supplies the runtime (node, and
    // mosquitto_passwd), the chart supplies the code, so a script change needs no image rebuild.
    match: (name) => name === 'gateway-credential-service.mjs',
    why: 'The credential-issuing sidecar in the broker pod; mints one gateway account per call',
  },
  {
    source: join('scripts', 'lib'),
    // A SEPARATE dest FROM THE ENTRY ABOVE, and it has to be. Each mirror OWNS its destination
    // directory and deletes anything in it that its own source did not produce -- so two mirrors
    // pointing at one directory alternately delete each other's file on every run. (Observed, not
    // theorised: the first attempt shared `gateway-credential` and the sync reported
    // "updated ... / removed ...' for the same path in a single pass.)
    //
    // The two files are reunited at MOUNT time instead: the ConfigMap carries both and the volume's
    // `items` restores this one to `lib/`. See templates/messaging/gateway-credential.yaml.
    dest: 'gateway-credential-lib',
    match: (name) => name === 'mosquitto-credentials.mjs',
    why: 'The shared merge -- the truncation guard both the CLI and the service depend on',
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
  // ONE MIRROR PER FOLDER, because this script does NOT recurse -- readdirSync is top-level only,
  // which is the same property that keeps supabase/migrations/archive/ out. A single entry
  // pointing at `dashboards/` would copy dashboards.yml and silently skip both subdirectories,
  // producing a chart that renders, installs, and serves a Grafana with no dashboards at all.
  {
    // Grafana unified-alerting provisioning: the rules, the notification policy tree, and the
    // contact-point TEMPLATE. All three go in one mirror because they are one Grafana provisioning
    // directory -- but only the template carries a placeholder, and the chart renders that one
    // through an initContainer into a Secret-backed emptyDir rather than mounting it from a
    // ConfigMap. A contact point holds a bearer token; the rules and the policy do not.
    source: join('grafana', 'provisioning', 'alerting'),
    dest: 'grafana-alerting',
    // NAMED, NOT GLOBBED, and the glob was a real bug rather than a tidier spelling. The
    // demonstrator's machine rules are opt-in by COPYING `shopfloor-alert-rules.yaml` into
    // this directory -- so on any machine where somebody had enabled them, a `*.yaml` match swept
    // that copy into the chart's UNCONDITIONAL alerting ConfigMap. The rules would then ship to
    // every cluster regardless of `simulation.grafana.enabled`, and the flag would have nothing to
    // switch. Caught by running the sync on a stack with the demonstrator turned on.
    match: (name) =>
      name === 'alert-rules.yaml' ||
      name === 'policies.yaml' ||
      name === 'contact-points.template.yaml',
    why: 'Alert rules, notification policy and the webhook contact point Grafana provisions at start',
  },
  {
    source: join('grafana', 'provisioning', 'dashboards', 'platform'),
    dest: 'grafana-dashboards-platform',
    match: (name) => name.endsWith('.json'),
    why: 'Platform Infrastructure folder -- stack and ingestion health',
  },
];

/**
 * A ConfigMap cannot exceed 1 MiB -- it is an etcd object limit, not a Kubernetes preference, and
 * exceeding it fails at APPLY time with "Request entity too large", naming the object rather than
 * the file that grew.
 *
 * The migrations were the group that mattered, at 878 KiB. THEY ARE NO LONGER MIRRORED AT ALL: they
 * ride in the db-init image instead.
 *
 * GZIP IS NOT THE ANSWER FOR THE NEXT GROUP EITHER, and the support for it has been removed rather
 * than left available. Compressing a mirror moves its bytes out of one 1 MiB limit and straight
 * into another -- Helm's release Secret holds the chart file AND the rendered ConfigMap, and
 * compressed bytes shrink in neither. What remains is to split the ConfigMap across several
 * objects, or to bake the content into an image as the migrations now are.
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
    const destPath = join(destDir, name);
    const rel = relative(REPO_ROOT, destPath).replace(/\\/g, '/');

    groupBytes += Buffer.byteLength(content, 'utf8');
    const current = existsSync(destPath)
      ? readFileSync(destPath, 'utf8').replace(/\r\n/g, '\n')
      : null;

    if (current === content) continue;

    stale += 1;
    if (checkOnly) {
      console.error(`STALE: ${rel} differs from ${mirror.source}/${name}`);
    } else {
      writeFileSync(destPath, content, 'utf8');
      console.log(`updated ${rel}`);
    }
  }

  // Each mirror becomes ONE ConfigMap, so the group total is what has to stay under the limit.
  const pct = groupBytes / CONFIGMAP_LIMIT;
  const describe = `${(groupBytes / 1024).toFixed(0)} KiB`;

  if (pct >= 1) {
    oversize += 1;
    console.error(
      `OVERSIZE: ${mirror.dest} is ${describe}, over the 1 MiB ConfigMap limit. This fails at ` +
        `apply time with "Request entity too large", naming the ConfigMap and not the file that ` +
        `grew. Split the ConfigMap across several objects, or bake an image -- see the note on ` +
        `CONFIGMAP_LIMIT for why compressing it is not the third option it looks like.`
    );
  } else if (pct >= CONFIGMAP_WARN_AT) {
    console.warn(
      `WARNING: ${mirror.dest} is ${describe} — ${(pct * 100).toFixed(0)}% of the 1 MiB ` +
        `ConfigMap limit.`
    );
  }

  // Remove copies whose source no longer exists.
  const expectedDestNames = sourceNames;
  if (existsSync(destDir)) {
    for (const name of readdirSync(destDir)) {
      if (expectedDestNames.includes(name)) continue;
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
