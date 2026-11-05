import { isAcknowledged } from './alertAcknowledgement'
import { cellUrl, deviceUrl, gatewayUrl } from '../routes'

/**
 * Suppression windows: a scheduled period on a device, a gateway or a cell during which its alerts
 * are recorded but kept quiet. The database decides (platform_alert_suppressing_window() and the
 * three writers, 0240); these say in advance what it will answer, so a drawer offers only what it
 * would accept.
 */

/** Who may schedule, change and end a window. Mirror check 53 holds it to the three writers. */
export const SUPPRESSION_WINDOW_ROLES = ['Administrator', 'Shopfloor_Manager']

/** The reason's limit, as `alert_suppression_windows_reason_valid` holds it (mirror check 54). */
export const SUPPRESSION_REASON_MAX = 200

export const maySuppress = (role) => SUPPRESSION_WINDOW_ROLES.includes(role)

/** Whether a window covers the alert now, as platform_alerts_active answered when it was read. */
export const isSuppressed = (alert) => Boolean(alert?.suppressed)

/**
 * The firing alerts the counter, the tab title and the favicon count: nobody has acknowledged them,
 * and no window keeps them quiet.
 */
export const countedAlerts = (alerts = []) => alerts.filter((a) => !isAcknowledged(a) && !isSuppressed(a))

/** A window's subject: `{ kind, id }`, kind one of device, gateway and cell. */
export function windowSubject(window) {
  if (window?.device_id) return { kind: 'device', id: window.device_id }
  if (window?.gateway_id) return { kind: 'gateway', id: window.gateway_id }
  return { kind: 'cell', id: window?.cell_id ?? null }
}

/** Where a message about a subject's window leads: that device, gateway or cell, its drawer open. */
export function subjectUrl(kind, id) {
  if (kind === 'gateway') return gatewayUrl(id)
  if (kind === 'cell') return cellUrl(id)
  return deviceUrl(id)
}

/** 'upcoming', 'current' or 'ended' at `now`, from the start up to but not including the end. */
export function windowState(window, now = Date.now()) {
  const starts = Date.parse(window?.starts_at)
  const ends = Date.parse(window?.ends_at)
  if (now >= ends) return 'ended'
  return now < starts ? 'upcoming' : 'current'
}

/**
 * The next moment the alerts' suppression can change with nothing written: the earliest end of a
 * window that keeps an alert quiet, or start of one still to come. An end already past (the
 * server's clock behind this one) counts as now, so the reader asks again shortly. Null when none.
 */
export function nextSuppressionChange(alerts = [], windowStarts = [], now = Date.now()) {
  const times = [
    ...alerts.filter(isSuppressed).map((a) => Date.parse(a.suppressed_until)),
    ...windowStarts.map((t) => Date.parse(t)).filter((t) => t > now),
  ].filter((t) => Number.isFinite(t))
  if (times.length === 0) return null
  return Math.max(Math.min(...times), now)
}
