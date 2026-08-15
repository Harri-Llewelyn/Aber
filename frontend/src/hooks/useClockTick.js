import { useEffect, useState } from 'react'

/**
 * Re-render on an interval without fetching anything.
 *
 * Some rendered state is a function of the wall clock rather than of data: gateway heartbeat
 * staleness (utils/gatewayStatus.js) and the "12s ago" labels next to it are computed from
 * NOW() at render time. Nothing changes in the database when a gateway simply stops beating,
 * so no Realtime event is emitted and no refetch is triggered -- and that silence is exactly
 * the case the STALE badge exists to surface.
 *
 * With a 3s poll this was free -- it re-rendered these tabs constantly. At a 60s
 * reconciliation interval a silent gateway could sit un-flagged for ~120s (the 90s threshold
 * plus up to a full poll interval). This restores prompt detection at zero network cost.
 *
 * @param {number} intervalMs
 * @param {boolean} [enabled=true]
 * @returns {number} An incrementing counter; read it (or ignore it) to depend on the tick.
 */
export function useClockTick(intervalMs, enabled = true) {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!enabled || !intervalMs) return
    const id = setInterval(() => setTick(t => t + 1), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs, enabled])

  return tick
}
