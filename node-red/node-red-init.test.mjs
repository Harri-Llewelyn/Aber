/**
 * node-red-init against a seeded volume: the TLS reconcile adds one tls-config node and points
 * every broker at it; a managed broker node whose pair is missing stops the boot, while one built
 * in the editor is left alone with what its Security tab holds.
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
import { after, describe, it } from 'node:test';
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
