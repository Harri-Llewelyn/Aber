/**
 * What the sign-in card shows when a password-reset request fails.
 *
 * GoTrue answers a recovery request with a 500 "Error sending recovery email" when no SMTP
 * relay is configured, which is the state every fresh install is in. That is an administrator's
 * problem, not the user's, and the message says so instead of echoing the server.
 */
export function describeResetError(err) {
  const msg = err?.message || ''
  if (err?.status === 500 || /smtp|sending|mail/i.test(msg)) {
    return 'This platform cannot send email, so no reset link was sent. Ask an administrator to reset your password.'
  }
  return msg || 'The reset link could not be sent.'
}
