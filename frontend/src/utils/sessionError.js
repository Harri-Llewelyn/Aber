import { supabase } from '../lib/supabaseClient';

/**
 * Detecting and recovering from a session that the auth server no longer recognises.
 *
 * `supabase.auth.getSession()` only reads localStorage -- it never asks GoTrue whether
 * the session is still real. PostgREST likewise verifies nothing but the JWT signature.
 * So a token whose `auth.sessions` row has gone (the database volume was recreated, an
 * administrator revoked the session, the JWT secret rotated) still reads data happily,
 * and the user looks signed in.
 *
 * Edge Functions are the odd one out: they call `auth.getUser()`, which validates the
 * session server-side and fails with "Session from session_id claim in JWT does not
 * exist". Without this module that surfaces as an opaque error on an otherwise
 * working-looking dashboard.
 */

const INVALID_SESSION_SIGNATURES = [
  'session from session_id claim in jwt does not exist',
  'session not found',
  'invalid user token',
  'jwt expired',
  'invalid claim',
  'user from sub claim in jwt does not exist',
  'bad_jwt'
];

/** True when `error` (an Error, a string, or a Supabase error object) means "sign in again". */
export function isInvalidSessionError(error) {
  if (!error) return false;
  const text = (typeof error === 'string' ? error : `${error.message || ''} ${error.details || ''}`)
    .toLowerCase();
  return INVALID_SESSION_SIGNATURES.some(signature => text.includes(signature));
}

/**
 * True only when the auth server actively *rejected* the session.
 *
 * A network failure must not be treated as a rejection: signing someone out because
 * their wifi dropped for a second would be worse than the stale session this guards
 * against. supabase-js reports unreachable-server as a retryable fetch error with no
 * HTTP status, so an explicit 401/403 (or an unmistakable message) is required.
 */
export function isSessionRejected(error) {
  if (!error) return false;
  if (error.status === 401 || error.status === 403) return true;
  if (error.name === 'AuthRetryableFetchError') return false;
  return isInvalidSessionError(error);
}

/**
 * Clear a session the server has already rejected and return the message to show.
 *
 * Signs out with `scope: 'local'` on purpose: the server-side session is already gone,
 * so asking it to revoke would just fail again. This drops the stale tokens from
 * storage, which makes onAuthStateChange fire SIGNED_OUT and return the app to the
 * login screen instead of leaving it half-authenticated.
 */
export async function clearInvalidSession() {
  try {
    await supabase.auth.signOut({ scope: 'local' });
  } catch (err) {
    console.warn('[auth] local sign-out after an invalid session failed:', err?.message);
  }
  return 'Your session is no longer valid on the server. Please sign in again.';
}

/**
 * Map an error from a privileged call to a message for the user, signing out first when
 * the session itself is the problem.
 *
 * @param {unknown} error - Error or message from the failed call.
 * @param {string} fallback - Message to show when the session is fine and something else broke.
 * @returns {Promise<string>}
 */
export async function describeAuthFailure(error, fallback) {
  if (isInvalidSessionError(error)) return clearInvalidSession();
  return typeof error === 'string' ? error : (error?.message || fallback);
}
