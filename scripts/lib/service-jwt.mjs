// =================================================================================================
// Minting and inspecting the stack's own HS256 JWTs.
//
// EXTRACTED SO THAT SETUP AND ROTATION CANNOT DRIFT (issue #101). `scripts/setup.mjs` signs these
// keys once, at install; `scripts/rotate-service-keys.mjs` signs the same keys again, on a live
// stack. Two copies of the claim set would diverge on the first change to either -- and the claims
// are not cosmetic: PostgREST switches database role on `role`, RLS resolves `auth.uid()` from
// `sub`, and `record_service_token_issued()` (0043) keys its audit row on `jti`.
//
// -------------------------------------------------------------------------------------------------
// TWO KINDS OF KEY, AND THE DIFFERENCE IS WHETHER ANYONE IS BEHIND THEM
//
// An INFRASTRUCTURE key carries `role` and no `sub`. The anon and service-role keys are these: they
// are not anybody, PostgREST switches to the named database role, and RLS never asks who is
// calling. They are the stack's API keys -- the gateway hands upstreams exactly these two literal strings as
// `apikey` -- so they cannot be shortened without a story for re-issuing them to every client at
// once, which is a different change from this one and is deliberately not attempted here.
//
// A SERVICE key carries `role: authenticated` AND a `sub` naming a principal seeded by a migration.
// It goes through RLS like a signed-in user and can therefore be narrow: the ingestion daemon's key
// writes nothing directly, only through the SECURITY DEFINER gates in 0047, each of which checks
// that the caller IS Service_Ingestor. These are the keys this module bounds.
//
// -------------------------------------------------------------------------------------------------
// WHY THE BOUND EXISTS, GIVEN THE ARGUMENT THAT USED TO SIT IN setup.mjs
//
// That argument was that a short expiry "would silently take the stack off the air on a date nobody
// wrote down, and there is no refresh path for them". The second half was true and is what this
// change removes -- there is a refresh path now, and it is one command. The first half survives the
// ten years unchanged: a key that expires in 2036 still goes off the air on a date nobody wrote
// down. Length does not fix that, visibility does, which is why `--check` exists.
//
// What the bound buys is the only revocation available. There is none otherwise: PostgREST checks
// the signature, not a session table, so withdrawing a leaked key means rotating
// SUPABASE_JWT_SECRET -- which invalidates every token in the stack, anon and service-role
// included. A 90-day key that leaks is valid for at most 90 days. A ten-year key that leaks is
// valid until 2036.
//
// 90 IS NOT AN INVENTION. It mirrors `service_token_max_days()` (0043), which
// `record_service_token_issued()` and `scripts/mint-mcp-token.mjs` both already enforce -- so the
// state this replaces was a rule the platform applied to operators and exempted itself from.
// =================================================================================================
import { createHmac, randomUUID } from 'node:crypto';

/**
 * THE CEILING, MIRRORED FROM `service_token_max_days()` IN 0043.
 *
 * Kept in step by test, not by hope: scripts/lib/service-jwt.test.mjs asserts this number against
 * the migration's own text, so raising one and not the other fails rather than drifts.
 */
export const SERVICE_KEY_MAX_DAYS = 90;

/** The default when nothing is passed. Same as the ceiling: there is no reason to ask for less. */
export const SERVICE_KEY_DEFAULT_DAYS = 90;

/**
 * The anon and service-role keys' lifetime, unchanged at ten years and deliberately so -- see the
 * header. Named rather than inlined so that reading it as an oversight is harder than reading it
 * as a decision.
 */
export const INFRASTRUCTURE_KEY_DAYS = 3650;

/**
 * How close to expiry `--check` starts complaining. Two weeks is chosen to be longer than any
 * plausible "we will do it next sprint": the warning has to arrive while there is still room to
 * schedule the restart, not on the morning ingestion stops.
 */
export const EXPIRY_WARN_DAYS = 14;

const b64url = (input) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Sign a Supabase-shaped HS256 JWT.
 *
 * @param {object}  opts
 * @param {string}  opts.role     `anon`, `service_role` or `authenticated`.
 * @param {string}  opts.secret   SUPABASE_JWT_SECRET.
 * @param {string} [opts.subject] Principal uuid. Its presence is what makes this a SERVICE key.
 * @param {number} [opts.days]    Lifetime. Defaults to SERVICE_KEY_DEFAULT_DAYS when a subject is
 *                                given, INFRASTRUCTURE_KEY_DAYS when one is not.
 * @param {number} [opts.now]     Epoch ms, injectable so the tests are not clock-dependent.
 * @returns {{token: string, jti: string|null, issuedAt: Date, expiresAt: Date, days: number}}
 */
export function mintJwt({ role, secret, subject = null, days = null, now = Date.now() }) {
  if (!role) throw new Error('mintJwt: role is required');
  if (!secret) throw new Error('mintJwt: secret is required');

  const ttlDays = days ?? (subject ? SERVICE_KEY_DEFAULT_DAYS : INFRASTRUCTURE_KEY_DAYS);
  if (!Number.isFinite(ttlDays) || ttlDays <= 0) {
    throw new Error(`mintJwt: days must be a positive number (got ${days})`);
  }

  // REFUSED RATHER THAN CLAMPED, matching mint-mcp-token.mjs: silently issuing something shorter
  // than asked for is how an operator ends up surprised by an expiry, and this ceiling exists
  // precisely to prevent that class of surprise.
  if (subject && ttlDays > SERVICE_KEY_MAX_DAYS) {
    throw new Error(
      `mintJwt: ${ttlDays} days exceeds the ${SERVICE_KEY_MAX_DAYS}-day ceiling for a service key. `
      + 'That ceiling is service_token_max_days() (0043), which record_service_token_issued() also '
      + 'enforces -- a longer key could not be recorded in the credential inventory, and could not '
      + 'be withdrawn short of rotating SUPABASE_JWT_SECRET.'
    );
  }

  const issuedAt = Math.floor(now / 1000);
  const expiresAt = issuedAt + Math.round(ttlDays * 24 * 60 * 60);

  // A `jti` ONLY WHERE THERE IS A PRINCIPAL TO ATTRIBUTE IT TO, which is the claim's whole purpose:
  // 0043 records an issuance AGAINST a principal and keys it on this. Two keys minted for one
  // principal are otherwise indistinguishable -- issue #101's second finding -- so a manual note of
  // "which key is on which host" could never be reconciled with anything. The anon and service-role
  // keys have no principal and can never be recorded, so one there would identify nothing.
  const jti = subject ? randomUUID() : null;

  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: 'supabase',
    role,
    ...(subject ? { sub: subject } : {}),
    ...(jti ? { jti } : {}),
    iat: issuedAt,
    exp: expiresAt,
  }));
  const signature = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  return {
    token: `${header}.${payload}.${signature}`,
    jti,
    issuedAt: new Date(issuedAt * 1000),
    expiresAt: new Date(expiresAt * 1000),
    days: ttlDays,
  };
}

/**
 * The claims of a token, without verifying its signature.
 *
 * DELIBERATELY DOES NOT VERIFY, and every caller here is reading a key it already holds out of the
 * release Secret -- the question is "when does this expire", not "is this genuine". A verifying
 * variant would need the secret, which would make `--check` require one to answer a question the
 * payload states in clear.
 *
 * @returns {object|null} null for anything that is not a well-formed JWT.
 */
export function decodeJwt(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** When a token expires, or null if it does not say. */
export function expiryOf(token) {
  const exp = decodeJwt(token)?.exp;
  return typeof exp === 'number' ? new Date(exp * 1000) : null;
}

/**
 * Days until a token expires -- negative once it has.
 *
 * Fractional on purpose: a key with eleven hours left should not report "0 days", which reads as
 * "no information" rather than "today".
 */
export function daysUntilExpiry(token, now = Date.now()) {
  const expiry = expiryOf(token);
  return expiry === null ? null : (expiry.getTime() - now) / 86_400_000;
}
