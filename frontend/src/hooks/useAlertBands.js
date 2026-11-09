import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { occurrenceRow } from '../utils/alertHistory'
import { alertBands, alertBandsPlugin } from '../components/common/alertBands'

const NO_PLUGINS = Object.freeze([])
const NO_IDS = Object.freeze([])

/**
 * The occurrences of the devices or gateways `sparkplugIds` over a chart's window, read from
 * alert_occurrences() (0243) as the Alerts tab reads them. `span` is the read the charts drew,
 * `{ start, end, at }` in milliseconds, or null before one: the alerts are read again with each
 * read, so Refresh and the timer reach them too. A failed read gives none, and the charts go on
 * without it. The ids are compared by value: a new array of the same ids is the same read.
 */
function useOccurrences(sparkplugIds, span) {
  const [rows, setRows] = useState(null)
  const start = span?.start
  const end = span?.end
  const at = span?.at
  const key = sparkplugIds.join('\n')

  useEffect(() => {
    if (!key || !(end > start)) {
      setRows(null)
      return undefined
    }
    const controller = new AbortController()
    // A thunk, so a build or a stub without the method reads as no alerts rather than throwing.
    Promise.resolve().then(() => api.readAlertOccurrences(
      { from: new Date(start).toISOString(), to: new Date(end).toISOString(), sparkplugIds: key.split('\n') },
      { signal: controller.signal },
    ))
      .then(data => { if (!controller.signal.aborted) setRows((data || []).map(occurrenceRow)) })
      .catch(() => { if (!controller.signal.aborted) setRows(null) })
    return () => controller.abort()
  }, [key, start, end, at])

  return rows
}

/**
 * The periods an alert on one device or gateway was firing over a chart's window, and the uPlot
 * plugin that shades them. A band still firing runs to the read's moment, where the lines stop.
 *
 * Returns `{ bands, plugins }`: alertBands(), and the plugins to pass each chart, the same array
 * while the bands are the same.
 */
export function useAlertBands(sparkplugId, span) {
  const ids = useMemo(() => (sparkplugId ? [sparkplugId] : NO_IDS), [sparkplugId])
  const rows = useOccurrences(ids, span)
  const start = span?.start
  const end = span?.end
  const at = span?.at
  const bands = useMemo(() => (rows && end > start ? alertBands(rows, { start, end, now: at ?? end }) : []), [rows, start, end, at])
  const plugins = useMemo(() => (bands.length ? [alertBandsPlugin(bands)] : NO_PLUGINS), [bands])
  return { bands, plugins }
}

/**
 * The same for several devices in one read, for the charts of a cell's machines: a Map of each
 * Sparkplug id to its `{ bands, plugins }`, and `count`, how many alerts fired across them all.
 */
export function useAlertBandsFor(sparkplugIds, span) {
  const rows = useOccurrences(sparkplugIds, span)
  const start = span?.start
  const end = span?.end
  const at = span?.at
  return useMemo(() => {
    const byId = new Map()
    const all = new Set()
    if (rows && end > start) {
      for (const id of sparkplugIds) {
        const bands = alertBands(rows.filter(r => r.sparkplug_id === id), { start, end, now: at ?? end })
        if (bands.length) byId.set(id, { bands, plugins: [alertBandsPlugin(bands)] })
        for (const b of bands) all.add(b.id)
      }
    }
    return { byId, count: all.size }
    // The ids by value: a new array of the same ids is the same bands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, start, end, at, sparkplugIds.join('\n')])
}
