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
import { clockWords } from '../../utils/timeWindow'
import {
  chartPalette, chartTitle, latestWords, momentWords, nowFraction, readingWords, runWords, shareWords, splitCarried,
  stateKey, stateRuns, stateShares, validRangeWords,
} from '../../utils/history'

const DAY_S = 24 * 60 * 60

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

/** uPlot's options for one chart. Its own drag selection is off: the page's window is the only zoom. */
function plotOptions({ width, height, series, start, end, validRange, palette, syncKey, onHover }) {
  const flag = series.kind === 'flag'
  const axis = { stroke: palette.text, font: palette.font, grid: { stroke: palette.grid, width: 1 }, ticks: { stroke: palette.grid, width: 1 } }
  const line = { stroke: palette.line, width: 1.5, spanGaps: false, ...(flag ? { paths: uPlot.paths.stepped({ align: 1 }) } : {}) }
  return {
    width,
    height,
    legend: { show: false },
    cursor: { drag: { x: false, y: false, setScale: false }, ...(syncKey ? { sync: { key: syncKey } } : {}) },
    select: { show: false },
    scales: {
      x: { time: true, range: [start / 1000, end / 1000] },
      y: flag ? { range: [-0.2, 1.2] } : {},
    },
    axes: [
      { ...axis, values: timeLabels((end - start) / 1000) },
      {
        ...axis,
        size: 56,
        ...(flag ? { splits: () => [0, 1] } : {}),
        values: (u, splits) => splits.map(v => (flag ? (v === 1 ? 'true' : v === 0 ? 'false' : '') : readingWords(v))),
      },
    ],
    series: [
      {},
      { label: 'Highest', stroke: palette.band, width: 0, points: { show: false } },
      { label: 'Lowest', stroke: palette.band, width: 0, points: { show: false } },
      { label: 'Average', ...line },
      { label: 'Carried forward', ...line, dash: [5, 4], points: { show: false } },
    ],
    bands: flag ? [] : [{ series: [1, 2], fill: palette.band }],
    hooks: {
      draw: [drawValidRange(validRange, palette)],
      setCursor: [(u) => onHover(u.cursor.idx ?? null)],
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

/** The tone class of a state's runs: its place in the key, or the neutral tone of the others. */
const toneOf = (tones, state) => `chart-tone-${tones.get(state) ?? 'other'}`

/**
 * A state metric as runs of its value across the window: text, which no line can draw. Each value
 * has a colour from the theme's categorical tokens and keeps its name, and a carried stretch is
 * hatched, as a number chart dashes one.
 */
function StateStrip({ runs, tones, start, end }) {
  const span = end - start
  const part = (from, to, of) => ({ left: `${((from - of.from) / of.span) * 100}%`, width: `${((to - from) / of.span) * 100}%` })
  const whole = { from: start, span }
  return (
    <div className="chart-states">
      {runs.map(r => {
        const own = { from: r.startMs, span: r.endMs - r.startMs }
        return (
          <span key={r.from} className={`chart-state ${toneOf(tones, r.state)}`} style={part(r.startMs, r.endMs, whole)}>
            {r.carried.map(c => (
              <span key={c.startMs} className="chart-state-carried" style={part(c.startMs, c.endMs, own)} />
            ))}
            <OverflowText>{r.state}</OverflowText>
          </span>
        )
      })}
    </div>
  )
}

/** Under a state chart: each value with its colour and its share of the charted time, then the others. */
function StateKey({ stateKey: key, carried }) {
  return (
    <ul className="chart-state-key">
      {key.shown.map(s => (
        <li key={s.state} className={toneOf(key.tones, s.state)}>
          <span className="chart-state-swatch" aria-hidden="true" />
          <OverflowText className="chart-state-key-name">{s.state}</OverflowText>
          <span className="chart-state-share">{shareWords(s.share)}</span>
        </li>
      ))}
      {key.others && (
        <li className="chart-tone-other">
          <span className="chart-state-swatch" aria-hidden="true" />
          <span className="chart-state-key-name">{`${key.others.count} other${key.others.count === 1 ? '' : 's'}`}</span>
          <span className="chart-state-share">{shareWords(key.others.share)}</span>
        </li>
      )}
      {carried && (
        <li className="chart-tone-other">
          <span className="chart-state-swatch chart-state-swatch-carried" aria-hidden="true" />
          <span className="chart-state-key-name">carried forward</span>
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
 * of the time under it. The head reads the bucket under the pointer, or the run under it on a
 * state strip, and otherwise the latest reading (latestWords()).
 *
 * Colours and the axis font are the theme's tokens, read again on a theme switch. The figure is
 * named by its title, and `summary` (chartSummary(), utils/history.js) is its text for a screen
 * reader. uPlot's drag selection is off: the page's time control is the only zoom.
 *
 *   <TimeSeriesChart metric="Spindle/LOAD" unit="kW" starts={starts} series={chartSeries(rows, starts)}
 *     start={startMs} end={endMs} now={Date.now()} minutes={5} summary={text} syncKey="device" />
 */
export function TimeSeriesChart({
  metric, unit, starts, series, start, end, now, minutes, validRange = null, summary, syncKey, height = 140,
}) {
  const id = useId()
  const boxRef = useRef(null)
  const [over, setOver] = useState(null)
  const [failed, setFailed] = useState(false)
  const [hover, setHover] = useState(null)
  const [runHover, setRunHover] = useState(null)
  const palette = useChartPalette()
  const drawn = series.kind === 'number' || series.kind === 'flag'
  const isState = series.kind === 'state'
  const runs = useMemo(
    () => (isState ? stateRuns(series, starts, { start, end, now, minutes }) : []),
    [isState, series, starts, start, end, now, minutes]
  )
  const key = useMemo(() => (isState ? stateKey(stateShares(runs)) : null), [isState, runs])

  useEffect(() => {
    const box = boxRef.current
    if (!drawn || !box) return undefined
    const { read, held } = splitCarried(series)
    let plot
    try {
      plot = new uPlot(
        plotOptions({ width: box.clientWidth || 600, height, series, start, end, validRange, palette, syncKey, onHover: setHover }),
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
  }, [drawn, starts, series, start, end, height, validRange, palette, syncKey])

  const fraction = nowFraction(start, end, now)
  const range = validRangeWords(validRange, unit)
  const hovered = isState
    ? (runHover ? runWords(runHover, minutes) : null)
    : hover !== null && starts[hover] !== undefined ? hoverWords(starts[hover], series, hover, unit, minutes) : null
  const headWords = hovered ?? latestWords(series, starts, minutes, unit)

  /** The run under the pointer, from where it is across the strip, which is the window's width. */
  const pointAt = (e) => {
    const box = e.currentTarget.getBoundingClientRect()
    if (!(box.width > 0)) return
    const t = start + ((e.clientX - box.left) / box.width) * (end - start)
    setRunHover(runs.find(r => t >= r.startMs && t < r.endMs) ?? null)
  }

  return (
    <figure className="history-chart" aria-labelledby={`${id}-title`}>
      <figcaption className="history-chart-head">
        <span className="history-chart-title" id={`${id}-title`}>{chartTitle(metric, unit)}</span>
        {range && <span className="history-chart-range">{range}</span>}
        <span className="history-chart-hover" aria-hidden="true">{headWords}</span>
      </figcaption>
      <div className="chart-frame" role="img" aria-labelledby={`${id}-title`} aria-describedby={`${id}-summary`}>
        {drawn && <div ref={boxRef} className="chart-box" style={{ height }} hidden={failed} />}
        {isState && (
          <div className="chart-box chart-box-states" onPointerMove={pointAt} onPointerLeave={() => setRunHover(null)}>
            <StateStrip runs={runs} tones={key.tones} start={start} end={end} />
            {fraction !== null && <div className="chart-overlay"><NowMarker fraction={fraction} now={now} /></div>}
          </div>
        )}
        {(series.kind === 'none' || failed) && (
          <div className="chart-box chart-box-empty">
            {failed ? 'This chart could not be drawn in this browser.' : 'No readings in this window, and none before it.'}
          </div>
        )}
        {drawn && !failed && over && fraction !== null && createPortal(<NowMarker fraction={fraction} now={now} />, over)}
      </div>
      {isState && key.shown.length > 0 && <StateKey stateKey={key} carried={runs.some(r => r.carried.length > 0)} />}
      <p className="sr-only" id={`${id}-summary`}>{summary}</p>
    </figure>
  )
}

/** The bucket under the pointer, in words: its time, its average and range, or that it carried. */
function hoverWords(x, series, i, unit, minutes) {
  const when = momentWords(x * 1000, minutes)
  const v = series.avg[i]
  if (v === null) return `${when} · no reading yet`
  if (series.kind === 'flag') return `${when} · ${v ? 'true' : 'false'}${series.carried[i] ? ', carried forward' : ''}`
  if (series.carried[i]) return `${when} · ${readingWords(v, unit)}, carried forward`
  const lo = series.min[i]
  const hi = series.max[i]
  return lo !== null && hi !== null && lo !== hi
    ? `${when} · ${readingWords(v, unit)} (${readingWords(lo)} to ${readingWords(hi, unit)})`
    : `${when} · ${readingWords(v, unit)}`
}
