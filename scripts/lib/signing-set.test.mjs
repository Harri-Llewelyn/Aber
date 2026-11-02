// =================================================================================================
// scripts/lib/signing-set.mjs and scripts/lib/signing-history.mjs, and setup.mjs completing a values
// file with them: what a site made before 1.8.0 is given, what it keeps, and that a second run
// changes nothing. Every key here is minted at run time.
// =================================================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  algorithmOf, decodeJwt, generateSigningKeys, signJwt, signatureVerifies, signingKeyFrom,
} from './service-jwt.mjs';
import {
  completeSigningSet, completeValuesText, readSecrets, secretFromUpdates, valuesFromSecret, writeSecrets,
} from './signing-set.mjs';
import { chartSignsEs256, es256SinceFrom } from './signing-history.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SECRET = randomBytes(32).toString('hex');
const oct = { kty: 'oct', k: Buffer.from(SECRET).toString('base64url'), alg: 'HS256' };
const scratch = mkdtempSync(join(tmpdir(), 'signing-set-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

const PRINCIPALS = { ingestionKey: '2', playbackKey: '3', releaseCheckKey: '4' };
const now = Math.floor(Date.now() / 1000);
/** The five JWTs a values file holds, signed by `sign` (signJwt's second argument). */
function jwts(sign) {
  const out = {
    anonKey: signJwt({ iss: 'supabase', role: 'anon', iat: now, exp: now + 3650 * 86400 }, sign).token,
    serviceRoleKey: signJwt({ iss: 'supabase', role: 'service_role', iat: now, exp: now + 3650 * 86400 }, sign).token,
  };
  for (const [key, n] of Object.entries(PRINCIPALS)) {
    out[key] = signJwt({
      iss: 'supabase', role: 'authenticated', sub: `b0000000-0000-4000-8000-00000000000${n}`, jti: `jti-${key}`, iat: now, exp: now + 90 * 86400,
    }, sign).token;
  }
  return out;
}

/** A values file in setup.mjs's shape: what 1.6 wrote (HS256, no pair), or 1.7 (ES256 and the `oct` key). */
function valuesFile({ pair = null, sign = { secret: SECRET }, extra = [], es256Line = null } = {}) {
  const secrets = { jwtSecret: SECRET, ...(pair ? { jwtKeys: pair.jwtKeys, jwtJwks: pair.jwtJwks } : {}), ...jwts(sign) };
  return [
    '# Written by `npm run setup`.',
    'global:',
    '  publicBaseDomain: "aber.example.test"',
    '',
    ...(es256Line ? ['supabaseAuth:', `  es256Signing: ${es256Line}`, ''] : []),
    'secrets:',
    ...Object.entries(secrets).map(([k, v]) => (v.includes('"') ? `  ${k}: '${v}'` : `  ${k}: "${v}"`)),
    '  realtimeMetricsJwtSecret: "metrics-secret"',
    ...extra,
    '  noderedWebhookJwtSecret: "webhook-secret"',
    '',
  ].join('\n');
}

/** A 1.7 key set: the EC pair, and the shared secret as the `oct` key in both halves. */
function pairOf17() {
  const pair = generateSigningKeys();
  return {
    ...pair,
    jwtKeys: JSON.stringify([...JSON.parse(pair.jwtKeys), oct]),
    jwtJwks: JSON.stringify({ keys: [...JSON.parse(pair.jwtJwks).keys, oct] }),
  };
}

const noOct = (json) => !JSON.stringify(JSON.parse(json)).includes('"oct"');

test('a site still on HS256 gets the pair, its five JWTs signed again ES256, and the two secrets', () => {
  const before = valuesFile({ es256Line: 'false' });
  const { text, changed, notes, resigned } = completeValuesText(before);
  assert.ok(changed);
  const after = readSecrets(text);
  const was = readSecrets(before);
  assert.ok(after.jwtKeys && after.jwtJwks && noOct(after.jwtKeys) && noOct(after.jwtJwks), 'EC keys alone');
  assert.deepEqual(resigned, ['anonKey', 'serviceRoleKey', 'ingestionKey', 'playbackKey', 'releaseCheckKey']);
  for (const key of resigned) {
    assert.equal(algorithmOf(after[key]), 'ES256', key);
    assert.ok(signatureVerifies(after[key], { jwks: after.jwtJwks }), key);
    assert.deepEqual(decodeJwt(after[key]), decodeJwt(was[key]), `${key}'s claims, its jti among them, are kept`);
  }
  assert.match(after.realtimeJwtSecret, /^[0-9a-f]{64}$/);
  assert.match(after.storageJwtSecret, /^[0-9a-f]{64}$/);
  assert.notEqual(after.realtimeJwtSecret, after.storageJwtSecret);
  assert.equal(after.jwtSecret, SECRET, 'jwtSecret is kept: GoTrue requires it');
  assert.match(text, /jwtSecret: .*\n {2}jwtKeys: '\[.*\n {2}jwtJwks: '\{/, 'the pair beside jwtSecret, single-quoted');
  assert.match(text, /realtimeMetricsJwtSecret: .*\n {2}realtimeJwtSecret: "[0-9a-f]+"\n {2}storageJwtSecret: "[0-9a-f]+"\n/);
  assert.match(text, /^ {2}es256Signing: true$/m);
  assert.match(text, /^# Written by `npm run setup`\.$/m, 'comments are kept');
  assert.equal(notes.length, 4, notes.join('\n'));

  const again = completeValuesText(text);
  assert.equal(again.changed, false, again.notes.join('\n'));
  assert.equal(again.text, text);
});

test('a 1.7 site on ES256 loses the `oct` key and gains the two secrets, and keeps its pair and JWTs', () => {
  const pair = pairOf17();
  const before = valuesFile({ pair, sign: { signingKey: signingKeyFrom(pair.jwtKeys) } });
  const { text, changed, resigned } = completeValuesText(before);
  assert.ok(changed);
  const after = readSecrets(text);
  const was = readSecrets(before);
  assert.deepEqual(resigned, []);
  for (const key of ['anonKey', 'serviceRoleKey', 'ingestionKey', 'playbackKey', 'releaseCheckKey']) {
    assert.equal(after[key], was[key], key);
  }
  assert.ok(noOct(after.jwtKeys) && noOct(after.jwtJwks));
  assert.equal(signingKeyFrom(after.jwtKeys).kid, pair.kid, 'the same pair');
  assert.deepEqual(JSON.parse(after.jwtJwks).keys.map((k) => k.kid), [pair.kid]);
  assert.ok(after.realtimeJwtSecret && after.storageJwtSecret);
  assert.equal(completeValuesText(text).changed, false);
});

test('a complete file is left exactly as it was, CRLF line ends and all', () => {
  const pair = generateSigningKeys();
  const complete = valuesFile({
    pair, sign: { signingKey: signingKeyFrom(pair.jwtKeys) },
    extra: ['  realtimeJwtSecret: "r-secret"', '  storageJwtSecret: "s-secret"'],
  }).replace(/\n/g, '\r\n');
  const { text, changed, notes } = completeValuesText(complete);
  assert.equal(changed, false, notes.join('\n'));
  assert.equal(text, complete);

  const missing = complete.replace('  storageJwtSecret: "s-secret"\r\n', '');
  const completed = completeValuesText(missing);
  assert.ok(completed.changed);
  assert.ok(!/[^\r]\n/.test(completed.text), 'CRLF kept');
  assert.equal(readSecrets(completed.text).realtimeJwtSecret, 'r-secret', 'a secret already set is kept');
});

test('an HS256 JWT beside a pair is signed again with that pair, and a missing JWKS is made from it', () => {
  const pair = generateSigningKeys();
  const values = { jwtSecret: SECRET, jwtKeys: pair.jwtKeys, ...jwts({ secret: SECRET }), realtimeJwtSecret: 'r', storageJwtSecret: 's' };
  const { updates } = completeSigningSet(values);
  assert.deepEqual(JSON.parse(updates.jwtJwks), JSON.parse(pair.jwtJwks));
  assert.ok(signatureVerifies(updates.anonKey, { jwks: pair.jwtJwks }));
  assert.ok(!('realtimeJwtSecret' in updates));
});

test('a key set GoTrue would refuse, or a file with no secrets block, is refused and not rewritten', () => {
  assert.throws(() => completeSigningSet({ jwtKeys: '{"not":"a list"}' }), /JSON array/);
  assert.throws(() => completeSigningSet({ jwtKeys: JSON.stringify([oct]) }), /exactly one key/);
  assert.throws(() => completeValuesText('global:\n  scheme: https\n'), /no secrets: block/);
});

test('the release Secret is completed under its own key names', () => {
  const pair = pairOf17();
  const secret = {
    SUPABASE_JWT_KEYS: pair.jwtKeys, SUPABASE_JWT_JWKS: pair.jwtJwks, SUPABASE_ANON_KEY: jwts({ secret: SECRET }).anonKey,
  };
  const { updates } = completeSigningSet(valuesFromSecret(secret));
  const env = secretFromUpdates(updates);
  assert.deepEqual(Object.keys(env).sort(),
    ['REALTIME_JWT_SECRET', 'STORAGE_JWT_SECRET', 'SUPABASE_ANON_KEY', 'SUPABASE_JWT_JWKS', 'SUPABASE_JWT_KEYS']);
  assert.ok(noOct(env.SUPABASE_JWT_KEYS));
});

test('writeSecrets adds a key a file lacks beside its neighbour, at the block\'s indent', () => {
  const text = 'secrets:\n    ingestionKey: "i"\n    playbackKey: "p"\n    postgresPassword: "x"\nother: 1\n';
  assert.equal(writeSecrets(text, { releaseCheckKey: 'r' }),
    'secrets:\n    ingestionKey: "i"\n    playbackKey: "p"\n    releaseCheckKey: "r"\n    postgresPassword: "x"\nother: 1\n');
  assert.equal(writeSecrets(text, { storageJwtSecret: 's' }),
    'secrets:\n    ingestionKey: "i"\n    playbackKey: "p"\n    postgresPassword: "x"\n    storageJwtSecret: "s"\nother: 1\n');
});

test('since when a release signs ES256 is read from its Helm history', () => {
  const at = (h) => new Date(Date.UTC(2026, 9, 1, h)).toISOString();
  const history = [
    { revision: 1, updated: at(1), chart: 'aber-1.6.0' },
    { revision: 2, updated: at(2), chart: 'aber-1.7.0' },
    { revision: 3, updated: at(3), chart: 'aber-1.7.0' },
    { revision: 4, updated: at(4), chart: 'aber-1.8.0' },
  ];
  const on = (...revisions) => (r) => (revisions.includes(r) ? { supabaseAuth: { es256Signing: true } } : {});
  assert.deepEqual(es256SinceFrom(history, on(3)), { since: new Date(at(3)), exact: true });
  assert.deepEqual(es256SinceFrom(history, on()), { since: new Date(at(4)), exact: true }, '1.8.0 signs ES256 whatever its values say');
  assert.deepEqual(es256SinceFrom(history.slice(0, 3), on(2)), { since: null, exact: true }, 'switched off again');
  assert.deepEqual(es256SinceFrom(history.slice(1), on(2, 3)), { since: new Date(at(2)), exact: false }, 'older than Helm kept');
  assert.deepEqual(es256SinceFrom(history.slice(0, 1), on(1)), { since: new Date(at(1)), exact: true }, 'installed on it');
  assert.ok(chartSignsEs256('aber-1.8.0-ci.g1234abcd'));
  assert.ok(chartSignsEs256('aber-2.0.0'));
  assert.ok(!chartSignsEs256('aber-1.7.3'));
});

// -------------------------------------------------------------------------------------------------
// setup.mjs, run as the installer runs it
// -------------------------------------------------------------------------------------------------
function setup(out) {
  return spawnSync(process.execPath, [join(REPO, 'scripts', 'setup.mjs'), `--out=${out}`], { encoding: 'utf8', input: '' });
}

test('setup completes an existing values file, says what it added, and leaves a complete one alone', () => {
  const out = join(scratch, 'values-local.yaml');
  writeFileSync(out, valuesFile());
  const first = setup(out);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Completed .*keeping every value it held/);
  assert.match(first.stdout, /signed again ES256, claims unchanged/);
  assert.match(first.stdout, /This site signed tokens HS256 until now/);
  const text = readFileSync(out, 'utf8');
  assert.equal(completeValuesText(text).changed, false);

  const second = setup(out);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /holds every key this release needs — left untouched/);
  assert.equal(readFileSync(out, 'utf8'), text);
});

test('a new site\'s values hold the pair alone, the two secrets, and no es256Signing', () => {
  const out = join(scratch, 'new', 'values-local.yaml');
  const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'setup.mjs'), '--domain=aber.example.test', `--out=${out}`],
    { encoding: 'utf8', input: '' });
  assert.equal(r.status, 0, r.stderr);
  const text = readFileSync(out, 'utf8');
  const s = readSecrets(text);
  assert.ok(noOct(s.jwtKeys) && noOct(s.jwtJwks));
  assert.match(s.realtimeJwtSecret, /^[0-9a-f]{64}$/);
  assert.match(s.storageJwtSecret, /^[0-9a-f]{64}$/);
  for (const key of ['anonKey', 'serviceRoleKey', 'ingestionKey', 'playbackKey', 'releaseCheckKey']) {
    assert.ok(signatureVerifies(s[key], { jwks: s.jwtJwks }), key);
  }
  assert.doesNotMatch(text, /es256Signing/);
  assert.doesNotMatch(text, /^supabaseAuth:/m, 'no administrator, so no supabaseAuth map to null out the chart\'s');
  assert.equal(completeValuesText(text).changed, false);
});
