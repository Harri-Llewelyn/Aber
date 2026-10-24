// =================================================================================================
// scripts/mint-api-token.mjs, and scripts/mint-mcp-token.mjs, its old name until 1.8.0
//
// Each run records against a stand-in for PostgREST's record_service_token_issued, so no stack is
// needed: stackCredentials() reads the environment before it asks the cluster.
// =================================================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'mint-api-token.mjs');
const OLD_NAME = join(HERE, 'mint-mcp-token.mjs');
// Fresh each run: a stand-in for the release Secret's SUPABASE_JWT_SECRET.
const SECRET = randomBytes(32).toString('hex');
const READ_ONLY_API_CLIENT = 'b0000000-0000-4000-8000-000000000001';
const NOTICE = 'scripts/mint-mcp-token.mjs is now scripts/mint-api-token.mjs; the old name is removed in 1.8.0.';

/** Runs a script to its end, resolving with its exit code and both streams. */
function run(script, args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

/** A stand-in for the recording RPC, answering every request with `status`. */
async function stubPostgrest(status = 200) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      calls.push({ url: req.url, body: JSON.parse(body || '{}') });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(status < 300 ? '1' : '{"message":"refused by the stand-in"}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const env = {
    SUPABASE_URL: `http://127.0.0.1:${server.address().port}`,
    SUPABASE_JWT_SECRET: SECRET,
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    SUPABASE_PUBLISHABLE_KEY: 'publishable-key',
  };
  return { calls, env, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** The claims of a token, once its signature is checked against the stack secret. */
function claimsOf(token) {
  const [header, payload, signature] = token.split('.');
  const expected = createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url');
  assert.equal(signature, expected, 'signed with the stack secret');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

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
    assert.ok(!stderr.includes(NOTICE), 'the new name prints no deprecation notice');
  } finally {
    await stub.close();
  }
});

test('the old name says where the script went, on stderr, and --json still parses', async () => {
  const stub = await stubPostgrest();
  try {
    const { code, stdout, stderr } = await run(OLD_NAME, ['--json'], stub.env);
    assert.equal(code, 0, stderr);
    assert.equal(stderr.split(/\r?\n/)[0], NOTICE);
    const block = JSON.parse(stdout);
    const claims = claimsOf(block.mcpServers['aber-i3x'].env.I3X_TOKEN);
    assert.equal(claims.sub, READ_ONLY_API_CLIENT);
    assert.equal(stub.calls[0].body.p_jti, claims.jti);
  } finally {
    await stub.close();
  }
});

test('the old name passes every argument through', async () => {
  const stub = await stubPostgrest();
  const other = 'c0ffee00-0000-4000-8000-000000000009';
  try {
    const { code, stdout, stderr } = await run(OLD_NAME, ['--principal', other, '--days', '7'], stub.env);
    assert.equal(code, 0, stderr);
    const claims = claimsOf(stdout.trim());
    assert.equal(claims.sub, other);
    assert.equal(claims.exp - claims.iat, 7 * 86400);
    assert.equal(stub.calls[0].body.p_principal_id, other);
  } finally {
    await stub.close();
  }
});

test('the old name keeps the exit code when the recording is refused, and prints no token', async () => {
  const stub = await stubPostgrest(400);
  try {
    const { code, stdout, stderr } = await run(OLD_NAME, [], stub.env);
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.equal(stderr.split(/\r?\n/)[0], NOTICE);
    assert.match(stderr, /refused to record this issue \(HTTP 400\)/);
  } finally {
    await stub.close();
  }
});

test('an argument error exits 1 under either name, before anything is signed', async () => {
  for (const script of [SCRIPT, OLD_NAME]) {
    const { code, stdout, stderr } = await run(script, ['--principal', 'not-a-uuid']);
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /--principal must be a service principal's UUID, got 'not-a-uuid'/);
    assert.equal(stderr.includes(NOTICE), script === OLD_NAME);
  }
});
