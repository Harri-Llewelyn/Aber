/*!
 * The charts are drawn by uPlot 1.6.32 (https://github.com/leeoniya/uPlot), whose notice follows.
 *
 * The MIT License (MIT)
 *
 * Copyright (c) 2022 Leon Sorokin
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { DerivedTag } from './DerivedTag'
import { bandText, bandsAt, bandsOf } from './alertBands'
import { NumberKey } from './NumberKey'
import { StateBand, StateBandKey } from './StateBand'
import { useChartTimeline } from './ChartTimeline'
import { clockWords } from '../../utils/timeWindow'
import { PLOT_LEFT_PX, PLOT_RIGHT_PX } from '../../utils/timelineAxis'
import {
  DEFAULT_CHART_PX, changeCount, chartPalette, chartTitle, latestWords, lowWords, markWords, markedStretches, momentWords, nowFraction, numberFigures,
  numberKey, readingWords, runNear, runWords, splitCarried, stateKey, stateRuns, stateShares, validRangeWords,
} from '../../utils/history'

const DAY_S = 24 * 60 * 60

/** No plugins: hoisted, so a chart without any is not drawn again on each render. */
const NO_PLUGINS = Object.freeze([])

/** No alert bands: hoisted, so a band without any is not drawn again on each render. */
const NO_BANDS = Object.freeze([])

/** How near the pointer, in pixels, a run thinner than this either side is found (runNear()). */
const HOVER_SLACK_PX = 4

/**
 * Under a shared time axis a chart is this much shorter, which is the room its own axis took, and
 * its plot keeps TIMED_PAD_PX above and below for the value axis's end labels.
 */
const TIMED_SAVED_PX = 25
const TIMED_PAD_PX = 10

/** What is under the pointer on a band when it is nowhere over it. */
const NO_STRIP_HOVER = Object.freeze({ mark: null, run: null, alerts: NO_BANDS })

/**
 * The theme's chart colours, read again whenever `<html data-theme>` changes, so a chart follows a
 * theme switch without a reload.
 */
export function useChartPalette() {
  const [palette, setPalette] = useState(() => chartPalette())
  useEffect(() => {
    if (typeof MutationObserver !== 'function') return undefined
    const watcher = new MutationObserver(() => setPalette(chartPalette()))
    watcher.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => watcher.disconnect()
  }, [])
  return palette
}

/** The time axis's labels: clock times inside a day, with the weekday on a longer window, then dates. */
const timeLabels = (spanS) => (u, splits, axisIdx, space, incr) => splits.map((s) => {
  const d = new Date(s * 1000)
  if (incr < DAY_S) {
    const clock = clockWords(d)
    return spanS > DAY_S ? `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${clock}` : clock
  }
  return incr < 28 * DAY_S
    ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
    : d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
})

/** Dotted lines at the schema's bounds, each labelled, where they fall inside the plot. */
const drawValidRange = (validRange, palette) => (u) => {
  const { ctx, bbox } = u
  const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
  for (const value of [validRange?.minimum, validRange?.maximum]) {
    if (value === null || value === undefined) continue
    const y = u.valToPos(value, 'y', true)
    if (!(y >= bbox.top && y <= bbox.top + bbox.height)) continue
    ctx.save()
    ctx.strokeStyle = palette.range
    ctx.fillStyle = palette.range
    ctx.lineWidth = ratio
    ctx.setLineDash([2 * ratio, 3 * ratio])
    ctx.beginPath()
    ctx.moveTo(bbox.left, y)
    ctx.lineTo(bbox.left + bbox.width, y)
    ctx.stroke()
    ctx.font = palette.font.replace(/^(\d+)px/, (m, px) => `${Number(px) * ratio}px`)
    ctx.fillText('valid range', bbox.left + 4 * ratio, y - 3 * ratio)
    ctx.restore()
  }
}

/** The plot area's gutters (utils/timelineAxis.js), which a text strip and the shared axis take too. */
export { PLOT_LEFT_PX, PLOT_RIGHT_PX }

/**
 * uPlot's options for one chart. Its own drag selection is off: the page's window is the only zoom.
 * `plugins` are the page's own uPlot plugins, such as the alert bands (alertBands.js). `yRange` fixes
 * a number chart's value scale to [low, high], so several charts can share one. Under a shared time
 * axis (`ticks`, a function giving the axis's ticks in seconds) the chart draws no time labels, only
 * gridlines at those ticks, and its pointer is a vertical line alone.
 */
function plotOptions({ width, height, start, end, validRange, yRange, palette, syncKey, onHover, plugins, unit, ticks }) {
  const axis = { stroke: palette.text, font: palette.font, grid: { stroke: palette.grid, width: 1 }, ticks: { stroke: palette.grid, width: 1 } }
  const line = { stroke: palette.line, width: 1.5, spanGaps: false }
  return {
    width,
    height,
    plugins,
    legend: { show: false },
    // Top, right, bottom, left; null is uPlot's own. The right is fixed so a strip can match it.
    padding: ticks ? [TIMED_PAD_PX, PLOT_RIGHT_PX, TIMED_PAD_PX, null] : [null, PLOT_RIGHT_PX, null, null],
    cursor: {
      drag: { x: false, y: false, setScale: false },
      ...(ticks ? { y: false } : {}),
      ...(syncKey ? { sync: { key: syncKey } } : {}),
    },
    select: { show: false },
    scales: {
      x: { time: true, range: [start / 1000, end / 1000] },
      y: yRange ? { range: yRange } : {},
    },
    axes: [
      ticks
        ? { ...axis, size: 0, ticks: { show: false }, splits: () => ticks(), values: (u, splits) => splits.map(() => '') }
        : { ...axis, values: timeLabels((end - start) / 1000) },
      {
        ...axis,
        size: PLOT_LEFT_PX,
        // A percentage says its sign on every tick; any other value says its unit in the title.
        values: (u, splits) => splits.map(v => lowWords(v, unit)),
      },
    ],
    series: [
      {},
      { label: 'Highest', stroke: palette.band, width: 0, points: { show: false } },
      { label: 'Lowest', stroke: palette.band, width: 0, points: { show: false } },
      { label: 'Average', ...line },
      { label: 'Carried forward', ...line, dash: [5, 4], points: { show: false } },
    ],
    bands: [{ series: [1, 2], fill: palette.band }],
    hooks: {
      draw: [drawValidRange(validRange, palette)],
      // The point under the pointer, and its time and slack in seconds for a chart of every change.
      setCursor: [(u) => {
        const left = u.cursor.left
        const at = Number.isFinite(left) && left >= 0 && u.posToVal ? u.posToVal(left, 'x') : null
        onHover(u.cursor.idx ?? null, at, at === null ? 0 : u.posToVal(left + HOVER_SLACK_PX, 'x') - at)
      }],
    },
  }
}

/**
 * Where now is, and the part after it hatched and named, over the plot. Under a shared axis the
 * hatch keeps its edge, a thin Now line, and says nothing: the axis names the badge and the words once.
 */
function NowMarker({ fraction, now, shared }) {
  const edge = fraction > 0.85 ? ' chart-now-end' : fraction < 0.15 ? ' chart-now-start' : ''
  return (
    <>
      <div className="chart-future" style={{ left: `${fraction * 100}%` }}>
        {!shared && fraction < 0.8 && 'No readings yet'}
      </div>
      {!shared && (
        <div className={`chart-now${edge}`} style={{ left: `${fraction * 100}%` }}>
          Now {clockWords(new Date(now))}
        </div>
      )}
    </>
  )
}

/** The pointer's vertical line across a strip, at `fraction` of the window. A number chart's is uPlot's own. */
function CursorLine({ fraction }) {
  return <div className="chart-cursor" aria-hidden="true" style={{ left: `${fraction * 100}%` }} />
}

/**
 * What a hovered key entry points at on a number chart, over the plot: a ring on a bucket's
 * extreme (`left` as a percentage of the window), or a dotted line across at a level.
 */
function KeyMark({ mark }) {
  return mark.left === undefined
    ? <div className="chart-level-mark" aria-hidden="true" style={{ top: mark.top }} />
    : <div className="chart-point-mark" aria-hidden="true" style={{ left: `${mark.left}%`, top: mark.top }} />
}

/**
 * A band being dragged across the charts (`band`: its ends and middle as fractions of the window,
 * and the window a release sets in words), drawn as the Audit Trail draws one on its axis. Under a
 * shared axis the chart shades it and the axis says the words once.
 */
function BandMark({ band, shared }) {
  const edge = band.mid > 0.85 ? ' chart-band-words-end' : band.mid < 0.15 ? ' chart-band-words-start' : ''
  const at = band.mid > 0.85 ? band.hi : band.mid < 0.15 ? band.lo : band.mid
  return (
    <>
      <div className="chart-band" aria-hidden="true" style={{ left: `${band.lo * 100}%`, width: `${(band.hi - band.lo) * 100}%` }} />
      {!shared && <div className={`chart-band-words${edge}`} aria-hidden="true" style={{ left: `${at * 100}%` }}>{band.words}</div>}
    </>
  )
}

/**
 * One time-series chart, on uPlot, sized to its container and redrawn when that changes, so a
 * window always fits the width and nothing scrolls sideways. The line is each bucket's average, the
 * band its minimum to maximum. A bucket with no reading carries the last value forward and is drawn
 * dashed, so a carried stretch never reads as a measured one. The schema's valid range is a dotted
 * line labelled "valid range". Where the window reaches past now, a Now line and a hatched "No
 * readings yet" mark the rest. Inside a ChartTimeline the page's one time axis draws the labels,
 * the Now badge and those words, so the chart keeps its gridlines at the axis's ticks, a thin Now
 * line and the hatch, is shorter by the room its own axis took, and shares the pointer: a hover over
 * any chart, strip or the axis draws one vertical line through all of them, and each head reads its
 * own value at that time. A state and a flag are one band of their runs (StateBand), which no
 * line draws: a state's a colour a value with its name kept where it fits, a flag's true and false
 * in two fixed colours, carried stretches hatched, and a key under it of each value's share of the
 * time (a flag's with its time and how many times it changed). A series of every change
 * (changeSeries()) is laid on its changes' own times instead of buckets, so a run starts and stops
 * when the value did; a bucket series may carry marks (markBuckets()), a dotted foot along the band.
 * `note` says which read the chart shows when the status line says otherwise. The head reads the
 * bucket under the pointer, or the run under it on a band, and otherwise the latest reading
 * (latestWords()). A number chart has a key under it (NumberKey): its lowest and highest with their
 * buckets, and its mean and median over time (numberFigures()); pointing at an entry marks it on the
 * plot. `band` is a drag's band, which the page shades on every chart; uPlot's own drag
 * selection stays off. `plugins` are uPlot plugins the page adds to a number chart, such as the
 * periods an alert was firing; a band is not drawn by uPlot, so it shades the `bands` those plugins
 * carry itself, and names the alerts under the pointer in the head. Pass the same array while they
 * are the same: a new one draws the chart again. `yRange` is a number chart's value
 * scale, `[low, high]`, the same across charts that share one (sharedScale()); it too is the same
 * array while it is the same. `label` names the chart in place of its metric and unit, and `head`
 * is what the title line shows in place of that name (a link, a status dot), so a machine's chart
 * is named by the machine: the figure keeps `label` as its name. `derived` marks a derived metric's
 * chart with a DerivedTag beside its title.
 *
 * Colours and the axis font are the theme's tokens, read again on a theme switch. The figure is
 * named by its title, and `summary` (chartSummary(), utils/history.js) is its text for a screen
 * reader. uPlot's drag selection is off: the page's time control is the only zoom.
 *
 *   <TimeSeriesChart metric="Spindle/LOAD" unit="kW" starts={starts} series={chartSeries(rows, starts)}
 *     start={startMs} end={endMs} now={Date.now()} minutes={5} summary={text} syncKey="device" />
 */
export function TimeSeriesChart({
  metric, unit, starts, series, start, end, now, minutes, validRange = null, summary, syncKey, band = null, height = 140,
  plugins = NO_PLUGINS, note = null, yRange = null, label = null, head = null, derived = false,
}) {
  const id = useId()
  const boxRef = useRef(null)
  const [over, setOver] = useState(null)
  const [failed, setFailed] = useState(false)
  const [hover, setHover] = useState(null)
  const [localAt, setLocalAt] = useState(null)
  const [keyMark, setKeyMark] = useState(null)
  const plotRef = useRef(null)
  const stripRef = useRef(null)
  // Under a shared time axis the pointer is the page's (ChartTimeline), and so is the band.
  const timeline = useChartTimeline()
  const shared = timeline !== null
  const shownBand = band ?? timeline?.band ?? null
  const timelineRef = useRef(null)
  timelineRef.current = timeline
  // Whether this chart's own setCursor is running, which is not the pointer moving over it.
  const applying = useRef(false)
  // Whether a cursor the page's pointer set, from a strip or the axis, is on the plot now.
  const applied = useRef(false)
  const palette = useChartPalette()
  const drawn = series.kind === 'number'
  // The plot's own height: a shared axis takes the time labels off the chart, and their room with them.
  const plotHeight = shared ? height - TIMED_SAVED_PX : height
  const isFlag = series.kind === 'flag'
  const isState = series.kind === 'state' || isFlag
  // A chart of every change carries its runs (changeSeries()); a bucket read's are worked out here.
  const runs = useMemo(
    () => series.runs ?? (isState ? stateRuns(series, starts, { start, end, now, minutes }) : []),
    [isState, series, starts, start, end, now, minutes]
  )
  const marks = useMemo(
    () => (isState ? markedStretches(series, starts, { start, end, now, minutes }) : []),
    [isState, series, starts, start, end, now, minutes]
  )
  const key = useMemo(() => (isState ? stateKey(stateShares(runs)) : null), [isState, runs])
  const changes = useMemo(() => (isFlag ? changeCount(series, runs) : null), [isFlag, series, runs])
  // A band is not a plot, so it shades the bands its plugins carry (alertBands.js) itself.
  const alerts = useMemo(() => (isState ? bandsOf(plugins) : NO_BANDS), [isState, plugins])
  const keyEntries = useMemo(() => {
    const figures = drawn ? numberFigures(series, starts, { now }) : null
    return figures ? numberKey(figures, starts, minutes, unit) : []
  }, [drawn, series, starts, now, minutes, unit])

  // The time the pointer is at, in milliseconds: the page's, or this strip's own when it has none.
  const pointerAt = shared ? (timeline.pointer?.at ?? null) : localAt
  // The mark, run and alerts under the pointer on a band; a thin run is found from a few pixels away (runNear()).
  const stripHover = useMemo(() => {
    if (!isState || pointerAt === null) return NO_STRIP_HOVER
    const width = stripRef.current?.getBoundingClientRect().width
    const msPerPx = (end - start) / (width > 0 ? width : DEFAULT_CHART_PX)
    const mark = marks.find(m => pointerAt >= m.startMs && pointerAt < m.endMs) ?? null
    return {
      mark,
      run: mark ? null : runNear(runs, pointerAt, HOVER_SLACK_PX * msPerPx),
      alerts: alerts.length ? bandsAt(alerts, pointerAt) : NO_BANDS,
    }
  }, [isState, pointerAt, marks, runs, alerts, start, end])
  const { mark: markHover, run: runHover, alerts: alertHover } = stripHover

  // The page's ticks as uPlot's splits, in seconds, so a gridline is under every label of the axis.
  const tickKey = shared ? timeline.ticks.map(t => t.at).join(',') : ''
  const tickKeyRef = useRef('')
  tickKeyRef.current = tickKey
  const drawnTicks = useRef('')

  useEffect(() => {
    const box = boxRef.current
    if (!drawn || !box) return undefined
    const { read, held } = splitCarried(series)
    // The pointer over a chart is the page's too, unless this chart is the one being handed it.
    const onHover = (idx, at, slack) => {
      setHover(idx === null ? null : { idx, at, slack })
      if (applying.current || !timelineRef.current) return
      if (at === null) timelineRef.current.clear('plot')
      else timelineRef.current.point({ at: at * 1000, by: 'plot' })
    }
    const ticks = shared ? () => (timelineRef.current?.ticks ?? []).map(t => t.at / 1000) : null
    let plot
    try {
      plot = new uPlot(
        plotOptions({ width: box.clientWidth || 600, height: plotHeight, start, end, validRange, yRange, palette, syncKey, onHover, plugins, unit, ticks }),
        [starts, series.max, series.min, read, held],
        box,
      )
    } catch {
      setFailed(true)
      return undefined
    }
    setFailed(false)
    plotRef.current = plot
    drawnTicks.current = tickKeyRef.current
    setOver(plot.over)
    const resize = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => plot.setSize({ width: box.clientWidth, height: plotHeight }))
      : null
    resize?.observe(box)
    return () => {
      resize?.disconnect()
      plot.destroy()
      plotRef.current = null
      setOver(null)
      setKeyMark(null)
    }
  }, [drawn, starts, series, start, end, plotHeight, validRange, yRange, palette, syncKey, plugins, unit, shared])

  // New ticks, as the axis narrows or widens, move the gridlines without building the chart again.
  useEffect(() => {
    if (!plotRef.current || drawnTicks.current === tickKey) return
    drawnTicks.current = tickKey
    plotRef.current.redraw?.(false, true)
  }, [tickKey])

  // A pointer over a strip or the axis puts this chart's cursor at its time; one over a chart is
  // uPlot's own, synced between the charts by `syncKey`.
  const handed = shared && timeline.pointer?.by !== 'plot' ? (timeline.pointer?.at ?? null) : undefined
  useEffect(() => {
    const plot = plotRef.current
    if (!plot || typeof plot.setCursor !== 'function') return
    if (handed === undefined) {
      applied.current = false
      return
    }
    if (handed === null && !applied.current) return
    const left = handed === null ? -10 : plot.valToPos(handed / 1000, 'x')
    const inside = handed !== null && left >= 0 && left <= (plot.over?.clientWidth || Infinity)
    applying.current = true
    try { plot.setCursor({ left: inside ? left : -10, top: 0 }, true, false) } finally { applying.current = false }
    applied.current = inside
  }, [handed, over])

  const fraction = nowFraction(start, end, now)
  const range = validRangeWords(validRange, unit)
  // On a band the head also names each alert firing under the pointer, as the plot's readout does.
  const alertWords = alertHover.length ? `Alert: ${alertHover.map(bandText).join('; ')}` : null
  const bandWords = markHover ? markWords(markHover, minutes, series.kind) : runHover ? runWords(runHover, minutes) : null
  const hovered = isState
    ? ([bandWords, alertWords].filter(Boolean).join(' — ') || null)
    : hover === null ? null
      : starts[hover.idx] !== undefined ? hoverWords(starts[hover.idx], series, hover.idx, unit, minutes) : null
  const headWords = hovered ?? latestWords(series, starts, minutes, unit)

  /** The pointer's time across the strip, which is the window's width: the page's pointer, or the strip's own. */
  const pointAt = (e) => {
    const box = e.currentTarget.getBoundingClientRect()
    if (!(box.width > 0)) return
    const at = start + ((e.clientX - box.left) / box.width) * (end - start)
    if (shared) timeline.point({ at, by: 'strip' })
    else setLocalAt(at)
  }
  const leaveStrip = () => (shared ? timeline.clear('strip') : setLocalAt(null))
  // A line across the strip where the pointer is, as the number charts' own cursor draws one.
  const cursorAt = shared && pointerAt !== null ? (pointerAt - start) / (end - start) : null

  /** A key entry's mark, placed from the plot's own scales: a ring at a bucket's value, or a level. */
  const markKey = (mark) => {
    const plot = plotRef.current
    if (!mark || typeof plot?.valToPos !== 'function') {
      setKeyMark(null)
      return
    }
    const top = plot.valToPos(mark.value, 'y')
    setKeyMark(mark.at === null ? { top } : { top, left: ((mark.at - start) / (end - start)) * 100 })
  }

  const title = label ?? chartTitle(metric, unit)
  // A head of the page's own cannot be the name: the figure and its image are named by `label`.
  const named = head ? { 'aria-label': title } : { 'aria-labelledby': `${id}-title` }
  return (
    <figure className="history-chart" {...named}>
      <figcaption className="history-chart-head">
        {head ?? <span className="history-chart-title" id={`${id}-title`}>{title}</span>}
        {derived && !head && <DerivedTag />}
        {range && <span className="history-chart-range">{range}</span>}
        {note && <span className="history-chart-read">{note}</span>}
        <span className="history-chart-hover" aria-hidden="true">{headWords}</span>
      </figcaption>
      <div className="chart-frame" role="img" {...named} aria-describedby={`${id}-summary`}>
        {drawn && <div ref={boxRef} className="chart-box" style={{ height: plotHeight }} hidden={failed} />}
        {isState && (
          <div
            ref={stripRef}
            className={`chart-box chart-box-states${alerts.length ? ' chart-box-states-alerted' : ''}`}
            style={{ marginLeft: PLOT_LEFT_PX, marginRight: PLOT_RIGHT_PX, width: 'auto' }}
            onPointerMove={pointAt}
            onPointerLeave={leaveStrip}
          >
            <StateBand runs={runs} marks={marks} start={start} end={end} flag={isFlag} alerts={alerts} />
            {(fraction !== null || shownBand || (cursorAt !== null && cursorAt >= 0 && cursorAt <= 1)) && (
              <div className="chart-overlay">
                {fraction !== null && <NowMarker fraction={fraction} now={now} shared={shared} />}
                {shownBand && <BandMark band={shownBand} shared={shared} />}
                {cursorAt !== null && cursorAt >= 0 && cursorAt <= 1 && <CursorLine fraction={cursorAt} />}
              </div>
            )}
          </div>
        )}
        {(series.kind === 'none' || failed) && (
          <div className="chart-box chart-box-empty">
            {failed ? 'This chart could not be drawn in this browser.' : 'No readings in this window, and none before it.'}
          </div>
        )}
        {drawn && !failed && over && (fraction !== null || shownBand || keyMark) && createPortal(
          <>
            {fraction !== null && <NowMarker fraction={fraction} now={now} shared={shared} />}
            {shownBand && <BandMark band={shownBand} shared={shared} />}
            {keyMark && <KeyMark mark={keyMark} />}
          </>,
          over,
        )}
      </div>
      {isState && key.shown.length > 0 && (
        <StateBandKey stateKey={key} carried={runs.some(r => r.carried.length > 0)} mixed={marks.length > 0} flag={isFlag} changes={changes} />
      )}
      {keyEntries.length > 0 && <NumberKey entries={keyEntries} onMark={markKey} />}
      <p className="sr-only" id={`${id}-summary`}>{summary}</p>
    </figure>
  )
}

/** The bucket of a number chart under the pointer, in words: its time, its average and range, or that it carried. */
function hoverWords(x, series, i, unit, minutes) {
  const when = momentWords(x * 1000, minutes)
  const v = series.avg[i]
  if (v === null) return series.withheld?.[i] ? `${when} · total withheld, a machine had no value` : `${when} · no reading yet`
  if (series.carried[i]) return `${when} · ${readingWords(v, unit)}, carried forward`
  const lo = series.min[i]
  const hi = series.max[i]
  return lo !== null && hi !== null && lo !== hi
    ? `${when} · ${readingWords(v, unit)} (${lowWords(lo, unit)} to ${readingWords(hi, unit)})`
    : `${when} · ${readingWords(v, unit)}`
}
