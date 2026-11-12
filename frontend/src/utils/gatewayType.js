/**
 * What kind of gateway this is, as one word: the Type column, the drawer badge and the form's
 * select all read it from here. `gateways` carries `deployment` ('host' | 'remote' |
 * 'third_party') and `is_simulated`; a simulated gateway is always host-run, which leaves four
 * legal combinations. Playback is a fifth value that is never selectable: only the seeded Playback
 * gateway (`is_shadow`) is one.
 *
 * Precedence is most-specific-first, as in `device_locations` and utils/cellResolution.js: playback,
 * then simulated, then deployment.
 */

export const GATEWAY_TYPES = {
  HOST: 'host',
  REMOTE: 'remote',
  THIRD_PARTY: 'third_party',
  SIMULATED: 'simulated',
  PLAYBACK: 'playback',
}

/** What the create/edit form may choose. */
export const SELECTABLE_TYPES = [
  GATEWAY_TYPES.REMOTE,
  GATEWAY_TYPES.THIRD_PARTY,
  GATEWAY_TYPES.HOST,
  GATEWAY_TYPES.SIMULATED,
]

/** What the list's Type filter offers: every type, the form's four first. */
export const LISTED_TYPES = [...SELECTABLE_TYPES, GATEWAY_TYPES.PLAYBACK]

const LABELS = {
  [GATEWAY_TYPES.HOST]: 'Host',
  [GATEWAY_TYPES.REMOTE]: 'Remote',
  [GATEWAY_TYPES.THIRD_PARTY]: 'Third-party',
  [GATEWAY_TYPES.SIMULATED]: 'Simulated',
  [GATEWAY_TYPES.PLAYBACK]: 'Playback',
}

/** The sentence a reader needs, in terms of what it means for the numbers. */
const DESCRIPTIONS = {
  [GATEWAY_TYPES.REMOTE]:
    'Runs on its own hardware out on the plant network. Set up with an install command or a bundle; '
    + 'its credential is issued to the appliance when it enrols and never passes through a browser.',
  [GATEWAY_TYPES.THIRD_PARTY]:
    'An edge node on its own machine, running software Aber does not manage. Its credential is '
    + 'issued here, and an engineer configures the node with it.',
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
  [GATEWAY_TYPES.THIRD_PARTY]: 'neutral',
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
  if (gateway.deployment === 'third_party') return GATEWAY_TYPES.THIRD_PARTY
  // Remote when `deployment` is absent: claiming host wrongly would hide the kind that needs setup.
  return gateway.deployment === 'host' ? GATEWAY_TYPES.HOST : GATEWAY_TYPES.REMOTE
}

/**
 * Whether the dashboard issues this gateway's broker credential: a Host gateway has no appliance to
 * enrol, and a Third-party one runs software Aber does not manage. A Remote appliance mints its own.
 */
export function credentialIssuedHere(gateway) {
  return gateway?.deployment === 'host' || gateway?.deployment === 'third_party'
}

// The drawer's rows, named by label, in the three groups a kind has in common.
const FORGE_ROWS = ['Bundle', 'Committed', 'Reported']
const HEALTH_ROWS = ['Health Reported', 'Runtime Uptime']
const APPLIANCE_ROWS = ['CA Expires', 'Disk Free', 'Memory Available', 'Load (1m)', 'Flow', 'Platform', 'Custom']

/**
 * The drawer rows each kind of gateway can never fill, so its drawer does not show them. A row a
 * kind could fill but has not yet is shown, and says "Not set"; one it never will would say it for
 * good, and a Host gateway's drawer carried seven of them between its facts and its actions.
 *
 * Only a Remote gateway runs on an appliance of its own, which enrols, holds a forge repository and
 * reports node_exporter's figures. A host-run gateway (Host, Simulated) runs in this stack's
 * Node-RED, and its heartbeat reports its uptime. Playback reports no health at all: the daemon
 * records none for a shadow gateway. A Third-party node's software is not Aber's to read.
 */
export const NEVER_FILLED_ROWS = Object.freeze({
  [GATEWAY_TYPES.REMOTE]: [],
  [GATEWAY_TYPES.HOST]: [...FORGE_ROWS, ...APPLIANCE_ROWS],
  [GATEWAY_TYPES.SIMULATED]: [...FORGE_ROWS, ...APPLIANCE_ROWS],
  [GATEWAY_TYPES.PLAYBACK]: [...FORGE_ROWS, ...HEALTH_ROWS, ...APPLIANCE_ROWS],
  [GATEWAY_TYPES.THIRD_PARTY]: [...FORGE_ROWS, ...HEALTH_ROWS, ...APPLIANCE_ROWS],
})

/** Whether this gateway's drawer shows the row with this label: false for one its kind can never fill. */
export function gatewayShowsRow(gateway, label) {
  return !NEVER_FILLED_ROWS[gatewayType(gateway)].includes(label)
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
    case GATEWAY_TYPES.HOST:        return { deployment: 'host',        is_simulated: false }
    case GATEWAY_TYPES.THIRD_PARTY: return { deployment: 'third_party', is_simulated: false }
    case GATEWAY_TYPES.SIMULATED:   return { deployment: 'host',        is_simulated: true }
    default:                        return { deployment: 'remote',      is_simulated: false }
  }
}

/**
 * What saving a change of type ends, read from the stored row, or null when the type is unchanged.
 * Mirrors clean_up_after_a_gateway_type_change() (0252): only crossing Remote's boundary ends
 * anything. Leaving Remote cancels an unused setup command (PENDING_ENROLLMENT), and crossing either
 * way ends the broker credential the stored row holds. `holdsCredential` is that row's
 * gateway_has_broker_credential(), or null while unknown, which counts as holding one.
 *
 * @returns {{ toRemote: boolean, crosses: boolean, setup: boolean, credential: boolean, keeps: boolean } | null}
 */
export function gatewayTypeChange(stored, chosenType, holdsCredential) {
  if (!stored || gatewayType(stored) === chosenType) return null
  const wasRemote = stored.deployment === 'remote'
  const toRemote = gatewayTypeFields(chosenType).deployment === 'remote'
  const crosses = wasRemote !== toRemote
  return {
    toRemote,
    crosses,
    setup: crosses && wasRemote && stored.status === 'PENDING_ENROLLMENT',
    credential: crosses && holdsCredential !== false,
    keeps: !crosses && holdsCredential === true,
  }
}

/**
 * The Type hint's sentences for a change of type, said before Save. Null when nothing ends or
 * follows. `holdsCredential` null reads "any broker credential", since the row could not be asked.
 */
export function gatewayTypeChangeHint(change, holdsCredential) {
  if (!change) return null
  const which = holdsCredential === null ? 'any broker credential' : 'the broker credential'
  const parts = []
  if (change.setup) parts.push('Saving cancels the unused setup command.')
  if (change.credential) {
    parts.push(change.toRemote
      ? `Saving ends ${which} this gateway holds, and whatever uses it is cut off.`
      : `Saving ends ${which} its appliance holds, and the appliance is cut off.`)
  }
  if (change.keeps) parts.push('Saving keeps the broker credential this gateway holds.')
  if (change.crosses) {
    parts.push(change.toRemote
      ? 'Once saved, set it up from its drawer: the appliance is issued a new credential when it enrols.'
      : 'Once saved, issue it a broker credential from its drawer.')
  }
  return parts.length ? parts.join(' ') : null
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
