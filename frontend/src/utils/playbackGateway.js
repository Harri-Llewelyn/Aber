import { alertPage } from '../routes'
import { pathSegments } from '../hooks/useUrlState'
import { alertForGateway, alertIndex, worstAlert } from './alertSubjects'
import { isSuppressed } from './alertSuppression'

/*
 * The Playback gateway on the Gateways page, as replay lanes are on Devices (replayLanes.js): left off
 * the list until a check shows it, or until something is wrong with it.
 */

/** The query key of the check, as the Gateways page keeps it: `?playback=1`. */
export const PLAYBACK_GATEWAY_PARAM = 'playback'

export const PLAYBACK_GATEWAY_LABEL = 'Show Playback gateway'

export const PLAYBACK_GATEWAY_TIP =
  'The Playback gateway is left off the list. It republishes captures, and no machine reports through it.'

/** An alert about a playback: the one that opens the Capture page's Playbacks tab. */
const isPlaybackAlert = (alert) => {
  const [page, tab] = pathSegments(alertPage(alert)?.to ?? '')
  return page === 'capture' && tab === 'playbacks'
}

/**
 * The alert that decides the Playback gateway's state, or null: one on it, or on a playback, which only
 * it publishes, the worse winning and its own winning a tie. Its row and the check's words are handed
 * no suppressed alert; its drawer's banner is, with `suppressed`, as alertIndex() takes it.
 */
export function playbackAlert(gateway, activeAlerts = [], { suppressed = false } = {}) {
  const own = alertForGateway(alertIndex(activeAlerts, 'gateway', { suppressed }), gateway)
  return worstAlert(own, ...activeAlerts.filter(a => (suppressed || !isSuppressed(a)) && isPlaybackAlert(a)))
}

/**
 * What is wrong with the Playback gateway, in words, or null: an alert on it, or on a playback
 * (playbackAlert()); or a device held in quarantine behind it. A suppressed alert is kept quiet.
 *
 * @param {object} gateway The Playback gateway's row.
 * @param {object} state `{ activeAlerts, quarantined }`: the firing alerts, and the ids of the gateways
 * with a device in quarantine.
 */
export function playbackProblem(gateway, { activeAlerts = [], quarantined = new Set() } = {}) {
  const alert = playbackAlert(gateway, activeAlerts)
  if (alert) return `an alert is firing: ${alert.alert_name}`
  return quarantined.has(gateway?.gateway_id) ? 'it has a device in quarantine' : null
}
