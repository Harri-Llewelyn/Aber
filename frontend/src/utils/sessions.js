/**
 * The words the Profile page's Sessions list uses for a session (`list_my_sessions()`, 0206): the
 * browser and system for a sign-in from a browser, the service for one a service started, and the
 * order the list is read in.
 */

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

/** A service's name without the site's prefix: "Aber Grafana" is "Grafana". */
export function serviceLabel(serviceName) {
  const name = String(serviceName ?? '').trim()
  return name.replace(/^Aber\s+/, '') || name
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
