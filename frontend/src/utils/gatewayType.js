/**
 * What kind of gateway this is, as one word.
 *
 * `gateways` carries `deployment` ('host' | 'remote') and `is_simulated` as two columns; `CHECK
 * (NOT is_simulated OR deployment = 'host')` leaves three legal combinations, so one control can
 * render them. If a remote simulator is ever wanted, the CHECK relaxes and this gains a fourth
 * option.
 *
 * Shadow is the fourth value and is not selectable: a simulated reading never happened, a shadow
 * reading did, on the day the capture was recorded. Only the seeded Playback gateway is a shadow,
 * and a trigger on `playback_jobs` refuses any other target, so `GATEWAY_TYPES` and
 * `SELECTABLE_TYPES` differ.
 *
 * Precedence is most-specific-first, matching `device_locations` and utils/cellResolution.js:
 * shadow, then simulated, then deployment.
 */

export const GATEWAY_TYPES = {
  HOST: 'host',
  REMOTE: 'remote',
  SIMULATED: 'simulated',
  SHADOW: 'shadow',
}

/** What the create/edit form may choose. Shadow is seeded by 0060 and set by nothing else. */
export const SELECTABLE_TYPES = [
  GATEWAY_TYPES.REMOTE,
  GATEWAY_TYPES.HOST,
  GATEWAY_TYPES.SIMULATED,
]

const LABELS = {
  [GATEWAY_TYPES.HOST]: 'Host',
  [GATEWAY_TYPES.REMOTE]: 'Remote',
  [GATEWAY_TYPES.SIMULATED]: 'Simulated',
  [GATEWAY_TYPES.SHADOW]: 'Shadow',
}

/** The sentence a reader needs, in terms of what it means for the numbers. */
const DESCRIPTIONS = {
  [GATEWAY_TYPES.REMOTE]:
    'Runs on its own hardware out on the plant network. Enrolled with a bundle; its credential is '
    + 'minted on the appliance and never travels through a browser.',
  [GATEWAY_TYPES.HOST]:
    'A connector running inside this stack. Nothing to install, and no appliance to enrol — its '
    + 'credential is minted here and shown once.',
  [GATEWAY_TYPES.SIMULATED]:
    'A host-run connector whose readings are generated rather than observed — a simulator, or a '
    + 'target for capture.py play. Its devices inherit the mark; they have no setting of their own. '
    + 'Ingestion is unchanged: this is a label for dashboards, retention and reports, not a filter '
    + 'on the data path.',
  [GATEWAY_TYPES.SHADOW]:
    'Republishes recorded captures. Its readings DID happen, on a real machine, on the day the '
    + 'capture was taken — which is what makes it different from Simulated rather than a kind of it.',
}

/** Badge tone. Only the two synthetic kinds are marked; a real gateway is unremarkable. */
const TONES = {
  [GATEWAY_TYPES.HOST]: 'neutral',
  [GATEWAY_TYPES.REMOTE]: 'neutral',
  [GATEWAY_TYPES.SIMULATED]: 'warning',
  [GATEWAY_TYPES.SHADOW]: 'warning',
}

/**
 * @param {object} gateway a row from `gateway_status` (or anything carrying the same three fields)
 * @returns {string} one of GATEWAY_TYPES
 */
export function gatewayType(gateway) {
  if (!gateway) return GATEWAY_TYPES.REMOTE
  if (gateway.is_shadow) return GATEWAY_TYPES.SHADOW
  if (gateway.is_simulated) return GATEWAY_TYPES.SIMULATED
  // Defaults to remote when `deployment` is absent: host is the type with no appliance and no
  // enrolment, so claiming it wrongly hides the one kind of gateway that needs setting up.
  return gateway.deployment === 'host' ? GATEWAY_TYPES.HOST : GATEWAY_TYPES.REMOTE
}

export function gatewayTypeLabel(type) {
  return LABELS[type] || LABELS[GATEWAY_TYPES.REMOTE]
}

export function gatewayTypeDescription(type) {
  return DESCRIPTIONS[type] || DESCRIPTIONS[GATEWAY_TYPES.REMOTE]
}

export function gatewayTypeTone(type) {
  return TONES[type] || 'neutral'
}

/**
 * The two columns a chosen type writes back; the translation lives here once. `shadow` is absent
 * because it is not selectable.
 */
export function gatewayTypeFields(type) {
  switch (type) {
    case GATEWAY_TYPES.HOST:      return { deployment: 'host',   is_simulated: false }
    case GATEWAY_TYPES.SIMULATED: return { deployment: 'host',   is_simulated: true }
    default:                      return { deployment: 'remote', is_simulated: false }
  }
}

/**
 * Whether a device may be assigned to this gateway. Mirrors the database gate: a shadow gateway's
 * devices are replay lanes minted by `ensure_shadow_devices()` with a `shadow_of`, and a device
 * assigned by hand would be a shadow with no provenance. Null-safe in the permissive direction: no
 * gateway yet is the Unassigned queue.
 */
export function gatewayAcceptsDevices(gateway) {
  return !gateway?.is_shadow
}

/**
 * Why this gateway takes no devices, as a sentence, or null. An operator looking for Playback in
 * the list needs to be told it is not assignable and that a different gesture does what they want.
 */
export function noDeviceAssignmentReason(gateway) {
  if (gatewayAcceptsDevices(gateway)) return null
  return 'Its devices are replay lanes, minted when a capture is played rather than assigned. '
    + 'Start a playback from the capture instead.'
}
