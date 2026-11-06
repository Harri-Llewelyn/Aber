/**
 * What System › Logs offers, as the service-logs function accepts it (logs.ts): the ranges, the
 * spans, the levels and the most lines one read returns. Mirror check 40 holds these to the
 * function's and to 0225's, which refuses a read it cannot record.
 */
import { formatDate } from './format'
import { rollingWindow, windowBounds } from './timeWindow'

const MINUTE = 60 * 1000

/** The rolling ranges, keyed as the Audit Trail keys its own, in the time control's shape. */
export const LOG_RANGES = [
  { value: '15m', label: 'Last 15 minutes', ms: 15 * MINUTE },
  { value: '1h', label: 'Last 1 hour', ms: 60 * MINUTE },
  { value: '6h', label: 'Last 6 hours', ms: 6 * 60 * MINUTE },
  { value: '24h', label: 'Last 24 hours', ms: 24 * 60 * MINUTE },
  { value: '7d', label: 'Last 7 days', ms: 7 * 24 * 60 * MINUTE },
]
export const DEFAULT_LOG_RANGE = '1h'

/** The window the tab opens on, Last 1 hour. */
export const DEFAULT_LOG_WINDOW = rollingWindow(DEFAULT_LOG_RANGE, LOG_RANGES)

/** The spans the time control offers: a month or a year is wider than the 7 days a read covers. */
export const LOG_SPANS = ['day', 'week']

/**
 * The window as service-logs takes it, worked out at fetch time: a rolling window as its `range`,
 * which the function measures back from now, and any other as its `from` and `to` instants, so
 * a refresh asks for the same window. A custom window missing an end sends the other alone, and
 * the function refuses it with the reason.
 */
export function logWindowParams(win, now = Date.now()) {
  if (win.kind === 'rolling') return { range: win.range }
  const { start, end } = windowBounds(win, now)
  return { from: start ? start.toISOString() : '', to: end ? end.toISOString() : '' }
}

/**
 * Which list of services a window's parameters read: a fixed window's own, between its ends, and
 * for every rolling range the same one, the last 7 days, so the list does not shrink at 15 minutes.
 */
export function logListKey(params) {
  return params.range ? 'last-7-days' : `${params.from}/${params.to}`
}

/** `any`, or a level a JSON line names in its `level` field. */
export const LOG_LEVELS = [
  { value: 'any', label: 'Any level' },
  { value: 'error', label: 'Errors' },
  { value: 'warning', label: 'Warnings' },
  { value: 'info', label: 'Info' },
  { value: 'debug', label: 'Debug' },
]

/** The most lines one read returns, which the tab always asks for. */
export const LOG_LINES_MAX = 500

/** The longest filter the function takes, in characters. */
export const LOG_FILTER_MAX = 200

/** The tab's auto-refresh choices, in seconds; 0 is off. */
export const LOG_REFRESH_EVERY = [
  { value: 0, label: 'Off' },
  { value: 10, label: '10 s' },
  { value: 30, label: '30 s' },
  { value: 60, label: '1 min' },
]

/** The service a read opens on: ingestion, where most faults show first, else the first listed. */
export function defaultLogService(services) {
  if (!services?.length) return ''
  return services.includes('ingestion') ? 'ingestion' : services[0]
}

const pad = (n, width = 2) => String(n).padStart(width, '0')

/**
 * "3 Nov 2026, 14:30:05.123" in the viewer's time zone: the dashboard's date with the seconds and
 * milliseconds a log needs, since many lines share a minute. Fallback "—", as format.js's.
 */
export function formatLogTime(ts) {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return formatDate(null)
  return `${formatDate(d)}, ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}
