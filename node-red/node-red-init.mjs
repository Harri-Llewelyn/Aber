/**
 * Node-RED initialisation.
 *
 * Provisions /data: the flow definition, a generated settings.js, and the MQTT broker
 * credentials encrypted at rest through Node-RED's own credential runtime.
 *
 * Three writes, three different lifetimes:
 *
 *   - the FLOW is user content        -> seed FIRST RUN ONLY (NODE_RED_FORCE_SEED=true resets)
 *   - settings.js is stack config     -> reconcile EVERY BOOT (a volume outlives a fix to it)
 *   - the CREDENTIALS are stack config -> but only while there are none to lose
 *
 * No flow is seeded: the editor opens empty, and the marker file records that this script wrote
 * a blank flow and when. tutorial/README.md holds the walkthrough and the failure modes behind
 * each guard ("Flow provisioning", "Node-RED authentication").
 *
 * Verified against Node-RED 5.0.1.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// settings.js is CommonJS and has to be evaluated, not parsed, to see what it actually declares
// -- see settingsAreCorrect(). This module is ESM, so `require` has to be constructed.
const require = createRequire(import.meta.url);

const DATA_DIR = process.env.NODE_RED_DATA_DIR || '/data';
const RUNTIME_DIR =
  process.env.NODE_RED_RUNTIME_DIR || '/usr/src/node-red/node_modules';

const credentialSecret = process.env.NODERED_CREDENTIAL_SECRET;
// A gateway credential, not a shared platform account: the broker's roles confine each client to
// `spBv1.0/+/+/<sparkplug_id>/#`, so the username must be the gateway's `sparkplug_id`. This pair is the
// legacy fallback for a `mqtt-broker-config` node (see brokerCredentialFor()); current flows
// name their own pair per broker node through `acsCredentialsEnv`.
const mqttUser = process.env.MQTT_USER || 'gwy100000000000400080000';
const mqttPassword = process.env.MQTT_PASSWORD;
const forceSeed = /^(1|true|yes)$/i.test(process.env.NODE_RED_FORCE_SEED || '');

// Bumped whenever the body of the generated settings.js changes in a way an existing volume
// needs; without it a settings.js that merely has an adminAuth passes settingsAreCorrect()
// forever. v2 adminAuth.users; v3 persisted username -> permissions map; v4 constant-time
// NODERED_ADMIN_TOKEN comparison; v5 editorTheme.tours off.
const SETTINGS_VERSION = 5;

function fail(message) {
  console.error(`[node-red-init] ERROR: ${message}`);
  process.exit(1);
}

// Fail closed. A missing secret previously degraded to plaintext-on-disk silently.
// Checked before any write, and unconditionally: settings.js is now reconciled on every boot,
// so there is no longer a path that legitimately runs without these.
if (!credentialSecret) {
  fail('NODERED_CREDENTIAL_SECRET is not set; refusing to write credentials unencrypted.');
}

// A missing auth variable stops the boot: an "auth optional" branch would reopen the admin API.
// Checked here so the failure is one legible message from the init container.
const REQUIRED_AUTH_ENV = [
  'NODERED_OAUTH_CLIENT_ID',
  'NODERED_OAUTH_CLIENT_SECRET',
  'NODERED_OAUTH_AUTH_URL',
  'NODERED_OAUTH_TOKEN_URL',
  'NODERED_OAUTH_CALLBACK_URL',
  'NODERED_USERINFO_URL',
  'SUPABASE_JWT_SECRET',
  'SUPABASE_PUBLISHABLE_KEY',
  'NODERED_WEBHOOK_JWT_SECRET'
];

const missingAuthEnv = REQUIRED_AUTH_ENV.filter((name) => !process.env[name]);
if (missingAuthEnv.length > 0) {
  fail(
    `${missingAuthEnv.join(', ')} not set; refusing to write a settings.js with no adminAuth. ` +
      'Node-RED would come up with its editor and /flows admin API open on port 1880. ' +
      'See secrets.nodered* in values.yaml.'
  );
}

// The flow file name is declared in settings.js below, and the credentials file name is derived
// from it by Node-RED (`<basename>_cred.json`). Both are pinned here so the two agree by
// construction -- a mismatch is exactly the failure this script exists to prevent.
const FLOW_FILE = 'flows.json';
const flowsPath = path.join(DATA_DIR, FLOW_FILE);
const credentialsPath = path.join(DATA_DIR, 'flows_cred.json');
const settingsPath = path.join(DATA_DIR, 'settings.js');
const runtimeConfigPath = path.join(DATA_DIR, '.config.runtime.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

// 1. Seed the flow definition: first run only. The guard is a marker file, not `flows.json`
// existing, because the image ships a placeholder and Docker pre-populates a fresh volume from it.
const SEED_MARKER = path.join(DATA_DIR, '.factoryplus-seeded');
const seededBefore = fs.existsSync(SEED_MARKER);
const seededFlow = !seededBefore || forceSeed;

/**
 * The blank canvas. An empty `flows.json` is a valid flow; SEED_MARKER records that it was
 * written deliberately, so the canvas needs no node to say so.
 */
const EMPTY_FLOW = [];

if (seededFlow) {
  // Anything already here is either the image's placeholder or -- on a volume provisioned before
  // this marker existed -- possibly real work. Backed up rather than assumed worthless, the same
  // courtesy settings.js gets above.
  if (fs.existsSync(flowsPath)) {
    fs.copyFileSync(flowsPath, `${flowsPath}.pre-seed`);
    console.log(`[node-red-init] existing flow backed up to ${flowsPath}.pre-seed`);
  }
  // THE MARKER IS WHAT MAKES AN EMPTY EDITOR READABLE. Without it, a volume this script seeded
  // blank and a volume whose seed failed look identical from inside Node-RED -- and "why is my
  // editor empty" has two very different answers.
  const seedBytes = Buffer.from(`${JSON.stringify(EMPTY_FLOW, null, 2)}\n`);

  fs.writeFileSync(flowsPath, seedBytes);
  fs.writeFileSync(
    SEED_MARKER,
    JSON.stringify({
      seeded_at: new Date().toISOString(),
      source: 'blank flow (this stack seeds none)',
      sha256: crypto.createHash('sha256').update(seedBytes).digest('hex')
    }, null, 2)
  );
  console.log(
    `[node-red-init] blank flow ${forceSeed ? 're-seeded (forced)' : 'seeded'} to ${flowsPath}. ` +
      'The editor opens empty; tutorial/README.md walks through building the first flow.'
  );
} else {
  console.log(
    `[node-red-init] flow already seeded (${SEED_MARKER}); preserving Node-RED editor changes. ` +
      'Set NODE_RED_FORCE_SEED=true to reset the volume to a blank flow.'
  );
}

// 1b. Reconcile the broker node's transport settings (host, port, TLS) on every boot: where the
// broker is is deployment configuration, not user content. Writes a narrow set of keys, only when
// they are explicitly configured. Must run before the credential section, which exits early on
// volumes that hold credentials.
const BROKER_NODE_ID = 'mqtt-broker-config';
const TLS_NODE_ID = 'factoryplus-tls-config';

const mqttTlsEnabled = /^(1|true|yes|on)$/i.test((process.env.MQTT_TLS_ENABLED || '').trim());
const mqttTlsCaFile = (process.env.MQTT_TLS_CA_FILE || '').trim();
const mqttHostEnv = (process.env.MQTT_HOST || '').trim();
const mqttPortEnv = (process.env.MQTT_PORT || '').trim();

if (mqttTlsEnabled && !mqttTlsCaFile) {
  // Fail closed: a tls-config node with no CA verifies against the system trust store, which knows
  // nothing about an internal CA, and the failure names no certificate.
  fail(
    'MQTT_TLS_ENABLED is set but MQTT_TLS_CA_FILE is empty. Node-RED would verify the broker ' +
      'against the system trust store, which cannot verify an internal CA, and the broker node ' +
      'would report only a generic connection failure.'
  );
}
// The port has to move with the transport. The chart derives it from the TLS flag, and TLS
// against the plaintext listener fails as a handshake timeout naming neither, so the pair is
// checked here.
if (mqttTlsEnabled && (!mqttPortEnv || mqttPortEnv === '1883')) {
  fail(
    `MQTT_TLS_ENABLED is set but MQTT_PORT is ${mqttPortEnv || 'unset, leaving the flow on 1883'}. ` +
      'That is the plaintext listener: the broker node would attempt a TLS handshake against it ' +
      'and report only a connection failure. Set MQTT_PORT=8883 alongside MQTT_TLS_ENABLED.'
  );
}

if (mqttTlsEnabled && !fs.existsSync(mqttTlsCaFile)) {
  // Checked here rather than left to Node-RED: an unreadable `ca` path marks the tls-config node
  // invalid and the broker node reports only "Connection failed to broker", the same message a
  // wrong password gives.
  fail(
    `MQTT_TLS_CA_FILE=${mqttTlsCaFile} does not exist. On Kubernetes this is projected from the ` +
      "broker's certificate Secret, so an absent file usually means mosquitto.tls.enabled is off " +
      'while mosquitto.tls.internalClients is on, or the Certificate has not been issued yet.'
  );
}

if (mqttTlsEnabled || mqttPortEnv || mqttHostEnv) {
  const flow = JSON.parse(fs.readFileSync(flowsPath, 'utf8'));

  // Every broker node, not just the first: the broker's roles pin the topic's edge-node segment to the
  // username, so a multi-cell floor has one broker node per gateway.
  const brokers = flow.filter((n) => n.type === 'mqtt-broker');

  // No broker nodes is a legitimate state: a blank flow has none. The check exists for a flow that
  // does declare brokers, deployed against a host it was not authored for.
  if (brokers.length === 0) {
    console.log(
      '[node-red-init] no mqtt-broker nodes in the flow; broker transport settings not applied. ' +
        'That is expected on a blank flow -- nothing is publishing yet.'
    );
  }
  // The loop below iterates `brokers` and the write is guarded on `changes.length`, so an empty
  // list degrades to a no-op without a second branch.

  const changes = [];
  const setField = (broker, key, value) => {
    if (broker[key] !== value) {
      changes.push(`${broker.id}.${key}: ${JSON.stringify(broker[key])} -> ${JSON.stringify(value)}`);
      broker[key] = value;
    }
  };

  const applyTls = (broker) => {
    setField(broker, 'usetls', true);
    // Both `verifyservercert` fields are set. 05-tls.js sets `rejectUnauthorized` unconditionally
    // from the tls-config node's value, and 10-mqtt.js falls back to the broker node's, which
    // defaults to false. Leaving either out is TLS with no verification and no warning.
    setField(broker, 'verifyservercert', true);
    setField(broker, 'tls', TLS_NODE_ID);

    // ONE tls-config node shared by every broker. They all reach the same broker over the same
    // internal CA, so a node each would be N copies of one fact to keep in step.
    let tlsNode = flow.find((n) => n.id === TLS_NODE_ID);
    if (!tlsNode) {
      tlsNode = { id: TLS_NODE_ID, type: 'tls-config' };
      // Config nodes sit at the top level with no `z`, like mqtt-broker-config itself.
      flow.push(tlsNode);
      changes.push(`added tls-config node '${TLS_NODE_ID}'`);
    }
    Object.assign(tlsNode, {
      name: 'Factory+ internal CA',
      // certType 'files' means cert/key/ca are paths read at deploy time. Stated explicitly because
      // 05-tls.js defaults it and a default change would silently reinterpret `ca`.
      certType: 'files',
      ca: mqttTlsCaFile,
      // Empty, and they must BOTH stay empty: 05-tls.js marks the node invalid if exactly one of
      // cert/key is set ("missing-file"), and an invalid tls-config node still sets
      // rejectUnauthorized -- so the connection would fail verification with the CA silently unused.
      cert: '',
      key: '',
      verifyservercert: true,
      servername: '',
      alpnprotocol: ''
    });
  };

  // The inverse of applyTls. Turning TLS off used to move the port and leave `usetls: true`, a TLS
  // handshake against the plaintext listener reported as "Connection failed to broker".
  // Reconciliation has to be bidirectional. The tls-config node is left in place: it is inert
  // with `usetls` false.
  const clearTls = (broker) => {
    setField(broker, 'usetls', false);
    setField(broker, 'tls', '');
  };

  // The protocol version is reconciled, not seeded: it is transport, not user content, and a
  // volume that kept its own flows.json would otherwise speak MQTT 3.1.1 while the daemon speaks
  // 5. Not an environment variable: the daemon's protocol is a constant in Python, and a knob
  // would only produce a combination nobody tests.
  const PROTOCOL_VERSION = '5';

  for (const broker of brokers) {
    setField(broker, 'protocolVersion', PROTOCOL_VERSION);
    if (mqttHostEnv) setField(broker, 'broker', mqttHostEnv);
    // Node-RED stores the port as a STRING. A number works at runtime but shows as empty in the
    // editor's port field, so the node looks misconfigured to whoever opens it next.
    if (mqttPortEnv) setField(broker, 'port', String(mqttPortEnv));
    if (mqttTlsEnabled) applyTls(broker); else clearTls(broker);
  }

  if (changes.length) {
    fs.writeFileSync(flowsPath, JSON.stringify(flow, null, 4));
    console.log(
      `[node-red-init] broker transport reconciled (${changes.join('; ')}).` +
        (mqttTlsEnabled ? ` Verifying the broker against ${mqttTlsCaFile}.` : '')
    );
  } else {
    console.log('[node-red-init] broker transport already matches the environment; flow untouched.');
  }
}

// 2. Reconcile settings.js on every boot. Stack configuration, not user content; only rewritten
// when it does not already declare every key correctly. The check loads the module rather than
// grepping it: Node-RED's default settings.js mentions `credentialSecret` in a commented-out
// example. It checks the auth keys and SETTINGS_VERSION too.
function settingsAreCorrect() {
  if (!fs.existsSync(settingsPath)) return false;
  try {
    const loaded = require(settingsPath);
    return (
      loaded?.credentialSecret === credentialSecret &&
      loaded?.flowFile === FLOW_FILE &&
      loaded?.acsCymruSettingsVersion === SETTINGS_VERSION &&
      loaded?.adminAuth?.type === 'strategy' &&
      typeof loaded?.adminAuth?.tokens === 'function' &&
      typeof loaded?.adminAuth?.authenticate === 'function' &&
      // `users` is checked separately from `authenticate` because they cover different halves:
      // authenticate runs at login, users runs on every request after it. A file with only the
      // first logs in fine and then 401s the whole editor.
      typeof loaded?.adminAuth?.users === 'function' &&
      // adminAuth.default re-opens the anonymous path wholesale. Treat its presence as a
      // broken file rather than as a preference to preserve.
      loaded?.adminAuth?.default === undefined &&
      typeof loaded?.httpNodeAuth === 'function'
    );
  } catch (err) {
    // Unloadable settings cannot be trusted to declare anything. Replaced (with a backup). If this
    // fires on every boot, the init container is missing the modules settings.js requires.
    console.warn(`[node-red-init] settings.js could not be loaded (${err.message}); replacing it.`);
    return false;
  }
}

// 2b. The generated settings.js. Configuration is read from process.env at Node-RED load time,
// not baked in: this file sits on a volume every flow author can read. The one exception is
// credentialSecret, which node-red-init compares against above. The require()s are absolute:
// this file lives at /data, so a bare require would never search the image's node_modules.
const SETTINGS_JS = `/**
 * GENERATED by node-red/node-red-init.mjs -- do not edit.
 *
 * Hand edits are detected by settingsAreCorrect() and overwritten on the next boot; the
 * previous file is kept as settings.js.bak. Change the generator instead, and bump its
 * SETTINGS_VERSION so deployed volumes pick the change up.
 *
 * THREE INDEPENDENT AUTH SURFACES, none of which overlaps another:
 *
 *   adminAuth.strategy  -- humans, in a browser. OAuth2 + PKCE against GoTrue, identity and
 *                          role from the nodered-userinfo edge function.
 *   adminAuth.tokens    -- services calling the admin API. Verifies the Supabase access token
 *                          that deploy-nodered forwards from the operator who triggered it.
 *   httpNodeAuth        -- the http-in nodes (POST /hooks/quarantine). adminAuth does NOT
 *                          cover these: they mount under httpNodeRoot, a separate Express
 *                          mount (node-red/red.js:426), which is why the webhook stayed open
 *                          in every design that only set adminAuth.
 */
const OAuth2Strategy = require(${JSON.stringify(`${RUNTIME_DIR}/passport-oauth2`)});
const jwt = require(${JSON.stringify(`${RUNTIME_DIR}/jsonwebtoken`)});
// A Node builtin, so it resolves without the absolute path the two above need.
const { timingSafeEqual } = require('crypto');

const env = process.env;

/**
 * Constant-time secret comparison. timingSafeEqual throws on a length mismatch, so unequal
 * lengths are answered by comparing the expected value against itself and returning false.
 * Used for the break-glass admin token, which returns permissions '*'.
 */
function secretEquals(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Supabase RBAC role -> Node-RED permissions. Node-RED only has '*' and 'read'. Operator and
 * Auditor map to 'read': a flow function node executes arbitrary JavaScript in a container
 * holding the MQTT credential. The mapping lives server-side in the nodered-userinfo function.
 */

/**
 * Resolve identity and permissions for a Supabase access token.
 *
 * Not read from the token's claims: GoTrue's OIDC claims omit app_metadata, and a claim-based
 * role would outlive its revocation. The edge function reads public.user_roles, as RLS does.
 */
async function userinfo(accessToken) {
  try {
    const res = await fetch(env.NODERED_USERINFO_URL, {
      headers: {
        Authorization: 'Bearer ' + accessToken,
        apikey: env.SUPABASE_PUBLISHABLE_KEY
      }
    });
    if (!res.ok) {
      // Say why: every refusal below ends as a bare redirect to the login screen. 401 means the
      // apikey or bearer was rejected at the gateway; 404 means the function is not registered in
      // supabase/functions/main/index.ts.
      console.warn(
        '[aber] userinfo ' + env.NODERED_USERINFO_URL + ' -> HTTP ' + res.status +
        '; refusing the sign-in.'
      );
      return null;
    }
    return await res.json();
  } catch (err) {
    // A userinfo endpoint that cannot be reached is not evidence of a role. Fail closed.
    console.warn('[aber] userinfo lookup failed: ' + err.message);
    return null;
  }
}

// Short-lived cache so an admin API burst is not one HTTP round trip per request. Keyed by the
// token, so it expires with the token and cannot outlive a revocation by more than TTL_MS.
const roleCache = new Map();
const CACHE_TTL_MS = 30000;

/**
 * Username -> permissions, for adminAuth.users. Node-RED re-resolves the user by username on
 * every editor request, long after the OAuth profile has gone.
 *
 * Persisted, because Node-RED writes editor sessions to /data/.sessions.json and they outlive a
 * restart; an in-memory map would leave the session authenticated with no permissions, which
 * the editor renders as a padlock on Deploy. The file holds usernames and permission strings
 * only; a role change reaches the editor at the next sign-in.
 */
// path.posix, not path.join: this string is baked into a file that only ever runs inside the
// container, but the generator can be run from Windows, where join() would emit a backslash path.
const EDITOR_USERS_FILE = ${JSON.stringify(path.posix.join(DATA_DIR, '.factoryplus-editor-users.json'))};
const editorUsers = new Map();

try {
  const stored = JSON.parse(require('fs').readFileSync(EDITOR_USERS_FILE, 'utf8'));
  for (const [name, permissions] of Object.entries(stored)) editorUsers.set(name, permissions);
} catch (err) {
  // Absent on first boot, and unreadable is no worse than absent: the fallback in \`users\`
  // keeps existing sessions working, they just render read-only until the next sign-in.
  if (err.code !== 'ENOENT') {
    console.warn('[aber] could not read ' + EDITOR_USERS_FILE + ': ' + err.message);
  }
}

function rememberEditorUser(username, permissions) {
  if (editorUsers.get(username) === permissions) return;
  editorUsers.set(username, permissions);
  try {
    require('fs').writeFileSync(
      EDITOR_USERS_FILE,
      JSON.stringify(Object.fromEntries(editorUsers), null, 2)
    );
  } catch (err) {
    // Non-fatal: the sign-in itself has already succeeded and the in-memory map still serves
    // this process. Only the next restart would notice.
    console.warn('[aber] could not persist ' + EDITOR_USERS_FILE + ': ' + err.message);
  }
}

function cacheGet(token) {
  const hit = roleCache.get(token);
  if (!hit) return null;
  if (hit.at < Date.now() - CACHE_TTL_MS) {
    roleCache.delete(token);
    return null;
  }
  return hit.user;
}

function cachePut(token, user) {
  // Bounded: an unauthenticated flood of distinct valid-looking tokens must not grow this
  // without limit. Entries are worthless once expired, so the oldest insert is the right evict.
  if (roleCache.size > 256) roleCache.delete(roleCache.keys().next().value);
  roleCache.set(token, { user: user, at: Date.now() });
}

module.exports = {
  acsCymruSettingsVersion: ${SETTINGS_VERSION},

  flowFile: ${JSON.stringify(FLOW_FILE)},
  credentialSecret: ${JSON.stringify(credentialSecret)},

  editorTheme: {
    // OFF, because it is shown per BROWSER rather than per user: Node-RED records that the tour
    // was seen in localStorage, and this editor is reached through the platform's own sign-in, so
    // a shared workstation or a cleared profile replays it at somebody who has seen it already.
    // It is also a tour of stock Node-RED, which is not what a flow author is here to learn.
    tours: false
  },

  adminAuth: {
    type: 'strategy',

    // Node-RED's default editor session is 7 days, and the role is only re-derived at login. Eight
    // hours bounds a revoked user to about a shift. The machine path re-checks within 30s.
    sessionExpiryTime: 28800,

    strategy: {
      name: 'oauth2',
      label: 'Sign in with Aber',
      icon: 'fa-cube',
      strategy: OAuth2Strategy,
      options: {
        authorizationURL: env.NODERED_OAUTH_AUTH_URL,
        tokenURL: env.NODERED_OAUTH_TOKEN_URL,
        clientID: env.NODERED_OAUTH_CLIENT_ID,
        clientSecret: env.NODERED_OAUTH_CLIENT_SECRET,
        callbackURL: env.NODERED_OAUTH_CALLBACK_URL,

        // No 'openid' scope, deliberately: requesting it makes GoTrue try to mint an ID token and
        // refuse with "HS256 is not supported for ID token signing". Identity comes from userinfo().
        // Same decision as grafana.ini.
        scope: ['email', 'profile'],

        // GoTrue's OAuth server requires PKCE. pkce implies state, and state needs the session store
        // Node-RED's genericStrategy installs.
        pkce: true,
        state: true,

        // The client is registered token_endpoint_auth_method = 'client_secret_post' in
        // auth.oauth_clients, which is what passport-oauth2 does by default; GoTrue enforces whichever
        // is registered.

        /**
         * Node-RED calls this with the strategy's own verify arguments and replaces the final
         * callback, expecting (err, profile). The profile is handed to adminAuth.authenticate below.
         */
        async verify(accessToken, refreshToken, profile, done) {
          try {
            const info = await userinfo(accessToken);
            // No permissions key means the edge function could not map this user's role -- an
            // unmapped or revoked role. Refuse the login rather than admitting them read-only:
            // a provisioning error should be visible as one.
            if (!info || !info.permissions) {
              if (info) {
                console.warn(
                  '[aber] sign-in refused for ' + (info.email || info.sub) +
                  ': supabase_role=' + info.supabase_role + ' maps to no Node-RED permissions. ' +
                  'Add a public.user_roles row for this user.'
                );
              }
              return done(null, false);
            }
            console.log(
              '[aber] sign-in: ' + info.email + ' (' + info.supabase_role +
              ') -> permissions=' + info.permissions
            );
            return done(null, {
              username: info.email || info.sub,
              email: info.email,
              permissions: info.permissions,
              supabase_role: info.supabase_role
            });
          } catch (err) {
            return done(err);
          }
        }
      }
    },

    /**
     * adminAuth.users receives only a username; adminAuth.authenticate receives the whole profile,
     * so the role has to ride through here. Variadic because the same hook backs the OAuth2
     * password grant on POST /auth/token, which is refused outright: there are no local passwords.
     */
    authenticate: async function (profile, password) {
      if (password !== undefined) return null;
      if (!profile || !profile.permissions) return null;
      rememberEditorUser(profile.username, profile.permissions);
      return { username: profile.username, permissions: profile.permissions };
    },

    /**
     * Resolve a user by username. Required: bearerStrategy calls Users.get() on every editor
     * request. It must return permissions, or the editor draws a padlock on Deploy. The last-resort
     * branch returns a bare username to keep an unknown session alive; enforcement reads the
     * token's stored scope, not this object.
     */
    users: async function (username) {
      const permissions = editorUsers.get(username);
      return permissions ? { username: username, permissions: permissions } : { username: username };
    },

    /**
     * Machine-to-machine access to the admin API, read from Authorization: Bearer. deploy-nodered
     * forwards the operator's access token; the role is re-derived from public.user_roles rather
     * than trusted, so a revocation takes effect on both sides at once.
     */
    tokenHeader: 'authorization',
    tokens: async function (token) {
      if (!token) return null;

      // Break-glass, empty by default: if Supabase Auth, the gateway or the edge runtime is down then
      // SSO is down with them. Same reasoning as disable_login_form = false in grafana/grafana.ini.
      // secretEquals() refuses an unset token, so there is one answer to "is this the token".
      if (secretEquals(token, env.NODERED_ADMIN_TOKEN)) {
        return { username: 'aber-break-glass', permissions: '*' };
      }

      // Signature, expiry and audience first, so an unverified token never reaches the network.
      try {
        jwt.verify(token, env.SUPABASE_JWT_SECRET, {
          algorithms: ['HS256'],
          audience: 'authenticated'
        });
      } catch (err) {
        return null;
      }

      const cached = cacheGet(token);
      if (cached) return cached;

      const info = await userinfo(token);
      if (!info || !info.permissions) return null;

      const user = { username: info.email || info.sub, permissions: info.permissions };
      cachePut(token, user);
      return user;
    }

    // adminAuth.default is deliberately absent: setting it grants an anonymous identity to every
    // unauthenticated request. With no default, passport's 'anon' arm has nothing to return.
  },

  /**
   * Authentication for the http-in nodes (POST /hooks/quarantine). A function, because Node-RED
   * accepts Express middleware here, which allows a bearer check instead of HTTP Basic.
   *
   * The token is not the admin credential and must never be: a flow author can read
   * msg.req.headers, so anything sent here is readable by every flow. The database mints a fresh
   * 60-second JWT per event, scoped aud=node-red-hooks.
   */
  httpNodeAuth: function (req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      res.set('WWW-Authenticate', 'Bearer');
      return res.status(401).end();
    }
    try {
      jwt.verify(token, env.NODERED_WEBHOOK_JWT_SECRET, {
        algorithms: ['HS256'],
        audience: 'node-red-hooks',
        issuer: 'aber-supabase'
      });
      return next();
    } catch (err) {
      return res.status(401).end();
    }
  }
};
`;

if (!settingsAreCorrect()) {
  // Never destroyed outright: a user may have hand-edited this file, and a .bak beside it is the
  // difference between a recoverable surprise and a lost afternoon.
  if (fs.existsSync(settingsPath)) {
    fs.copyFileSync(settingsPath, `${settingsPath}.bak`);
    console.log(`[node-red-init] previous settings.js backed up to ${settingsPath}.bak`);
  }
  fs.writeFileSync(settingsPath, SETTINGS_JS);
  console.log(
    `[node-red-init] settings.js written (v${SETTINGS_VERSION}, flowFile=${FLOW_FILE}, ` +
      'credentialSecret set, adminAuth=strategy+tokens, httpNodeAuth=bearer).'
  );
} else {
  console.log(`[node-red-init] settings.js already correct (v${SETTINGS_VERSION}); left untouched.`);
}

// 3. Decide whether the broker credentials may be (re)written: only while there are none to
// lose. Credentials that carry content were entered through the editor and are encrypted under
// whatever key Node-RED was using; rewriting them, or clearing the key, would destroy them.
function credentialsWorthKeeping() {
  if (!fs.existsSync(credentialsPath)) return false;
  try {
    const existing = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    if (typeof existing?.$ === 'string') return existing.$.length > 0;
    return Object.keys(existing || {}).length > 0;
  } catch {
    return false;  // Unparseable is not worth keeping.
  }
}

/**
 * The broker username currently stored in flows_cred.json, or null if it cannot be read. A file
 * we cannot decrypt is not ours to judge, so it reads as null and is left untouched.
 */
function storedBrokerCredential(nodeId = BROKER_NODE_ID) {
  if (!fs.existsSync(credentialsPath)) return null;
  try {
    const existing = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    if (typeof existing?.$ !== 'string' || existing.$.length === 0) return null;
    const key = crypto.createHash('sha256').update(credentialSecret).digest();
    const iv = Buffer.from(existing.$.substring(0, 32), 'hex');
    const decipher = crypto.createDecipheriv('aes-256-ctr', key, iv);
    const plain =
      decipher.update(existing.$.substring(32), 'base64', 'utf8') + decipher.final('utf8');
    return JSON.parse(plain)[nodeId] || null;
  } catch {
    return null;
  }
}

/**
 * Which credential each broker node in the flow should carry.
 *
 * One connection per gateway, because the broker's roles pin the edge-node segment to the username.
 * The env prefix is declared on the node in `acsCredentialsEnv`, not derived from its id: a
 * convention is invisible when it breaks, and the only symptom is "Connection failed to broker".
 * The credential tooling emits exactly these variable names. The legacy node keeps reading
 * MQTT_USER / MQTT_PASSWORD with no declaration.
 */
function brokerCredentialFor(node) {
  const prefix = node.acsCredentialsEnv;

  if (!prefix) {
    if (node.id === BROKER_NODE_ID) {
      // Checked here, not at start-up, so a stack whose flow has no legacy node boots without the
      // legacy pair. A flow that contains this node still refuses to be seeded without a password:
      // seeding an empty one produces a CONNACK 5 the editor reports with no cause.
      if (!mqttPassword) {
        fail(
          `this volume's flow carries the legacy '${BROKER_NODE_ID}' node, but MQTT_PASSWORD is not set.
  That node predates the per-cell consolidation and reads MQTT_USER / MQTT_PASSWORD
  which are empty by default because the account they
  name was retired by archived migration 0020.

  Either set MQTT_SIMULATOR_PASSWORD and re-provision that account, or reseed the flow
  with NODE_RED_FORCE_SEED=true to drop the legacy node entirely.`
        );
      }
      return { user: mqttUser, password: mqttPassword };
    }
    fail(
      `broker node '${node.id}' (${node.name || 'unnamed'}) declares no 'acsCredentialsEnv' and is ` +
        `not the legacy '${BROKER_NODE_ID}'. It would connect with no username, and Mosquitto ` +
        'refuses that with CONNACK 5 while Node-RED reports only "Connection failed to broker".'
    );
  }

  const user = process.env[`${prefix}_USER`];
  const password = process.env[`${prefix}_PASSWORD`];

  // FAIL CLOSED. An absent variable would otherwise seed an empty username, which the broker
  // refuses and the editor reports as a connection failure with no cause -- the exact ambiguity
  // this script exists to remove. Naming both the node and the variable makes it one fix.
  if (!user || !password) {
    fail(
      `broker node '${node.id}' declares acsCredentialsEnv='${prefix}', but ` +
        `${prefix}_USER and/or ${prefix}_PASSWORD are not set.\n` +
        '  Mint the credential from the dashboard: Gateways tab, Generate broker credential.\n' +
        '  Add them to the release Secret and restart node-red-init.'
    );
  }

  return { user, password };
}

/**
 * A changed broker identity forces a rewrite of the otherwise seed-once credentials. The
 * username is the gateway's `sparkplug_id`, not user content; a stale one authenticates as an
 * account that no longer exists and reports only "Connection failed to broker: <clientId>@...".
 * Only a differing user triggers this: a password an operator changed in the editor is left
 * alone.
 */
// Read the flow to find every broker node that needs a credential. Done here rather than reusing
// the copy above, because that block only runs when a transport variable is set.
const flowForCredentials = JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
const brokerNodes = flowForCredentials.filter((n) => n.type === 'mqtt-broker');
const brokerCredentials = new Map(
  brokerNodes.map((node) => [node.id, brokerCredentialFor(node)])
);

// ANY broker whose stored username no longer matches forces the rewrite. Checked across all of
// them, not just the first: a single stale account is enough to take one cell silently offline,
// and the rest of the floor carrying on makes that harder to notice, not easier.
const identityChanges = [];
for (const [nodeId, desired] of brokerCredentials) {
  const stored = storedBrokerCredential(nodeId);
  if (stored && stored.user !== desired.user) {
    identityChanges.push(`${nodeId}: '${stored.user}' -> '${desired.user}'`);
  }
}
const brokerIdentityChanged = identityChanges.length > 0;

// A broker node present in the flow with NO stored credential at all is also a rewrite: it is what
// adding a cell to an existing volume looks like, and without this the new gateway would sit there
// unauthenticated while the seeded ones kept working.
const missingCredential = credentialsWorthKeeping() &&
  [...brokerCredentials.keys()].some((nodeId) => storedBrokerCredential(nodeId) === null);

const writeCredentials =
  seededFlow || !credentialsWorthKeeping() || brokerIdentityChanged || missingCredential;

if (brokerIdentityChanged) {
  console.log(
    `[node-red-init] broker username changed (${identityChanges.join('; ')}); ` +
      'rewriting flows_cred.json. The old account no longer exists, and Node-RED would report ' +
      'only "Connection failed to broker" if it kept using it.'
  );
}

if (missingCredential && !brokerIdentityChanged) {
  console.log(
    '[node-red-init] a broker node in the flow has no stored credential (a cell was added); ' +
      'rewriting flows_cred.json so every gateway can authenticate.'
  );
}

// 3b. Drop any credential key Node-RED generated for itself on an earlier boot. A minted
// `_credentialSecret` wins over ours, fails to decrypt flows_cred.json, and rewrites it empty.
// Guarded by writeCredentials, not the seed path: the question is whether there is ciphertext
// only this key can open.
if (writeCredentials && fs.existsSync(runtimeConfigPath)) {
  try {
    const runtimeConfig = JSON.parse(fs.readFileSync(runtimeConfigPath, 'utf8'));
    if (Object.prototype.hasOwnProperty.call(runtimeConfig, '_credentialSecret')) {
      delete runtimeConfig._credentialSecret;
      fs.writeFileSync(runtimeConfigPath, JSON.stringify(runtimeConfig, null, 4));
      console.log(
        '[node-red-init] cleared a self-generated _credentialSecret; ' +
          'Node-RED will now use the key from settings.js.'
      );
    }
  } catch (err) {
    // Corrupt or unreadable: Node-RED regenerates this file, and leaving a stale key behind is
    // worse than losing the instance id, so remove it rather than failing the boot.
    fs.rmSync(runtimeConfigPath, { force: true });
    console.warn(
      `[node-red-init] .config.runtime.json unreadable (${err.message}); removed so Node-RED can rebuild it.`
    );
  }
}

if (!writeCredentials) {
  console.log(
    '[node-red-init] existing flows_cred.json holds credentials; leaving them and the ' +
      'credential key untouched.'
  );
  process.exit(0);
}

// 4. Encrypt the credentials via Node-RED's own runtime module.
const credentials = (
  await import(`${RUNTIME_DIR}/@node-red/runtime/lib/nodes/credentials.js`)
).default;

const noop = () => {};
credentials.init({
  // export() calls log.debug/log.warn; init() would otherwise leave `log`
  // undefined and throw the moment encryption is actually enabled.
  log: { debug: noop, warn: noop, trace: noop, info: noop, _: (s) => s },
  settings: {}
});

credentials.setKey(credentialSecret);
for (const [nodeId, credential] of brokerCredentials) {
  await credentials.add(nodeId, credential);
}
// Zero is a legitimate count (a blank flow declares no broker nodes) and is said as such, rather
// than printed as an empty list that reads like a lookup that returned nothing.
if (brokerCredentials.size === 0) {
  console.log(
    '[node-red-init] no broker nodes in the flow, so there are no credentials to seed. ' +
      'That is the blank flow this stack seeds; add a broker node and its credential pair to change it.'
  );
} else {
  console.log(
    `[node-red-init] seeding credentials for ${brokerCredentials.size} broker node(s): ` +
      [...brokerCredentials].map(([id, c]) => `${id}=${c.user}`).join(', ')
  );
}

const exported = await credentials.export();

// 5. Assert we really produced ciphertext. This is the guard that the previous
//    implementation lacked -- it failed open and wrote readable passwords.
if (!Object.prototype.hasOwnProperty.call(exported, '$')) {
  fail(
    'credential export was not encrypted (missing "$" envelope). ' +
      'Node-RED internals may have changed; refusing to write plaintext secrets.'
  );
}

// 6. Prove Node-RED will be able to read every credential back before committing it to disk.
// Checked per broker node, not against one hardcoded id: a partial check would pass on the one
// node it knew about and say nothing about the rest.
try {
  const key = crypto.createHash('sha256').update(credentialSecret).digest();
  const blob = exported.$;
  const iv = Buffer.from(blob.substring(0, 32), 'hex');
  const decipher = crypto.createDecipheriv('aes-256-ctr', key, iv);
  const plain =
    decipher.update(blob.substring(32), 'base64', 'utf8') + decipher.final('utf8');
  const decoded = JSON.parse(plain);

  for (const [nodeId, expected] of brokerCredentials) {
    const roundTripped = decoded[nodeId];
    if (roundTripped?.user !== expected.user || roundTripped?.password !== expected.password) {
      fail(
        `credential round-trip mismatch for broker node '${nodeId}'; refusing to write. ` +
          'Node-RED would not have been able to decrypt it, and the gateway would report only ' +
          '"Connection failed to broker".'
      );
    }
  }
} catch (err) {
  fail(`credential round-trip failed: ${err.message}`);
}

fs.writeFileSync(credentialsPath, JSON.stringify(exported));

console.log(
  brokerCredentials.size === 0
    // Still WRITTEN, and deliberately so: an empty encrypted envelope is what proves the
    // credential key in settings.js is the one Node-RED will use, and it is what stops Node-RED
    // minting a `_credentialSecret` of its own on first start -- the failure section 3b exists for.
    ? `[node-red-init] empty credential file written encrypted (aes-256-ctr) to ${credentialsPath}; ` +
        'nothing in the flow needs an account.'
    : `[node-red-init] broker credentials written encrypted (aes-256-ctr) to ${credentialsPath} ` +
        `for ${brokerCredentials.size} gateway account(s).`
);
