import { supabase } from '../lib/supabaseClient';

/**
 * Detecting and recovering from a session the auth server no longer recognises. `getSession()` only
 * reads localStorage and PostgREST only checks the JWT signature, so a token whose `auth.sessions`
 * row has gone still reads data. Edge Functions call `auth.getUser()` and fail with "Session from
 * session_id claim in JWT does not exist"; this module turns that into a sign-out.
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
 * True only when the auth server actively rejected the session. A network failure is not a
 * rejection: supabase-js reports an unreachable server as a fetch error with no HTTP status, so an
 * explicit 401/403 or an unmistakable message is required.
 */
export function isSessionRejected(error) {
  if (!error) return false;
  if (error.status === 401 || error.status === 403) return true;
  if (error.name === 'AuthRetryableFetchError') return false;
  return isInvalidSessionError(error);
}

/**
 * Clear a session the server has already rejected and return the message to show. Signs out with
 * `scope: 'local'` because the server-side session is already gone; dropping the stored tokens
 * makes onAuthStateChange fire SIGNED_OUT.
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
 * Map an error from a privileged call to a message for the user, signing out first when the session
 * itself is the problem.
 *
 * @param {unknown} error Error or message from the failed call.
 *
 * @param {string} fallback Message to show when the session is fine and something else broke.
 *
 * @returns {Promise<string>}
 */
export async function describeAuthFailure(error, fallback) {
  if (isInvalidSessionError(error)) return clearInvalidSession();
  return typeof error === 'string' ? error : (error?.message || fallback);
}
