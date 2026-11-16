import React from 'react'
import { FilterCheck } from './FilterChecklist'
import { REPLAY_LANES_LABEL, REPLAY_LANES_TIP } from '../../utils/replayLanes'

/**
 * The Show replay lanes check, in the words the Devices page uses (utils/replayLanes.js). `count` is
 * how many lanes turning it on would add. A page draws it only while a lane exists.
 */
export function ReplayLanesCheck({ checked, onChange, count }) {
  return <FilterCheck label={REPLAY_LANES_LABEL} checked={checked} onChange={onChange} count={count} tip={REPLAY_LANES_TIP} />
}
