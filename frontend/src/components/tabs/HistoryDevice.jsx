import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS } from '../../constants'
import { requiresRolesTitle } from '../../hooks/usePermissions'
import { ToolbarPopover } from '../common/FiltersPopover'
import { SearchInput } from '../common/SearchInput'
import { TimeWindowControl } from '../common/TimeWindowControl'
import { TimeSeriesChart } from '../common/TimeSeriesChart'
import { RefreshButton } from '../common/RefreshButton'
import { ClearFilters } from '../common/ClearFilters'
import { ActionButton } from '../common/ActionButton'
import { TelemetryExportModal } from '../modals/TelemetryExportModal'
import { FilterDropdown } from '../common/FilterChecklist'
import { Tooltip } from '../common/Tooltip'
import { GroupHeading } from '../common/GroupHeading'
import { ExpandAllToggle } from '../common/ExpandAllToggle'
import { EmptyState } from '../common/EmptyState'
import { LoadingState } from '../common/LoadingState'
import { OverflowText } from '../common/OverflowText'
import { RouteLink } from '../common/RouteLink'
import { IconChartLine, IconCpu, IconDownload } from '../common/Icons'
import { useClockTick } from '../../hooks/useClockTick'
import { usePolling } from '../../hooks/usePolling'
import { useBandDrag } from '../../hooks/useBandDrag'
import { useAlertBands } from '../../hooks/useAlertBands'
import { alertsAddress } from '../../utils/alertHistory'
import { deviceIds } from '../../utils/sparkplugId'
import { navigate, useUrlList, useUrlState } from '../../hooks/useUrlState'
import { bandWindow, bandWords, holdsNow, sameWindow, windowBounds, windowWords } from '../../utils/timeWindow'
import {
  DEFAULT_CHART_PX, DEFAULT_HISTORY_WINDOW, ENDED_WINDOW_REASON, HISTORY_BUCKETS, HISTORY_RANGES, HISTORY_REFRESH_EVERY,
  HISTORY_SPANS, TOO_MANY_BUCKETS, bucketOptions, bucketStarts, chartSeries, chartSummary, datatypeKind, deviceMatches,
  deviceMetrics, inReads, metricGroups, pickResolution, pickedAddress, readPlan, readableResolution, validRanges,
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
      buttonClass="btn btn-sm btn-ghost control-md history-device-pick"
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
      buttonClass="btn btn-sm btn-ghost control-sm history-bucket-pick"
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

/**
 * The charts' band drag (hooks/useBandDrag.js): a press on a chart's plot area or a state's strip,
 * each the window's width.
 */
const CHART_BAND = { track: '.u-over, .chart-box-states' }

/** Which groups this browser's viewer closed, by datatype. Not in the address: a link opens them all. */
export const CLOSED_GROUPS_KEY = 'aber_history_closed_groups'

/** The closed groups, or none where storage is refused or holds something else. */
function readClosedGroups() {
  try {
    const keys = JSON.parse(window.localStorage.getItem(CLOSED_GROUPS_KEY) || '[]')
    return new Set(Array.isArray(keys) ? keys.filter(k => typeof k === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeClosedGroups(keys) {
  try {
    if (keys.size) window.localStorage.setItem(CLOSED_GROUPS_KEY, JSON.stringify([...keys]))
    else window.localStorage.removeItem(CLOSED_GROUPS_KEY)
  } catch {
    // Refused storage: the groups open again on the next visit, which is the default anyway.
  }
}

/** No metric chosen: every metric is charted. Hoisted: useUrlList's default is compared, not copied. */
const ALL_METRICS = Object.freeze([])

/**
 * The status line: how many metrics are charted, of how many, in which buckets, and the text
 * charts' when they read apart in others.
 */
function metaWords({ names, total, groups, refused, reads }) {
  const count = names.length < total ? `${names.length} of ${total} metrics` : `${total} metric${total === 1 ? '' : 's'}`
  const main = groups.find(g => !g.text) ?? groups[0]
  const text = groups.find(g => g.text && g !== main && g.resolution.id !== main.resolution.id)
  const why = refused ? `: ${refused.words} are too many for this window` : ''
  const parts = reads > groups.length ? `, read in ${reads} parts` : ''
  return `${count}, in ${main.resolution.words}${why}${text ? `; text in ${text.resolution.words}` : ''}${parts}`
}

/**
 * The key to the alert shading, beside the status line: its swatch named in words, and how many
 * alerts fired in the window, a link to them on the Alerts tab.
 */
function AlertKey({ count, to }) {
  return (
    <p className="history-alert-key">
      <span className="history-alert-swatch" aria-hidden="true" />
      Shaded while an alert was firing:{' '}
      <RouteLink to={to} className="count-link" title="List them on the Alerts tab">
        {count} {count === 1 ? 'alert' : 'alerts'} in this window
      </RouteLink>
    </p>
  )
}

/** How long a change of width settles before the text charts' buckets are picked again. */
const WIDTH_SETTLE_MS = 300

/**
 * The Device tab with a device chosen: one chart per metric over the window, stacked on one time
 * axis. The toolbar's Metrics filter narrows the charts, and Buckets takes Auto, the finest the row
 * cap allows for the metrics chosen, or a coarser one. Both are in the address, with the window.
 * The page says which resolution it shows. A read is made again when the device, the window, the
 * metrics or the buckets change, on Refresh, and on the refresh timer while the window reaches
 * now; never on a re-render. `every` is the timer, in seconds, held by the page so it outlasts a
 * change of device. Export CSV downloads what the page shows: this device, the metrics chosen and
 * the window, resolved to its bounds as it opens, for a role with `telemetry:read`.
 *
 * The window zooms as the Audit Trail's does: Zoom in and Zoom out in the time control, and a drag
 * across any chart, which shades the band on every chart and sets it as the window on release, as a
 * new history entry, so Back undoes it.
 *
 * The charts are grouped by their catalog datatype (metricGroups()), each group under a heading that
 * opens and closes it. A closed group only hides its charts: the reads, the row cap and the Metrics
 * filter are the same. Which are closed is kept in this browser (CLOSED_GROUPS_KEY).
 */
export function HistoryDevice({ device, devices, schemas, catalog, win, setWin, every, setEvery, hasPermission, showToast }) {
  useClockTick(CLOCK_MS)
  const now = Date.now()
  const metrics = useMemo(() => deviceMetrics(device, schemas), [device, schemas])
  const ranges = useMemo(() => validRanges(device, schemas), [device, schemas])
  const units = useMemo(() => unitsOf(catalog), [catalog])
  const kinds = useMemo(() => new Map((catalog || []).map(m => [m.name, datatypeKind(m.datatype)])), [catalog])
  const [chosen, setChosen] = useUrlList('metric', ALL_METRICS, { allowed: metrics })
  const [bucket, setBucket] = useUrlState('bucket', 'auto', { allowed: HISTORY_BUCKETS })
  const names = useMemo(() => (chosen.length ? metrics.filter(m => chosen.includes(m)) : metrics), [metrics, chosen])
  const [reading, setReading] = useState(null)
  const [exporting, setExporting] = useState(null)
  const [closedGroups, setClosedGroups] = useState(readClosedGroups)
  const groupsId = useId()
  const bodyRef = useRef(null)
  // Each read's number: only the newest may land, so a slow read never draws over a later one.
  const latestRead = useRef(0)

  const textNames = useMemo(() => new Set(names.filter(n => kinds.get(n) === 'text')), [names, kinds])

  /** The width a strip is drawn at: a chart's, else the page's less its insets, else a default. */
  const chartPx = () => {
    const body = bodyRef.current
    const box = body?.querySelector('.chart-box')
    const inset = body ? parseFloat(getComputedStyle(body).getPropertyValue('--inset')) || 16 : 0
    const width = box?.clientWidth || (body ? body.clientWidth - 2 * inset : 0)
    return width > 0 ? width : DEFAULT_CHART_PX
  }

  const namesKey = names.join('\n')
  const textKey = [...textNames].join('\n')
  const windowKey = JSON.stringify(win)
  const read = useCallback(async (signal) => {
    const id = ++latestRead.current
    const at = Date.now()
    const { start, end } = windowBounds(win, at)
    if (!start || !end || end <= start) {
      setReading({ problem: 'Set both ends of the custom range to chart it.' })
      return
    }
    const plan = readPlan(start.getTime(), end.getTime(), { names, textNames, bucket, widthPx: chartPx() })
    if (plan.problem) {
      setReading({ problem: 'This window is too long to chart. At 1-day buckets, one metric would need more buckets than one read may carry. Choose a shorter window.' })
      return
    }
    const { groups, refused } = plan
    const resolutionOf = new Map(groups.flatMap(g => g.names.map(n => [n, g.resolution])))
    const span = { start: start.getTime(), end: end.getTime(), groups, resolutionOf, refused, at, names, windowText: windowWords(win, at) }
    if (names.length === 0) {
      setReading({ ...span, byMetric: new Map(), reads: 0 })
      return
    }
    setReading(r => ({ ...(r?.byMetric ? r : {}), loading: true }))
    const reads = groups.flatMap(g => inReads(g.names, g.resolution.perRead).map(part => ({ part, resolution: g.resolution })))
    try {
      const parts = await Promise.all(reads.map(({ part, resolution }) => api.readCarriedTelemetry({
        from: start.toISOString(),
        to: end.toISOString(),
        bucketMinutes: resolution.minutes,
        assetIds: [device.asset_id],
        metricNames: part,
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
  }, [device.asset_id, namesKey, textKey, windowKey, bucket])

  useEffect(() => {
    const controller = new AbortController()
    read(controller.signal).catch(() => {})
    return () => controller.abort()
  }, [read])

  // The page's width, once a change of it settles, for the text charts' buckets under Auto.
  const [settledPx, setSettledPx] = useState(null)
  useEffect(() => {
    const body = bodyRef.current
    if (!body || typeof ResizeObserver !== 'function') return undefined
    let timer = null
    const watcher = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(() => setSettledPx(chartPx()), WIDTH_SETTLE_MS)
    })
    watcher.observe(body)
    return () => { watcher.disconnect(); clearTimeout(timer) }
  }, [])
  // A width that changes the text charts' buckets reads them again; any other width reads nothing.
  useEffect(() => {
    const text = reading?.groups?.find(g => g.text)
    if (settledPx === null || !text) return
    const pick = readableResolution(reading.start, reading.end, text.names.length, settledPx)
    if (pick && pick.id !== text.resolution.id) read().catch(() => {})
    // On a settled width only: a new read settles `reading` and must not re-pick by itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledPx])

  // The timer runs only while the window reaches now: an ended window cannot gain a reading.
  const live = holdsNow(win, now)
  usePolling(read, every * 1000, live && every > 0)

  // What Buckets offers for the window and the metrics chosen now: Auto's pick and coarser.
  const { start: shownStart, end: shownEnd } = windowBounds(win, now)
  const auto = shownStart && shownEnd && shownEnd > shownStart
    ? pickResolution(shownStart.getTime(), shownEnd.getTime(), names.length)
    : null

  const canExport = hasPermission?.(PERMISSION_UUIDS.TELEMETRY_READ) ?? false
  const exportBlocked = names.length === 0
    ? 'This device has no metric to export.'
    : !(shownStart && shownEnd && shownEnd > shownStart) ? 'Set both ends of the custom range to export it.' : null
  /** The export, with the window fixed to its bounds now, so the file is what the dialog names. */
  const openExport = () => {
    const at = Date.now()
    const { start, end } = windowBounds(win, at)
    setExporting({ names, from: start.toISOString(), to: end.toISOString(), windowWords: windowWords(win, at) })
  }

  // The groups of the metrics chosen, and which are open; the Metrics list is grouped the same way.
  const groups = useMemo(() => metricGroups(names, catalog), [names, catalog])
  const metricOptions = useMemo(
    () => metricGroups(metrics, catalog).flatMap(g => g.names.map(m => ({ value: m, label: m, group: g.label }))),
    [metrics, catalog]
  )
  const setGroupsOpen = (keys, open) => setClosedGroups(prev => {
    const next = new Set(prev)
    for (const k of keys) if (open) next.delete(k); else next.add(k)
    writeClosedGroups(next)
    return next
  })

  const filterCount = [!sameWindow(win, DEFAULT_HISTORY_WINDOW), chosen.length > 0, bucket !== 'auto'].filter(Boolean).length
  const clear = () => { setWin(DEFAULT_HISTORY_WINDOW); setChosen(ALL_METRICS); setBucket('auto') }

  const charts = useMemo(() => {
    if (!reading?.byMetric) return []
    // Each resolution's bucket starts, once: the text charts may read at their own.
    const startsOf = new Map(reading.groups.map(g => [g.resolution.id, bucketStarts(reading.start, reading.end, g.resolution.minutes)]))
    return reading.names.map(name => {
      const resolution = reading.resolutionOf.get(name)
      const starts = startsOf.get(resolution.id)
      const series = chartSeries(reading.byMetric.get(name) || [], starts)
      const unit = units.get(name) ?? null
      const validRange = ranges.get(name) ?? null
      return {
        name, unit, series, validRange, resolution, starts,
        summary: chartSummary({
          metric: name, unit, windowText: reading.windowText, resolution, series, validRange, starts,
          span: { start: reading.start, end: reading.end, now: reading.at },
        }),
      }
    })
  }, [reading, units, ranges])
  const chartGroups = useMemo(() => {
    const byName = new Map(charts.map(c => [c.name, c]))
    return metricGroups(charts.map(c => c.name), catalog).map(g => ({ ...g, charts: g.names.map(n => byName.get(n)) }))
  }, [charts, catalog])

  const busy = Boolean(reading?.loading) || reading === null

  // The periods an alert on this device was firing, over the window the charts drew.
  const alertSpan = reading?.byMetric ? { start: reading.start, end: reading.end, at: reading.at } : null
  const alerts = useAlertBands(deviceIds(device).issued, alertSpan)

  // A drag across a chart: its fractions are of the window the charts draw, the read's.
  const drawnSpan = reading?.byMetric ? { start: reading.start, ms: reading.end - reading.start } : null
  const atFraction = (f) => drawnSpan.start + drawnSpan.ms * f
  const { band, onPointerDown: startBand } = useBandDrag((a, b) => {
    if (drawnSpan) setWin(bandWindow(atFraction(a), atFraction(b), drawnSpan.ms), { replace: false })
  }, CHART_BAND)
  /** The band as drawn: its ends as fractions, and the window a release sets, in words. */
  const shownBand = band && drawnSpan ? (() => {
    const lo = Math.min(band.a, band.b)
    const hi = Math.max(band.a, band.b)
    const { start, end } = windowBounds(bandWindow(atFraction(lo), atFraction(hi), drawnSpan.ms))
    return { lo, hi, mid: (lo + hi) / 2, words: bandWords(start, end, now) }
  })() : null

  return (
    <>
      <div className="filter-bar">
        <DeviceSwitcher device={device} devices={devices} win={win} chosen={chosen} bucket={bucket} />
        <TimeWindowControl value={win} onChange={setWin} ranges={HISTORY_RANGES} spans={HISTORY_SPANS} zoom />
        <FilterDropdown
          label="Metrics"
          noun="metric"
          plural="metrics"
          options={metricOptions}
          value={chosen}
          onChange={setChosen}
          words={v => (v.length === 0 ? 'All metrics' : null)}
          width="sm"
          tip="Chart only the metrics you choose. Fewer metrics fit finer buckets."
        />
        <BucketChoice value={bucket} options={bucketOptions(auto)} onChange={setBucket} />
        <div className="filter-bar-actions">
          <ClearFilters count={filterCount} onClear={clear} />
          <ActionButton
            className="btn btn-primary btn-sm"
            permitted={canExport}
            deniedTitle={`Exporting readings needs telemetry access. ${requiresRolesTitle(PERMISSION_UUIDS.TELEMETRY_READ)}.`}
            disabled={Boolean(exportBlocked)}
            title={exportBlocked ?? 'Download the readings of the metrics shown, over this window, as CSV'}
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

      {/* Measured for the text charts' bucket width (chartPx). The part of the card that gives way,
          as Overview's lanes are: the row above the charts stays, and .trail-scroll scrolls them. */}
      <div className="history-body card-fill-scroll trail-timeline" ref={bodyRef}>
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
          {/* One row above the charts, as the Audit Trail has above its sections: the control that
              opens or closes every group first, over the group headings it acts on, then the line
              saying what is shown. */}
          <div className="history-header">
            <ExpandAllToggle
              anyOpen={groups.some(g => !closedGroups.has(g.key))}
              onExpandAll={() => setGroupsOpen(groups.map(g => g.key), true)}
              onCollapseAll={() => setGroupsOpen(groups.map(g => g.key), false)}
              noun="groups"
              disabled={groups.length === 0}
            />
            <p className="history-meta" role="status">
              {metaWords({ names: reading.names, total: metrics.length, groups: reading.groups, refused: reading.refused, reads: reading.reads })}
              {reading.loading && ' · reading again…'}
            </p>
            {alerts.bands.length > 0 && (
              <AlertKey count={new Set(alerts.bands.map(b => b.id)).size} to={alertsAddress(win, { assets: [deviceIds(device).issued] })} />
            )}
          </div>
          {/* A press on a chart or a strip and a drag zooms (useBandDrag). */}
          <div className="trail-scroll">
          <div className="history-groups" onPointerDown={startBand}>
            {chartGroups.map(g => {
              const open = !closedGroups.has(g.key)
              const id = `${groupsId}-${g.key}`
              const shown = g.charts
              return (
                <section key={g.key} className="history-group" aria-label={g.label}>
                  <div className="history-group-head">
                    <GroupHeading
                      open={open}
                      onToggle={() => setGroupsOpen([g.key], !open)}
                      label={g.label}
                      count={shown.length}
                      countLabel={`${shown.length} ${shown.length === 1 ? 'chart' : 'charts'}`}
                      controls={id}
                    />
                  </div>
                  <div id={id} className="history-charts" hidden={!open}>
                    {open && shown.map(c => (
                      <TimeSeriesChart
                        key={c.name}
                        metric={c.name}
                        unit={c.unit}
                        starts={c.starts}
                        series={c.series}
                        start={reading.start}
                        end={reading.end}
                        now={now}
                        minutes={c.resolution.minutes}
                        validRange={c.validRange}
                        summary={c.summary}
                        syncKey={`history-${device.asset_id}`}
                        band={shownBand}
                        plugins={alerts.plugins}
                      />
                    ))}
                  </div>
                </section>
              )
            })}
          </div>
          </div>
        </>
      )}
      </div>

      {exporting && (
        <TelemetryExportModal
          device={device}
          metricNames={exporting.names}
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
