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

// -------------------------------------------------------------------------------------------------
// A scanner for the shape kong.yml actually has, and for no other.
//
// Indentation carries the structure, and every level below is one this file uses. It is not a YAML
// parser and must not be reused as one: it understands scalars and single-level lists at the exact
// depths kong.yml puts them, which is enough to read the surface and nothing more.
//
// The one ambiguity is `- name:` at indent 6, which is a ROUTE under `routes:` and a PLUGIN under
// `plugins:` -- both indent-4 keys on a service. `mode` disambiguates them, and getting that wrong
// would silently report every gated service as ungated.
// -------------------------------------------------------------------------------------------------
function parseKong(text) {
  const out = { consumers: [], services: [], globalPlugins: [] };
  let section = null;          // 'consumers' | 'services' | 'plugins'
  let mode = null;             // within a service: 'routes' | 'plugins'
  let svc = null, route = null, plugin = null, consumer = null;

  for (const raw of text.split('\n')) {
    if (/^\s*#/.test(raw) || !raw.trim()) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();

    if (indent === 0) {
      section = /^(consumers|services|plugins):$/.test(line) ? line.slice(0, -1) : null;
      svc = route = plugin = consumer = null;
      mode = null;
      continue;
    }

    if (section === 'consumers') {
      if (indent === 2 && line.startsWith('- username:')) {
        consumer = { username: value(line), keys: [] };
        out.consumers.push(consumer);
      } else if (indent === 6 && line.startsWith('- key:') && consumer) {
        consumer.keys.push(value(line));
      }
      continue;
    }

    if (section === 'services') {
      if (indent === 2 && line.startsWith('- name:')) {
        svc = { name: value(line), url: null, plugins: [], routes: [] };
        out.services.push(svc);
        mode = null; route = plugin = null;
      } else if (indent === 4 && svc) {
        if (line.startsWith('url:')) svc.url = value(line);
        else if (line === 'routes:') { mode = 'routes'; route = plugin = null; }
        else if (line === 'plugins:') { mode = 'plugins'; route = plugin = null; }
      } else if (indent === 6 && line.startsWith('- name:') && svc) {
        if (mode === 'routes') {
          route = { name: value(line), strip: null, paths: [] };
          svc.routes.push(route);
        } else if (mode === 'plugins') {
          plugin = { name: value(line), config: {} };
          svc.plugins.push(plugin);
        }
      } else if (indent === 8 && mode === 'routes' && route) {
        if (line.startsWith('strip_path:')) route.strip = value(line) === 'true';
      } else if (indent === 10 && mode === 'routes' && route && line.startsWith('- /')) {
        route.paths.push(line.slice(2));
      } else if (indent === 10 && mode === 'plugins' && plugin && line.includes(': ')) {
        plugin.config[line.split(':')[0]] = value(line);
      }
      continue;
    }

    if (section === 'plugins') {
      if (indent === 2 && line.startsWith('- name:')) {
        plugin = { name: value(line), config: {} };
        out.globalPlugins.push(plugin);
      } else if (indent === 6 && plugin && line.includes(': ')) {
        plugin.config[line.split(':')[0]] = value(line);
      }
    }
  }
  return out;
}

/** The scalar after the first `:`, with any `- ` item marker already gone. */
function value(line) {
  const body = line.replace(/^-\s*/, '');
  return body.slice(body.indexOf(':') + 1).trim();
}

/**
 * REFUSE TO COMPARE A PARSE THAT CANNOT BE RIGHT.
 *
 * Every assertion below is a set difference, and a scanner that returned nothing would make all of
 * them pass: no unexpected services, no ungated routes, no literal keys. That is the shape of
 * vacuous success this check is most exposed to, so the parse is bounded before it is trusted --
 * against the file's own text rather than against EXPECTED, which is the thing under test.
 */
function assertParsed(kong, text) {
  // Counted from the raw text at the two depths that carry them, with no naming convention
  // assumed: inside the `services:` block, indent 2 is a service and indent 6 is a route OR a
  // service plugin -- the scanner has to account for every one of the latter, whichever bucket it
  // put it in. SCOPED TO THAT BLOCK, because the top-level `plugins:` list puts its own entries at
  // indent 2 and a whole-file count reads them as two more services.
  const lines = text.split(/\r?\n/);
  const from = lines.indexOf('services:');
  const to = lines.indexOf('plugins:');
  // Found while breaking this guard on purpose: with no `services:` key the scanner reads zero
  // services AND the bounded count reads zero, so the two agree and the guard waves a parse of
  // nothing through. The set assertions below do still fail -- but on nine missing services
  // rather than on the one real cause, which is the wrong thing to put in front of a reader.
  if (from === -1) {
    return KONG + ' has no top-level `services:` key, so the scanner read no routing surface at '
      + 'all. Nothing was compared.';
  }
  const servicesBlock = lines.slice(from, to === -1 ? lines.length : to).join('\n');
  const declaredServices = (servicesBlock.match(/^ {2}- name: /gm) || []).length;
  const declaredNested = (servicesBlock.match(/^ {6}- name: /gm) || []).length;
  const routes = kong.services.flatMap((s) => s.routes);
  const svcPlugins = kong.services.flatMap((s) => s.plugins);

  if (kong.services.length !== declaredServices) {
    return `the scanner read ${kong.services.length} service(s) from ${KONG} but the file declares `
      + `${declaredServices}. Every assertion below is a set difference and would pass vacuously on `
      + 'a short parse, so nothing was compared.';
  }
  if (routes.length + svcPlugins.length !== declaredNested) {
    return `the scanner read ${routes.length} route(s) and ${svcPlugins.length} service plugin(s) `
      + `from ${KONG}, which is ${routes.length + svcPlugins.length} of the ${declaredNested} nested `
      + 'entries the file declares. Nothing was compared -- see above.';
  }
  if (!kong.consumers.length || !kong.globalPlugins.length) {
    return 'the scanner read no consumers or no global plugins, which cannot be true of a working '
      + 'gateway config. Nothing was compared.';
  }
  return null;
}

// =================================================================================================
// The assertions.
// =================================================================================================
const kongText = read(KONG);
const kong = parseKong(kongText);

const parseProblem = assertParsed(kong, kongText);
if (parseProblem) {
  console.error(`\nThe gateway surface was NOT checked:\n\n  ${parseProblem}\n`);
  process.exit(1);
}

const expectedRoutes = new Map(EXPECTED.map((r) => [r.route, r]));
const actualRoutes = kong.services.flatMap((s) =>
  s.routes.map((r) => ({ ...r, service: s.name, gated: s.plugins.some((p) => p.name === 'key-auth') }))
);
log(`${kong.services.length} services, ${actualRoutes.length} routes, `
  + `${kong.globalPlugins.length} global plugin(s)`);

// -------------------------------------------------------------------------------------------------
// 1. The service set, exactly.
// -------------------------------------------------------------------------------------------------
{
  const want = new Set(EXPECTED.map((r) => r.service));
  const got = new Set(kong.services.map((s) => s.name));
  const added = [...got].filter((n) => !want.has(n));
  const removed = [...want].filter((n) => !got.has(n));

  if (added.length || removed.length) {
    fail(
      `${KONG} does not front the services this check records:\n`
      + (added.length ? `         added and unreviewed: ${added.join(', ')}\n` : '')
      + (removed.length ? `         recorded but gone:   ${removed.join(', ')}\n` : '')
      + '         A service added here has no recorded auth posture. Add it to EXPECTED in this\n'
      + '         script with the reason it is gated or open, so the migration in roadmap §4 has\n'
      + '         something to translate against.'
    );
  } else {
    pass(`the gateway fronts exactly the ${want.size} recorded services`);
  }
}

// -------------------------------------------------------------------------------------------------
// 2. The route set, its paths, and strip_path.
//
// `strip_path` is checked because it is load bearing rather than cosmetic: the edge runtime reads
// the first path segment to choose a worker, so `fplus-directory` needs the prefix PRESERVED and
// the userinfo routes need it REMOVED. The wrong one hands the runtime an empty service name and
// it answers 400 naming nothing -- which reads as a broken function, not a routing mistake.
// -------------------------------------------------------------------------------------------------
{
  const seen = new Set();
  let drift = 0;
  for (const r of actualRoutes) {
    seen.add(r.name);
    const want = expectedRoutes.get(r.name);
    if (!want) {
      drift += 1;
      fail(
        `route \`${r.name}\` on service \`${r.service}\` (${r.paths.join(', ') || 'no paths'}) is `
        + 'NOT in this check\'s inventory.\n'
        + '         This is the case the check exists for: a route nobody reviewed is open or '
        + 'gated\n         by accident rather than by decision. Add it to EXPECTED with its reason.'
      );
      continue;
    }
    if (want.service !== r.service) {
      drift += 1;
      fail(`route \`${r.name}\` has moved from service \`${want.service}\` to \`${r.service}\``);
    }
    if (JSON.stringify(want.paths) !== JSON.stringify(r.paths)) {
      drift += 1;
      fail(
        `route \`${r.name}\` no longer matches the recorded paths:\n`
        + `         recorded: ${want.paths.join(', ')}\n`
        + `         found:    ${r.paths.join(', ') || '(none)'}`
      );
    }
    if (want.strip !== r.strip) {
      drift += 1;
      fail(
        `route \`${r.name}\` has strip_path: ${r.strip}, recorded as ${want.strip}. `
        + 'For the fplus-directory\n         routes this is the difference between a working '
        + 'function and a bare 400.'
      );
    }
  }
  const missing = [...expectedRoutes.keys()].filter((n) => !seen.has(n));
  if (missing.length) {
    drift += 1;
    fail(`recorded route(s) no longer declared in ${KONG}: ${missing.join(', ')}`);
  }
  if (!drift) {
    pass(`all ${EXPECTED.length} routes match their recorded paths and strip_path`);
  }
}

// -------------------------------------------------------------------------------------------------
// 3. THE AUTH POSTURE OF EVERY ROUTE -- the assertion the rest of this file exists to support.
//
// `key-auth` is attached at the SERVICE level, so every route on a gated service is gated and every
// route on an ungated one is open. An open route must name one of the four recorded exemptions;
// there is no third state, and "open because nobody thought about it" is what this rejects.
// -------------------------------------------------------------------------------------------------
{
  let drift = 0;
  for (const r of actualRoutes) {
    const want = expectedRoutes.get(r.name);
    if (!want) continue;                                  // already reported by assertion 2
    const posture = r.gated ? 'key-auth' : 'open';
    if (posture === want.auth) continue;
    drift += 1;
    if (want.auth === 'key-auth') {
      fail(
        `route \`${r.name}\` (${r.paths.join(', ')}) IS RECORDED AS GATED AND IS NOW OPEN. `
        + `Service \`${r.service}\`\n         carries no key-auth plugin. `
        + (r.service === 'functions-v1'
          ? 'This is the most serious form of it: the edge\n         runtime boots with '
            + 'VERIFY_JWT="false", so an unauthenticated request can start any worker.'
          : 'Nothing in validate.py asserts the absence of\n         this change.')
      );
    } else {
      fail(
        `route \`${r.name}\` is recorded as an OPEN exemption (${want.exemption}) and is now gated `
        + 'by key-auth.\n         That is the safe direction, but it breaks the clients the '
        + 'exemption exists for:\n         ' + EXEMPTIONS[want.exemption]
      );
    }
  }

  const openRoutes = EXPECTED.filter((r) => r.auth === 'open');
  const unrecorded = openRoutes.filter((r) => !EXEMPTIONS[r.exemption]);
  if (unrecorded.length) {
    drift += 1;
    fail(`open route(s) naming no recorded exemption: ${unrecorded.map((r) => r.route).join(', ')}`);
  }

  if (!drift) {
    const gated = EXPECTED.filter((r) => r.auth === 'key-auth').length;
    const groups = new Set(openRoutes.map((r) => r.exemption)).size;
    pass(
      `${gated} route(s) are gated by key-auth and ${openRoutes.length} are open across the `
      + `${groups} recorded exemptions`
    );
  }
}

// -------------------------------------------------------------------------------------------------
// 4. The consumers, and NO LITERAL KEY MATERIAL.
//
// A rendered kong.yml committed over the template is not a config mistake, it is a published
// service-role key -- and it would look entirely normal in a diff. Both substituters write their
// output to a volume or a Secret precisely so the literal never reaches the repository, and this is
// the assertion that says the template stayed a template.
// -------------------------------------------------------------------------------------------------
{
  const got = kong.consumers.map((c) => c.username);
  const mismatch = JSON.stringify(got) !== JSON.stringify(EXPECTED_CONSUMERS);
  if (mismatch) {
    fail(
      `${KONG} registers consumers [${got.join(', ')}]; recorded is `
      + `[${EXPECTED_CONSUMERS.join(', ')}]. A third consumer is a third key the gateway accepts.`
    );
  }

  const literals = kong.consumers.flatMap((c) =>
    c.keys.filter((k) => !/^__[A-Z0-9_]+__$/.test(k)).map((k) => ({ user: c.username, k }))
  );
  if (literals.length) {
    fail(
      'A LITERAL API KEY IS COMMITTED IN ' + KONG + ':\n'
      + literals.map((l) => `         ${l.user}: ${l.k.slice(0, 12)}…`).join('\n')
      + '\n         This file is a TEMPLATE substituted at deploy time on both targets. A literal '
      + 'here is\n         a published credential -- rotate it, do not merely revert the file.'
    );
  } else if (!mismatch) {
    pass(`both consumers (${got.join(', ')}) still carry placeholders, not literal keys`);
  }
}

// -------------------------------------------------------------------------------------------------
// 5. The global plugins, and the config on each that is load bearing.
// -------------------------------------------------------------------------------------------------
{
  const got = kong.globalPlugins.map((p) => p.name);
  if (JSON.stringify([...got].sort()) !== JSON.stringify([...EXPECTED_GLOBAL_PLUGINS].sort())) {
    fail(
      `${KONG} declares global plugins [${got.join(', ')}]; recorded is `
      + `[${EXPECTED_GLOBAL_PLUGINS.join(', ')}].\n         Every plugin named here must ALSO be in `
      + 'KONG_PLUGINS on both targets: naming any plugin\n         there replaces the bundled set, '
      + 'so one missing stops Kong dead at boot.'
    );
  } else {
    pass(`the ${got.length} global plugins are exactly ${EXPECTED_GLOBAL_PLUGINS.join(' and ')}`);
  }

  const cors = kong.globalPlugins.find((p) => p.name === 'cors');
  if (!cors) {
    fail('the global `cors` plugin is gone. It is the stack\'s ONLY statement of origin policy -- '
      + 'the edge\n         functions deliberately declare none, so there is no second layer.');
  } else if (cors.config.origins !== '__CORS_ORIGINS__') {
    fail(
      `the cors plugin's origins is \`${cors.config.origins}\`, not the __CORS_ORIGINS__ `
      + 'placeholder.\n         Literal origins are what failed on Kubernetes: four localhost '
      + 'entries that were correct on\n         Compose, so the dashboard logged in and then showed '
      + 'empty tables while the gateway\n         reported 200 for every request.'
    );
  } else {
    pass('origin policy is still substituted from acs-cymru.corsOrigins, not written literally');
  }

  const prom = kong.globalPlugins.find((p) => p.name === 'prometheus');
  if (prom) {
    const off = PROMETHEUS_FLAGS.filter((f) => prom.config[f] !== 'true');
    if (off.length) {
      fail(
        `the prometheus plugin is missing ${off.join(', ')}. On Kong 3.x these default to FALSE, `
        + 'and\n         without them kong_http_status, kong_latency_* and kong_bandwidth all '
        + 'disappear while\n         /metrics keeps answering 200 -- an unmeasured gateway that '
        + 'reads as an idle one.'
      );
    } else {
      pass('the prometheus plugin keeps all three 3.x metric flags that default to false');
    }
  }
}

// -------------------------------------------------------------------------------------------------
// 6. THE PLACEHOLDER SET IS KNOWN TO BOTH SUBSTITUTERS.
//
// Each substituter already scans its own output for leftovers, but only AT RUNTIME -- so a
// placeholder added to the template and taught to only one of them is a boot failure on whichever
// target was forgotten, found by deploying rather than by reading. Three lists, compared here.
//
// kong.yml's header documents the convention by name, so the template's own list is read from value
// positions only; a `__PLACEHOLDER__` inside a comment is documentation, not a placeholder.
// -------------------------------------------------------------------------------------------------
{
  const valueLines = kongText.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const inTemplate = [...new Set(valueLines.match(/__[A-Z0-9_]+__/g) || [])].sort();
  const substituted = (text) => [...new Set(
    (text.match(/s\|__[A-Z0-9_]+__\|/g) || []).map((m) => m.slice(2, -1))
  )].sort();

  // SCOPED TO THE ONE SERVICE. docker-compose.yml holds several init containers that substitute
  // placeholders into other files -- Grafana's alerting, the BI reader's password, the Prometheus
  // URL -- and a whole-file scan reads their expressions as ones this template should have
  // declared. Three false positives, all of them real substitutions belonging to something else.
  const composeService = (text, name) => {
    const lines = text.split(/\r?\n/);
    const from = lines.findIndex((l) => l === `  ${name}:`);
    if (from === -1) return '';
    const after = lines.slice(from + 1).findIndex((l) => /^ {2}\S/.test(l));
    return lines.slice(from, after === -1 ? lines.length : from + 1 + after).join('\n');
  };

  const byCompose = substituted(composeService(read(COMPOSE), 'supabase-kong-init'));
  const byChart = substituted(read(CHART_KONG));

  if (!byCompose.length) {
    fail(
      'no `supabase-kong-init` service with sed substitutions was found in ' + COMPOSE + '.\n'
      + '         Either it was renamed or Compose no longer renders kong.yml -- and either way\n'
      + '         the placeholder comparison below examined nothing on that target.'
    );
  }

  const describe = (a, b) => [
    ...a.filter((p) => !b.includes(p)).map((p) => `+${p}`),
    ...b.filter((p) => !a.includes(p)).map((p) => `-${p}`),
  ];

  const drift = [];
  if (JSON.stringify(inTemplate) !== JSON.stringify(EXPECTED_PLACEHOLDERS)) {
    drift.push(`${KONG} declares ${describe(inTemplate, EXPECTED_PLACEHOLDERS).join(' ')} `
      + 'against this check\'s recorded set');
  }
  if (JSON.stringify(byCompose) !== JSON.stringify(inTemplate)) {
    drift.push(`supabase-kong-init in ${COMPOSE} substitutes `
      + `${describe(byCompose, inTemplate).join(' ')} against the template`);
  }
  if (JSON.stringify(byChart) !== JSON.stringify(inTemplate)) {
    drift.push(`the chart's initContainer substitutes ${describe(byChart, inTemplate).join(' ')} `
      + 'against the template');
  }

  if (drift.length) {
    fail(
      'THE THREE PLACEHOLDER LISTS DISAGREE:\n'
      + drift.map((d) => `         ${d}`).join('\n')
      + '\n         (+ is present there and not in the comparison; - is the reverse.)\n'
      + '         Each substituter scans for leftovers only at runtime, so this surfaces as Kong '
      + 'failing\n         to boot on whichever target was forgotten -- and only on that one.'
    );
  } else {
    pass(`all ${inTemplate.length} placeholders are substituted by both targets`);
  }
}

// -------------------------------------------------------------------------------------------------
// 7. kong.yml's own header states both counts, and they are the counts.
//
// The header is where a reader meets the exemptions, and it is the first thing a migration reads.
// It said "FOUR ROUTES ARE DELIBERATELY EXEMPT" and then listed four BULLETS covering six routes --
// two of them name a pair. Both numbers are true of something and neither was stated, so the header
// now carries both and this asserts them, the same way check-docs-drift.mjs treats a count claim.
// -------------------------------------------------------------------------------------------------
{
  const WORDS = { ZERO: 0, ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5, SIX: 6, SEVEN: 7, EIGHT: 8,
    NINE: 9, TEN: 10 };
  const claim = kongText.match(
    /(\w+) ROUTES ARE DELIBERATELY EXEMPT from `key-auth`, across (\w+) exemptions/
  );
  const openRoutes = EXPECTED.filter((r) => r.auth === 'open');
  const groups = new Set(openRoutes.map((r) => r.exemption)).size;

  if (!claim) {
    fail(
      `${KONG}'s header does not carry a "<N> ROUTES ARE DELIBERATELY EXEMPT from \`key-auth\`, `
      + 'across <N> exemptions" claim.\n         It is where a reader -- and a gateway migration -- '
      + 'meets the exemptions, so it states both\n         counts and this asserts them.'
    );
  } else if (WORDS[claim[1]] !== openRoutes.length || WORDS[claim[2]] !== groups) {
    fail(
      `${KONG}'s header claims ${claim[1]} exempt routes across ${claim[2]} exemptions; `
      + `the file has ${openRoutes.length} across ${groups}.`
    );
  } else {
    pass(`kong.yml's header claim of ${claim[1]} exempt routes across ${claim[2]} exemptions holds`);
  }

  const bullets = (kongText.match(/^#   \* `[^`]+`/gm) || []).length;
  if (claim && bullets !== groups) {
    fail(
      `${KONG}'s header lists ${bullets} exemption bullet(s) for ${groups} exemptions. `
      + 'Each exemption\n         carries its argument in the header and a note at its own service '
      + 'definition; one\n         without an argument is one nobody can safely translate.'
    );
  } else if (claim) {
    pass(`each of the ${groups} exemptions carries its argument in the header`);
  }
}

// -------------------------------------------------------------------------------------------------
// 8. THE DOCUMENT kong.yml POINTS READERS AT AGREES WITH kong.yml.
//
// The header ends "The full reasoning, and what the exemptions do and do not expose: supabase/
// README.md -> API Gateway (kong.yml)". That table said TWO deliberately open routes, and had done
// since the userinfo and Directory exemptions were added -- so the file that carries the argument
// for each exemption documented half of them, while every one had been argued for carefully in
// kong.yml itself. Found by writing this check, which is the only reason it is guarded now.
//
// Presence, not prose: every open route's path must appear in that section, and the count claim
// must match. What each exemption EXPOSES cannot be checked mechanically and is not attempted.
// -------------------------------------------------------------------------------------------------
{
  const WORDS = { ZERO: 0, ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5, SIX: 6, SEVEN: 7, EIGHT: 8,
    NINE: 9, TEN: 10 };
  const doc = 'supabase/README.md';
  const text = read(doc);
  const from = text.indexOf('## API Gateway (`kong.yml`)');
  const rest = from === -1 ? -1 : text.indexOf('\n## ', from + 1);
  const section = from === -1 ? '' : text.slice(from, rest === -1 ? undefined : rest);

  const openRoutes = EXPECTED.filter((r) => r.auth === 'open');
  const groups = new Set(openRoutes.map((r) => r.exemption)).size;

  if (!section) {
    fail(`${doc} has no "## API Gateway (\`kong.yml\`)" section, and kong.yml's header sends `
      + 'readers to it for\n         the full reasoning behind every exemption.');
  } else {
    const claim = section.match(
      /\*\*(\w+) routes are deliberately open, across (\w+) exemptions\*\*/i
    );
    const missing = openRoutes.flatMap((r) => r.paths).filter((path) => !section.includes(path));

    if (!claim) {
      fail(`${doc}'s gateway section carries no "**<N> routes are deliberately open, across <N> `
        + 'exemptions**"\n         claim to check.');
    } else if (WORDS[claim[1].toUpperCase()] !== openRoutes.length
               || WORDS[claim[2].toUpperCase()] !== groups) {
      fail(
        `${doc} claims ${claim[1]} open routes across ${claim[2]} exemptions; kong.yml has `
        + `${openRoutes.length} across ${groups}.\n         This is the drift that was already `
        + 'there when the check was written.'
      );
    } else if (missing.length) {
      fail(
        `${doc}'s gateway section does not name open route(s): ${missing.join(', ')}.\n`
        + '         An exemption whose argument is written down in only one of the two files is one\n'
        + '         a gateway migration can drop without contradicting anything it reads.'
      );
    } else {
      pass(`${doc} documents all ${openRoutes.length} open routes across ${groups} exemptions`);
    }
  }
}

// =================================================================================================
for (const line of ok) console.log(`  ok   ${line}`);
if (problems.length) {
  console.error('\nThe gateway surface has drifted from what was reviewed:\n');
  for (const p of problems) console.error(`  ${p}\n`);
  console.error(
    'EXPECTED in this script is the reviewed surface, not a mirror of kong.yml. If a change here\n'
    + 'is intended, change EXPECTED in the same commit and say why -- that record is what roadmap\n'
    + '§4 (Kong -> Envoy) has to translate against, and the exemptions are the part a mechanical\n'
    + 'translation gets wrong without failing any test that exists today.\n'
  );
  process.exit(1);
}
console.log(
  `\nThe gateway fronts ${kong.services.length} services over ${actualRoutes.length} routes: `
  + `${EXPECTED.filter((r) => r.auth === 'key-auth').length} gated by key-auth, `
  + `${EXPECTED.filter((r) => r.auth === 'open').length} open across `
  + `${new Set(EXPECTED.filter((r) => r.auth === 'open').map((r) => r.exemption)).size} `
  + 'recorded exemptions.'
);
