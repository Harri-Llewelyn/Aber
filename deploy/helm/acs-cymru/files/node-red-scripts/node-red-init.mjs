/**
 * Node-RED initialisation for the Factory+ stack.
 *
 * Provisions /data: the repo's flow definition, a generated settings.js, and the MQTT broker
 * credentials encrypted at rest through Node-RED's own credential runtime.
 *
 * THREE WRITES, THREE DIFFERENT LIFETIMES. They cannot share one guard:
 *
 *   - the FLOW is user content        -> seed FIRST RUN ONLY (NODE_RED_FORCE_SEED=true resets)
 *   - settings.js is stack config     -> reconcile EVERY BOOT (a volume outlives a fix to it)
 *   - the CREDENTIALS are stack config -> but only while there are none to lose
 *
 * Every guard below carries a one-line note. The failure modes behind them -- why `flowFile` is
 * load-bearing, why `_credentialSecret` silently defeats the seed, why settings.js is LOADED
 * rather than grepped, and how to tell an auth failure from a network one -- are documented in:
 *
 *   simulators/README.md -> "Flow provisioning" and "Node-RED authentication"
 *
 * Verified against Node-RED 5.0.1 (nodered/node-red:latest).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// settings.js is CommonJS and has to be evaluated, not parsed, to see what it actually declares
// -- see settingsAreCorrect(). This module is ESM, so `require` has to be constructed.
const require = createRequire(import.meta.url);

const DATA_DIR = process.env.NODE_RED_DATA_DIR || '/data';
const SEED_FLOW = process.env.NODE_RED_SEED_FLOW || '/seed/flows.json';
const RUNTIME_DIR =
  process.env.NODE_RED_RUNTIME_DIR || '/usr/src/node-red/node_modules';

const credentialSecret = process.env.NODERED_CREDENTIAL_SECRET;
// The SIMULATOR'S OWN GATEWAY CREDENTIAL, not a shared platform account. mosquitto.acl confines
// each client to `spBv1.0/+/+/%u/#`, so this username must be the `sparkplug_id` of the gateway
// the flow publishes under -- Virtual_Gateway_NodeRED, whose UUID is pinned in 0002_seed_data.sql
// precisely so that id is knowable in advance. A friendly name here would authenticate fine and
// then have every publish silently dropped by the broker.
const mqttUser = process.env.MQTT_USER || 'gwy100000000000400080000';
const mqttPassword = process.env.MQTT_PASSWORD;
const forceSeed = /^(1|true|yes)$/i.test(process.env.NODE_RED_FORCE_SEED || '');

// Bumped whenever the BODY of the generated settings.js changes in a way an existing volume
// needs. Without it, a settings.js that merely *has* an adminAuth passes settingsAreCorrect()
// forever, and a fix to the token validation below would never reach a deployed stack -- the
// same class of trap as the `flowFile` omission this script was written to prevent.
// v2 added adminAuth.users. Without it the OAuth handshake completes and every editor request
// afterwards 401s -- see the comment on `users` in the generated file.
// v3 persisted the username -> permissions map. Holding it only in memory made every restart
// silently downgrade live sessions to a read-only editor (padlocked Deploy).
const SETTINGS_VERSION = 3;

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
if (!mqttPassword) {
  fail('MQTT_PASSWORD is not set; refusing to seed empty broker credentials.');
}

// Same posture, applied to authentication. THE PREVIOUS DEFAULT WAS AN OPEN ADMIN API, so a
// missing variable has to stop the boot rather than quietly fall back to it -- an "auth
// optional" branch here would reintroduce exactly the hole this exists to close. Node-RED
// reads these from its own environment at settings-load time; they are checked here so the
// failure is one legible message from the init container instead of a login that never works.
const REQUIRED_AUTH_ENV = [
  'NODERED_OAUTH_CLIENT_ID',
  'NODERED_OAUTH_CLIENT_SECRET',
  'NODERED_OAUTH_AUTH_URL',
  'NODERED_OAUTH_TOKEN_URL',
  'NODERED_OAUTH_CALLBACK_URL',
  'NODERED_USERINFO_URL',
  'SUPABASE_JWT_SECRET',
  'SUPABASE_ANON_KEY',
  'NODERED_WEBHOOK_JWT_SECRET'
];

const missingAuthEnv = REQUIRED_AUTH_ENV.filter((name) => !process.env[name]);
if (missingAuthEnv.length > 0) {
  fail(
    `${missingAuthEnv.join(', ')} not set; refusing to write a settings.js with no adminAuth. ` +
      'Node-RED would come up with its editor and /flows admin API open on port 1880. ' +
      'See the Node-RED section of .env.example.'
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

// 1. Seed the flow definition from the repo -- FIRST RUN ONLY. The only user content here.
//
// THE GUARD IS A MARKER FILE, NOT `flows.json` EXISTING: the image ships a placeholder flows.json
// and Docker pre-populates a fresh volume from it, so that file exists before this script has ever
// run. A marker records what this script DID. (simulators/README.md -> "Flow provisioning")
const SEED_MARKER = path.join(DATA_DIR, '.factoryplus-seeded');
const seededBefore = fs.existsSync(SEED_MARKER);
const seededFlow = !seededBefore || forceSeed;

if (seededFlow) {
  if (!fs.existsSync(SEED_FLOW)) {
    fail(`seed flow not found at ${SEED_FLOW}`);
  }
  // Anything already here is either the image's placeholder or -- on a volume provisioned before
  // this marker existed -- possibly real work. Backed up rather than assumed worthless, the same
  // courtesy settings.js gets above.
  if (fs.existsSync(flowsPath)) {
    fs.copyFileSync(flowsPath, `${flowsPath}.pre-seed`);
    console.log(`[node-red-init] existing flow backed up to ${flowsPath}.pre-seed`);
  }
  fs.copyFileSync(SEED_FLOW, flowsPath);
  fs.writeFileSync(
    SEED_MARKER,
    JSON.stringify({
      seeded_at: new Date().toISOString(),
      source: SEED_FLOW,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(SEED_FLOW)).digest('hex')
    }, null, 2)
  );
  console.log(`[node-red-init] flow ${forceSeed ? 're-seeded (forced)' : 'seeded'} to ${flowsPath}.`);
} else {
  console.log(
    `[node-red-init] flow already seeded (${SEED_MARKER}); preserving Node-RED editor changes. ` +
      'Set NODE_RED_FORCE_SEED=true to reset the volume to the repo flow.'
  );
}

// 1b. Reconcile the broker node's TRANSPORT settings -- host, port, TLS -- on every boot.
//
// The broker node straddles the seed/reconcile line: it lives inside flows.json, but WHERE the
// broker is and whether the connection is encrypted is deployment configuration, not user content.
// So this writes a narrow set of keys on ONE node, only when they are explicitly configured -- on
// the Compose default it does nothing and the flow stays byte-identical.
//
// MUST run before the credential section, which exits early when there are credentials it must not
// overwrite; after it, the reconciliation would be skipped on the oldest volumes.
const BROKER_NODE_ID = 'mqtt-broker-config';
const TLS_NODE_ID = 'factoryplus-tls-config';

const mqttTlsEnabled = /^(1|true|yes|on)$/i.test((process.env.MQTT_TLS_ENABLED || '').trim());
const mqttTlsCaFile = (process.env.MQTT_TLS_CA_FILE || '').trim();
const mqttHostEnv = (process.env.MQTT_HOST || '').trim();
const mqttPortEnv = (process.env.MQTT_PORT || '').trim();

if (mqttTlsEnabled && !mqttTlsCaFile) {
  // Fail closed, same posture as the credential secret. Node-RED's tls-config node with no CA and
  // verifyservercert true verifies against the SYSTEM trust store, which knows nothing about an
  // internal CA -- so the broker node would fail to connect with a generic
  // "Connection failed to broker" and no mention of certificates at all.
  fail(
    'MQTT_TLS_ENABLED is set but MQTT_TLS_CA_FILE is empty. Node-RED would verify the broker ' +
      'against the system trust store, which cannot verify an internal CA, and the broker node ' +
      'would report only a generic connection failure.'
  );
}
if (mqttTlsEnabled && !fs.existsSync(mqttTlsCaFile)) {
  // Checked HERE rather than left to Node-RED, because of how 05-tls.js handles it: an unreadable
  // `ca` path marks the tls-config node invalid, and addTLSOptions() then attaches NO ca while
  // still setting rejectUnauthorized. The broker node reports only
  // "Connection failed to broker: <clientId>@<url>" -- the same message a wrong password gives --
  // with the certificate never mentioned. Diagnosing that from the editor is most of an afternoon.
  fail(
    `MQTT_TLS_CA_FILE=${mqttTlsCaFile} does not exist. On Kubernetes this is projected from the ` +
      "broker's certificate Secret, so an absent file usually means mosquitto.tls.enabled is off " +
      'while mosquitto.tls.internalClients is on, or the Certificate has not been issued yet.'
  );
}

if (mqttTlsEnabled || mqttPortEnv || mqttHostEnv) {
  const flow = JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
  const broker = flow.find((n) => n.id === BROKER_NODE_ID);
  if (!broker) {
    fail(
      `flow at ${flowsPath} has no node with id '${BROKER_NODE_ID}'. The broker transport settings ` +
        'could not be applied; the deployed flow does not match the repository flow.'
    );
  }

  const changes = [];
  const setField = (key, value) => {
    if (broker[key] !== value) {
      changes.push(`${key}: ${JSON.stringify(broker[key])} -> ${JSON.stringify(value)}`);
      broker[key] = value;
    }
  };

  if (mqttHostEnv) setField('broker', mqttHostEnv);
  // Node-RED stores the port as a STRING. A number works at runtime but shows as empty in the
  // editor's port field, so the node looks misconfigured to whoever opens it next.
  if (mqttPortEnv) setField('port', String(mqttPortEnv));

  if (mqttTlsEnabled) {
    setField('usetls', true);
    // ---------------------------------------------------------------------------------------------
    // BOTH `verifyservercert` FIELDS ARE SET, AND THAT IS NOT BELT-AND-BRACES.
    //
    // 10-mqtt.js calls tlsNode.addTLSOptions(node.options), and 05-tls.js ends that method with an
    // UNCONDITIONAL `opts.rejectUnauthorized = this.verifyservercert`. So:
    //
    //   * omit it on the tls-config node   -> rejectUnauthorized becomes `undefined`
    //   * 10-mqtt.js then falls back to the BROKER node's verifyservercert
    //   * which defaults to `false` when absent (10-mqtt.js, "sensible options for the new fields")
    //
    // The result of leaving either one out is therefore TLS WITH NO VERIFICATION AT ALL: the
    // connection succeeds, the editor shows a connected broker, the traffic is encrypted, and any
    // certificate whatsoever is accepted. Nothing logs a warning. Setting both makes the outcome
    // independent of which of the two Node-RED happens to consult.
    // ---------------------------------------------------------------------------------------------
    setField('verifyservercert', true);
    setField('tls', TLS_NODE_ID);

    let tlsNode = flow.find((n) => n.id === TLS_NODE_ID);
    if (!tlsNode) {
      tlsNode = { id: TLS_NODE_ID, type: 'tls-config' };
      // Config nodes sit at the top level with no `z`, like mqtt-broker-config itself.
      flow.push(tlsNode);
      changes.push(`added tls-config node '${TLS_NODE_ID}'`);
    }
    Object.assign(tlsNode, {
      name: 'Factory+ internal CA',
      // certType 'files' means cert/key/ca are PATHS, read with fs.readFileSync at deploy time.
      // 'env' and 'pfx' are the other two modes; 'files' is the only one that suits a mounted
      // Secret, and it is stated explicitly because 05-tls.js defaults it and a future default
      // change would silently reinterpret `ca` below.
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

// 2. Reconcile settings.js -- EVERY BOOT.
//
// Stack configuration, not user content: this is the file a broken volume needs repaired. Only
// rewritten when it does not already declare every key correctly.
//
// The check LOADS the module rather than grepping it -- Node-RED's own 26KB default mentions
// `credentialSecret` in a commented-out example, so a substring test passes a file that declares
// nothing. It checks the AUTH keys and SETTINGS_VERSION too, which is what lets a volume from
// before authentication existed be repaired rather than left with an open admin API.
// (simulators/README.md -> "Flow provisioning")
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
    // Unloadable settings cannot be trusted to declare anything. Replaced (with a backup).
    //
    // If this fires on EVERY boot, the init container is missing the modules settings.js
    // requires -- i.e. node-red-init is not building from node-red/Dockerfile. See its header.
    console.warn(`[node-red-init] settings.js could not be loaded (${err.message}); replacing it.`);
    return false;
  }
}

// 2b. The generated settings.js.
//
// CONFIGURATION IS READ FROM process.env AT NODE-RED LOAD TIME, not baked in as literals. This
// file sits on a durable volume that every flow author can read, so the OAuth client secret,
// the Supabase JWT secret and the webhook signing key stay in the container environment. The
// one exception is credentialSecret, which node-red-init has to be able to COMPARE against
// above to decide whether the file needs rewriting -- and which is already recoverable from
// flows_cred.json's key derivation anyway.
//
// The require()s are ABSOLUTE. Node resolves modules from the requiring file's location, and
// this file lives at /data -- so a bare require('passport-oauth2') would search /data/
// node_modules and /node_modules, never the image's /usr/src/node-red/node_modules. Same idiom
// this script already uses for @node-red/runtime's credentials module.
const SETTINGS_JS = `/**
 * GENERATED by scripts/node-red-init.mjs -- do not edit.
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

const env = process.env;

/**
 * Supabase RBAC role -> Node-RED permissions.
 *
 * Node-RED only has '*' and 'read'. Operator and Auditor both map to 'read': neither should be
 * able to deploy a flow, and a flow \`function\` node executes arbitrary JavaScript inside this
 * container -- which holds the MQTT credential and can reach Mosquitto, Supabase and
 * TimescaleDB. The mapping itself lives server-side in the nodered-userinfo edge function; this
 * comment records what it does, and the code below trusts nothing that endpoint did not say.
 */

/**
 * Resolve identity and permissions for a Supabase access token.
 *
 * NOT read from the token's own claims. GoTrue's OIDC claims omit app_metadata entirely, and
 * app_metadata.role goes stale on revocation -- deleting a user's public.user_roles row IS how
 * a role is revoked, so a claim-based path would keep granting the old privilege for as long as
 * the token lived. The edge function reads public.user_roles, the same table RLS uses.
 */
async function userinfo(accessToken) {
  try {
    const res = await fetch(env.NODERED_USERINFO_URL, {
      headers: {
        Authorization: 'Bearer ' + accessToken,
        apikey: env.SUPABASE_ANON_KEY
      }
    });
    if (!res.ok) {
      // SAY WHY. Every refusal below ends as a bare redirect back to the login screen, so
      // without this line a failed sign-in is indistinguishable from a mis-click. 401 here
      // means the apikey or the bearer was rejected at the gateway; 404 means the function is
      // not registered in supabase/functions/main/index.ts.
      console.warn(
        '[acs-cymru] userinfo ' + env.NODERED_USERINFO_URL + ' -> HTTP ' + res.status +
        '; refusing the sign-in.'
      );
      return null;
    }
    return await res.json();
  } catch (err) {
    // A userinfo endpoint that cannot be reached is not evidence of a role. Fail closed.
    console.warn('[acs-cymru] userinfo lookup failed: ' + err.message);
    return null;
  }
}

// Short-lived cache so an admin API burst is not one HTTP round trip per request. Keyed by the
// token, so it expires with the token and cannot outlive a revocation by more than TTL_MS.
const roleCache = new Map();
const CACHE_TTL_MS = 30000;

/**
 * Username -> permissions, for adminAuth.users. See the comment on \`users\` below for why this
 * exists at all; the short version is that Node-RED re-resolves the user by USERNAME on every
 * editor request, long after the OAuth profile has gone.
 *
 * IT IS PERSISTED, and that is not an optimisation. Node-RED writes editor sessions to
 * /data/.sessions.json, so they outlive a restart -- but an in-memory map does not. The
 * mismatch is not a logout, which would at least be obvious: the session still authenticates,
 * \`users\` falls through to the bare-username branch, and getRuntimeSettings copies the
 * (missing) \`permissions\` to the editor, which renders a PADLOCK ON THE DEPLOY BUTTON. An
 * administrator silently becomes read-only in the UI after every \`docker compose restart\`,
 * until they happen to sign out and back in.
 *
 * The file holds usernames and Node-RED permission strings only -- no tokens, no secrets. It is
 * a cache of a decision already recorded in the session's scope, not a second source of truth:
 * a role change reaches the editor at the next sign-in, exactly as the enforced scope does.
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
    console.warn('[acs-cymru] could not read ' + EDITOR_USERS_FILE + ': ' + err.message);
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
    console.warn('[acs-cymru] could not persist ' + EDITOR_USERS_FILE + ': ' + err.message);
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

  adminAuth: {
    type: 'strategy',

    // Node-RED's default editor session is 7 days. The role behind that session is only
    // re-derived at login, so a revoked user would keep a working editor for a week. Eight hours
    // bounds that to about a shift without making people re-authenticate mid-task. The machine
    // path is unaffected -- it re-checks public.user_roles within 30s, every time.
    sessionExpiryTime: 28800,

    strategy: {
      name: 'oauth2',
      label: 'Sign in with ACS-Cymru',
      icon: 'fa-cube',
      strategy: OAuth2Strategy,
      options: {
        authorizationURL: env.NODERED_OAUTH_AUTH_URL,
        tokenURL: env.NODERED_OAUTH_TOKEN_URL,
        clientID: env.NODERED_OAUTH_CLIENT_ID,
        clientSecret: env.NODERED_OAUTH_CLIENT_SECRET,
        callbackURL: env.NODERED_OAUTH_CALLBACK_URL,

        // NOTE THE ABSENT 'openid' SCOPE. This is required, not an oversight. Requesting it
        // makes GoTrue try to mint an ID token and refuse:
        //   HS256 is not supported for ID token signing
        // The whole stack is HS256 on SUPABASE_JWT_SECRET, which Kong, PostgREST, Realtime and
        // the pre-minted anon/service_role keys all depend on. Identity comes from userinfo()
        // instead, so no ID token is needed. Same decision as grafana.ini:23-34 -- do not
        // "fix" a login problem by adding it back.
        scope: ['email', 'profile'],

        // GoTrue's OAuth server REQUIRES PKCE; without it /oauth/authorize fails with
        //   invalid_request: PKCE flow requires both code_challenge and code_challenge_method
        // pkce implies state, and state needs a session store -- which Node-RED's
        // genericStrategy installs (express-session + MemoryStore) before passport.initialize().
        pkce: true,
        state: true,

        // The client is registered token_endpoint_auth_method = 'client_secret_post' in
        // auth.oauth_clients (migration 0003), which is what passport-oauth2 does by default.
        // Grafana's client is 'client_secret_basic' instead only because its Go OAuth2 client
        // needs auth_style pinned; GoTrue enforces whichever is registered, exactly.

        /**
         * Node-RED calls this with the strategy's own verify arguments and replaces the final
         * callback, expecting (err, profile). The profile it gets is handed straight to
         * adminAuth.authenticate below.
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
                  '[acs-cymru] sign-in refused for ' + (info.email || info.sub) +
                  ': supabase_role=' + info.supabase_role + ' maps to no Node-RED permissions. ' +
                  'Add a public.user_roles row for this user.'
                );
              }
              return done(null, false);
            }
            console.log(
              '[acs-cymru] sign-in: ' + info.email + ' (' + info.supabase_role +
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
     * adminAuth.users receives only a USERNAME STRING; adminAuth.authenticate receives the whole
     * profile (@node-red/editor-api/lib/auth/users.js -- completeVerify calls
     * Users.authenticate(profile)). The role has to ride through here or it is lost between
     * verify() and the session Node-RED mints.
     *
     * It is variadic because the same hook backs the OAuth2 password grant on POST /auth/token,
     * which is called with (username, password). That path is refused outright: there are no
     * local passwords here, and silently accepting it would be a second, undocumented way in.
     */
    authenticate: async function (profile, password) {
      if (password !== undefined) return null;
      if (!profile || !profile.permissions) return null;
      rememberEditorUser(profile.username, profile.permissions);
      return { username: profile.username, permissions: profile.permissions };
    },

    /**
     * Resolve a user BY USERNAME. REQUIRED -- bearerStrategy calls Users.get() on every editor
     * request, and without this the editor logs in and then 401s everything with no error shown.
     *
     * It MUST return \`permissions\`, not just a username: the editor draws a padlock on Deploy
     * when that key is absent, silently making an administrator read-only. Hence the persisted
     * map above. The last-resort branch returns a bare username to keep an unknown session alive;
     * that is safe because enforcement reads the token's stored scope, not this object.
     *
     * (simulators/README.md -> "Node-RED authentication")
     */
    users: async function (username) {
      const permissions = editorUsers.get(username);
      return permissions ? { username: username, permissions: permissions } : { username: username };
    },

    /**
     * Machine-to-machine access to the admin API, read from Authorization: Bearer.
     *
     * deploy-nodered forwards the access token of the operator who triggered the deploy, having
     * already checked their role. This re-derives the role from public.user_roles rather than
     * trusting that check, so a revocation takes effect on both sides at once and a token
     * obtained any other way is judged identically.
     */
    tokenHeader: 'authorization',
    tokens: async function (token) {
      if (!token) return null;

      // Break-glass. Empty by default. If Supabase Auth, Kong or the edge runtime is down then
      // SSO is down with them, and Node-RED may be exactly what you need to reach. Same
      // reasoning as disable_login_form = false in grafana/grafana.ini.
      if (env.NODERED_ADMIN_TOKEN && token === env.NODERED_ADMIN_TOKEN) {
        return { username: 'acs-cymru-break-glass', permissions: '*' };
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

    // adminAuth.default IS DELIBERATELY ABSENT. Setting it grants an anonymous identity to every
    // unauthenticated request, which is precisely the state this file exists to end. Node-RED's
    // needsPermission() runs passport.authenticate(['bearer','tokens','anon']) -- with no
    // default, the 'anon' arm has nothing to return and the request is refused.
  },

  /**
   * Authentication for the http-in nodes, i.e. POST /hooks/quarantine.
   *
   * A FUNCTION, NOT {user, pass}. Node-RED accepts Express middleware here
   * (node-red/red.js:427), which is what allows a bearer check instead of HTTP Basic against a
   * bcrypt hash. pg_net sends Bearer, and a static password would be one more shared secret to
   * rotate by hand.
   *
   * THE TOKEN IS NOT THE ADMIN CREDENTIAL, and must never be made so.
   * public.dispatch_device_quarantine_webhook() mints a fresh 60-second JWT per event, scoped
   * aud=node-red-hooks. A flow author can read msg.req.headers, so anything sent here is
   * readable by every flow in this instance -- an admin token here would hand every flow the
   * admin API. What leaks instead is a capability to post a fake quarantine notice, for a
   * minute.
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
        issuer: 'acs-cymru-supabase'
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

// 3. Decide whether the broker credentials may be (re)written.
//
// "Only while there are none to lose." Credentials that exist and carry content were entered
// through the editor and are encrypted under whatever key Node-RED was using; rewriting them --
// or clearing the key that decrypts them, below -- would destroy them. An absent or empty file
// means there is nothing to protect, which is the state a volume is left in after Node-RED
// discards credentials it could not decrypt.
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
 * The broker username currently stored in flows_cred.json, or null if it cannot be read.
 *
 * Decrypted with the same scheme the round-trip check below uses. A file we cannot decrypt is not
 * ours to judge, so it reads as null and the keep-them-untouched path applies unchanged.
 */
function storedBrokerCredential() {
  if (!fs.existsSync(credentialsPath)) return null;
  try {
    const existing = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    if (typeof existing?.$ !== 'string' || existing.$.length === 0) return null;
    const key = crypto.createHash('sha256').update(credentialSecret).digest();
    const iv = Buffer.from(existing.$.substring(0, 32), 'hex');
    const decipher = crypto.createDecipheriv('aes-256-ctr', key, iv);
    const plain =
      decipher.update(existing.$.substring(32), 'base64', 'utf8') + decipher.final('utf8');
    return JSON.parse(plain)['mqtt-broker-config'] || null;
  } catch {
    return null;
  }
}

/**
 * A CHANGED BROKER IDENTITY FORCES A REWRITE of the otherwise seed-once credentials.
 *
 * The broker USERNAME is not user content: it is the simulator gateway's `sparkplug_id`, which
 * mosquitto.acl matches the topic's edge-node segment against. Leaving a stale one in place means
 * Node-RED authenticates as an account that no longer exists, and it reports only:
 *
 *     Connection failed to broker: <clientId>@mqtt://mosquitto:1883
 *
 * -- the CLIENT ID, not the username, and no CONNACK code. Identical to the line a wrong host
 * produces, which is why this is corrected here rather than left to a runbook.
 *
 * ONLY A DIFFERING USER TRIGGERS THIS. A password an operator changed in the editor is left alone:
 * that is a credential for the same account, whereas a different account is a different credential
 * and the environment is authoritative about which one this deployment uses.
 */
const storedBroker = storedBrokerCredential();
const brokerIdentityChanged = Boolean(storedBroker) && storedBroker.user !== mqttUser;

const writeCredentials = seededFlow || !credentialsWorthKeeping() || brokerIdentityChanged;

if (brokerIdentityChanged) {
  console.log(
    `[node-red-init] broker username changed ('${storedBroker.user}' -> '${mqttUser}'); ` +
      'rewriting flows_cred.json. The old account no longer exists, and Node-RED would report ' +
      'only "Connection failed to broker" if it kept using it.'
  );
}

// 3b. Drop any credential key Node-RED generated for itself on an earlier boot.
//
// A `_credentialSecret` Node-RED minted for itself WINS over ours on every later start: it fails
// to decrypt our flows_cred.json, silently discards the credentials, and rewrites the file empty.
// The broker node ends up with no username and Mosquitto refuses it with CONNACK 5.
//
// Guarded by writeCredentials, not by the seed path -- the question is "is there ciphertext only
// this key can open", not "is this volume fresh". (simulators/README.md -> "Flow provisioning")
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
await credentials.add('mqtt-broker-config', {
  user: mqttUser,
  password: mqttPassword
});

const exported = await credentials.export();

// 5. Assert we really produced ciphertext. This is the guard that the previous
//    implementation lacked -- it failed open and wrote readable passwords.
if (!Object.prototype.hasOwnProperty.call(exported, '$')) {
  fail(
    'credential export was not encrypted (missing "$" envelope). ' +
      'Node-RED internals may have changed; refusing to write plaintext secrets.'
  );
}

// 6. Prove Node-RED will be able to read it back before we commit it to disk.
try {
  const key = crypto.createHash('sha256').update(credentialSecret).digest();
  const blob = exported.$;
  const iv = Buffer.from(blob.substring(0, 32), 'hex');
  const decipher = crypto.createDecipheriv('aes-256-ctr', key, iv);
  const plain =
    decipher.update(blob.substring(32), 'base64', 'utf8') + decipher.final('utf8');
  const roundTripped = JSON.parse(plain)['mqtt-broker-config'];
  if (roundTripped?.user !== mqttUser || roundTripped?.password !== mqttPassword) {
    fail('credential round-trip mismatch; refusing to write.');
  }
} catch (err) {
  fail(`credential round-trip failed: ${err.message}`);
}

fs.writeFileSync(credentialsPath, JSON.stringify(exported));

console.log(
  `[node-red-init] broker credentials written encrypted (aes-256-ctr) to ${credentialsPath} ` +
    `for user '${mqttUser}'.`
);
