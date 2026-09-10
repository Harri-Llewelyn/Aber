#!/usr/bin/env node
/**
 * First-boot provisioning for an ACS-Cymru physical gateway appliance.
 *
 * WHAT IT DOES, ONCE:
 *   1. redeems the single-use enrolment token in .env against the platform's enroll-gateway
 *   2. writes the broker CA, so this appliance can VERIFY the broker rather than trust it
 *   3. writes /data/flows.json from flows.template.json, with this gateway's identity substituted
 *   4. writes /data/flows_cred.json, ENCRYPTED, through Node-RED's own credential runtime
 *   5. writes /data/settings.js with a locally generated admin password, printed once
 *   6. writes /data/gateway.env, which the node-red service sources at start
 *
 * ---------------------------------------------------------------------------------------------
 * THE TOKEN IS SINGLE-USE, AND EVERYTHING ABOUT THE CONTROL FLOW FOLLOWS FROM THAT.
 *
 * A second successful run is impossible: the platform consumed the token the first time. So this
 * script is not idempotent in the usual sense -- it is ONCE-ONLY, guarded by /data/.enrolled.json,
 * and a re-run against a provisioned volume exits 0 having done nothing. That is deliberate: the
 * alternative (attempt, fail, exit non-zero) would make `docker compose up` on an already-working
 * appliance report a failure.
 *
 * RETRYING IS THEREFORE NARROW AND EXPLICIT. Only a 503 carrying `retryable: true` is retried --
 * that is the platform saying, in as many words, that it RELEASED the claim and the same token is
 * still good. Every other failure is terminal, because retrying a spent token cannot succeed and
 * would only bury the real error under a wall of 401s.
 *
 * Usage:
 *   node /bundle/bootstrap.mjs                          # first boot; no-op once enrolled
 *   node /bundle/bootstrap.mjs --reset-admin-password    # new editor password, keeps enrolment
 *   node /bundle/bootstrap.mjs --force                   # re-enrol with a NEW token in .env
 */
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import {
  chownSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import process from 'node:process';

// An ESM module gets no implicit require(). One is needed because bcryptjs is CommonJS and has to
// be loaded by ABSOLUTE PATH: this file runs from /bundle, so a bare specifier would resolve
// against /bundle/node_modules and /node_modules, never the image's own module directory.
const require = createRequire(import.meta.url);

const DATA_DIR = process.env.NODE_RED_DATA_DIR || '/data';
const BUNDLE_DIR = process.env.BUNDLE_DIR || '/bundle';
/** Where the base image keeps its modules. bootstrap runs from /bundle, so requires are absolute. */
const RUNTIME_DIR = process.env.NODE_RED_RUNTIME_DIR || '/usr/src/node-red/node_modules';

const MARKER = join(DATA_DIR, '.enrolled.json');
const FLOWS = join(DATA_DIR, 'flows.json');
const CREDS = join(DATA_DIR, 'flows_cred.json');
const SETTINGS = join(DATA_DIR, 'settings.js');
const GATEWAY_ENV = join(DATA_DIR, 'gateway.env');
const CA_PATH = join(DATA_DIR, 'certs', 'ca.crt');
// The GitOps identity: this appliance's own SSH keypair, and where the platform told it to pull
// from. See generateDeployKey() for why the private half is generated here rather than issued.
const GITOPS_DIR = join(DATA_DIR, 'gitops');
const DEPLOY_KEY = join(GITOPS_DIR, 'id_ed25519');
const REPOSITORY = join(GITOPS_DIR, 'repository.json');
// The forge's own public key, so `git` can VERIFY it rather than trust whatever answers on the
// first connection. Written from the enrolment response, which arrives over TLS on a single-use
// token -- see step 5b.
const KNOWN_HOSTS = join(GITOPS_DIR, 'known_hosts');
// What flow-sync.mjs authenticates to the LOCAL Node-RED admin API with. See syncCredential().
const SYNC_CREDENTIAL = join(GITOPS_DIR, 'nodered.json');

const args = process.argv.slice(2);
const resetPasswordOnly = args.includes('--reset-admin-password');
const force = args.includes('--force');

const log = (...m) => console.log('[bootstrap]', ...m);
const die = (message, hint) => {
  console.error(`\n[bootstrap] FAILED: ${message}\n`);
  if (hint) console.error(`${hint}\n`);
  process.exit(1);
};

// -------------------------------------------------------------------------------------------------
// Configuration, from .env via compose's env_file
// -------------------------------------------------------------------------------------------------
const SUPABASE_URL = (process.env.ACS_SUPABASE_URL || '').replace(/\/+$/, '');
// THE GATEWAY CREDENTIAL, in whichever format the bundle carries.
//
// The platform's gateway accepts the legacy anon JWT and the new `sb_publishable_*` key at the
// same time, so an appliance does not care which it was given -- it presents the string and the
// gateway matches it. This appliance sends it as `apikey` AND as the bearer, which is safe for an
// opaque key because the gateway synthesises the JWT its upstreams need.
//
// THE FALLBACK IS FOR BUNDLES, NOT FOR INSTALLS. A bundle downloaded before the platform minted
// a publishable key carries only ACS_SUPABASE_ANON_KEY, and an appliance commissioned from one of
// those must still boot -- the token in it is single-use and a failed first boot spends it.
const ANON_KEY =
  process.env.ACS_SUPABASE_PUBLISHABLE_KEY || process.env.ACS_SUPABASE_ANON_KEY || '';
const TOKEN = (process.env.ACS_ENROLLMENT_TOKEN || '').trim();
const GATEWAY_NAME = process.env.ACS_GATEWAY_NAME || 'gateway';
const AGENT_VERSION = process.env.ACS_AGENT_VERSION || 'unknown';
const CREDENTIAL_SECRET = process.env.NODERED_CREDENTIAL_SECRET || '';

/**
 * The retry budget for a RELEASED claim.
 *
 * Six attempts over roughly two minutes. Long enough to ride out a broker restart or a rolling
 * update of the platform, short enough that an appliance whose platform is genuinely down reports
 * so while somebody is still standing next to it. There is no unbounded retry: a bootstrap that
 * never exits is indistinguishable from one that is stuck.
 */
const MAX_ATTEMPTS = 6;
const BACKOFF_MS = [2000, 5000, 10000, 20000, 30000];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// -------------------------------------------------------------------------------------------------
// The admin password
// -------------------------------------------------------------------------------------------------
/**
 * A generated password and its bcrypt hash.
 *
 * GENERATED, NEVER TAKEN FROM .env. A password in the bundle would be identical on every appliance
 * built from it, would sit in a file that travels by USB stick, and would survive in the download
 * folder of whoever provisioned the fleet. This one exists in exactly two places: this process's
 * stdout, once, and a bcrypt hash in settings.js.
 *
 * base64url, so it survives being copied through a terminal, a ticket and a password manager
 * without an escaping accident.
 */
function generateAdminPassword() {
  const bcrypt = require(`${RUNTIME_DIR}/bcryptjs`);
  const password = randomBytes(18).toString('base64url');
  // Cost 10: Node-RED's own default for adminAuth hashes. Higher costs a noticeable pause on the
  // low-power hardware these appliances usually run on, for a credential that is already 144 bits
  // of entropy and never transmitted.
  return { password, hash: bcrypt.hashSync(password, 10) };
}

// -------------------------------------------------------------------------------------------------
// settings.js
// -------------------------------------------------------------------------------------------------
/**
 * LOCAL adminAuth, deliberately -- see the Dockerfile header for why this appliance does not
 * federate to Supabase Auth.
 *
 * `type: 'credentials'` with one user. The hash is bcrypt; Node-RED compares it itself. There is no
 * `default` user, which is what keeps the editor and the /flows admin API closed to an
 * unauthenticated caller -- the failure mode this whole block exists to avoid is an appliance on a
 * plant network with an open flow editor.
 */
/**
 * The flow-sync agent's own Node-RED login, generated and STORED -- unlike the admin password.
 *
 * WHY IT IS A SECOND ACCOUNT AND NOT THE ADMIN ONE. The admin password is printed once and written
 * nowhere, which is a property worth keeping: it is the credential a person uses, and a copy of it
 * on disk would outlive the person who read it. A machine that must authenticate unattended on
 * every timer tick cannot work that way, so it gets an identity of its own -- separately
 * revocable, obviously non-human in the audit log, and re-issued by rewriting settings.js.
 *
 * IT GRANTS NOTHING THE MOUNT DOES NOT ALREADY GRANT. flow-sync writes /data/flows.json directly
 * over the shared volume; a Node-RED admin token is strictly less authority than that. The token
 * exists because RELOADING is an API call -- Node-RED does not watch the flow file -- and not
 * because the agent needs permission to change anything.
 *
 * `permissions: '*'` because Node-RED's model has no narrower grant that includes POST /flows.
 * Stated rather than quietly accepted: if a future release adds a `flows.write` scope, this should
 * take it.
 */
function generateSyncCredential() {
  const bcrypt = require(`${RUNTIME_DIR}/bcryptjs`);
  const password = randomBytes(18).toString('base64url');
  return { password, hash: bcrypt.hashSync(password, 10) };
}

/**
 * Write the sync agent's password where flow-sync.mjs will read it, 0600.
 *
 * SEPARATE FROM settings.js ON PURPOSE. settings.js holds the bcrypt HASH, which is what Node-RED
 * verifies against; this file holds the plaintext the agent presents. Keeping them apart means the
 * file an operator is most likely to open, copy or paste into a ticket is the one with no secret
 * in it.
 */
function writeSyncCredential(username, password) {
  mkdirSync(GITOPS_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(
    SYNC_CREDENTIAL,
    JSON.stringify({ username, password, written_at: new Date().toISOString() }, null, 2),
    { mode: 0o600 },
  );
}

/** The username flow-sync.mjs authenticates as. Not `admin`, so the two are told apart in the log. */
const SYNC_USER = 'acs-flow-sync';

function settingsJs(adminHash, credentialSecret, syncHash) {
  return `/**
 * GENERATED by bootstrap.mjs -- do not edit by hand.
 *
 * Re-running bootstrap with --reset-admin-password rewrites this file with a new password and
 * prints it once. Everything else here is fixed by the appliance's enrolment.
 */
module.exports = {
    flowFile: 'flows.json',
    // Encrypts flows_cred.json. It comes from this appliance's .env; LOSING IT means the stored
    // broker password cannot be decrypted and the appliance must be re-enrolled with a new bundle.
    credentialSecret: ${JSON.stringify(credentialSecret)},
    uiPort: process.env.PORT || 1880,
    // LOCAL CREDENTIALS, NOT SSO. A shopfloor appliance usually has no stable address, and OAuth2
    // requires the authorisation server to hold an exact redirect_uri per client -- so SSO here
    // would break every time DHCP moved the appliance, reporting 'invalid redirect_uri' at the
    // consent step rather than anything that names an address.
    adminAuth: {
        type: 'credentials',
        users: [{
            username: 'admin',
            password: ${JSON.stringify(adminHash)},
            permissions: '*'
        }, {
            // THE FLOW-SYNC AGENT, not a person. It exists because reloading the flow file is an
            // API call -- Node-RED does not watch flows.json -- and the agent already writes that
            // file over the shared volume, so this token is less authority than it holds anyway.
            // Its password is in /data/gitops/nodered.json, 0600, and is re-issued by rerunning
            // bootstrap with --reset-admin-password.
            username: ${JSON.stringify(SYNC_USER)},
            password: ${JSON.stringify(syncHash)},
            permissions: '*'
        }]
    },
    // The editor is the only HTTP surface. No httpNodeAuth default: the sample flow exposes no
    // HTTP endpoints, and adding one should be a deliberate act with its own auth decision.
    functionGlobalContext: {},
    logging: { console: { level: 'info', metrics: false, audit: false } },
    editorTheme: {
        page: { title: 'ACS-Cymru Gateway' },
        header: { title: ${JSON.stringify(`ACS-Cymru — ${GATEWAY_NAME}`)} }
    }
};
`;
}

// -------------------------------------------------------------------------------------------------
// Enrolment
// -------------------------------------------------------------------------------------------------
async function enrol() {
  const url = `${SUPABASE_URL}/functions/v1/enroll-gateway`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response;
    let payload;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          // THE ANON KEY, and no user JWT. Kong gates /functions/v1/ with key-auth, so a key is
          // required to get past the gateway -- but this appliance has no session and never will.
          // The enrolment TOKEN is what authorises the call.
          apikey: ANON_KEY,
          Authorization: `Bearer ${ANON_KEY}`,
          'Content-Type': 'application/json',
        },
        // ssh_public_key is the PUBLIC half only, and it may be null on an appliance whose
      // ssh-keygen failed. The platform treats a missing key as "no repository for this
      // gateway" rather than as an error, so enrolment is unaffected either way.
      body: JSON.stringify({
        token: TOKEN,
        agent_version: AGENT_VERSION,
        ssh_public_key: deployPublicKey,
      }),
      });
      payload = await response.json().catch(() => ({}));
    } catch (err) {
      // The platform is unreachable. NOT a spent token, so retrying is correct -- an appliance is
      // routinely powered on before the network it is meant to reach.
      if (attempt < MAX_ATTEMPTS) {
        const wait = BACKOFF_MS[attempt - 1] ?? 30000;
        log(`cannot reach ${SUPABASE_URL} (${err.message}); retrying in ${wait / 1000}s ` +
            `(attempt ${attempt}/${MAX_ATTEMPTS})`);
        await sleep(wait);
        continue;
      }
      die(
        `the platform at ${SUPABASE_URL} is unreachable after ${MAX_ATTEMPTS} attempts.`,
        'Check this appliance\'s network route to the platform. The enrolment token has NOT been\n'
        + 'consumed -- once connectivity is restored, `docker compose up` again with this bundle.'
      );
    }

    if (response.ok) return payload;

    // ---------------------------------------------------------------------------------------
    // THE ONLY RETRYABLE FAILURE. `retryable: true` is the platform stating that it released the
    // claim, so this exact token is still live. Anything else -- above all a 401 -- means the
    // token is spent or invalid, and retrying can only produce the same answer more slowly.
    // ---------------------------------------------------------------------------------------
    if (response.status === 503 && payload?.retryable === true && attempt < MAX_ATTEMPTS) {
      const wait = BACKOFF_MS[attempt - 1] ?? 30000;
      log(`the platform released the claim and asked us to retry: ${payload.error}. ` +
          `Waiting ${wait / 1000}s (attempt ${attempt}/${MAX_ATTEMPTS}).`);
      await sleep(wait);
      continue;
    }

    if (response.status === 401) {
      die(
        'the enrolment token was refused.',
        'Enrolment tokens are SINGLE-USE and expire (30 minutes by default). This one is\n'
        + 'unknown, expired, or has already been redeemed -- possibly by an earlier run of this\n'
        + 'same bundle. Generate a new bundle from the gateway\'s page in the dashboard.'
      );
    }

    die(
      `the platform answered ${response.status}: ${payload?.error || 'unknown error'}`,
      payload?.details || ''
    );
  }

  die(`enrolment did not succeed after ${MAX_ATTEMPTS} attempts.`);
  return null;
}

// -------------------------------------------------------------------------------------------------
// Credentials, encrypted through Node-RED's own runtime
// -------------------------------------------------------------------------------------------------
/**
 * Write flows_cred.json the way Node-RED will read it.
 *
 * NOT hand-rolled AES. The file format is Node-RED's, and the one implementation guaranteed to
 * match what its runtime will decrypt is the runtime's own module. This is the same approach the
 * platform's scripts/node-red-init.mjs takes, for the same reason.
 *
 * IT ASSERTS CIPHERTEXT BEFORE WRITING. An export without the `$` envelope means encryption did not
 * happen -- and the failure of writing that file anyway is a broker password sitting in plaintext
 * on the appliance's disk, which nothing downstream would notice.
 */
async function writeEncryptedCredentials(brokerNodeId, username, password) {
  const credentials = (
    await import(`${RUNTIME_DIR}/@node-red/runtime/lib/nodes/credentials.js`)
  ).default;

  const noop = () => {};
  credentials.init({
    log: { debug: noop, warn: noop, trace: noop, info: noop, _: (s) => s },
    settings: {},
  });

  credentials.setKey(CREDENTIAL_SECRET);
  await credentials.add(brokerNodeId, { user: username, password });
  const exported = await credentials.export();

  if (!Object.prototype.hasOwnProperty.call(exported, '$')) {
    die(
      'the credential export was not encrypted.',
      'Refusing to write the broker password to disk in plaintext. Node-RED internals may have\n'
      + 'changed; do not work around this by writing the file yourself.'
    );
  }

  writeFileSync(CREDS, JSON.stringify(exported), { mode: 0o600 });
}

// -------------------------------------------------------------------------------------------------
// main
// -------------------------------------------------------------------------------------------------
mkdirSync(DATA_DIR, { recursive: true });

// --reset-admin-password: a new editor password, nothing else touched. The appliance keeps its
// enrolment, its flow and its broker credential -- this is a lost-password path, not a re-install.
if (resetPasswordOnly) {
  if (!existsSync(MARKER)) {
    die('this appliance has not been enrolled yet; run bootstrap without --reset-admin-password.');
  }
  if (!CREDENTIAL_SECRET) {
    die(
      'NODERED_CREDENTIAL_SECRET is not set.',
      'settings.js is rewritten whole, so it has to carry the same credentialSecret the existing\n'
      + 'flows_cred.json was encrypted with. It is in this bundle\'s .env -- restore that value\n'
      + 'before resetting the password, or the appliance will lose its broker credential.'
    );
  }
  const { password, hash } = generateAdminPassword();
  // THE SYNC CREDENTIAL IS RE-ISSUED HERE TOO, and this is deliberately the path that repairs an
  // appliance enrolled before flow-sync existed: settings.js is rewritten whole, so the agent's
  // account has to be written back into it or the reset would REMOVE it. It also means an operator
  // who has lost only the editor password gets a working sync agent as a side effect rather than
  // needing a second, differently named recovery command.
  const sync = generateSyncCredential();
  writeFileSync(SETTINGS, settingsJs(hash, CREDENTIAL_SECRET, sync.hash));
  writeSyncCredential(SYNC_USER, sync.password);
  console.log(`\n${'='.repeat(78)}\n  NEW NODE-RED EDITOR PASSWORD\n\n    username: admin\n    password: ${password}\n\n  Shown once. Restart the appliance for it to take effect:  docker compose restart node-red\n${'='.repeat(78)}\n`);
  process.exit(0);
}

if (existsSync(MARKER) && !force) {
  const enrolled = JSON.parse(readFileSync(MARKER, 'utf8'));
  log(`already enrolled as ${enrolled.sparkplug_id} on ${enrolled.enrolled_at}; nothing to do.`);
  log('The enrolment token in .env was consumed at that point and cannot be reused.');
  process.exit(0);
}

const missing = [
  !SUPABASE_URL && 'ACS_SUPABASE_URL',
  !ANON_KEY && 'ACS_SUPABASE_PUBLISHABLE_KEY or ACS_SUPABASE_ANON_KEY',
  !TOKEN && 'ACS_ENROLLMENT_TOKEN',
  !CREDENTIAL_SECRET && 'NODERED_CREDENTIAL_SECRET',
].filter(Boolean);

if (missing.length) {
  die(
    `.env is missing ${missing.join(', ')}.`,
    'These are written into .env by the dashboard when the bundle is generated. If you edited it,\n'
    + 'compare against the values in the downloaded copy.'
  );
}

if (!/^[0-9a-f]{64}$/.test(TOKEN)) {
  die(
    'ACS_ENROLLMENT_TOKEN is not a valid token.',
    'It should be 64 hexadecimal characters, exactly as generated. A truncated value here is\n'
    + 'usually a copy-paste that lost the end of the line.'
  );
}

/**
 * This appliance's deploy key, generated HERE and never anywhere else.
 *
 * THE PRIVATE HALF NEVER LEAVES THE PLANT. Only the public half goes up with the enrolment
 * request, where the platform registers it against this gateway's repository as READ-ONLY. That is
 * the same decision as the editor password below -- generated on the appliance, so there is no
 * fleet-wide store of credentials to compromise, and revoking one gateway is deleting one key from
 * one repository.
 *
 * ed25519 rather than RSA: small, fast to generate on the low-power hardware these appliances run
 * on, and accepted by every forge worth pointing this at.
 *
 * REUSED IF IT EXISTS. A --force re-enrolment against a volume that kept its key sends the same
 * public half up again, which the platform records as already registered. Regenerating would
 * orphan the key the repository already trusts.
 *
 * NOT FATAL IF IT FAILS. An appliance with no key enrols, gets its broker credential and publishes
 * telemetry exactly as before; what it cannot do is converge to a reviewed flow. Refusing to boot
 * over it would trade the gateway's whole purpose for a feature it has never had.
 */
function generateDeployKey() {
  try {
    mkdirSync(GITOPS_DIR, { recursive: true, mode: 0o700 });
    if (!existsSync(DEPLOY_KEY)) {
      execFileSync('ssh-keygen', [
        '-t', 'ed25519',
        '-N', '',
        '-C', `acs-cymru gateway ${GATEWAY_NAME}`,
        '-f', DEPLOY_KEY,
      ], { stdio: 'pipe' });
      log(`generated a deploy key at ${DEPLOY_KEY}`);
    } else {
      log(`reusing the deploy key already at ${DEPLOY_KEY}`);
    }
    return readFileSync(`${DEPLOY_KEY}.pub`, 'utf8').trim();
  } catch (err) {
    log(`WARNING: could not generate a deploy key (${err.message}).`);
    log('This appliance will enrol and publish telemetry, but it will have no repository to pull '
      + 'its flow from.');
    return null;
  }
}

const deployPublicKey = generateDeployKey();

log(`enrolling '${GATEWAY_NAME}' with ${SUPABASE_URL} ...`);
const enrolment = await enrol();

log(`enrolled as ${enrolment.sparkplug_id} (group ${enrolment.sparkplug_group})`);
log(`broker: ${enrolment.mqtt_host}:${enrolment.mqtt_tls_port} over MQTTS`);

// 1. The CA. Written before anything else that depends on it, so a failure here is unambiguous.
mkdirSync(join(DATA_DIR, 'certs'), { recursive: true });
writeFileSync(CA_PATH, enrolment.ca_cert, { mode: 0o644 });
log(`wrote the broker CA to ${CA_PATH} (${createHash('sha256').update(enrolment.ca_cert).digest('hex').slice(0, 16)}…)`);

// 2. The flow. PLACEHOLDER SUBSTITUTION, not environment variables inside the flow: a flow whose
//    broker address is an unresolved ${VAR} still deploys, and fails at connect time with a message
//    that names neither the variable nor the flow. Substituting here means the file on disk is the
//    file that runs, and can be read to see exactly what this appliance will do.
const BROKER_NODE_ID = 'acs-broker';
const template = readFileSync(join(BUNDLE_DIR, 'flows.template.json'), 'utf8');
const flow = template
  .replaceAll('__MQTT_HOST__', enrolment.mqtt_host)
  .replaceAll('__MQTT_TLS_PORT__', String(enrolment.mqtt_tls_port))
  .replaceAll('__SPARKPLUG_ID__', enrolment.sparkplug_id)
  .replaceAll('__SPARKPLUG_GROUP__', enrolment.sparkplug_group)
  .replaceAll('__GATEWAY_NAME__', GATEWAY_NAME)
  // ---------------------------------------------------------------------------------------------
  // THE CA PATH, AND WITHOUT IT THIS APPLIANCE ENROLS PERFECTLY AND NEVER CONNECTS.
  //
  // The tls-config node's `ca` is a PATH (certType: 'files'), read with fs.readFileSync at deploy
  // time. Left empty -- which it was -- Node-RED verifies the broker against the SYSTEM TRUST
  // STORE, which knows nothing about an internal CA. The broker node then reports only
  //
  //     Connection failed to broker: <clientid>@<url>
  //
  // the same line a wrong password produces, with certificates never mentioned. The CA was being
  // written to disk correctly the whole time and simply nothing pointed at it.
  //
  // The platform's own provisioner refuses to start rather than reach this state -- see the
  // MQTT_TLS_CA_FILE guard in scripts/node-red-init.mjs, which documents the identical failure.
  // ---------------------------------------------------------------------------------------------
  .replaceAll('__CA_FILE__', CA_PATH);

if (flow.includes('__')) {
  const leftover = [...new Set(flow.match(/__[A-Z0-9_]+__/g) || [])];
  if (leftover.length) {
    die(
      `flows.template.json still contains unsubstituted placeholders: ${leftover.join(', ')}`,
      'A placeholder reaching Node-RED renders as a literal hostname or topic segment, which\n'
      + 'fails as a connection error rather than as a missing value.'
    );
  }
}

JSON.parse(flow); // Refuse to write a flow Node-RED cannot parse; it would start with no flows.
writeFileSync(FLOWS, flow);
log(`wrote ${FLOWS}`);

// ---------------------------------------------------------------------------------------------
// THE THREE FACTS THE HEARTBEAT REPORTS THAT NODE-RED CANNOT WORK OUT FOR ITSELF.
//
// A function node runs in a sandbox with no `require`, no `fs` and no `process` -- settings.js
// declares `functionGlobalContext: {}` deliberately, and the flow's own comment records what
// happens when something reaches past that (a ReferenceError thrown before the first publish,
// leaving the appliance in AWAITING_BIRTH with the only evidence in its own logs). So these are
// resolved HERE, where the files actually are, and handed to the flow as environment variables
// that `env.get()` reads.
//
// ALL THREE ARE FIXED FOR THE LIFE OF AN ENROLMENT, which is what makes this the right place
// rather than a periodic job: the CA, the flow and the bundle all change only by re-running this
// script, and re-running it rewrites every one of these values.
//
// The caveat, stated because it is the one way these go stale: an operator who replaces
// /data/certs/ca.crt or edits the flow in the Node-RED editor WITHOUT re-enrolling will keep
// reporting the values recorded here. Re-enrolment is the supported path for both.
// ---------------------------------------------------------------------------------------------

// The flow AS DELIVERED. Identifies which bundle's flow was installed -- not whether it has since
// been edited in the editor, which would need the admin API and a credential to ask.
const FLOW_HASH = createHash('sha256').update(flow).digest('hex');

/**
 * `ACS_AGENT_VERSION` COMES FROM THE OPERATOR'S .env AND IS ABOUT TO ENTER A SHELL FILE.
 *
 * gateway.env is written as `export NAME='value'` and SOURCED by the node-red service's command.
 * A single quote in this value therefore closes the string and the rest becomes shell -- which at
 * best stops the appliance starting with a syntax error naming a file the operator has never
 * heard of, and at worst runs. Nothing else written below has this exposure: the hash is hex, the
 * expiry is digits, and the remaining values come from the platform's own enrolment response.
 *
 * Restricted rather than escaped, and capped at 64 to match what the daemon accepts for the
 * column: a version string is a label, and anything outside this set is not one.
 */
const SAFE_AGENT_VERSION = AGENT_VERSION.replace(/[^A-Za-z0-9._+-]/g, '').slice(0, 64) || 'unknown';
if (SAFE_AGENT_VERSION !== AGENT_VERSION) {
  log(`ACS_AGENT_VERSION contained characters that cannot go in gateway.env; reporting `
    + `'${SAFE_AGENT_VERSION}'`);
}

/**
 * The CA's notAfter, in epoch milliseconds.
 *
 * WHY THIS ONE MATTERS MOST. The CA is distributed by hand into every appliance's trust store, so
 * re-minting it does not fail loudly -- it succeeds, and the whole fleet drops off at once with no
 * signal but absence. Reporting the date this appliance actually holds is what turns that into a
 * warning with a month's notice.
 *
 * A CA THAT CANNOT BE PARSED IS NOT FATAL. The appliance still enrols, still connects and still
 * reports every other health metric; it simply does not claim an expiry date. Refusing to boot
 * over an unreadable date would trade a monitoring gap for an outage.
 */
let caExpiresMs = '';
try {
  caExpiresMs = String(Date.parse(new X509Certificate(enrolment.ca_cert).validTo));
  if (!Number.isFinite(Number(caExpiresMs))) caExpiresMs = '';
} catch {
  caExpiresMs = '';
}
if (caExpiresMs) {
  log(`broker CA expires ${new Date(Number(caExpiresMs)).toISOString()}`);
} else {
  log('WARNING: could not read the broker CA expiry; Cert_Expires_At will not be reported.');
}

// 3. The broker credential, encrypted.
await writeEncryptedCredentials(BROKER_NODE_ID, enrolment.mqtt_username, enrolment.mqtt_password);
log(`wrote ${CREDS} (encrypted)`);

// 4. settings.js, with a freshly generated editor password and the sync agent's own account.
const { password: adminPassword, hash: adminHash } = generateAdminPassword();
const syncCredential = generateSyncCredential();
writeFileSync(SETTINGS, settingsJs(adminHash, CREDENTIAL_SECRET, syncCredential.hash));
writeSyncCredential(SYNC_USER, syncCredential.password);
log(`wrote ${SETTINGS}`);

// 5. The environment the node-red service sources at start. NO PASSWORD HERE -- the broker
//    credential lives only in the encrypted flows_cred.json. These are addresses and identity.
writeFileSync(
  GATEWAY_ENV,
  [
    `export GATEWAY_MQTT_HOST='${enrolment.mqtt_host}'`,
    `export GATEWAY_MQTT_TLS_PORT='${enrolment.mqtt_tls_port}'`,
    `export GATEWAY_SPARKPLUG_ID='${enrolment.sparkplug_id}'`,
    `export GATEWAY_SPARKPLUG_GROUP='${enrolment.sparkplug_group}'`,
    // Read by the flow's `build node-level message` function through env.get(), and reported on
    // the heartbeat. See the block above for why they are resolved here rather than in the flow.
    `export GATEWAY_AGENT_VERSION='${SAFE_AGENT_VERSION}'`,
    `export GATEWAY_FLOW_HASH='${FLOW_HASH}'`,
    `export GATEWAY_CA_EXPIRES_MS='${caExpiresMs}'`,
    `export NODERED_CREDENTIAL_SECRET='${CREDENTIAL_SECRET}'`,
    '',
  ].join('\n'),
  { mode: 0o600 },
);

// 5b. WHERE THIS APPLIANCE PULLS FROM, if the platform gave it a repository.
//
//     RECORDED RATHER THAN DERIVED. The clone URL is the forge's own answer -- built from its
//     ROOT_URL and SSH_DOMAIN -- so the appliance never has to reconstruct an address from parts it
//     would have to be told separately. A null repository is a deployment with no forge, a bundle
//     that sent no key, or a forge that was unreachable at enrolment; all three look the same here
//     and none of them stops the gateway working.
//
//     THE HOST KEY ARRIVES WITH IT, AND THAT IS WHAT MAKES THE PULL VERIFIABLE. An appliance with
//     no known_hosts entry could only trust whatever key answers on its first connection -- trust
//     on first use, decided at the one moment an attacker would choose -- or be told to skip
//     verification, which roadmap 7 and 11 both refuse. THIS response is the alternative: it comes
//     over TLS, authenticated by a single-use token bound to one gateway row, so the forge's
//     identity is learned from the platform BEFORE the first clone. flow-sync.mjs points
//     GIT_SSH_COMMAND at the file written here and never at a skip-verification switch.
//
//     A NULL host key is a forge that has not published one yet, and it is not an error. The
//     appliance keeps its broker credential and publishes telemetry; flow-sync declines to
//     converge and says why, which is the correct refusal rather than a degraded mode.
if (enrolment.repository && enrolment.repository.ssh_url) {
  const knownHosts = enrolment.repository.known_hosts || null;
  if (knownHosts) {
    // 0644, not 0600: the sync agent runs as uid 1000 and this is a PUBLIC key. The private half
    // beside it keeps its 0600, which is the file that matters.
    writeFileSync(KNOWN_HOSTS, `${knownHosts}\n`, { mode: 0o644 });
    log(`wrote ${KNOWN_HOSTS} for the forge`);
  }

  writeFileSync(
    REPOSITORY,
    JSON.stringify(
      {
        ssh_url: enrolment.repository.ssh_url,
        branch: enrolment.repository.branch || 'main',
        deploy_key: DEPLOY_KEY,
        known_hosts: knownHosts ? KNOWN_HOSTS : null,
        recorded_at: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  log(`this gateway pulls from ${enrolment.repository.ssh_url}`);
  if (!knownHosts) {
    log('WARNING: the platform sent no SSH host key for the forge, so this appliance cannot verify');
    log('it and will NOT converge. Restart the forge to publish one, then re-run enrolment.');
  }
} else {
  log('the platform gave this gateway no repository; it will publish telemetry but not converge.');
}

// 6. The marker. LAST, so a crash part-way through leaves the appliance un-enrolled rather than
//    marked enrolled with half a configuration -- though the token is spent either way, which is
//    why every step above either succeeds or exits non-zero.
writeFileSync(
  MARKER,
  JSON.stringify(
    {
      sparkplug_id: enrolment.sparkplug_id,
      sparkplug_group: enrolment.sparkplug_group,
      gateway_name: enrolment.gateway_name,
      mqtt_host: enrolment.mqtt_host,
      enrolled_at: new Date().toISOString(),
      agent_version: AGENT_VERSION,
    },
    null,
    2,
  ),
);

// -------------------------------------------------------------------------------------------------
// HAND /data BACK TO uid 1000, WHICH IS WHAT NODE-RED RUNS AS.
//
// This script runs as ROOT, and it has to: the node-red image ships /data/flows.json owned by
// root:root, Docker copies it into a fresh named volume with that ownership, and a non-root
// bootstrap therefore cannot overwrite it -- EACCES, after enrolment has already spent the token.
// See the `user: "0"` block in docker-compose.yml.
//
// The consequence is that everything written above is root-owned, and Node-RED (uid 1000) would then
// fail to write flows.json when someone deploys from the editor -- the same failure moved one step
// later, where it looks like a Node-RED bug rather than a provisioning one. So the ownership is
// corrected here, before this container exits.
//
// Recursive and best-effort: a chown that fails on a stray file should not undo a successful
// enrolment, but it must be reported, because it is the reason a later editor deploy would fail.
// -------------------------------------------------------------------------------------------------
function handBackOwnership(dir) {
  let changed = 0;
  const walk = (target) => {
    chownSync(target, 1000, 1000);
    changed += 1;
    if (statSync(target).isDirectory()) {
      for (const entry of readdirSync(target)) walk(join(target, entry));
    }
  };
  try {
    walk(dir);
    log(`handed ${changed} path(s) under ${dir} to uid 1000 (the uid Node-RED runs as)`);
  } catch (err) {
    console.error(
      `[bootstrap] WARNING: could not chown ${dir} to uid 1000 (${err.message}). Enrolment `
      + 'succeeded, but Node-RED may be unable to save flows from the editor until this is fixed.'
    );
  }
}

if (typeof process.getuid === 'function' && process.getuid() === 0) {
  handBackOwnership(DATA_DIR);
}

const banner = '='.repeat(78);
console.log(`
${banner}
  ENROLLED — ${enrolment.gateway_name}

    Sparkplug id     ${enrolment.sparkplug_id}
    Broker           ${enrolment.mqtt_host}:${enrolment.mqtt_tls_port} (MQTTS, CA-verified)
    Editor           http://<this-appliance>:1880

  NODE-RED EDITOR LOGIN — shown ONCE, not stored anywhere in plaintext

    username: admin
    password: ${adminPassword}

  Lost it?  docker compose run --rm bootstrap node /bundle/bootstrap.mjs --reset-admin-password
${banner}
`);

if (enrolment.applied_to_running_broker === false) {
  log(
    'NOTE: the platform reports the credential is not yet live at the broker (its configuration '
    + 'is still syncing, up to ~90s). The first connection attempts may be refused; Node-RED '
    + 'retries on its own and no action is needed.'
  );
}
