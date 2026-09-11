import { useCallback, useState } from 'react'
import { api } from '../api'
import { REALTIME_ENABLED, refreshInterval } from '../constants'
import { usePolling } from './usePolling'
import { useRealtimeTable } from './useRealtimeTable'
import { gatewayFleetCounts, deviceFleetCounts } from '../utils/fleetCounts'

/**
 * What the rail should flag, from the lists the pages read. Each signal is a condition its page
 * already reports as a banner or a queue, so the rail says where the work is before the page is
 * opened: a device held in quarantine, a gateway that should be reporting and is not, a cell in
 * no area. `note` is the words, carried on the item's title and label, so the colour is never the
 * only signal. Pure, so it is testable without a network.
 */
export function navSignalsFrom({ cells = [], gateways = [], devices = [] } = {}) {
  const signals = {}
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

  const dev = deviceFleetCounts(devices)
  if (dev.quarantined > 0) {
    signals.devices = { tone: 'warning', note: `${plural(dev.quarantined, 'device')} awaiting zero-touch onboarding approval` }
  }

  // Awaiting setup is not offline: a gateway waiting for its bundle is an unfinished task, not a
  // fault (fleetCounts.js keeps the two apart).
  const gw = gatewayFleetCounts(gateways)
  if (gw.offline > 0) {
    signals.gateways = { tone: 'warning', note: `${plural(gw.offline, 'gateway')} offline` }
  }

  const unfiled = cells.filter(c => !c.is_archived && !c.area_id).length
  if (unfiled > 0) {
    signals.areas = { tone: 'warning', note: `${plural(unfiled, 'cell')} in no area` }
  }

  return signals
}

/**
 * The rail's signals, kept current the way a tab keeps its table current: Realtime on the three
 * tables, with the poll as the reconciler. Owned by App, so the flag is visible whichever page is
 * open. A failed read keeps the last answer rather than clearing it.
 */
export function useNavSignals() {
  const [signals, setSignals] = useState({})

  const load = useCallback(async (signal) => {
    const [cells, gateways, devices] = await Promise.all([
      api.get('/api/v1/cells', { signal }),
      api.get('/api/v1/gateways', { signal }),
      api.get('/api/v1/devices', { signal })
    ])
    setSignals(navSignalsFrom({ cells, gateways, devices }))
  }, [])

  usePolling(load, refreshInterval())
  useRealtimeTable(['cells', 'gateways', 'devices'], load, { enabled: REALTIME_ENABLED })

  return signals
}
