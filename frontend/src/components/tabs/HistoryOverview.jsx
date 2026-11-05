import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
import { ARROW_INSET, Tooltip, tooltipHost } from '../common/Tooltip'
import { IconChartLine, IconCpu, IconX, IconZoomIn } from '../common/Icons'
import { useClockTick } from '../../hooks/useClockTick'
import { usePolling } from '../../hooks/usePolling'
import { useBandDrag } from '../../hooks/useBandDrag'
import { useClickOutside } from '../../hooks/useClickOutside'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { navigate, useUrlList, useUrlState } from '../../hooks/useUrlState'
import { DEVICE_STATUS, deviceDotStyle, deviceLifecycleStatus, deviceStatusTitle } from '../../utils/deviceStatus'
import { bandWindow, clockWords, holdsNow, sameWindow, windowBounds } from '../../utils/timeWindow'
import {
  CHART_SEVERAL_REASON, COVERAGE_KEY, COVERAGE_PER_READ, COVERAGE_STEPS, DEFAULT_CHART_PX, DEFAULT_HISTORY_WINDOW,
  ENDED_WINDOW_REASON, HISTORY_RANGES, HISTORY_REFRESH_EVERY, HISTORY_SPANS, TOO_LONG_FOR_MANY, axisTicks, blockReadoutWords,
  blockWords, boxWords, bucketStarts, coverageBlock, coverageCounts, coverageRuns, coverageSteps, coverageSummary,
  deviceMatches, deviceMetrics, groupIsOpen, groupKeys, inReads, mergeCounts, nowFraction, overviewGroups, pickedAddress,
  readOverviewGroups, readWidth, readingsStopWords, telemetryKey, uncountedStretches, uncountedWords, writeOverviewGroups,
} from '../../utils/history'

/** How often the page looks at the clock, so the now marker follows it. */
const CLOCK_MS = 60 * 1000

/** How long a change of width settles before the blocks are picked again. */
const WIDTH_SETTLE_MS = 300

/** How long typing in the search settles before a long window reads the devices it matches. */
const SEARCH_SETTLE_MS = 300

/** The band drag (hooks/useBandDrag.js): a press on any of Overview's tracks, each the window's width. */
const OVERVIEW_BAND = { track: '.overview-swimlanes .trail-track' }

/** The narrowest stretch of a track that holds the hatch's words, "No readings yet". */
const SHADE_WORDS_PX = 110

/** No device ticked. Hoisted: useUrlList's default is compared, not copied. */
const NONE = Object.freeze([])

/** A strip with nothing read for it. */
const NO_COUNTS = Object.freeze([])

const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/** A fraction of the window as a CSS length across a track. */
const at = (f) => `${f * 100}%`

/** Words held inside the track near either end, as the Audit Trail's band words and now marker are. */
const edgeClass = (base, f) => `${base}${f > 0.85 ? ` ${base}-end` : f < 0.15 ? ` ${base}-start` : ''}`

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
 * A track's blocks, a run of blocks of one shade a box: darker where more readings arrived, against
 * the strip's own busiest block (coverageSteps()). A block with none is the track's own colour.
 * Never a value, only how many readings arrived.
 */
function Blocks({ counts, reading }) {
  const runs = useMemo(() => coverageRuns(coverageSteps(counts)), [counts])
  const { start, end, starts, minutes } = reading
  const span = end - start
  const edge = (ms) => Math.min(1, Math.max(0, (ms - start) / span))
  return runs.map(r => {
    const left = edge(starts[r.from] * 1000)
    const right = edge(starts[r.to - 1] * 1000 + minutes * 60000)
    return <span key={r.from} className={`overview-run overview-step-${r.step}`} style={{ left: at(left), width: at(right - left) }} />
  })
}

/** From the block or the box to the bubble's or the popover's edge: room for the arrow's point. */
const GAP = 8
/** From the window's sides. */
const MARGIN = 8
/** How near the popover's corner its arrow may sit (FiltersPopover's ARROW_INSET). */
const POPOVER_ARROW_INSET = 16

const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi))

/**
 * Where a block's readout goes, `width` by `height`: below the block's track, centred on the block
 * and kept inside the track's width, or above it where the scroll area `area` has no room below,
 * as on the last lane. `arrowX` is the block's centre from the bubble's left edge.
 */
export function placeReadout(block, track, area, { width, height }) {
  const centre = clamp((block.left + block.right) / 2, track.left, track.right)
  const left = Math.max(track.left, Math.min(centre - width / 2, track.right - width))
  const above = track.bottom + GAP + height > area.bottom
  return {
    left,
    top: above ? track.top - GAP - height : track.bottom + GAP,
    above,
    arrowX: clamp(centre - left, ARROW_INSET, Math.max(ARROW_INSET, width - ARROW_INSET)),
  }
}

/**
 * Where the selection's popover goes, `width` by `height`, beside the box's visible part `box` in a
 * `vw` by `vh` window: below it, or above it where there is no room below, centred on it and kept
 * inside the window. A box taller than the window has it over its foot (`over`, no arrow).
 */
export function placeSelection(box, { width, height }, vw, vh) {
  const centre = clamp((box.left + box.right) / 2, MARGIN, vw - MARGIN)
  const left = Math.max(MARGIN, Math.min(centre - width / 2, vw - width - MARGIN))
  const arrowX = clamp(centre - left, POPOVER_ARROW_INSET, Math.max(POPOVER_ARROW_INSET, width - POPOVER_ARROW_INSET))
  if (box.bottom + GAP + height <= vh - MARGIN) return { left, top: box.bottom + GAP, above: false, over: false, arrowX }
  if (box.top - GAP - height >= MARGIN) return { left, top: box.top - GAP - height, above: true, over: false, arrowX }
  return { left, top: Math.max(MARGIN, vh - height - MARGIN), above: false, over: true, arrowX }
}

/**
 * The block under the pointer, in words: its stretch and how many readings arrived in it. The
 * tooltip's bubble and arrow (`.tooltip-bubble`), portalled as the tooltip is, so no row or card
 * clips it, and placed below the block (placeReadout()). The track's own words say the same to a
 * screen reader, so this is for the pointer only.
 */
function Readout({ hover, counts, reading, now }) {
  const ref = useRef(null)
  const [pos, setPos] = useState(null)
  const startMs = reading.starts[hover.i] * 1000
  const words = blockReadoutWords(startMs, reading.minutes, counts[hover.i] ?? 0, {
    spanMs: reading.end - reading.start, counted: reading.counted, now,
  })
  useLayoutEffect(() => {
    const el = ref.current
    const { track } = hover
    if (!el || !track?.isConnected) return
    const t = track.getBoundingClientRect()
    const area = track.closest('.trail-scroll')?.getBoundingClientRect() ?? { bottom: window.innerHeight }
    const span = reading.end - reading.start
    const edge = (ms) => t.left + clamp((ms - reading.start) / span, 0, 1) * t.width
    const block = { left: edge(startMs), right: edge(startMs + reading.minutes * 60000) }
    setPos(placeReadout(block, t, area, { width: el.offsetWidth, height: el.offsetHeight }))
  }, [hover, startMs, words, reading])
  return createPortal(
    <span
      ref={ref}
      className={`tooltip-bubble overview-readout${pos?.above ? ' tooltip-bubble-above' : ''}`}
      aria-hidden="true"
      style={pos ? { left: pos.left, top: pos.top, '--arrow-x': `${pos.arrowX}px` } : { left: 0, top: 0, visibility: 'hidden' }}
    >
      {words}
    </span>,
    tooltipHost(hover.track),
  )
}

/**
 * One device's row of the grid: its label (tick box, status dot as the Site Map draws it, name as a
 * link to its charts, and its metric count as the qualifier), then its track of blocks, where its
 * readings stop in words, and the readout of the block under the pointer.
 */
function Lane({ device, laneKey, counts, reading, metrics, ticked, onTick, win, now, hover, deep }) {
  const status = deviceLifecycleStatus(device)
  const offline = status !== DEVICE_STATUS.ONLINE
  // A device a long window's read left out (the search changed since) draws an empty track, unworded.
  const stop = counts
    ? readingsStopWords(counts, reading.starts, reading.minutes, { start: reading.start, end: reading.end, now, counted: reading.counted })
    : null
  return (
    <div className={`trail-lane overview-lane${deep ? ' overview-lane-deep' : ''}`} data-lanes={laneKey}>
      <div className="trail-lane-label">
        <input
          type="checkbox"
          className="overview-pick"
          checked={ticked}
          onChange={e => onTick(laneKey, e.target.checked)}
          aria-label={`Pick ${device.asset_name}`}
        />
        <Tooltip text={deviceStatusTitle(status)}>
          <span className="overview-status" tabIndex={0}>
            <span className="badge-dot" style={deviceDotStyle(device)} aria-hidden="true" />
            {/* Never colour alone: an offline device says so in words, as the Site Map's chip does. */}
            {!offline && <span className="sr-only">Online</span>}
          </span>
        </Tooltip>
        <RouteLink to={pickedAddress(device.asset_id, win)} className="overview-lane-name" title={`Chart ${device.asset_name}'s readings over this window`}>
          <OverflowText className="trail-lane-name">{device.asset_name}</OverflowText>
        </RouteLink>
        {offline && <span className="overview-lane-offline">Offline</span>}
        <span className="trail-lane-qualifier">{plural(metrics, 'metric', 'metrics')}</span>
      </div>
      <div
        className="trail-track overview-track"
        data-hover={`d:${laneKey}`}
        role="img"
        aria-label={counts ? coverageSummary(device.asset_name, counts, stop) : device.asset_name}
      >
        <Blocks counts={counts || NO_COUNTS} reading={reading} />
        {stop && <span className="overview-stop">{stop}</span>}
        {hover?.id === `d:${laneKey}` && counts && <Readout hover={hover} counts={counts} reading={reading} now={now} />}
      </div>
    </div>
  )
}

/** The key, in words: a block with none, the shades from fewer readings to more, and a block not counted yet when one is drawn. */
function CoverageKey({ uncounted }) {
  return (
    <div className="overview-key" role="group" aria-label="Key">
      <span className="overview-key-item">
        <span className="overview-swatch overview-swatch-none" aria-hidden="true" />
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

/** What in the popover takes the focus as it opens: its first action that is not off. */
const FIRST_ACTION = 'button:not([disabled]):not([aria-disabled="true"])'

/**
 * The selection's words and actions in a popover beside the box, as on the Datasets page of AMRC's
 * ACS: Chart (the Device tab, for one device), Zoom and Clear. Portalled to <body> as the toolbar's
 * popovers are, so the card cannot clip it, and fixed below the box's visible part, or above it
 * (placeSelection()), its arrow at the box's centre. Focus moves to its first action that is not off,
 * and Tab stays inside it. Escape, Clear, a press outside, a scroll and a resize close it, and the
 * box with it (`onClose`).
 */
function SelectionPopover({ box, layerRef, words, keys, win, names, onZoom, onClose }) {
  const ref = useClickOutside(onClose)
  const [pos, setPos] = useState(null)
  useEscapeKey(onClose)

  useLayoutEffect(() => {
    const el = ref.current
    const drawn = layerRef.current?.querySelector('.overview-box')
    if (!el || !drawn) return
    // The box's part the lanes' scroller shows, which is what the popover points at.
    const r = drawn.getBoundingClientRect()
    const area = drawn.closest('.trail-scroll')?.getBoundingClientRect()
    const shown = area ? { left: r.left, right: r.right, top: Math.max(r.top, area.top), bottom: Math.min(r.bottom, area.bottom) } : r
    setPos(placeSelection(shown, { width: el.offsetWidth, height: el.offsetHeight }, window.innerWidth, window.innerHeight))
  }, [box, words, ref, layerRef])

  // Once placed. Not scrolled to, which would close it.
  const placed = pos !== null
  useEffect(() => {
    if (placed) ref.current?.querySelector(FIRST_ACTION)?.focus({ preventScroll: true })
  }, [placed, ref])

  const closer = useRef(onClose)
  closer.current = onClose
  useEffect(() => {
    const dismiss = (e) => { if (!(e.target instanceof Node && ref.current?.contains(e.target))) closer.current() }
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', dismiss, true)
    return () => {
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', dismiss, true)
    }
  }, [ref])

  // Escape here before a tooltip inside takes it, and Tab round its actions.
  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key !== 'Tab') return
    const actions = [...ref.current.querySelectorAll('button:not([disabled])')]
    if (actions.length === 0) return
    const [first, last] = [actions[0], actions[actions.length - 1]]
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="Selection"
      className={`overview-popover${pos?.above ? ' overview-popover-above' : ''}${pos?.over ? ' overview-popover-over' : ''}`}
      onKeyDown={onKeyDown}
      // Unplaced, transparent rather than hidden, as ToolbarPopover is, so the focus above lands.
      style={pos ? { left: pos.left, top: pos.top, '--arrow-x': `${pos.arrowX}px` } : { left: 0, top: 0, opacity: 0, pointerEvents: 'none' }}
    >
      <p className="overview-popover-words" role="status">{words}</p>
      <div className="overview-popover-actions">
        <ChartButton keys={keys} win={win} names={names} />
        <Tooltip text="Show this stretch of the window, as a new step in your browser's history">
          <button type="button" className="btn btn-primary btn-sm" onClick={onZoom}>
            <IconZoomIn size={13} aria-hidden="true" /> Zoom
          </button>
        </Tooltip>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
          <IconX size={13} aria-hidden="true" /> Clear
        </button>
      </div>
    </div>,
    document.body,
  )
}

/**
 * History's Overview: where readings arrived over the window, before anything is charted. The
 * Audit Trail's lane grid: a label column, then a track per row, under an axis. A row per device,
 * grouped as the Site Map places devices (overviewGroups()): each area and its cells, the cells in
 * no area, then Site-Wide, Simulated and Unassigned, each group a section row. A track is a strip of
 * blocks, darker where more readings arrived, from telemetry_coverage() (0245), read for every
 * device at about one block per COVERAGE_BLOCK_PX of the track, in parts that fit its bound; the
 * block under the pointer is read out in words. A closed group's section row carries its devices'
 * counts merged. Which groups are open is kept in this browser (OVERVIEW_GROUPS_KEY); on a first
 * visit all are, unless the page would draw more lanes than OVERVIEW_OPEN_LANES_MAX.
 *
 * A drag across the tracks draws a selection box: the devices whose rows it covers and the stretch
 * of the window it spans, named on the axis while it is drawn. On release a popover beside it holds
 * its words, Chart (the Device tab, for one device), Zoom (the page's window, as a new history entry)
 * and Clear (SelectionPopover). The box is a shortcut: each lane's tick box picks devices
 * (`?device=`), the toolbar then offers Chart at the time control's window, and the control zooms.
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
  const gridRef = useRef(null)
  const layerRef = useRef(null)
  // Each read's number: only the newest may land, so a slow read never draws over a later one.
  const latestRead = useRef(0)
  const [reading, setReading] = useState(null)
  const [box, setBox] = useState(null)
  const [hover, setHover] = useState(null)

  /** The width a track is drawn at: the axis track's, else the page's less the label column, else a default's. */
  const stripPx = () => {
    const body = bodyRef.current
    const track = body?.querySelector('.trail-axis-track')
    const width = track?.clientWidth || (body ? body.clientWidth - Math.min(260, Math.max(140, body.clientWidth * 0.3)) - 10 : 0)
    return width > 0 ? width : DEFAULT_CHART_PX
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
    const at0 = Date.now()
    const { start, end } = windowBounds(win, at0)
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
    const span = { start: from, end: to, minutes, asked: minutes, starts, at: at0, devices: chosen.keys.length }
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
      const width = readWidth(rows.flat(), minutes)
      const laid = width === minutes ? starts : bucketStarts(from, to, width)
      setReading({ ...span, minutes: width, starts: laid, ...coverageCounts(rows.flat(), chosen.keys, laid.length), reads: parts.length })
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

  /** The rows a stretch of the page from `y0` to `y1` covers: their devices, and their top and height in the box's layer. */
  const rowsUnder = (y0, y1) => {
    const host = gridRef.current
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
  /** The popover closes, and the box with it: focus goes back to the box's first lane, or its group's heading. */
  const closeBox = () => {
    const keysIn = new Set(box?.keys ?? [])
    const row = [...(gridRef.current?.querySelectorAll('[data-lanes]') ?? [])]
      .find(el => el.dataset.lanes.split(' ').some(k => keysIn.has(k)))
    const target = row?.matches('.trail-section') ? row.querySelector('.group-heading') : row?.querySelector('.overview-pick')
    setBox(null)
    target?.focus({ preventScroll: true })
  }
  // A new window leaves the box behind: it named the window the tracks drew.
  useEffect(() => { setBox(null) }, [windowKey])

  const dragged = band && drawn ? (() => {
    const rows = rowsUnder(band.y0 ?? 0, band.y ?? band.y0 ?? 0)
    return rows ? { lo: Math.min(band.a, band.b), hi: Math.max(band.a, band.b), ...rows } : null
  })() : null
  const shownBox = dragged ?? (box && drawn ? box : null)
  // While a box is drawn the axis names it, and while one is held its popover does: no block is
  // read out over either.
  const pointed = dragged || box ? null : hover
  const boxWindow = shownBox ? bandWindow(atFraction(shownBox.lo), atFraction(shownBox.hi), drawn.ms) : null
  const boxBounds = boxWindow ? windowBounds(boxWindow) : null
  const boxText = shownBox ? boxWords(shownBox.keys.length, boxBounds.start.getTime(), boxBounds.end.getTime(), now) : null
  const zoomToBox = () => { setWin(boxWindow, { replace: false }); closeBox() }

  // ---- The readout -------------------------------------------------------------------------------
  /** The block under the pointer: which track, which block and where, from the track's own box. */
  const pointAt = (e) => {
    const track = e.target.closest?.('[data-hover]')
    if (!track || !reading?.counts) { setHover(null); return }
    const r = track.getBoundingClientRect()
    if (!(r.width > 0)) return
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    const t = reading.start + f * (reading.end - reading.start)
    const width = reading.minutes * 60000
    const i = Math.min(reading.starts.length - 1, Math.max(0, Math.floor((t - reading.starts[0] * 1000) / width)))
    setHover(h => (h && h.id === track.dataset.hover && h.i === i ? h : { id: track.dataset.hover, i, f, track }))
  }

  // ---- What the page draws -----------------------------------------------------------------------
  const countsOf = (list) => mergeCounts(list.map(d => reading.counts.get(telemetryKey(d))), reading.starts.length)
  const fraction = reading?.counts ? nowFraction(reading.start, reading.end, now) : null
  // What the device rollups have not counted yet: hatched apart from the future, and named.
  const uncounted = reading?.counts ? uncountedStretches(reading.counted, { start: reading.start, end: reading.end, now }) : []
  const uncountedNote = reading?.counts ? uncountedWords(reading.counted, reading.start) : null
  const ticks = reading?.counts ? axisTicks(win, reading.start, reading.end) : []
  const busy = Boolean(reading?.loading) || reading === null
  const allKeys = groupKeys(shown)
  const trackPx = typeof document === 'undefined' ? 0 : (bodyRef.current?.querySelector('.trail-axis-track')?.clientWidth || 0)
  const futureFits = fraction !== null && (!trackPx || (1 - fraction) * trackPx >= SHADE_WORDS_PX)

  /** The hatched parts of a track that is opaque: a section row's, which the layer behind cannot show through. */
  const shades = (withWords) => (
    <>
      {uncounted.map(u => <span key={u.lo} className="overview-uncounted" aria-hidden="true" style={{ left: at(u.lo), width: at(u.hi - u.lo) }} />)}
      {fraction !== null && (
        <span className="trail-shade trail-shade-future" aria-hidden="true" style={{ left: at(fraction) }}>
          {withWords && futureFits && 'No readings yet'}
        </span>
      )}
    </>
  )

  const renderGroup = (g, depth) => {
    const open = isOpen(g.key)
    const id = `${groupsId}-${g.key}`
    const merged = open ? null : countsOf(g.devices)
    const hoverId = `g:${g.key}`
    return (
      <React.Fragment key={g.key}>
        {/* A row of the grid: the heading in the label column and a track beside it, as the Audit
            Trail's sections are. Closed, the track carries its devices' counts merged. */}
        <div
          className={`trail-section${open ? '' : ' trail-section-closed'}${depth ? ' overview-subsection' : ''}`}
          data-lanes={open ? undefined : g.devices.map(telemetryKey).join(' ')}
        >
          <div className="trail-lane-label">
            <GroupHeading
              open={open}
              onToggle={() => setGroupsOpen([g.key], !open)}
              label={g.label}
              detail={plural(g.devices.length, 'device', 'devices')}
              controls={id}
            />
          </div>
          <div
            className="trail-track overview-track"
            data-hover={open ? undefined : hoverId}
            {...(open ? {} : { role: 'img', 'aria-label': coverageSummary(`${g.label}, ${plural(g.devices.length, 'device', 'devices')} merged`, merged, null) })}
          >
            {shades(depth === 0)}
            {!open && <Blocks counts={merged} reading={reading} />}
            {!open && pointed?.id === hoverId && <Readout hover={pointed} counts={merged} reading={reading} now={now} />}
          </div>
        </div>
        <div id={id} role="group" aria-label={`${g.label} lanes`} hidden={!open}>
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
                  hover={pointed}
                  deep={depth > 0}
                />
              )
            }))}
        </div>
      </React.Fragment>
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
          {/* The tick boxes' way to Chart, without a drag: on for exactly one device. */}
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

      {/* Measured for the blocks' width (stripPx). The part of the card that gives way, as the Audit
          Trail's timeline is: the row above the lanes stays, and .trail-scroll scrolls the grid. */}
      <div className="history-body card-fill-scroll trail-timeline" ref={bodyRef}>
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
            {/* The row above the lanes, as on the Device tab: Expand all or Collapse all first, then
                what is shown, then the key at the row's end. */}
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
                {reading.loading && ' · reading again…'}
              </p>
              <CoverageKey uncounted={uncounted.length > 0} />
            </div>

            {shown.length === 0 ? (
              <EmptyState icon={<IconCpu size={36} />} message={`No device matches "${search.trim()}".`} />
            ) : (
              <div className="trail-scroll" onScroll={() => setHover(null)}>
                {/* A press on a track and a drag draws the selection box (useBandDrag); the pointer
                    over a track reads out its block. */}
                <div
                  className="trail-swimlanes overview-swimlanes"
                  ref={gridRef}
                  onPointerDown={startBand}
                  onPointerMove={pointAt}
                  onPointerLeave={() => setHover(null)}
                >
                  <div className="trail-lane trail-axis">
                    <div className="trail-lane-label trail-axis-corner" aria-hidden="true" />
                    <div className="trail-track trail-axis-track" aria-hidden="true">
                      {ticks.map(t => (
                        <span key={t.f} className="trail-tick" style={{ left: at(t.f) }}>{t.label}</span>
                      ))}
                      {fraction !== null && (
                        <div className={edgeClass('trail-now', fraction)} style={{ left: at(fraction) }}>
                          Now {clockWords(new Date(now))}
                        </div>
                      )}
                      {dragged && <div className="trail-band" style={{ left: at(dragged.lo), width: at(dragged.hi - dragged.lo) }} />}
                      {dragged && (
                        <div className={edgeClass('trail-band-words', (dragged.lo + dragged.hi) / 2)} style={{ left: at((dragged.lo + dragged.hi) / 2) }}>
                          {boxText}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="trail-body">
                    {shown.map(g => renderGroup(g, 0))}

                    {/* Behind the rows, across the track column: a dotted line from each tick, and the
                        hatched parts of the window, as the Audit Trail draws them. */}
                    <div className="trail-gridlines" aria-hidden="true">
                      {ticks.map(t => <span key={t.f} className="trail-gridline" style={{ left: at(t.f) }} />)}
                      {shades(false)}
                    </div>
                    {/* Over the tracks: the selection box. */}
                    <div className="overview-box-layer" ref={layerRef} aria-hidden="true">
                      {shownBox && (
                        <div
                          className="overview-box"
                          style={{ left: at(shownBox.lo), width: at(shownBox.hi - shownBox.lo), top: shownBox.top, height: shownBox.height }}
                        />
                      )}
                    </div>
                    {box && !dragged && shownBox && (
                      <SelectionPopover
                        box={box}
                        layerRef={layerRef}
                        words={boxText}
                        keys={shownBox.keys}
                        win={boxWindow}
                        names={names}
                        onZoom={zoomToBox}
                        onClose={closeBox}
                      />
                    )}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
}
