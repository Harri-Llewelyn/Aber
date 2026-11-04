import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api'
import { ToolbarPopover } from '../common/FiltersPopover'
import { SearchInput } from '../common/SearchInput'
import { TimeWindowControl } from '../common/TimeWindowControl'
import { TimeSeriesChart } from '../common/TimeSeriesChart'
import { RefreshButton } from '../common/RefreshButton'
import { ClearFilters } from '../common/ClearFilters'
import { FilterDropdown } from '../common/FilterChecklist'
import { Tooltip } from '../common/Tooltip'
import { EmptyState } from '../common/EmptyState'
import { LoadingState } from '../common/LoadingState'
import { OverflowText } from '../common/OverflowText'
import { RouteLink } from '../common/RouteLink'
import { IconChartLine, IconCpu } from '../common/Icons'
import { useClockTick } from '../../hooks/useClockTick'
import { usePolling } from '../../hooks/usePolling'
import { navigate, useUrlList, useUrlState } from '../../hooks/useUrlState'
import { holdsNow, sameWindow, windowBounds, windowWords } from '../../utils/timeWindow'
import {
  DEFAULT_HISTORY_WINDOW, ENDED_WINDOW_REASON, HISTORY_BUCKETS, HISTORY_RANGES, HISTORY_REFRESH_EVERY, HISTORY_SPANS,
  TOO_MANY_BUCKETS, bucketOptions, bucketStarts, chartSeries, chartSummary, deviceMatches, deviceMetrics, inReads,
  pickResolution, pickedAddress, resolutionFor, validRanges,
} from '../../utils/history'

/** How often the page looks at the clock, so the now marker follows it. */
const CLOCK_MS = 60 * 1000

/** The toolbar's device: its name, opening a list of the others to chart instead, at the same view. */
function DeviceSwitcher({ device, devices, win, chosen, bucket }) {
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
                  to={pickedAddress(d.asset_id, win, { metrics: chosen, bucket })}
                  className={`history-device-option${d.asset_id === device.asset_id ? ' is-current' : ''}`}
                  aria-current={d.asset_id === device.asset_id ? 'true' : undefined}
                  onNavigate={() => { close(); navigate(pickedAddress(d.asset_id, win, { metrics: chosen, bucket })) }}
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

/**
 * Buckets in the toolbar: Auto or one size, in the time window's popover frame. A size finer than
 * Auto's pick is listed but off (`aria-disabled`, keeping its Tab stop), and its tooltip says why.
 */
function BucketChoice({ value, options, onChange }) {
  const chosen = options.find(o => o.value === value) ?? options[0]
  return (
    <ToolbarPopover
      label="Choose the bucket size"
      buttonLabel={`Buckets: ${chosen.label}`}
      buttonClass="btn btn-sm btn-ghost control-md history-bucket-pick"
      tip="Auto takes the finest buckets that fit one read of the metrics chosen"
      button={<OverflowText>{chosen.label}</OverflowText>}
    >
      {({ close }) => (
        <div className="history-bucket-choices" role="group" aria-label="Buckets">
          {options.map(o => (
            <Tooltip key={o.value} text={o.on ? null : TOO_MANY_BUCKETS}>
              <button
                type="button"
                className={`btn btn-sm ${o.value === value ? 'btn-primary' : 'btn-ghost'}${o.on ? '' : ' btn-disabled'}`}
                aria-pressed={o.value === value}
                aria-disabled={o.on ? undefined : 'true'}
                onClick={() => { if (o.on) { onChange(o.value); close() } }}
              >
                {o.label}
              </button>
            </Tooltip>
          ))}
        </div>
      )}
    </ToolbarPopover>
  )
}

/** A unit for each metric, from the catalog, by name. */
const unitsOf = (catalog) => new Map((catalog || []).map(m => [m.name, m.units ?? null]))

/** No metric chosen: every metric is charted. Hoisted: useUrlList's default is compared, not copied. */
const ALL_METRICS = Object.freeze([])

/** The status line: how many metrics are charted, of how many, and in which buckets. */
function metaWords({ names, total, resolution, refused }) {
  const count = names.length < total ? `${names.length} of ${total} metrics` : `${total} metric${total === 1 ? '' : 's'}`
  const why = refused ? `: ${refused.words} are too many for this window` : ''
  return `${count}, in ${resolution.words}${why}`
}

/**
 * The Device tab with a device chosen: one chart per metric over the window, stacked on one time
 * axis. The toolbar's Metrics filter narrows the charts, and Buckets takes Auto, the finest the row
 * cap allows for the metrics chosen, or a coarser one. Both are in the address, with the window.
 * The page says which resolution it shows. A read is made again when the device, the window, the
 * metrics or the buckets change, on Refresh, and on the refresh timer while the window reaches
 * now; never on a re-render. `every` is the timer, in seconds, held by the page so it outlasts a
 * change of device.
 */
export function HistoryDevice({ device, devices, schemas, catalog, win, setWin, every, setEvery }) {
  useClockTick(CLOCK_MS)
  const now = Date.now()
  const metrics = useMemo(() => deviceMetrics(device, schemas), [device, schemas])
  const ranges = useMemo(() => validRanges(device, schemas), [device, schemas])
  const units = useMemo(() => unitsOf(catalog), [catalog])
  const [chosen, setChosen] = useUrlList('metric', ALL_METRICS, { allowed: metrics })
  const [bucket, setBucket] = useUrlState('bucket', 'auto', { allowed: HISTORY_BUCKETS })
  const names = useMemo(() => (chosen.length ? metrics.filter(m => chosen.includes(m)) : metrics), [metrics, chosen])
  const [reading, setReading] = useState(null)
  // Each read's number: only the newest may land, so a slow read never draws over a later one.
  const latestRead = useRef(0)

  const namesKey = names.join('\n')
  const windowKey = JSON.stringify(win)
  const read = useCallback(async (signal) => {
    const id = ++latestRead.current
    const at = Date.now()
    const { start, end } = windowBounds(win, at)
    if (!start || !end || end <= start) {
      setReading({ problem: 'Set both ends of the custom range to chart it.' })
      return
    }
    const { resolution, refused } = resolutionFor(start.getTime(), end.getTime(), names.length, bucket)
    if (!resolution) {
      setReading({ problem: 'This window is too long to chart. At 1-day buckets, one metric would need more buckets than one read may carry. Choose a shorter window.' })
      return
    }
    const span = { start: start.getTime(), end: end.getTime(), resolution, refused, at, names, windowText: windowWords(win, at) }
    if (names.length === 0) {
      setReading({ ...span, byMetric: new Map(), reads: 0 })
      return
    }
    setReading(r => ({ ...(r?.byMetric ? r : {}), loading: true }))
    const reads = inReads(names, resolution.perRead)
    try {
      const parts = await Promise.all(reads.map(group => api.readCarriedTelemetry({
        from: start.toISOString(),
        to: end.toISOString(),
        bucketMinutes: resolution.minutes,
        assetIds: [device.asset_id],
        metricNames: group,
      }, { signal })))
      if (id !== latestRead.current) return
      const byMetric = new Map()
      for (const row of parts.flat()) {
        if (!byMetric.has(row.metric_name)) byMetric.set(row.metric_name, [])
        byMetric.get(row.metric_name).push(row)
      }
      setReading({ ...span, byMetric, reads: reads.length })
    } catch (e) {
      if (e?.name !== 'AbortError' && !signal?.aborted && id === latestRead.current) {
        setReading({ ...span, error: e?.message || 'The readings could not be read.' })
      }
      // Rethrown so usePolling backs off on a failing read rather than hammering it.
      throw e
    }
    // The window and the metrics by value: a new object of the same window is the same read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.asset_id, namesKey, windowKey, bucket])

  useEffect(() => {
    const controller = new AbortController()
    read(controller.signal).catch(() => {})
    return () => controller.abort()
  }, [read])

  // The timer runs only while the window reaches now: an ended window cannot gain a reading.
  const live = holdsNow(win, now)
  usePolling(read, every * 1000, live && every > 0)

  // What Buckets offers for the window and the metrics chosen now: Auto's pick and coarser.
  const { start: shownStart, end: shownEnd } = windowBounds(win, now)
  const auto = shownStart && shownEnd && shownEnd > shownStart
    ? pickResolution(shownStart.getTime(), shownEnd.getTime(), names.length)
    : null

  const filterCount = [!sameWindow(win, DEFAULT_HISTORY_WINDOW), chosen.length > 0, bucket !== 'auto'].filter(Boolean).length
  const clear = () => { setWin(DEFAULT_HISTORY_WINDOW); setChosen(ALL_METRICS); setBucket('auto') }

  const starts = useMemo(
    () => (reading?.byMetric ? bucketStarts(reading.start, reading.end, reading.resolution.minutes) : []),
    [reading]
  )
  const charts = useMemo(() => {
    if (!reading?.byMetric) return []
    return reading.names.map(name => {
      const series = chartSeries(reading.byMetric.get(name) || [], starts)
      const unit = units.get(name) ?? null
      const validRange = ranges.get(name) ?? null
      return {
        name, unit, series, validRange,
        summary: chartSummary({
          metric: name, unit, windowText: reading.windowText, resolution: reading.resolution, series, validRange, starts,
          span: { start: reading.start, end: reading.end, now: reading.at },
        }),
      }
    })
  }, [reading, starts, units, ranges])

  const busy = Boolean(reading?.loading) || reading === null

  return (
    <>
      <div className="filter-bar">
        <DeviceSwitcher device={device} devices={devices} win={win} chosen={chosen} bucket={bucket} />
        <TimeWindowControl value={win} onChange={setWin} ranges={HISTORY_RANGES} spans={HISTORY_SPANS} />
        <FilterDropdown
          label="Metrics"
          noun="metric"
          plural="metrics"
          options={metrics.map(m => ({ value: m, label: m }))}
          value={chosen}
          onChange={setChosen}
          words={v => (v.length === 0 ? 'All metrics' : null)}
          width="md"
          tip="Chart only the metrics you choose. Fewer metrics fit finer buckets."
        />
        <BucketChoice value={bucket} options={bucketOptions(auto)} onChange={setBucket} />
        <div className="filter-bar-actions">
          <ClearFilters count={filterCount} onClear={clear} />
          <RefreshButton
            onRefresh={() => read().catch(() => {})}
            busy={busy}
            every={live ? every : 0}
            onEveryChange={setEvery}
            choices={HISTORY_REFRESH_EVERY}
            everyDisabledReason={live ? null : ENDED_WINDOW_REASON}
          />
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
            {metaWords({ names: reading.names, total: metrics.length, resolution: reading.resolution, refused: reading.refused })}
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
