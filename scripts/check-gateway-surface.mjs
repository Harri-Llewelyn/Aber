#!/usr/bin/env node
/**
 * Assert the API gateway's routing and authentication surface against a declared inventory.
 * `validate.py` asserts the 401s that should happen; nothing can assert the absence of a route
 * nobody wrote, and a gateway change that quietly widened an exemption would pass every other
 * test. Three modes: (default) template hygiene over `supabase/envoy.yaml`: every credential is
 * still an `__UPPER_SNAKE__` placeholder and the placeholder set is known to the substituter.
 * `--runtime`: the route surface against a live gateway, every row in EXPECTED, gated routes
 * refused before their upstream and open ones through. `--authenticated`: extends --runtime with
 * a credentialled pass, presenting a valid key by header and by query and an unregistered key,
 * and asserting that on a route which hides credentials the header and query forms are
 * indistinguishable upstream. Both modes share EXPECTED so two inventories cannot drift.
 *
 * Usage: node scripts/check-gateway-surface.mjs [--verbose] | --runtime [baseUrl] | --runtime
 * --authenticated [baseUrl] (needs SUPABASE_PUBLISHABLE_KEY). The base URL is the first non-flag
 * argument, or SUPABASE_URL. No dependencies: this runs in CI before any `npm install`, and the
 * runtime modes use `node:http`; see probeOnce.
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verbose = process.argv.includes('--verbose');
const read = (p) => readFileSync(join(REPO, p), 'utf8');
const log = (m) => verbose && console.log(`       ${m}`);

const problems = [];
const ok = [];
const fail = (m) => problems.push(m);
const pass = (m) => ok.push(m);


// The inventory. This is the specification, not a mirror of the file: a row is a claim that this
// route is meant to exist with this posture, and a route added to the gateway without a row here
// fails.

/** The four recorded exemptions, and what each one is for. Open routes must name one of these. */
const EXEMPTIONS = {
  'sign-in': 'sign-in must work before a session exists; GoTrue authenticates its own callers',
  'public-objects': 'an AAS File URL must resolve with no session',
  'oauth-userinfo': 'an OAuth client sends client credentials, never a Supabase apikey',
  'fplus-directory':
    '`/ping` is open by specification; `/v1/` is authenticated by the FUNCTION, not the gateway',
};

const EXPECTED = [
  { service: 'auth-v1', route: 'auth-v1-routes', paths: ['/auth/v1/'], strip: true,
    auth: 'open', exemption: 'sign-in',
    probe: '/auth/v1/health', marker: '"name":"GoTrue"' },

  { service: 'rest-v1', route: 'rest-v1-routes', paths: ['/rest/v1/'], strip: true,
    auth: 'key-auth',
    probe: '/rest/v1/cells?select=id', marker: 'PGRST' ,
    authMarker: '42501', hides: true},

  { service: 'realtime-v1', route: 'realtime-v1-ws', paths: ['/realtime/v1/'], strip: true,
    auth: 'key-auth',
    probe: '/realtime/v1/', marker: null,
    authMarker: null, hides: false },

  { service: 'storage-v1-public', route: 'storage-v1-public-routes',
    paths: ['/storage/v1/object/public/'], strip: true,
    auth: 'open', exemption: 'public-objects',
    // `statusCode` is storage-api's error envelope, not one particular error: the same upstream
    // answers `not_found` or `Unauthorized` depending on database state, and the request reaching
    // it is the only thing this row asserts.
    probe: '/storage/v1/object/public/asset-3d-models/__probe__', marker: 'statusCode' },

  { service: 'storage-v1', route: 'storage-v1-routes', paths: ['/storage/v1/'], strip: true,
    auth: 'key-auth',
    probe: '/storage/v1/object/list/asset-3d-models', marker: 'statusCode' ,
    authMarker: 'statusCode', hides: true},

  { service: 'functions-v1-grafana-userinfo', route: 'functions-v1-grafana-userinfo-route',
    paths: ['/functions/v1/grafana-userinfo'], strip: true,
    auth: 'open', exemption: 'oauth-userinfo',
    probe: '/functions/v1/grafana-userinfo', marker: '"error"' },

  { service: 'functions-v1-nodered-userinfo', route: 'functions-v1-nodered-userinfo-route',
    paths: ['/functions/v1/nodered-userinfo'], strip: true,
    auth: 'open', exemption: 'oauth-userinfo',
    probe: '/functions/v1/nodered-userinfo', marker: '"error"' },

  // strip_path false on both, unlike every other route: the function reads the first path segment
  // to pick a worker, so the matched prefix has to survive.
  { service: 'fplus-directory', route: 'fplus-directory-ping', paths: ['/ping'], strip: false,
    auth: 'open', exemption: 'fplus-directory',
    probe: '/ping', marker: '"service":"fplus-directory"' },
  { service: 'fplus-directory', route: 'fplus-directory-v1', paths: ['/v1/'], strip: false,
    auth: 'open', exemption: 'fplus-directory',
    probe: '/v1/device', marker: '"error"' },

  // The catch-all, and the most important of the four gates: the edge runtime boots with
  // VERIFY_JWT="false", so without this plugin an unauthenticated request can start any worker.
  { service: 'functions-v1', route: 'functions-v1-routes', paths: ['/functions/v1/'], strip: true,
    auth: 'key-auth',
    probe: '/functions/v1/aas-api/description', marker: '"profiles"' ,
    authMarker: 'profiles', hides: true},
];

// Runtime mode: `node scripts/check-gateway-surface.mjs --runtime [baseUrl]`. What survives a
// gateway swap is the observable posture of each route, so the inventory above is shared. The
// discriminator is whether the request reached the upstream, not the status code: an open route may
// legitimately answer 401 (`/v1/device` and the userinfo endpoints authenticate the caller
// themselves), so each row carries a `marker`, a string only its upstream emits. Every request is
// sent with no `apikey` and no `Authorization`, the only condition under which the gate is
// observable.

const RUNTIME = process.argv.includes('--runtime');
/** Extends --runtime with the credentialled pass. See the block at the end of that mode. */
const AUTHENTICATED = process.argv.includes('--authenticated');

if (RUNTIME) {
  // The first non-flag argument, not whatever follows --runtime, so `--runtime <url>
  // --authenticated` and `--runtime --authenticated <url>` mean the same thing; the latter once
  // fell back to SUPABASE_URL and probed the wrong gateway under the other one's name.
  const argBase = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const base = (
    argBase || process.env.SUPABASE_URL || 'http://127.0.0.1:54321'
  ).replace(/\/+$/, '');

  const runtimeProblems = [];
  const runtimeOk = [];

  // A row with no `probe` is a declaration this mode cannot check, and saying so is the point.
  // `realtime-v1` upgrades to a WebSocket, so an ordinary GET never reaches a body its upstream
  // authored.
  const unprobeable = EXPECTED.filter((r) => !r.probe || r.marker === null);

  const probes = EXPECTED.filter((r) => r.probe && r.marker !== null);

  /**
   * One unauthenticated GET. `node:http` and not `fetch`: Node's fetch holds sockets in a
   * keep-alive pool, and `process.exit()` while undici owns one aborts the process on Windows with
   * a libuv assertion after the report has printed. `agent: false` gives each request its own
   * socket. No headers beyond Accept.
   */
  const probeOnce = (url, extraHeaders = {}) => new Promise((resolveProbe) => {
    let mod, opts;
    try {
      const u = new URL(url);
      mod = u.protocol === 'https:' ? https : http;
      opts = {
        method: 'GET',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        headers: { Accept: '*/*', ...extraHeaders },
        agent: false,
      };
    } catch (err) {
      resolveProbe({ status: 0, body: '', error: `unparseable URL: ${err.message}` });
      return;
    }

    const req = mod.request(opts, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolveProbe({ status: res.statusCode, body, error: null }));
    });
    req.setTimeout(15000, () => {
      req.destroy();
      resolveProbe({ status: 0, body: '', error: 'timed out after 15s' });
    });
    req.on('error', (err) => resolveProbe({ status: 0, body: '', error: err.message }));
    req.end();
  });

  const results = await Promise.all(probes.map(async (row) => {
    const { status, body, error } = await probeOnce(`${base}${row.probe}`);
    return { row, status, body, error };
  }));

  for (const { row, status, body, error } of results) {
    const label = `${row.route} (${row.probe})`;

    if (error) {
      runtimeProblems.push(`${label}: the gateway could not be reached -- ${error}`);
      continue;
    }

    const reachedUpstream = body.includes(row.marker);

    if (row.auth === 'key-auth') {
      // GATED: the gateway must refuse it before the upstream sees it.
      if (reachedUpstream) {
        runtimeProblems.push(
          `${label} is GATED in the inventory but an unauthenticated request reached its upstream `
          + `(HTTP ${status}, body contains ${JSON.stringify(row.marker)}). The gate is not applied.`
        );
      } else if (status !== 401) {
        runtimeProblems.push(
          `${label} is gated and did not reach its upstream, but answered HTTP ${status} rather `
          + `than 401. A gate that refuses with the wrong status is still a behaviour change for `
          + `every client that retries on 401.`
        );
      } else {
        runtimeOk.push(`${row.route} is gated: refused before its upstream, 401`);
      }
      continue;
    }

    // OPEN: the request must get through. The upstream's own answer -- including its own 401 --
    // is the evidence; see the note on the discriminator above.
    if (!reachedUpstream) {
      runtimeProblems.push(
        `${label} is OPEN in the inventory (exemption '${row.exemption}') but an unauthenticated `
        + `request did not reach its upstream (HTTP ${status}). Either the gateway is now gating `
        + `it -- which breaks ${EXEMPTIONS[row.exemption]} -- or the upstream is down.`
      );
    } else {
      runtimeOk.push(
        `${row.route} is open (${row.exemption}): reached its upstream, HTTP ${status}`
      );
    }
  }

  for (const line of runtimeOk) console.log(`  ok   ${line}`);
  for (const row of unprobeable) {
    console.log(`  --   ${row.route}: declared ${row.auth}, not probeable over plain HTTP`);
  }

  if (runtimeProblems.length) {
    console.error(`\nThe live gateway at ${base} does not match the reviewed surface:\n`);
    for (const p of runtimeProblems) console.error(`  ${p}\n`);
    console.error(
      'This mode asserts POSTURE, not configuration, so it is the check that must still pass after\n'
      + 'the gateway is replaced. A failure here is a route whose exposure changed, not a file that\n'
      + 'was formatted differently.\n'
    );
    process.exit(1);
  }

  const gated = probes.filter((r) => r.auth === 'key-auth').length;
  const open = probes.filter((r) => r.auth === 'open').length;
  console.log(
    `\nThe live gateway at ${base} matches the reviewed surface: ${gated} route(s) refused before `
    + `their upstream, ${open} reached theirs across `
    + `${new Set(probes.filter((r) => r.auth === 'open').map((r) => r.exemption)).size} exemptions`
    + (unprobeable.length ? `, ${unprobeable.length} not probeable over plain HTTP.` : '.')
  );

  // Authenticated mode: `--runtime --authenticated`. The unauthenticated pass presents no
  // credential, so it is blind to everything the gateway does with one: the filter once passed
  // it while forwarding a query-string apikey to PostgREST, which parsed it as a column filter. This pass presents a valid key by header (the gate opens), by query (key_in_query,
  // which Realtime needs since a browser sets no header on a handshake), and an invalid key
  // (refused 401), and asserts that on a route which hides credentials the header and query forms
  // produce the same status. Its limit: this detects forwarding only where the upstream is
  // sensitive to it, which is `rest-v1`; a forwarded key sitting in an upstream access log cannot
  // be observed from outside.

  if (AUTHENTICATED) {
    const anonKey = process.env.SUPABASE_PUBLISHABLE_KEY || '';
    if (!anonKey) {
      console.error(
        '\n--authenticated needs SUPABASE_PUBLISHABLE_KEY to present a valid credential.\n'
        + 'Export it: kubectl -n acs-cymru get secret acs-cymru-secrets -o jsonpath={.data.SUPABASE_PUBLISHABLE_KEY} | base64 -d\n'
        + 'Refusing rather than skipping: a pass that\n'
        + 'silently checked nothing is the failure this whole mode exists to prevent.\n'
      );
      process.exit(1);
    }

    /** Append a query parameter to a path that may or may not already have a query string. */
    const withParam = (path, param) => path + (path.includes('?') ? '&' : '?') + param;

    const authProblems = [];
    const authOk = [];

    // Exempt routes are checked too: an exemption that starts refusing a request carrying a key is
    // as broken as a gate that stops applying, and an OAuth client may well send one to the
    // userinfo endpoints.
    for (const row of EXPECTED) {
      if (!row.probe || row.marker === null) continue;

      const label = `${row.route} (${row.probe})`;

      if (row.auth === 'open') {
        const res = await probeOnce(`${base}${row.probe}`, { apikey: anonKey });
        if (res.error) {
          authProblems.push(`${label}: ${res.error}`);
        } else if (!res.body.includes(row.marker)) {
          authProblems.push(
            `${label} is OPEN, but presenting a valid key stopped it reaching its upstream `
            + `(HTTP ${res.status}). An exemption that refuses a credentialled caller is as `
            + `broken as a gate that stops applying.`
          );
        } else {
          authOk.push(`${row.route}: open, and a credentialled request still reaches its upstream`);
        }
        continue;
      }

      // ---- gated ------------------------------------------------------------------------------
      if (row.authMarker === null) {
        console.log(`  --   ${row.route}: gated, no authenticated probe (${row.marker === null ? 'not probeable over plain HTTP' : 'no marker'})`);
        continue;
      }

      const [viaHeader, viaQuery, viaWrong] = await Promise.all([
        probeOnce(`${base}${row.probe}`, { apikey: anonKey }),
        probeOnce(`${base}${withParam(row.probe, `apikey=${encodeURIComponent(anonKey)}`)}`, {}),
        probeOnce(`${base}${row.probe}`, { apikey: 'not-a-registered-key' }),
      ]);

      const transport = [viaHeader, viaQuery, viaWrong].find((r) => r.error);
      if (transport) {
        authProblems.push(`${label}: ${transport.error}`);
        continue;
      }

      if (!viaHeader.body.includes(row.authMarker)) {
        authProblems.push(
          `${label}: a VALID key in the apikey header did not reach the upstream `
          + `(HTTP ${viaHeader.status}). The gate is refusing a key it should accept.`
        );
      }

      if (!viaQuery.body.includes(row.authMarker)) {
        authProblems.push(
          `${label}: a VALID key in the QUERY STRING did not reach the upstream `
          + `(HTTP ${viaQuery.status}). The gateway accepts the key either way, and Realtime `
          + `depends on it -- a browser cannot set a header on a WebSocket handshake.`
        );
      }

      if (row.hides && viaHeader.status !== viaQuery.status) {
        authProblems.push(
          `${label}: the same key answered HTTP ${viaHeader.status} in the header and `
          + `HTTP ${viaQuery.status} in the query string. This route hides credentials, so the two `
          + `must be indistinguishable upstream -- a difference means the query copy was FORWARDED. `
          + `That both leaks the key into upstream logs and corrupts the request: PostgREST reads a `
          + `stray apikey= as a column filter.`
        );
      }

      if (viaWrong.status !== 401 || viaWrong.body.includes(row.authMarker)) {
        authProblems.push(
          `${label}: an UNREGISTERED key was not refused (HTTP ${viaWrong.status}`
          + `${viaWrong.body.includes(row.authMarker) ? ', and reached the upstream' : ''}). `
          + `The gate is testing for the presence of a key rather than its value.`
        );
      }

      if (!authProblems.some((p) => p.startsWith(label))) {
        authOk.push(
          `${row.route}: gated, accepts a valid key in header and query`
          + `${row.hides ? ', hides it from the upstream' : ', forwards it by design'}`
          + `, refuses an unregistered one`
        );
      }
    }

    for (const line of authOk) console.log(`  ok   ${line}`);

    if (authProblems.length) {
      console.error(`\nThe live gateway at ${base} mishandles credentials:\n`);
      for (const p of authProblems) console.error(`  ${p}\n`);
      process.exit(1);
    }

    const checked = EXPECTED.filter((r) => r.auth === 'key-auth' && r.authMarker).length;
    console.log(
      `\nCredential handling at ${base} matches the reviewed surface: ${checked} gated route(s) `
      + 'accept a valid key by header and by query, hide it where the route hides it, and refuse an '
      + 'unregistered one.'
    );
  }

  process.exit(0);
}

// Template hygiene, the default mode. Two assertions about the template rather than the gateway: no
// literal credential is committed (every key must be an `__UPPER_SNAKE__` placeholder, and in
// envoy.yaml the key is inlined into a Lua string), and the substituter knows every placeholder
// (the chart's initContainer scans for leftovers at boot, so a placeholder it was not taught is a
// boot failure). The route surface is asserted by `--runtime`.

const ENVOY_TEMPLATE = 'supabase/envoy.yaml';
const CHART_ENVOY = 'deploy/helm/acs-cymru/templates/supabase/envoy.yaml';

/** Substituted by the chart's initContainer. */
const TEMPLATE_PLACEHOLDERS = [
  '__CORS_ORIGINS__',
  '__REALTIME_UPSTREAM_ADDRESS__',
  '__REALTIME_UPSTREAM_HOST__',
  '__SUPABASE_ANON_KEY__',
  '__SUPABASE_PUBLISHABLE_KEY__',
  '__SUPABASE_SECRET_KEY__',
  '__SUPABASE_SERVICE_ROLE_KEY__',
  // The studio listener's four. The last is the HS256 signing secret as an `oct` JWKS key: not a
  // credential the gateway presents but the one it verifies with.
  '__SUPABASE_JWT_SECRET_B64URL__',
  '__SUPABASE_PUBLIC_URL__',
  '__STUDIO_PUBLIC_URL__',
  '__STUDIO_UPSTREAM_ADDRESS__',
  // The forge listener's two (0094). It shares the JWKS key and SUPABASE_PUBLIC_URL with Studio's.
  '__GITEA_PUBLIC_URL__',
  '__GITEA_UPSTREAM_ADDRESS__',
];

const template = read(ENVOY_TEMPLATE);

// ---- 1. Every placeholder in the template is declared, and nothing else looks like one. --------
{
  // Comment lines are excluded, as the substituters exclude them: the template's header documents
  // the convention by name.
  const found = new Set(
    template
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .flatMap((l) => [...l.matchAll(/__[A-Z0-9_]+__/g)].map((m) => m[0]))
  );
  const undeclared = [...found].filter((x) => !TEMPLATE_PLACEHOLDERS.includes(x)).sort();
  const unused = TEMPLATE_PLACEHOLDERS.filter((x) => !found.has(x)).sort();

  if (undeclared.length) {
    fail(
      `${ENVOY_TEMPLATE} uses placeholder(s) this script does not know: ${undeclared.join(', ')}. `
      + 'Add them to TEMPLATE_PLACEHOLDERS and to the substituter.'
    );
  }
  if (unused.length) {
    fail(
      `TEMPLATE_PLACEHOLDERS names ${unused.join(', ')}, which ${ENVOY_TEMPLATE} does not use. `
      + 'A substituter replacing something absent hides a rename.'
    );
  }
  if (!undeclared.length && !unused.length) {
    pass(`${ENVOY_TEMPLATE} uses exactly the ${TEMPLATE_PLACEHOLDERS.length} declared placeholders`);
  }
}

// ---- 2. No literal credential is committed. ----------------------------------------------------
{
  // A JWT is three base64url segments separated by dots and starts `eyJ` -- the base64 of `{"`.
  // Matching the SHAPE rather than a known value is what makes this catch a key nobody has seen.
  const jwt = template.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/);
  if (jwt) {
    fail(
      `${ENVOY_TEMPLATE} contains what looks like a real JWT (${jwt[0].slice(0, 24)}…). `
      + 'The template is committed; the rendered config is not. Replace it with a placeholder and '
      + 'ROTATE THE KEY -- it is in the git history now.'
    );
  }
  // And the new format, which the JWT shape above cannot see: `sb_publishable_*` and `sb_secret_*`
  // are opaque strings, so the prefix is the only thing that identifies one. Comment lines are
  // excluded as in assertion 1.
  const newKey = template
    .split('\n')
    .filter((l) => !/^\s*(#|\s*--)/.test(l))
    .map((l) => l.match(/sb_(?:publishable|secret)_[A-Za-z0-9_-]{8,}/))
    .find(Boolean);
  if (newKey) {
    fail(
      `${ENVOY_TEMPLATE} contains what looks like a real API key (${newKey[0].slice(0, 24)}…). `
      + 'The template is committed; the rendered config is not. Replace it with a placeholder and '
      + 'ROTATE THE KEY -- it is in the git history now.'
    );
  }
  if (!jwt && !newKey) {
    pass(`${ENVOY_TEMPLATE} carries no literal credential in either key format`);
  }
}

// ---- 3. The substituter handles every placeholder. ---------------------------------------------
{
  const chart = read(CHART_ENVOY);
  const missing = TEMPLATE_PLACEHOLDERS.filter((x) => !chart.includes(x));
  if (missing.length) {
    fail(
      `${CHART_ENVOY} does not substitute ${missing.join(', ')}. Its own leftover scan would catch this `
      + 'at boot, as a gateway that refuses to start.'
    );
  } else {
    pass(`${CHART_ENVOY} substitutes all ${TEMPLATE_PLACEHOLDERS.length} placeholders`);
  }
}

for (const line of ok) console.log(`  ok   ${line}`);
if (problems.length) {
  console.error('\nThe gateway template has drifted:\n');
  for (const problem of problems) console.error(`  ${problem}\n`);
  process.exit(1);
}
console.log(
  `\n${ENVOY_TEMPLATE} is consistent with its substituter. The ROUTE surface is not checkable `
  + 'from a file: run --runtime --authenticated against a live gateway for that.'
);
