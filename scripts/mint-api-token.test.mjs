// =================================================================================================
// scripts/mint-api-token.mjs
//
// Each run records against a stand-in for PostgREST's record_service_token_issued and answers
// GoTrue's JWKS, so no stack is needed: stackCredentials() reads the environment before it asks the
// cluster, and KUBECONFIG names no file, so a name left out of the environment asks no cluster.
// =================================================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSigningKeys, signatureVerifies } from './lib/service-jwt.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'mint-api-token.mjs');
// Fresh each run: a stand-in for the release Secret's key set.
const KEY_SET = generateSigningKeys();
const PUBLISHED = JSON.parse(KEY_SET.jwtJwks).keys;
const READ_ONLY_API_CLIENT = 'b0000000-0000-4000-8000-000000000001';
const NO_CLUSTER = { KUBECONFIG: join(tmpdir(), 'mint-api-token-test-no-such-kubeconfig') };

/** Runs a script to its end, resolving with its exit code and both streams. */
function run(script, args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { env: { ...process.env, ...NO_CLUSTER, ...env } }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

/**
 * A stand-in for the recording RPC, answering every request with `status`, and for GoTrue's JWKS,
 * which publishes `published` (the public half of KEY_SET, as a release from 1.8.0 does).
 */
async function stubPostgrest(status = 200, { published = PUBLISHED } = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (req.url === '/auth/v1/.well-known/jwks.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ keys: published }));
        return;
      }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      calls.push({ url: req.url, body: JSON.parse(body || '{}') });
      res.end(status < 300 ? '1' : '{"message":"refused by the stand-in"}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const env = {
    SUPABASE_URL: `http://127.0.0.1:${server.address().port}`,
    SUPABASE_JWT_KEYS: KEY_SET.jwtKeys,
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    SUPABASE_PUBLISHABLE_KEY: 'publishable-key',
  };
  return { calls, env, close: () => new Promise((resolve) => server.close(resolve)) };
}

const headerOf = (token) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));

/** The claims of a token, once its signature verifies as the stack's verifiers verify it. */
function claimsOf(token) {
  assert.ok(signatureVerifies(token, { jwks: KEY_SET.jwtJwks }), `signed with the stack's key (${headerOf(token).alg})`);
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

test('it signs ES256 under the kid GoTrue publishes, and signs nothing while GoTrue does not', async () => {
  const live = await stubPostgrest(200);
  const off = await stubPostgrest(200, { published: [] });
  try {
    const es = await run(SCRIPT, [], live.env);
    assert.equal(es.code, 0, es.stderr);
    assert.deepEqual(headerOf(es.stdout.trim()), { alg: 'ES256', typ: 'JWT', kid: KEY_SET.kid });
    assert.equal(claimsOf(es.stdout.trim()).jti, live.calls[0].body.p_jti);
    assert.match(es.stderr, new RegExp(`# signed ES256, kid ${KEY_SET.kid}`));

    // A release that does not sign ES256: no service would take the token, so none is made.
    const refused = await run(SCRIPT, [], off.env);
    assert.equal(refused.code, 1);
    assert.equal(refused.stdout, '');
    assert.match(refused.stderr, /ES256 is not live: GoTrue does not publish kid/);
    assert.equal(off.calls.length, 0, 'nothing is recorded');

    const noKeys = await run(SCRIPT, [], { ...live.env, SUPABASE_JWT_KEYS: '' });
    assert.equal(noKeys.code, 1);
    assert.match(noKeys.stderr, /SUPABASE_JWT_KEYS is not set/);
  } finally {
    await live.close();
    await off.close();
  }
});

test('the script records the token, then prints it alone on stdout', async () => {
  const stub = await stubPostgrest();
  try {
    const { code, stdout, stderr } = await run(SCRIPT, [], stub.env);
    assert.equal(code, 0, stderr);
    const claims = claimsOf(stdout.trim());
    assert.equal(claims.sub, READ_ONLY_API_CLIENT);
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, '/rest/v1/rpc/record_service_token_issued');
    assert.equal(stub.calls[0].body.p_jti, claims.jti);
    assert.match(stderr, /Read-only API client b0000000-0000-4000-8000-000000000001 \(telemetry:read\)/);
    // Neutral about the client: a variable name suits one of them, and the dialog has a setup per client.
    assert.match(stderr, /Give it to the client as its bearer token\. The Issue Token dialog on Access Control/);
    assert.ok(!stderr.includes('I3X_TOKEN'), 'the plain output names no client variable');
  } finally {
    await stub.close();
  }
});

test('--json prints a block that parses, holding the token it recorded', async () => {
  const stub = await stubPostgrest();
  try {
    const { code, stdout, stderr } = await run(SCRIPT, ['--json'], stub.env);
    assert.equal(code, 0, stderr);
    const block = JSON.parse(stdout);
    const claims = claimsOf(block.mcpServers['aber-i3x'].env.I3X_TOKEN);
    assert.equal(claims.sub, READ_ONLY_API_CLIENT);
    assert.equal(stub.calls[0].body.p_jti, claims.jti);
  } finally {
    await stub.close();
  }
});

test('--principal and --days reach the token and its record', async () => {
  const stub = await stubPostgrest();
  const other = 'c0ffee00-0000-4000-8000-000000000009';
  try {
    const { code, stdout, stderr } = await run(SCRIPT, ['--principal', other, '--days', '7'], stub.env);
    assert.equal(code, 0, stderr);
    const claims = claimsOf(stdout.trim());
    assert.equal(claims.sub, other);
    assert.equal(claims.exp - claims.iat, 7 * 86400);
    assert.equal(stub.calls[0].body.p_principal_id, other);
  } finally {
    await stub.close();
  }
});

test('a refused recording exits 1 and prints no token', async () => {
  const stub = await stubPostgrest(400);
  try {
    const { code, stdout, stderr } = await run(SCRIPT, [], stub.env);
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /refused to record this issue \(HTTP 400\)/);
  } finally {
    await stub.close();
  }
});

test('an argument error exits 1 before anything is signed', async () => {
  const { code, stdout, stderr } = await run(SCRIPT, ['--principal', 'not-a-uuid']);
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /--principal must be a service principal's UUID, got 'not-a-uuid'/);
});
