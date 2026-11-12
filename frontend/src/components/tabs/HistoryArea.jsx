import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { api } from '../../api'
import { useSetting } from '../../hooks/useSettings'
import { ToolbarPopover } from '../common/FiltersPopover'
import { SearchInput } from '../common/SearchInput'
import { SegmentedControl } from '../common/SegmentedControl'
import { TimeWindowControl } from '../common/TimeWindowControl'
import { RefreshButton } from '../common/RefreshButton'
import { ActionButton } from '../common/ActionButton'
import { TelemetryExportModal } from '../modals/TelemetryExportModal'
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
import { alertBandsPlugin } from '../common/alertBands'
import { IconChartLine, IconDownload, IconFactory, IconLayoutDashboard } from '../common/Icons'
import { useClockTick } from '../../hooks/useClockTick'
import { usePolling } from '../../hooks/usePolling'
import { useChartBand } from '../../hooks/useChartBand'
import { useAlertBandsFor } from '../../hooks/useAlertBands'
import { alertsAddress } from '../../utils/alertHistory'
import {
  EXPORT_DENIED_TITLE, EXPORT_MAX_DAYS, EXPORT_MAX_DAYS_KEY, areaExportNote, areaExportScope, exportMaxDays, exportSizeProblem,
  exportWindowProblem, mayExportReadings,
} from '../../utils/telemetryExport'
import { navigate, useUrlState } from '../../hooks/useUrlState'
import { areaWideInService } from '../../utils/inService'
import { holdsNow, sameWindow, windowBounds, windowWords } from '../../utils/timeWindow'
import {
  AGG_MODES, DEFAULT_AGG, DEFAULT_HISTORY_WINDOW, ENDED_WINDOW_REASON, HISTORY_RANGES, HISTORY_REFRESH_EVERY, HISTORY_SPANS,
  areaAddress, bucketStarts, browserTimeZone, cellAddress, cellHourGrid, cellMetrics, cellsWords, datatypeKind, defaultCellMetric,
  deviceMetrics, groupSeries, hourGrid, hourOfDayPlan, pickGroupResolution, silentCellWords, telemetryKey, withheldWords,
} from '../../utils/history'

/** How often the page looks at the clock, so the now marker follows it. */
const CLOCK_MS = 60 * 1000

/** The two sections of the tab, by the key each is opened and closed by. */
const SECTIONS = ['cells', 'hours']

const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/** What each of the control's two choices says, in its tooltip. */
const AGG_OPTIONS = [
  { id: 'mean', label: 'Mean', description: "Each cell's chart is the mean of its machines that have a value in each bucket." },
  { id: 'total', label: 'Total', description: "Each cell's chart is the total of its machines, drawn only in a bucket in which every one of them has a value." },
]

/** A metric's unit from the catalog, by name. */
const unitsOf = (catalog) => new Map((catalog || []).map(m => [m.name, m.units ?? null]))

/** The toolbar's area: its name, opening a list of the others to look at instead, at the same view. */
function AreaSwitcher({ area, areas, win, metric, agg }) {
  const [search, setSearch] = useState('')
  const needle = search.trim().toLowerCase()
  const shown = areas.filter(a => !needle || a.name.toLowerCase().includes(needle))
  return (
    <ToolbarPopover
      label="Choose an area"
      buttonLabel={`Area: ${area.name}`}
      buttonClass="btn btn-sm btn-ghost control-md history-device-pick"
      tip="Compare the cells of another area"
      button={<><IconFactory size={13} aria-hidden="true" /><OverflowText>{area.name}</OverflowText></>}
    >
      {({ close }) => (
        <>
          <SearchInput value={search} onChange={setSearch} placeholder="Find an area…" ariaLabel="Find an area" width="md" />
          <ul className="history-device-list">
            {shown.map(a => {
              const to = areaAddress(a.area_id, win, { metric, agg })
              return (
                <li key={a.area_id}>
                  <RouteLink
                    to={to}
                    className={`history-device-option${a.area_id === area.area_id ? ' is-current' : ''}`}
                    aria-current={a.area_id === area.area_id ? 'true' : undefined}
                    onNavigate={() => { close(); navigate(to) }}
                  >
                    <OverflowText>{a.name}</OverflowText>
                    <span className="history-device-place">
                      {[plural(a.cells.length, 'cell', 'cells'), a.is_archived ? 'Archived' : null].filter(Boolean).join(' · ')}
                    </span>
                  </RouteLink>
                </li>
              )
            })}
            {shown.length === 0 && <li className="history-device-none">No area matches.</li>}
          </ul>
        </>
      )}
    </ToolbarPopover>
  )
}

/** The toolbar's metric: its name, opening the metrics the area's machines report, each with how many do. */
function MetricSwitcher({ area, metrics, metric, win, agg, total }) {
  const [search, setSearch] = useState('')
  const needle = search.trim().toLowerCase()
  const shown = metrics.filter(m => !needle || m.name.toLowerCase().includes(needle))
  return (
    <ToolbarPopover
      label="Choose a metric"
      buttonLabel={`Metric: ${metric}`}
      buttonClass="btn btn-sm btn-ghost control-md history-device-pick"
      tip="Compare another metric across these cells"
      button={<OverflowText>{metric}</OverflowText>}
    >
      {({ close }) => (
        <>
          <SearchInput value={search} onChange={setSearch} placeholder="Find a metric…" ariaLabel="Find a metric" width="md" />
          <ul className="history-device-list">
            {shown.map(m => {
              const to = areaAddress(area.area_id, win, { metric: m.name, agg })
              return (
                <li key={m.name}>
                  <RouteLink
                    to={to}
                    className={`history-device-option${m.name === metric ? ' is-current' : ''}`}
                    aria-current={m.name === metric ? 'true' : undefined}
                    onNavigate={() => { close(); navigate(to) }}
                  >
                    <OverflowText>{m.name}</OverflowText>
                    <span className="history-device-place">{`${m.count} of ${plural(total, 'machine', 'machines')}`}</span>
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
 * The Area tab with an area chosen: one metric across the cells in it, compared, the Cell tab one
 * level up. Two sections.
 *
 * - **Over the window:** one chart a cell, on one time axis and one value scale (SmallMultiples), each
 *   the cell's mean or total of the metric in every bucket. The tab's one control picks which, and
 *   `agg` is in the address. One telemetry_carried_by_group() read for every machine that reports
 *   the metric, folded where it is made into cells times buckets, at the finest resolution whose
 *   rows fit the row cap and whose machines fit the function's own bound (pickGroupResolution()); the
 *   status line says which. The mean is of the machines that have a value in the bucket. A total is
 *   drawn only for a bucket in which every machine of the cell has a value, carried or measured: a
 *   partial sum reads as a real one. Where it was withheld, the chart's head says so in words. Each
 *   chart's title links to the Cell tab for that cell, at the same window and metric.
 * - **By hour of the day:** a row a cell, a column an hour, the cell's mean at that hour across the
 *   window's days in this browser's time zone: its machines' own (telemetry_hour_of_day(), as the Cell
 *   tab reads it) averaged in the browser (cellHourGrid()). A number metric only.
 *
 * A text or flag metric has no mean or total: the tab says so and offers each cell's own tab. The
 * metric and the mean or total are in the address, with the window. A read is made again when the area,
 * the metric or the window changes, on Refresh, and on the refresh timer while the window reaches now.
 * Export CSV downloads the machines behind the charts, not the cells' means and totals, which are a
 * fold: every machine of the area's cells that reports the metric, in the Device tab's dialog, for an
 * Administrator or a Shopfloor Manager and for a window no longer than history.export_max_days.
 */
export function HistoryArea({ area, areas, devices, schemas, catalog, win, setWin, every, setEvery, userRole, showToast }) {
  useClockTick(CLOCK_MS)
  const now = Date.now()
  const cells = area.cells
  const machines = area.machines
  const metricList = useMemo(() => cellMetrics(machines, schemas), [machines, schemas])
  const metricNames = useMemo(() => metricList.map(m => m.name), [metricList])
  const [chosen, setChosen] = useUrlState('metric', '', { allowed: metricNames })
  const [agg, setAgg] = useUrlState('agg', DEFAULT_AGG, { allowed: AGG_MODES })
  const metric = chosen || defaultCellMetric(metricList)
  const units = useMemo(() => unitsOf(catalog), [catalog])
  const unit = units.get(metric) ?? null
  const kind = useMemo(() => datatypeKind((catalog || []).find(m => m.name === metric)?.datatype), [catalog, metric])
  const stateKind = kind === 'text' || kind === 'flag'

  // Who reports the metric, cell by cell: charted and read. The rest are named in words.
  const byCell = useMemo(
    () => cells.map(c => ({ cell: c, keys: c.machines.filter(d => deviceMetrics(d, schemas).includes(metric)).map(telemetryKey) })),
    [cells, schemas, metric]
  )
  const assetKeys = useMemo(() => byCell.flatMap(c => c.keys), [byCell])
  const groupKeys = useMemo(() => byCell.flatMap(c => c.keys.map(() => c.cell.cell_id)), [byCell])
  const reporting = byCell.filter(c => c.keys.length > 0)
  const keysKey = `${assetKeys.join('\n')}|${groupKeys.join('\n')}`
  const windowKey = JSON.stringify(win)

  const [reading, setReading] = useState(null)
  const [heat, setHeat] = useState(null)
  const [exporting, setExporting] = useState(null)
  const [closed, setClosed] = useState(() => new Set())
  const sectionsId = useId()
  // Each read's number: only the newest may land, so a slow read never draws over a later one.
  const latestRead = useRef(0)
  const latestHeat = useRef(0)

  const read = useCallback(async (signal) => {
    const id = ++latestRead.current
    const at = Date.now()
    const { start, end } = windowBounds(win, at)
    if (!start || !end || end <= start) {
      setReading({ problem: 'Set both ends of the custom range to compare the cells over it.' })
      return
    }
    if (stateKind) {
      setReading({ needsNumber: true })
      return
    }
    const resolution = assetKeys.length ? pickGroupResolution(start.getTime(), end.getTime(), assetKeys.length, reporting.length) : null
    if (assetKeys.length && !resolution) {
      setReading({ problem: `This window is too long to chart. At 1-day buckets, the ${plural(assetKeys.length, 'machine', 'machines')} in this area would need more rows than one read may carry. Choose a shorter window.` })
      return
    }
    const span = { start: start.getTime(), end: end.getTime(), resolution, at, metric, unit, windowText: windowWords(win, at) }
    if (assetKeys.length === 0) {
      setReading({ ...span, byCell: new Map() })
      return
    }
    setReading(r => ({ ...(r?.byCell ? r : {}), loading: true }))
    try {
      const rows = await api.readCarriedByGroup(
        { from: start.toISOString(), to: end.toISOString(), bucketMinutes: resolution.minutes, assetIds: assetKeys, groupKeys, metricName: metric },
        { signal }
      )
      if (id !== latestRead.current) return
      const grouped = new Map()
      for (const row of rows) {
        if (!grouped.has(row.group_key)) grouped.set(row.group_key, [])
        grouped.get(row.group_key).push(row)
      }
      setReading({ ...span, byCell: grouped })
    } catch (e) {
      if (e?.name !== 'AbortError' && !signal?.aborted && id === latestRead.current) {
        setReading({ ...span, error: e?.message || 'The readings could not be read.' })
      }
      // Rethrown so usePolling backs off on a failing read rather than hammering it.
      throw e
    }
    // The window, the metric and the machines by value: a new object of the same is the same read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [area.area_id, metric, keysKey, windowKey, stateKind])

  const readHeat = useCallback(async (signal) => {
    const id = ++latestHeat.current
    const at = Date.now()
    const { start, end } = windowBounds(win, at)
    if (!start || !end || end <= start) {
      setHeat({ problem: 'Set both ends of the custom range to see the hours of the day in it.' })
      return
    }
    if (stateKind) {
      setHeat({ needsNumber: true, metric, unit })
      return
    }
    const plan = hourOfDayPlan(start.getTime(), end.getTime(), assetKeys.length)
    if (plan.problem) {
      setHeat({ problem: plan.problem })
      return
    }
    const zone = browserTimeZone()
    if (assetKeys.length === 0) {
      setHeat({ grid: cellHourGrid(hourGrid([], []), []), zone, metric, unit, byCell })
      return
    }
    setHeat(h => ({ ...(h?.grid ? h : {}), loading: true }))
    try {
      const rows = await api.readHourOfDay({ from: start.toISOString(), to: end.toISOString(), assetIds: assetKeys, metricName: metric, timeZone: zone }, { signal })
      if (id !== latestHeat.current) return
      const grid = cellHourGrid(hourGrid(rows, assetKeys), byCell.map(c => ({ key: c.cell.cell_id, keys: c.keys })))
      setHeat({ grid, zone, metric, unit, byCell })
    } catch (e) {
      if (e?.name !== 'AbortError' && !signal?.aborted && id === latestHeat.current) {
        setHeat({ error: e?.message || 'The hours of the day could not be read.' })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [area.area_id, metric, keysKey, windowKey, stateKind])

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

  // The periods an alert on any machine of a cell was firing, over the window the charts drew.
  const alertSpan = reading?.byCell ? { start: reading.start, end: reading.end, at: reading.at } : null
  const alerts = useAlertBandsFor(assetKeys, alertSpan)
  const cellPlugins = useMemo(() => {
    const out = new Map()
    for (const { cell, keys } of byCell) {
      const bands = keys.flatMap(k => alerts.byId.get(k)?.bands ?? []).sort((a, b) => a.from - b.from || a.to - b.to)
      if (bands.length) out.set(cell.cell_id, [alertBandsPlugin(bands)])
    }
    return out
  }, [alerts, byCell])

  // A drag across a chart: its fractions are of the window the charts draw, the read's.
  const drawnSpan = reading?.byCell ? { start: reading.start, ms: reading.end - reading.start } : null
  const { band, onPointerDown: startBand } = useChartBand({ span: drawnSpan, setWin, now })

  const members = useMemo(() => {
    if (!reading?.byCell || !reading.resolution) return []
    const { minutes } = reading.resolution
    const starts = bucketStarts(reading.start, reading.end, minutes)
    return byCell.map(({ cell, keys }) => {
      const to = cellAddress(cell.cell_id, win, { metric: reading.metric })
      const linkTitle = `Compare the machines in ${cell.name} on the Cell tab`
      if (!keys.length) return { key: cell.cell_id, name: cell.name, to, linkTitle, absent: silentCellWords(cell.name, reading.metric) }
      const rows = reading.byCell.get(cell.cell_id) || []
      const series = groupSeries(rows, starts, agg)
      const withheld = withheldWords(series.withheld, starts, minutes)
      const base = `${agg} of ${plural(keys.length, 'machine', 'machines')}`
      if (agg === 'total' && series.kind === 'none' && rows.length > 0) {
        return { key: cell.cell_id, name: cell.name, to, linkTitle, absent: `${cell.name} has no total in this window: a machine had no value in every bucket.` }
      }
      return {
        key: cell.cell_id, name: cell.name, to, linkTitle, place: plural(keys.length, 'machine', 'machines'),
        series, starts, read: withheld ? `${base}, ${withheld}` : base,
      }
    })
    // The window only through the read, which names its own: a new window is a new read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reading, byCell, agg])
  // The alert bands apart from the series, so the alerts arriving does not draw every chart again.
  const shown = members.map(m => (m.series ? { ...m, plugins: cellPlugins.get(m.key) } : m))

  const heatRows = useMemo(() => (heat?.byCell ?? byCell).map(({ cell, keys }) => ({
    key: cell.cell_id, name: cell.name, absent: keys.length ? null : silentCellWords(cell.name, heat?.metric ?? metric),
  })), [heat, byCell, metric])

  const setOpen = (list, open) => setClosed(prev => {
    const next = new Set(prev)
    for (const k of list) if (open) next.delete(k); else next.add(k)
    return next
  })
  const filterCount = [!sameWindow(win, DEFAULT_HISTORY_WINDOW), chosen !== '', agg !== DEFAULT_AGG].filter(Boolean).length
  const clear = () => { setWin(DEFAULT_HISTORY_WINDOW); setChosen(''); setAgg(DEFAULT_AGG) }
  const busy = Boolean(reading?.loading || heat?.loading) || reading === null

  const canExport = mayExportReadings(userRole)
  const exportDays = exportMaxDays(useSetting(EXPORT_MAX_DAYS_KEY, EXPORT_MAX_DAYS))
  const { start: shownStart, end: shownEnd } = windowBounds(win, now)
  const exportBlocked = !metric ? 'This area has no metric to export.'
    : stateKind ? `${metric} is text or a flag, so this tab draws no mean or total of it and has nothing to export. The Cell tab exports it.`
      : assetKeys.length === 0 ? `None of the machines in ${area.name} reports ${metric}, so there is nothing to export.`
        : exportSizeProblem(assetKeys.length, 1) ?? exportWindowProblem(shownStart?.getTime(), shownEnd?.getTime(), exportDays)
  /** The export, with the window fixed to its bounds now, so the file is what the dialog names. */
  const openExport = () => {
    const at = Date.now()
    const { start, end } = windowBounds(win, at)
    setExporting({
      devices: reporting.flatMap(({ cell, keys }) => {
        const reports = new Set(keys)
        return cell.machines.filter(d => reports.has(telemetryKey(d))).map(d => ({ id: telemetryKey(d), name: d.asset_name }))
      }),
      names: [metric], scope: areaExportScope(area.name, reporting.map(c => c.keys.length)),
      from: start.toISOString(), to: end.toISOString(), windowWords: windowWords(win, at),
    })
  }

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

  const silent = cells.length - reporting.length
  const areaWide = areaWideInService(area.area_id, devices, []).devices.length
  // What the sections show is what was read: the metric asked for next waits for its read to land.
  const shownMetric = reading?.metric ?? metric
  const shownUnit = reading ? reading.unit : unit
  const heading = shownUnit ? `${shownMetric} (${shownUnit})` : shownMetric
  const cellCount = plural(cells.length, 'cell', 'cells')

  return (
    <>
      <div className="filter-bar">
        <AreaSwitcher area={area} areas={areas} win={win} metric={chosen} agg={agg} />
        <TimeWindowControl value={win} onChange={setWin} ranges={HISTORY_RANGES} spans={HISTORY_SPANS} zoom />
        {metricList.length > 0 && <MetricSwitcher area={area} metrics={metricList} metric={metric} win={win} agg={agg} total={machines.length} />}
        <SegmentedControl label="Each cell's chart is its" options={AGG_OPTIONS} value={agg} onChange={setAgg} />
        <div className="filter-bar-actions">
          <ClearFilters count={filterCount} onClear={clear} />
          <ActionButton
            className="btn btn-primary btn-sm"
            permitted={canExport}
            deniedTitle={EXPORT_DENIED_TITLE}
            disabled={Boolean(exportBlocked)}
            title={exportBlocked ?? `Download ${metric} for each machine behind the charts, over this window, as CSV`}
            onClick={openExport}
          >
            <IconDownload size={13} aria-hidden="true" /> Export CSV
          </ActionButton>
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
        {cells.length === 0 ? (
          <EmptyState icon={<IconLayoutDashboard size={36} />} message="No cell in this area has a device in service, so there are no cells to compare." />
        ) : metricList.length === 0 ? (
          <EmptyState
            icon={<IconChartLine size={36} />}
            message="The machines in this area have declared no metrics, and no schema attached to them models any, so there is nothing to compare."
          />
        ) : reading?.problem ? (
          <EmptyState icon={<IconChartLine size={36} />} message={reading.problem} />
        ) : reading?.error ? (
          <div className="callout callout-danger">{`The readings could not be read: ${reading.error}`}</div>
        ) : !reading?.byCell && !reading?.needsNumber ? (
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
                {reading.needsNumber
                  ? `${cellCount}; ${metric} is text or a flag`
                  : reading.resolution
                    ? cellsWords({ shown: reporting.length, silent, agg, resolution: reading.resolution, areaWide })
                    : `${cellCount}, none of whose machines reports ${metric}`}
                {reading.loading && ' · reading again…'}
              </p>
              {alerts.count > 0 && <AlertKey count={alerts.count} to={alertsAddress(win, { assets: assetKeys })} />}
            </div>
            <div className="trail-scroll">
              <div className="history-groups">
                {section('cells', 'Over the window', `${heading} · ${agg} · ${cellCount}`, (
                  reading.needsNumber ? (
                    <NeedsNumber metric={metric} cells={reporting.map(c => c.cell)} win={win} />
                  ) : reporting.length === 0 ? (
                    <p className="cell-note">{`None of the machines in ${area.name} reports ${shownMetric}.`}</p>
                  ) : (
                    // A press on a chart and a drag zooms (useChartBand).
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
                        syncKey={`history-area-${area.area_id}`}
                        band={band}
                        noun="cell"
                      />
                    </div>
                  )
                ))}
                {section('hours', 'By hour of the day', `${heading} · each cell's mean at each hour`, (
                  <HeatBody heat={heat} rows={heatRows} cells={reporting.map(c => c.cell)} win={win} />
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {exporting && (
        <TelemetryExportModal
          devices={exporting.devices}
          metricNames={exporting.names}
          scope={exporting.scope}
          note={areaExportNote(areaWide)}
          from={exporting.from}
          to={exporting.to}
          windowWords={exporting.windowWords}
          onClose={() => setExporting(null)}
          showToast={showToast}
        />
      )}
    </>
  )
}

/** A text or flag metric has no mean or total: said in words, with each cell's own tab, where it is charted. */
function NeedsNumber({ metric, cells, win }) {
  return (
    <>
      <p className="cell-note">{`A mean or a total needs a number. ${metric} is text or a flag, so it is charted for each machine on the Cell tab, by its changes.`}</p>
      <ul className="history-device-list">
        {cells.map(c => (
          <li key={c.cell_id}>
            <RouteLink to={cellAddress(c.cell_id, win, { metric })} className="count-link">{`Open ${c.name} on the Cell tab`}</RouteLink>
          </li>
        ))}
      </ul>
    </>
  )
}

/** The heatmap's body: its grid, or in words why there is none. */
function HeatBody({ heat, rows, cells, win }) {
  const { metric, unit } = heat ?? {}
  if (!heat || (heat.loading && !heat.grid)) return <LoadingState label="the hours of the day" />
  if (heat.needsNumber) return <NeedsNumber metric={metric} cells={cells} win={win} />
  if (heat.problem) return <p className="cell-note">{heat.problem}</p>
  if (heat.error) return <div className="callout callout-danger">{`The hours of the day could not be read: ${heat.error}`}</div>
  if (heat.grid.low === null) {
    return <p className="cell-note">{`No machine in these cells has a value for ${metric} in this window.`}</p>
  }
  return (
    <>
      <p className="cell-note">
        {`Each square is the mean of the cell's machines at that hour across the window's days, in this browser's time zone, ${heat.zone}.${heat.loading ? ' Reading again…' : ''}`}
      </p>
      <HourHeatmap rows={rows} grid={heat.grid} metric={metric} unit={unit} noun="Cell" />
    </>
  )
}
