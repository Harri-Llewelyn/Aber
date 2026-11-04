import React, { useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import { ToolbarPopover } from '../common/FiltersPopover'
import { SearchInput } from '../common/SearchInput'
import { TimeWindowControl } from '../common/TimeWindowControl'
import { TimeSeriesChart } from '../common/TimeSeriesChart'
import { EmptyState } from '../common/EmptyState'
import { LoadingState } from '../common/LoadingState'
import { OverflowText } from '../common/OverflowText'
import { RouteLink } from '../common/RouteLink'
import { IconChartLine, IconCpu, IconRefreshCw } from '../common/Icons'
import { useClockTick } from '../../hooks/useClockTick'
import { navigate } from '../../hooks/useUrlState'
import { windowBounds, windowWords } from '../../utils/timeWindow'
import {
  HISTORY_RANGES, HISTORY_SPANS, bucketStarts, chartSeries, chartSummary, deviceMatches, deviceMetrics, inReads,
  pickResolution, pickedAddress, validRanges,
} from '../../utils/history'

/** How often the page looks at the clock, so the now marker follows it. */
const CLOCK_MS = 60 * 1000

/** The toolbar's device: its name, opening a list of the others to chart instead. */
function DeviceSwitcher({ device, devices, win }) {
  const [search, setSearch] = useState('')
  const shown = devices.filter(d => deviceMatches(d, search))
  return (
    <ToolbarPopover
      label="Choose a device"
      buttonLabel={`Device: ${device.asset_name}`}
      buttonClass="btn btn-sm btn-ghost control-lg history-device-pick"
      tip="Chart another device"
      button={<><IconCpu size={13} aria-hidden="true" /><OverflowText>{device.asset_name}</OverflowText></>}
    >
      {({ close }) => (
        <>
          <SearchInput value={search} onChange={setSearch} placeholder="Find a device…" ariaLabel="Find a device" width="md" />
          <ul className="history-device-list">
            {shown.map(d => (
              <li key={d.asset_id}>
                <RouteLink
                  to={pickedAddress(d.asset_id, win)}
                  className={`history-device-option${d.asset_id === device.asset_id ? ' is-current' : ''}`}
                  aria-current={d.asset_id === device.asset_id ? 'true' : undefined}
                  onNavigate={() => { close(); navigate(pickedAddress(d.asset_id, win)) }}
                >
                  <OverflowText>{d.asset_name}</OverflowText>
                  {(d.cell_name || d.area_name) && (
                    <span className="history-device-place">{[d.cell_name, d.area_name].filter(Boolean).join(' · ')}</span>
                  )}
                </RouteLink>
              </li>
            ))}
            {shown.length === 0 && <li className="history-device-none">No device matches.</li>}
          </ul>
        </>
      )}
    </ToolbarPopover>
  )
}

/** A unit for each metric, from the catalog, by name. */
const unitsOf = (catalog) => new Map((catalog || []).map(m => [m.name, m.units ?? null]))

/**
 * The Device tab with a device chosen: one chart per metric over the window, stacked on one time
 * axis, at the resolution the row cap picks for all of them. The page says which resolution it
 * shows. A read is made again when the device, the window or Refresh changes, never on a re-render.
 */
export function HistoryDevice({ device, devices, schemas, catalog, win, setWin }) {
  useClockTick(CLOCK_MS)
  const now = Date.now()
  const metrics = useMemo(() => deviceMetrics(device, schemas), [device, schemas])
  const ranges = useMemo(() => validRanges(device, schemas), [device, schemas])
  const units = useMemo(() => unitsOf(catalog), [catalog])
  const [refresh, setRefresh] = useState(0)
  const [reading, setReading] = useState(null)

  const metricsKey = metrics.join('\n')
  const windowKey = JSON.stringify(win)
  useEffect(() => {
    const controller = new AbortController()
    const at = Date.now()
    const { start, end } = windowBounds(win, at)
    if (!start || !end || end <= start) {
      setReading({ problem: 'Set both ends of the custom range to chart it.' })
      return undefined
    }
    const resolution = pickResolution(start.getTime(), end.getTime(), metrics.length)
    if (!resolution) {
      setReading({ problem: 'This window is too long to chart. At 1-day buckets, one metric would need more buckets than one read may carry. Choose a shorter window.' })
      return undefined
    }
    const span = { start: start.getTime(), end: end.getTime(), resolution, at }
    if (metrics.length === 0) {
      setReading({ ...span, byMetric: new Map(), reads: 0 })
      return undefined
    }
    setReading(r => ({ ...(r?.byMetric ? r : {}), loading: true }))
    const reads = inReads(metrics, resolution.perRead)
    Promise.all(reads.map(names => api.readCarriedTelemetry({
      from: start.toISOString(),
      to: end.toISOString(),
      bucketMinutes: resolution.minutes,
      assetIds: [device.asset_id],
      metricNames: names,
    }, { signal: controller.signal })))
      .then(parts => {
        const byMetric = new Map()
        for (const row of parts.flat()) {
          if (!byMetric.has(row.metric_name)) byMetric.set(row.metric_name, [])
          byMetric.get(row.metric_name).push(row)
        }
        setReading({ ...span, byMetric, reads: reads.length })
      })
      .catch(e => {
        if (e?.name === 'AbortError' || controller.signal.aborted) return
        setReading({ ...span, error: e?.message || 'The readings could not be read.' })
      })
    return () => controller.abort()
    // The window and the metric list by value: a new object of the same window is the same read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.asset_id, metricsKey, windowKey, refresh])

  const starts = useMemo(
    () => (reading?.byMetric ? bucketStarts(reading.start, reading.end, reading.resolution.minutes) : []),
    [reading]
  )
  const charts = useMemo(() => {
    if (!reading?.byMetric) return []
    const windowText = windowWords(win, reading.at)
    return metrics.map(name => {
      const series = chartSeries(reading.byMetric.get(name) || [], starts)
      const unit = units.get(name) ?? null
      const validRange = ranges.get(name) ?? null
      return {
        name, unit, series, validRange,
        summary: chartSummary({ metric: name, unit, windowText, resolution: reading.resolution, series, validRange }),
      }
    })
    // `win` is read for its words only; the read it belongs to is `reading`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reading, starts, metrics, units, ranges])

  const busy = Boolean(reading?.loading) || reading === null

  return (
    <>
      <div className="filter-bar">
        <DeviceSwitcher device={device} devices={devices} win={win} />
        <TimeWindowControl value={win} onChange={setWin} ranges={HISTORY_RANGES} spans={HISTORY_SPANS} />
        <div className="filter-bar-actions">
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setRefresh(n => n + 1)} disabled={busy}>
            <IconRefreshCw size={13} aria-hidden="true" /> Refresh
          </button>
        </div>
      </div>

      {reading?.problem ? (
        <EmptyState icon={<IconChartLine size={36} />} message={reading.problem} />
      ) : reading?.error ? (
        <div className="callout callout-danger">{`The readings could not be read: ${reading.error}`}</div>
      ) : !reading?.byMetric ? (
        <LoadingState label="readings" />
      ) : metrics.length === 0 ? (
        <EmptyState
          icon={<IconChartLine size={36} />}
          message="This device has declared no metrics, and no schema attached to it models any, so there is nothing to chart."
        />
      ) : (
        <>
          <p className="history-meta" role="status">
            {`${metrics.length} metric${metrics.length === 1 ? '' : 's'}, in ${reading.resolution.words}`}
            {reading.reads > 1 && `, read in ${reading.reads} parts`}
            {reading.loading && ' · reading again…'}
          </p>
          <div className="history-charts">
            {charts.map(c => (
              <TimeSeriesChart
                key={c.name}
                metric={c.name}
                unit={c.unit}
                starts={starts}
                series={c.series}
                start={reading.start}
                end={reading.end}
                now={now}
                minutes={reading.resolution.minutes}
                validRange={c.validRange}
                summary={c.summary}
                syncKey={`history-${device.asset_id}`}
              />
            ))}
          </div>
        </>
      )}
    </>
  )
}
