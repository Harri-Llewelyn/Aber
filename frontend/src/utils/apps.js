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
 * How an app came to be registered: one of Aber's own (0002 seeds them on every boot), added by an
 * Administrator (Register App, or the sign-in service's admin API), or registered by itself.
 * `{ label, detail }`.
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
    label: 'Added by an Administrator',
    detail: "An Administrator registered it with Register App, or through the sign-in service's admin API.",
  }
}

/** What an app that is not Aber's own may reach, for its drawer: who the person is, and nothing else. */
export const OUTSIDE_APP_REACH = {
  label: 'What it may reach',
  value: 'Sign-in only',
  help: 'It learns who the person is. Its token reaches no data and changes nothing in Aber.',
}

/** The longest app name, and the most redirect addresses, register_app() takes (0260). Mirror check 75. */
export const APP_NAME_MAX = 80
export const APP_REDIRECT_MAX = 10

// Unicode's control characters, which register_app() refuses in a name.
// eslint-disable-next-line no-control-regex
const NAME_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f]/

/** Why register_app() would refuse this name, in a sentence, or null. Spaces off both ends are not counted. */
export function appNameProblem(name) {
  const trimmed = String(name ?? '').replace(/^ +| +$/g, '')
  if (!trimmed) return null
  if ([...trimmed].length > APP_NAME_MAX) return `An app's name is ${APP_NAME_MAX} characters at most.`
  if (NAME_FORBIDDEN.test(trimmed)) return 'An app\'s name cannot contain a control character, such as a line break or a tab.'
  return null
}

/**
 * The site's own domain, as site_domain() reads it (0260) from the API's public address: its host
 * with the first label dropped when it has three or more, so `https://api.plant.example` is
 * `plant.example`. Null for an IP address or a name with no dot, which have no domain.
 */
export function siteDomainOf(apiUrl) {
  const host = /^https?:\/\/([A-Za-z0-9.-]+)(?::[0-9]+)?(?:[/?#]|$)/.exec(String(apiUrl ?? ''))?.[1]?.toLowerCase()
  if (!host || /^[0-9.]+$/.test(host) || !host.includes('.')) return null
  const labels = host.split('.')
  return labels.length >= 3 ? host.slice(host.indexOf('.') + 1) : host
}

/**
 * Why an app may not ask to be sent back to this address, in words that follow the address, or
 * null. The rule app_redirect_problem() applies (0260), which test-harness/fixtures/
 * app-redirect-addresses.json holds both to. https goes anywhere. Plain http goes only to the
 * site's own network: localhost and any .localhost name, loopback and private IPv4 addresses, ::1,
 * and the site's domain with everything under it. No fragment, wildcard, comma, user name, space or
 * backslash, and no other scheme.
 */
export function redirectAddressProblem(uri, siteDomain = null) {
  const domain = String(siteDomain ?? '').toLowerCase() || null
  if (uri == null || uri === '') return 'is empty'
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(uri)) return 'has a space or a control character'
  if (uri.length > 2048) return 'is longer than 2048 characters'
  if (uri.includes(',')) return 'has a comma, which the sign-in service reads as the end of one address'
  if (uri.includes('*')) return 'has a wildcard: give each address in full'
  if (uri.includes('#')) return 'has a fragment (#), which a redirect address may not'
  if (uri.includes('\\')) return 'has a backslash'

  const scheme = /^(https?):\/\//.exec(uri)?.[1]
  if (!scheme) return "must start with https://, or with http:// for an app on this site's own network"
  const authority = /^https?:\/\/([^/?#]*)/.exec(uri)[1]
  if (authority === '') return 'has no host after the scheme'
  if (authority.includes('@')) return 'has a user name or password in it'

  let host
  let port
  if (authority.startsWith('[')) {
    host = /^\[([0-9A-Fa-f:.]+)\](?::[0-9]{1,5})?$/.exec(authority)?.[1]
    port = /^\[[0-9A-Fa-f:.]+\]:([0-9]{1,5})$/.exec(authority)?.[1]
  } else {
    host = /^([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?::[0-9]{1,5})?$/.exec(authority)?.[1]
    port = /^[^:]+:([0-9]{1,5})$/.exec(authority)?.[1]
  }
  host = host?.toLowerCase()
  if (!host || host.includes('..')) return 'has a host that is not a name or an address'
  if (port != null && (Number(port) < 1 || Number(port) > 65535)) return 'has a port outside 1 to 65535'
  if (scheme === 'https') return null

  // Plain http: the site's own network alone.
  let local
  if (/^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(host)) {
    const [a, b, c, d] = host.split('.').map(Number)
    if (a > 255 || b > 255 || c > 255 || d > 255) return 'has a host that is not a name or an address'
    local = a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  } else {
    local = host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1' || host.endsWith('.localhost')
      || (domain !== null && (host === domain || host.endsWith(`.${domain}`)))
  }
  if (!local) {
    return `is plain http, which is allowed only on this site's own network: localhost, a private address${
      domain ? `, or a name under ${domain}` : ''}. Use https for any other address`
  }
  return null
}

/** The addresses typed one to a line: spaces off each end, empty lines dropped. */
export function parseRedirectAddresses(text) {
  return String(text ?? '').split(/\r?\n/).map(line => line.replace(/^ +| +$/g, '')).filter(Boolean)
}

/**
 * The first problem with the addresses typed, as a sentence that names the address, or null. None
 * typed is not a problem here: the dialog says so above its buttons.
 */
export function redirectAddressesProblem(text, siteDomain = null) {
  const uris = parseRedirectAddresses(text)
  if (uris.length > APP_REDIRECT_MAX) return `Give ${APP_REDIRECT_MAX} addresses at most.`
  for (const [n, uri] of uris.entries()) {
    const problem = redirectAddressProblem(uri, siteDomain)
    if (problem) return `${uri} ${problem}.`
    if (uris.indexOf(uri) !== n) return `${uri} is given twice.`
  }
  return null
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
  return `${name} can no longer sign anyone in to Aber. ${approvals} To use it again, register it again.`
}
