/**
 * What System › Logs offers, as the service-logs function accepts it (logs.ts): the ranges, the
 * levels and the most lines one read returns. Mirror check 40 holds these to the function's and to
 * 0225's, which refuses a read it cannot record.
 */
import { formatDate } from './format'

/** The rolling ranges, keyed as the Audit Trail keys its own. */
export const LOG_RANGES = [
  { value: '15m', label: 'Last 15 minutes' },
  { value: '1h', label: 'Last 1 hour' },
  { value: '6h', label: 'Last 6 hours' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
]
export const DEFAULT_LOG_RANGE = '1h'

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
  { value: 0, label: 'Refresh by hand' },
  { value: 10, label: 'Every 10 seconds' },
  { value: 30, label: 'Every 30 seconds' },
  { value: 60, label: 'Every minute' },
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
