import React from 'react'
import { GATEWAY_STATUS_LABELS } from '../../utils/gatewayStatus'
import { Badge } from './Badge'

/**
 * The gateway status chip, drawn through Badge. `warning` is the default for anything
 * unrecognised: `gateways.status` is free text (an NBIRTH payload can override it), so the set is
 * open.
 */
export function StatusBadge({ status }) {
  const isOnline = status === 'ONLINE' || status === 'ACTIVE'
  const isOffline = status === 'OFFLINE'

  // The enrolment states get their own informational tones: amber means look at this and grey
  // means offline, and a gateway waiting for its bundle is neither. Two tones, not one: solid
  // (pending) for "waiting on a person", dashed (provisioned) for "waiting on a machine". The label
  // says what is being waited for.
  const isPending = status === 'PENDING_ENROLLMENT' || status === 'AWAITING_BIRTH'

  const tone = isOnline
    ? 'success'
    : status === 'PENDING_ENROLLMENT'
      ? 'pending'
      : status === 'AWAITING_BIRTH'
        ? 'provisioned'
        : isOffline
          ? 'neutral'
          : 'warning'

  const label = GATEWAY_STATUS_LABELS[status] || status

  const title = isPending
    ? status === 'PENDING_ENROLLMENT'
      ? 'A bundle has been generated for this gateway. It is waiting for the appliance to run it and enrol.'
      : 'The appliance enrolled and holds a broker credential. It has not published its first Sparkplug birth yet.'
    : `Operational Status: ${status}`

  return <Badge tone={tone} dot title={title}>{label}</Badge>
}
