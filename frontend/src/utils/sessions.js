/**
 * The words a list of sessions uses for a session: the Profile page's (`list_my_sessions()`, 0206)
 * and a person's drawer on People (`person_sessions()`, 0212). The browser and system for a
 * sign-in from a browser, the service for one a service started, the order the list is read in,
 * and the question End asks.
 */

import { formatDate, plural } from './format'

/** Browsers by the token their user agent carries. Order matters: Edge and Opera also say Chrome. */
const BROWSERS = [
  ['Edge', /\bEdg(?:e|A|iOS)?\//],
  ['Opera', /\bOPR\//],
  ['Samsung Internet', /\bSamsungBrowser\//],
  ['Firefox', /\b(?:Firefox|FxiOS)\//],
  ['Chrome', /\b(?:Chrome|CriOS)\//],
  ['Safari', /\bVersion\/[\d.]+ (?:Mobile\/\w+ )?Safari\//],
]

/** Systems the same way. iPhone's agent says "like Mac OS X", and Android's says Linux. */
const SYSTEMS = [
  ['Windows', /\bWindows\b/],
  ['Android', /\bAndroid\b/],
  ['iOS', /\b(?:iPhone|iPad|iPod)\b/],
  ['ChromeOS', /\bCrOS\b/],
  ['macOS', /\bMacintosh\b|\bMac OS X\b/],
  ['Linux', /\bLinux\b/],
]

/** Longest program name shown before it is cut short. */
const PROGRAM_NAME_MAX = 32

/**
 * A user agent in a few words: "Chrome on Windows", "Safari on iOS". A browser this does not know
 * is "A browser on Linux"; a program, such as a script, is "A program (Python-urllib)"; and an
 * empty agent is "Not recorded". Never the version: it changes with every update.
 */
export function describeUserAgent(userAgent) {
  const ua = typeof userAgent === 'string' ? userAgent.trim() : ''
  if (!ua) return 'Not recorded'
  const system = SYSTEMS.find(([, test]) => test.test(ua))?.[0]
  const browser = BROWSERS.find(([, test]) => test.test(ua))?.[0]
  if (browser) return system ? `${browser} on ${system}` : browser
  if (ua.startsWith('Mozilla/')) return system ? `A browser on ${system}` : 'A browser'
  const program = /^[A-Za-z][\w.+-]*/.exec(ua)?.[0]
  if (!program) return 'A program'
  return `A program (${program.length > PROGRAM_NAME_MAX ? `${program.slice(0, PROGRAM_NAME_MAX)}…` : program})`
}

/**
 * Short names the help uses where dropping the prefix is not enough, keyed on the client name 0002
 * seeds. The client names stay as they are: the consent page shows them.
 */
const SERVICE_SHORT_NAMES = new Map([['Aber Supabase Studio', 'Studio']])

/** A service's name as the help says it: "Aber Grafana" is "Grafana", "Aber Supabase Studio" is "Studio". */
export function serviceLabel(serviceName) {
  const name = String(serviceName ?? '').trim()
  return SERVICE_SHORT_NAMES.get(name) ?? (name.replace(/^Aber\s+/, '') || name)
}

/** What the Where column says for a session: its service, or its browser. */
export function sessionLabel(session) {
  return session?.service_name ? serviceLabel(session.service_name) : describeUserAgent(session?.user_agent)
}

const time = (ts) => {
  const t = new Date(ts ?? NaN).getTime()
  return Number.isNaN(t) ? -Infinity : t
}

/** The session in use first, then the most recently active, newest first. A new array. */
export function sortSessions(sessions) {
  return [...(sessions || [])].sort((a, b) =>
    (Number(!!b.is_current) - Number(!!a.is_current))
    || (time(b.last_active_at) - time(a.last_active_at))
    || String(a.id).localeCompare(String(b.id)))
}

/** How long ago, in words for a sentence: "5 minutes ago", "2 days ago", "on 25 Sept 2026". */
function agoInWords(ts, now) {
  const t = new Date(ts ?? NaN).getTime()
  if (Number.isNaN(t)) return null
  const seconds = Math.max(0, Math.round((now - t) / 1000))
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${plural(Math.floor(seconds / 60), 'minute')} ago`
  if (seconds < 86400) return `${plural(Math.floor(seconds / 3600), 'hour')} ago`
  const days = Math.floor(seconds / 86400)
  return days < 30 ? `${plural(days, 'day')} ago` : `on ${formatDate(t)}`
}

/**
 * The End dialog's question: the session as the Where column names it, when it was last active,
 * and what has to sign in again, a browser, a program or a service. Reads sessionLabel()'s words:
 * "A program (…)", "A browser on …" and "Not recorded" are describeUserAgent()'s.
 *
 * `person` is the name of whose session it is, for an Administrator ending another person's:
 * "End Owain Operator's session in Chrome on Windows…". Without it the session is the reader's.
 */
export function endSessionQuestion(session, now = Date.now(), person = null) {
  const label = sessionLabel(session)
  const when = agoInWords(session?.last_active_at, now)
  const lastActive = when ? `, last active ${when}` : ''
  const whose = person ? `${person}'s session` : 'the session'
  if (session?.service_name) {
    return `End ${whose} in ${label}${lastActive}? ${label} has to sign ${person ? 'them' : 'you'} in again.`
  }
  if (label === 'Not recorded') {
    return `End ${whose} with no browser recorded${lastActive}? Whatever used it has to sign in again.`
  }
  const lowered = label.replace(/^A /, 'a ')
  if (label.startsWith('A program')) {
    return `End ${whose} of ${lowered}${lastActive}? That program has to sign in again.`
  }
  return `End ${whose} in ${lowered}${lastActive}? That browser has to sign in again.`
}
