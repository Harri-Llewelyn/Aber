import { useEffect, useState } from 'react'

/**
 * Re-render on an interval without fetching. Heartbeat staleness and the "12s ago" labels are
 * computed from the wall clock at render time, and nothing in the database changes when a gateway
 * stops beating, so no Realtime event or refetch would surface it.
 *
 * @param {number} intervalMs
 *
 * @param {boolean} [enabled=true]
 *
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
