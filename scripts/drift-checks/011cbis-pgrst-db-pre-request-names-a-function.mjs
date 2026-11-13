import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 11c-bis. PGRST_DB_PRE_REQUEST names a function that actually exists.
//
// Measured against postgrest/postgrest:v14.12: a hook naming a missing function boots, answers
// 200 on /live and /ready, and fails every data request with 404 42883. A typo here is a total
// API outage that every health check calls healthy, so it is caught statically: the chart sets
// the name, and a migration has to declare it.
// -------------------------------------------------------------------------------------------------
// -------------------------------------------------------------------------------------------------
// 11c-ter. The playback credential delivery path is the same string in all four places.
//
// The credential is written at one path and read at another, and neither end complains when they
// differ. The two ends cannot share a constant -- JavaScript beside the broker, Python in the
// ingestion image -- and the chart states the same path twice more, as the mount and as the
// Secret key projected into it.
// -------------------------------------------------------------------------------------------------
function part1() {
  const lib = read('scripts/lib/mosquitto-credentials.mjs');
  const worker = read('ingestion/playback_worker.py');
  const chartSrc = read('deploy/helm/aber/templates/apps/playback.yaml');

  const libPath = lib.match(/PLAYBACK_CREDENTIAL_FILE\s*=\s*'([^']+)'/)?.[1];
  const workerPath = worker.match(/"PLAYBACK_CREDENTIAL_FILE",\s*"([^"]+)"/)?.[1];

  if (!libPath || !workerPath) {
    fail(
      'the playback delivery path could not be read from both ends ' +
        `(lib: ${libPath || 'absent'}, worker: ${workerPath || 'absent'}).`
    );
  } else if (libPath !== workerPath) {
    fail(
      `the playback delivery path differs: gateway-credential writes ${libPath}, playback_worker ` +
        `reads ${workerPath}. Neither end reports an error when these disagree -- the write ` +
        'succeeds and the read finds nothing, which the worker reports as "no credentials issued".'
    );
  } else {
    // The DIRECTORY is what the chart mounts; the file is created inside it.
    const dir = libPath.replace(/\/[^/]+$/, '');
    const onChart = chartSrc.includes(`mountPath: ${dir}`);
    // The Secret key's `path:` is relative to the mount, so it must be the file's basename or the
    // worker reads a directory entry that is not there.
    const basename = libPath.slice(dir.length + 1);
    const chartItem = chartSrc.includes(`path: ${basename}`);

    if (!onChart || !chartItem) {
      fail(
        `the playback delivery path ${libPath} is not carried by the chart (mount: ` +
          `${onChart ? 'ok' : 'MISSING'}, secret item path: ${chartItem ? 'ok' : 'MISSING'}). ` +
          'An issued playback credential would be written into a container layer and lost, with no ' +
          'error on either side.'
      );
    } else {
      pass(`the playback delivery path ${libPath} agrees across both ends and the chart`);
    }
  }
}

function part2() {
  const chart = read('deploy/helm/aber/templates/supabase/rest.yaml');

  const chartName = chart.match(/name:\s*PGRST_DB_PRE_REQUEST\s*\n\s*value:\s*([A-Za-z0-9_.]+)/)?.[1];

  if (!chartName) {
    fail(
      'PGRST_DB_PRE_REQUEST is not set on supabase-rest. It is the choke point 0074 and 0076 ' +
        'revoke through; unset, the stack enforces no revocation at all and says nothing about it.'
    );
  } else {
    // Declared anywhere in the applied chain. The bare name is enough: a function that is dropped
    // and recreated still has to appear in a CREATE, and this is looking for the typo case.
    const bare = chartName.replace(/^public\./, '');
    const declared = readdirSync(join(REPO, 'supabase/migrations'), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.sql'))
      .some((e) => new RegExp(
        `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+(public\\.)?${bare}\\s*\\(`, 'i'
      ).test(read(`supabase/migrations/${e.name}`)));

    if (!declared) {
      fail(
        `PGRST_DB_PRE_REQUEST names ${chartName}, which no migration declares. PostgREST does ` +
          'NOT fail to boot on this -- it answers 404 (42883) to every request while /live and ' +
          '/ready both report 200, so the outage is invisible to every health check.'
      );
    } else {
      pass(`PGRST_DB_PRE_REQUEST names ${chartName}, and a migration declares it`);
    }
  }
}

// -------------------------------------------------------------------------------------------------
// Every variable a function declares is set on the functions Deployment
//
// main/index.ts forwards a worker nothing but the names its registry entry lists, and a name the
// Deployment never sets is skipped silently, so the function reads `undefined` and refuses or
// degrades on every call while the pod stays Ready. GRAFANA_ALERT_WEBHOOK_SECRET shipped that way
// from the Compose removal: Grafana held the secret, the functions Deployment did not, and no alert
// reached the dashboard on any Kubernetes install while every rule reported healthy.
function part3() {
  const registry = read('supabase/functions/main/index.ts');
  const chart = read('deploy/helm/aber/templates/supabase/functions.yaml');

  const from = registry.indexOf('const COMMON_ENV');
  const to = registry.indexOf('function envForFunction');
  const declared = new Set(
    [...registry.slice(from, to).matchAll(/"([A-Z][A-Z0-9_]+)"/g)].map((m) => m[1])
  );

  // Set by something other than the Deployment's env list, each with what sets it.
  const elsewhere = {
    ABER_CA_PEM: 'main/index.ts reads it from the mounted platform root at spawn, the entrypoint at start',
    ABER_CA_STATE: 'main/index.ts derives it from what the mounted platform root holds',
    GITEA_MACHINE_TOKEN: 'main/index.ts reads it at spawn from the mounted file GITEA_MACHINE_TOKEN_FILE names',
    ASSET_EXPORT_MAX_TELEMETRY_ROWS: 'defaulted inside aas-export, deliberately not plumbed',
    ASSET_EXPORT_MAX_TRAIL_ROWS: 'defaulted inside aas-export, deliberately not plumbed',
  };

  const set = new Set([
    ...[...chart.matchAll(/^\s*-\s*name:\s*([A-Z][A-Z0-9_]+)\s*$/gm)].map((m) => m[1]),
    ...[...chart.matchAll(/"aber\.(?:optional)?[sS]ecretEnv"\s*\(dict\s+"name"\s+"([A-Z][A-Z0-9_]+)"/g)]
      .map((m) => m[1]),
  ]);

  const missing = [...declared].filter((n) => !set.has(n) && !(n in elsewhere));
  const stale = Object.keys(elsewhere).filter((n) => !declared.has(n));

  if (!declared.size || !set.size) {
    fail(
      'the function registry or the functions Deployment could not be read ' +
        `(${declared.size} declared, ${set.size} set); one of them has moved.`
    );
  } else if (missing.length) {
    fail(
      `${missing.length} variable(s) the function registry declares are set nowhere on ` +
        'supabase-functions, so the worker never receives them and the function fails on every ' +
        `call while the pod stays Ready: ${missing.join(', ')}`
    );
  } else if (stale.length) {
    fail(
      `${stale.join(', ')} is listed here as set elsewhere but no function declares it any more; ` +
        'remove it from the list.'
    );
  } else {
    pass(
      `all ${declared.size} variable(s) the function registry declares are set on ` +
        `supabase-functions (${Object.keys(elsewhere).length} by something other than its env list)`
    );
  }
}

export default function check() {
  part1();
  part2();
  part3();
}
