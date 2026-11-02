// =================================================================================================
// scripts/lib/service-jwt.mjs
//
// WHAT IS WORTH ASSERTING HERE is not that ECDSA works -- node:crypto's does -- but the decisions
// layered on top of it, each of which is a thing that could silently regress into the state issue
// #101 describes:
//
//   * the ceiling is REFUSED rather than clamped, so nobody is surprised by an expiry;
//   * it mirrors service_token_max_days() in the migration chain, checked against its own text;
//   * a service key carries a `jti` and an infrastructure key does not;
//   * the two kinds have different lifetimes, deliberately.
// =================================================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  mintJwt, decodeJwt, expiryOf, daysUntilExpiry, generateSigningKeys, signingKeyFrom, signatureVerifies,
  signJwt, resignJwt, algorithmOf, publicJwksFrom, SERVICE_KEY_MAX_DAYS, SERVICE_KEY_DEFAULT_DAYS, INFRASTRUCTURE_KEY_DAYS,
} from './service-jwt.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SECRET = 'test-secret-not-a-real-one';
const SET = generateSigningKeys();
const KEY = signingKeyFrom(SET.jwtKeys);
const PRINCIPAL = 'b0000000-0000-4000-8000-000000000002';

test('the ceiling mirrors service_token_max_days() in the migration that owns it', () => {
  // KEPT IN STEP BY TEST RATHER THAN BY HOPE. Two numbers that must agree and live in different
  // languages are exactly the pair that drifts -- and drifting UPWARD here re-creates #101, while
  // drifting downward makes every key this repo mints unrecordable.
  //
  // FOUND BY WHAT IT DECLARES, NOT BY WHAT IT IS CALLED. Searching for a file NAMED after the
  // function breaks on the next squash, and naming the baseline instead only moves the problem to
  // the one after it. Reading every migration and taking the one that declares the function is
  // stable across any renumbering, and asserts something worth asserting on its own: that the
  // chain declares this function exactly once.
  const dir = join(REPO, 'supabase', 'migrations');
  const DECLARATION =
    /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.service_token_max_days\(\)[\s\S]*?AS\s*\$\$\s*SELECT\s+(\d+)\s*\$\$/i;

  const declaring = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => ({ file: f, sql: readFileSync(join(dir, f), 'utf8') }))
    .filter(({ sql }) => DECLARATION.test(sql));

  assert.ok(declaring.length > 0, 'no migration declares service_token_max_days()');
  assert.equal(
    declaring.length, 1,
    `service_token_max_days() is declared in ${declaring.length} migrations ` +
    `(${declaring.map((d) => d.file).join(', ')}); the last one applied wins, which is not a thing ` +
    'to leave to file order'
  );

  const { file, sql } = declaring[0];

  // Matches the declaration as the chain actually writes it -- a one-line SQL function,
  // `AS $$ SELECT 90 $$`. Asserted to have matched at all, so that a rewrite of the function into
  // another form fails here loudly instead of quietly comparing against undefined.
  const declared = sql.match(DECLARATION)?.[1];
  assert.ok(declared, `could not read the ceiling out of ${file}; has the function been rewritten?`);
  assert.equal(
    Number(declared), SERVICE_KEY_MAX_DAYS,
    `service_token_max_days() is ${declared} in ${file} but SERVICE_KEY_MAX_DAYS is ${SERVICE_KEY_MAX_DAYS}`
  );
});

test('a service key carries the principal as sub', () => {
  const { token } = mintJwt({ role: 'authenticated', signingKey: KEY, subject: PRINCIPAL });
  const claims = decodeJwt(token);
  assert.equal(claims.sub, PRINCIPAL);
  assert.equal(claims.role, 'authenticated');
  assert.equal(claims.iss, 'supabase');
});

test('a service key carries a jti, because 0043 records an issuance against one', () => {
  // #101's second finding: two keys minted for one principal were indistinguishable, so no manual
  // record of "which key is on which host" could be reconciled with anything.
  const a = mintJwt({ role: 'authenticated', signingKey: KEY, subject: PRINCIPAL });
  const b = mintJwt({ role: 'authenticated', signingKey: KEY, subject: PRINCIPAL });
  assert.ok(a.jti, 'a service key must carry a jti');
  assert.notEqual(a.jti, b.jti, 'two mints for one principal must be distinguishable');
  assert.equal(decodeJwt(a.token).jti, a.jti);
});

test('an infrastructure key carries no sub and therefore no jti', () => {
  // The anon key is not anybody: PostgREST switches to the named database role and RLS never asks
  // who is calling. A jti there would identify nothing, since it can never be recorded.
  const { token, jti } = mintJwt({ role: 'anon', signingKey: KEY });
  const claims = decodeJwt(token);
  assert.equal(jti, null);
  assert.equal(claims.jti, undefined);
  assert.equal(claims.sub, undefined);
  assert.equal(claims.role, 'anon');
});

test('the two kinds default to different lifetimes', () => {
  const now = Date.UTC(2026, 0, 1);
  const service = mintJwt({ role: 'authenticated', signingKey: KEY, subject: PRINCIPAL, now });
  const infra = mintJwt({ role: 'anon', signingKey: KEY, now });
  assert.equal(Math.round(daysUntilExpiry(service.token, now)), SERVICE_KEY_DEFAULT_DAYS);
  assert.equal(Math.round(daysUntilExpiry(infra.token, now)), INFRASTRUCTURE_KEY_DAYS);
});

test('asking for more than the ceiling is refused, not clamped', () => {
  // REFUSED RATHER THAN CLAMPED, matching mint-api-token.mjs. Silently issuing something shorter
  // than asked for is how an operator ends up surprised by an expiry -- which is the failure the
  // ceiling exists to prevent, so satisfying it by that route would be self-defeating.
  assert.throws(
    () => mintJwt({ role: 'authenticated', signingKey: KEY, subject: PRINCIPAL, days: SERVICE_KEY_MAX_DAYS + 1 }),
    /exceeds the 90-day ceiling/
  );
});

test('the ceiling does not apply to an infrastructure key', () => {
  // They are the JWTs the gateway hands its upstreams -- exactly these two literal strings -- so bounding
  // them needs a story for re-issuing them to every client at once. Different change; not this one.
  assert.doesNotThrow(() => mintJwt({ role: 'anon', signingKey: KEY, days: INFRASTRUCTURE_KEY_DAYS }));
});

test('exp and iat are whole seconds, which is what a JWT consumer reads', () => {
  const now = 1_767_225_600_123; // deliberately not a whole second
  const { token } = mintJwt({ role: 'authenticated', signingKey: KEY, subject: PRINCIPAL, now });
  const claims = decodeJwt(token);
  assert.ok(Number.isInteger(claims.iat), 'iat must be an integer');
  assert.ok(Number.isInteger(claims.exp), 'exp must be an integer');
  assert.ok(claims.exp > claims.iat);
});

test('a token signed by another pair does not verify, so a re-sign under a new key is not silently valid', () => {
  const other = generateSigningKeys({ kid: SET.kid });
  const minted = mintJwt({ role: 'anon', signingKey: signingKeyFrom(other.jwtKeys) });
  assert.ok(signatureVerifies(minted.token, { jwks: other.jwtJwks }));
  assert.ok(!signatureVerifies(minted.token, { jwks: SET.jwtJwks }));
});

test('decodeJwt returns null for anything that is not a JWT, rather than throwing', () => {
  // --check reads whatever the release Secret holds, which may be empty, truncated or a placeholder. Throwing
  // there would turn "this key looks wrong" into a stack trace.
  assert.equal(decodeJwt(''), null);
  assert.equal(decodeJwt('not.a.jwt'), null);
  assert.equal(decodeJwt(undefined), null);
  assert.equal(decodeJwt('only-one-part'), null);
});

test('expiry helpers report a lapsed key as negative rather than zero', () => {
  const now = Date.UTC(2026, 0, 1);
  const { token } = mintJwt({ role: 'authenticated', signingKey: KEY, subject: PRINCIPAL, days: 10, now });
  const later = now + 15 * 86_400_000;
  assert.ok(daysUntilExpiry(token, later) < 0, 'an expired key must report negative days');
  assert.ok(expiryOf(token) instanceof Date);
});

const headerOf = (token) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));

test('the key set carries one signing key and EC keys alone, and the JWKS no private part', () => {
  // GoTrue refuses GOTRUE_JWT_KEYS with no key, or more than one, whose key_ops hold `sign`. An
  // `oct` key in either half would verify a token signed with its secret, which 1.8.0 ended.
  const keys = JSON.parse(SET.jwtKeys);
  const jwks = JSON.parse(SET.jwtJwks);
  assert.deepEqual(keys.filter((k) => k.key_ops?.includes('sign')).map((k) => k.kid), [SET.kid]);
  assert.ok([...keys, ...jwks.keys].every((k) => k.kty === 'EC'), 'EC keys only');
  assert.ok(jwks.keys.every((k) => !('d' in k)), 'the JWKS holds no private key');
  assert.deepEqual(jwks.keys[0].key_ops, ['verify']);
  assert.equal(jwks.keys[0].x, keys[0].x);
  assert.equal(signingKeyFrom(SET.jwtKeys).kid, SET.kid);
  assert.deepEqual(JSON.parse(publicJwksFrom(SET.jwtKeys)), jwks, 'the JWKS is the set\'s public half');
});

test('a token is ES256 with its kid, and verifies against the JWKS alone', () => {
  const minted = mintJwt({ role: 'authenticated', signingKey: KEY, subject: PRINCIPAL });
  assert.equal(minted.alg, 'ES256');
  assert.deepEqual(headerOf(minted.token), { alg: 'ES256', typ: 'JWT', kid: SET.kid });
  assert.ok(signatureVerifies(minted.token, { jwks: SET.jwtJwks }));
  assert.ok(!signatureVerifies(minted.token, { secret: SECRET }), 'a secret cannot verify an ES256 token');
  assert.ok(!signatureVerifies(minted.token, { jwks: generateSigningKeys({ kid: SET.kid }).jwtJwks }),
    'another pair under the same kid does not verify it');
});

test('no mint signs HS256, and an HS256 token verifies against its own secret and nothing else', () => {
  assert.throws(() => mintJwt({ role: 'anon', secret: SECRET }), /signing key is required/);
  const { token, alg } = signJwt({ role: 'anon' }, { secret: SECRET });
  assert.equal(alg, 'HS256');
  assert.deepEqual(headerOf(token), { alg: 'HS256', typ: 'JWT' });
  assert.ok(signatureVerifies(token, { secret: SECRET }));
  assert.ok(!signatureVerifies(token, { secret: 'another-secret' }));
  assert.ok(!signatureVerifies(token, { jwks: SET.jwtJwks }), 'the JWKS verifies no HS256 token');
});

test('a token signed again keeps its claims, its jti among them, and becomes ES256', () => {
  const claims = { iss: 'supabase', role: 'authenticated', sub: PRINCIPAL, jti: 'a-recorded-jti', iat: 1, exp: 2 };
  const hs = signJwt(claims, { secret: SECRET }).token;
  const es = resignJwt(hs, KEY);
  assert.equal(algorithmOf(hs), 'HS256');
  assert.equal(algorithmOf(es), 'ES256');
  assert.deepEqual(decodeJwt(es), claims);
  assert.ok(signatureVerifies(es, { jwks: SET.jwtJwks }));
  assert.throws(() => resignJwt('not-a-jwt', KEY), /not a JWT/);
  assert.equal(algorithmOf('not-a-jwt'), '?');
});

test('a key set GoTrue would refuse is refused here too', () => {
  const [key] = JSON.parse(SET.jwtKeys);
  assert.throws(() => signingKeyFrom('not json'), /not JSON/);
  assert.throws(() => signingKeyFrom('{}'), /JSON array/);
  assert.throws(() => signingKeyFrom([{ kty: 'oct', k: 'c2VjcmV0', alg: 'HS256' }]), /exactly one key/);
  assert.throws(() => signingKeyFrom([key, { ...key, kid: 'second' }]), /exactly one key/);
  assert.throws(() => signingKeyFrom([{ ...key, kid: undefined }]), /a kid/);
  assert.throws(() => mintJwt({ role: 'anon' }), /signing key is required/);
});

test('a token with no exp reports null, which --check treats as the worst case', () => {
  // A key that never expires can never be withdrawn. Reporting "no information" as "fine" is the
  // reading this must not permit.
  const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url');
  const payload = Buffer.from('{"role":"anon"}').toString('base64url');
  assert.equal(daysUntilExpiry(`${header}.${payload}.sig`), null);
  assert.equal(expiryOf(`${header}.${payload}.sig`), null);
});
