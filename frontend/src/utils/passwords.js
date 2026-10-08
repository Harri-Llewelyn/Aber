import { supabase } from '../lib/supabaseClient'

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
 * GoTrue's refusals of a password change, by error code, as the dialog's own sentences. The two
 * current_password codes share one message from GoTrue, so the code is what tells them apart.
 */
const REFUSALS = {
  current_password_required: 'Enter your current password.',
  // GoTrue's Go constant is ErrorCodeCurrentPasswordMismatch; the code it sends is this one.
  current_password_invalid: 'Your current password is not right. Nothing was changed.',
  same_password: 'The new password must be different from your current one.',
}

/**
 * Sets the new password in one PUT /auth/v1/user carrying the current one, which GoTrue checks
 * (GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD). GoTrue keeps this session and ends
 * the person's others. Throws with the sentence to show.
 */
export async function changeOwnPassword(email, current, next) {
  if (!email) throw new Error('This account has no password to change.')
  const { error } = await supabase.auth.updateUser({ password: next, current_password: current })
  if (error) throw new Error(REFUSALS[error.code] || error.message || 'Your password was not changed.')
}
