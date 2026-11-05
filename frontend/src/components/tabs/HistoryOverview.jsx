import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { COVERAGE_SMALL_SELECTION, api } from '../../api'
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
import { Tooltip } from '../common/Tooltip'
import { PLOT_LEFT_PX, PLOT_RIGHT_PX } from '../common/TimeSeriesChart'
import { IconChartLine, IconCpu, IconZoomIn } from '../common/Icons'
import { useClockTick } from '../../hooks/useClockTick'
import { usePolling } from '../../hooks/usePolling'
import { useBandDrag } from '../../hooks/useBandDrag'
import { navigate, useUrlList, useUrlState } from '../../hooks/useUrlState'
import { DEVICE_STATUS, deviceDotStyle, deviceLifecycleStatus, deviceStatusTitle } from '../../utils/deviceStatus'
import { bandWindow, clockWords, holdsNow, sameWindow, windowBounds } from '../../utils/timeWindow'
import {
  CHART_SEVERAL_REASON, COVERAGE_KEY, COVERAGE_PER_READ, COVERAGE_STEPS, DEFAULT_CHART_PX, DEFAULT_HISTORY_WINDOW,
  ENDED_WINDOW_REASON, HISTORY_RANGES, HISTORY_REFRESH_EVERY, HISTORY_SPANS, TOO_LONG_FOR_MANY, axisTicks, blockWords,
  boxWords, bucketStarts, coverageBlock, coverageCounts, coverageRuns, coverageSteps, coverageSummary, deviceMatches,
  deviceMetrics, groupIsOpen, groupKeys, inReads, mergeCounts, nowFraction, overviewGroups, pickedAddress,
  readOverviewGroups, readWidth, readingsStopWords, telemetryKey, uncountedStretches, uncountedWords, writeOverviewGroups,
} from '../../utils/history'

/** How often the page looks at the clock, so the now marker follows it. */
const CLOCK_MS = 60 * 1000

/** How long a change of width settles before the blocks are picked again. */
const WIDTH_SETTLE_MS = 300

/** How long typing in the search settles before a long window reads the devices it matches. */
const SEARCH_SETTLE_MS = 300

/** The band drag (hooks/useBandDrag.js): a press on any strip, each the window's width. */
const OVERVIEW_BAND = { track: '.overview-strip' }

/** No device ticked. Hoisted: useUrlList's default is compared, not copied. */
const NONE = Object.freeze([])

/** A strip with nothing read for it. */
const NO_COUNTS = Object.freeze([])

const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/** The groups, and each area's groups, narrowed to the devices that match `text`; empty ones go. */
function matchingGroups(groups, text) {
  if (!String(text ?? '').trim()) return groups
  const narrow = (g) => {
    if (!g.groups) {
      const devices = g.devices.filter(d => deviceMatches(d, text))
      return devices.length ? { ...g, devices } : null
    }
    const groupsIn = g.groups.map(narrow).filter(Boolean)
    return groupsIn.length ? { ...g, groups: groupsIn, devices: groupsIn.flatMap(s => s.devices) } : null
  }
  return groups.map(narrow).filter(Boolean)
}

/**
 * One strip of blocks across the window, a run of blocks of one shade a box: darker where more
 * readings arrived, against the strip's own busiest block (coverageSteps()). A block with none is
 * the strip's ground. Never a value, only how many readings arrived.
 */
function CoverageStrip({ counts, reading, summary }) {
  const runs = useMemo(() => coverageRuns(coverageSteps(counts)), [counts])
  const { start, end, starts, minutes } = reading
  const span = end - start
  const edge = (ms) => Math.min(1, Math.max(0, (ms - start) / span))
  return (
    <div className="overview-strip" role="img" aria-label={summary}>
      {runs.map(r => {
        const left = edge(starts[r.from] * 1000)
        const right = edge(starts[r.to - 1] * 1000 + minutes * 60000)
        return (
          <span
            key={r.from}
            className={`overview-run overview-step-${r.step}`}
            style={{ left: `${left * 100}%`, width: `${(right - left) * 100}%` }}
          />
        )
      })}
    </div>
  )
}

/**
 * One device's lane: its tick box, its name (a link to its charts at the window shown), its status
 * dot as the Site Map draws it, how many metrics it reports, where its readings stop, then its strip.
 */
function Lane({ device, laneKey, counts, reading, metrics, ticked, onTick, win, now }) {
  const status = deviceLifecycleStatus(device)
  const offline = status !== DEVICE_STATUS.ONLINE
  // A device a long window's read left out (the search changed since) draws an empty strip, unworded.
  const stop = counts
    ? readingsStopWords(counts, reading.starts, reading.minutes, { start: reading.start, end: reading.end, now, counted: reading.counted })
    : null
  return (
    <div className="overview-row overview-lane" data-lanes={laneKey}>
      <div className="overview-lane-head">
        <input
          type="checkbox"
          className="overview-pick"
          checked={ticked}
          onChange={e => onTick(laneKey, e.target.checked)}
          aria-label={`Pick ${device.asset_name}`}
        />
        <RouteLink
          to={pickedAddress(device.asset_id, win)}
          className="overview-lane-name"
          title={`Chart ${device.asset_name}'s readings over this window`}
        >
          <OverflowText>{device.asset_name}</OverflowText>
        </RouteLink>
        <Tooltip text={deviceStatusTitle(status)}>
          <span className="overview-lane-meta" tabIndex={0}>
            <span className="badge-dot" style={deviceDotStyle(device)} aria-hidden="true" />
            {/* Never colour alone: an offline device says so in words, as the Site Map's chip does. */}
            {offline ? <span className="overview-lane-offline">Offline</span> : <span className="sr-only">Online</span>}
            <span>{plural(metrics, 'metric', 'metrics')}</span>
          </span>
        </Tooltip>
        {stop && <span className="overview-lane-stop">{stop}</span>}
      </div>
      <CoverageStrip counts={counts || NO_COUNTS} reading={reading} summary={counts ? coverageSummary(device.asset_name, counts, stop) : device.asset_name} />
    </div>
  )
}

/** The key, in words: a block with none, the shades from fewer readings to more, and a block not counted yet when one is drawn. */
function CoverageKey({ uncounted }) {
  return (
    <div className="overview-key" role="group" aria-label="Key">
      <span className="overview-key-item">
        <span className="overview-swatch" aria-hidden="true" />
        {COVERAGE_KEY.none}
      </span>
      <span className="overview-key-item">
        {COVERAGE_KEY.fewer}
        <span className="overview-key-shades" aria-hidden="true">
          {Array.from({ length: COVERAGE_STEPS }, (_, i) => (
            <span key={i} className={`overview-swatch overview-step-${i + 1}`} />
          ))}
        </span>
        <span aria-hidden="true">→</span>
        {COVERAGE_KEY.more}
      </span>
      {uncounted && (
        <span className="overview-key-item">
          <span className="overview-swatch overview-swatch-uncounted" aria-hidden="true" />
          {COVERAGE_KEY.uncounted}
        </span>
      )}
    </div>
  )
}

/**
 * Chart, for the devices picked: the Device tab for one, at `win`. With several it is off and says
 * why, keeping its Tab stop (`aria-disabled`) so the reason reaches a keyboard.
 */
function ChartButton({ keys, win, names }) {
  const several = keys.length > 1
  const chart = () => { if (!several && keys.length) navigate(pickedAddress(keys[0], win)) }
  return (
    <Tooltip text={several ? CHART_SEVERAL_REASON : `Chart ${names.get(keys[0]) ?? 'this device'}'s readings over this window`}>
      <button
        type="button"
        className={`btn btn-primary btn-sm${several ? ' btn-disabled' : ''}`}
        aria-disabled={several ? 'true' : undefined}
        onClick={chart}
      >
        <IconChartLine size={13} aria-hidden="true" /> Chart
      </button>
    </Tooltip>
  )
}

/**
 * History's Overview: where readings arrived over the window, before anything is charted. A lane
 * per device, grouped as the Site Map places devices (overviewGroups()): each area and its cells,
 * the cells in no area, then Site-Wide, Simulated and Unassigned. A lane is a strip of blocks,
 * darker where more readings arrived, from telemetry_coverage() (0245), read for every device at
 * about one block per COVERAGE_BLOCK_PX of the strip, in parts that fit its bound. A closed group
 * draws one strip of its devices' counts merged. Which groups are open is kept in this browser
 * (OVERVIEW_GROUPS_KEY); on a first visit all are, unless the page would draw more lanes than
 * OVERVIEW_OPEN_LANES_MAX.
 *
 * A drag across the strips draws a selection box: the devices whose rows it covers and the
 * stretch of the window it spans, in words, with Chart (the Device tab, for one device) and Zoom
 * (the page's window, as a new history entry). Escape or a press outside clears it. The box is a
 * shortcut: each lane's tick box picks devices (`?device=`), the toolbar's Chart charts them at the
 * time control's window, and the control zooms.
 */
export function HistoryOverview({ devices, cells, areas, schemas, win, setWin, every, setEvery }) {
  useClockTick(CLOCK_MS)
  const now = Date.now()
  const [search, setSearch] = useUrlState('search', '')
  const groups = useMemo(() => overviewGroups(devices, cells, areas), [devices, cells, areas])
  const placed = useMemo(() => groups.flatMap(g => g.devices), [groups])
  const keys = useMemo(() => placed.map(telemetryKey), [placed])
  const names = useMemo(() => new Map(placed.map(d => [telemetryKey(d), d.asset_name])), [placed])
  const metricCounts = useMemo(
    () => new Map(placed.map(d => [telemetryKey(d), deviceMetrics(d, schemas).length])),
    [placed, schemas]
  )
  const [ticked, setTicked] = useUrlList('device', NONE, { allowed: keys })
  const shown = useMemo(() => matchingGroups(groups, search), [groups, search])
  const [choices, setChoices] = useState(readOverviewGroups)
  const isOpen = (key) => groupIsOpen(key, choices, placed.length)
  const groupsId = useId()
  const bodyRef = useRef(null)
  const plotRef = useRef(null)
  const layerRef = useRef(null)
  const barRef = useRef(null)
  // Each read's number: only the newest may land, so a slow read never draws over a later one.
  const latestRead = useRef(0)
  const [reading, setReading] = useState(null)
  const [box, setBox] = useState(null)

  /** The width a strip is drawn at: a strip's, else the page's less its gutters, else a default's. */
  const stripPx = () => {
    const body = bodyRef.current
    const strip = body?.querySelector('.overview-strip')
    const inset = body ? parseFloat(getComputedStyle(body).getPropertyValue('--inset')) || 16 : 16
    const width = strip?.clientWidth || (body ? body.clientWidth - 2 * inset - PLOT_LEFT_PX - PLOT_RIGHT_PX : 0)
    return width > 0 ? width : DEFAULT_CHART_PX - PLOT_LEFT_PX - PLOT_RIGHT_PX
  }

  // The devices the search matches, once typing settles: a window too long for the whole fleet
  // reads them alone when they are few enough. A shorter one reads every device and filters here.
  const [settledSearch, setSettledSearch] = useState(search)
  useEffect(() => {
    const timer = setTimeout(() => setSettledSearch(search), SEARCH_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [search])
  const matchingKeys = useMemo(
    () => matchingGroups(groups, settledSearch).flatMap(g => g.devices).map(telemetryKey),
    [groups, settledSearch]
  )

  const keysKey = keys.join('\n')
  const windowKey = JSON.stringify(win)
  /** What a read over [from, to) takes: its devices and block width, or why there is none. */
  const plan = (from, to, px) => {
    const minutes = coverageBlock(from, to, px, keys.length)
    if (minutes !== null) return { keys, minutes }
    if (matchingKeys.length > 0 && matchingKeys.length <= COVERAGE_SMALL_SELECTION) {
      return { keys: matchingKeys, minutes: coverageBlock(from, to, px, matchingKeys.length) }
    }
    return { problem: TOO_LONG_FOR_MANY }
  }
  // Which devices a long window reads, by value; a short window's read does not depend on the search.
  const { start: shownStart, end: shownEnd } = windowBounds(win, now)
  const longKey = shownStart && shownEnd && coverageBlock(shownStart.getTime(), shownEnd.getTime(), DEFAULT_CHART_PX, keys.length) === null
    ? matchingKeys.join('\n') : ''
  const read = useCallback(async (signal) => {
    const id = ++latestRead.current
    const at = Date.now()
    const { start, end } = windowBounds(win, at)
    if (!start || !end || end <= start) {
      setReading({ problem: 'Set both ends of the custom range to see where readings arrived in it.' })
      return
    }
    const [from, to] = [start.getTime(), end.getTime()]
    const chosen = plan(from, to, stripPx())
    if (chosen.problem) {
      setReading({ problem: chosen.problem })
      return
    }
    const { minutes } = chosen
    const starts = bucketStarts(from, to, minutes)
    const span = { start: from, end: to, minutes, asked: minutes, starts, at, devices: chosen.keys.length }
    if (chosen.keys.length === 0) {
      setReading({ ...span, counts: new Map(), counted: { from: -Infinity, to: Infinity, complete: true }, reads: 0 })
      return
    }
    setReading(r => ({ ...(r?.counts ? r : {}), loading: true }))
    const parts = inReads(chosen.keys, COVERAGE_PER_READ)
    try {
      const rows = await Promise.all(parts.map(part => api.readCoverage({
        from: start.toISOString(), to: end.toISOString(), blockMinutes: minutes, assetIds: part,
      }, { signal })))
      if (id !== latestRead.current) return
      // A window older than the 5-minute rollup reaches comes back in hours (block_width).
      const shown = readWidth(rows.flat(), minutes)
      const laid = shown === minutes ? starts : bucketStarts(from, to, shown)
      setReading({ ...span, minutes: shown, starts: laid, ...coverageCounts(rows.flat(), chosen.keys, laid.length), reads: parts.length })
    } catch (e) {
      if (e?.name !== 'AbortError' && !signal?.aborted && id === latestRead.current) {
        setReading({ ...span, error: e?.message || 'Where readings arrived could not be read.' })
      }
      // Rethrown so usePolling backs off on a failing read rather than hammering it.
      throw e
    }
    // The window and the devices by value: a new object of the same window is the same read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysKey, windowKey, longKey])

  useEffect(() => {
    const controller = new AbortController()
    read(controller.signal).catch(() => {})
    return () => controller.abort()
  }, [read])

  // A width that changes the blocks reads again, once it settles; any other width reads nothing.
  const [settledPx, setSettledPx] = useState(null)
  useEffect(() => {
    const body = bodyRef.current
    if (!body || typeof ResizeObserver !== 'function') return undefined
    let timer = null
    const watcher = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(() => setSettledPx(stripPx()), WIDTH_SETTLE_MS)
    })
    watcher.observe(body)
    return () => { watcher.disconnect(); clearTimeout(timer) }
  }, [])
  useEffect(() => {
    if (settledPx === null || !reading?.counts) return
    if (coverageBlock(reading.start, reading.end, settledPx, reading.devices) !== reading.asked) read().catch(() => {})
    // On a settled width only: a new read settles `reading` and must not re-pick by itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledPx])

  // The timer runs only while the window reaches now: an ended window cannot gain a reading.
  const live = holdsNow(win, now)
  usePolling(read, every * 1000, live && every > 0)

  const setGroupsOpen = (list, open) => setChoices(prev => {
    const next = { ...prev }
    for (const k of list) next[k] = open
    writeOverviewGroups(next)
    return next
  })
  const tick = (key, on) => setTicked(prev => (on ? [...prev, key] : prev.filter(k => k !== key)))

  const filterCount = [!sameWindow(win, DEFAULT_HISTORY_WINDOW), search.trim() !== ''].filter(Boolean).length
  const clear = () => { setWin(DEFAULT_HISTORY_WINDOW); setSearch('') }

  // ---- The selection box -------------------------------------------------------------------------
  const drawn = reading?.counts ? { start: reading.start, ms: reading.end - reading.start } : null
  const atFraction = (f) => drawn.start + drawn.ms * f

  /** The rows a stretch of the page from `y0` to `y1` covers: their devices, and their top and height in the layer. */
  const rowsUnder = (y0, y1) => {
    const host = plotRef.current
    const layer = layerRef.current
    if (!host || !layer) return null
    const [lo, hi] = [Math.min(y0, y1), Math.max(y0, y1)]
    const rows = [...host.querySelectorAll('[data-lanes]')].filter(el => {
      const r = el.getBoundingClientRect()
      return r.top <= hi && r.bottom >= lo
    })
    if (rows.length === 0) return null
    const base = layer.getBoundingClientRect().top
    const rects = rows.map(el => el.getBoundingClientRect())
    return {
      keys: [...new Set(rows.flatMap(el => el.dataset.lanes.split(' ')))],
      top: Math.min(...rects.map(r => r.top)) - base,
      height: Math.max(...rects.map(r => r.bottom)) - Math.min(...rects.map(r => r.top)),
    }
  }
  const { band, onPointerDown: startBand } = useBandDrag((a, b, extent) => {
    const rows = drawn && extent ? rowsUnder(extent.y0, extent.y) : null
    setBox(rows ? { lo: Math.min(a, b), hi: Math.max(a, b), ...rows } : null)
  }, OVERVIEW_BAND)
  // While a box is drawn: Escape, or a press anywhere but its bar and itself, clears it.
  useEffect(() => {
    if (!box) return undefined
    const key = (e) => { if (e.key === 'Escape') setBox(null) }
    const press = (e) => {
      if (barRef.current?.contains(e.target)) return
      const r = layerRef.current?.querySelector('.overview-box')?.getBoundingClientRect()
      if (r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return
      setBox(null)
    }
    window.addEventListener('keydown', key)
    document.addEventListener('pointerdown', press, true)
    return () => { window.removeEventListener('keydown', key); document.removeEventListener('pointerdown', press, true) }
  }, [box])
  // A new read, or a new window, leaves the box behind: it named the window the strips drew.
  useEffect(() => { setBox(null) }, [windowKey])

  const dragged = band && drawn ? (() => {
    const rows = rowsUnder(band.y0 ?? 0, band.y ?? band.y0 ?? 0)
    return rows ? { lo: Math.min(band.a, band.b), hi: Math.max(band.a, band.b), ...rows } : null
  })() : null
  const shownBox = dragged ?? (box && drawn ? box : null)
  const boxWindow = shownBox ? bandWindow(atFraction(shownBox.lo), atFraction(shownBox.hi), drawn.ms) : null
  const boxBounds = boxWindow ? windowBounds(boxWindow) : null
  const zoomToBox = () => { setWin(boxWindow, { replace: false }); setBox(null) }

  // ---- What the page draws -----------------------------------------------------------------------
  const countsOf = (list) => mergeCounts(list.map(d => reading.counts.get(telemetryKey(d))), reading.starts.length)
  const fraction = reading?.counts ? nowFraction(reading.start, reading.end, now) : null
  // What the device rollups have not counted yet: hatched apart from the future, and named.
  const uncounted = reading?.counts ? uncountedStretches(reading.counted, { start: reading.start, end: reading.end, now }) : []
  const uncountedNote = reading?.counts ? uncountedWords(reading.counted, reading.start) : null
  const ticks = reading?.counts ? axisTicks(win, reading.start, reading.end).filter(t => fraction === null || t.f < fraction) : []
  const busy = Boolean(reading?.loading) || reading === null
  const allKeys = groupKeys(shown)

  const renderGroup = (g, depth) => {
    const open = isOpen(g.key)
    const id = `${groupsId}-${g.key}`
    const merged = open ? null : countsOf(g.devices)
    return (
      <section key={g.key} className="overview-group" aria-label={g.label}>
        <div className={`history-group-head${depth ? ' overview-subgroup-head' : ''}`}>
          <GroupHeading
            open={open}
            onToggle={() => setGroupsOpen([g.key], !open)}
            label={g.label}
            detail={plural(g.devices.length, 'device', 'devices')}
            controls={id}
          />
        </div>
        {!open && (
          <div className="overview-row overview-summary" data-lanes={g.devices.map(telemetryKey).join(' ')}>
            <CoverageStrip
              counts={merged}
              reading={reading}
              summary={coverageSummary(`${g.label}, ${plural(g.devices.length, 'device', 'devices')} merged`, merged, null)}
            />
          </div>
        )}
        <div id={id} className="overview-group-body" hidden={!open}>
          {open && (g.groups
            ? g.groups.map(s => renderGroup(s, depth + 1))
            : g.devices.map(d => {
              const k = telemetryKey(d)
              return (
                <Lane
                  key={k}
                  device={d}
                  laneKey={k}
                  counts={reading.counts.get(k)}
                  reading={reading}
                  metrics={metricCounts.get(k) ?? 0}
                  ticked={ticked.includes(k)}
                  onTick={tick}
                  win={win}
                  now={now}
                />
              )
            }))}
        </div>
      </section>
    )
  }

  return (
    <>
      <div className="filter-bar">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Find a device…"
          ariaLabel="Find a device by its name, id, cell or area"
        />
        <TimeWindowControl value={win} onChange={setWin} ranges={HISTORY_RANGES} spans={HISTORY_SPANS} zoom />
        <div className="filter-bar-actions">
          <ClearFilters count={filterCount} onClear={clear} />
          {ticked.length > 0 && <ChartButton keys={ticked} win={win} names={names} />}
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

      {/* Measured for the blocks' width (stripPx). */}
      <div className="history-body" ref={bodyRef}>
        {placed.length === 0 ? (
          <EmptyState icon={<IconCpu size={36} />} message="No device is in service yet, so no reading has arrived to show." />
        ) : reading?.problem ? (
          <EmptyState icon={<IconChartLine size={36} />} message={reading.problem} />
        ) : reading?.error ? (
          <div className="callout callout-danger">{`Where readings arrived could not be read: ${reading.error}`}</div>
        ) : !reading?.counts ? (
          <LoadingState label="where readings arrived" />
        ) : (
          <>
            {/* The row above the lanes, as on the Device tab: Expand all or Collapse all first,
                then what is shown, then the key at the row's end. */}
            <div className="history-header">
              <ExpandAllToggle
                anyOpen={allKeys.some(isOpen)}
                onExpandAll={() => setGroupsOpen(allKeys, true)}
                onCollapseAll={() => setGroupsOpen(allKeys, false)}
                noun="groups"
                disabled={allKeys.length === 0}
              />
              <p className="history-meta" role="status">
                {`${plural(reading.devices, 'device', 'devices')}, in ${blockWords(reading.minutes)}`}
                {uncountedNote && ` · ${uncountedNote}`}
                {ticked.length > 0 && ` · ${ticked.length} picked`}
                {reading.loading && ' · reading again…'}
              </p>
              <CoverageKey uncounted={uncounted.length > 0} />
            </div>

            {shown.length === 0 ? (
              <EmptyState icon={<IconCpu size={36} />} message={`No device matches "${search.trim()}".`} />
            ) : (
              /* A press on a strip and a drag draws the selection box (useBandDrag). */
              <div className="overview-plot" ref={plotRef} onPointerDown={startBand}>
                <div className="overview-axis" aria-hidden="true">
                  {ticks.map(t => (
                    <span
                      key={t.f}
                      className={`overview-axis-tick${t.f < 0.05 ? ' overview-axis-tick-start' : t.f > 0.95 ? ' overview-axis-tick-end' : ''}`}
                      style={{ left: `${t.f * 100}%` }}
                    >
                      {t.label}
                    </span>
                  ))}
                  {fraction !== null && (
                    <>
                      <div className="chart-future" style={{ left: `${fraction * 100}%` }}>{fraction < 0.8 && 'No readings yet'}</div>
                      <div className={`chart-now${fraction > 0.85 ? ' chart-now-end' : fraction < 0.15 ? ' chart-now-start' : ''}`} style={{ left: `${fraction * 100}%` }}>
                        Now {clockWords(new Date(now))}
                      </div>
                    </>
                  )}
                </div>

                {shown.map(g => renderGroup(g, 0))}

                {/* Over the strips, the window's width: the hatch after now and the box. */}
                <div className="overview-layer" ref={layerRef}>
                  {fraction !== null && <div className="chart-future" aria-hidden="true" style={{ left: `${fraction * 100}%` }} />}
                  {uncounted.map(u => (
                    <div key={u.lo} className="overview-uncounted" aria-hidden="true" style={{ left: `${u.lo * 100}%`, width: `${(u.hi - u.lo) * 100}%` }} />
                  ))}
                  {shownBox && (
                    <>
                      <div
                        className="overview-box"
                        aria-hidden="true"
                        style={{ left: `${shownBox.lo * 100}%`, width: `${(shownBox.hi - shownBox.lo) * 100}%`, top: shownBox.top, height: shownBox.height }}
                      />
                      <div
                        ref={barRef}
                        className={`overview-box-bar${shownBox.hi > 0.6 ? ' overview-box-bar-end' : ''}`}
                        role="group"
                        aria-label="Selection"
                        style={{
                          top: shownBox.top + shownBox.height + 4,
                          ...(shownBox.hi > 0.6 ? { right: `${(1 - shownBox.hi) * 100}%` } : { left: `${shownBox.lo * 100}%` }),
                        }}
                        onPointerDown={e => e.stopPropagation()}
                      >
                        <span className="overview-box-words" role="status">
                          {boxWords(shownBox.keys.length, boxBounds.start.getTime(), boxBounds.end.getTime(), now)}
                        </span>
                        {!dragged && (
                          <>
                            <ChartButton keys={shownBox.keys} win={boxWindow} names={names} />
                            <Tooltip text="Show this stretch of the window, as a new step in your browser's history">
                              <button type="button" className="btn btn-primary btn-sm" onClick={zoomToBox}>
                                <IconZoomIn size={13} aria-hidden="true" /> Zoom
                              </button>
                            </Tooltip>
                          </>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
}
