/**
 * What kind of gateway this is, as one word: the Type column, the drawer badge and the form's
 * select all read it from here. `gateways` carries `deployment` ('host' | 'remote') and
 * `is_simulated`; a simulated gateway is always host-run, which leaves three legal combinations.
 * Playback is a fourth value that is never selectable: only the seeded Playback gateway (`is_shadow`)
 * is one.
 *
 * Precedence is most-specific-first, as in `device_locations` and utils/cellResolution.js: playback,
 * then simulated, then deployment.
 */

export const GATEWAY_TYPES = {
  HOST: 'host',
  REMOTE: 'remote',
  SIMULATED: 'simulated',
  PLAYBACK: 'playback',
}

/** What the create/edit form may choose. */
export const SELECTABLE_TYPES = [
  GATEWAY_TYPES.REMOTE,
  GATEWAY_TYPES.HOST,
  GATEWAY_TYPES.SIMULATED,
]

/** What the list's Type filter offers: every type, the form's three first. */
export const LISTED_TYPES = [...SELECTABLE_TYPES, GATEWAY_TYPES.PLAYBACK]

const LABELS = {
  [GATEWAY_TYPES.HOST]: 'Host',
  [GATEWAY_TYPES.REMOTE]: 'Remote',
  [GATEWAY_TYPES.SIMULATED]: 'Simulated',
  [GATEWAY_TYPES.PLAYBACK]: 'Playback',
}

/** The sentence a reader needs, in terms of what it means for the numbers. */
const DESCRIPTIONS = {
  [GATEWAY_TYPES.REMOTE]:
    'Runs on its own hardware out on the plant network. Set up with an install command or a bundle; '
    + 'its credential is issued to the appliance when it enrols and never passes through a browser.',
  [GATEWAY_TYPES.HOST]:
    'A connector running inside this stack. Nothing to install, and no appliance to enrol — its '
    + 'credential is issued here, and an Administrator can show it again.',
  [GATEWAY_TYPES.SIMULATED]:
    'A host-run connector whose readings are generated rather than observed. Its devices inherit '
    + 'the mark; they have no setting of their own. Ingestion is unchanged: this is a label for '
    + 'dashboards, retention and reports, not a filter on the data path.',
  [GATEWAY_TYPES.PLAYBACK]:
    'Republishes recorded captures. Its readings DID happen, on a real machine, on the day the '
    + 'capture was taken — which is what makes it different from Simulated rather than a kind of it.',
}

/** Badge tone. Only the two synthetic kinds are marked. */
const TONES = {
  [GATEWAY_TYPES.HOST]: 'neutral',
  [GATEWAY_TYPES.REMOTE]: 'neutral',
  [GATEWAY_TYPES.SIMULATED]: 'warning',
  [GATEWAY_TYPES.PLAYBACK]: 'warning',
}

/**
 * @param {object} gateway a row from `gateway_status` (or anything carrying the same three fields)
 * @returns {string} one of GATEWAY_TYPES
 */
export function gatewayType(gateway) {
  if (!gateway) return GATEWAY_TYPES.REMOTE
  if (gateway.is_shadow) return GATEWAY_TYPES.PLAYBACK
  if (gateway.is_simulated) return GATEWAY_TYPES.SIMULATED
  // Remote when `deployment` is absent: claiming host wrongly would hide the kind that needs setup.
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
 * The two columns a chosen type writes back; the translation lives here once. `playback` is absent
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

/**
 * Whether what an operator typed into a "type the name to confirm" box names this gateway. Compared
 * trimmed, whitespace-collapsed and case-folded: the guard stops an accidental click, not a
 * determined typist.
 */
export function typedNameMatches(typed, gatewayName) {
  const normalise = (value) => (value || '').trim().replace(/\s+/g, ' ').toLowerCase()
  return normalise(typed) === normalise(gatewayName)
}
