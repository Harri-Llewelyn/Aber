import { severityOf } from './alertHistory'
import { alertPage } from '../routes'
import { grafanaAlertUrl } from '../constants'

/**
 * Desktop notifications for a firing alert: what one says, how long it waits to name its subject,
 * and where a click on it leads. The browser's side is utils/notificationPermission.js.
 */

/** The most a place lookup may delay a notification: a slow read shows the Sparkplug id instead. */
export const SUBJECT_WAIT_MS = 2000

/**
 * What a click on a notification opens, as the alert counter's row does: a device or gateway through
 * `showDevice` and `showGateway`, at its own address; the page alertPage() names through
 * `navigate`; any other alert's rule in Grafana, in a new tab. Returns the function to call with the alert.
 */
export function alertOpener({ showDevice, showGateway, navigate, open = (url) => window.open(url, '_blank', 'noopener,noreferrer') }) {
  return (alert) => {
    const kind = alert?.entity_type || 'device'
    if (kind === 'device' && alert?.sparkplug_id) return showDevice?.(alert.sparkplug_id)
    if (kind === 'gateway' && alert?.sparkplug_id) return showGateway?.(alert.sparkplug_id)
    const page = alertPage(alert)
    return page ? navigate?.(page.to) : open(grafanaAlertUrl(alert))
  }
}

/**
 * What a notification for `alert` says: the alert's name, then its severity in words and the
 * subject. `subject` is `{ name, place }` from api.readAlertSubject(), or null, when the subject is
 * named by its Sparkplug id. It carries no reading: the alert counter holds the summary, which has
 * the values in it.
 */
export function alertNotificationText(alert, subject = null) {
  const kind = alert?.entity_type || 'device'
  const severity = severityOf(alert?.severity).label
  let about
  if (kind === 'device' || kind === 'gateway') {
    const name = subject?.name || alert?.sparkplug_id
    about = name ? `${kind} ${name}` : `a ${kind}`
    if (subject?.place) about += `, in ${subject.place}`
  } else {
    about = kind === 'service_identity' ? 'a machine identity' : 'the platform'
  }
  return { title: alert?.alert_name || 'Alert', body: `${severity} on ${about}.` }
}
