/**
 * The one place the dashboard turns a timestamp, a duration, a size or a count into text, so the
 * same value reads the same on every page. Each formatter returns a stable fallback for a missing
 * or invalid input, never "Invalid Date" or "NaN"; the fallback is named in each doc below.
 */

/** Shown wherever a value is absent or unreadable. */
export const NO_VALUE = '—'

const LOCALE = 'en-GB'

/** A Date for a timestamp (ISO string, epoch ms or Date), or null when it is not one. */
function toDate(ts) {
  if (ts === null || ts === undefined || ts === '') return null
  const d = ts instanceof Date ? ts : new Date(ts)
  return Number.isNaN(d.getTime()) ? null : d
}

/** "29 Sept 2026, 14:30" in the viewer's time zone, no seconds. Fallback "—". */
export function formatDateTime(ts) {
  const d = toDate(ts)
  if (!d) return NO_VALUE
  const date = d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' })
  const time = d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', hour12: false })
  return `${date}, ${time}`
}

/** "29 Sept 2026" in the viewer's time zone. Fallback "—". */
export function formatDate(ts) {
  const d = toDate(ts)
  if (!d) return NO_VALUE
  return d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' })
}

/**
 * How long ago, compactly: "12s ago", "5m ago", "3h ago", "4d ago", then `formatDate` from 30 days.
 * A timestamp after `now` reads as "0s ago". Fallback "—".
 */
export function formatRelative(ts, now = Date.now()) {
  const d = toDate(ts)
  if (!d) return NO_VALUE
  const seconds = Math.max(0, Math.round((now - d.getTime()) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  const days = Math.floor(seconds / 86400)
  if (days < 30) return `${days}d ago`
  return formatDate(d)
}

/**
 * A length of time in seconds: "45s", "12m", "3h 5m" or "2d 4h". Fallback "—" for a value that is
 * not a non-negative number.
 */
export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || seconds === '') return NO_VALUE
  const s = Number(seconds)
  if (!Number.isFinite(s) || s < 0) return NO_VALUE
  if (s < 60) return `${Math.floor(s)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
}

const BYTE_UNITS = ['KiB', 'MiB', 'GiB', 'TiB']

/**
 * A size in binary units: "512 B", "1.0 KiB", "12.4 MiB", "1.0 GiB". One decimal from KiB up.
 * Fallback "—" for null, undefined or a value that is not a non-negative number; zero is "0 B".
 */
export function formatBytes(n) {
  if (n === null || n === undefined || n === '') return NO_VALUE
  const bytes = Number(n)
  if (!Number.isFinite(bytes) || bytes < 0) return NO_VALUE
  if (bytes < 1024) return `${bytes} B`
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${BYTE_UNITS[unit]}`
}

/**
 * The count with its noun: plural(1, 'cell') is "1 cell", plural(3, 'cell') is "3 cells". Pass the
 * plural for irregular words: plural(2, 'entity', 'entities'). A count that is not a number
 * reads as "0 <plural>".
 */
export function plural(n, word, pluralWord = `${word}s`) {
  const count = Number.isFinite(Number(n)) ? Number(n) : 0
  return `${count} ${count === 1 ? word : pluralWord}`
}
