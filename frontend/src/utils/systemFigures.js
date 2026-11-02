/**
 * The System page's figures: what each one is, how it reads, and where its history is.
 *
 * Five come from `directory_figures`, which `refresh_directory_figures()` writes every minute from
 * Prometheus (0223); a NULL value there is a figure the last answer did not carry. Two are read
 * live: `directory_gateway_counts()` and `directory_devices_reporting()`. Anything without a value
 * reads "not observed", never a last value and never a zero.
 */

/**
 * The `directory_figures` keys, as 0223 seeds them. Mirror check 39 (scripts/check-mirror-drift.mjs)
 * holds this list to the seed.
 */
export const FIGURE_KEYS = Object.freeze([
  'messages_per_second',
  'readings_per_second',
  'messages_refused_last_hour',
  'messages_shed_last_hour',
  'messages_missed_last_hour',
  'ingestion_broker_link',
  'ingestion_historian_link',
])

/**
 * The Grafana panel that holds each tile's history, by dashboard uid and panel id. A tile not here
 * has no panel to open. Check 176 (scripts/check-docs-drift.mjs) holds every pair to the
 * dashboards in grafana/provisioning/dashboards/.
 */
export const FIGURE_PANELS = Object.freeze({
  readings: { uid: 'aber-platform', panel: 2 },
  lost: { uid: 'aber-platform', panel: 17 },
  gateways: { uid: 'aber-gateway-health', panel: 2 },
  devices: { uid: 'aber-platform', panel: 5 },
})

/** How often the tiles read again. The Prometheus figures change once a minute. */
export const FIGURES_POLL_MS = 15000

/** What a figure with no value says, in words. */
export const NOT_OBSERVED = 'not observed'

const LOCALE = 'en-GB'

/** A finite number, or null: NULL, a string and NaN are not figures. */
export function figureValue(row) {
  const v = row?.value
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** `rows` from `directory_figures`, keyed; a key with no row is absent. */
export function figuresByKey(rows) {
  const out = {}
  for (const row of rows || []) if (row && typeof row.key === 'string') out[row.key] = row
  return out
}

/** A rate per second: "0.03", "2.5", "12.3", "1,204". */
export function formatRate(v) {
  const digits = v >= 100 ? 0 : v >= 10 ? 1 : 2
  return v.toLocaleString(LOCALE, { maximumFractionDigits: digits })
}

/** A count: `increase()` extrapolates, so 6.98 is read as 7. */
export function formatCount(v) {
  return Math.round(v).toLocaleString(LOCALE)
}

/**
 * The three parts of Messages lost, each a count or null. Never summed: a message the broker shed
 * also shows as a missed sequence number.
 */
export function messagesLost(figures) {
  return [
    { label: 'refused', value: figureValue(figures.messages_refused_last_hour) },
    { label: 'shed', value: figureValue(figures.messages_shed_last_hour) },
    { label: 'missed', value: figureValue(figures.messages_missed_last_hour) },
  ]
}

/**
 * Ingestion's two links, or null unless both were observed: they come from one scrape, so one
 * without the other is not an answer.
 */
export function ingestionLinks(figures) {
  const broker = figureValue(figures.ingestion_broker_link)
  const historian = figureValue(figures.ingestion_historian_link)
  if (broker === null || historian === null) return null
  return { broker: broker >= 1, historian: historian >= 1 }
}

/** "DDATA 12/s · NBIRTH 0.25/s", by rate, from the split the collector keeps; null without one. */
export function messageTypeSplit(row) {
  const split = row?.detail?.by_msg_type
  if (!split || typeof split !== 'object') return null
  const parts = Object.entries(split)
    .filter(([, v]) => typeof v === 'number' && Number.isFinite(v))
    .sort(([a, x], [b, y]) => (y - x) || a.localeCompare(b))
    .map(([type, v]) => `${type} ${formatRate(v)}/s`)
  return parts.length ? parts.join(' · ') : null
}

/** The refusal reason with the most messages in the hour, as `{ reason, count }`, or null. */
export function largestRefusal(row) {
  const detail = row?.detail
  if (!detail || typeof detail.largest_reason !== 'string' || typeof detail.largest !== 'number') return null
  return { reason: detail.largest_reason, count: detail.largest }
}
