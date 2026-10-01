/**
 * node-red-init against volumes written before the rename to Aber: the broker's tls-config node
 * moves to its new id, its references move with it, and nothing else in flows.json changes.
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
const scratch = [];
after(() => { for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true }); });

/** Node-RED's own envelope: aes-256-ctr under sha256(credentialSecret), iv in hex ahead of it. */
function encrypted(credentials) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-ctr', crypto.createHash('sha256').update(SECRET).digest(), iv);
  return { $: iv.toString('hex') + cipher.update(JSON.stringify(credentials), 'utf8', 'base64') + cipher.final('base64') };
}

/** A volume that was seeded before and holds the broker node's credential. */
function volume(flowText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-red-init-'));
  scratch.push(dir);
  fs.writeFileSync(path.join(dir, 'flows.json'), flowText);
  fs.writeFileSync(path.join(dir, 'flows_cred.json'), JSON.stringify(encrypted({ 'gw-broker': BROKER })));
  fs.writeFileSync(path.join(dir, '.aber-seeded'), '{"seeded_at":"2026-09-01T00:00:00.000Z"}');
  fs.writeFileSync(path.join(dir, 'ca.crt'), 'not read by the init script\n');
  return dir;
}

function run(dir, extraEnv = {}) {
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
    ...extraEnv,
  });
  const result = spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, `node-red-init exited ${result.status}:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

const flowFile = (dir) => fs.readFileSync(path.join(dir, 'flows.json'), 'utf8');

/** A flow as the stack left it before the rename, with a comment that names the id in prose. */
function flow({ id = 'factoryplus-tls-config', name = 'Factory+ internal CA', extra = [] } = {}) {
  return [
    { id: 'tab1', type: 'tab', label: 'Line 1', disabled: false, info: '' },
    {
      id: 'gw-broker', type: 'mqtt-broker', name: 'Cell 1', broker: 'mosquitto', port: '8883',
      usetls: true, tls: id, verifyservercert: true, protocolVersion: '5', acsCredentialsEnv: 'MQTT_GW_TEST',
    },
    {
      id, type: 'tls-config', name, certType: 'files', ca: '/etc/aber/tls/ca.crt', cert: '', key: '',
      verifyservercert: true, servername: '', alpnprotocol: '',
    },
    { id: 'note', type: 'comment', z: 'tab1', name: 'TLS', info: 'Brokers verify through "factoryplus-tls-config", the Factory+ internal CA.' },
    ...extra,
  ];
}

describe('the tls-config node named for Factory+', () => {
  it('moves to aber-tls-config with its reference and name, and the rest of the file is unchanged', () => {
    // Compact, as Node-RED itself writes flows.json.
    const dir = volume(JSON.stringify(flow()));
    const out = run(dir);
    assert.match(out, /moved tls-config node 'factoryplus-tls-config' to 'aber-tls-config' \(1 reference\(s\) with it\)/);
    assert.equal(flowFile(dir), JSON.stringify(flow({ id: 'aber-tls-config', name: 'Aber internal CA' })));
    assert.equal(fs.existsSync(path.join(dir, 'flows.json.pre-seed')), false, 'the flow must never be re-seeded');
    assert.match(out, /flow already seeded/);
  });

  it('keeps the formatting of a file this script wrote, and a second boot changes nothing', () => {
    const dir = volume(JSON.stringify(flow(), null, 4));
    run(dir);
    const moved = flowFile(dir);
    assert.equal(moved, JSON.stringify(flow({ id: 'aber-tls-config', name: 'Aber internal CA' }), null, 4));
    assert.doesNotMatch(run(dir), /moved tls-config node/);
    assert.equal(flowFile(dir), moved);
  });

  it('keeps a name somebody gave the node', () => {
    const dir = volume(JSON.stringify(flow({ name: 'Plant CA' })));
    run(dir);
    assert.equal(flowFile(dir), JSON.stringify(flow({ id: 'aber-tls-config', name: 'Plant CA' })));
  });

  it('leaves the flow alone when the new id is already taken', () => {
    const before = JSON.stringify(flow({ extra: [{ id: 'aber-tls-config', type: 'tls-config', name: 'Aber internal CA' }] }));
    const dir = volume(before);
    assert.doesNotMatch(run(dir), /moved tls-config node/);
    assert.equal(flowFile(dir), before);
  });

  it('is the node the TLS reconcile then finds, so no second one is added', () => {
    const dir = volume(JSON.stringify(flow()));
    run(dir, { MQTT_TLS_ENABLED: 'true', MQTT_TLS_CA_FILE: path.join(dir, 'ca.crt'), MQTT_PORT: '8883' });
    const nodes = JSON.parse(flowFile(dir));
    const tls = nodes.filter((n) => n.type === 'tls-config');
    assert.deepEqual(tls.map((n) => [n.id, n.name, n.ca]), [['aber-tls-config', 'Aber internal CA', path.join(dir, 'ca.crt')]]);
    assert.equal(nodes.find((n) => n.id === 'gw-broker').tls, 'aber-tls-config');
  });
});
