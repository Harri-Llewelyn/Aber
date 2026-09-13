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
 * ACS_CYMRU_NAMESPACE and ACS_CYMRU_RELEASE select the release (default acs-cymru, acs-cymru).
 */
import { spawnSync } from 'node:child_process';

export const NAMESPACE = process.env.ACS_CYMRU_NAMESPACE || 'acs-cymru';
export const RELEASE = process.env.ACS_CYMRU_RELEASE || 'acs-cymru';

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

/** The sentence a script prints when a credential is missing from both places. */
export function missingCredentialAdvice(name) {
  return `${name} is not set and the release Secret ${RELEASE}-secrets in namespace ${NAMESPACE} ` +
    'does not carry it (or the cluster is unreachable: is the kube context right?). Export it, or ' +
    'point ACS_CYMRU_NAMESPACE/ACS_CYMRU_RELEASE at the release.';
}
