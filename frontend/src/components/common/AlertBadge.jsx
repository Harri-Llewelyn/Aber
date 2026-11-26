import React from 'react'
import { Badge } from './Badge'
import { IconAlertCircle, IconAlertTriangle, IconCheck } from './Icons'
import { alertState } from '../../utils/alertSubjects'
import { reasonLabel } from '../../utils/alertAcknowledgement'
import { acknowledgerName } from '../../utils/alertHistory'

/**
 * The alert in a table row's status cell, beside the state it does not replace (an overheating
 * machine is still ONLINE): ALARM for a critical alert and WARNING for any other while nobody has it,
 * ACKNOWLEDGED, the hollow badge with a tick, once somebody has. Nothing for no alert or a suppressed
 * one. The words are what a screen reader reads; the tooltip names the alert.
 *
 * @param {object|null} alert The alert that decides the row's state: see utils/alertSubjects.js.
 */
export function AlertBadge({ alert }) {
  const state = alertState(alert)
  if (state === 'acknowledged') {
    return (
      <Badge
        tone="danger"
        size="sm"
        className="badge-acknowledged"
        icon={<IconCheck size={11} />}
        title={`${alert.alert_name} — acknowledged by ${acknowledgerName(alert)}: ${reasonLabel(alert.acknowledgement_reason)}`}
      >
        ACKNOWLEDGED
      </Badge>
    )
  }
  if (state !== 'alert') return null
  const critical = alert.severity === 'critical'
  return (
    <Badge
      tone={critical ? 'danger' : 'warning'}
      size="sm"
      icon={critical ? <IconAlertCircle size={11} /> : <IconAlertTriangle size={11} />}
      title={`${alert.alert_name}${alert.summary ? ` — ${alert.summary}` : ''}`}
    >
      {critical ? 'ALARM' : 'WARNING'}
    </Badge>
  )
}
