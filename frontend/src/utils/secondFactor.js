/**
 * Second factors (TOTP) as the dashboard reads GoTrue's answers: whether the sign-in still asks for
 * a code, what a person's factors are called, and the QR code as an image the CSP admits.
 */

/** Sign-in methods whose assurance another identity provider gave, as GoTrue names them in `amr`. */
export const FEDERATED_METHODS = ['oauth', 'sso/saml']

/** A code from an authenticator app: six digits. Spaces a person types between groups are dropped. */
export const CODE_LENGTH = 6
export const normaliseCode = (code) => String(code ?? '').replace(/\s/g, '')
export const isCode = (code) => /^\d{6}$/.test(normaliseCode(code))

/**
 * Whether the dashboard asks for a code before it opens, from getAuthenticatorAssuranceLevel()'s
 * answer: the session is aal1 and the person has a verified factor (next level aal2), and they did
 * not sign in through another identity provider, which is never asked twice.
 */
export function secondFactorDue(level) {
  if (!level || level.currentLevel !== 'aal1' || level.nextLevel !== 'aal2') return false
  return !(level.currentAuthenticationMethods || []).some(m => FEDERATED_METHODS.includes(m?.method))
}

/** The factors a sign-in can use: verified TOTP ones, oldest first, as GoTrue lists them. */
export const verifiedFactors = (factors) =>
  (factors || []).filter(f => f?.status === 'verified' && f?.factor_type === 'totp')

/** A factor's name for the eye. GoTrue allows an empty one. */
export const factorLabel = (factor) => factor?.friendly_name?.trim() || 'Authenticator app'

/** The first of "Authenticator app", "Authenticator app 2", ... that no factor of theirs is called. */
export function nextFactorName(factors) {
  const taken = new Set((factors || []).map(f => (f?.friendly_name || '').trim().toLowerCase()))
  for (let n = 1; ; n++) {
    const name = n === 1 ? 'Authenticator app' : `Authenticator app ${n}`
    if (!taken.has(name.toLowerCase())) return name
  }
}

/** The secret in groups of four, as an authenticator app's manual entry shows it. */
export const groupedSecret = (secret) => (String(secret || '').match(/.{1,4}/g) || []).join(' ')

/**
 * The QR code as an image source. auth-js prefixes GoTrue's SVG with `data:image/svg+xml;utf-8,`
 * and leaves it unencoded, where a `#` would end the URL; the SVG is percent-encoded instead.
 */
const RAW_SVG = 'data:image/svg+xml;utf-8,'
export function qrImageSource(qrCode) {
  const value = String(qrCode || '')
  if (value.startsWith(RAW_SVG)) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(value.slice(RAW_SVG.length))}`
  }
  return value.startsWith('data:image/') ? value : null
}

/** GoTrue's refusals of a second-factor request, as a person can act on them. */
const REFUSALS = {
  mfa_verification_failed: 'That code is not right. Enter the code your app shows now.',
  mfa_challenge_expired: 'That took too long. Enter the code your app shows now.',
  mfa_factor_name_conflict: 'You already have a second factor with that name. Choose another.',
  too_many_enrolled_mfa_factors: 'You have as many second factors as the sign-in service allows. Remove one first.',
  insufficient_aal: 'Enter a code from your authenticator app first.',
  mfa_factor_not_found: 'That second factor is no longer on your account.',
  mfa_totp_enroll_not_enabled: 'This site does not allow authenticator apps. Ask whoever runs it.',
  mfa_totp_verify_not_enabled: 'This site does not allow authenticator apps. Ask whoever runs it.',
  over_request_rate_limit: 'Too many tries. Wait a minute, then try again.',
}

export function describeFactorError(error, fallback) {
  return REFUSALS[error?.code] || error?.message || fallback
}

/** An Error carrying that sentence, with GoTrue's `code` kept for a caller that tells refusals apart. */
export function factorError(error, fallback) {
  const failure = new Error(describeFactorError(error, fallback))
  failure.code = error?.code
  return failure
}
