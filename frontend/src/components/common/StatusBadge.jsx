import React from 'react'
import { GATEWAY_STATUS_LABELS } from '../../utils/gatewayStatus'

/**
 * The gateway status chip. Five visual classes, with `badge-warning` as the default for anything
 * unrecognised: `gateways.status` is free text (an
 * NBIRTH payload can override it), so the set is open.
 */
export function StatusBadge({ status }) {
  const isOnline = status === 'ONLINE' || status === 'ACTIVE'
  const isOffline = status === 'OFFLINE'

  // The enrolment states get their own informational variants: amber means look at this and grey
  // means offline, and a gateway waiting for its bundle is neither. Two variants, not one: solid for
  // "waiting on a person", dashed for "waiting on a machine". See the .badge-pending /
  // .badge-provisioned block in App.css. The label says what is being waited for.
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
