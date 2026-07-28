/**
 * Node-RED initialisation for the Factory+ stack.
 *
 * Seeds /data with the repo's flow definition and writes the MQTT broker
 * credentials ENCRYPTED AT REST, using Node-RED's own credential runtime so the
 * on-disk format is exactly what Node-RED expects to read back.
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

function fail(message) {
  console.error(`[node-red-init] ERROR: ${message}`);
  process.exit(1);
}

// Fail closed. A missing secret previously degraded to plaintext-on-disk silently.
if (!credentialSecret) {
  fail('NODERED_CREDENTIAL_SECRET is not set; refusing to write credentials unencrypted.');
}
if (!mqttPassword) {
  fail('MQTT_PASSWORD is not set; refusing to seed empty broker credentials.');
}

// 1. Seed the flow definition from the repo.
if (!fs.existsSync(SEED_FLOW)) {
  fail(`seed flow not found at ${SEED_FLOW}`);
}
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.copyFileSync(SEED_FLOW, path.join(DATA_DIR, 'flows.json'));

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

console.log('[node-red-init] Flow seeded and credentials written encrypted (aes-256-ctr).');
