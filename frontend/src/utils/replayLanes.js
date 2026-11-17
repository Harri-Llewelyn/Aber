import { SOURCE_SHADOW } from './cellResolution'
import { isShadowDevice } from './fleetCounts'

/*
 * What the Devices page and History say of replay lanes, once: the check that shows them, its
 * words, and the address key that holds it. Both pages hide the lanes until it is on.
 */

/** The query key of the check, as the Devices page keeps it: `?replay=1`. */
export const REPLAY_LANES_PARAM = 'replay'

export const REPLAY_LANES_LABEL = 'Show replay lanes'

export const REPLAY_LANES_TIP =
  'Playback makes one replay lane per device a capture recorded. They are hidden by default because they are not machines.'

/** A replay lane: a device on the Playback gateway, named by its `shadow_of` and placed `shadow`. */
export const isReplayLane = (device) => !!device && (device.location_source === SOURCE_SHADOW || isShadowDevice(device))
