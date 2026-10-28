/**
 * node-red-init against a seeded volume: the TLS reconcile adds one tls-config node and points
 * every broker at it; a managed broker node whose pair is missing stops the boot, while one built
 * in the editor is left alone with what its Security tab holds. And the settings.js it writes: an
 * editor session keeps its permissions only while user_roles still grants them.
 *
 *   node --test node-red/node-red-init.test.mjs
 *
 * Each case runs the real script against a scratch /data holding a seed marker and stored broker
 * credentials, so it keeps the flow and exits before it would need Node-RED's own runtime.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'node-red-init.mjs');
const SECRET = 'node-red-init-test-credential-secret';
const BROKER = { user: 'gwy100000000000400080000', password: 'test-password' };
const TWO = { user: 'gwy200000000000400080000', password: 'two' };
const scratch = [];
after(() => { for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true }); });

/** Node-RED's own envelope: aes-256-ctr under sha256(credentialSecret), iv in hex ahead of it. */
function encrypted(credentials) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-ctr', crypto.createHash('sha256').update(SECRET).digest(), iv);
  return { $: iv.toString('hex') + cipher.update(JSON.stringify(credentials), 'utf8', 'base64') + cipher.final('base64') };
}

/** A volume that was seeded before and holds the broker nodes' credentials. */
function volume(flowText, stored = { 'gw-broker': BROKER, 'gw-broker-2': TWO }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-red-init-'));
  scratch.push(dir);
  fs.writeFileSync(path.join(dir, 'flows.json'), flowText);
  fs.writeFileSync(path.join(dir, 'flows_cred.json'), JSON.stringify(encrypted(stored)));
  fs.writeFileSync(path.join(dir, '.aber-seeded'), '{"seeded_at":"2026-09-01T00:00:00.000Z"}');
  fs.writeFileSync(path.join(dir, 'ca.crt'), 'not read by the init script\n');
  return dir;
}

function boot(dir, extraEnv = {}) {
  const env = { ...process.env };
  for (const name of ['MQTT_TLS_ENABLED', 'MQTT_TLS_CA_FILE', 'MQTT_HOST', 'MQTT_PORT', 'NODE_RED_FORCE_SEED']) delete env[name];
  Object.assign(env, {
    NODE_RED_DATA_DIR: dir,
    NODE_RED_RUNTIME_DIR: path.join(dir, 'no-runtime'),
    NODERED_CREDENTIAL_SECRET: SECRET,
    NODERED_OAUTH_CLIENT_ID: 'x', NODERED_OAUTH_CLIENT_SECRET: 'x', NODERED_OAUTH_AUTH_URL: 'x',
    NODERED_OAUTH_TOKEN_URL: 'x', NODERED_OAUTH_CALLBACK_URL: 'x', NODERED_USERINFO_URL: 'x',
    SUPABASE_JWT_SECRET: 'x', SUPABASE_PUBLISHABLE_KEY: 'x', NODERED_WEBHOOK_JWT_SECRET: 'x',
    MQTT_GW_TEST_USER: BROKER.user, MQTT_GW_TEST_PASSWORD: BROKER.password,
    MQTT_GW_TWO_USER: TWO.user, MQTT_GW_TWO_PASSWORD: TWO.password,
    ...extraEnv,
  });
  return spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
}

function run(dir, extraEnv = {}) {
  const result = boot(dir, extraEnv);
  assert.equal(result.status, 0, `node-red-init exited ${result.status}:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

const flowFile = (dir) => fs.readFileSync(path.join(dir, 'flows.json'), 'utf8');

/** Two plaintext broker nodes, each naming its credential pair; `extra` nodes are appended. */
function flow(extra = []) {
  return [
    { id: 'tab1', type: 'tab', label: 'Line 1', disabled: false, info: '' },
    { id: 'gw-broker', type: 'mqtt-broker', name: 'Cell 1', broker: 'mosquitto', port: '1883', aberCredentialsEnv: 'MQTT_GW_TEST' },
    { id: 'gw-broker-2', type: 'mqtt-broker', name: 'Cell 2', broker: 'mosquitto', port: '1883', aberCredentialsEnv: 'MQTT_GW_TWO' },
    ...extra,
  ];
}

describe('the TLS reconcile', () => {
  const tlsEnv = (dir) => ({ MQTT_TLS_ENABLED: 'true', MQTT_TLS_CA_FILE: path.join(dir, 'ca.crt'), MQTT_PORT: '8883' });

  it('adds one aber-tls-config node, points every broker at it, and a second boot changes nothing', () => {
    const dir = volume(JSON.stringify(flow()));
    const out = run(dir, tlsEnv(dir));
    assert.match(out, /added tls-config node 'aber-tls-config'/);
    assert.match(out, /flow already seeded/);
    assert.equal(fs.existsSync(path.join(dir, 'flows.json.pre-seed')), false, 'the flow must never be re-seeded');
    const nodes = JSON.parse(flowFile(dir));
    const tls = nodes.filter((n) => n.type === 'tls-config');
    assert.deepEqual(tls.map((n) => [n.id, n.name, n.ca]), [['aber-tls-config', 'Aber internal CA', path.join(dir, 'ca.crt')]]);
    for (const broker of nodes.filter((n) => n.type === 'mqtt-broker')) {
      assert.deepEqual([broker.tls, broker.usetls, broker.verifyservercert, broker.port], ['aber-tls-config', true, true, '8883']);
    }
    const reconciled = flowFile(dir);
    assert.match(run(dir, tlsEnv(dir)), /broker transport already matches/);
    assert.equal(flowFile(dir), reconciled);
  });

  it('reuses an aber-tls-config node the flow already holds', () => {
    const dir = volume(JSON.stringify(flow([{ id: 'aber-tls-config', type: 'tls-config', name: 'Plant CA' }])));
    assert.doesNotMatch(run(dir, tlsEnv(dir)), /added tls-config node/);
    const tls = JSON.parse(flowFile(dir)).filter((n) => n.type === 'tls-config');
    assert.deepEqual(tls.map((n) => [n.id, n.name]), [['aber-tls-config', 'Aber internal CA']]);
  });
});

/** What flows_cred.json holds once decrypted, by node id. */
function decrypted(dir) {
  const { $: blob } = JSON.parse(fs.readFileSync(path.join(dir, 'flows_cred.json'), 'utf8'));
  const decipher = crypto.createDecipheriv(
    'aes-256-ctr', crypto.createHash('sha256').update(SECRET).digest(), Buffer.from(blob.substring(0, 32), 'hex'));
  return JSON.parse(decipher.update(blob.substring(32), 'base64', 'utf8') + decipher.final('utf8'));
}

/**
 * Node-RED's credentials module exists only in the image, so a boot that WRITES credentials gets
 * this stand-in: the same envelope (aes-256-ctr under sha256(key), iv in hex ahead of it). It
 * tests what this script hands the module; the module itself is Node-RED's.
 */
function fakeCredentialsModule(dir) {
  const target = path.join(dir, 'no-runtime', '@node-red', 'runtime', 'lib', 'nodes');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'credentials.js'), `
const crypto = require('node:crypto');
let key; const held = {};
module.exports = {
  init() {},
  setKey(secret) { key = crypto.createHash('sha256').update(secret).digest(); },
  async add(id, credential) { held[id] = credential; },
  async export() {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-ctr', key, iv);
    return { $: iv.toString('hex') + cipher.update(JSON.stringify(held), 'utf8', 'base64') + cipher.final('base64') };
  },
};
`);
}

/** A broker node built in the editor: the editor drops aberCredentialsEnv, so it has none. */
const EDITOR_BROKER = { id: 'ed-broker', type: 'mqtt-broker', name: 'Host gateway', broker: 'mosquitto', port: '1883' };
const TYPED = { user: 'gwy300000000000400080000', password: 'typed-in-the-editor' };

describe('the broker credential pair', () => {
  it('starts with a broker node built in the editor that has no credential yet, and says how to fix it', () => {
    const editorOnly = flow([EDITOR_BROKER]);
    const result = boot(volume(JSON.stringify(editorOnly)));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /broker node 'ed-broker' \(Host gateway\) has no username yet/);
    assert.match(result.stderr, /Security tab/);
  });

  it('leaves a credential typed in the editor alone', () => {
    const dir = volume(JSON.stringify(flow([EDITOR_BROKER])), { 'gw-broker': BROKER, 'gw-broker-2': TWO, 'ed-broker': TYPED });
    const result = boot(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /ed-broker/);
    assert.deepEqual(decrypted(dir)['ed-broker'], TYPED);
  });

  it('keeps a credential typed in the editor when it writes a managed pair', () => {
    // gw-broker-2 has nothing stored, which is what makes this boot write the file.
    const dir = volume(JSON.stringify(flow([EDITOR_BROKER])), { 'gw-broker': BROKER, 'ed-broker': TYPED });
    fakeCredentialsModule(dir);
    const out = run(dir);
    assert.match(out, /keeping 1 stored credential/);
    const stored = decrypted(dir);
    assert.deepEqual(stored['ed-broker'], TYPED);
    assert.deepEqual(stored['gw-broker-2'], TWO);
    assert.deepEqual(stored['gw-broker'], BROKER);
  });

  it('refuses a declared pair that is not set, naming the Secret it belongs in', () => {
    const result = boot(volume(JSON.stringify(flow())), {
      MQTT_GW_TWO_USER: '', MQTT_GW_TWO_PASSWORD: '',
    });
    assert.notEqual(result.status, 0);
    const out = result.stderr + result.stdout;
    assert.match(out, /MQTT_GW_TWO_USER and\/or MQTT_GW_TWO_PASSWORD are not set/);
    assert.match(out, /the Secret that nodeRed\.gatewayCredentialsSecret names/);
  });
});

/**
 * The settings.js a boot writes, loaded with stand-ins for the two modules it requires from the
 * image (the OAuth strategy is only referenced; the JWT module only decodes here), and with fetch
 * answered by `answer(url, init)`. Every fetch is recorded.
 */
function editorSettings(answer) {
  const dir = volume(JSON.stringify(flow()));
  const runtime = path.join(dir, 'no-runtime');
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, 'passport-oauth2.js'), 'module.exports = function OAuth2Strategy() {};\n');
  fs.writeFileSync(path.join(runtime, 'jsonwebtoken.js'), `
module.exports = {
  decode(token) {
    try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString()); } catch { return null; }
  },
  verify() { throw new Error('not used here'); },
};
`);
  run(dir);
  for (const [name, value] of Object.entries(SETTINGS_ENV)) process.env[name] = value;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const { status = 200, body = {} } = answer(String(url), init, calls.length) ?? {};
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  const settings = createRequire(import.meta.url)(path.join(dir, 'settings.js'));
  return { adminAuth: settings.adminAuth, settings, calls };
}

const SETTINGS_ENV = {
  NODERED_USERINFO_URL: 'http://gateway.test/functions/v1/nodered-userinfo',
  NODERED_OAUTH_TOKEN_URL: 'http://gateway.test/auth/v1/oauth/token',
  NODERED_OAUTH_CLIENT_ID: 'node-red-client',
  NODERED_OAUTH_CLIENT_SECRET: 'node-red-client-credential',
  SUPABASE_PUBLISHABLE_KEY: 'publishable-key',
};
const EMAIL = 'admin@site.test';
const ADMIN_INFO = { sub: 'aaaaaaaa-0000-4000-8000-000000000001', email: EMAIL, supabase_role: 'Administrator', permissions: '*' };

/** An access token that expires `seconds` from now; only its exp is read. */
const accessToken = (name, seconds = 3600) =>
  ['h', Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds, n: name })).toString('base64url'), 's'].join('.');

/** Signs `info` in through the strategy's verify, as Node-RED does after the OAuth callback. */
function signIn(adminAuth, access, refresh) {
  return new Promise((resolve, reject) => {
    adminAuth.strategy.options.verify(access, refresh, {}, (err, profile) => (err ? reject(err) : resolve(profile)));
  });
}

const originalFetch = globalThis.fetch;
const originalNow = Date.now;
/** Moves the clock `ms` forward for the rest of the test. */
const later = (ms) => { const at = Date.now() + ms; Date.now = () => at; };

describe("the editor's role, re-checked", () => {
  afterEach(() => { globalThis.fetch = originalFetch; Date.now = originalNow; });

  it('answers from the sign-in for a minute, then asks user_roles again and keeps a role still granted', async () => {
    const { adminAuth, calls } = editorSettings(() => ({ body: ADMIN_INFO }));
    const first = accessToken('first');
    assert.equal((await signIn(adminAuth, first, 'refresh-1')).permissions, '*');
    assert.equal(calls.length, 1);

    assert.deepEqual(await adminAuth.users(EMAIL), { username: EMAIL, permissions: '*' });
    assert.equal(calls.length, 1, 'within the minute, nothing is asked');

    later(61000);
    assert.deepEqual(await adminAuth.users(EMAIL), { username: EMAIL, permissions: '*' });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, SETTINGS_ENV.NODERED_USERINFO_URL);
    assert.equal(calls[1].init.headers.Authorization, `Bearer ${first}`, "the person's own token asks");
  });

  it('ends the session once user_roles no longer grants the permissions, and for a username it never signed in', async () => {
    let removed = false;
    const { adminAuth, calls } = editorSettings(() => ({ body: removed ? { ...ADMIN_INFO, permissions: undefined, supabase_role: null } : ADMIN_INFO }));
    await signIn(adminAuth, accessToken('t'), 'refresh-1');
    assert.equal(await adminAuth.users('someone-else@site.test'), null, 'a restart forgets every sign-in');
    assert.equal(calls.length, 1);

    removed = true;
    later(61000);
    assert.equal(await adminAuth.users(EMAIL), null);
    later(1000);
    assert.equal(await adminAuth.users(EMAIL), null, 'and stays ended without asking again');
    assert.equal(calls.length, 2);
  });

  it('ends the session on a changed role too: the scope Node-RED enforces was fixed at sign-in', async () => {
    let info = ADMIN_INFO;
    const { adminAuth } = editorSettings(() => ({ body: info }));
    await signIn(adminAuth, accessToken('t'), 'refresh-1');
    info = { ...ADMIN_INFO, supabase_role: 'Shopfloor_Manager', permissions: 'read' };
    later(61000);
    assert.equal(await adminAuth.users(EMAIL), null);
  });

  it('refreshes an expiring token first, sending each refresh token once', async () => {
    const fresh = [accessToken('second'), accessToken('third')];
    const { adminAuth, calls } = editorSettings((url) => (url === SETTINGS_ENV.NODERED_OAUTH_TOKEN_URL
      ? { body: { access_token: fresh.shift(), refresh_token: `refresh-${calls.length}`, token_type: 'bearer', expires_in: 3600 } }
      : { body: ADMIN_INFO }));
    await signIn(adminAuth, accessToken('first', 10), 'refresh-1');

    later(61000);
    assert.deepEqual(await adminAuth.users(EMAIL), { username: EMAIL, permissions: '*' });
    const refresh = calls[1];
    assert.equal(refresh.url, SETTINGS_ENV.NODERED_OAUTH_TOKEN_URL);
    assert.equal(refresh.init.method, 'POST');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(String(refresh.init.body))), {
      grant_type: 'refresh_token', refresh_token: 'refresh-1',
      client_id: SETTINGS_ENV.NODERED_OAUTH_CLIENT_ID, client_secret: SETTINGS_ENV.NODERED_OAUTH_CLIENT_SECRET,
    });
    assert.match(calls[2].init.headers.Authorization, /^Bearer h\./);
    assert.equal(calls.length, 3);

    // An hour on, the rotated refresh token is the one sent.
    later(3600000);
    assert.deepEqual(await adminAuth.users(EMAIL), { username: EMAIL, permissions: '*' });
    assert.equal(new URLSearchParams(String(calls[3].init.body)).get('refresh_token'), 'refresh-2');
  });

  it('ends the session when GoTrue refuses the refresh, as it does for a banned person', async () => {
    const { adminAuth, calls } = editorSettings((url) => (url === SETTINGS_ENV.NODERED_OAUTH_TOKEN_URL
      ? { status: 400, body: { error: 'invalid_grant', error_description: 'Invalid Refresh Token: User Banned' } }
      : { body: ADMIN_INFO }));
    await signIn(adminAuth, accessToken('first', 10), 'refresh-1');
    later(61000);
    assert.equal(await adminAuth.users(EMAIL), null);
    assert.equal(calls.length, 2, 'no userinfo with a token that has run out');
  });

  it('asks once for a burst of requests', async () => {
    const { adminAuth, calls } = editorSettings(() => ({ body: ADMIN_INFO }));
    await signIn(adminAuth, accessToken('t'), 'refresh-1');
    later(61000);
    const answers = await Promise.all([1, 2, 3, 4, 5].map(() => adminAuth.users(EMAIL)));
    assert.deepEqual(answers.map((a) => a?.permissions), ['*', '*', '*', '*', '*']);
    assert.equal(calls.length, 2);
  });

  it('ends the session when user_roles cannot be asked, rather than rejecting', async () => {
    const { adminAuth } = editorSettings(() => { throw new Error('socket hang up'); });
    // The sign-in needs a working userinfo, so the failing one is put in place after it.
    globalThis.fetch = async () => new Response(JSON.stringify(ADMIN_INFO), { status: 200 });
    await signIn(adminAuth, accessToken('t'), 'refresh-1');
    globalThis.fetch = async () => { throw new Error('socket hang up'); };
    later(61000);
    assert.equal(await adminAuth.users(EMAIL), null);
  });

  it('removes the username -> permissions file earlier settings persisted', () => {
    const dir = volume(JSON.stringify(flow()));
    fs.writeFileSync(path.join(dir, '.aber-editor-users.json'), JSON.stringify({ [EMAIL]: '*' }));
    run(dir);
    assert.equal(fs.existsSync(path.join(dir, '.aber-editor-users.json')), false);
  });
});

/**
 * The subset of jsonwebtoken 9 settings.js calls, done with node:crypto: decode with `complete`,
 * and verify, which throws unless the signature, `algorithms`, `audience` and exp all hold.
 */
const JWT_STAND_IN = `
const crypto = require('node:crypto');
const part = (s) => JSON.parse(Buffer.from(s, 'base64url').toString());
module.exports = {
  decode(token, options = {}) {
    try {
      const [h, p] = String(token).split('.');
      return options.complete ? { header: part(h), payload: part(p) } : part(p);
    } catch { return null; }
  },
  verify(token, key, options = {}) {
    const [h, p, s] = String(token).split('.');
    const header = part(h);
    const claims = part(p);
    if (!(options.algorithms || []).includes(header.alg)) throw new Error('invalid algorithm');
    const data = Buffer.from(h + '.' + p);
    const sig = Buffer.from(s, 'base64url');
    const ok = header.alg === 'HS256'
      ? crypto.timingSafeEqual(crypto.createHmac('sha256', key).update(data).digest(), sig.length === 32 ? sig : Buffer.alloc(32))
      : crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig);
    if (!ok) throw new Error('invalid signature');
    if (options.audience && claims.aud !== options.audience) throw new Error('jwt audience invalid');
    if (claims.exp * 1000 < Date.now()) throw new Error('jwt expired');
    return claims;
  },
};
`;

const LEGACY_SECRET = 'node-red-init-test-signing-secret-of-32-characters';
const KID = 'node-red-init-test-kid';
const { privateKey: EC_PRIVATE, publicKey: EC_PUBLIC } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const LEGACY_JWK = { kty: 'oct', k: Buffer.from(LEGACY_SECRET).toString('base64url'), alg: 'HS256' };
const JWKS = JSON.stringify({ keys: [{ ...EC_PUBLIC.export({ format: 'jwk' }), kid: KID, alg: 'ES256', use: 'sig', key_ops: ['verify'] }, LEGACY_JWK] });

/** A token GoTrue could have signed: ES256 under `kid`, or HS256 under `secret`. */
function gotrueToken(claims, { alg = 'ES256', kid = KID, secret = LEGACY_SECRET, key = EC_PRIVATE } = {}) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${b64(alg === 'ES256' ? { alg, typ: 'JWT', kid } : { alg, typ: 'JWT' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}`;
  const sig = alg === 'ES256'
    ? crypto.sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' })
    : crypto.createHmac('sha256', secret).update(data).digest();
  return `${data}.${sig.toString('base64url')}`;
}

/** settings.js as a boot writes it with `env`, loaded with the stand-ins above; fetch as in editorSettings. */
function gotrueSettings(env, answer = () => ({ body: ADMIN_INFO })) {
  const dir = volume(JSON.stringify(flow()));
  const runtime = path.join(dir, 'no-runtime');
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, 'passport-oauth2.js'),
    'module.exports = function OAuth2Strategy(options, verify) { this.options = options; this._verify = verify; };\n');
  fs.writeFileSync(path.join(runtime, 'jsonwebtoken.js'), JWT_STAND_IN);
  run(dir, env);
  for (const [name, value] of Object.entries({ ...SETTINGS_ENV, ...env })) process.env[name] = value;
  globalThis.fetch = async (url, init = {}) => {
    const { status = 200, body = {} } = answer(String(url), init) ?? {};
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return createRequire(import.meta.url)(path.join(dir, 'settings.js'));
}

const access = (claims = {}) => ({ aud: 'authenticated', sub: ADMIN_INFO.sub, role: 'authenticated', ...claims });

describe("GoTrue's tokens, verified", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.SUPABASE_JWT_JWKS;
    delete process.env.SUPABASE_JWT_SECRET;
  });

  it('without the JWKS: an HS256 token under the secret passes adminAuth.tokens, and nothing else does', async () => {
    const { adminAuth } = gotrueSettings({ SUPABASE_JWT_SECRET: LEGACY_SECRET });
    assert.deepEqual(await adminAuth.tokens(gotrueToken(access(), { alg: 'HS256' })), { username: EMAIL, permissions: '*' });
    assert.equal(await adminAuth.tokens(gotrueToken(access())), null, 'no ES256 without the JWKS');
    assert.equal(await adminAuth.tokens(gotrueToken(access(), { alg: 'HS256', secret: 'another-secret' })), null);
    assert.equal(await adminAuth.tokens(gotrueToken(access({ aud: 'node-red-hooks' }), { alg: 'HS256' })), null, 'the audience is checked');
    assert.deepEqual(adminAuth.strategy.options.scope, ['email', 'profile'], 'no openid under HS256');
  });

  it('with the JWKS: ES256 by kid and HS256 by the legacy key pass, through 1.7', async () => {
    const { adminAuth } = gotrueSettings({ SUPABASE_JWT_JWKS: JWKS, SUPABASE_JWT_SECRET: '' });
    assert.deepEqual(await adminAuth.tokens(gotrueToken(access())), { username: EMAIL, permissions: '*' });
    assert.deepEqual(await adminAuth.tokens(gotrueToken(access({ n: 2 }), { alg: 'HS256' })), { username: EMAIL, permissions: '*' });
    assert.equal(await adminAuth.tokens(gotrueToken(access(), { kid: 'another-kid' })), null, 'an unknown kid verifies nothing');
    const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    assert.equal(await adminAuth.tokens(gotrueToken(access({ n: 3 }), { key: other })), null, 'another pair under the kid');
    assert.equal(await adminAuth.tokens(gotrueToken(access({ n: 4 }), { alg: 'HS256', secret: 'another-secret' })), null);
    assert.deepEqual(adminAuth.strategy.options.scope, ['openid', 'email', 'profile']);
  });

  it('with the JWKS the sign-in takes the ID token: for this client, and naming the person userinfo names', async () => {
    const settings = gotrueSettings({ SUPABASE_JWT_JWKS: JWKS });
    const { adminAuth } = settings;
    const signInWith = (idToken) => new Promise((resolve, reject) => {
      // Node-RED constructs the strategy with its wrapper; passport-oauth2 calls it with five arguments.
      const strategy = new adminAuth.strategy.strategy(adminAuth.strategy.options,
        (a, r, profile, done) => adminAuth.strategy.options.verify(a, r, profile, done));
      assert.equal(strategy._verify.length, 5, 'passport-oauth2 passes the token response only to a five-parameter verify');
      strategy._verify(gotrueToken(access()), 'refresh-1', { id_token: idToken }, {}, (err, profile) => (err ? reject(err) : resolve(profile)));
    });
    const idToken = (claims) => gotrueToken({ sub: ADMIN_INFO.sub, aud: SETTINGS_ENV.NODERED_OAUTH_CLIENT_ID, ...claims });
    assert.equal((await signInWith(idToken())).permissions, '*');
    assert.equal(await signInWith(undefined), false, 'openid was asked for, so an absent ID token refuses');
    assert.equal(await signInWith(idToken({ aud: 'another-client' })), false, "another client's ID token");
    assert.equal(await signInWith(idToken({ sub: 'bbbbbbbb-0000-4000-8000-000000000002' })), false, 'another person');
    assert.equal(await signInWith(gotrueToken({ sub: ADMIN_INFO.sub, aud: SETTINGS_ENV.NODERED_OAUTH_CLIENT_ID }, { kid: 'x' })), false);
  });

  it('refuses to boot on a JWKS with no EC key, before it writes a settings.js', () => {
    const result = boot(volume(JSON.stringify(flow())), { SUPABASE_JWT_JWKS: JSON.stringify({ keys: [LEGACY_JWK] }) });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SUPABASE_JWT_JWKS is not a JWKS with an EC P-256 key/);
  });

  it('refuses to boot with neither the JWKS nor the secret', () => {
    const result = boot(volume(JSON.stringify(flow())), { SUPABASE_JWT_SECRET: '' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SUPABASE_JWT_JWKS \(or SUPABASE_JWT_SECRET\) not set/);
  });
});

/** A response that records the headers set on it and a refusal's status. */
function recordedResponse() {
  const headers = {};
  return {
    headers,
    setHeader(name, value) { headers[name] = value; },
    set(name, value) { headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    end() {},
  };
}

describe('the response headers', () => {
  const HSTS = 'Strict-Transport-Security';
  afterEach(() => { globalThis.fetch = originalFetch; delete process.env.ABER_STRICT_TRANSPORT_SECURITY; });

  /** The editor's response and an http-in route's refusal, under the value the chart set. */
  function responses(value) {
    const { settings } = editorSettings(() => ({}));
    process.env.ABER_STRICT_TRANSPORT_SECURITY = value;
    const editor = recordedResponse();
    let reached = false;
    settings.httpAdminMiddleware({}, editor, () => { reached = true; });
    assert.equal(reached, true, 'the editor middleware did not pass the request on');
    const refused = recordedResponse();
    settings.httpNodeAuth({ headers: {} }, refused, () => assert.fail('a request with no token reached a route'));
    assert.equal(refused.statusCode, 401);
    return { editor, refused };
  }

  it('sends the chart\'s Strict-Transport-Security on the editor and on an http-in refusal under https', () => {
    const { editor, refused } = responses('max-age=31536000');
    assert.equal(editor.headers[HSTS], 'max-age=31536000');
    assert.equal(refused.headers[HSTS], 'max-age=31536000');
  });

  it('sends none where the chart leaves the value empty, as over http', () => {
    const { editor, refused } = responses('');
    assert.equal(HSTS in editor.headers, false);
    assert.equal(HSTS in refused.headers, false);
    assert.equal(editor.headers['X-Content-Type-Options'], 'nosniff', 'the other headers still go');
  });

  it('reports the editor\'s Content-Security-Policy and enforces none', () => {
    const { editor } = responses('');
    const policy = editor.headers['Content-Security-Policy-Report-Only'];
    assert.match(policy, /frame-ancestors 'self'/);
    assert.match(policy, /connect-src 'self'/);
    assert.equal('Content-Security-Policy' in editor.headers, false, 'the editor runs on inline scripts');
  });
});

