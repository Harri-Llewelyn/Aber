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
import React, { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { OverflowText } from './OverflowText'
import { clockWords } from '../../utils/timeWindow'
import { chartPalette, chartTitle, nowFraction, readingWords, splitCarried, validRangeWords } from '../../utils/history'

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

/** A state metric as runs of its value across the window: text, which no line can draw. */
function StateStrip({ starts, series, start, end, minutes, now }) {
  const runs = []
  series.states.forEach((state, i) => {
    if (state === null) return
    const last = runs[runs.length - 1]
    if (last && last.state === state && last.to === i) last.to = i + 1
    else runs.push({ state, from: i, to: i + 1 })
  })
  const span = end - start
  const at = (i) => Math.max(0, Math.min(1, ((starts[i] ?? (starts[starts.length - 1] + minutes * 60)) * 1000 - start) / span))
  const stop = (i) => (i < starts.length ? at(i) : Math.min(1, (Math.min(now, end) - start) / span))
  return (
    <div className="chart-states">
      {runs.map(r => (
        <span
          key={r.from}
          className="chart-state"
          style={{ left: `${at(r.from) * 100}%`, width: `${Math.max(0, stop(r.to) - at(r.from)) * 100}%` }}
        >
          <OverflowText>{r.state}</OverflowText>
        </span>
      ))}
    </div>
  )
}

/**
 * One time-series chart, on uPlot, sized to its container and redrawn when that changes, so a
 * window always fits the width and nothing scrolls sideways. The line is each bucket's average, the
 * band its minimum to maximum. A bucket with no reading carries the last value forward and is drawn
 * dashed, so a carried stretch never reads as a measured one. The schema's valid range is a dotted
 * line labelled "valid range". Where the window reaches past now, a Now line and a hatched "No
 * readings yet" mark the rest. A flag steps between false and true; a state is a strip of its runs.
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
  const palette = useChartPalette()
  const drawn = series.kind === 'number' || series.kind === 'flag'

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
  const hovered = hover !== null && starts[hover] !== undefined ? hoverWords(starts[hover], series, hover, unit) : null

  return (
    <figure className="history-chart" aria-labelledby={`${id}-title`}>
      <figcaption className="history-chart-head">
        <span className="history-chart-title" id={`${id}-title`}>{chartTitle(metric, unit)}</span>
        {range && <span className="history-chart-range">{range}</span>}
        <span className="history-chart-hover" aria-hidden="true">{hovered}</span>
      </figcaption>
      <div className="chart-frame" role="img" aria-labelledby={`${id}-title`} aria-describedby={`${id}-summary`}>
        {drawn && <div ref={boxRef} className="chart-box" style={{ height }} hidden={failed} />}
        {series.kind === 'state' && (
          <div className="chart-box chart-box-states">
            <StateStrip starts={starts} series={series} start={start} end={end} minutes={minutes} now={now} />
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
      <p className="sr-only" id={`${id}-summary`}>{summary}</p>
    </figure>
  )
}

/** The bucket under the pointer, in words: its time, its average and range, or that it carried. */
function hoverWords(x, series, i, unit) {
  const d = new Date(x * 1000)
  const when = `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${clockWords(d)}`
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
