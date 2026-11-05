#!/usr/bin/env node
/**
 * Assert the API gateway's routing and authentication surface against a declared inventory.
 * `validate.py` asserts the 401s that should happen; nothing can assert the absence of a route
 * nobody wrote, and a gateway change that quietly widened an exemption would pass every other
 * test. Three modes: (default) template hygiene over `supabase/envoy.yaml`: every credential is
 * still an `__UPPER_SNAKE__` placeholder, the placeholder set is known to the substituter, every
 * API route has a row in EXPECTED, each exemption sits above the gate it is carved out of, and the
 * API listener keeps its sign-in limit, response headers and access log, admits an app's token
 * on /auth/v1/ and APP_ROUTES alone, and asks consent-gate on GoTrue's consent endpoints alone,
 * failing closed. `--runtime`: the route surface against a live gateway, every row in EXPECTED,
 * gated routes refused before their upstream and open ones through, the response headers present,
 * a burst of password grants from one client address refused with 429 while another address
 * and a token refresh pass, and every other spelling of the consent prefix answered by the gateway
 * itself. The burst names its addresses in X-Forwarded-For, which the gateway trusts from a
 * direct caller only: run it against a port-forward. `--authenticated`: extends --runtime with
 * a credentialled pass, presenting a valid key by header and by query and an unregistered key,
 * and asserting that on a route which hides credentials the header and query forms are
 * indistinguishable upstream, that a token naming an app which verifies against no key still
 * reaches its upstream, and that GoTrue refuses dynamic OAuth client registration to the
 * publishable key. `--consent`: extends --runtime with the consent step's decisions, for two
 * throwaway people it makes with the secret key: a Shopfloor Manager at aal1 refused on both
 * consent calls while MFA is required, and admitted for Grafana and once it is not; an Operator
 * admitted. It turns security.require_mfa_for_managers on and back to what it found, which ends
 * every covered person's app sessions but Grafana's, and deletes both people. Every mode shares
 * EXPECTED so two inventories cannot drift.
 *
 * Usage: node scripts/check-gateway-surface.mjs | --runtime [baseUrl] | --runtime
 * --authenticated [baseUrl] (needs SUPABASE_PUBLISHABLE_KEY) | --runtime --consent [baseUrl] (needs
 * SUPABASE_PUBLISHABLE_KEY and SUPABASE_SECRET_KEY). The base URL is the first non-flag argument,
 * or SUPABASE_URL. No dependencies: this runs in CI before any `npm install`, and the runtime modes
 * use `node:http`; see probeOnce.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');

const problems = [];
const ok = [];
const fail = (m) => problems.push(m);
const pass = (m) => ok.push(m);


// The inventory. This is the specification, not a mirror of the file: a row is a claim that this
// route is meant to exist with this posture, and a route added to the gateway without a row here
// fails.

/** The five recorded exemptions, and what each one is for. Open routes must name one of these. */
const EXEMPTIONS = {
  'sign-in': 'sign-in must work before a session exists; GoTrue authenticates its own callers',
  'public-objects': 'an AAS File URL must resolve with no session',
  'oauth-userinfo': 'an OAuth client sends client credentials, never a Supabase apikey',
  'fplus-directory':
    '`/ping` is open by specification; `/v1/` is authenticated by the FUNCTION, not the gateway',
  'aas-api':
    'a standard AAS client sends a bearer token and no apikey; `/description` is open by '
    + 'specification, and every other route is authenticated by the FUNCTION, not the gateway',
};

const EXPECTED = [
  // The same exemption under the sign-in limit; POST only, so the burst below probes it.
  { service: 'auth-v1', route: 'auth-v1-limited-routes', paths: ['/auth/v1/token', '/auth/v1/recover'],
    strip: true, auth: 'open', exemption: 'sign-in',
    probe: null, marker: null, unprobeable: 'POST only; the sign-in limit pass sends to it' },

  // GoTrue's consent endpoints, behind consent-gate (assertion 8). Open as sign-in is, so the
  // evidence is the gate's own answer to no bearer, which GoTrue never words this way.
  { service: 'auth-v1', route: 'auth-v1-consent-routes', paths: ['/auth/v1/oauth/authorizations/'], strip: true,
    auth: 'open', exemption: 'sign-in',
    probe: '/auth/v1/oauth/authorizations/gateway-surface-probe', marker: '"msg":"Sign in to the dashboard first' },

  // A refusal, not a route to an upstream: every other spelling of that prefix, answered 404 by the
  // gateway after the key check. The consent-spellings pass of --runtime sends them.
  { service: 'auth-v1', route: 'auth-v1-consent-spellings', paths: ['/auth/v1/'], strip: false,
    auth: 'refused', probe: null, marker: null,
    unprobeable: 'answers other spellings of the consent prefix only; the consent-spellings pass sends them' },

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

  // Refusals, not routes to an upstream: the gateway answers 400, after the key check, to multipart
  // storage-api's parser must not see. Above both storage routes (assertion 6); the multipart pass
  // of --authenticated probes them.
  { service: 'storage-v1', route: 'storage-v1-long-boundary', paths: ['/storage/v1/'], strip: false,
    auth: 'refused', probe: null, marker: null,
    unprobeable: 'answers a multipart Content-Type only; the multipart pass of --authenticated sends one' },
  { service: 'storage-v1', route: 'storage-v1-unreadable-multipart', paths: ['/storage/v1/'], strip: false,
    auth: 'refused', probe: null, marker: null,
    unprobeable: 'answers a multipart Content-Type only; the multipart pass of --authenticated sends one' },

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

  // A prefix, before the catch-all; the rewrite keeps `/aas-api/` so the runtime picks the worker.
  { service: 'functions-v1-aas-api', route: 'functions-v1-aas-api-routes',
    paths: ['/functions/v1/aas-api/'], strip: true,
    auth: 'open', exemption: 'aas-api',
    probe: '/functions/v1/aas-api/description', marker: '"profiles"' },

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
  // Probed through the Directory's /ping, which answers without a token once the gate admits it.
  { service: 'functions-v1', route: 'functions-v1-routes', paths: ['/functions/v1/'], strip: true,
    auth: 'key-auth',
    probe: '/functions/v1/fplus-directory/ping', marker: '"service":"fplus-directory"' ,
    authMarker: 'fplus-directory', hides: true},
];

/**
 * Content-Types for the two multipart refusals, and whether the gateway must refuse each. A boundary
 * is 1 to 70 characters (RFC 2046 5.1.1). storage-api's parser, busboy, also reads one spelt with
 * spaces, quotes or `boundary*=charset''`, and stalls on one of exactly 252 bytes.
 */
const a = (n) => 'a'.repeat(n);
const MULTIPART_CASES = [
  { name: 'a browser\'s', contentType: 'multipart/form-data; boundary=----WebKitFormBoundary7MA4YWxkTrZu0gW', refused: false },
  { name: '70 characters', contentType: `multipart/form-data; boundary=${a(70)}`, refused: false },
  { name: '70 quoted, with a space', contentType: `multipart/form-data; boundary="${a(30)} ${a(39)}"`, refused: false },
  { name: '70 quoted, then a charset', contentType: `multipart/form-data; boundary="${a(70)}"; charset=utf-8`, refused: false },
  { name: 'exactly 200 characters', contentType: `multipart/form-data; boundary=abc; x=${a(163)}`, refused: false },
  { name: 'not multipart', contentType: `text/plain; x=${a(300)}`, refused: false },
  { name: '71 characters', contentType: `multipart/form-data; boundary=${a(71)}`, refused: true },
  { name: '71 quoted', contentType: `multipart/form-data; boundary="${a(71)}"`, refused: true },
  { name: '71 in capitals', contentType: `MULTIPART/FORM-DATA; BOUNDARY=${a(71)}`, refused: true },
  { name: 'the 252 that stalls busboy', contentType: `multipart/form-data; boundary=${a(252)}`, refused: true },
  { name: 'boundary*=utf-8\'\'', contentType: `multipart/form-data; boundary*=utf-8''${a(252)}`, refused: true },
  { name: 'boundary*=ucs2\'\', which busboy widens', contentType: `multipart/form-data; boundary*=ucs2''${a(160)}`, refused: true },
  { name: 'a quoted semicolon', contentType: `multipart/form-data; boundary="${a(120)};${a(131)}"`, refused: true },
  { name: 'spaces, which busboy drops', contentType: `multipart/form-data; boundary=${Array(26).fill(a(10)).join(' ')}`, refused: true },
  { name: 'empty quotes, which busboy drops', contentType: `multipart/form-data; boundary=${Array(63).fill(a(4)).join('""')}`, refused: true },
  { name: 'a spaced-out key', contentType: `multipart/form-data; b o u n d a r y = ${Array(26).fill(a(10)).join(' ')}`, refused: true },
  { name: 'a byte outside ASCII', contentType: 'multipart/form-data; boundary=abc\xffdef', refused: true },
  { name: '201 characters', contentType: `multipart/form-data; boundary=abc; x=${a(164)}`, refused: true },
];

/**
 * What a token GoTrue's OAuth server issued to an app reaches on the API listener, by the app's
 * client id: /auth/v1/, which every app's does, and these functions. Grafana and Node-RED call their
 * userinfo function here. The Studio and forge doors call theirs from their own listeners, straight
 * to the edge runtime, so they reach /auth/v1/ alone, as an app not listed does. Mirror check 48
 * holds the ids to stack_app_ids() and the functions to the ones that exist.
 */
const APP_ROUTES = {
  'c0ffee00-0000-4000-8000-000000000001': { app: 'Grafana', functions: ['grafana-userinfo'] },
  'c0ffee00-0000-4000-8000-000000000002': { app: 'Node-RED', functions: ['nodered-userinfo'] },
  'c0ffee00-0000-4000-8000-000000000003': { app: "Studio's door", functions: [] },
  'c0ffee00-0000-4000-8000-000000000004': { app: "the forge's door", functions: [] },
};

/** The gateway's answer to an app's token off its own routes; clients and this script read it. */
const APP_REFUSAL = '{"message":"This token was issued to an app, and reaches only that app\'s own routes"}';

/**
 * The consent step: GoTrue's consent endpoints, the one route the gateway asks consent-gate on.
 * Its refusal is GoTrue's error shape with MFA_REFUSAL_CODE, pointing to Profile › MFA; its 401
 * to no bearer carries CONSENT_NO_BEARER. Every other spelling of the prefix is the gateway's own
 * 404. GoTrue's router matches the path as sent, case-sensitively and with no slash cleaning or
 * decoding of an encoded slash, so it would answer each of these with its own 404, never with its
 * consent handler.
 */
const CONSENT_PREFIX = '/auth/v1/oauth/authorizations/';
const CONSENT_NO_BEARER = '"msg":"Sign in to the dashboard first';
const CONSENT_SPELLING_BODY = 'The consent endpoints are';
const MFA_REFUSAL_CODE = 'mfa_required';
const CONSENT_SPELLINGS = [
  { name: 'a doubled slash', path: '/auth/v1//oauth/authorizations/gateway-surface-probe' },
  { name: 'an upper-case segment', path: '/auth/v1/OAUTH/authorizations/gateway-surface-probe' },
  { name: 'an upper-case prefix', path: '/AUTH/v1/oauth/authorizations/gateway-surface-probe' },
  { name: 'an encoded slash after authorizations', path: '/auth/v1/oauth/authorizations%2Fgateway-surface-probe' },
  { name: 'an encoded slash before authorizations', path: '/auth/v1/oauth%2Fauthorizations/gateway-surface-probe' },
];
/** Paths the spellings route must leave to the routes after it. */
const NOT_CONSENT_SPELLINGS = ['/auth/v1/health', '/auth/v1/oauth/authorize', '/auth/v1/oauth/token'];

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
/** Extends --runtime with the consent step's decisions. See the block at the end of that mode. */
const CONSENT = process.argv.includes('--consent');

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
   * socket. No headers beyond Accept unless given; a GET unless `method` and `body` are given.
   */
  const probeOnce = (url, extraHeaders = {}, { method = 'GET', body: payload = null } = {}) =>
    new Promise((resolveProbe) => {
      let mod, opts;
      try {
        const u = new URL(url);
        mod = u.protocol === 'https:' ? https : http;
        opts = {
          method,
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: `${u.pathname}${u.search}`,
          headers: {
            Accept: '*/*',
            ...(payload === null ? {} : { 'Content-Length': Buffer.byteLength(payload) }),
            ...extraHeaders,
          },
          agent: false,
        };
      } catch (err) {
        resolveProbe({ status: 0, body: '', headers: {}, error: `unparseable URL: ${err.message}` });
        return;
      }

      const req = mod.request(opts, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolveProbe({ status: res.statusCode, body, headers: res.headers, error: null }));
      });
      req.setTimeout(15000, () => {
        req.destroy();
        resolveProbe({ status: 0, body: '', headers: {}, error: 'timed out after 15s' });
      });
      req.on('error', (err) => resolveProbe({ status: 0, body: '', headers: {}, error: err.message }));
      req.end(payload === null ? undefined : payload);
    });

  const results = await Promise.all(probes.map(async (row) => {
    const { status, body, headers, error } = await probeOnce(`${base}${row.probe}`);
    return { row, status, body, headers, error };
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

  // Response headers. nosniff on every routed response, the gateway's own refusals included;
  // no-store on sign-in; Strict-Transport-Security wherever the gateway is reached over https.
  {
    const answered = results.filter((r) => !r.error);
    const sniffable = answered.filter((r) => r.headers['x-content-type-options'] !== 'nosniff');
    if (sniffable.length) {
      runtimeProblems.push(
        `${sniffable.map((r) => r.row.probe).join(', ')} answered without X-Content-Type-Options: nosniff, `
        + 'which the API listener adds to every routed response (route_config response_headers_to_add).'
      );
    } else if (answered.length) {
      runtimeOk.push(`every probed route answers X-Content-Type-Options: nosniff, refusals included`);
    }
    const signIn = answered.find((r) => r.row.route === 'auth-v1-routes');
    if (signIn && !/\bno-store\b/.test(signIn.headers['cache-control'] || '')) {
      runtimeProblems.push(
        `${signIn.row.probe} answered Cache-Control ${JSON.stringify(signIn.headers['cache-control'] || '')}, `
        + 'not no-store: the sign-in routes carry tokens no cache may keep.'
      );
    } else if (signIn) {
      runtimeOk.push(`${signIn.row.probe} answers Cache-Control: no-store`);
    }
    if (base.startsWith('https:')) {
      const unpinned = answered.filter((r) => !r.headers['strict-transport-security']);
      if (unpinned.length) {
        runtimeProblems.push(
          `${unpinned.map((r) => r.row.probe).join(', ')} answered over https without `
          + 'Strict-Transport-Security, which the chart sets when global.scheme is https.'
        );
      } else {
        runtimeOk.push('every probed route answers Strict-Transport-Security over https');
      }
    }
  }

  // The sign-in limit. Wrong-password grants from one client address until the gateway itself
  // refuses one: a 429 with no x-envoy-upstream-service-time, which only an upstream's answer
  // carries. Then a grant from another address and a refresh from the first must reach GoTrue. The
  // addresses are fresh documentation addresses (2001:db8::/32), so no earlier run's bucket is spent.
  {
    const burst = Number(process.env.SIGN_IN_BURST || 20);
    const hex = () => randomBytes(2).toString('hex');
    const address = () => `2001:db8::${hex()}:${hex()}`;
    const grant = (from, query, payload) => probeOnce(
      `${base}/auth/v1/token?${query}`,
      { 'Content-Type': 'application/json', 'X-Forwarded-For': from },
      { method: 'POST', body: JSON.stringify(payload) },
    );
    const password = () => ({ email: `gateway-surface-${hex()}${hex()}@aber.invalid`, password: 'not-the-password' });
    const byGateway = (r) => r.status === 429 && !r.headers['x-envoy-upstream-service-time'];
    const reachedGoTrue = (r) => !r.error && Boolean(r.headers['x-envoy-upstream-service-time']);

    const first = address();
    let refusal = null;
    let sent = 0;
    let transport = null;
    while (!refusal && sent < burst) {
      const r = await grant(first, 'grant_type=password', password());
      sent += 1;
      if (r.error) { transport = r.error; break; }
      if (byGateway(r)) refusal = r;
    }

    if (transport) {
      runtimeProblems.push(`the sign-in limit pass could not reach /auth/v1/token -- ${transport}`);
    } else if (!refusal) {
      runtimeProblems.push(
        `${burst} password grants from one client address within seconds were never refused by the `
        + 'gateway. The sign-in limit is off (supabaseEnvoy.signInRateLimit) or not keyed on the '
        + 'client address; or this ran through an ingress, which replaces the X-Forwarded-For it names.'
      );
    } else {
      const shapeProblems = [];
      if (!refusal.body.includes('over_request_rate_limit')) {
        shapeProblems.push(`its body is not GoTrue's over_request_rate_limit shape (${refusal.body.slice(0, 120)})`);
      }
      if (refusal.headers['x-content-type-options'] !== 'nosniff'
        || !/\bno-store\b/.test(refusal.headers['cache-control'] || '')) {
        shapeProblems.push('it lacks nosniff or Cache-Control: no-store');
      }
      const [other, refresh] = [
        await grant(address(), 'grant_type=password', password()),
        await grant(first, 'grant_type=refresh_token', { refresh_token: 'not-a-refresh-token' }),
      ];
      if (!reachedGoTrue(other)) {
        shapeProblems.push(
          `a grant from a different address did not reach GoTrue (HTTP ${other.status || other.error}): `
          + 'the limit is shared rather than per client'
        );
      }
      if (!reachedGoTrue(refresh)) {
        shapeProblems.push(
          `a token refresh from the refused address did not reach GoTrue (HTTP ${refresh.status || refresh.error}): `
          + 'refreshes are not limited, since every open dashboard tab sends them'
        );
      }
      if (shapeProblems.length) {
        runtimeProblems.push(`the gateway refused password grant ${sent} with 429, but ${shapeProblems.join('; ')}.`);
      } else {
        runtimeOk.push(
          `the gateway refused password grant ${sent} from one address with 429; another address and a `
          + 'refresh from the first still reached GoTrue'
        );
      }
    }
  }

  // The consent step. With no bearer, consent-gate answers its own 401, so the gateway asked it; an
  // answer of its own carries no x-envoy-upstream-service-time, which only an upstream's has. Each
  // other spelling of the prefix is the gateway's 404, after the key check, which a run without the
  // publishable key meets first. CONSENT_SPELLINGS says what GoTrue would do with each.
  let consentKeyless = false;
  {
    const key = process.env.SUPABASE_PUBLISHABLE_KEY || '';
    consentKeyless = !key;
    const withKey = key ? { apikey: key } : {};
    const own = (r) => !r.error && !r.headers['x-envoy-upstream-service-time'];
    const before = runtimeProblems.length;
    const gate = await probeOnce(`${base}${CONSENT_PREFIX}gateway-surface-${randomBytes(4).toString('hex')}`, withKey);
    if (gate.error) {
      runtimeProblems.push(`the consent route could not be reached -- ${gate.error}`);
    } else if (gate.status !== 401 || !gate.body.includes(CONSENT_NO_BEARER) || !own(gate)) {
      runtimeProblems.push(
        `${CONSENT_PREFIX}<id> with no bearer answered HTTP ${gate.status} (${gate.body.slice(0, 120)}), not consent-gate's `
        + '401 from the gateway itself. The consent step is not asked, and an app\'s sign-in is approved whatever MFA requires.'
      );
    }
    for (const s of CONSENT_SPELLINGS) {
      const r = await probeOnce(`${base}${s.path}`, withKey);
      if (r.error) {
        runtimeProblems.push(`${s.path} (${s.name}): ${r.error}`);
      } else if (!own(r)) {
        runtimeProblems.push(`${s.path} (${s.name}) reached an upstream (HTTP ${r.status}): another spelling of the consent prefix passes the gateway unasked.`);
      } else if (key ? r.status !== 404 || !r.body.includes(CONSENT_SPELLING_BODY) : r.status !== 401) {
        runtimeProblems.push(
          `${s.path} (${s.name}) answered HTTP ${r.status} (${r.body.slice(0, 120)}), not the gateway's `
          + `${key ? '404 for another spelling of the consent prefix' : '401 from the key check'}.`
        );
      }
    }
    if (runtimeProblems.length === before) {
      runtimeOk.push(
        `the consent route asks consent-gate, and ${CONSENT_SPELLINGS.length} other spellings of its prefix are `
        + `the gateway's own ${key ? '404' : '401 (the key check, as no publishable key was given)'}`
      );
    }
  }

  for (const line of runtimeOk) console.log(`  ok   ${line}`);
  if (consentKeyless) {
    console.log('  --   consent spellings: set SUPABASE_PUBLISHABLE_KEY to see each answered 404 past the key check');
  }
  for (const row of unprobeable) {
    console.log(`  --   ${row.route}: declared ${row.auth}, ${row.unprobeable || 'not probeable over plain HTTP'}`);
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
        + 'Export it: kubectl -n aber get secret aber-secrets -o jsonpath={.data.SUPABASE_PUBLISHABLE_KEY} | base64 -d\n'
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

    // The multipart pass (assertion 6 of the template mode). Each request carries the key, so the
    // gate admits it. Refused ones must be answered by the gateway, without an upstream timing
    // header. A 70-character boundary must reach storage-api, which reads the form and then refuses
    // the anonymous upload itself. The S3 protocol, which reads a form before any credential, must
    // answer storage-api's 404 because the chart turns it off.
    {
      const UPLOAD = '/storage/v1/object/asset-3d-models/__gateway_probe__.bin';
      const S3 = '/storage/v1/s3/asset-3d-models';
      const form = (boundary) => [`--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="probe.bin"',
        'Content-Type: application/octet-stream', '', 'probe', `--${boundary}--`, ''].join('\r\n');
      const send = (path, contentType, boundary) => probeOnce(`${base}${path}`,
        { apikey: anonKey, 'Content-Type': contentType }, { method: 'POST', body: form(boundary) });
      const upstream = (r) => r.headers['x-envoy-upstream-service-time'] !== undefined;
      const b70 = 'a'.repeat(70);
      const b71 = 'a'.repeat(71);
      const b252 = 'a'.repeat(252);
      const checks = [
        ['a 71-character boundary to an upload', await send(UPLOAD, `multipart/form-data; boundary=${b71}`, b71),
          (r) => r.status === 400 && !upstream(r) && r.body.includes('longer than 70'), 'the gateway\'s 400'],
        ['the 252-character boundary busboy loops on, to the S3 protocol', await send(S3, `multipart/form-data; boundary=${b252}`, b252),
          (r) => r.status === 400 && !upstream(r) && r.body.includes('longer than 70'), 'the gateway\'s 400'],
        ['a 201-character multipart Content-Type', await send(UPLOAD, `multipart/form-data; boundary=${b70}; x=${'a'.repeat(97)}`, b70),
          (r) => r.status === 400 && !upstream(r) && r.body.includes('printable ASCII'), 'the gateway\'s 400'],
        ['a 70-character boundary to an upload', await send(UPLOAD, `multipart/form-data; boundary=${b70}`, b70),
          (r) => upstream(r) && r.status >= 400 && r.body.includes('statusCode'), 'storage-api\'s own refusal of an anonymous upload'],
        ['a 70-character boundary to the S3 protocol', await send(S3, `multipart/form-data; boundary=${b70}`, b70),
          (r) => upstream(r) && r.status === 404, 'storage-api\'s 404: the S3 protocol is off'],
      ];
      for (const [what, r, okay, want] of checks) {
        if (r.error) authProblems.push(`multipart pass, ${what}: ${r.error}`);
        else if (!okay(r)) {
          authProblems.push(
            `multipart pass: ${what} answered HTTP ${r.status}${upstream(r) ? ' from storage-api' : ' from the gateway'} `
            + `(${r.body.slice(0, 120)}), not ${want}. See supabase/envoy.yaml, storage-v1-long-boundary.`
          );
        }
      }
      if (!checks.some(([, r, okay]) => r.error || !okay(r))) {
        authOk.push('multipart: boundaries over 70 characters and oversized Content-Types are refused by the gateway, '
          + 'a 70-character one reaches storage-api, and its S3 protocol is off');
      }
    }

    // Every OAuth client the stack uses is seeded, and a token issued to any client carries its
    // person's whole role. An empty registration is refused whether or not registration is on, so
    // this creates nothing; only the refusal's reason tells the two apart.

    // An app's token reaches only its own routes, decided on the VERIFIED client_id: a token that
    // names Grafana's client and verifies against no key goes on, as any unverifiable token does, to
    // be refused by its upstream. On PostgREST, which answers it itself, and on Node-RED's userinfo,
    // which is not Grafana's route and asks GoTrue. A real app's token is the stack lane's
    // (supabase/test_each_app_s_token_reaches_only_its_own_routes.py): only GoTrue can issue one.
    {
      const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const unverifiable = [
        b64({ alg: 'ES256', typ: 'JWT', kid: 'gateway-surface-probe' }),
        b64({ sub: randomUUID(), role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 300,
          client_id: Object.keys(APP_ROUTES)[0] }),
        randomBytes(64).toString('base64url'),
      ].join('.');
      for (const [path, marker] of [['/rest/v1/cells?select=id', '"code":"PGRST'], ['/functions/v1/nodered-userinfo', '"error"']]) {
        const res = await probeOnce(`${base}${path}`, { apikey: anonKey, Authorization: `Bearer ${unverifiable}` });
        if (res.error) {
          authProblems.push(`${path} with an unverifiable app token: ${res.error}`);
        } else if (res.body.includes(APP_REFUSAL) || !res.body.includes(marker)) {
          authProblems.push(
            `${path}: a token naming an app that verifies against no key did not reach its upstream (HTTP ${res.status}: `
            + `${res.body.slice(0, 120)}). The app check must decide on a verified client_id alone, or anyone can `
            + 'have a request refused by writing one.'
          );
        } else {
          authOk.push(`${path}: a token naming an app that verifies against no key reaches its upstream, which refuses it (HTTP ${res.status})`);
        }
      }
      console.log("  --   an app's own token: issued by GoTrue alone, so the stack lane holds its routes");
    }

    // Every OAuth client the stack uses is seeded, and a client nobody reviewed should not exist to be
    // approved. An empty registration is refused whether or not registration is on, so this creates
    // nothing; only the refusal's reason tells the two apart.
    {
      const label = 'dynamic OAuth client registration (/auth/v1/oauth/clients/register)';
      const res = await probeOnce(
        `${base}/auth/v1/oauth/clients/register`,
        { apikey: anonKey, 'Content-Type': 'application/json' },
        { method: 'POST', body: '{}' },
      );
      if (res.error) {
        authProblems.push(`${label}: ${res.error}`);
      } else if (res.status === 403 && res.body.includes('oauth_dynamic_client_registration_disabled')) {
        authOk.push('GoTrue refuses dynamic OAuth client registration to the publishable key');
      } else {
        authProblems.push(
          `${label} answered HTTP ${res.status} (${res.body.slice(0, 120)}), not GoTrue's 403 `
          + 'oauth_dynamic_client_registration_disabled. Anyone holding the publishable key could '
          + 'register a client and ask a person to approve it: GOTRUE_OAUTH_SERVER_ALLOW_DYNAMIC_REGISTRATION '
          + 'must be "false" (deploy/helm/aber/templates/supabase/auth.yaml).'
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
      + 'unregistered one; GoTrue registers no OAuth client itself.'
    );
  }

  // Consent mode: `--runtime --consent`. What consent-gate decides, for two throwaway people the
  // secret key makes: a Shopfloor Manager and an Operator, each signed in with a password (aal1,
  // with no factor). Each sign-in it starts is denied, so nothing is approved. The switch goes back
  // to the value it found, and both people are deleted, whatever failed.
  if (CONSENT) {
    const anonKey = process.env.SUPABASE_PUBLISHABLE_KEY || '';
    const secretKey = process.env.SUPABASE_SECRET_KEY || '';
    if (!anonKey || !secretKey) {
      console.error(
        '\n--consent needs SUPABASE_PUBLISHABLE_KEY and SUPABASE_SECRET_KEY: the secret key makes the two\n'
        + 'people and turns the switch, and nothing else here can. Refusing rather than skipping.\n'
      );
      process.exit(1);
    }

    const GRAFANA = 'c0ffee00-0000-4000-8000-000000000001';
    const NODE_RED = 'c0ffee00-0000-4000-8000-000000000002';
    const SWITCH = '/rest/v1/system_settings?key=eq.security.require_mfa_for_managers';
    const asService = { apikey: secretKey, Authorization: `Bearer ${secretKey}` };
    const consentProblems = [];
    const consentOk = [];
    const parsed = (r) => { try { return JSON.parse(r.body); } catch { return null; } };
    const send = (path, headers, method = 'GET', payload) => probeOnce(
      `${base}${path}`,
      payload === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
      { method, body: payload === undefined ? null : JSON.stringify(payload) },
    );
    const asPerson = (token) => ({ apikey: anonKey, Authorization: `Bearer ${token}` });
    const details = (id, token) => send(`${CONSENT_PREFIX}${id}`, asPerson(token));
    const deny = (id, token) => send(`${CONSENT_PREFIX}${id}/consent`, asPerson(token), 'POST', { action: 'deny' });
    const refusedForMfa = (r) => r.status === 403 && parsed(r)?.error_code === MFA_REFUSAL_CODE
      && String(parsed(r)?.msg || '').includes('Profile › MFA') && !r.headers['x-envoy-upstream-service-time'];
    const passedGate = (r) => !r.error && parsed(r)?.error_code !== MFA_REFUSAL_CODE
      && Boolean(r.headers['x-envoy-upstream-service-time']);
    const said = (r) => (r.error ? r.error : `HTTP ${r.status}: ${r.body.slice(0, 160)}`);

    const read = await send(`${SWITCH}&select=value`, asService);
    const found = parsed(read);
    if (read.status !== 200 || !Array.isArray(found) || found.length !== 1) {
      console.error(`\nThe switch security.require_mfa_for_managers could not be read (${said(read)}).\n`);
      process.exit(1);
    }
    const wasOn = found[0].value === true;
    const setSwitch = async (on) => {
      const r = await send(SWITCH, { ...asService, Prefer: 'return=representation' }, 'PATCH', { value: on });
      if (r.status !== 200 || parsed(r)?.[0]?.value !== on) throw new Error(`the switch could not be turned ${on ? 'on' : 'off'} (${said(r)})`);
    };

    // The sign-in limit is shared with the burst above: a 429 from the gateway is waited out.
    const signIn = async (email, password) => {
      for (const wait of [0, 2, 4, 8, 16, 30]) {
        if (wait) await new Promise((done) => setTimeout(done, wait * 1000));
        const r = await send('/auth/v1/token?grant_type=password', { apikey: anonKey }, 'POST', { email, password });
        if (r.status === 429) continue;
        if (r.status !== 200 || !parsed(r)?.access_token) throw new Error(`${email} could not sign in (${said(r)})`);
        return parsed(r).access_token;
      }
      throw new Error(`${email} could not sign in: the sign-in limit refused every attempt for a minute`);
    };

    const people = [];
    const person = async (role, roles) => {
      const email = `gateway-consent-${randomBytes(6).toString('hex')}@aber.local`;
      const password = randomBytes(24).toString('base64url');
      const made = await send('/auth/v1/admin/users', asService, 'POST', { email, password, email_confirm: true });
      if (made.status !== 200 || !parsed(made)?.id) throw new Error(`GoTrue's admin API did not make ${email} (${said(made)})`);
      people.push({ id: parsed(made).id, email });
      const roleId = roles.find((r) => r.name === role)?.id;
      const granted = await send('/rest/v1/user_roles', { ...asService, Prefer: 'return=minimal' }, 'POST',
        { user_id: parsed(made).id, role_id: roleId });
      if (granted.status !== 201) throw new Error(`${email} was not given ${role} (${said(granted)})`);
      return { role, email, token: await signIn(email, password) };
    };

    // An app's registered address, or null when the stack does not register the app.
    const redirectOf = async (clientId) => {
      const r = await send(`/auth/v1/admin/oauth/clients/${clientId}`, asService);
      const listed = parsed(r)?.redirect_uris;
      const uris = Array.isArray(listed) ? listed : String(listed || '').split(',').map((u) => u.trim()).filter(Boolean);
      return r.status === 200 && uris.length ? uris[0] : null;
    };
    // A fresh sign-in to the app, as the app starts one: PKCE, no redirect followed.
    const authorize = async (clientId, redirectUri) => {
      const query = new URLSearchParams({
        response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: 'openid email profile',
        state: randomBytes(9).toString('base64url'),
        code_challenge: createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url'),
        code_challenge_method: 'S256',
      });
      const r = await send(`/auth/v1/oauth/authorize?${query}`, {});
      let id = null;
      try { id = new URL(r.headers.location || '', base).searchParams.get('authorization_id'); } catch { /* none */ }
      if (!id) throw new Error(`GoTrue's authorize for ${clientId} gave no authorization_id (${said(r)}, Location ${JSON.stringify(r.headers.location || '')})`);
      return id;
    };
    const expect = (label, okay, r) => (okay ? consentOk.push(label) : consentProblems.push(`${label}: ${said(r)}`));

    try {
      const roles = parsed(await send('/rest/v1/roles?select=id,name', asService)) || [];
      const [nodeRed, grafana] = [await redirectOf(NODE_RED), await redirectOf(GRAFANA)];
      const manager = await person('Shopfloor_Manager', roles);
      const operator = await person('Operator', roles);
      await setSwitch(true);

      if (nodeRed) {
        const id = await authorize(NODE_RED, nodeRed);
        const get = await details(id, manager.token);
        expect("MFA required: a Shopfloor Manager at aal1 is refused Node-RED's sign-in request (GET)", refusedForMfa(get), get);
        const post = await deny(id, manager.token);
        expect('MFA required: the same person is refused its consent (POST)', refusedForMfa(post), post);
        const theirs = await authorize(NODE_RED, nodeRed);
        const [oget, opost] = [await details(theirs, operator.token), await deny(theirs, operator.token)];
        expect("MFA required: an Operator at aal1 passes to GoTrue on Node-RED's sign-in (GET)", passedGate(oget), oget);
        expect('MFA required: and on its consent (POST, denied)', passedGate(opost), opost);
      } else {
        console.log(`  --   Node-RED's client (${NODE_RED}) is not registered here: its refusal and the Operator's pass were not probed`);
      }
      if (grafana) {
        const id = await authorize(GRAFANA, grafana);
        const [get, post] = [await details(id, manager.token), await deny(id, manager.token)];
        expect("MFA required: the same Shopfloor Manager at aal1 passes to GoTrue on Grafana's sign-in (GET)", passedGate(get), get);
        expect('MFA required: and on its consent (POST, denied)', passedGate(post), post);
      } else {
        console.log(`  --   Grafana's client (${GRAFANA}) is not registered here: its pass was not probed`);
      }

      await setSwitch(false);
      if (nodeRed) {
        const id = await authorize(NODE_RED, nodeRed);
        const [get, post] = [await details(id, manager.token), await deny(id, manager.token)];
        expect("MFA not required: the Shopfloor Manager at aal1 passes to GoTrue on Node-RED's sign-in (GET)", passedGate(get), get);
        expect('MFA not required: and on its consent (POST, denied)', passedGate(post), post);
      }
    } catch (err) {
      consentProblems.push(err instanceof Error ? err.message : String(err));
    } finally {
      try {
        await setSwitch(wasOn);
      } catch (err) {
        consentProblems.push(`CLEANUP: ${err.message}; set security.require_mfa_for_managers back to ${wasOn} on Settings`);
      }
      for (const p of people) {
        const r = await send(`/auth/v1/admin/users/${p.id}`, asService, 'DELETE');
        if (r.status !== 200) consentProblems.push(`CLEANUP: ${p.email} was not deleted (${said(r)}); delete ${p.id} with GoTrue's admin API`);
      }
    }

    for (const line of consentOk) console.log(`  ok   ${line}`);
    if (consentProblems.length) {
      console.error(`\nThe consent step at ${base} does not decide as reviewed:\n`);
      for (const p of consentProblems) console.error(`  ${p}\n`);
      process.exit(1);
    }
    console.log(
      `\nThe consent step at ${base} decides as reviewed: ${consentOk.length} decision(s); the switch is `
      + `${wasOn ? 'on' : 'off'} again and both people are deleted.`
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
const CHART_ENVOY = 'deploy/helm/aber/templates/supabase/envoy.yaml';

/** Substituted by the chart's initContainer. */
const TEMPLATE_PLACEHOLDERS = [
  '__CORS_ORIGINS__',
  '__REALTIME_UPSTREAM_ADDRESS__',
  '__REALTIME_UPSTREAM_HOST__',
  '__SUPABASE_ANON_KEY__',
  '__SUPABASE_PUBLISHABLE_KEY__',
  '__SUPABASE_SECRET_KEY__',
  '__SUPABASE_SERVICE_ROLE_KEY__',
  // The studio listener's four. The first is the JWKS GoTrue's tokens verify against (the EC public
  // key): not a credential the gateway presents but the one it verifies with.
  '__SUPABASE_JWT_JWKS__',
  '__SUPABASE_PUBLIC_URL__',
  '__STUDIO_PUBLIC_URL__',
  '__STUDIO_UPSTREAM_ADDRESS__',
  // The forge listener's two (0094). It shares the JWKS key and SUPABASE_PUBLIC_URL with Studio's.
  '__GITEA_PUBLIC_URL__',
  '__GITEA_UPSTREAM_ADDRESS__',
  // The API listener's client address and sign-in limit, and the HSTS value all three send.
  '__XFF_TRUSTED_HOPS__',
  '__SIGN_IN_LIMIT_PERCENT__',
  '__SIGN_IN_LIMIT_PER_CLIENT__',
  '__SIGN_IN_LIMIT_TOTAL__',
  '__STRICT_TRANSPORT_SECURITY__',
];

const template = read(ENVOY_TEMPLATE).replace(/\r\n/g, '\n');

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

/** The lines after the one equal to `first`, up to the first that `stop` matches. */
const linesAfter = (lines, first, stop) => {
  const start = lines.indexOf(first);
  if (start < 0) return '';
  let end = start + 1;
  while (end < lines.length && !stop.test(lines[end])) end += 1;
  return lines.slice(start + 1, end).join('\n');
};
/** One listener's text: from its `- name:` line to the next listener or the clusters. */
const listenerText = (name) => linesAfter(template.split('\n'), `    - name: ${name}`, /^ {4}- name: |^ {2}clusters:/);
const gateway = listenerText('gateway');
// Route names are kebab-case; filter, logger and header-matcher names have dots or quotes.
const ROUTE_LINE = /^ *- name: ([a-z0-9-]+) *$/;
const routesStart = gateway.indexOf('routes:');
const filtersStart = gateway.indexOf('http_filters:');
const routeLines = gateway.slice(routesStart, filtersStart).split('\n');
const routeNames = routeLines.map((l) => (l.match(ROUTE_LINE) || [])[1]).filter(Boolean);
/** One gateway route's text, from its `- name:` line to the next route's. */
const routeText = (name) => linesAfter(routeLines.map((l) => l.trim()), `- name: ${name}`, ROUTE_LINE);

// ---- 4. Every API route has a row in EXPECTED, and every row names a route. --------------------
{
  const declared = new Set(EXPECTED.map((r) => r.route));
  const unreviewed = routeNames.filter((n) => !declared.has(n));
  const absent = [...declared].filter((n) => !routeNames.includes(n));
  if (!routeNames.length) {
    fail(`found no routes on the gateway listener in ${ENVOY_TEMPLATE}; this script's reading of it is stale.`);
  } else if (unreviewed.length || absent.length) {
    fail(
      `${ENVOY_TEMPLATE}'s API routes and EXPECTED disagree.`
      + (unreviewed.length ? ` Routes with no row: ${unreviewed.join(', ')}.` : '')
      + (absent.length ? ` Rows naming no route: ${absent.join(', ')}.` : '')
      + ' A route is reviewed by adding its row, with its posture, in the same change.'
    );
  } else {
    pass(`each of the ${routeNames.length} API routes has its row in EXPECTED`);
  }

  // Routes are first-match, so an exemption inside a gated prefix works only above that gate.
  const inside = EXPECTED.filter((r) => r.auth === 'open').flatMap((open) => EXPECTED
    .filter((gated) => gated.auth === 'key-auth'
      && open.paths.some((p) => gated.paths.some((g) => p.startsWith(g))))
    .map((gated) => [open.route, gated.route]));
  const below = inside.filter(([open, gated]) => routeNames.indexOf(open) > routeNames.indexOf(gated));
  if (below.length) {
    fail(
      `${ENVOY_TEMPLATE}: ${below.map(([open, gated]) => `${open} comes after ${gated}`).join('; ')}. `
      + 'Routes are first-match, so the gate answers first and the exemption never applies.'
    );
  } else if (inside.length) {
    pass(`each of the ${inside.length} exemption(s) inside a gated prefix comes before its gate`);
  }
}

// ---- 5. The API listener keeps its sign-in limit, response headers and access log. ------------
// Text assertions, since this script has no YAML parser: each names what removing it would undo.
{
  const before = problems.length;
  const need = (text, fragment, what) => {
    if (!text.includes(fragment)) fail(`${ENVOY_TEMPLATE}: ${what} (expected ${JSON.stringify(fragment)}).`);
  };

  need(gateway, 'use_remote_address: true',
    'the API listener must resolve the client address itself, or the sign-in limit keys on Traefik');
  need(gateway, 'xff_num_trusted_hops: __XFF_TRUSTED_HOPS__', 'the trusted hops come from supabaseEnvoy.trustedProxyHops');
  need(gateway, 'preserve_external_request_id: true',
    'without it an edge request\'s X-Request-Id is replaced, and an edge function\'s error no longer echoes the caller\'s id');
  need(gateway, 'pack_trace_reason: false', 'with it Envoy rewrites one character of a caller\'s 36-character request id');

  const filters = gateway.slice(filtersStart);
  const order = ['cors', 'local_ratelimit', 'lua', 'jwt_authn', 'rbac', 'ext_authz', 'router'].map((f) => filters.indexOf(`- name: envoy.filters.http.${f}`));
  if (order.some((i) => i < 0) || order.some((i, n) => n > 0 && i < order[n - 1])) {
    fail(
      `${ENVOY_TEMPLATE}: the API listener's filters must run CORS, the sign-in limit, the key check, the token's `
      + 'claims, the app check, the consent step, then the router; a limit before CORS would spend a token on every '
      + 'preflight, an app check before the key check would answer 403 where the key check answers 401, and a '
      + 'consent step before the app check would ask consent-gate about a request the app check refuses.'
    );
  }

  const limited = routeText('auth-v1-limited-routes');
  if (routeNames[0] !== 'auth-v1-limited-routes') {
    fail(`${ENVOY_TEMPLATE}: auth-v1-limited-routes must be the API listener's first route; routes are first-match.`);
  }
  for (const [fragment, what] of [
    ['(token|recover)', 'the sign-in limit covers /token and /recover'],
    ['exact: POST', 'the sign-in limit matches POST only'],
    ['exact: "/auth/v1/token?grant_type=refresh_token"', 'only a refresh, in the one spelling clients send, is exempt'],
    ['invert_match: true', 'the refresh spelling is excluded from the limit, not the only thing limited'],
    ['envoy.filters.http.local_ratelimit', 'the limit itself is this route\'s per-route config'],
    ['remote_address: {}', 'the limit keys on the client address'],
    ['- entries: [{ key: remote_address }]', 'each client address has a bucket of its own'],
    ['__SIGN_IN_LIMIT_PER_CLIENT__', 'the per-client rate comes from supabaseEnvoy.signInRateLimit'],
    ['__SIGN_IN_LIMIT_TOTAL__', 'the total rate comes from supabaseEnvoy.signInRateLimit'],
    ['__SIGN_IN_LIMIT_PERCENT__', 'supabaseEnvoy.signInRateLimit.enabled switches it'],
    ['name: translate_bearer', 'sign-in is not gated by a key: the route keeps the sign-in Lua'],
  ]) need(limited, fragment, `auth-v1-limited-routes: ${what}`);

  for (const name of ['auth-v1-limited-routes', 'auth-v1-routes']) {
    const text = routeText(name);
    need(text, 'key: x-forwarded-for, value: "%DOWNSTREAM_REMOTE_ADDRESS_WITHOUT_PORT%"',
      `${name}: GoTrue's own limits key on X-Forwarded-For, which the route sets to the client address alone`);
    need(text, 'key: cache-control, value: no-store', `${name}: sign-in responses carry tokens no cache may keep`);
  }

  const headersOf = (text) => text.slice(text.indexOf('route_config:'), text.indexOf('virtual_hosts:'));
  need(headersOf(gateway), 'key: x-content-type-options, value: nosniff', 'every API response carries nosniff');
  for (const name of ['gateway', 'studio', 'forge']) {
    need(headersOf(listenerText(name)), 'key: strict-transport-security, value: "__STRICT_TRANSPORT_SECURITY__"',
      `the ${name} listener sends Strict-Transport-Security when global.scheme is https`);
  }
  need(gateway, '"error_code":"over_request_rate_limit"', 'the limit answers 429 in GoTrue\'s shape, which clients read');

  const format = (gateway.match(/inline_string: "(aber-api [^"]*)"/) || [])[1] || '';
  if (!format) {
    fail(`${ENVOY_TEMPLATE}: the API listener writes no aber-api access log line.`);
  } else {
    need(gateway, 'envoy.formatter.req_without_query', 'the access log needs the formatter that drops the query string');
    for (const field of ['method=', 'path=%REQ_WITHOUT_QUERY(', 'status=', 'flags=', 'upstream=', 'duration_ms=', 'request_id=', 'client=']) {
      need(format, field, 'the aber-api access log line keeps each of its fields');
    }
    if (/%REQ\([^)]*PATH/i.test(format) || /%(?:REQ|RESP|REQ_WITHOUT_QUERY)\([^)]*(?:apikey|authorization|cookie)/i.test(format)) {
      fail(
        `${ENVOY_TEMPLATE}: the aber-api access log line names the path with its query, or a credential header. `
        + 'The query can carry the apikey; the log goes to Loki.'
      );
    }
  }

  if (problems.length === before) {
    pass('the API listener keeps its sign-in limit, client address, response headers and access log');
  }
}

// ---- 6. Multipart storage-api's parser must not see is refused above every route to it. --------
// busboy loops on a 252-byte boundary; the two refusals keep every boundary within RFC 2046's 70,
// and the chart turns off the S3 protocol, which parses a form before any credential.
{
  const before = problems.length;
  const REFUSALS = ['storage-v1-long-boundary', 'storage-v1-unreadable-multipart'];
  const STORAGE_CHART = 'deploy/helm/aber/templates/supabase/storage.yaml';
  const toStorage = routeNames.filter((n) => /\bcluster: storage-v1\b/.test(routeText(n)));
  const offListener = (template.match(/\bcluster: storage-v1\b/g) || []).length - toStorage.length;
  if (offListener) {
    fail(`${ENVOY_TEMPLATE} routes to storage-v1 from ${offListener} place(s) off the API listener, where no multipart refusal stands.`);
  }

  const patterns = [];
  for (const name of REFUSALS) {
    if (!routeNames.includes(name)) {
      fail(`${ENVOY_TEMPLATE}: the API listener has no ${name} route, so a multipart boundary busboy loops on reaches storage-api.`);
      continue;
    }
    const first = toStorage.filter((n) => routeNames.indexOf(n) < routeNames.indexOf(name));
    if (first.length) {
      fail(`${ENVOY_TEMPLATE}: ${first.join(', ')} comes before ${name}. Routes are first-match, so storage-api sees the request first.`);
    }
    const text = routeText(name);
    for (const [fragment, what] of [
      ['prefix: "/storage/v1/"', 'it covers every path to storage-api'],
      ['- name: "content-type"', 'it reads the Content-Type'],
      ['status: 400', 'the gateway answers 400 itself'],
    ]) {
      if (!text.includes(fragment)) fail(`${ENVOY_TEMPLATE}: ${name}: ${what} (expected ${JSON.stringify(fragment)}).`);
    }
    // RE2 matches a header in full; these patterns read the same in JavaScript.
    const m = text.match(/regex: '((?:[^']|'')*)'/);
    if (m) patterns.push({ name, re: new RegExp(`^(?:${m[1].replace(/''/g, "'")})$`) });
    else fail(`${ENVOY_TEMPLATE}: ${name} matches the Content-Type with no single-quoted safe_regex this script can read.`);
  }
  if (patterns.length === REFUSALS.length) {
    for (const c of MULTIPART_CASES) {
      const by = patterns.filter((p) => p.re.test(c.contentType)).map((p) => p.name);
      if (Boolean(by.length) !== c.refused) {
        fail(
          `${ENVOY_TEMPLATE}: a Content-Type with ${c.name} (${c.contentType.length} characters) is `
          + `${by.length ? `refused by ${by.join(' and ')}` : 'passed to storage-api'}; it must be ${c.refused ? 'refused' : 'passed'}.`
        );
      }
    }
  }
  if (!template.includes('re2.max_program_size.error_level:')) {
    fail(`${ENVOY_TEMPLATE}: the refusals' regexes exceed RE2's default program size, and Envoy refuses the config without re2.max_program_size.error_level.`);
  }
  if (!/- name: S3_PROTOCOL_ENABLED\s+value: "false"/.test(read(STORAGE_CHART))) {
    fail(`${STORAGE_CHART} must set S3_PROTOCOL_ENABLED to "false": storage-api's S3 protocol parses a multipart form before any credential.`);
  }
  if (problems.length === before) {
    pass(
      `the ${REFUSALS.length} multipart refusals come before every route to storage-api and refuse `
      + `${MULTIPART_CASES.filter((c) => c.refused).length} of the ${MULTIPART_CASES.length} fixture Content-Types, `
      + 'passing every conforming one; the S3 protocol is off'
    );
  }
}

// ---- 7. An app's token reaches only its own routes. ---------------------------------------------
// jwt_authn verifies the bearer and records its claims without refusing anything; rbac then admits a
// token with no client_id anywhere, every app's on /auth/v1/, and each app's on APP_ROUTES' functions.
{
  const before = problems.length;
  const need = (text, fragment, what) => {
    if (!text.includes(fragment)) fail(`${ENVOY_TEMPLATE}: ${what} (expected ${JSON.stringify(fragment)}).`);
  };
  const filters = gateway.slice(filtersStart);
  const between = (from, to) => {
    const start = filters.indexOf(`- name: envoy.filters.http.${from}`);
    return start < 0 ? '' : filters.slice(start, filters.indexOf(`- name: envoy.filters.http.${to}`, start));
  };
  const claims = between('jwt_authn', 'rbac');
  const decision = between('rbac', 'ext_authz');

  need(claims, 'requires: { allow_missing_or_failed: {} }',
    'the API listener\'s jwt_authn records claims and refuses nothing, so no token, a key or an expired one go on as before');
  for (const [fragment, what] of [
    ['provider_name', 'a provider requirement would refuse every request without a valid token'],
    ['audiences:', 'an audience would hide the client_id of a token with another audience'],
    ['issuer:', 'an issuer would hide the client_id of a token GoTrue issued without one'],
    ['from_params', 'no upstream reads a bearer from the query string'],
  ]) {
    if (claims.includes(fragment)) fail(`${ENVOY_TEMPLATE}: the API listener's jwt_authn names ${fragment} -- ${what}.`);
  }
  need(claims, 'forward: true', 'the bearer goes on to the upstream, which authenticates with it');
  need(claims, 'payload_in_metadata: jwt_payload', 'the rbac filter reads the verified claims from jwt_authn\'s metadata');
  need(claims, "inline_string: '__SUPABASE_JWT_JWKS__'", 'tokens verify against the key set GoTrue signs with');
  for (const header of ['{ name: authorization, value_prefix: " " }', '{ name: authorization, value_prefix: "\\t" }', '{ name: authorization }']) {
    need(claims, header, 'jwt_authn reads the bearer in every spelling an upstream accepts: any scheme, a tab, or none');
  }

  need(decision, 'action: ALLOW', 'the app check admits what its policies name and refuses the rest');
  // Each policy: its name, and the text up to the next one at the same indent.
  const lines = decision.split('\n');
  const at = lines.findIndex((l) => /^\s*policies:\s*$/.test(l));
  const indent = at < 0 ? -1 : lines[at].search(/\S/) + 2;
  const policies = [];
  for (const line of lines.slice(at + 1)) {
    const name = line.length - line.trimStart().length === indent && line.match(/^\s*([a-z0-9-]+):\s*$/);
    if (name) policies.push({ name: name[1], text: '' });
    else if (policies.length) policies[policies.length - 1].text += `${line}\n`;
  }
  const clientIds = (text) => [...text.matchAll(/string_match: \{ exact: ([0-9a-f-]{36}) \}/g)].map((m) => m[1]);
  const paths = (text) => [...text.matchAll(/url_path: \{ path: \{ (exact|prefix): "([^"]+)" \} \}/g)].map((m) => `${m[1]} ${m[2]}`);
  const noApp = policies.filter((p) => p.text.includes('not_id:'));
  const signIn = policies.filter((p) => paths(p.text).join() === 'prefix /auth/v1/' && p.text.includes('principals: [{ any: true }]'));
  const perApp = policies.filter((p) => !noApp.includes(p) && !signIn.includes(p));
  if (noApp.length !== 1 || !noApp[0].text.includes('permissions: [{ any: true }]')
    || !noApp[0].text.includes('path: [{ key: jwt_payload }, { key: client_id }]')
    || !noApp[0].text.includes('safe_regex: { regex: "(?s).+" }')) {
    fail(`${ENVOY_TEMPLATE}: the app check has no single policy admitting, on every route, a token whose verified claims carry no non-empty client_id.`);
  }
  if (signIn.length !== 1) fail(`${ENVOY_TEMPLATE}: the app check has no single policy admitting every token on /auth/v1/, where every app checks its session.`);
  const found = {};
  for (const p of perApp) {
    const ids = clientIds(p.text);
    const routes = paths(p.text);
    const fns = routes.map((r) => (r.match(/^exact \/functions\/v1\/([a-z0-9-]+)$/) || [])[1]);
    if (ids.length !== 1 || !routes.length || fns.some((f) => !f) || p.text.includes('any: true')) {
      fail(`${ENVOY_TEMPLATE}: app check policy ${p.name} must name one client_id and exact /functions/v1/<name> paths alone; it names [${ids.join(', ')}] and [${routes.join(', ')}].`);
      continue;
    }
    found[ids[0]] = [...(found[ids[0]] || []), ...fns].sort();
  }
  const wanted = Object.fromEntries(Object.entries(APP_ROUTES).filter(([, r]) => r.functions.length).map(([id, r]) => [id, [...r.functions].sort()]));
  const show = (m) => Object.entries(m).map(([id, fns]) => `${id} -> ${fns.join(', ')}`).sort().join('; ');
  if (show(found) !== show(wanted)) {
    fail(
      `${ENVOY_TEMPLATE}: the app check admits ${show(found) || 'no app to any function'}, and APP_ROUTES says `
      + `${show(wanted)}. An app's route is reviewed by changing both in the same change.`
    );
  }
  for (const fn of Object.values(wanted).flat()) {
    if (!routeNames.some((n) => routeText(n).includes(`match: { path: "/functions/v1/${fn}" }`))) {
      fail(`${ENVOY_TEMPLATE}: APP_ROUTES names /functions/v1/${fn}, which no API route matches exactly.`);
    }
  }

  need(gateway, APP_REFUSAL.replace(/'/g, "''"), 'an app\'s token off its routes is refused in the key check\'s JSON shape');
  need(gateway, 'match_if_key_not_found: false', 'the refusal\'s body is matched on a verified client_id, so no other reply takes it');
  need(gateway, 'app=%DYNAMIC_METADATA(envoy.filters.http.jwt_authn:jwt_payload:client_id)%', 'the access log names the app a verified token was issued to');

  if (problems.length === before) {
    pass(
      `an app's token reaches /auth/v1/ and its own functions alone (${Object.keys(wanted).length} app(s) with functions, `
      + `${Object.keys(APP_ROUTES).length - Object.keys(wanted).length} with none), decided on the verified client_id`
    );
  }
}

// ---- 8. The consent step: consent-gate is asked on GoTrue's consent endpoints alone. ------------
// The ext_authz filter is off on every route but auth-v1-consent-routes, a plain prefix between the
// sign-in limit and the rest of /auth/v1/, and fails closed. Every other spelling of the prefix is
// the gateway's own answer. Config lines only: a comment may name what a setting must not be.
{
  const before = problems.length;
  const need = (text, fragment, what) => {
    if (!text.includes(fragment)) fail(`${ENVOY_TEMPLATE}: ${what} (expected ${JSON.stringify(fragment)}).`);
  };
  const config = (text) => text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  const filters = gateway.slice(filtersStart);
  const at = filters.indexOf('- name: envoy.filters.http.ext_authz');
  const step = at < 0 ? '' : config(filters.slice(at, filters.indexOf('- name: envoy.filters.http.', at + 1)));
  if (!step) {
    fail(`${ENVOY_TEMPLATE}: the API listener has no ext_authz filter, so an app's sign-in is approved whatever MFA requires.`);
  } else {
    for (const [fragment, what] of [
      ['disabled: true', 'the consent step is off on every route that does not turn it on'],
      ['failure_mode_allow: false', 'a consent-gate that cannot answer refuses the consent, since no claim here stands in for it'],
      ['status_on_error: { code: ServiceUnavailable }', 'a check that could not answer is a 503, which the consent page shows'],
      ['cluster: functions-v1', 'consent-gate runs in the edge runtime'],
    ]) need(step, fragment, `the consent step: ${what}`);
    if (!/^\s*path_prefix: \/consent-gate\s*$/m.test(step)) {
      fail(`${ENVOY_TEMPLATE}: the consent step does not ask /consent-gate; the edge runtime routes on the first path segment.`);
    }
    const timeout = step.match(/^\s*timeout: (\d+(?:\.\d+)?)s\s*$/m);
    if (!timeout || Number(timeout[1]) > 5) {
      fail(`${ENVOY_TEMPLATE}: the consent step's timeout is ${timeout ? `${timeout[1]}s` : 'unset'}; a person waits on it, so at most 5s.`);
    }
    const allowed = (step.match(/allowed_headers:\s*\n\s*patterns:\s*\n((?:\s*- exact: \S+\s*\n)+)/) || [])[1] || '';
    const sent = [...allowed.matchAll(/- exact: (\S+)/g)].map((m) => m[1]);
    if (sent.join() !== 'authorization') {
      fail(`${ENVOY_TEMPLATE}: the consent step sends consent-gate [${sent.join(', ')}]; the Authorization header alone is its to read.`);
    }
  }

  const routeConfig = (name) => config(routeText(name));
  const enabling = routeNames.filter((n) => routeConfig(n).includes('envoy.filters.http.ext_authz'));
  if (enabling.join() !== 'auth-v1-consent-routes') {
    fail(
      `${ENVOY_TEMPLATE}: the consent step is named by [${enabling.join(', ') || 'no route'}]. A route that names it turns `
      + 'it on, so auth-v1-consent-routes alone may: every other /auth/v1/ route goes to GoTrue unasked.'
    );
  }
  const [limited, consentAt, spellingsAt, rest] = ['auth-v1-limited-routes', 'auth-v1-consent-routes',
    'auth-v1-consent-spellings', 'auth-v1-routes'].map((n) => routeNames.indexOf(n));
  if (consentAt < 0 || !(limited < consentAt && consentAt < rest)) {
    fail(`${ENVOY_TEMPLATE}: auth-v1-consent-routes must come after auth-v1-limited-routes and before auth-v1-routes, which would otherwise answer first.`);
  }
  const consent = routeConfig('auth-v1-consent-routes');
  const matches = consent.split('\n').filter((l) => /^(match|safe_regex|path|prefix|headers):/.test(l));
  if (matches.join('\n') !== `match: { prefix: "${CONSENT_PREFIX}" }`) {
    fail(`${ENVOY_TEMPLATE}: auth-v1-consent-routes must match the plain prefix ${CONSENT_PREFIX} alone; it matches ${JSON.stringify(matches)}.`);
  }
  for (const [fragment, what] of [
    ['check_settings: {}', 'the route turns the consent step on'],
    ['cluster: auth-v1', 'the consent endpoints are GoTrue\'s'],
    ['prefix_rewrite: "/oauth/authorizations/"', 'GoTrue serves them at /oauth/authorizations/'],
    ['name: translate_bearer', 'sign-in is not gated by a key: the route keeps the sign-in Lua'],
    ['key: cache-control, value: no-store', 'its answers carry what no cache may keep'],
    ['key: x-forwarded-for, value: "%DOWNSTREAM_REMOTE_ADDRESS_WITHOUT_PORT%"', 'GoTrue keys its limits on the client address alone'],
  ]) need(consent, fragment, `auth-v1-consent-routes: ${what}`);

  const spellings = routeConfig('auth-v1-consent-spellings');
  if (spellingsAt < 0 || !(consentAt < spellingsAt && spellingsAt < rest)) {
    fail(`${ENVOY_TEMPLATE}: auth-v1-consent-spellings must come after auth-v1-consent-routes and before auth-v1-routes.`);
  }
  if (!spellings.includes('direct_response:') || !spellings.includes('status: 404') || /\bcluster:/.test(spellings)
    || !spellings.includes(CONSENT_SPELLING_BODY)) {
    fail(`${ENVOY_TEMPLATE}: auth-v1-consent-spellings must be the gateway's own 404 ("${CONSENT_SPELLING_BODY} ..."), routed nowhere.`);
  }
  const pattern = (spellings.match(/safe_regex: \{ regex: "([^"]+)" \}/) || [])[1];
  if (!pattern) {
    fail(`${ENVOY_TEMPLATE}: auth-v1-consent-spellings has no double-quoted safe_regex this script can read.`);
  } else {
    // RE2 matches the path in full; `(?i)` is JavaScript's i flag.
    const re = new RegExp(`^(?:${pattern.replace(/^\(\?i\)/, '')})$`, pattern.startsWith('(?i)') ? 'i' : '');
    const missed = CONSENT_SPELLINGS.filter((s) => !re.test(s.path)).map((s) => `${s.name} (${s.path})`);
    const caught = NOT_CONSENT_SPELLINGS.filter((p) => re.test(p));
    if (missed.length) fail(`${ENVOY_TEMPLATE}: auth-v1-consent-spellings lets through ${missed.join(', ')}, to auth-v1-routes and GoTrue.`);
    if (caught.length) fail(`${ENVOY_TEMPLATE}: auth-v1-consent-spellings answers ${caught.join(', ')}, which are GoTrue's own routes.`);
  }

  const registry = read('supabase/functions/main/index.ts');
  if (!/^\s+"consent-gate": \[/m.test(registry)) {
    fail('supabase/functions/main/index.ts: consent-gate is not in FUNCTION_REGISTRY, so the router answers the consent step 404 and every consent is refused.');
  }
  need(gateway, 'response_flag_filter: { flags: [UAEX] }', 'the consent step\'s own failure is mapped on the flag only ext_authz sets');
  need(gateway, 'runtime_key: gateway.consent_check_status', 'the mapper matches the consent step\'s 503');
  need(gateway, '"error_code":"consent_check_unavailable"', 'the consent step\'s own failure answers in GoTrue\'s shape, which the consent page reads');

  if (problems.length === before) {
    pass(
      `consent-gate is asked on ${CONSENT_PREFIX} alone, fails closed within ${(step.match(/^\s*timeout: (\S+)$/m) || [])[1]}, `
      + `and ${CONSENT_SPELLINGS.length} other spellings of the prefix are the gateway's own 404`
    );
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
