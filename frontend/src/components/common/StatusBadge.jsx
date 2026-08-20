import React from 'react'
import { GATEWAY_STATUS_LABELS } from '../../utils/gatewayStatus'

/**
 * The one status chip, shared by cells, gateways and devices.
 *
 * FOUR VISUAL CLASSES, not one per status. `badge-warning` is the default for anything unrecognised,
 * which is what lets a status this component has never heard of still render legibly rather than
 * unstyled -- `gateways.status` is free text by design (an NBIRTH payload can override it), so the
 * set is genuinely open and must not be treated as an enum here.
 */
export function StatusBadge({ status }) {
  const isOnline = status === 'ONLINE' || status === 'ACTIVE'
  const isOffline = status === 'OFFLINE'

  /**
   * THE ENROLMENT STATES GET THEIR OWN VARIANT, and the reason is that neither of the existing two
   * fits without saying something false.
   *
   * `badge-warning` (amber) is what an unrecognised status falls through to, and amber on this page
   * means "look at this" -- but a gateway waiting for someone to carry a USB stick to a machine is
   * not a problem, it is an unfinished task. `badge-neutral` (grey) is the other option and reads as
   * decommissioned, which is worse: it suggests the gateway is out of service rather than on its way
   * in. So: a distinct informational variant, and a label that says what is actually being waited
   * for rather than repeating the wire value.
   */
  // Two variants, not one: solid for "waiting on a person", dashed for "waiting on a machine". See
  // the .badge-pending / .badge-provisioned block in App.css.
  const isPending = status === 'PENDING_ENROLLMENT' || status === 'AWAITING_BIRTH'

  const cls = isOnline
    ? 'badge-online'
    : status === 'PENDING_ENROLLMENT'
      ? 'badge-pending'
      : status === 'AWAITING_BIRTH'
        ? 'badge-provisioned'
        : isOffline
          ? 'badge-neutral'
          : 'badge-warning'

  // The dot inherits `currentColor` from the variant, so only OFFLINE needs an override -- it is the
  // one variant whose text colour is deliberately muted rather than signalling.
  const dotColor = isOffline ? 'var(--text-muted)' : undefined

  const label = GATEWAY_STATUS_LABELS[status] || status

  const title = isPending
    ? status === 'PENDING_ENROLLMENT'
      ? 'A bundle has been generated for this gateway. It is waiting for the appliance to run it and enrol.'
      : 'The appliance enrolled and holds a broker credential. It has not published its first Sparkplug birth yet.'
    : `Operational Status: ${status}`

  return (
    <span className={`badge ${cls}`} title={title}>
      <span className="badge-dot" style={dotColor ? { background: dotColor } : {}} />
      {label}
    </span>
  )
}
