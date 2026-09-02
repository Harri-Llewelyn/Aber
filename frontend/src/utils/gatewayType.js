/**
 * What KIND of gateway this is, as one word.
 *
 * =================================================================================================
 * ONE COLUMN, FOUR VALUES, AND THE SCHEMA STILL HOLDS TWO FACTS
 *
 * `gateways` carries `deployment` ('host' | 'remote') and `is_simulated`, deliberately separate,
 * as 0064 has it: folding them into one enum welds two independent facts together and makes a
 * simulator on a separate load-generation box unrepresentable. What makes a
 * SINGLE control honest anyway is the cross-column CHECK beside them,
 * `CHECK (NOT is_simulated OR deployment = 'host')`, which leaves exactly three legal combinations.
 *
 * So this is not a collapse of the model. It is a rendering of the constraint, and if a remote
 * simulator is ever wanted the CHECK relaxes in one line and this gains a fourth option with no
 * data migration behind it.
 *
 * =================================================================================================
 * SHADOW IS THE FOURTH VALUE AND IS NOT OFFERED FOR SELECTION
 *
 * `is_shadow` (0059) is a lane of its own because provenance is not one axis: a SIMULATED spindle
 * reporting 4000 RPM never turned, and a SHADOW spindle reporting 4000 RPM did turn, on a real
 * machine, on the day the capture was recorded. Both are "not a machine running now" and they give
 * opposite answers to *is this number true* -- which is the question being asked at the moment
 * anyone reads this column.
 *
 * Nobody creates one by hand: 0060 seeds the single Playback gateway and a trigger on
 * `playback_jobs` refuses any other target. So it is a value this can REPORT and the editor cannot
 * SET, which is why `GATEWAY_TYPES` and `SELECTABLE_TYPES` are different lists.
 *
 * PRECEDENCE IS MOST-SPECIFIC-FIRST, matching `device_locations` and utils/cellResolution.js:
 * shadow > simulated > deployment. Both flags are true of a shadow gateway, so without an order it
 * would land in Simulated and the more informative answer would be unreachable.
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

/**
 * The sentence a reader needs, not a restatement of the label.
 *
 * Each says what it means for the NUMBERS, because that is what somebody looking at a gateway row
 * is about to trust or not trust.
 */
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
  // DEFAULTS TO REMOTE when `deployment` is absent, which is the safe direction: a row read through
  // an older select list, or a fixture written before 0064, should not be reported as host-run.
  // Host is the type with no appliance and no enrolment, so claiming it wrongly hides the one kind
  // of gateway that needs setting up.
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
 * The two columns a chosen type writes back.
 *
 * THE FORM HOLDS ONE VALUE AND THE DATABASE HOLDS TWO, so this is where the translation lives --
 * once, rather than in each page that offers the control. `shadow` is deliberately absent: it is
 * not selectable, and a caller that somehow asked for it would be asking to fabricate the one
 * gateway 0060 seeds.
 */
export function gatewayTypeFields(type) {
  switch (type) {
    case GATEWAY_TYPES.HOST:      return { deployment: 'host',   is_simulated: false }
    case GATEWAY_TYPES.SIMULATED: return { deployment: 'host',   is_simulated: true }
    default:                      return { deployment: 'remote', is_simulated: false }
  }
}
