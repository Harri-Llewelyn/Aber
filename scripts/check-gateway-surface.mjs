#!/usr/bin/env node
/**
 * Assert the API gateway's ROUTING AND AUTHENTICATION SURFACE against a declared inventory.
 *
 * WHY THIS EXISTS, and it is not the same claim `validate.py` makes. `validate.py` asserts the 401s
 * that SHOULD happen -- the Directory's `/v1/device`, i3X's `/objects`, Node-RED's admin API. Those
 * are positive assertions about routes somebody wrote. NOTHING IN THIS REPOSITORY CAN ASSERT THE
 * ABSENCE OF A ROUTE NOBODY WROTE, because absence is not probeable: there is no request that
 * demonstrates a route was never added, and no test fails when one is.
 *
 * That gap is what makes a gateway migration dangerous rather than tedious. `kong.yml` fronts nine
 * services, gates four of them with `key-auth`, and leaves six routes open across FOUR deliberate
 * exemptions -- each open for a stated reason and each load bearing. A translation that quietly
 * widened one would pass every test that exists today. So would a route added here and gated
 * nowhere.
 *
 * WHAT IT CHECKS is therefore the whole declared surface, against EXPECTED below:
 *
 *   1. the service set, exactly -- no additions, no removals
 *   2. the route set and its paths, exactly, per service
 *   3. the AUTH POSTURE of every route: gated by `key-auth`, or open and recorded as one of the
 *      four exemptions. A new route has no entry and fails; a gated route that loses its plugin
 *      fails; an open route that is not a recorded exemption fails.
 *   4. `strip_path` per route, because it is not cosmetic here -- `fplus-directory` needs `false`
 *      to preserve `/v1/device/<uuid>`, the userinfo routes need `true`, and the wrong one hands
 *      the edge runtime an empty service name and answers 400 naming nothing
 *   5. the consumers are exactly `anon` and `service_role`, and NEITHER CARRIES A LITERAL KEY --
 *      every credential must still be an `__UPPER_SNAKE__` placeholder, because a real JWT
 *      committed here is a leaked key, not a config change
 *   6. the global plugins are exactly `cors` and `prometheus`; `origins` is still substituted
 *      rather than written, and prometheus keeps the three 3.x flags that default to false and
 *      silently delete every per-service series when they are missing
 *   7. THE PLACEHOLDER SET IS KNOWN TO BOTH SUBSTITUTERS. Compose's `supabase-kong-init` and the
 *      chart's initContainer each scan for leftovers AT RUNTIME, so a placeholder added here and
 *      taught to only one of them is a per-target divergence that surfaces as a boot failure on
 *      whichever target was forgotten. This compares the three lists statically instead.
 *   8. THE TWO DOCUMENTS THAT CARRY THE ARGUMENT AGREE. kong.yml's header states both counts and
 *      one bullet per exemption; supabase/README.md, which that header sends readers to for the
 *      full reasoning, states the same counts and names every open route. It said TWO open routes
 *      until this check was written -- half of them -- which is how an exemption gets dropped in a
 *      migration without contradicting anything the migration reads.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK. Whether the gateway is Kong. Every assertion above is a
 * statement about the SURFACE -- which paths exist, which are authenticated, which are open and
 * why -- and none of it is Kong vocabulary except where it reads the file. That is the point:
 * roadmap §4 (Kong -> Envoy) says "any migration needs the negative assertions first", and this is
 * them. When the gateway moves, EXPECTED is the specification the new one must satisfy and this
 * header is the argument for each exemption it must preserve.
 *
 * It also does not check that the routes WORK. That is `validate.py`'s half, live against a running
 * stack, and the two are complementary: this one proves the surface is what was intended, that one
 * proves the intended surface behaves.
 *
 * ---------------------------------------------------------------------------------------------
 * TWO MODES, AND THE SECOND IS THE ONE THAT SURVIVES THE MIGRATION.
 *
 *   (default)   reads kong.yml and asserts its SHAPE against EXPECTED. Correct while Kong is the
 *               gateway; meaningless the moment it is not, because Envoy's configuration is
 *               lds.yaml and cds.yaml and this parser has nothing to say about it.
 *
 *   --runtime   probes a LIVE gateway and asserts the observable POSTURE of every route in
 *               EXPECTED: gated routes must be refused before their upstream sees them, open ones
 *               must get through. It names no Kong concept, so it reads identically against
 *               whatever is fronting the stack -- which makes it the before-and-after check the
 *               migration is steered by, rather than a check that has to be rewritten alongside
 *               the thing it is meant to be guarding.
 *
 *   --authenticated
 *               extends --runtime with a CREDENTIALLED pass, and it is the difference between a
 *               comparison and a promotion gate. The unauthenticated pass sends no key at all, so
 *               it is blind to everything the gateway does WITH one -- which is how the first
 *               Envoy translation passed every assertion here while forwarding the apikey from the
 *               query string to PostgREST, where it was read as a column filter. Presents a valid
 *               key by header and by query, an unregistered key, and asserts that on a route which
 *               hides credentials the header and query forms are indistinguishable upstream.
 *
 * Both share EXPECTED on purpose. Two inventories would drift, and the one that drifted would be
 * the one nobody ran.
 *
 * Usage:
 *   node scripts/check-gateway-surface.mjs
 *   node scripts/check-gateway-surface.mjs --verbose
 *   node scripts/check-gateway-surface.mjs --runtime [baseUrl]
 *   node scripts/check-gateway-surface.mjs --runtime --authenticated [baseUrl]   # needs SUPABASE_ANON_KEY
 *
 * The base URL is the first non-flag argument, or SUPABASE_URL. Running it twice against two
 * gateways and diffing the output is the equivalence test roadmap §4 is steered by.
 *
 * No YAML dependency: this runs in CI before any `npm install`, and the shape it reads is narrow
 * and asserted -- see `assertParsed()`, which refuses to compare anything if the scan came back
 * emptier than the file can possibly be. A parser that silently returns nothing would otherwise
 * make every assertion below pass while checking nothing, which is the failure mode a check like
 * this is most likely to have and least likely to show.
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

const KONG = 'supabase/kong.yml';
const COMPOSE = 'docker-compose.yml';
const CHART_KONG = 'deploy/helm/acs-cymru/templates/supabase/kong.yaml';

// -------------------------------------------------------------------------------------------------
// THE INVENTORY. This is the specification, not a mirror of the file -- every row was read from
// kong.yml once, by hand, and each `why` is the reason recorded at that service's own definition.
//
// A row here is a claim that this route is MEANT to exist with this posture. Adding a route to
// kong.yml without adding it here fails, which is the whole point: the default for a new route is
// "not reviewed", not "inherits whatever the file says".
// -------------------------------------------------------------------------------------------------

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
    probe: '/storage/v1/object/public/asset-3d-models/__probe__', marker: '"error":"not_found"' },

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

  // strip_path FALSE on both, unlike every other route here. The function reads the first path
  // segment to pick a worker, so the matched prefix has to survive; stripping it hands the runtime
  // an empty service name and it answers 400.
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

/** Consumers the gateway registers. Values must stay placeholders -- see assertion 5. */
const EXPECTED_CONSUMERS = ['anon', 'service_role'];

/** Global plugins, and the config keys that are load bearing rather than incidental. */
const EXPECTED_GLOBAL_PLUGINS = ['prometheus', 'cors'];

/**
 * On Kong 3.x these three default to FALSE, and 2.8 emitted them from a bare `- name: prometheus`.
 * Losing them removes `kong_http_status`, `kong_latency_*` and `kong_bandwidth` while /metrics keeps
 * answering 200 -- an unmeasured gateway that reads as an idle one.
 */
const PROMETHEUS_FLAGS = ['status_code_metrics', 'latency_metrics', 'bandwidth_metrics'];

/** Substituted by BOTH targets. Assertion 7 requires all three lists to agree. */
const EXPECTED_PLACEHOLDERS = [
  '__CORS_ORIGINS__',
  '__REALTIME_UPSTREAM_URL__',
  '__SUPABASE_ANON_KEY__',
  '__SUPABASE_SERVICE_ROLE_KEY__',
];

// =================================================================================================
// RUNTIME MODE  --  `node scripts/check-gateway-surface.mjs --runtime [baseUrl]`
//
// WHY A SECOND MODE RATHER THAN A SECOND SCRIPT. Everything above reads `kong.yml` and asserts its
// SHAPE. That is the right check while Kong is the gateway and worthless the moment it is not:
// Envoy's configuration is `lds.yaml` and `cds.yaml`, and a checker that parses Kong's indentation
// has nothing to say about it. What survives a gateway swap is not the config -- it is the
// OBSERVABLE POSTURE of each route, and that is what this mode asserts.
//
// So the inventory above is shared deliberately. Two inventories would drift, and the one that
// drifted would be the one nobody ran.
//
// THE DISCRIMINATOR IS "DID THE REQUEST REACH THE UPSTREAM", NOT THE STATUS CODE, and the
// difference is the whole reason this is not three lines of curl. An OPEN route may legitimately
// answer 401 -- `/v1/device` and both userinfo endpoints are exempt from the gateway precisely so
// they can authenticate the caller THEMSELVES, and they answer 401 when nobody is signed in. A
// check that read 401 as "gated" would call those four correctly gated while they were wide open,
// which is the exact failure this exists to catch.
//
// So each row carries a `marker`: a string only its UPSTREAM emits. Present means the request got
// through; absent on a gated route means the gateway refused it. That test is worded in terms of
// the upstreams rather than the gateway, so it reads identically against Kong and against Envoy --
// whose refusal body will differ from Kong's `No API key found in request` and does not need to be
// known here.
//
// EVERY REQUEST IS SENT WITH NO `apikey` AND NO `Authorization`. That is the only condition under
// which the gate is observable at all: with a valid key every route answers from its upstream and
// the gated and open sets become indistinguishable.
// -------------------------------------------------------------------------------------------------

const RUNTIME = process.argv.includes('--runtime');
/** Extends --runtime with the credentialled pass. See the block at the end of that mode. */
const AUTHENTICATED = process.argv.includes('--authenticated');

if (RUNTIME) {
  // THE FIRST NON-FLAG ARGUMENT, not "whatever follows --runtime".
  //
  // It was the latter, and the failure was silent and total: `--runtime --authenticated <url>`
  // read `--authenticated` as the base, rejected it for starting with `--`, and fell back to
  // SUPABASE_URL. Every run that was supposed to be probing the second gateway probed the first
  // one instead, and reported a clean pass for it under the other one's name. Caught by diffing
  // two runs that should have differed and did not.
  //
  // Order-independent now, so `--runtime <url> --authenticated` and
  // `--runtime --authenticated <url>` mean the same thing.
  const argBase = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const base = (
    argBase || process.env.SUPABASE_URL || 'http://127.0.0.1:54321'
  ).replace(/\/+$/, '');

  const runtimeProblems = [];
  const runtimeOk = [];

  // A row with no `probe` is a declaration this mode cannot check, and saying so is the point --
  // silence would read as a pass. `realtime-v1` is the case: it upgrades to a WebSocket, so an
  // ordinary GET never reaches a body its upstream authored.
  const unprobeable = EXPECTED.filter((r) => !r.probe || r.marker === null);

  const probes = EXPECTED.filter((r) => r.probe && r.marker !== null);

  /**
   * One unauthenticated GET.
   *
   * DELIBERATELY `node:http` AND NOT `fetch`. Node's fetch holds its sockets open in a keep-alive
   * pool, and `process.exit()` below while undici still owns one aborts the process on Windows with
   * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` -- AFTER the report has printed. The
   * run reads as a pass that crashed, and in CI as a failure with a green-looking log above it.
   * `agent: false` gives each request its own socket and closes it, so exit has nothing to trip on.
   *
   * NO HEADERS BEYOND Accept. Sending no `apikey` and no `Authorization` is the whole experiment.
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

  // ===============================================================================================
  // AUTHENTICATED MODE  --  `--runtime --authenticated`
  //
  // WHY THE UNAUTHENTICATED PASS IS NOT A PROMOTION GATE ON ITS OWN, learned the hard way: the
  // Envoy translation passed every unauthenticated assertion above while `hide_credentials` was
  // stripping the apikey from the HEADER and not from the QUERY STRING. A client sending
  // `?apikey=...` -- which Kong accepts and then removes -- got its key forwarded to PostgREST,
  // which parsed it as a COLUMN FILTER and answered PGRST100 where Kong answered 200. Every probe
  // above was green throughout, because none of them presented a credential at all.
  //
  // So this pass presents one, three ways, and asserts what each is for:
  //
  //   header    a valid key in `apikey:` reaches the upstream          (the gate opens)
  //   query     a valid key in `?apikey=` reaches the upstream         (key_in_query, which
  //                                                                     Realtime cannot live
  //                                                                     without -- a browser sets
  //                                                                     no header on a handshake)
  //   invalid   a wrong key is refused 401 and reaches nothing         (the gate is a check, not
  //                                                                     a presence test)
  //
  // AND THE ONE THAT CAUGHT THE BUG: on a route that hides credentials, the header form and the
  // query form must produce the SAME STATUS. That comparison is worded against neither gateway nor
  // upstream -- it says only "how the caller passed the key must not change the answer" -- which is
  // exactly the invariant `hide_credentials` exists to provide and the one a translation silently
  // drops. 400-vs-200 is what it looked like when it was broken.
  //
  // ITS LIMIT, MEASURED RATHER THAN ASSUMED. Re-introducing the bug on purpose fails `rest-v1` on
  // both counts and leaves `functions-v1` GREEN: a stray `apikey=` corrupts a PostgREST request
  // because PostgREST reads unknown query parameters as column filters, and is simply ignored by
  // the edge runtime. So this detects FORWARDING only where the upstream is sensitive to it, and
  // `rest-v1` is the row carrying that weight. The half it cannot see is the leak -- a forwarded
  // service-role key sitting in an upstream access log -- which no black-box probe can observe
  // from outside. Stated here so the green on the other rows is not read as more than it is.
  // ===============================================================================================

  if (AUTHENTICATED) {
    const anonKey = process.env.SUPABASE_ANON_KEY || '';
    if (!anonKey) {
      console.error(
        '\n--authenticated needs SUPABASE_ANON_KEY to present a valid credential.\n'
        + 'Run `set -a && . ./.env && set +a` first. Refusing rather than skipping: a pass that\n'
        + 'silently checked nothing is the failure this whole mode exists to prevent.\n'
      );
      process.exit(1);
    }

    /** Append a query parameter to a path that may or may not already have a query string. */
    const withParam = (path, param) => path + (path.includes('?') ? '&' : '?') + param;

    const authProblems = [];
    const authOk = [];

    // Exempt routes are checked too, and for a reason that is not symmetry: an exemption that
    // starts REFUSING a request carrying a key is just as broken as a gate that stops applying,
    // and presenting a credential to an open route is the ordinary case for the two userinfo
    // endpoints -- an OAuth client may well send one.
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
          + `(HTTP ${viaQuery.status}). Kong accepts the key either way (key_in_query), and `
          + `Realtime depends on it -- a browser cannot set a header on a WebSocket handshake.`
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
      + 'accept a valid key by header and by query, hide it where Kong hides it, and refuse an '
      + 'unregistered one.'
    );
  }

  process.exit(0);
}

// =================================================================================================
// TEMPLATE HYGIENE  --  the default mode, and what is LEFT of the static one.
//
// The Kong static mode is gone with Kong. It read `kong.yml`'s indentation and asserted its shape:
// services, routes, strip_path, plugins, consumers. Every one of those was Kong vocabulary, and
// Envoy's configuration is a bootstrap of listeners and clusters that the parser could not read a
// word of. Keeping it would have meant maintaining a checker for a file the stack no longer has.
//
// TWO OF ITS EIGHT ASSERTIONS WERE NOT ABOUT KONG AT ALL, and those are here. Both are about the
// TEMPLATE rather than the gateway, so they survived the migration unchanged in meaning:
//
//   * Assertion 5 -- NO LITERAL CREDENTIAL IS COMMITTED. Every key in the template must still be
//     an `__UPPER_SNAKE__` placeholder. A real key here is a leaked key, not a config change, and
//     it is MORE dangerous in envoy.yaml than it was in kong.yml: the key is inlined into a Lua
//     string the filter compares against, so it appears in the file as ordinary source.
//
//   * Assertion 7 -- BOTH SUBSTITUTERS KNOW EVERY PLACEHOLDER. Compose's `supabase-envoy-init`
//     and the chart's initContainer each scan for leftovers AT RUNTIME, so a placeholder added to
//     the template and taught to only one of them is a per-target divergence that surfaces as a
//     boot failure on whichever target was forgotten. Comparing the three lists statically is
//     cheaper than discovering it on deploy.
//
// The ROUTE surface is no longer checkable from a file, and that is the point of `--runtime`: it
// asserts posture against a live gateway instead, in terms no gateway owns.
// =================================================================================================

const ENVOY_TEMPLATE = 'supabase/envoy.yaml';
const COMPOSE_FILE = 'docker-compose.yml';
const CHART_ENVOY = 'deploy/helm/acs-cymru/templates/supabase/envoy.yaml';

/** Substituted by BOTH targets. All three lists below must agree. */
const TEMPLATE_PLACEHOLDERS = [
  '__CORS_ORIGINS__',
  '__REALTIME_UPSTREAM_HOST__',
  '__SUPABASE_ANON_KEY__',
  '__SUPABASE_SERVICE_ROLE_KEY__',
];

const template = read(ENVOY_TEMPLATE);

// ---- 1. Every placeholder in the template is declared, and nothing else looks like one. --------
{
  // Comment lines are excluded for the reason the substituters exclude them: the template's header
  // documents the convention BY NAME, so a whole-file scan flags the documentation of the rule as
  // a violation of it.
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
      + 'Add them to TEMPLATE_PLACEHOLDERS and to BOTH substituters.'
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
  } else {
    pass(`${ENVOY_TEMPLATE} carries no literal credential`);
  }
}

// ---- 3. Both substituters handle every placeholder. --------------------------------------------
{
  const compose = read(COMPOSE_FILE);
  const chart = read(CHART_ENVOY);
  for (const [file, text] of [[COMPOSE_FILE, compose], [CHART_ENVOY, chart]]) {
    const missing = TEMPLATE_PLACEHOLDERS.filter((x) => !text.includes(x));
    if (missing.length) {
      fail(
        `${file} does not substitute ${missing.join(', ')}. Its own leftover scan would catch this `
        + 'at boot -- on that target only, which is how the two drift.'
      );
    } else {
      pass(`${file} substitutes all ${TEMPLATE_PLACEHOLDERS.length} placeholders`);
    }
  }
}

// ---- 4. Kong is actually gone. -----------------------------------------------------------------
{
  // Retiring a gateway means the config stops existing, not that it stops being referenced. A
  // leftover kong.yml is a file that looks authoritative and is read by nothing.
  let stale = false;
  try {
    read('supabase/kong.yml');
    stale = true;
  } catch { /* expected: it should be gone */ }

  if (stale) {
    fail(
      'supabase/kong.yml still exists. Envoy is the gateway on both targets; a leftover Kong '
      + 'config is a file that reads as authoritative and is loaded by nothing.'
    );
  } else {
    pass('supabase/kong.yml is gone');
  }
}

for (const line of ok) console.log(`  ok   ${line}`);
if (problems.length) {
  console.error('\nThe gateway template has drifted:\n');
  for (const problem of problems) console.error(`  ${problem}\n`);
  process.exit(1);
}
console.log(
  `\n${ENVOY_TEMPLATE} is consistent with both substituters. The ROUTE surface is not checkable `
  + 'from a file: run --runtime --authenticated against a live gateway for that.'
);
