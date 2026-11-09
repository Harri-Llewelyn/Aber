import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { HISTORY_CHANGE_SERIES, api } from '../../api'
import { ToolbarPopover } from '../common/FiltersPopover'
import { SearchInput } from '../common/SearchInput'
import { TimeWindowControl } from '../common/TimeWindowControl'
import { RefreshButton } from '../common/RefreshButton'
import { ClearFilters } from '../common/ClearFilters'
import { GroupHeading } from '../common/GroupHeading'
import { ExpandAllToggle } from '../common/ExpandAllToggle'
import { EmptyState } from '../common/EmptyState'
import { LoadingState } from '../common/LoadingState'
import { OverflowText } from '../common/OverflowText'
import { RouteLink } from '../common/RouteLink'
import { AlertKey } from '../common/AlertKey'
import { SmallMultiples } from '../common/SmallMultiples'
import { HourHeatmap } from '../common/HourHeatmap'
import { IconChartLine, IconCpu, IconLayoutDashboard } from '../common/Icons'
import { useClockTick } from '../../hooks/useClockTick'
import { usePolling } from '../../hooks/usePolling'
import { useChartBand } from '../../hooks/useChartBand'
import { useAlertBandsFor } from '../../hooks/useAlertBands'
import { alertsAddress } from '../../utils/alertHistory'
import { navigate, useUrlState } from '../../hooks/useUrlState'
import { holdsNow, sameWindow, windowBounds, windowWords } from '../../utils/timeWindow'
import {
  DEFAULT_HISTORY_WINDOW, ENDED_WINDOW_REASON, HISTORY_RANGES, HISTORY_REFRESH_EVERY, HISTORY_SPANS, bucketStarts, browserTimeZone,
  cellAddress, cellMetrics, changeSeries, chartSeries, datatypeKind, defaultCellMetric, deviceMetrics, hourGrid,
  hourOfDayPlan, inReads, markBuckets, multiplesWords, pickedAddress, pickResolution, readWords, silentWords, stateReadLine,
  telemetryKey, validRanges,
} from '../../utils/history'

/** How often the page looks at the clock, so the now marker follows it. */
const CLOCK_MS = 60 * 1000

/** The two sections of the tab, by the key each is opened and closed by. */
const SECTIONS = ['machines', 'hours']

/** A metric's unit from the catalog, by name. */
const unitsOf = (catalog) => new Map((catalog || []).map(m => [m.name, m.units ?? null]))

/** The toolbar's cell: its name, opening a list of the others to look at instead, at the same view. */
function CellSwitcher({ cell, cells, win, metric }) {
  const [search, setSearch] = useState('')
  const needle = search.trim().toLowerCase()
  const shown = cells.filter(c => !needle || `${c.name} ${c.area_name ?? ''}`.toLowerCase().includes(needle))
  return (
    <ToolbarPopover
      label="Choose a cell"
      buttonLabel={`Cell: ${cell.name}`}
      buttonClass="btn btn-sm btn-ghost control-md history-device-pick"
      tip="Compare the machines of another cell"
      button={<><IconLayoutDashboard size={13} aria-hidden="true" /><OverflowText>{cell.name}</OverflowText></>}
    >
      {({ close }) => (
        <>
          <SearchInput value={search} onChange={setSearch} placeholder="Find a cell…" ariaLabel="Find a cell" width="md" />
          <ul className="history-device-list">
            {shown.map(c => {
              const to = cellAddress(c.cell_id, win, { metric })
              return (
                <li key={c.cell_id}>
                  <RouteLink
                    to={to}
                    className={`history-device-option${c.cell_id === cell.cell_id ? ' is-current' : ''}`}
                    aria-current={c.cell_id === cell.cell_id ? 'true' : undefined}
                    onNavigate={() => { close(); navigate(to) }}
                  >
                    <OverflowText>{c.name}</OverflowText>
                    <span className="history-device-place">
                      {[c.area_name, `${c.machines.length} ${c.machines.length === 1 ? 'machine' : 'machines'}`, c.is_archived ? 'Archived' : null].filter(Boolean).join(' · ')}
                    </span>
                  </RouteLink>
                </li>
              )
            })}
            {shown.length === 0 && <li className="history-device-none">No cell matches.</li>}
          </ul>
        </>
      )}
    </ToolbarPopover>
  )
}

/** The toolbar's metric: its name, opening the metrics the cell's machines report, each with how many do. */
function MetricSwitcher({ cell, metrics, metric, win, total }) {
  const [search, setSearch] = useState('')
  const needle = search.trim().toLowerCase()
  const shown = metrics.filter(m => !needle || m.name.toLowerCase().includes(needle))
  return (
    <ToolbarPopover
      label="Choose a metric"
      buttonLabel={`Metric: ${metric}`}
      buttonClass="btn btn-sm btn-ghost control-md history-device-pick"
      tip="Compare another metric across these machines"
      button={<OverflowText>{metric}</OverflowText>}
    >
      {({ close }) => (
        <>
          <SearchInput value={search} onChange={setSearch} placeholder="Find a metric…" ariaLabel="Find a metric" width="md" />
          <ul className="history-device-list">
            {shown.map(m => {
              const to = cellAddress(cell.cell_id, win, { metric: m.name })
              return (
                <li key={m.name}>
                  <RouteLink
                    to={to}
                    className={`history-device-option${m.name === metric ? ' is-current' : ''}`}
                    aria-current={m.name === metric ? 'true' : undefined}
                    onNavigate={() => { close(); navigate(to) }}
                  >
                    <OverflowText>{m.name}</OverflowText>
                    <span className="history-device-place">{`${m.count} of ${total} ${total === 1 ? 'machine' : 'machines'}`}</span>
                  </RouteLink>
                </li>
              )
            })}
            {shown.length === 0 && <li className="history-device-none">No metric matches.</li>}
          </ul>
        </>
      )}
    </ToolbarPopover>
  )
}

/**
 * The Cell tab with a cell chosen: one metric across the machines in it, compared. Two sections.
 *
 * - **Over the window:** one chart a machine, on one time axis and one value scale (SmallMultiples),
 *   so the outlier shows. One telemetry_carried() read for every machine that reports the metric,
 *   at the finest resolution whose buckets times machines fit the row cap, and the status line says
 *   which. A text or flag metric draws every change per machine, as the Device tab does
 *   (telemetry_changes()). A machine that does not report the metric says so in words.
 * - **By hour of the day:** a row a machine, a column an hour, the metric's mean at that hour across
 *   the window's days in this browser's time zone (telemetry_hour_of_day(), HourHeatmap). A number
 *   metric only. Its window is limited by what that read takes (hourOfDayPlan()), said in words
 *   where it is over, and the charts above are unaffected.
 *
 * The metric is in the address (`metric`), with the window; the page opens on the metric most
 * machines report. A read is made again when the cell, the metric or the window changes, on
 * Refresh, and on the refresh timer while the window reaches now. The window zooms as the Device
 * tab's does: the time control's buttons, and a drag across any chart.
 */
export function HistoryCell({ cell, cells, schemas, catalog, win, setWin, every, setEvery }) {
  useClockTick(CLOCK_MS)
  const now = Date.now()
  const machines = cell.machines
  const metricList = useMemo(() => cellMetrics(machines, schemas), [machines, schemas])
  const metricNames = useMemo(() => metricList.map(m => m.name), [metricList])
  const [chosen, setChosen] = useUrlState('metric', '', { allowed: metricNames })
  const metric = chosen || defaultCellMetric(metricList)
  const units = useMemo(() => unitsOf(catalog), [catalog])
  const unit = units.get(metric) ?? null
  const kind = useMemo(() => datatypeKind((catalog || []).find(m => m.name === metric)?.datatype), [catalog, metric])
  const stateKind = kind === 'text' || kind === 'flag'

  // Who reports the metric: charted and read. The rest are named in words.
  const reporters = useMemo(() => machines.filter(d => deviceMetrics(d, schemas).includes(metric)), [machines, schemas, metric])
  const keys = useMemo(() => reporters.map(telemetryKey), [reporters])
  const keysKey = keys.join('\n')

  const [reading, setReading] = useState(null)
  const [heat, setHeat] = useState(null)
  const [closed, setClosed] = useState(() => new Set())
  const sectionsId = useId()
  // Each read's number: only the newest may land, so a slow read never draws over a later one.
  const latestRead = useRef(0)
  const latestHeat = useRef(0)
  const windowKey = JSON.stringify(win)

  const read = useCallback(async (signal) => {
    const id = ++latestRead.current
    const at = Date.now()
    const { start, end } = windowBounds(win, at)
    if (!start || !end || end <= start) {
      setReading({ problem: 'Set both ends of the custom range to compare the machines over it.' })
      return
    }
    const picked = keys.length ? pickResolution(start.getTime(), end.getTime(), keys.length) : null
    if (keys.length && !picked) {
      setReading({ problem: 'This window is too long to chart. At 1-day buckets, one machine would need more buckets than one read may carry. Choose a shorter window.' })
      return
    }
    const resolution = picked ?? pickResolution(start.getTime(), end.getTime(), 1)
    const span = { start: start.getTime(), end: end.getTime(), resolution, at, keys, metric, unit, kind, windowText: windowWords(win, at) }
    if (keys.length === 0) {
      setReading({ ...span, byAsset: new Map(), changes: new Map(), reads: 0 })
      return
    }
    setReading(r => ({ ...(r?.byAsset ? r : {}), loading: true }))
    const bounds = { from: start.toISOString(), to: end.toISOString(), bucketMinutes: resolution.minutes, metricNames: [metric] }
    const parts = inReads(keys, resolution.perRead)
    const changeParts = stateKind ? inReads(keys, HISTORY_CHANGE_SERIES) : []
    try {
      const [rows, changeRows] = await Promise.all([
        Promise.all(parts.map(assetIds => api.readCarriedTelemetry({ ...bounds, assetIds }, { signal }))),
        Promise.all(changeParts.map(assetIds => api.readTelemetryChanges({ ...bounds, assetIds }, { signal }))),
      ])
      if (id !== latestRead.current) return
      const byAsset = new Map()
      for (const row of rows.flat()) {
        if (!byAsset.has(row.asset_id)) byAsset.set(row.asset_id, [])
        byAsset.get(row.asset_id).push(row)
      }
      setReading({ ...span, byAsset, changes: new Map(changeRows.flat().map(row => [row.asset_id, row])), reads: parts.length })
    } catch (e) {
      if (e?.name !== 'AbortError' && !signal?.aborted && id === latestRead.current) {
        setReading({ ...span, error: e?.message || 'The readings could not be read.' })
      }
      // Rethrown so usePolling backs off on a failing read rather than hammering it.
      throw e
    }
    // The window, the metric and the machines by value: a new object of the same is the same read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cell.cell_id, metric, keysKey, windowKey, stateKind])

  const readHeat = useCallback(async (signal) => {
    const id = ++latestHeat.current
    const at = Date.now()
    const { start, end } = windowBounds(win, at)
    if (!start || !end || end <= start) {
      setHeat({ problem: 'Set both ends of the custom range to see the hours of the day in it.' })
      return
    }
    if (stateKind) {
      setHeat({ needsNumber: true, metric, unit, keys })
      return
    }
    const plan = hourOfDayPlan(start.getTime(), end.getTime(), keys.length)
    if (plan.problem) {
      setHeat({ problem: plan.problem })
      return
    }
    const zone = browserTimeZone()
    if (keys.length === 0) {
      setHeat({ grid: hourGrid([], []), zone, metric, unit, keys })
      return
    }
    setHeat(h => ({ ...(h?.grid ? h : {}), loading: true }))
    try {
      const rows = await api.readHourOfDay({ from: start.toISOString(), to: end.toISOString(), assetIds: keys, metricName: metric, timeZone: zone }, { signal })
      if (id !== latestHeat.current) return
      setHeat({ grid: hourGrid(rows, keys), zone, metric, unit, keys })
    } catch (e) {
      if (e?.name !== 'AbortError' && !signal?.aborted && id === latestHeat.current) {
        setHeat({ error: e?.message || 'The hours of the day could not be read.' })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cell.cell_id, metric, keysKey, windowKey, stateKind])

  useEffect(() => {
    const controller = new AbortController()
    read(controller.signal).catch(() => {})
    return () => controller.abort()
  }, [read])
  useEffect(() => {
    const controller = new AbortController()
    readHeat(controller.signal)
    return () => controller.abort()
  }, [readHeat])

  const readAll = useCallback((signal) => Promise.all([read(signal), readHeat(signal)]), [read, readHeat])
  // The timer runs only while the window reaches now: an ended window cannot gain a reading.
  const live = holdsNow(win, now)
  usePolling(readAll, every * 1000, live && every > 0)

  // The periods an alert on a machine was firing, over the window the charts drew.
  const alertSpan = reading?.byAsset ? { start: reading.start, end: reading.end, at: reading.at } : null
  const alerts = useAlertBandsFor(keys, alertSpan)

  // A drag across a chart: its fractions are of the window the charts draw, the read's.
  const drawnSpan = reading?.byAsset ? { start: reading.start, ms: reading.end - reading.start } : null
  const { band, onPointerDown: startBand } = useChartBand({ span: drawnSpan, setWin, now })

  const members = useMemo(() => {
    if (!reading?.byAsset) return []
    const starts = bucketStarts(reading.start, reading.end, reading.resolution.minutes)
    const span = { start: reading.start, end: reading.end, now: reading.at }
    const readers = new Set(reading.keys)
    return machines.map(d => {
      const key = telemetryKey(d)
      const to = pickedAddress(d.asset_id, win, { metrics: [reading.metric] })
      if (!readers.has(key)) return { key, name: d.asset_name, device: d, to, absent: silentWords(d.asset_name, reading.metric) }
      // Every change when the change read has them; else the buckets, marked where it counted more than one value.
      const change = reading.changes.get(key) ?? null
      const every = changeSeries(change, span)
      const at = every ? every.starts : starts
      const series = every ? every.series : markBuckets(chartSeries(reading.byAsset.get(key) || [], at), at, change)
      return {
        key, name: d.asset_name, device: d, to, series, starts: at, validRange: validRanges(d, schemas).get(reading.metric) ?? null,
        read: readWords(change, reading.resolution),
      }
    })
    // The window only through the read, which names its own: a new window is a new read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reading, machines, schemas])
  // The alert bands apart from the series, so the alerts arriving does not draw every chart again.
  const shown = members.map(m => (m.series ? { ...m, plugins: alerts.byId.get(m.key)?.plugins } : m))
  const stateLine = useMemo(
    () => stateReadLine(members.filter(m => m.read).map(m => ({ kind: reading.kind, words: m.read }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [members]
  )

  // The heatmap's rows are the machines that reported the metric it was read for.
  const heatRows = useMemo(() => machines.map(d => {
    const key = telemetryKey(d)
    return { key, name: d.asset_name, device: d, absent: (heat?.keys ?? []).includes(key) ? null : silentWords(d.asset_name, heat?.metric) }
  }), [machines, heat])

  const setOpen = (list, open) => setClosed(prev => {
    const next = new Set(prev)
    for (const k of list) if (open) next.delete(k); else next.add(k)
    return next
  })
  const filterCount = [!sameWindow(win, DEFAULT_HISTORY_WINDOW), chosen !== ''].filter(Boolean).length
  const clear = () => { setWin(DEFAULT_HISTORY_WINDOW); setChosen('') }
  const busy = Boolean(reading?.loading || heat?.loading) || reading === null

  const sectionId = (key) => `${sectionsId}-${key}`
  const section = (key, label, detail, body) => {
    const open = !closed.has(key)
    return (
      <section key={key} className="history-group" aria-label={label}>
        <div className="history-group-head">
          <GroupHeading open={open} onToggle={() => setOpen([key], !open)} label={label} detail={detail} controls={sectionId(key)} />
        </div>
        <div id={sectionId(key)} className="cell-section" hidden={!open}>{open && body}</div>
      </section>
    )
  }

  const total = machines.length
  const silent = total - keys.length
  // What the sections show is what was read: the metric asked for next waits for its read to land.
  const shownMetric = reading?.metric ?? metric
  const shownUnit = reading ? reading.unit : unit
  const heading = shownUnit ? `${shownMetric} (${shownUnit})` : shownMetric

  return (
    <>
      <div className="filter-bar">
        <CellSwitcher cell={cell} cells={cells} win={win} metric={chosen} />
        <TimeWindowControl value={win} onChange={setWin} ranges={HISTORY_RANGES} spans={HISTORY_SPANS} zoom />
        {metricList.length > 0 && <MetricSwitcher cell={cell} metrics={metricList} metric={metric} win={win} total={total} />}
        <div className="filter-bar-actions">
          <ClearFilters count={filterCount} onClear={clear} />
          <RefreshButton
            onRefresh={() => readAll().catch(() => {})}
            busy={busy}
            every={live ? every : 0}
            onEveryChange={setEvery}
            choices={HISTORY_REFRESH_EVERY}
            everyDisabledReason={live ? null : ENDED_WINDOW_REASON}
          />
        </div>
      </div>

      <div className="history-body card-fill-scroll trail-timeline">
        {total === 0 ? (
          <EmptyState icon={<IconCpu size={36} />} message="No device is in service in this cell, so there are no machines to compare." />
        ) : metricList.length === 0 ? (
          <EmptyState
            icon={<IconChartLine size={36} />}
            message="The machines in this cell have declared no metrics, and no schema attached to them models any, so there is nothing to compare."
          />
        ) : reading?.problem ? (
          <EmptyState icon={<IconChartLine size={36} />} message={reading.problem} />
        ) : reading?.error ? (
          <div className="callout callout-danger">{`The readings could not be read: ${reading.error}`}</div>
        ) : !reading?.byAsset ? (
          <LoadingState label="readings" />
        ) : (
          <>
            <div className="history-header">
              <ExpandAllToggle
                anyOpen={SECTIONS.some(k => !closed.has(k))}
                onExpandAll={() => setOpen(SECTIONS, true)}
                onCollapseAll={() => setOpen(SECTIONS, false)}
                noun="sections"
              />
              <p className="history-meta" role="status">
                {multiplesWords({ shown: keys.length, silent, resolution: reading.resolution, reads: reading.reads, stateLine: stateLine?.line ?? null })}
                {reading.loading && ' · reading again…'}
              </p>
              {alerts.count > 0 && <AlertKey count={alerts.count} to={alertsAddress(win, { assets: keys })} />}
            </div>
            <div className="trail-scroll">
              <div className="history-groups">
                {section('machines', 'Over the window', `${heading} · ${total} ${total === 1 ? 'machine' : 'machines'}`, (
                  keys.length === 0 ? (
                    <p className="cell-note">{`None of the machines in ${cell.name} reports ${shownMetric}.`}</p>
                  ) : (
                    // A press on a chart or a strip and a drag zooms (useChartBand).
                    <div onPointerDown={startBand}>
                      <SmallMultiples
                        members={shown}
                        metric={shownMetric}
                        unit={shownUnit}
                        start={reading.start}
                        end={reading.end}
                        now={now}
                        resolution={reading.resolution}
                        windowText={reading.windowText}
                        syncKey={`history-cell-${cell.cell_id}`}
                        band={band}
                        stateLine={stateLine?.words ?? null}
                      />
                    </div>
                  )
                ))}
                {section('hours', 'By hour of the day', `${heading} · mean at each hour`, (
                  <HeatBody heat={heat} rows={heatRows} />
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </>
  )
}

/** The heatmap's body: its grid, or in words why there is none. */
function HeatBody({ heat, rows }) {
  const { metric, unit } = heat ?? {}
  if (!heat || (heat.loading && !heat.grid)) return <LoadingState label="the hours of the day" />
  if (heat.needsNumber) return <p className="cell-note">{`The heatmap needs a number. ${metric} is text or a flag, so it is charted above by its changes, not averaged.`}</p>
  if (heat.problem) return <p className="cell-note">{heat.problem}</p>
  if (heat.error) return <div className="callout callout-danger">{`The hours of the day could not be read: ${heat.error}`}</div>
  if (heat.grid.low === null) {
    return <p className="cell-note">{`No machine has a value for ${metric} in this window.`}</p>
  }
  return (
    <>
      <p className="cell-note">
        {`Each cell is the mean at that hour across the window's days, in this browser's time zone, ${heat.zone}.${heat.loading ? ' Reading again…' : ''}`}
      </p>
      <HourHeatmap rows={rows} grid={heat.grid} metric={metric} unit={unit} />
    </>
  )
}
