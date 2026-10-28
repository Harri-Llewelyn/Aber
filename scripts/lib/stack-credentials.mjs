/**
 * Where a host-side script gets the stack's credentials: the environment first, then the
 * release's own Secret in the cluster. The Secret's keys are the environment names the
 * containers read (SUPABASE_JWT_SECRET, MQTT_DYNSEC_ADMIN_PASSWORD, ...), so one name serves both.
 *
 * The cluster is the source of truth. A values file on disk may be the one the release was
 * installed from or may not, and an externally managed Secret has no file at all; the Secret is
 * what the pods run with, so it is what a script acting on the stack must use.
 *
 *   import { stackCredentials } from './lib/stack-credentials.mjs';
 *   const { SUPABASE_JWT_SECRET } = stackCredentials(['SUPABASE_JWT_SECRET']);
 *
 * ABER_NAMESPACE and ABER_RELEASE select the release (default aber, aber).
 */
import { spawnSync } from 'node:child_process';
import { signingKeyFrom } from './service-jwt.mjs';

export const NAMESPACE = process.env.ABER_NAMESPACE || 'aber';
export const RELEASE = process.env.ABER_RELEASE || 'aber';

let cached = null;

/** Every key in the release Secret, decoded. Empty when the cluster is unreachable. */
export function releaseSecret() {
  if (cached) return cached;
  const r = spawnSync('kubectl', ['-n', NAMESPACE, 'get', 'secret', `${RELEASE}-secrets`, '-o', 'json'], {
    encoding: 'utf8',
  });
  cached = {};
  if (r.status === 0) {
    const data = JSON.parse(r.stdout).data || {};
    for (const [k, v] of Object.entries(data)) cached[k] = Buffer.from(v, 'base64').toString('utf8');
  }
  return cached;
}

/**
 * The named credentials, each from the environment when set there, otherwise from the Secret.
 * Missing ones are returned as '' so the caller can name what it lacks.
 */
export function stackCredentials(names) {
  const out = {};
  let secret = null;
  for (const name of names) {
    if (process.env[name]) { out[name] = process.env[name]; continue; }
    secret ??= releaseSecret();
    out[name] = secret[name] ?? '';
  }
  return out;
}

/**
 * The ES256 signing key, when the stack verifies ES256: SUPABASE_JWT_KEYS holds it AND GoTrue
 * publishes its kid at /auth/v1/.well-known/jwks.json, which it does only with
 * supabaseAuth.es256Signing on, the release that also gives every verifier the JWKS. Otherwise
 * null, with why: an HS256 token verifies on either path through 1.7, and an ES256 one only on
 * the second, so a script signs ES256 only on evidence.
 *
 * @returns {Promise<{key: object|null, why: string}>}
 */
export async function liveSigningKey({ jwtKeys, supabaseUrl, apikey }) {
  if (!jwtKeys) return { key: null, why: 'the release Secret holds no SUPABASE_JWT_KEYS' };
  const key = signingKeyFrom(jwtKeys);
  const url = `${supabaseUrl.replace(/\/+$/, '')}/auth/v1/.well-known/jwks.json`;
  try {
    const res = await fetch(url, { headers: apikey ? { apikey } : {} });
    if (!res.ok) return { key: null, why: `${url} answered ${res.status}` };
    const { keys = [] } = await res.json();
    return keys.some((k) => k.kid === key.kid)
      ? { key, why: `GoTrue publishes kid ${key.kid}` }
      : { key: null, why: `GoTrue does not publish kid ${key.kid}: supabaseAuth.es256Signing is off on this release` };
  } catch (err) {
    return { key: null, why: `${url} could not be reached (${err.message})` };
  }
}

/** The sentence a script prints when a credential is missing from both places. */
export function missingCredentialAdvice(name) {
  return `${name} is not set and the release Secret ${RELEASE}-secrets in namespace ${NAMESPACE} ` +
    'does not carry it (or the cluster is unreachable: is the kube context right?). Export it, or ' +
    'point ABER_NAMESPACE/ABER_RELEASE at the release.';
}
