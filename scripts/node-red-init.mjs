/**
 * Node-RED initialisation for the Factory+ stack.
 *
 * Seeds /data with the repo's flow definition and writes the MQTT broker
 * credentials ENCRYPTED AT REST, using Node-RED's own credential runtime so the
 * on-disk format is exactly what Node-RED expects to read back.
 *
 * THREE WRITES, THREE DIFFERENT LIFETIMES. An earlier version guarded all of
 * them behind a single "does flows.json exist" check, which is correct for
 * exactly one of them:
 *
 *   - the FLOW is user content. /data is a durable named volume, so an existing
 *     flows.json is work done in the editor, not a stale copy of ours. Seeded
 *     first-run only; NODE_RED_FORCE_SEED=true resets it deliberately.
 *   - settings.js is STACK CONFIGURATION. It must be reconciled on every boot,
 *     because a volume can outlive a fix to it -- and did: a volume provisioned
 *     before `flowFile` was declared here could never be repaired, since the
 *     one guard exited before reaching the repair.
 *   - the CREDENTIALS are stack configuration too, but only while there are
 *     none to lose. See the `_credentialSecret` note below.
 *
 * `flowFile` IS LOAD-BEARING AND ITS ABSENCE IS SILENT. Without it Node-RED does
 * not fall back to flows.json -- it falls back to `flows_<hostname>.json`
 * (@node-red/runtime/lib/storage/localfilesystem/projects/index.js), and a
 * container's hostname is a random id. So a seeded /data/flows.json is simply
 * never read: Node-RED starts with a BLANK CANVAS and writes its own empty flow
 * beside ours. The credentials file is derived from the same basename, so the
 * seeded flows_cred.json is missed in the same breath and the MQTT node comes up
 * with no username. One omitted line, two unrelated-looking symptoms.
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
import { createRequire } from 'node:module';

// settings.js is CommonJS and has to be evaluated, not parsed, to see what it actually declares
// -- see settingsAreCorrect(). This module is ESM, so `require` has to be constructed.
const require = createRequire(import.meta.url);

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

// Fail closed. A missing secret previously degraded to plaintext-on-disk silently.
// Checked before any write, and unconditionally: settings.js is now reconciled on every boot,
// so there is no longer a path that legitimately runs without these.
if (!credentialSecret) {
  fail('NODERED_CREDENTIAL_SECRET is not set; refusing to write credentials unencrypted.');
}
if (!mqttPassword) {
  fail('MQTT_PASSWORD is not set; refusing to seed empty broker credentials.');
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

// 1. Seed the flow definition from the repo -- FIRST RUN ONLY.
//
// The only one of this script's writes that is user content. An existing flows.json may be work
// done in the editor, and overwriting it silently discarded everything built there.
//
// THE GUARD IS A MARKER FILE, NOT `flows.json` EXISTING, and that distinction is the whole
// reason Node-RED came up blank. `nodered/node-red:latest` SHIPS a /data/flows.json in the image
// -- a two-node "Flow 1" placeholder -- and Docker pre-populates a fresh named volume from the
// image's directory contents. So flows.json exists before this script has ever run, on a volume
// that is empty by every meaningful definition. Guarding on it meant the repo flow was never
// seeded at all: the script announced it was "preserving Node-RED editor changes" that did not
// exist, and the editor opened on the image's placeholder.
//
// A marker records what this script DID, which is the actual question. It cannot be forged by an
// image, and it survives the user editing or deleting the flow.
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

// 2. Reconcile settings.js -- EVERY BOOT.
//
// Stack configuration, not user content, and the file a broken volume needs repaired. It is
// only rewritten when it does not already declare both keys correctly, so a settings.js this
// script previously wrote is left untouched.
//
// The check LOADS the module rather than grepping it. Node-RED's own default settings.js is 26KB
// and mentions `credentialSecret` in a commented-out example, so a substring test reports a file
// that declares nothing as correctly configured -- which is precisely the state a volume ends up
// in when Node-RED writes its default before this script ever gets to it.
function settingsAreCorrect() {
  if (!fs.existsSync(settingsPath)) return false;
  try {
    const loaded = require(settingsPath);
    return loaded?.credentialSecret === credentialSecret && loaded?.flowFile === FLOW_FILE;
  } catch (err) {
    // Unloadable settings cannot be trusted to declare anything. Replaced (with a backup).
    console.warn(`[node-red-init] settings.js could not be loaded (${err.message}); replacing it.`);
    return false;
  }
}

if (!settingsAreCorrect()) {
  // Never destroyed outright: a user may have hand-edited this file, and a .bak beside it is the
  // difference between a recoverable surprise and a lost afternoon.
  if (fs.existsSync(settingsPath)) {
    fs.copyFileSync(settingsPath, `${settingsPath}.bak`);
    console.log(`[node-red-init] previous settings.js backed up to ${settingsPath}.bak`);
  }
  fs.writeFileSync(
    settingsPath,
    'module.exports = {\n' +
      `  flowFile: ${JSON.stringify(FLOW_FILE)},\n` +
      `  credentialSecret: ${JSON.stringify(credentialSecret)}\n` +
      '};\n'
  );
  console.log(`[node-red-init] settings.js written (flowFile=${FLOW_FILE}, credentialSecret set).`);
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

const writeCredentials = seededFlow || !credentialsWorthKeeping();

// 3b. Drop any credential key Node-RED generated for itself on an earlier boot.
//
// When settings.js carries no `credentialSecret`, Node-RED mints a random one and stores it as
// `_credentialSecret` in .config.runtime.json. That stored key then wins on every subsequent
// start: Node-RED tries it against the flows_cred.json this script wrote under
// NODERED_CREDENTIAL_SECRET, fails to decrypt, silently DISCARDS the credentials, and rewrites
// the file empty under its own key. The mqtt-broker node is left with no username, and
// Mosquitto -- which runs `allow_anonymous false` -- refuses the connection with CONNACK 5.
//
// Guarded by writeCredentials rather than by the seed path: the point is not "is this a fresh
// volume" but "is there ciphertext that only this key can open". Tying it to the seed was what
// made an already-broken volume unrepairable, since the credentials were long gone but the stale
// key survived in a file the script never touched.
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
