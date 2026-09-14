#!/usr/bin/env node
/**
 * First-boot provisioning for an ACS-Cymru physical gateway appliance. Once: redeems the single-use
 * enrolment token in .env against enroll-gateway, writes the broker CA, writes /data/flows.json
 * from flows.template.json with this gateway's identity substituted, writes /data/flows_cred.json
 * encrypted through Node-RED's own credential runtime, writes /data/settings.js with a generated
 * admin password printed once, and writes /data/gateway.env for the node-red service to source.
 *
 * The token is single-use, so the script is once-only, guarded by /data/.enrolled.json: a re-run
 * against a provisioned volume exits 0 having done nothing. Only a 503 carrying `retryable: true`
 * is retried, the platform saying it released the claim; every other failure is terminal.
 *
 * Usage: `node /bundle/bootstrap.mjs` (first boot; no-op once enrolled), `--reset-admin-password`
 * (new editor password, keeps enrolment), `--force` (re-enrol with a new token in .env).
 */
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import {
  chownSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import process from 'node:process';

// bcryptjs is CommonJS and must be loaded by absolute path: this file runs from /bundle, so a bare
// specifier would never resolve against the image's own module directory.
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
// The forge's own public key, written from the enrolment response, so `git` verifies the host
// rather than trusting the first connection. See step 5b.
const KNOWN_HOSTS = join(GITOPS_DIR, 'known_hosts');
/** What flow-sync.mjs last deployed, and what the heartbeat reports. Must agree with flow-sync.mjs. */
const DEPLOYED = join(GITOPS_DIR, 'deployed.json');
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

// Configuration, from .env via compose's env_file
const SUPABASE_URL = (process.env.ACS_SUPABASE_URL || '').replace(/\/+$/, '');
// The publishable key, sent as `apikey` and as the bearer: the gateway translates it.
const GATEWAY_KEY = process.env.ACS_SUPABASE_PUBLISHABLE_KEY || '';
const TOKEN = (process.env.ACS_ENROLLMENT_TOKEN || '').trim();
const GATEWAY_NAME = process.env.ACS_GATEWAY_NAME || 'gateway';
const AGENT_VERSION = process.env.ACS_AGENT_VERSION || 'unknown';
const CREDENTIAL_SECRET = process.env.NODERED_CREDENTIAL_SECRET || '';

/**
 * The retry budget for a released claim: six attempts over roughly two minutes, enough to ride out
 * a broker restart, bounded so a bootstrap that cannot reach the platform reports so while somebody
 * is still standing next to it.
 */
const MAX_ATTEMPTS = 6;
const BACKOFF_MS = [2000, 5000, 10000, 20000, 30000];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The admin password
/**
 * A generated password and its bcrypt hash. Generated, never taken from .env, so it is not
 * identical on every appliance built from the bundle; it exists only in this process's stdout,
 * once, and as a hash in settings.js. base64url, so it survives a terminal, a ticket and a password
 * manager.
 */
function generateAdminPassword() {
  const bcrypt = require(`${RUNTIME_DIR}/bcryptjs`);
  const password = randomBytes(18).toString('base64url');
  // Cost 10, Node-RED's own default for adminAuth hashes, for a credential that is already 144 bits
  // of entropy and never transmitted.
  return { password, hash: bcrypt.hashSync(password, 10) };
}

// settings.js
/**
 * Local adminAuth with one user and no `default` user, so the editor and the /flows admin API are
 * closed to an unauthenticated caller. See the Dockerfile header for why this appliance does not
 * federate to Supabase Auth.
 */
/**
 * The flow-sync agent's own Node-RED login, generated and stored, unlike the admin password: a
 * machine that authenticates unattended cannot use a password that is printed once. It grants
 * nothing the volume mount does not already grant; the token exists because reloading is an API
 * call. `permissions: '*'` because Node-RED has no narrower grant that includes POST /flows.
 */
function generateSyncCredential() {
  const bcrypt = require(`${RUNTIME_DIR}/bcryptjs`);
  const password = randomBytes(18).toString('base64url');
  return { password, hash: bcrypt.hashSync(password, 10) };
}

/**
 * Write the sync agent's password where flow-sync.mjs will read it, 0600. Separate from
 * settings.js, which holds only the bcrypt hash.
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

// Enrolment
async function enrol() {
  const url = `${SUPABASE_URL}/functions/v1/enroll-gateway`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response;
    let payload;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          // The publishable key and no user JWT: the gateway requires a key, and the enrolment
          // token is what authorises the call.
          apikey: GATEWAY_KEY,
          Authorization: `Bearer ${GATEWAY_KEY}`,
          'Content-Type': 'application/json',
        },
        // ssh_public_key is the public half only, and may be null if ssh-keygen failed; the
        // platform treats a missing key as no repository rather than an error.
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

    // The only retryable failure: `retryable: true` is the platform stating it released the claim,
    // so this token is still live. Anything else, above all a 401, means the token is spent.
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

// Credentials, encrypted through Node-RED's own runtime
/**
 * Write flows_cred.json the way Node-RED will read it, through the runtime's own module rather than
 * hand-rolled AES, as scripts/node-red-init.mjs does. Asserts ciphertext before writing: an export
 * without the `$` envelope means encryption did not happen.
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

// main
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
  // The sync credential is re-issued here too: settings.js is rewritten whole, so the agent's
  // account has to be written back or the reset would remove it. This is also the repair path for
  // an appliance enrolled before flow-sync existed.
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
  !GATEWAY_KEY && 'ACS_SUPABASE_PUBLISHABLE_KEY',
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
 * This appliance's deploy key, generated here. The private half never leaves the plant; the public
 * half goes up with the enrolment request and is registered against the gateway's own repository,
 * where it can pull `main` and push `appliance` and nothing else (the branch rules the platform
 * sets there decide that, not the key). ed25519 for the low-power hardware. Reused if it exists, so a --force re-enrolment
 * sends the same public half. Not fatal if it fails: the appliance still enrols and publishes; it
 * cannot converge to a reviewed flow.
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

// 2. The flow. Placeholder substitution, not environment variables inside the flow, so the file on
// disk is the file that runs and an unresolved value fails here rather than at connect time.
const BROKER_NODE_ID = 'acs-broker';
const template = readFileSync(join(BUNDLE_DIR, 'flows.template.json'), 'utf8');
const flow = template
  .replaceAll('__MQTT_HOST__', enrolment.mqtt_host)
  .replaceAll('__MQTT_TLS_PORT__', String(enrolment.mqtt_tls_port))
  .replaceAll('__SPARKPLUG_ID__', enrolment.sparkplug_id)
  .replaceAll('__SPARKPLUG_GROUP__', enrolment.sparkplug_group)
  .replaceAll('__GATEWAY_NAME__', GATEWAY_NAME)
  // The CA path. The tls-config node's `ca` is a path read at deploy time; left empty, Node-RED
  // verifies the broker against the system trust store and reports only "Connection failed to
  // broker", the same line a wrong password produces. scripts/node-red-init.mjs guards the
  // identical failure with MQTT_TLS_CA_FILE.
  .replaceAll('__CA_FILE__', CA_PATH)
  // Read every minute by the flow's `read deployed.json` branch; see the record written below.
  .replaceAll('__DEPLOYED_FILE__', DEPLOYED);

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

// The flow as installed, recorded where flow-sync.mjs records every flow it deploys and in the same
// shape, so the heartbeat reports this hash until the first convergence replaces it. The dashboard
// compares it with the hash at the head of main; the enrolment flow is never on main, so a fresh
// appliance reads as differing until its first deploy, which is true. `revision: null` also makes
// flow-sync reconverge on its next tick after a --force re-enrolment.
mkdirSync(GITOPS_DIR, { recursive: true, mode: 0o700 });
writeFileSync(
  DEPLOYED,
  JSON.stringify({
    revision: null,
    branch: null,
    flow_sha256: createHash('sha256').update(flow).digest('hex'),
    deployed_at: new Date().toISOString(),
    source: 'enrolment',
  }, null, 2),
  { mode: 0o644 },
);
log(`wrote ${DEPLOYED} for the enrolment flow`);

// Two facts the heartbeat reports that Node-RED cannot work out for itself. A function node runs in
// a sandbox with no `require`, `fs` or `process`, so these are resolved here and handed to the flow
// as environment variables that `env.get()` reads. Both are fixed for the life of an enrolment; an
// operator who replaces the CA without re-enrolling keeps reporting the date recorded here.

/**
 * `ACS_AGENT_VERSION` comes from the operator's .env and is about to enter a shell file:
 * gateway.env is written as `export NAME='value'` and sourced, so a single quote would close the
 * string. Restricted to a safe character set rather than escaped, and capped at 64 to match the
 * daemon's column.
 */
const SAFE_AGENT_VERSION = AGENT_VERSION.replace(/[^A-Za-z0-9._+-]/g, '').slice(0, 64) || 'unknown';
if (SAFE_AGENT_VERSION !== AGENT_VERSION) {
  log(`ACS_AGENT_VERSION contained characters that cannot go in gateway.env; reporting `
    + `'${SAFE_AGENT_VERSION}'`);
}

/**
 * The CA's notAfter, in epoch milliseconds. The CA is distributed by hand into every appliance's
 * trust store, so re-minting it drops the whole fleet with no signal but absence; reporting the
 * date each appliance holds gives a month's warning. A CA that cannot be parsed is not fatal: the
 * appliance simply does not claim an expiry.
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
    `export GATEWAY_CA_EXPIRES_MS='${caExpiresMs}'`,
    `export NODERED_CREDENTIAL_SECRET='${CREDENTIAL_SECRET}'`,
    '',
  ].join('\n'),
  { mode: 0o600 },
);

// 5b. Where this appliance pulls from, if the platform gave it a repository. Recorded rather than
// derived: the clone URL is the forge's own answer. The host key arrives with it, over TLS on a
// single-use token bound to one gateway row, so the forge's identity is learned from the platform
// before the first clone and flow-sync.mjs never needs a skip-verification switch. A null
// repository or a null host key is not an error: the appliance keeps publishing, and flow-sync
// declines to converge and says why.
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
        // The platform repository the same key reads, and the tag current at enrolment. Read by
        // acs-gateway-converge on the host, which the platform playbook installs; the tag is the
        // fallback until the puller has fetched this gateway's own platform.yml.
        platform_ssh_url: enrolment.repository.platform_ssh_url || null,
        platform_tag: enrolment.repository.platform_tag || null,
        recorded_at: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  log(`this gateway pulls from ${enrolment.repository.ssh_url}`);
  if (enrolment.repository.platform_ssh_url) {
    log(`and converges to the platform at ${enrolment.repository.platform_tag} from ${enrolment.repository.platform_ssh_url}`);
  }
  if (!knownHosts) {
    log('WARNING: the platform sent no SSH host key for the forge, so this appliance cannot verify');
    log('it and will NOT converge. Restart the forge to publish one, then re-run enrolment.');
  }
} else {
  log('the platform gave this gateway no repository; it will publish telemetry but not converge.');
}

// 6. The marker, last, so a crash part-way through leaves the appliance un-enrolled rather than
// marked enrolled with half a configuration.
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

// Hand /data back to uid 1000, which Node-RED runs as. This script runs as root because the image
// ships /data/flows.json owned by root and a non-root bootstrap cannot overwrite it (see the `user:
// "0"` block in docker-compose.yml). Left root-owned, Node-RED would fail to write flows.json on
// the next editor deploy. Recursive and best-effort, but reported.
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
