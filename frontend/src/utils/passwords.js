import { supabase, SUPABASE_URL, SUPABASE_GATEWAY_KEY } from '../lib/supabaseClient'

/**
 * Change Password, for the signed-in person: the rules a new password meets, and the change itself.
 * Without a mail relay this is the only way a person changes their own password.
 */

/** The chart's rule for the first administrator's password. GoTrue's own minimum (6) is lower. */
export const MIN_PASSWORD_LENGTH = 12

/** Why the form cannot be sent yet, or null. */
export function newPasswordProblem(current, next, again) {
  if (!current) return 'Enter your current password.'
  if (next.length < MIN_PASSWORD_LENGTH) return `The new password needs at least ${MIN_PASSWORD_LENGTH} characters.`
  if (next === current) return 'The new password must be different from your current one.'
  if (next !== again) return 'The two copies of the new password do not match.'
  return null
}

/**
 * Whether `password` is the person's current one, by a password grant sent straight to GoTrue, not
 * through supabase-js: the session it opens is never stored, so the dashboard's own is not replaced.
 * GoTrue ends that session with the person's others when the password changes. Throws when GoTrue
 * refuses for another reason, such as a rate limit.
 */
async function isCurrentPassword(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_GATEWAY_KEY,
      'Content-Type': 'application/json',
      // The error shape supabase-js asks for, with `error_code`.
      'X-Supabase-Api-Version': '2024-01-01',
    },
    body: JSON.stringify({ email, password }),
  })
  let body = null
  try { body = await res.json() } catch { /* non-JSON body */ }
  if (res.ok) return true
  if (res.status === 400 && (!body?.error_code || body.error_code === 'invalid_credentials')) return false
  throw new Error(body?.msg || body?.message || `Your current password could not be checked (${res.status}).`)
}

/**
 * Checks the current password, then sets the new one (GoTrue's PUT /auth/v1/user). GoTrue keeps
 * this session and ends the person's others. Throws with the sentence to show.
 */
export async function changeOwnPassword(email, current, next) {
  if (!email) throw new Error('This account has no password to change.')
  if (!(await isCurrentPassword(email, current))) {
    throw new Error('Your current password is not right. Nothing was changed.')
  }
  const { error } = await supabase.auth.updateUser({ password: next })
  if (error) throw new Error(error.message || 'Your password was not changed.')
}
