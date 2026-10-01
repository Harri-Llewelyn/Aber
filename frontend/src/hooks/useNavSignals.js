import { useCallback, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { PERMISSION_UUIDS, REALTIME_ENABLED, refreshInterval } from '../constants'
import { usePolling } from './usePolling'
import { useRealtimeTable } from './useRealtimeTable'
import { gatewayFleetCounts, deviceFleetCounts } from '../utils/fleetCounts'
import { canDecide } from '../components/tabs/ApprovalsTab'

/**
 * What the rail should flag for the person looking, from the lists the pages read. A signal is a
 * condition its page already reports as a banner or a queue, shown only to a viewer who can act on
 * it, with the same permission the page gates that action on: a device in quarantine for one who
 * may approve or reject it, an offline gateway for one who may manage gateways, a cell in no area
 * for one who may manage cells, an open proposal for one who may decide it and did not file it.
 * `count` is the number shown beside the icon; `note` is the words, carried on the item's title
 * and label, so the colour is never the only signal. `viewer` is { hasPermission, userRole, userId };
 * without one nothing is flagged. Pure, so it is testable without a network.
 */
export function navSignalsFrom({ cells = [], gateways = [], devices = [], proposals = [] } = {}, viewer = {}) {
  const { hasPermission = () => false, userRole = null, userId = null } = viewer
  const signals = {}
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

  const dev = deviceFleetCounts(devices)
  if (dev.quarantined > 0 && (hasPermission(PERMISSION_UUIDS.QUARANTINE_APPROVE) || hasPermission(PERMISSION_UUIDS.QUARANTINE_REJECT))) {
    signals.devices = { tone: 'warning', count: dev.quarantined, note: `${plural(dev.quarantined, 'device')} awaiting zero-touch onboarding approval` }
  }

  // Awaiting setup is not offline: a gateway waiting for its bundle is an unfinished task, not a
  // fault (fleetCounts.js keeps the two apart).
  const gw = gatewayFleetCounts(gateways)
  if (gw.offline > 0 && hasPermission(PERMISSION_UUIDS.GATEWAY_MANAGE)) {
    signals.gateways = { tone: 'warning', count: gw.offline, note: `${plural(gw.offline, 'gateway')} offline` }
  }

  const unfiled = cells.filter(c => !c.is_archived && !c.area_id).length
  if (unfiled > 0 && hasPermission(PERMISSION_UUIDS.CELL_MANAGE)) {
    signals.areas = { tone: 'warning', count: unfiled, note: `${plural(unfiled, 'cell')} in no area` }
  }

  // The Approvals page's own test, `canDecide`, minus the viewer's own requests: waiting on
  // somebody else is not work.
  const waiting = proposals.filter(p => p.status === 'open' && p.proposed_by !== userId && canDecide(p.entity_type, userRole)).length
  if (waiting > 0) {
    signals.approvals = { tone: 'warning', count: waiting, note: `${plural(waiting, 'proposal')} waiting for a decision` }
  }

  return signals
}

/**
 * The rail's signals, kept current the way a tab keeps its table current: Realtime on the three
 * tables the publication carries, with the poll as the reconciler (and the only source for
 * proposals, which are not published). Owned by App, so the flag is visible whichever page is
 * open. The lists are kept and the signals derived from them, so a late-arriving permission
 * re-flags without a read. A failed read keeps the last answer rather than clearing it.
 */
export function useNavSignals({ hasPermission, userRole, userId } = {}) {
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
    () => navSignalsFrom(lists, { hasPermission, userRole, userId }),
    [lists, hasPermission, userRole, userId]
  )
}
