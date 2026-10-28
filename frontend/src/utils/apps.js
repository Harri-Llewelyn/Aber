/**
 * The words the dashboard uses for an app that signs people in with Aber (a GoTrue OAuth client,
 * `list_apps()`, 0217) and for a person's approval of one: Access Control's Apps tab, and the
 * Profile page's Apps you have allowed.
 */

import { plural } from './format'
import { serviceLabel } from './sessions'

/** An app's name as the dashboard says it: "Aber Grafana" is "Grafana", as the Sessions list says. */
export function appLabel(name) {
  const trimmed = String(name ?? '').trim()
  return trimmed ? serviceLabel(trimmed) : 'An unnamed app'
}

/**
 * How an app came to be registered: one of Aber's own (0002 seeds them on every boot), added by
 * hand through the sign-in service's admin API, or registered by itself. `{ label, detail }`.
 */
export function appRegistration(app) {
  if (app?.part_of_stack) {
    return {
      label: 'Part of Aber',
      detail: 'Aber registers it each time it starts, so it cannot be removed here.',
    }
  }
  if (app?.registration_type === 'dynamic') {
    return {
      label: 'Registered itself',
      detail: 'It registered itself through dynamic registration, which Aber now keeps turned off.',
    }
  }
  return {
    label: 'Added by hand',
    detail: "Added through the sign-in service's admin API, which needs the secret key.",
  }
}

/** The OAuth client type in a word, and what it means. */
export function clientTypeLabel(type) {
  if (type === 'confidential') return { label: 'Confidential', detail: 'It holds a secret, so it runs on a server.' }
  if (type === 'public') return { label: 'Public', detail: 'It holds no secret, as a desktop or browser app cannot keep one.' }
  return { label: type || 'Unknown', detail: null }
}

/** The scopes an approval covers, as the consent page shows them: "openid email profile". */
export function scopesText(scopes) {
  return (scopes || []).join(' ') || 'openid'
}

/** What a scope lets the app read, for the column's tip. */
export const SCOPES_TIP = 'What the app may read: openid is who you are, email your address, profile your name and picture.'

/**
 * The question Revoke asks, for the person's own approval or, with `person`, for another person's
 * on the Apps tab.
 */
export function revokeQuestion(appName, person = null) {
  const app = appLabel(appName)
  if (person) {
    return `${app} can no longer sign in as ${person}. Their sessions in ${app} end now, and ${app} asks them to allow it again next time they use it.`
  }
  return `${app} can no longer sign in as you. Your sessions in ${app} end now, and ${app} asks you to allow it again next time you use it.`
}

/** The question Remove App asks: what ends with it. */
export function removeQuestion(app) {
  const name = appLabel(app?.client_name)
  const people = app?.people_allowing || 0
  const approvals = people === 0
    ? 'Nobody allows it at the moment.'
    : `The approvals of ${plural(people, 'person', 'people')} end, and so does every session it holds.`
  return `${name} can no longer sign anyone in to Aber. ${approvals} To use it again, register it again through the sign-in service.`
}
