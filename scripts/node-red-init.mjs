/**
 * Node-RED initialisation for the Factory+ stack.
 *
 * Seeds /data with the repo's flow definition and writes the MQTT broker
 * credentials ENCRYPTED AT REST, using Node-RED's own credential runtime so the
 * on-disk format is exactly what Node-RED expects to read back.
 *
 * Seeding is FIRST-RUN ONLY. /data is a durable named volume (nodered_data), so
 * an existing flows.json is the user's work, not a stale copy of ours -- this
 * script used to overwrite it on every `docker compose up`, silently discarding
 * everything built in the Node-RED editor. Set NODE_RED_FORCE_SEED=true to
 * deliberately reset the volume back to the repo's flow.
 *
 * Why this is not a plain JSON write: Node-RED encrypts flows_cred.json with
 * aes-256-ctr under sha256(credentialSecret). Writing plaintext leaves broker
 * passwords readable on the volume and makes Node-RED log
 * "Encrypted credentials not found" until a user happens to hit Deploy.
 *
 * The subtlety this script exists to get right: credentials.export() only
 * encrypts when the module's internal `encryptionEnabled` flag is set, and that
 * flag is set by load() or setKey() -- NOT by init(). Calling init() + add() +
 * export() (the obvious sequence) silently returns plaintext. We call setKey()
 * explicitly and then assert the result is encrypted before writing.
 *
 * Verified against Node-RED 5.0.1 (nodered/node-red:latest).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.NODE_RED_DATA_DIR || '/data';
const SEED_FLOW = process.env.NODE_RED_SEED_FLOW || '/seed/flows.json';
const RUNTIME_DIR =
  process.env.NODE_RED_RUNTIME_DIR || '/usr/src/node-red/node_modules';

const credentialSecret = process.env.NODERED_CREDENTIAL_SECRET;
const mqttUser = process.env.MQTT_USER || 'factoryplus';
const mqttPassword = process.env.MQTT_PASSWORD;
const forceSeed = /^(1|true|yes)$/i.test(process.env.NODE_RED_FORCE_SEED || '');

function fail(message) {
  console.error(`[node-red-init] ERROR: ${message}`);
  process.exit(1);
}

// Bail out before anything is written if the volume is already provisioned.
// This is checked ahead of the credential guards below because those protect a
// write, and on an existing volume there is no write to protect.
const flowsPath = path.join(DATA_DIR, 'flows.json');
if (fs.existsSync(flowsPath) && !forceSeed) {
  console.log(
    `[node-red-init] ${flowsPath} already exists; preserving Node-RED editor changes. ` +
      'Set NODE_RED_FORCE_SEED=true to reset the volume to the repo flow.'
  );
  process.exit(0);
}

// Fail closed. A missing secret previously degraded to plaintext-on-disk silently.
if (!credentialSecret) {
  fail('NODERED_CREDENTIAL_SECRET is not set; refusing to write credentials unencrypted.');
}
if (!mqttPassword) {
  fail('MQTT_PASSWORD is not set; refusing to seed empty broker credentials.');
}

// 1. Seed the flow definition from the repo. Reached only on a fresh volume, or
//    when NODE_RED_FORCE_SEED asks for a deliberate reset.
if (!fs.existsSync(SEED_FLOW)) {
  fail(`seed flow not found at ${SEED_FLOW}`);
}
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.copyFileSync(SEED_FLOW, flowsPath);

// 1b. Drop any credential key Node-RED generated for itself on an earlier boot.
//
// This is what made the seeded broker credentials unusable. When settings.js carries no
// `credentialSecret`, Node-RED mints a random one and stores it as `_credentialSecret` in
// .config.runtime.json. That stored key then wins over settings.js on every subsequent start:
// Node-RED tries it against the flows_cred.json this script wrote under NODERED_CREDENTIAL_SECRET,
// fails to decrypt, silently DISCARDS the credentials, and rewrites the file empty under its own
// key. The mqtt-broker node is then left with no username, and Mosquitto -- which runs
// `allow_anonymous false` -- answers every connection with "not authorised".
//
// The failure is silent from both ends: Node-RED logs only a generic "Connection failed to
// broker", and re-running this script does not help, because the stale key survives in a file the
// script never touched. Removing the key here is what makes a seed actually stick.
//
// Only ever reached on the seed path. On an existing volume the script has already exited above,
// so credentials a user entered through the editor -- which really are encrypted under
// `_credentialSecret` -- are never invalidated by this.
const runtimeConfigPath = path.join(DATA_DIR, '.config.runtime.json');
if (fs.existsSync(runtimeConfigPath)) {
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

// 2. settings.js supplies the key Node-RED derives its decryption key from.
fs.writeFileSync(
  path.join(DATA_DIR, 'settings.js'),
  `module.exports = { credentialSecret: ${JSON.stringify(credentialSecret)} };\n`
);

// 3. Encrypt the credentials via Node-RED's own runtime module.
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

// 4. Assert we really produced ciphertext. This is the guard that the previous
//    implementation lacked -- it failed open and wrote readable passwords.
if (!Object.prototype.hasOwnProperty.call(exported, '$')) {
  fail(
    'credential export was not encrypted (missing "$" envelope). ' +
      'Node-RED internals may have changed; refusing to write plaintext secrets.'
  );
}

// 5. Prove Node-RED will be able to read it back before we commit it to disk.
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

fs.writeFileSync(
  path.join(DATA_DIR, 'flows_cred.json'),
  JSON.stringify(exported)
);

console.log(
  `[node-red-init] Flow ${forceSeed ? 're-seeded (forced)' : 'seeded'} ` +
    'and credentials written encrypted (aes-256-ctr).'
);
