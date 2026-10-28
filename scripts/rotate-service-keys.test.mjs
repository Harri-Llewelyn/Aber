// =================================================================================================
// scripts/rotate-service-keys.mjs: which key it signs with, and the ES256 key pair it adds.
//
// Each run reads its credentials from the environment, records against a stand-in for PostgREST
// and asks a stand-in GoTrue for its JWKS, and writes a values file in a scratch directory; KUBECONFIG
// names no file, so nothing reaches a cluster and nothing is applied.
// =================================================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSigningKeys, signatureVerifies, mintJwt } from './lib/service-jwt.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'rotate-service-keys.mjs');
const SECRET = randomBytes(32).toString('hex');
const KEY_SET = generateSigningKeys(SECRET);
const PUBLIC_KEYS = JSON.parse(KEY_SET.jwtJwks).keys.filter((k) => k.kty === 'EC');
const scratch = mkdtempSync(join(tmpdir(), 'rotate-service-keys-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

function run(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, KUBECONFIG: join(scratch, 'no-such-kubeconfig'), ...env },
    }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

/** PostgREST's recording RPC, and GoTrue's JWKS publishing `published`. */
async function stack(published = []) {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(req.url === '/auth/v1/.well-known/jwks.json' ? JSON.stringify({ keys: published }) : '1');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** A values file as setup.mjs before 1.7 wrote it: HS256 keys and no key pair. */
function valuesFile() {
  const file = join(mkdtempSync(join(scratch, 'values-')), 'values-local.yaml');
  const hs = (role, subject) => mintJwt({ role, secret: SECRET, subject }).token;
  writeFileSync(file, [
    'secrets:',
    `  jwtSecret: "${SECRET}"`,
    `  anonKey: "${hs('anon')}"`,
    `  serviceRoleKey: "${hs('service_role')}"`,
    `  ingestionKey: "${hs('authenticated', 'b0000000-0000-4000-8000-000000000002')}"`,
    `  playbackKey: "${hs('authenticated', 'b0000000-0000-4000-8000-000000000003')}"`,
    `  releaseCheckKey: "${hs('authenticated', 'b0000000-0000-4000-8000-000000000004')}"`,
    '',
  ].join('\n'));
  return file;
}

/** A values file's `key: "value"` or `key: 'value'`, unquoted. */
const value = (text, key) => {
  const line = text.split('\n').find((l) => l.trimStart().startsWith(`${key}: `));
  return line?.trim().slice(key.length + 2).replace(/^['"]|['"]$/g, '');
};
const algOf = (token) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString()).alg;
const env = (url, extra = {}) => ({
  SUPABASE_URL: url, SUPABASE_JWT_SECRET: SECRET, SUPABASE_SERVICE_ROLE_KEY: 'k', SUPABASE_PUBLISHABLE_KEY: 'p',
  SUPABASE_ANON_KEY: 'a', SUPABASE_INGESTION_KEY: 'i', SUPABASE_PLAYBACK_KEY: 'p', SUPABASE_RELEASE_CHECK_KEY: 'r',
  ...extra,
});

test('--signing-keys writes a pair around the secret beside it, and signs nothing', async () => {
  const file = valuesFile();
  const before = readFileSync(file, 'utf8');
  const { code, stdout, stderr } = await run(['--signing-keys', `--values=${file}`], env('http://127.0.0.1:9'));
  assert.equal(code, 0, stderr);
  const after = readFileSync(file, 'utf8');
  const jwtKeys = value(after, 'jwtKeys');
  const jwtJwks = value(after, 'jwtJwks');
  assert.ok(jwtKeys && jwtJwks, 'both halves are written');
  assert.match(after, /jwtSecret: .*\n\s+jwtKeys: '\[.*\n\s+jwtJwks: '\{/, 'beside jwtSecret, single-quoted');
  assert.equal(value(after, 'anonKey'), value(before, 'anonKey'), 'no JWT is re-signed');
  const legacy = { kty: 'oct', k: Buffer.from(SECRET).toString('base64url'), alg: 'HS256' };
  assert.deepEqual(JSON.parse(jwtJwks).keys[1], legacy);
  assert.ok(signatureVerifies(value(before, 'anonKey'), { jwks: jwtJwks }), 'the HS256 keys verify against the new JWKS');
  assert.match(stdout, /supabaseAuth\.es256Signing: true/);
});

test('--signing-keys refuses a Secret that already holds a pair', async () => {
  const { code, stderr } = await run(['--signing-keys', `--values=${valuesFile()}`],
    env('http://127.0.0.1:9', { SUPABASE_JWT_KEYS: KEY_SET.jwtKeys }));
  assert.equal(code, 1);
  assert.match(stderr, /already holds SUPABASE_JWT_KEYS/);
});

test('it signs HS256 while GoTrue does not publish the kid, and ES256 once it does', async () => {
  const off = await stack([]);
  const live = await stack(PUBLIC_KEYS);
  try {
    const hsFile = valuesFile();
    const hs = await run([`--values=${hsFile}`], env(off.url, { SUPABASE_JWT_KEYS: KEY_SET.jwtKeys }));
    assert.equal(hs.code, 0, hs.stderr);
    assert.equal(algOf(value(readFileSync(hsFile, 'utf8'), 'ingestionKey')), 'HS256');
    assert.match(hs.stderr, /Signed HS256 \(GoTrue does not publish kid/);

    const esFile = valuesFile();
    const before = readFileSync(esFile, 'utf8');
    const es = await run([`--values=${esFile}`], env(live.url, { SUPABASE_JWT_KEYS: KEY_SET.jwtKeys }));
    assert.equal(es.code, 0, es.stderr);
    const after = readFileSync(esFile, 'utf8');
    for (const key of ['ingestionKey', 'playbackKey', 'releaseCheckKey']) {
      assert.equal(algOf(value(after, key)), 'ES256', key);
      assert.ok(signatureVerifies(value(after, key), { jwks: KEY_SET.jwtJwks }), key);
    }
    assert.equal(value(after, 'anonKey'), value(before, 'anonKey'), 'the API JWTs only with --anon-and-service-role');
  } finally {
    await off.close();
    await live.close();
  }
});

test('--anon-and-service-role re-signs the two ES256, and refuses while ES256 is not live', async () => {
  const off = await stack([]);
  const live = await stack(PUBLIC_KEYS);
  try {
    const refused = await run(['--anon-and-service-role', `--values=${valuesFile()}`],
      env(off.url, { SUPABASE_JWT_KEYS: KEY_SET.jwtKeys }));
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /ES256 is not live/);

    const file = valuesFile();
    const ok = await run(['--anon-and-service-role', `--values=${file}`], env(live.url, { SUPABASE_JWT_KEYS: KEY_SET.jwtKeys }));
    assert.equal(ok.code, 0, ok.stderr);
    const after = readFileSync(file, 'utf8');
    for (const [key, role] of [['anonKey', 'anon'], ['serviceRoleKey', 'service_role']]) {
      const token = value(after, key);
      assert.equal(algOf(token), 'ES256', key);
      assert.ok(signatureVerifies(token, { jwks: KEY_SET.jwtJwks }), key);
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
      assert.equal(claims.role, role);
      assert.equal(claims.jti, undefined, 'no principal, so no jti');
    }
    assert.match(ok.stderr, /deploy\/supabase-envoy deploy\/supabase-storage/, 'the gateway and storage restart');
  } finally {
    await off.close();
    await live.close();
  }
});

test('--check names the keys still HS256, and does not fail on them', async () => {
  const hs = mintJwt({ role: 'authenticated', secret: SECRET, subject: 'b0000000-0000-4000-8000-000000000002' }).token;
  const es = mintJwt({ role: 'authenticated', signingKey: JSON.parse(KEY_SET.jwtKeys)[0], subject: 'b0000000-0000-4000-8000-000000000003' }).token;
  const { code, stdout } = await run(['--check'], {
    SUPABASE_INGESTION_KEY: hs, SUPABASE_PLAYBACK_KEY: es, SUPABASE_RELEASE_CHECK_KEY: es,
    SUPABASE_ANON_KEY: hs, SUPABASE_SERVICE_ROLE_KEY: es, SUPABASE_JWT_SECRET: SECRET,
  });
  assert.equal(code, 0, stdout);
  assert.match(stdout, /SUPABASE_INGESTION_KEY .* HS256 /);
  assert.match(stdout, /SUPABASE_PLAYBACK_KEY .* ES256 /);
  assert.match(stdout, /HS256, which stops verifying in 1\.8: SUPABASE_INGESTION_KEY, SUPABASE_ANON_KEY\./);
});
