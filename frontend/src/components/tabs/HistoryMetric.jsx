import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useSetting } from '../../hooks/useSettings'
import { ToolbarPopover, FiltersPopover } from '../common/FiltersPopover'
import { FilterList } from '../common/FilterChecklist'
import { SearchInput } from '../common/SearchInput'
import { TimeWindowControl } from '../common/TimeWindowControl'
import { RefreshButton } from '../common/RefreshButton'
import { ClearFilters } from '../common/ClearFilters'
import { GroupHeading } from '../common/GroupHeading'
import { EmptyState } from '../common/EmptyState'
import { LoadingState } from '../common/LoadingState'
import { OverflowText } from '../common/OverflowText'
import { RouteLink } from '../common/RouteLink'
import { AlertKey } from '../common/AlertKey'
import { SmallMultiples } from '../common/SmallMultiples'
import { ActionButton } from '../common/ActionButton'
import { TelemetryExportModal } from '../modals/TelemetryExportModal'
import { IconChartLine, IconChevronLeft, IconChevronRight, IconCpu, IconDownload } from '../common/Icons'
import { useClockTick } from '../../hooks/useClockTick'
import { usePolling } from '../../hooks/usePolling'
import { useChartBand } from '../../hooks/useChartBand'
import { useAlertBandsFor } from '../../hooks/useAlertBands'
import { alertsAddress } from '../../utils/alertHistory'
import {
  EXPORT_DENIED_TITLE, EXPORT_MAX_DAYS, EXPORT_MAX_DAYS_KEY, exportMaxDays, exportSizeProblem, exportWindowProblem, mayExportReadings,
  metricExportNote, metricExportScope,
} from '../../utils/telemetryExport'
import { navigate, useUrlList, useUrlState } from '../../hooks/useUrlState'
import { holdsNow, sameWindow, windowBounds, windowWords } from '../../utils/timeWindow'
import { readDeviceSeries } from '../../utils/historyReads'
import {
  DEFAULT_HISTORY_WINDOW, ENDED_WINDOW_REASON, HISTORY_RANGES, HISTORY_REFRESH_EVERY, HISTORY_SPANS, bucketStarts,
  METRIC_PAGE_SIZE, changeSeries, chartSeries, markBuckets, metricAddress, metricDevices, metricPages, multiplesWords, pageFrom, pagingWords,
  pickedAddress, readWords, stateReadLine, telemetryKey, validRanges,
} from '../../utils/history'

/** How often the page looks at the clock, so the now marker follows it. */
const CLOCK_MS = 60 * 1000

/** No value chosen. Hoisted: useUrlList's default is compared, not copied. */
const NONE = Object.freeze([])

const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/** The toolbar's metric: its name, opening the metrics some device reports, each with how many do. */
function MetricSwitcher({ metrics, metric, win, filters }) {
  const [search, setSearch] = useState('')
  const needle = search.trim().toLowerCase()
  const shown = metrics.filter(m => !needle || m.name.toLowerCase().includes(needle))
  return (
    <ToolbarPopover
      label="Choose a metric"
      buttonLabel={`Metric: ${metric}`}
      buttonClass="btn btn-sm btn-ghost control-md history-device-pick"
      tip="Compare another metric across the devices that report it"
      button={<OverflowText>{metric}</OverflowText>}
    >
      {({ close }) => (
        <>
          <SearchInput value={search} onChange={setSearch} placeholder="Find a metric…" ariaLabel="Find a metric" width="md" />
          <ul className="history-device-list">
            {shown.map(m => {
              const to = metricAddress(m.name, win, filters)
              return (
                <li key={m.name}>
                  <RouteLink
                    to={to}
                    className={`history-device-option${m.name === metric ? ' is-current' : ''}`}
                    aria-current={m.name === metric ? 'true' : undefined}
                    onNavigate={() => { close(); navigate(to) }}
                  >
                    <OverflowText>{m.name}</OverflowText>
                    <span className="history-device-place">{plural(m.count, 'device', 'devices')}</span>
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

/** The pager under the charts: the page the devices are on, and Previous and Next. Only where the tab pages. */
function Pager({ plan, onPage }) {
  const first = plan.page <= 1
  const last = plan.page >= plan.pages
  return (
    <nav className="list-foot history-pager" aria-label="Pages of devices">
      <ActionButton className="btn btn-ghost btn-sm" disabled={first} title={first ? 'This is the first page' : undefined} onClick={() => onPage(plan.page - 1)}>
        <IconChevronLeft size={13} aria-hidden="true" /> Previous
      </ActionButton>
      <span className="list-foot-end">{`Page ${plan.page} of ${plan.pages}`}</span>
      <ActionButton className="btn btn-ghost btn-sm" disabled={last} title={last ? 'This is the last page' : undefined} onClick={() => onPage(plan.page + 1)}>
        Next <IconChevronRight size={13} aria-hidden="true" />
      </ActionButton>
    </nav>
  )
}

/**
 * The Metric tab with a metric chosen: it across every device in service that reports it, wherever
 * the devices sit, a chart each on one time axis and one value scale (SmallMultiples). Where the Cell
 * tab groups by place, this groups by metric: "how do the bearing temperatures of all our lathes
 * compare?", where the lathes are in several areas. Each chart's title says where its device is.
 *
 * - **Which devices:** those that report the metric (a last birth or a schema says so), narrowed by
 *   the Filters panel's Area, Cell and Device lists (`area`, `cell` and `devices` in the address; the
 *   Overview box's Chart sets `devices`).
 * - **One read at the finest resolution the row cap allows**, as the Cell tab's, with the devices
 *   as the series (metricPages()). Past the devices one read carries at the coarsest resolution, or
 *   more than METRIC_DRAW_MAX, the tab pages: METRIC_PAGE_SIZE devices a page (`page`), each page read
 *   apart, with its own scale, and the status line says so. A text or flag metric takes
 *   telemetry_changes() too and draws every change, as the Cell tab does.
 *
 * A read is made again when the metric, the filters, the page or the window changes, on Refresh, and on
 * the refresh timer while the window reaches now. The window zooms as the Device tab's does. Export CSV
 * downloads the metric of every device the tab lists under its filters, all pages and not only the one
 * shown, in the Device tab's dialog, for an Administrator or a Shopfloor Manager and for a window no
 * longer than history.export_max_days.
 */
export function HistoryMetric({ metric, devices, schemas, metrics, areas, cells, win, setWin, every, setEvery, userRole, showToast }) {
  useClockTick(CLOCK_MS)
  const now = Date.now()
  const info = metrics.find(m => m.name === metric) ?? null
  const unit = info?.unit ?? null
  const kind = info?.kind ?? null
  const stateKind = kind === 'text' || kind === 'flag'

  // Everything that reports the metric, before any narrowing: what the Filters panel offers.
  const everyReporter = useMemo(() => metricDevices(devices, schemas, metric), [devices, schemas, metric])
  const areaOptions = useMemo(() => {
    const ids = new Set(everyReporter.map(d => d.area_id).filter(Boolean))
    return areas.filter(a => ids.has(a.area_id)).map(a => ({ value: a.area_id, label: a.name }))
  }, [areas, everyReporter])
  const cellOptions = useMemo(() => {
    const ids = new Set(everyReporter.map(d => d.cell_id).filter(Boolean))
    return cells.filter(c => ids.has(c.cell_id)).map(c => ({ value: c.cell_id, label: c.name, group: c.area_name ?? 'In no area' }))
  }, [cells, everyReporter])
  const deviceOptions = useMemo(
    () => everyReporter.map(d => ({ value: telemetryKey(d), label: d.asset_name })),
    [everyReporter]
  )
  const [areaIds, setAreaIds] = useUrlList('area', NONE, { allowed: areaOptions.map(o => o.value) })
  const [cellIds, setCellIds] = useUrlList('cell', NONE, { allowed: cellOptions.map(o => o.value) })
  const [deviceKeys, setDeviceKeys] = useUrlList('devices', NONE, { allowed: deviceOptions.map(o => o.value) })
  const [pageText, setPageText] = useUrlState('page', '')
  const page = pageFrom(pageText)
  const filters = { areas: areaIds, cells: cellIds, devices: deviceKeys }

  const reporters = useMemo(
    () => metricDevices(devices, schemas, metric, { areas: areaIds, cells: cellIds, keys: deviceKeys }),
    [devices, schemas, metric, areaIds, cellIds, deviceKeys]
  )
  const allKeys = useMemo(() => reporters.map(telemetryKey), [reporters])
  const keysKey = allKeys.join('\n')
  const windowKey = JSON.stringify(win)

  const [reading, setReading] = useState(null)
  const [open, setOpen] = useState(true)
  const [exporting, setExporting] = useState(null)
  const sectionId = useId()
  // Each read's number: only the newest may land, so a slow read never draws over a later one.
  const latestRead = useRef(0)

  const read = useCallback(async (signal) => {
    const id = ++latestRead.current
    const at = Date.now()
    const { start, end } = windowBounds(win, at)
    if (!start || !end || end <= start) {
      setReading({ problem: 'Set both ends of the custom range to compare the devices over it.' })
      return
    }
    const plan = metricPages(start.getTime(), end.getTime(), allKeys.length, page)
    if (allKeys.length && !plan.resolution) {
      setReading({ problem: 'This window is too long to chart. At 1-day buckets, one device would need more buckets than one read may carry. Choose a shorter window.' })
      return
    }
    const keys = allKeys.slice(plan.from, plan.to)
    const span = { start: start.getTime(), end: end.getTime(), resolution: plan.resolution, at, keys, plan, metric, unit, kind, windowText: windowWords(win, at) }
    if (keys.length === 0) {
      setReading({ ...span, byAsset: new Map(), changes: new Map(), reads: 0 })
      return
    }
    setReading(r => ({ ...(r?.byAsset ? r : {}), loading: true }))
    try {
      const got = await readDeviceSeries({ keys, metric, startMs: span.start, endMs: span.end, resolution: plan.resolution, stateKind, signal })
      if (id !== latestRead.current) return
      setReading({ ...span, ...got })
    } catch (e) {
      if (e?.name !== 'AbortError' && !signal?.aborted && id === latestRead.current) {
        setReading({ ...span, error: e?.message || 'The readings could not be read.' })
      }
      // Rethrown so usePolling backs off on a failing read rather than hammering it.
      throw e
    }
    // The window, the metric and the devices by value: a new object of the same is the same read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metric, keysKey, page, windowKey, stateKind])

  useEffect(() => {
    const controller = new AbortController()
    read(controller.signal).catch(() => {})
    return () => controller.abort()
  }, [read])

  // The timer runs only while the window reaches now: an ended window cannot gain a reading.
  const live = holdsNow(win, now)
  usePolling(read, every * 1000, live && every > 0)

  const keys = reading?.keys ?? []
  // The periods an alert on a device was firing, over the window the charts drew.
  const alertSpan = reading?.byAsset ? { start: reading.start, end: reading.end, at: reading.at } : null
  const alerts = useAlertBandsFor(keys, alertSpan)

  // A drag across a chart: its fractions are of the window the charts draw, the read's.
  const drawnSpan = reading?.byAsset ? { start: reading.start, ms: reading.end - reading.start } : null
  const { band, onPointerDown: startBand } = useChartBand({ span: drawnSpan, setWin, now })

  const members = useMemo(() => {
    if (!reading?.byAsset || !reading.keys.length) return []
    const starts = bucketStarts(reading.start, reading.end, reading.resolution.minutes)
    const span = { start: reading.start, end: reading.end, now: reading.at }
    const onPage = new Set(reading.keys)
    return reporters.filter(d => onPage.has(telemetryKey(d))).map(d => {
      const key = telemetryKey(d)
      const to = pickedAddress(d.asset_id, win, { metrics: [reading.metric] })
      const place = [d.cell_name, d.area_name].filter(Boolean).join(' · ') || null
      // Every change when the change read has them; else the buckets, marked where it counted more than one value.
      const change = reading.changes.get(key) ?? null
      const every = changeSeries(change, span)
      const at = every ? every.starts : starts
      const series = every ? every.series : markBuckets(chartSeries(reading.byAsset.get(key) || [], at), at, change)
      return {
        key, name: d.asset_name, device: d, to, place, series, starts: at, validRange: validRanges(d, schemas).get(reading.metric) ?? null,
        read: readWords(change, reading.resolution),
      }
    })
    // The window only through the read, which names its own: a new window is a new read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reading, reporters, schemas])
  // The alert bands apart from the series, so the alerts arriving does not draw every chart again.
  const shown = members.map(m => ({ ...m, plugins: alerts.byId.get(m.key)?.plugins }))
  const stateLine = useMemo(
    () => stateReadLine(members.filter(m => m.read).map(m => ({ kind: reading.kind, words: m.read }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [members]
  )

  const filterCount = [!sameWindow(win, DEFAULT_HISTORY_WINDOW), areaIds.length > 0, cellIds.length > 0, deviceKeys.length > 0].filter(Boolean).length
  const panelCount = [areaIds, cellIds, deviceKeys].filter(l => l.length > 0).length
  const clearPanel = () => { setAreaIds(NONE); setCellIds(NONE); setDeviceKeys(NONE); setPageText('') }
  const clear = () => { setWin(DEFAULT_HISTORY_WINDOW); clearPanel() }
  const busy = Boolean(reading?.loading) || reading === null
  // A new set of devices starts at the first page, and a page past the last is the last.
  const narrow = (set) => (list) => { set(list); setPageText('') }
  const plan = reading?.plan ?? null
  const heading = unit ? `${reading?.metric ?? metric} (${unit})` : (reading?.metric ?? metric)

  const canExport = mayExportReadings(userRole)
  const exportDays = exportMaxDays(useSetting(EXPORT_MAX_DAYS_KEY, EXPORT_MAX_DAYS))
  const { start: shownStart, end: shownEnd } = windowBounds(win, now)
  const exportBlocked = !info ? `No device in service reports ${metric}, so there is nothing to export.`
    : allKeys.length === 0 ? `No device that reports ${metric} is in the area, cell or devices chosen, so there is nothing to export.`
      : exportSizeProblem(allKeys.length, 1) ?? exportWindowProblem(shownStart?.getTime(), shownEnd?.getTime(), exportDays)
  /** The export, with the window fixed to its bounds now, so the file is what the dialog names. */
  const openExport = () => {
    const at = Date.now()
    const { start, end } = windowBounds(win, at)
    const paged = metricPages(start.getTime(), end.getTime(), allKeys.length, page).paged
    setExporting({
      devices: reporters.map(d => ({ id: telemetryKey(d), name: d.asset_name })), names: [metric],
      scope: metricExportScope(reporters.length, everyReporter.length),
      note: paged ? metricExportNote(reporters.length, METRIC_PAGE_SIZE) : null,
      from: start.toISOString(), to: end.toISOString(), windowWords: windowWords(win, at),
    })
  }

  return (
    <>
      <div className="filter-bar">
        <MetricSwitcher metrics={metrics} metric={metric} win={win} filters={filters} />
        <TimeWindowControl value={win} onChange={setWin} ranges={HISTORY_RANGES} spans={HISTORY_SPANS} zoom />
        <FiltersPopover activeCount={panelCount} onClear={clearPanel}>
          <FilterList label="Area" plural="areas" options={areaOptions} value={areaIds} onChange={narrow(setAreaIds)} />
          <FilterList label="Cell" plural="cells" options={cellOptions} value={cellIds} onChange={narrow(setCellIds)} />
          <FilterList label="Device" plural="devices" options={deviceOptions} value={deviceKeys} onChange={narrow(setDeviceKeys)} />
        </FiltersPopover>
        <div className="filter-bar-actions">
          <ClearFilters count={filterCount} onClear={clear} />
          <ActionButton
            className="btn btn-primary btn-sm"
            permitted={canExport}
            deniedTitle={EXPORT_DENIED_TITLE}
            disabled={Boolean(exportBlocked)}
            title={exportBlocked ?? `Download ${metric} for every device listed, on every page, over this window, as CSV`}
            onClick={openExport}
          >
            <IconDownload size={13} aria-hidden="true" /> Export CSV
          </ActionButton>
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

      <div className="history-body card-fill-scroll trail-timeline">
        {!info ? (
          <EmptyState icon={<IconChartLine size={36} />} message={`No device in service reports ${metric}.`}>
            <RouteLink to={metricAddress('', win)} className="count-link">Choose another metric</RouteLink>
          </EmptyState>
        ) : reading?.problem ? (
          <EmptyState icon={<IconChartLine size={36} />} message={reading.problem} />
        ) : reading?.error ? (
          <div className="callout callout-danger">{`The readings could not be read: ${reading.error}`}</div>
        ) : reading && !reading.loading && reading.keys.length === 0 ? (
          <EmptyState icon={<IconCpu size={36} />} message={`No device that reports ${metric} is in the area, cell or devices chosen.`} />
        ) : !reading?.byAsset ? (
          <LoadingState label="readings" />
        ) : (
          <>
            <div className="history-header">
              <p className="history-meta" role="status">
                {multiplesWords({ shown: keys.length, silent: 0, resolution: reading.resolution, reads: reading.reads, stateLine: stateLine?.line ?? null, noun: 'device' })}
                {reading.loading && ' · reading again…'}
              </p>
              {plan?.paged && (
                <p className="history-meta">{pagingWords({ total: allKeys.length, from: plan.from, to: plan.to, size: plan.size })}</p>
              )}
              {alerts.count > 0 && <AlertKey count={alerts.count} to={alertsAddress(win, { assets: keys })} />}
            </div>
            <div className="trail-scroll">
              <div className="history-groups">
                <section className="history-group" aria-label="Over the window">
                  <div className="history-group-head">
                    <GroupHeading
                      open={open}
                      onToggle={() => setOpen(o => !o)}
                      label="Over the window"
                      detail={`${heading} · ${plural(keys.length, 'device', 'devices')}`}
                      controls={sectionId}
                    />
                  </div>
                  <div id={sectionId} className="cell-section" hidden={!open}>
                    {open && (
                      // A press on a chart or a strip and a drag zooms (useChartBand).
                      <div onPointerDown={startBand}>
                        <SmallMultiples
                          members={shown}
                          metric={reading.metric}
                          unit={reading.unit}
                          start={reading.start}
                          end={reading.end}
                          now={now}
                          resolution={reading.resolution}
                          windowText={reading.windowText}
                          syncKey={`history-metric-${reading.metric}`}
                          band={band}
                          stateLine={stateLine?.words ?? null}
                          noun="device"
                          scope={plan?.paged ? 'on this page' : ''}
                        />
                      </div>
                    )}
                  </div>
                </section>
              </div>
            </div>
            {plan?.paged && <Pager plan={plan} onPage={(n) => setPageText(n > 1 ? String(n) : '')} />}
          </>
        )}
      </div>

      {exporting && (
        <TelemetryExportModal
          devices={exporting.devices}
          metricNames={exporting.names}
          scope={exporting.scope}
          note={exporting.note}
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
