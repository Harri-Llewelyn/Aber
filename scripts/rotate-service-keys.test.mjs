// =================================================================================================
// scripts/rotate-service-keys.mjs: the key it signs with, the signing set it completes for 1.8.0,
// the two service secrets it replaces, and what --check reports.
//
// Each run reads its credentials from the environment, records against a stand-in for PostgREST
// and asks a stand-in GoTrue for its JWKS, and writes a values file in a scratch directory; KUBECONFIG
// names no file, so nothing reaches a cluster and nothing is applied.
// =================================================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { algorithmOf, decodeJwt, generateSigningKeys, mintJwt, signJwt, signatureVerifies, signingKeyFrom } from './lib/service-jwt.mjs';
import { readSecrets } from './lib/signing-set.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'rotate-service-keys.mjs');
const SECRET = randomBytes(32).toString('hex');
const KEY_SET = generateSigningKeys();
const SIGNING_KEY = signingKeyFrom(KEY_SET.jwtKeys);
const PUBLIC_KEYS = JSON.parse(KEY_SET.jwtJwks).keys;
const scratch = mkdtempSync(join(tmpdir(), 'rotate-service-keys-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

function run(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, KUBECONFIG: join(scratch, 'no-such-kubeconfig'), ...env },
    }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

/** PostgREST's recording RPC and service_token_health (`tokens`), and GoTrue's JWKS publishing `published`. */
async function stack(published = [], tokens = []) {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/auth/v1/.well-known/jwks.json') res.end(JSON.stringify({ keys: published }));
      else if (req.url.startsWith('/rest/v1/service_token_health')) res.end(JSON.stringify(tokens));
      else res.end('1');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

const hs = (role, subject) => {
  const iat = Math.floor(Date.now() / 1000);
  return signJwt({ iss: 'supabase', role, ...(subject ? { sub: subject, jti: `jti-${subject.slice(-1)}` } : {}), iat, exp: iat + 86400 * 30 },
    { secret: SECRET }).token;
};

/** A values file as setup.mjs before 1.7 wrote it: HS256 keys and no key pair. */
function valuesFile() {
  const file = join(mkdtempSync(join(scratch, 'values-')), 'values-local.yaml');
  writeFileSync(file, [
    'secrets:',
    `  jwtSecret: "${SECRET}"`,
    `  anonKey: "${hs('anon')}"`,
    `  serviceRoleKey: "${hs('service_role')}"`,
    `  ingestionKey: "${hs('authenticated', 'b0000000-0000-4000-8000-000000000002')}"`,
    `  playbackKey: "${hs('authenticated', 'b0000000-0000-4000-8000-000000000003')}"`,
    `  releaseCheckKey: "${hs('authenticated', 'b0000000-0000-4000-8000-000000000004')}"`,
    '  realtimeMetricsJwtSecret: "metrics"',
    '',
  ].join('\n'));
  return file;
}

const env = (url, extra = {}) => ({
  SUPABASE_URL: url, SUPABASE_JWT_KEYS: KEY_SET.jwtKeys, SUPABASE_SERVICE_ROLE_KEY: 'k', SUPABASE_PUBLISHABLE_KEY: 'p',
  SUPABASE_ANON_KEY: 'a', SUPABASE_INGESTION_KEY: 'i', SUPABASE_PLAYBACK_KEY: 'p', SUPABASE_RELEASE_CHECK_KEY: 'r',
  ...extra,
});

test('--signing-keys completes an HS256 values file for 1.8.0, and a second run changes nothing', async () => {
  const file = valuesFile();
  const before = readSecrets(readFileSync(file, 'utf8'));
  const first = await run(['--signing-keys', `--values=${file}`], env('http://127.0.0.1:9'));
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /Completed/);
  assert.match(first.stdout, /From 1\.8\.0, every token is signed ES256/);
  const after = readSecrets(readFileSync(file, 'utf8'));
  assert.ok(!after.jwtKeys.includes('"oct"') && !after.jwtJwks.includes('"oct"'));
  for (const key of ['anonKey', 'serviceRoleKey', 'ingestionKey', 'playbackKey', 'releaseCheckKey']) {
    assert.equal(algorithmOf(after[key]), 'ES256', key);
    assert.ok(signatureVerifies(after[key], { jwks: after.jwtJwks }), key);
    assert.deepEqual(decodeJwt(after[key]), decodeJwt(before[key]), key);
  }
  assert.ok(after.realtimeJwtSecret && after.storageJwtSecret);

  const text = readFileSync(file, 'utf8');
  const second = await run(['--signing-keys', `--values=${file}`], env('http://127.0.0.1:9'));
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /already holds the signing set 1\.8\.0 needs/);
  assert.equal(readFileSync(file, 'utf8'), text);
});

test('--signing-keys with no values file completes the release Secret and prints what to set', async () => {
  const pair = JSON.parse(KEY_SET.jwtKeys);
  const oct = { kty: 'oct', k: Buffer.from(SECRET).toString('base64url'), alg: 'HS256' };
  const missing = join(scratch, 'none', 'values-local.yaml');
  const r = await run(['--signing-keys', `--values=${missing}`], env('http://127.0.0.1:9', {
    SUPABASE_JWT_KEYS: JSON.stringify([...pair, oct]),
    SUPABASE_JWT_JWKS: JSON.stringify({ keys: [...PUBLIC_KEYS, oct] }),
    SUPABASE_ANON_KEY: mintJwt({ role: 'anon', signingKey: SIGNING_KEY }).token,
  }));
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!existsSync(missing));
  const printed = Object.fromEntries(r.stdout.split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1)]));
  assert.deepEqual(Object.keys(printed).sort(), ['REALTIME_JWT_SECRET', 'STORAGE_JWT_SECRET', 'SUPABASE_JWT_JWKS', 'SUPABASE_JWT_KEYS']);
  assert.deepEqual(JSON.parse(printed.SUPABASE_JWT_KEYS), pair, 'the same pair, without the oct key');
  assert.match(r.stderr, /Printed only/);
});

test('it signs ES256 once GoTrue publishes the kid, and refuses while it does not', async () => {
  const off = await stack([]);
  const live = await stack(PUBLIC_KEYS);
  try {
    const refused = await run([`--values=${valuesFile()}`], env(off.url));
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /ES256 is not live: GoTrue does not publish kid/);

    const file = valuesFile();
    const before = readFileSync(file, 'utf8');
    const es = await run([`--values=${file}`], env(live.url));
    assert.equal(es.code, 0, es.stderr);
    const after = readSecrets(readFileSync(file, 'utf8'));
    for (const key of ['ingestionKey', 'playbackKey', 'releaseCheckKey']) {
      assert.equal(algorithmOf(after[key]), 'ES256', key);
      assert.ok(signatureVerifies(after[key], { jwks: KEY_SET.jwtJwks }), key);
    }
    assert.equal(after.anonKey, readSecrets(before).anonKey, 'the API JWTs only with --anon-and-service-role');
  } finally {
    await off.close();
    await live.close();
  }
});

test('--anon-and-service-role re-signs the two ES256', async () => {
  const live = await stack(PUBLIC_KEYS);
  try {
    const file = valuesFile();
    const ok = await run(['--anon-and-service-role', `--values=${file}`], env(live.url));
    assert.equal(ok.code, 0, ok.stderr);
    const after = readSecrets(readFileSync(file, 'utf8'));
    for (const [key, role] of [['anonKey', 'anon'], ['serviceRoleKey', 'service_role']]) {
      assert.equal(algorithmOf(after[key]), 'ES256', key);
      assert.ok(signatureVerifies(after[key], { jwks: KEY_SET.jwtJwks }), key);
      assert.equal(decodeJwt(after[key]).role, role);
      assert.equal(decodeJwt(after[key]).jti, undefined, 'no principal, so no jti');
    }
    assert.match(ok.stderr, /deploy\/supabase-envoy deploy\/supabase-storage/, 'the gateway and storage restart');
  } finally {
    await live.close();
  }
});

test('--service-secrets replaces Realtime\'s and Storage\'s secrets and names what restarts', async () => {
  const file = valuesFile();
  writeFileSync(file, readFileSync(file, 'utf8').replace('  realtimeMetricsJwtSecret: "metrics"\n',
    '  realtimeMetricsJwtSecret: "metrics"\n  realtimeJwtSecret: "old-r"\n  storageJwtSecret: "old-s"\n'));
  const r = await run(['--service-secrets', `--values=${file}`], env('http://127.0.0.1:9'));
  assert.equal(r.code, 0, r.stderr);
  const after = readSecrets(readFileSync(file, 'utf8'));
  assert.match(after.realtimeJwtSecret, /^[0-9a-f]{64}$/);
  assert.match(after.storageJwtSecret, /^[0-9a-f]{64}$/);
  assert.match(r.stdout, new RegExp(`REALTIME_JWT_SECRET=${after.realtimeJwtSecret}`));
  assert.match(r.stderr, /rollout restart deploy\/supabase-realtime deploy\/supabase-storage/);
});

test('--check fails a Secret 1.8.0 would refuse, and lists the HS256 tokens outside the stack', async () => {
  const tokens = [{ identity_name: 'Read-only API client', jti: 'jti-outside', issued_at: '2026-10-01T00:00:00Z', expires_at: '2026-12-30T00:00:00Z' }];
  const off = await stack([], tokens);
  try {
    const es = mintJwt({ role: 'authenticated', signingKey: SIGNING_KEY, subject: 'b0000000-0000-4000-8000-000000000003' }).token;
    const r = await run(['--check'], env(off.url, {
      SUPABASE_JWT_KEYS: '', SUPABASE_INGESTION_KEY: hs('authenticated', 'b0000000-0000-4000-8000-000000000002'),
      SUPABASE_PLAYBACK_KEY: es, SUPABASE_RELEASE_CHECK_KEY: es, SUPABASE_ANON_KEY: hs('anon'), SUPABASE_SERVICE_ROLE_KEY: es,
    }));
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /SUPABASE_INGESTION_KEY .* HS256 /);
    assert.match(r.stdout, /SUPABASE_JWT_KEYS \(secrets\.jwtKeys, the ES256 key pair\) is missing/);
    assert.match(r.stdout, /signed HS256, which no service accepts from 1\.8\.0: SUPABASE_ANON_KEY, SUPABASE_INGESTION_KEY/);
    assert.match(r.stdout, /REALTIME_JWT_SECRET \(secrets\.realtimeJwtSecret\) is missing/);
    assert.match(r.stdout, /Tokens outside the stack signed HS256 \(every one: tokens are signed HS256 here/);
    assert.match(r.stdout, /Read-only API client .* jti jti-outside/);
    assert.match(r.stderr, /not ready for 1\.8\.0/);
  } finally {
    await off.close();
  }
});

test('--check passes a Secret ready for 1.8.0, and lists every token when Helm cannot say when ES256 began', async () => {
  const tokens = [{ identity_name: 'Line 3 historian reader', jti: 'jti-x', issued_at: '2026-10-01T00:00:00Z', expires_at: '2026-12-30T00:00:00Z' }];
  const live = await stack(PUBLIC_KEYS, tokens);
  try {
    const es = (subject) => mintJwt({ role: subject ? 'authenticated' : 'anon', signingKey: SIGNING_KEY, subject }).token;
    const r = await run(['--check'], env(live.url, {
      SUPABASE_JWT_JWKS: KEY_SET.jwtJwks, REALTIME_JWT_SECRET: 'r', STORAGE_JWT_SECRET: 's',
      SUPABASE_ANON_KEY: es(), SUPABASE_SERVICE_ROLE_KEY: es(),
      SUPABASE_INGESTION_KEY: es('b0000000-0000-4000-8000-000000000002'),
      SUPABASE_PLAYBACK_KEY: es('b0000000-0000-4000-8000-000000000003'),
      SUPABASE_RELEASE_CHECK_KEY: es('b0000000-0000-4000-8000-000000000004'),
    }));
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /The signing set is what 1\.8\.0 needs/);
    assert.match(r.stdout, /those issued before ES256 signing went live; .*so all are listed/);
    assert.match(r.stdout, /Line 3 historian reader .* jti jti-x/);
  } finally {
    await live.close();
  }
});
