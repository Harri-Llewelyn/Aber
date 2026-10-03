import React from 'react'
import { GATEWAY_STATUS_LABELS, GATEWAY_STATUS_PLAYING_BACK, GATEWAY_STATUS_IDLE } from '../../utils/gatewayStatus'
import { Badge } from './Badge'

/** The Playback gateway's two states (gatewayDisplayStatus): publishing a capture, or resting. */
const PLAYBACK_STATES = {
  [GATEWAY_STATUS_PLAYING_BACK]: {
    tone: 'info',
    title: 'A capture is playing: the playback worker is publishing as this gateway.'
  },
  [GATEWAY_STATUS_IDLE]: {
    tone: 'neutral',
    title: 'No capture is playing. This gateway publishes only during a playback, so idle is its resting state, not a fault.'
  }
}

/**
 * The gateway status chip, drawn through Badge. `warning` is the default for anything
 * unrecognised: `gateways.status` is free text (an NBIRTH payload can override it), so the set is
 * open.
 */
export function StatusBadge({ status }) {
  const playback = PLAYBACK_STATES[status]
  if (playback) return <Badge tone={playback.tone} dot title={playback.title}>{GATEWAY_STATUS_LABELS[status]}</Badge>

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
