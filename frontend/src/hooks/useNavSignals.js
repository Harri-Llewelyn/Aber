import { useCallback, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { PERMISSION_UUIDS, REALTIME_ENABLED, refreshInterval } from '../constants'
import { usePolling } from './usePolling'
import { useRealtimeTable } from './useRealtimeTable'
import { gatewayFleetCounts, deviceFleetCounts } from '../utils/fleetCounts'
import { canDecide } from '../utils/proposalAuthority'
import { mayAcknowledge } from '../utils/alertAcknowledgement'
import { countAlertedSubjects, signalFromParts } from '../utils/navSignal'

/**
 * What the rail should flag for the person looking, from the lists the pages read. A signal is a
 * condition its page already reports as a banner or a queue, shown only to a viewer who can act on
 * it, with the same permission the page gates that action on: a device in quarantine for one who
 * may approve or reject it, an offline gateway for one who may manage gateways, a cell in no area
 * for one who may manage cells, an open proposal for one who may decide it and did not file it.
 * `count` is the number shown beside the icon; `note` is the words, carried on the item's title
 * and label, so the colour is never the only signal. `viewer` is { hasPermission, userRole, userId };
 * without one nothing is flagged. Pure, so it is testable without a network.
 *
 * A page's signal is built from its parts (utils/navSignal.js), one for each condition the viewer
 * can act on there, because two conditions are never one number: Devices has the devices with a
 * firing alert (`danger`) and the devices in quarantine (`warning`), Gateways the gateways with a
 * firing alert and the offline ones. `alerts` is the firing alerts `usePlatformAlerts` already
 * keeps for the header's counter, not a second read. One counts when nobody has acknowledged it and
 * no window keeps it quiet, for the viewer who may acknowledge one (the check the counter's
 * Acknowledge button uses), and the count is the devices, or gateways, not the alerts.
 */
export function navSignalsFrom({ cells = [], gateways = [], devices = [], proposals = [], alerts = [] } = {}, viewer = {}) {
  const { hasPermission = () => false, userRole = null, userId = null } = viewer
  const signals = {}
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
  const mayAct = mayAcknowledge(userRole)
  const flag = (page, parts) => {
    const signal = signalFromParts(parts)
    if (signal) signals[page] = signal
  }

  const alertedDevices = mayAct ? countAlertedSubjects(alerts, 'device') : 0
  const dev = deviceFleetCounts(devices)
  const mayApprove = hasPermission(PERMISSION_UUIDS.QUARANTINE_APPROVE) || hasPermission(PERMISSION_UUIDS.QUARANTINE_REJECT)
  flag('devices', {
    ...(alertedDevices > 0 && { alerts: { tone: 'danger', count: alertedDevices, note: `${plural(alertedDevices, 'device')} with a firing alert`, tabNote: `${alertedDevices} with a firing alert` } }),
    ...(dev.quarantined > 0 && mayApprove && { quarantine: { tone: 'warning', count: dev.quarantined, note: `${plural(dev.quarantined, 'device')} awaiting zero-touch onboarding approval`, tabNote: `${dev.quarantined} waiting` } }),
  })

  // Awaiting setup is not offline: a gateway waiting for its bundle is an unfinished task, not a
  // fault (fleetCounts.js keeps the two apart).
  const alertedGateways = mayAct ? countAlertedSubjects(alerts, 'gateway') : 0
  const gw = gatewayFleetCounts(gateways)
  flag('gateways', {
    ...(alertedGateways > 0 && { alerts: { tone: 'danger', count: alertedGateways, note: `${plural(alertedGateways, 'gateway')} with a firing alert`, tabNote: `${alertedGateways} with a firing alert` } }),
    ...(gw.offline > 0 && hasPermission(PERMISSION_UUIDS.GATEWAY_MANAGE) && { offline: { tone: 'warning', count: gw.offline, note: `${plural(gw.offline, 'gateway')} offline`, tabNote: `${gw.offline} offline` } }),
  })

  const unfiled = cells.filter(c => !c.is_archived && !c.area_id).length
  flag('areas', {
    ...(unfiled > 0 && hasPermission(PERMISSION_UUIDS.CELL_MANAGE) && { cells: { tone: 'warning', count: unfiled, note: `${plural(unfiled, 'cell')} in no area`, tabNote: `${unfiled} waiting` } }),
  })

  // The Approvals page's own test, `canDecide`, minus the viewer's own requests: waiting on
  // somebody else is not work.
  const waiting = proposals.filter(p => p.status === 'open' && p.proposed_by !== userId && canDecide(p.entity_type, userRole)).length
  flag('approvals', {
    ...(waiting > 0 && { proposals: { tone: 'warning', count: waiting, note: `${plural(waiting, 'proposal')} waiting for a decision`, tabNote: `${waiting} waiting` } }),
  })

  return signals
}

/**
 * The rail's signals, kept current the way a tab keeps its table current: Realtime on the three
 * tables the publication carries, with the poll as the reconciler (and the only source for
 * proposals, which are not published). Owned by App, so the flag is visible whichever page is
 * open. The lists are kept and the signals derived from them, so a late-arriving permission
 * re-flags without a read. A failed read keeps the last answer rather than clearing it.
 *
 * `alerts` are the firing alerts the header's counter already holds (App hands over what
 * usePlatformAlerts returns): the alert counts read that list as it changes, with no read of their
 * own and no second Realtime subscription.
 */
export function useNavSignals({ hasPermission, userRole, userId, alerts } = {}) {
  const [lists, setLists] = useState({})
  // Whether any proposal could be flagged for this viewer; the read is the heaviest of the four.
  const readsProposals = useRef(false)
  readsProposals.current = canDecide('cells', userRole)

  const load = useCallback(async (signal) => {
    const [cells, gateways, devices, proposals] = await Promise.all([
      api.get('/api/v1/cells', { signal }),
      api.get('/api/v1/gateways', { signal }),
      api.get('/api/v1/devices', { signal }),
      readsProposals.current ? api.get('/api/v1/proposals', { signal }).catch(() => null) : []
    ])
    setLists(prev => ({ cells, gateways, devices, proposals: proposals ?? prev.proposals ?? [] }))
  }, [])

  usePolling(load, refreshInterval())
  useRealtimeTable(['cells', 'gateways', 'devices'], load, { enabled: REALTIME_ENABLED })

  return useMemo(
    () => navSignalsFrom({ ...lists, alerts }, { hasPermission, userRole, userId }),
    [lists, alerts, hasPermission, userRole, userId]
  )
}
