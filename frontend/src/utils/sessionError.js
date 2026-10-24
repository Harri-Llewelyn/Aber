import { isAuthSessionMissingError } from '@supabase/supabase-js';
import { supabase, SUPABASE_URL, SUPABASE_GATEWAY_KEY } from '../lib/supabaseClient';

/**
 * Detecting and recovering from a session the auth server no longer recognises. `getSession()` only
 * reads localStorage and PostgREST only checks the JWT signature, so a token whose `auth.sessions`
 * row has gone still reads data. Edge Functions call `auth.getUser()` and fail with "Session from
 * session_id claim in JWT does not exist"; this module recognises that answer, asks the auth
 * server itself, and turns a rejected session into a sign-out.
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
 * True when an edge function's failed answer says the session no longer exists: a 401 whose JSON
 * body names it. The functions also answer 401 when no token was sent at all, which this leaves
 * alone.
 *
 * @param {number|undefined} status The answer's HTTP status.
 *
 * @param {unknown} body The parsed body: `{ error, details? }` from our functions, `{ msg }` from
 * the runtime's router.
 */
export function isSessionRefusal(status, body) {
  if (status !== 401 || !body || typeof body !== 'object') return false;
  return isInvalidSessionError({ message: body.error || body.msg || body.message, details: body.details });
}

/** How long a refusal waits for the auth server's own word before it is left as it was. */
const REFUSAL_CHECK_TIMEOUT_MS = 10000;

let pendingRefusalCheck = null;

/**
 * Whether the auth server itself refuses the session supabase-js holds: a 401 or 403 from its
 * `/user`. False for a live session, no session, an unreachable server, a 5xx, or no answer within
 * REFUSAL_CHECK_TIMEOUT_MS. Callers at the same time share one request.
 *
 * A plain fetch, not getUser(): auth-js drops a refused session and announces SIGNED_OUT before
 * getUser() returns, which would swap the page for the sign-in screen with no word of why.
 *
 * @returns {Promise<boolean>}
 */
export function authServerRefusesSession() {
  if (!pendingRefusalCheck) {
    pendingRefusalCheck = askUserEndpoint().finally(() => { pendingRefusalCheck = null; });
  }
  return pendingRefusalCheck;
}

async function askUserEndpoint() {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return false;
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_GATEWAY_KEY, Authorization: `Bearer ${session.access_token}` },
      signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(REFUSAL_CHECK_TIMEOUT_MS) : undefined
    });
    return res.status === 401 || res.status === 403;
  } catch {
    return false;
  }
}

/**
 * True only when the auth server actively rejected the session. A network failure is not a
 * rejection: supabase-js reports an unreachable server as a fetch error with no HTTP status, so an
 * explicit 401/403 or an unmistakable message is required. GoTrue's 403 session_not_found reaches
 * here as AuthSessionMissingError, which carries status 400.
 */
export function isSessionRejected(error) {
  if (!error) return false;
  if (isAuthSessionMissingError(error)) return true;
  if (error.status === 401 || error.status === 403) return true;
  if (error.name === 'AuthRetryableFetchError') return false;
  return isInvalidSessionError(error);
}

/**
 * Ask the auth server whether the session supabase-js holds is still live. getUser() deletes a
 * session the server refused, whatever auth-js calls the error, so `current` is what supabase-js
 * still holds afterwards. An unreachable server is never a refusal, even when it left `current`
 * empty because an expired token could not be refreshed through it.
 *
 * @returns {Promise<{ error: unknown, current: object|null, rejected: boolean }>}
 */
export async function askAuthServer() {
  const { error } = await supabase.auth.getUser();
  const { data: { session: current } } = await supabase.auth.getSession();
  const unreachable = error?.name === 'AuthRetryableFetchError';
  return { error, current, rejected: !!error && (isSessionRejected(error) || (!current && !unreachable)) };
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
