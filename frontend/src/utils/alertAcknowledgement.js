import { alertPage, deviceUrl, gatewayUrl } from '../routes'
import { grafanaAlertUrl } from '../constants'

/**
 * Acknowledging an alert: the reasons a person gives, who may acknowledge and withdraw, and the
 * words the alert counter shows. The database decides (acknowledge_alert() and
 * withdraw_alert_acknowledgement(), 0231); these say in advance what it will answer, so the counter
 * offers only what it would accept.
 */

/**
 * The reasons, in the order the dialog lists them. The values are the CHECK's and
 * acknowledge_alert()'s; mirror check 45 holds the three together.
 */
export const ALERT_ACKNOWLEDGEMENT_REASONS = [
  { value: 'investigating', label: 'Investigating' },
  { value: 'known_cause', label: 'Known cause' },
  { value: 'planned_work', label: 'Planned work' },
  { value: 'sensor_or_model_fault', label: 'Sensor or model fault' },
  { value: 'threshold_wrong', label: 'Threshold wrong' },
  { value: 'other', label: 'Other' },
]

/** The note's limit, as `platform_alerts_acknowledgement_note_valid` holds it. */
export const ALERT_ACKNOWLEDGEMENT_NOTE_MAX = 200

/**
 * Who may acknowledge, and who may withdraw anyone's acknowledgement; the acknowledger may always
 * withdraw their own. Mirror check 46 holds both lists to the two functions.
 */
export const ALERT_ACKNOWLEDGE_ROLES = ['Administrator', 'Shopfloor_Manager', 'Operator']
export const ALERT_WITHDRAW_ANY_ROLES = ['Administrator', 'Shopfloor_Manager']

export const isAcknowledged = (alert) => Boolean(alert?.acknowledged_at)

/** The firing alerts nobody has acknowledged: what the counter, the tab title and the favicon count. */
export const unacknowledgedAlerts = (alerts = []) => alerts.filter((a) => !isAcknowledged(a))

export const reasonLabel = (value) =>
  ALERT_ACKNOWLEDGEMENT_REASONS.find((r) => r.value === value)?.label ?? value

export const mayAcknowledge = (role) => ALERT_ACKNOWLEDGE_ROLES.includes(role)

export const mayWithdraw = (alert, role, userId) => isAcknowledged(alert) && (
  ALERT_WITHDRAW_ANY_ROLES.includes(role)
  || (mayAcknowledge(role) && Boolean(userId) && alert.acknowledged_by === userId)
)

/**
 * Where a message about an alert leads, as its row in the counter does: the page alertPage() names
 * when it has one of its own (an automation's alert opens the automation), else the device or
 * gateway it is about, else its rule in Grafana (none for an alert Aber's evaluator raised, so null).
 */
export function alertSubjectUrl(alert) {
  const own = alertPage(alert)
  if (own) return own.to
  const kind = alert?.entity_type || 'device'
  if (kind === 'device' && alert?.sparkplug_id) return deviceUrl(alert.sparkplug_id)
  if (kind === 'gateway' && alert?.sparkplug_id) return gatewayUrl(alert.sparkplug_id)
  return grafanaAlertUrl(alert)
}
