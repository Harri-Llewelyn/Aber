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
import { OverflowText } from './OverflowText'
import { DerivedTag } from './DerivedTag'
import { clockWords } from '../../utils/timeWindow'
import {
  chartPalette, chartTitle, latestWords, lowWords, markWords, markedStretches, momentWords, nowFraction, readingWords, runNear,
  runWords, shareWords, splitCarried, stateHue, stateKey, stateRuns, stateShares, validRangeWords,
} from '../../utils/history'

const DAY_S = 24 * 60 * 60

/** No plugins: hoisted, so a chart without any is not drawn again on each render. */
const NO_PLUGINS = Object.freeze([])

/** How near the pointer, in pixels, a run thinner than this either side is found (runNear()). */
const HOVER_SLACK_PX = 4

/** Under this many pixels a state's box keeps its colour and edge but no name, which could not show. */
const NAMED_RUN_PX = 24

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

/**
 * The plot area's gutters, in pixels: the value axis on the left, and room on the right for the
 * last time label. A text strip takes the same, so one time is at one place across every chart.
 */
export const PLOT_LEFT_PX = 56
export const PLOT_RIGHT_PX = 28

/**
 * uPlot's options for one chart. Its own drag selection is off: the page's window is the only zoom.
 * `plugins` are the page's own uPlot plugins, such as the alert bands (alertBands.js). `yRange` fixes
 * a number chart's value scale to [low, high], so several charts can share one.
 */
function plotOptions({ width, height, series, start, end, validRange, yRange, palette, syncKey, onHover, plugins, unit }) {
  const flag = series.kind === 'flag'
  // A flag's bucket that held both values is a band from false to true (markBuckets()).
  const banded = !flag || (series.marked || []).some(n => n > 1)
  const axis = { stroke: palette.text, font: palette.font, grid: { stroke: palette.grid, width: 1 }, ticks: { stroke: palette.grid, width: 1 } }
  const line = { stroke: palette.line, width: 1.5, spanGaps: false, ...(flag ? { paths: uPlot.paths.stepped({ align: 1 }) } : {}) }
  return {
    width,
    height,
    plugins,
    legend: { show: false },
    // Top, right, bottom, left; null is uPlot's own. The right is fixed so a strip can match it.
    padding: [null, PLOT_RIGHT_PX, null, null],
    cursor: { drag: { x: false, y: false, setScale: false }, ...(syncKey ? { sync: { key: syncKey } } : {}) },
    select: { show: false },
    scales: {
      x: { time: true, range: [start / 1000, end / 1000] },
      y: flag ? { range: [-0.2, 1.2] } : yRange ? { range: yRange } : {},
    },
    axes: [
      { ...axis, values: timeLabels((end - start) / 1000) },
      {
        ...axis,
        size: PLOT_LEFT_PX,
        ...(flag ? { splits: () => [0, 1] } : {}),
        // A percentage says its sign on every tick; any other value says its unit in the title.
        values: (u, splits) => splits.map(v => (flag ? (v === 1 ? 'true' : v === 0 ? 'false' : '') : lowWords(v, unit))),
      },
    ],
    series: [
      {},
      { label: 'Highest', stroke: palette.band, width: 0, points: { show: false } },
      { label: 'Lowest', stroke: palette.band, width: 0, points: { show: false } },
      { label: 'Average', ...line },
      { label: 'Carried forward', ...line, dash: [5, 4], points: { show: false } },
    ],
    bands: banded ? [{ series: [1, 2], fill: palette.band }] : [],
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

/** Where now is, and the part after it hatched and named, over the plot. */
function NowMarker({ fraction, now }) {
  const edge = fraction > 0.85 ? ' chart-now-end' : fraction < 0.15 ? ' chart-now-start' : ''
  return (
    <>
      <div className="chart-future" style={{ left: `${fraction * 100}%` }}>
        {fraction < 0.8 && 'No readings yet'}
      </div>
      <div className={`chart-now${edge}`} style={{ left: `${fraction * 100}%` }}>
        Now {clockWords(new Date(now))}
      </div>
    </>
  )
}

/**
 * A band being dragged across the charts (`band`: its ends and middle as fractions of the window,
 * and the window a release sets in words), drawn as the Audit Trail draws one on its axis.
 */
function BandMark({ band }) {
  const edge = band.mid > 0.85 ? ' chart-band-words-end' : band.mid < 0.15 ? ' chart-band-words-start' : ''
  const at = band.mid > 0.85 ? band.hi : band.mid < 0.15 ? band.lo : band.mid
  return (
    <>
      <div className="chart-band" aria-hidden="true" style={{ left: `${band.lo * 100}%`, width: `${(band.hi - band.lo) * 100}%` }} />
      <div className={`chart-band-words${edge}`} aria-hidden="true" style={{ left: `${at * 100}%` }}>{band.words}</div>
    </>
  )
}

/** A value's hue for App.css to colour it with, through the CSSOM: `--state-hue` (stateHue()). */
const hueOf = (state) => ({ '--state-hue': stateHue(state) })

/**
 * A state metric as runs of its value across the window: text, which no line can draw. Each value
 * takes the hue its text hashes to, at the theme's lightness and chroma, and keeps its name, and a
 * carried stretch is hatched, as a number chart dashes one. A box under NAMED_RUN_PX keeps its
 * colour and edge at its own width, at least 2px, without the name; the head names it under the
 * pointer. A bucket that held more than one value (`marks`) is dotted along its foot.
 */
function StateStrip({ runs, marks, start, end }) {
  const ref = useRef(null)
  const [px, setPx] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    setPx(el.clientWidth)
    if (typeof ResizeObserver !== 'function') return undefined
    const watcher = new ResizeObserver(() => setPx(el.clientWidth))
    watcher.observe(el)
    return () => watcher.disconnect()
  }, [])
  const span = end - start
  const part = (from, to, of) => ({ left: `${((from - of.from) / of.span) * 100}%`, width: `${((to - from) / of.span) * 100}%` })
  const whole = { from: start, span }
  return (
    <div className="chart-states" ref={ref}>
      {runs.map(r => {
        const own = { from: r.startMs, span: r.endMs - r.startMs }
        const thin = px > 0 && ((r.endMs - r.startMs) / span) * px < NAMED_RUN_PX
        return (
          <span key={r.from} className={`chart-state${thin ? ' chart-state-thin' : ''}`} style={{ ...part(r.startMs, r.endMs, whole), ...hueOf(r.state) }}>
            {r.carried.map(c => (
              <span key={c.startMs} className="chart-state-carried" style={part(c.startMs, c.endMs, own)} />
            ))}
            {!thin && <OverflowText>{r.state}</OverflowText>}
          </span>
        )
      })}
      {marks.map(m => <span key={m.startMs} className="chart-state-mixed" style={part(m.startMs, m.endMs, whole)} />)}
    </div>
  )
}

/** Under a state chart: each value with its colour and its share of the charted time, then the others. */
function StateKey({ stateKey: key, carried, mixed }) {
  return (
    <ul className="chart-state-key">
      {key.shown.map(s => (
        <li key={s.state} className="chart-state-key-value" style={hueOf(s.state)}>
          <span className="chart-state-swatch" aria-hidden="true" />
          <OverflowText className="chart-state-key-name">{s.state}</OverflowText>
          <span className="chart-state-share">{shareWords(s.share)}</span>
        </li>
      ))}
      {key.others && (
        <li className="chart-state-key-plain">
          <span className="chart-state-swatch" aria-hidden="true" />
          <span className="chart-state-key-name">{`${key.others.count} other${key.others.count === 1 ? '' : 's'}`}</span>
          <span className="chart-state-share">{shareWords(key.others.share)}</span>
        </li>
      )}
      {carried && (
        <li className="chart-state-key-plain">
          <span className="chart-state-swatch chart-state-swatch-carried" aria-hidden="true" />
          <span className="chart-state-key-name">carried forward</span>
        </li>
      )}
      {mixed && (
        <li className="chart-state-key-plain">
          <span className="chart-state-swatch chart-state-swatch-mixed" aria-hidden="true" />
          <span className="chart-state-key-name">more than one value in the bucket</span>
        </li>
      )}
    </ul>
  )
}

/**
 * One time-series chart, on uPlot, sized to its container and redrawn when that changes, so a
 * window always fits the width and nothing scrolls sideways. The line is each bucket's average, the
 * band its minimum to maximum. A bucket with no reading carries the last value forward and is drawn
 * dashed, so a carried stretch never reads as a measured one. The schema's valid range is a dotted
 * line labelled "valid range". Where the window reaches past now, a Now line and a hatched "No
 * readings yet" mark the rest. A flag steps between false and true; a state is a strip of its runs,
 * a colour a value with its name kept, carried stretches hatched, and a key of each value's share
 * of the time under it. A series of every change (changeSeries()) is laid on its changes' own
 * times instead of buckets, so a flag steps and a run starts and stops when the value did; a bucket
 * series may carry marks (markBuckets()), a flag's as a band from false to true and a state's as a
 * dotted foot. `note` says which read the chart shows when the status line says otherwise. The head
 * reads the bucket under the pointer, or the run under it on a state strip or a flag of every
 * change, and otherwise the latest reading (latestWords()). `band` is a drag's band, which the
 * page shades on every chart; uPlot's own drag selection stays off. `plugins` are uPlot plugins
 * the page adds to a number or flag chart, such as the periods an alert was firing; a state strip
 * is not drawn by uPlot and takes none. Pass the same array while they are the same: a new one
 * draws the chart again. `yRange` is a number chart's value scale, `[low, high]`, the same across
 * charts that share one (sharedScale()); it too is the same array while it is the same. `label`
 * names the chart in place of its metric and unit, and `head` is what the title line shows in place
 * of that name (a link, a status dot), so a machine's chart is named by the machine: the figure
 * keeps `label` as its name. `derived` marks a derived metric's chart with a DerivedTag beside its title.
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
  const [runHover, setRunHover] = useState(null)
  const [markHover, setMarkHover] = useState(null)
  const palette = useChartPalette()
  const drawn = series.kind === 'number' || series.kind === 'flag'
  const isState = series.kind === 'state'
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

  useEffect(() => {
    const box = boxRef.current
    if (!drawn || !box) return undefined
    const { read, held } = splitCarried(series)
    const onHover = (idx, at, slack) => setHover(idx === null ? null : { idx, at, slack })
    let plot
    try {
      plot = new uPlot(
        plotOptions({ width: box.clientWidth || 600, height, series, start, end, validRange, yRange, palette, syncKey, onHover, plugins, unit }),
        [starts, series.max, series.min, read, held],
        box,
      )
    } catch {
      setFailed(true)
      return undefined
    }
    setFailed(false)
    setOver(plot.over)
    const resize = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => plot.setSize({ width: box.clientWidth, height }))
      : null
    resize?.observe(box)
    return () => {
      resize?.disconnect()
      plot.destroy()
      setOver(null)
    }
  }, [drawn, starts, series, start, end, height, validRange, yRange, palette, syncKey, plugins, unit])

  const fraction = nowFraction(start, end, now)
  const range = validRangeWords(validRange, unit)
  /** A flag of every change: the run at the pointer's time, not the change nearest it. */
  const flagRun = () => {
    const run = hover?.at === null || hover?.at === undefined ? null : runNear(runs, hover.at * 1000, hover.slack * 1000)
    return run ? runWords(run, minutes) : null
  }
  const hovered = isState
    ? (markHover ? markWords(markHover, minutes) : runHover ? runWords(runHover, minutes) : null)
    : hover === null ? null
      : series.runs ? flagRun()
        : starts[hover.idx] !== undefined ? hoverWords(starts[hover.idx], series, hover.idx, unit, minutes) : null
  const headWords = hovered ?? latestWords(series, starts, minutes, unit)

  /**
   * The run under the pointer, from where it is across the strip, which is the window's width, or
   * the marked bucket there: a thin run is found from a few pixels away (runNear()).
   */
  const pointAt = (e) => {
    const box = e.currentTarget.getBoundingClientRect()
    if (!(box.width > 0)) return
    const msPerPx = (end - start) / box.width
    const t = start + (e.clientX - box.left) * msPerPx
    const mark = marks.find(m => t >= m.startMs && t < m.endMs) ?? null
    setMarkHover(mark)
    setRunHover(mark ? null : runNear(runs, t, HOVER_SLACK_PX * msPerPx))
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
        {drawn && <div ref={boxRef} className="chart-box" style={{ height }} hidden={failed} />}
        {isState && (
          <div
            className="chart-box chart-box-states"
            style={{ marginLeft: PLOT_LEFT_PX, marginRight: PLOT_RIGHT_PX, width: 'auto' }}
            onPointerMove={pointAt}
            onPointerLeave={() => { setRunHover(null); setMarkHover(null) }}
          >
            <StateStrip runs={runs} marks={marks} start={start} end={end} />
            {(fraction !== null || band) && (
              <div className="chart-overlay">
                {fraction !== null && <NowMarker fraction={fraction} now={now} />}
                {band && <BandMark band={band} />}
              </div>
            )}
          </div>
        )}
        {(series.kind === 'none' || failed) && (
          <div className="chart-box chart-box-empty">
            {failed ? 'This chart could not be drawn in this browser.' : 'No readings in this window, and none before it.'}
          </div>
        )}
        {drawn && !failed && over && (fraction !== null || band) && createPortal(
          <>
            {fraction !== null && <NowMarker fraction={fraction} now={now} />}
            {band && <BandMark band={band} />}
          </>,
          over,
        )}
      </div>
      {isState && key.shown.length > 0 && (
        <StateKey stateKey={key} carried={runs.some(r => r.carried.length > 0)} mixed={marks.length > 0} />
      )}
      <p className="sr-only" id={`${id}-summary`}>{summary}</p>
    </figure>
  )
}

/** The bucket under the pointer, in words: its time, its average and range, or that it carried. */
function hoverWords(x, series, i, unit, minutes) {
  const when = momentWords(x * 1000, minutes)
  const v = series.avg[i]
  if (v === null) return series.withheld?.[i] ? `${when} · total withheld, a machine had no value` : `${when} · no reading yet`
  if (series.kind === 'flag') {
    const both = series.marked?.[i] > 1 ? ', both values in this bucket' : ''
    return `${when} · ${v ? 'true' : 'false'}${series.carried[i] ? ', carried forward' : ''}${both}`
  }
  if (series.carried[i]) return `${when} · ${readingWords(v, unit)}, carried forward`
  const lo = series.min[i]
  const hi = series.max[i]
  return lo !== null && hi !== null && lo !== hi
    ? `${when} · ${readingWords(v, unit)} (${lowWords(lo, unit)} to ${readingWords(hi, unit)})`
    : `${when} · ${readingWords(v, unit)}`
}
