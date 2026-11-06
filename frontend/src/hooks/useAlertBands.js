import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { occurrenceRow } from '../utils/alertHistory'
import { alertBands, alertBandsPlugin } from '../components/common/alertBands'

const NO_PLUGINS = Object.freeze([])

/**
 * The periods an alert on one device or gateway was firing over a chart's window, read from
 * alert_occurrences() (0243) as the Alerts tab reads them, and the uPlot plugin that shades them.
 * `span` is the read the charts drew, `{ start, end, at }` in milliseconds, or null before one: the
 * alerts are read again with each read, so Refresh and the timer reach them too, and a band still
 * firing runs to the read's moment, where the lines stop. A failed read shades nothing, and the
 * charts go on without it.
 *
 * Returns `{ bands, plugins }`: alertBands(), and the plugins to pass each chart, the same array
 * while the bands are the same.
 */
export function useAlertBands(sparkplugId, span) {
  const [rows, setRows] = useState(null)
  const start = span?.start
  const end = span?.end
  const at = span?.at

  useEffect(() => {
    if (!sparkplugId || !(end > start)) {
      setRows(null)
      return undefined
    }
    const controller = new AbortController()
    // A thunk, so a build or a stub without the method reads as no alerts rather than throwing.
    Promise.resolve().then(() => api.readAlertOccurrences(
      { from: new Date(start).toISOString(), to: new Date(end).toISOString(), sparkplugIds: [sparkplugId] },
      { signal: controller.signal },
    ))
      .then(data => { if (!controller.signal.aborted) setRows((data || []).map(occurrenceRow)) })
      .catch(() => { if (!controller.signal.aborted) setRows(null) })
    return () => controller.abort()
  }, [sparkplugId, start, end, at])

  const bands = useMemo(() => (rows && end > start ? alertBands(rows, { start, end, now: at ?? end }) : []), [rows, start, end, at])
  const plugins = useMemo(() => (bands.length ? [alertBandsPlugin(bands)] : NO_PLUGINS), [bands])
  return { bands, plugins }
}
