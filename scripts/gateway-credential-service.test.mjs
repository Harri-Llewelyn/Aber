/**
 * The credential service's read-only account verbs, over HTTP, against a stand-in broker.
 *
 *     node --test scripts/gateway-credential-service.test.mjs
 *
 * The service runs as it ships, with its own bearer token, and its control requests go through
 * controlArgv's shell to a `mosquitto_rr` earlier on PATH: a script that answers each command as the
 * 2.1.2 plugin does (its replies measured on eclipse-mosquitto:2.1.2-alpine) and records what it
 * was sent. What is held here: who may call the two verbs, that the caller names the purpose and
 * nothing else, and that a username outside the subscriber scheme reaches no broker command.
 * scripts/check-broker-config.mjs drives the same commands against the real plugin. Needs `sh`
 * and `node` on PATH.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVICE = join(dirname(fileURLToPath(import.meta.url)), 'gateway-credential-service.mjs');
const TOKEN = 'a-test-bearer-token-of-forty-characters!!';
const SUBSCRIBER = /^sub[0-9a-f]{21}$/;
const PURPOSE = { name: 'Line 4 OEE board', description: 'The contractor dashboard on line 4. Reads only.' };

// The stand-in plugin: one command per request, its state in a file between requests.
const STUB = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const state = existsSync(process.env.STUB_STATE) ? JSON.parse(readFileSync(process.env.STUB_STATE, 'utf8')) : { clients: {} };
const { commands } = JSON.parse(readFileSync(0, 'utf8'));
const responses = commands.map((c) => {
  appendFileSync(process.env.STUB_LOG, JSON.stringify(c) + '\\n');
  const held = state.clients[c.username];
  switch (c.command) {
    case 'createClient':
      if (held) return { command: c.command, error: 'Client already exists' };
      state.clients[c.username] = { username: c.username, textname: c.textname, textdescription: c.textdescription, roles: c.roles || [], groups: [], connections: [] };
      return { command: c.command };
    case 'getClient':
      return held ? { command: c.command, data: { client: held } } : { command: c.command, error: 'Client not found' };
    case 'deleteClient':
      if (!held) return { command: c.command, error: 'Client not found' };
      delete state.clients[c.username];
      return { command: c.command };
    case 'listClients':
      return { command: c.command, data: { totalCount: Object.keys(state.clients).length, clients: Object.values(state.clients) } };
    case 'listRoles':
      return { command: c.command, data: { roles: [{ rolename: 'subscriber', acls: [{ acltype: 'subscribePattern', topic: 'spBv1.0/#', priority: 0, allow: true }] }] } };
    default:
      return { command: c.command, error: 'Unknown command' };
  }
});
writeFileSync(process.env.STUB_STATE, JSON.stringify(state));
process.stdout.write(JSON.stringify({ responses }));
`;

const work = mkdtempSync(join(tmpdir(), 'credential-service-'));
const logFile = join(work, 'sent.jsonl');
let service;
let base;

/** The commands the stand-in broker was sent since the last call, by name. */
function sentSince() {
  const lines = existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : [];
  writeFileSync(logFile, '');
  return lines.map((l) => JSON.parse(l));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function call(path, { body, token = TOKEN, method = 'POST' } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

before(async () => {
  writeFileSync(join(work, 'stub.mjs'), STUB);
  const wrapper = join(work, 'mosquitto_rr');
  writeFileSync(wrapper, `#!/bin/sh\nexec node "${join(work, 'stub.mjs').replace(/\\/g, '/')}"\n`);
  chmodSync(wrapper, 0o755);
  writeFileSync(logFile, '');

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  service = spawn(process.execPath, [SERVICE], {
    env: {
      ...process.env,
      PATH: `${work}${delimiter}${process.env.PATH}`,
      MQTT_CREDENTIAL_SERVICE_PORT: String(port),
      MQTT_CREDENTIAL_SERVICE_TOKEN: TOKEN,
      MQTT_DYNSEC_ADMIN_USER: 'dynsec-admin',
      MQTT_DYNSEC_ADMIN_PASSWORD: 'admin-password-for-the-test',
      MQTT_HOST: '127.0.0.1',
      STUB_STATE: join(work, 'state.json'),
      STUB_LOG: logFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the service did not start:\n${output}`)), 10000);
    const seen = (chunk) => {
      output += chunk;
      if (output.includes('listening on')) { clearTimeout(timer); resolve(); }
    };
    service.stdout.on('data', seen);
    service.stderr.on('data', seen);
    service.once('exit', (code) => { clearTimeout(timer); reject(new Error(`the service exited ${code}:\n${output}`)); });
  });
});

after(() => {
  service?.kill();
  rmSync(work, { recursive: true, force: true });
});

describe('creating a read-only account', () => {
  test('is refused without the bearer token, and the broker is asked nothing', async () => {
    for (const token of [null, 'x'.repeat(TOKEN.length), 'short']) {
      assert.equal((await call('/subscribers', { body: PURPOSE, token })).status, 401);
      assert.equal((await call('/subscriber-deletions', { body: { username: 'sub0a1b2c3d4e5f60718293a' }, token })).status, 401);
    }
    assert.deepEqual(sentSince(), []);
  });

  test('makes one account in the scheme, holding the subscriber role, and returns its password once', async () => {
    const { status, body } = await call('/subscribers', { body: PURPOSE });
    assert.equal(status, 200);
    assert.match(body.username, SUBSCRIBER);
    assert.match(body.password, /^[A-Za-z0-9_-]{32}$/);
    assert.deepEqual({ ...body, username: null, password: null }, {
      username: null, password: null, name: PURPOSE.name, description: PURPOSE.description, roles: ['subscriber'],
    });

    const sent = sentSince();
    assert.deepEqual(sent, [{
      command: 'createClient',
      username: body.username,
      password: body.password,
      textname: PURPOSE.name,
      textdescription: PURPOSE.description,
      roles: [{ rolename: 'subscriber' }],
    }]);

    // The Access Control page reads what it is for from the inventory, with no hash material.
    const listed = (await call('/clients', { method: 'GET' })).body.clients.find((c) => c.username === body.username);
    assert.deepEqual(listed, {
      username: body.username, roles: ['subscriber'], disabled: false, connections: 0,
      textname: PURPOSE.name, textdescription: PURPOSE.description,
    });
    sentSince();
  });

  test('takes no username, password or role from the caller', async () => {
    const { status, body } = await call('/subscribers', {
      body: { ...PURPOSE, username: 'gwy120000000000400080000', password: 'chosen-by-the-caller-0001', roles: ['admin'], role: 'ingestion' },
    });
    assert.equal(status, 200);
    assert.match(body.username, SUBSCRIBER);
    assert.notEqual(body.password, 'chosen-by-the-caller-0001');
    const [create] = sentSince();
    assert.deepEqual(create.roles, [{ rolename: 'subscriber' }]);
    assert.equal(create.username, body.username);
  });

  test('refuses a missing or malformed purpose before the broker is asked anything', async () => {
    for (const [body, code] of [
      [{ description: PURPOSE.description }, 'invalid_subscriber_name'],
      [{ name: '  ', description: PURPOSE.description }, 'invalid_subscriber_name'],
      [{ name: PURPOSE.name }, 'invalid_subscriber_description'],
      [{ name: PURPOSE.name, description: 'two\nlines' }, 'invalid_subscriber_description'],
      [{ name: 'x'.repeat(81), description: PURPOSE.description }, 'invalid_subscriber_name'],
    ]) {
      const answer = await call('/subscribers', { body });
      assert.equal(answer.status, 400, JSON.stringify(body));
      assert.equal(answer.body.code, code, JSON.stringify(body));
    }
    assert.deepEqual(sentSince(), []);
  });

  test('answers a POST and nothing else', async () => {
    assert.equal((await call('/subscribers', { method: 'GET' })).status, 405);
    assert.equal((await call('/subscriber-deletions', { method: 'GET' })).status, 405);
    assert.deepEqual(sentSince(), []);
  });
});

describe('deleting a read-only account', () => {
  test('refuses every username outside the subscriber scheme, and the broker is asked nothing', async () => {
    for (const username of [
      'gwy120000000000400080000', 'gwy110000000000400080000', 'aber_ingestion', 'aber_i3x', 'aber_monitor',
      'dynsec-admin', 'scada-reader', 'sub0a1b2c3d4e5f60718293', '', undefined,
    ]) {
      const answer = await call('/subscriber-deletions', { body: { username } });
      assert.equal(answer.status, 400, String(username));
      assert.equal(answer.body.code, 'invalid_subscriber_id', String(username));
    }
    assert.deepEqual(sentSince(), []);
  });

  test('deletes one it made, saying what it was for, and the inventory no longer lists it', async () => {
    const made = (await call('/subscribers', { body: PURPOSE })).body;
    sentSince();
    const { status, body } = await call('/subscriber-deletions', { body: { username: made.username } });
    assert.equal(status, 200);
    assert.deepEqual(body, {
      username: made.username, existed: true, deleted: true,
      name: PURPOSE.name, description: PURPOSE.description, roles: ['subscriber'],
    });
    assert.deepEqual(sentSince().map((c) => [c.command, c.username]), [['getClient', made.username], ['deleteClient', made.username]]);
    const clients = (await call('/clients', { method: 'GET' })).body.clients;
    assert.ok(!clients.some((c) => c.username === made.username));
    sentSince();
  });

  test('says when there was nothing to delete, and deletes nothing', async () => {
    const { status, body } = await call('/subscriber-deletions', { body: { username: 'sub00000000000000000000f' } });
    assert.equal(status, 200);
    assert.deepEqual(body, {
      username: 'sub00000000000000000000f', existed: false, deleted: false, name: null, description: null, roles: [],
    });
    assert.deepEqual(sentSince().map((c) => c.command), ['getClient']);
  });
});
