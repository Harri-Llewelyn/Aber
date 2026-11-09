/**
 * The Notifications settings and the delivery log, as the database states them (0247, 0248, 0262,
 * 0263). The webhook's allowed hosts are edited in the webhook's dialog, beside its address, and the
 * roles email goes to in the email dialog, so the Settings table leaves them out, as it leaves out
 * the Cold Storage and Backups destinations.
 */

/** The category the Settings page draws its own panel for. */
export const NOTIFICATIONS_CATEGORY = 'Notifications'

export const ALLOWED_HOSTS_KEY = 'notifications.webhook_allowed_hosts'
export const MIN_SEVERITY_KEY = 'notifications.webhook_min_severity'
export const REMINDER_HOURS_KEY = 'notifications.reminder_hours'
export const EMAIL_MIN_SEVERITY_KEY = 'notifications.email_min_severity'
export const EMAIL_ROLES_KEY = 'notifications.email_roles'

/** Edited by the webhook's dialog, not by a row of the table. */
export const WEBHOOK_DIALOG_KEYS = [ALLOWED_HOSTS_KEY]
/** Edited by the email dialog, not by a row of the table: a list of roles, ticked. */
export const EMAIL_DIALOG_KEYS = [EMAIL_ROLES_KEY]

/** notification_setting_guard()'s set, lowest first; mirror check 58 holds the two together. */
export const SEVERITIES = [
  { value: 'info', label: 'Info and above' },
  { value: 'warning', label: 'Warning and above' },
  { value: 'critical', label: 'Critical only' }
]

/** A string setting with a closed set is a choice, not a text field. */
export const SETTING_OPTIONS = { [MIN_SEVERITY_KEY]: SEVERITIES, [EMAIL_MIN_SEVERITY_KEY]: SEVERITIES }

/** Each channel as the log names it; mirror check 76 holds the set against the queue's CHECK. */
export const CHANNEL_LABELS = { webhook: 'Webhook', email: 'Email' }

/** A role as a sentence names it: "Shopfloor_Manager" is the Shopfloor Manager. */
export function roleLabel(role) {
  return String(role).replace(/_/g, ' ')
}

/** The people an email goes to, in words: "3 people", "1 person". */
export function peopleCount(n) {
  return `${n} ${n === 1 ? 'person' : 'people'}`
}

/** How many messages the delivery log lists, newest first. */
export const DELIVERY_LOG_LIMIT = 50

/**
 * The hosts typed into the dialog, one a line (commas and spaces split too), as the setting holds
 * them: lower-case, each once, in the order typed. A pasted URL gives its host.
 */
export function parseHosts(text) {
  const hosts = []
  for (const raw of String(text || '').split(/[\s,]+/)) {
    let host = raw.trim().toLowerCase()
    if (!host) continue
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) {
      try { host = new URL(host).hostname } catch { /* left as typed: the database says why */ }
    }
    if (!hosts.includes(host)) hosts.push(host)
  }
  return hosts
}

/** The host a webhook address names, or null while it is not yet an http or https URL. */
export function hostOf(url) {
  try {
    const parsed = new URL(String(url || '').trim())
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname.toLowerCase() : null
  } catch {
    return null
  }
}

/** Each event as the log names it. */
export const EVENT_LABELS = { firing: 'Firing', resolved: 'Resolved', reminder: 'Reminder', test: 'Test' }

/**
 * What became of a message, as `{ label, tone, detail }`: the label says it, so the badge's colour
 * is never the only sign.
 */
export function deliveryOutcome(row) {
  if (row.state === 'sent') {
    if (row.channel === 'email') {
      const refused = row.refused ? ` The relay refused ${row.refused} address${row.refused === 1 ? '' : 'es'}.` : ''
      return { label: 'Sent', tone: 'success', detail: `The mail relay took it for ${peopleCount(row.recipients ?? 0)}.${refused}` }
    }
    return { label: 'Sent', tone: 'success', detail: row.response_status ? `The receiver answered ${row.response_status}.` : 'The receiver accepted it.' }
  }
  if (row.state === 'dropped') {
    return {
      label: 'Not sent',
      tone: 'neutral',
      detail: 'It no longer applied when it was due: the alert had resolved, been replaced or been acknowledged, the webhook was removed, or nobody was left to email.'
    }
  }
  if (row.state === 'dead') {
    return { label: 'Failed', tone: 'danger', detail: 'Every attempt failed, so it is not tried again.' }
  }
  if (row.attempts > 0) {
    return { label: 'Retrying', tone: 'warning', detail: `Tried ${row.attempts} time${row.attempts === 1 ? '' : 's'}; it is tried again.` }
  }
  return { label: 'Waiting', tone: 'pending', detail: 'Queued, and sent on the dispatcher’s next pass.' }
}

/** What a log row is about: the alert and its subject, or the test. */
export function deliverySubject(row) {
  if (row.event === 'test') return 'A test, sent from this page'
  const alert = row.platform_alerts
  if (!alert) return 'An alert no longer kept'
  return alert.sparkplug_id ? `${alert.alert_name} · ${alert.sparkplug_id}` : alert.alert_name
}
