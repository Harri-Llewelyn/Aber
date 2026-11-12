/**
 * History's Alerts tab: its address, its rows as alert_occurrences() (0243) returns them, the
 * subject each is about, and the words its cells say. Pure, so each rule is unit-tested;
 * frontend/README.md, "History's Alerts tab".
 */
import { encodeList } from '../hooks/useUrlState'
import { alertPage } from '../routes'
import { deviceIds, gatewaySparkplugId } from './sparkplugId'
import { windowToQuery } from './timeWindow'
import { DEFAULT_HISTORY_WINDOW, durationWords } from './history'
import { personShown } from './displayName'

/** The tab's id among HISTORY_TABS, and its path. */
export const ALERTS_TAB = 'alerts'
export const ALERTS_PATH = '/history/alerts'

/**
 * The Alerts tab's address: the window, when it is not the page's default, and the devices and
 * gateways chosen (`asset`), by Sparkplug id, which every device and gateway alert carries.
 */
export function alertsAddress(win, { assets = [] } = {}) {
  const query = new URLSearchParams()
  for (const [k, v] of Object.entries(windowToQuery(win, DEFAULT_HISTORY_WINDOW))) if (v) query.set(k, v)
  if (assets.length) query.set('asset', encodeList(assets))
  // A list reads with its commas, as useUrlList writes it.
  const q = query.toString().replace(/%2C/gi, ',')
  return `${ALERTS_PATH}${q ? `?${q}` : ''}`
}

/**
 * One row of alert_occurrences() as the tab draws it: the occurrence's own columns, then
 * `ended_at`, `replaced`, and `firing`, which is still firing: a firing occurrence nothing replaced.
 */
export function occurrenceRow({ occurrence, ended_at: endedAt = null, replaced = false } = {}) {
  const row = occurrence || {}
  return { ...row, ended_at: endedAt, replaced: Boolean(replaced), firing: row.status === 'firing' && !replaced }
}

/**
 * Whether an occurrence overlaps [startMs, endMs), alert_occurrences()' rule: it started before
 * the window ends, and it ended after the window starts or has not ended. So one that ended at the
 * window's start, or started at its end, does not.
 */
export function overlapsWindow(row, startMs, endMs) {
  const from = Date.parse(row.starts_at)
  const to = row.ended_at ? Date.parse(row.ended_at) : Infinity
  return from < endMs && to > startMs
}

/**
 * How long alerts are kept, in days, where `alerts.retention_days` cannot be read: 0002's seeded
 * default, which mirror check 55 holds this to.
 */
export const ALERT_RETENTION_DAYS = 90

/**
 * Why a window may list fewer alerts than fired: it starts more than `days` before `now`, and the
 * nightly prune removes a resolved alert after that many. Null when it does not.
 */
export function retentionWords(startMs, now, days) {
  const n = Number(days)
  if (!(n > 0) || startMs >= now - n * 24 * 60 * 60 * 1000) return null
  return `Alerts are kept for ${n} ${n === 1 ? 'day' : 'days'}, so none older is listed.`
}

/** How long an occurrence fired, in milliseconds: to its end, or to `now` while it fires. */
export function occurrenceMs(row, now = Date.now()) {
  const to = row.ended_at ? Date.parse(row.ended_at) : now
  return Math.max(0, to - Date.parse(row.starts_at))
}

/** Its length in words, "35 min", with "so far" while it fires. */
export function lengthText(row, now = Date.now()) {
  const words = durationWords(occurrenceMs(row, now))
  return row.firing ? `${words} so far` : words
}

/** Severities in the order they rank, and each one's words and badge tone. */
export const SEVERITIES = [
  { value: 'critical', label: 'Critical', tone: 'danger' },
  { value: 'warning', label: 'Warning', tone: 'warning' },
  { value: 'info', label: 'Info', tone: 'info' },
]
export const severityOf = (value) => SEVERITIES.find(s => s.value === value) ?? { value, label: String(value ?? ''), tone: 'neutral' }

/**
 * Who acknowledged an occurrence, as the dashboard names them: their display name when the read
 * gave one (`acknowledged_by_name`, from display_names_for(), 0290), else the email their token
 * carried, else "someone". Where it is drawn, PersonName puts the email in a tooltip.
 */
export const acknowledgerName = (row) => personShown(row?.acknowledged_by_name, row?.acknowledged_by_email, 'someone').text

/** The rows with `acknowledged_by_name` from a person id -> name map, for the rows an acknowledger is on. */
export const withAcknowledgerNames = (rows, names) => rows.map(r => (
  r.acknowledged_by ? { ...r, acknowledged_by_name: names.get(r.acknowledged_by) ?? null } : r
))

/**
 * Lookups from a Sparkplug id to the device or gateway it names, for the subject column, each
 * device under its issued id.
 */
export function subjectIndex(devices = [], gateways = []) {
  return {
    devices: new Map(devices.map(d => [deviceIds(d).issued, d])),
    gateways: new Map(gateways.map(g => [g.sparkplug_id || gatewaySparkplugId(g.gateway_id), g])),
  }
}

/**
 * What an occurrence is about, as its Subject cell draws it: `{ kind, name, sparkplugId, page }`.
 * A device or gateway is named as its page names it, or by its Sparkplug id when no row has it any
 * more; a platform alert is Platform-wide and a machine identity's is Machine identity. `page` is
 * the page alertPage() opens for one that has a page of its own, as the alert counter's row does.
 */
export function alertSubject(row, index) {
  const kind = row.entity_type || 'device'
  if (kind === 'device' || kind === 'gateway') {
    const held = (kind === 'device' ? index?.devices : index?.gateways)?.get(row.sparkplug_id)
    const name = kind === 'device' ? held?.asset_name : held?.gateway_name
    return { kind, name: name || row.sparkplug_id || '', sparkplugId: row.sparkplug_id || null, known: Boolean(held), page: null }
  }
  return {
    kind,
    name: kind === 'service_identity' ? 'Machine identity' : 'Platform-wide',
    sparkplugId: null,
    known: false,
    page: alertPage(row),
  }
}

/** Whether an occurrence matches what was typed: its name, summary, subject, or who acknowledged it. */
export function occurrenceMatches(row, subject, text) {
  const needle = String(text ?? '').trim().toLowerCase()
  if (!needle) return true
  return [row.alert_name, row.summary, subject?.name, subject?.sparkplugId, row.acknowledged_by_name, row.acknowledged_by_email, row.acknowledgement_note]
    .some(v => String(v ?? '').toLowerCase().includes(needle))
}

/**
 * The Asset filter's options: every device, then every gateway, each valued by its Sparkplug id and
 * named as its page names it.
 */
export function assetOptions(devices = [], gateways = []) {
  const byName = (a, b) => String(a.label).localeCompare(String(b.label))
  return [
    ...devices.map(d => ({ value: deviceIds(d).issued, label: d.asset_name || deviceIds(d).issued, group: 'Devices' })).sort(byName),
    ...gateways.map(g => ({ value: g.sparkplug_id || gatewaySparkplugId(g.gateway_id), label: g.gateway_name || g.sparkplug_id, group: 'Gateways' })).sort(byName),
  ].filter(o => o.value)
}

/**
 * The tab's sortable columns, over rows carrying their `subject`. With none chosen, the rows keep
 * the read's order, newest first. Ended sorts a firing occurrence as now, so it is the latest.
 */
export const ALERT_SORT = {
  alert: { type: 'text', value: r => r.alert_name },
  severity: { type: 'rank', value: r => SEVERITIES.findIndex(s => s.value === r.severity) },
  subject: { type: 'text', value: r => r.subject?.name },
  started: { type: 'time', value: r => r.starts_at },
  ended: { type: 'time', value: r => r.ended_at ?? new Date(r.now ?? Date.now()).toISOString() },
  length: { type: 'number', value: r => occurrenceMs(r, r.now) },
  acknowledged: { type: 'text', value: r => (r.acknowledged_at ? acknowledgerName(r) : null) },
}
