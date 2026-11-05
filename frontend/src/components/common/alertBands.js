/**
 * The periods an alert was firing, as bands across a chart's window, and the uPlot plugin that
 * shades them on History's charts. The bands are pure arithmetic, unit-tested; the plugin draws
 * them on the plot area only, where the time scale is, so they line up with the text strips'
 * gutters (PLOT_LEFT_PX, PLOT_RIGHT_PX). frontend/README.md, "History's Alerts tab".
 */
import { clockWords } from '../../utils/timeWindow'
import { durationWords, momentWords, withAlpha } from '../../utils/history'
import { severityOf } from '../../utils/alertHistory'

/**
 * Each occurrence (occurrenceRow()) as a band over [start, end): clipped to the window, and a
 * still-firing one running to `now`, or to the window's end before that. One that leaves no
 * stretch inside the window is dropped. `{ id, name, severity, from, to, starts, ends, firing,
 * startsInside, endsInside }`, times in milliseconds, in order of start; `starts` and `ends` are
 * the occurrence's own (`ends` null while firing), and `startsInside` and `endsInside` say whether
 * its own edges fall inside the window.
 */
export function alertBands(rows, { start, end, now }) {
  const out = []
  for (const r of rows || []) {
    const starts = Date.parse(r.starts_at)
    const ends = r.ended_at ? Date.parse(r.ended_at) : null
    const stop = ends ?? Math.min(end, now)
    const from = Math.max(start, starts)
    const to = Math.min(end, stop)
    if (!Number.isFinite(from) || !(to > from)) continue
    out.push({
      id: r.id, name: r.alert_name, severity: r.severity, from, to, starts, ends, firing: ends === null,
      startsInside: starts >= start, endsInside: ends !== null && ends < end,
    })
  }
  return out.sort((a, b) => a.from - b.from || a.to - b.to)
}

/** The bands over moment `t`, in milliseconds. */
export const bandsAt = (bands, t) => bands.filter(b => t >= b.from && t < b.to)

/**
 * A band in words, as the readout names it: "Spindle Overload, warning · 2 Nov 10:05 – 10:40,
 * 35 min", or "since 2 Nov 10:05, firing" while it fires. The times are the occurrence's own, not
 * the window's.
 */
export function bandText(band) {
  const head = `${band.name}, ${severityOf(band.severity).label.toLowerCase()}`
  if (band.firing) return `${head} · since ${momentWords(band.starts, 1)}, firing`
  const sameDay = new Date(band.starts).toDateString() === new Date(band.ends).toDateString()
  const to = sameDay ? clockWords(new Date(band.ends)) : momentWords(band.ends, 1)
  return `${head} · ${momentWords(band.starts, 1)} – ${to}, ${durationWords(band.ends - band.starts)}`
}

/**
 * What the bands are painted with, from the theme's tokens on `<html>`: the danger signal, as the
 * alert counter's critical glyph is, translucent for the fill and solid for the edges, and the
 * danger text colour for the names. `read` is the token lookup, for a test.
 */
export function alertBandPalette(read = (name) => getComputedStyle(document.documentElement).getPropertyValue(name)) {
  const token = (name) => String(read(name) || '').trim()
  const edge = token('--danger')
  return { fill: withAlpha(edge, 0.12), edge, text: token('--danger-text'), font: `11px ${token('--font-mono') || 'monospace'}` }
}

/** The narrowest band, in CSS pixels, whose alert is named inside it. */
const NAMED_PX = 48

/** `text` cut with an ellipsis to fit `width` canvas pixels, or '' when not even one letter does. */
function fitted(ctx, text, width) {
  if (ctx.measureText(text).width <= width) return text
  for (let n = text.length - 1; n > 0; n--) {
    const cut = `${text.slice(0, n)}…`
    if (ctx.measureText(cut).width <= width) return cut
  }
  return ''
}

/**
 * The uPlot plugin that shades `bands` (alertBands()) on a chart. Under the series, each band is a
 * translucent fill across the plot area's height. Over them, a solid edge where an occurrence starts
 * and ends inside the window, and the alert's name inside the band's foot where it fits, so a band
 * never differs by colour alone. While the pointer is on this chart, a readout at the plot's foot
 * names each alert firing at that moment (bandText()). Each chart a plot of its own state, so one
 * plugin serves every chart of a device. Tokens are read as each plot starts, which a theme switch
 * makes happen again.
 */
export function alertBandsPlugin(bands, { palette = alertBandPalette } = {}) {
  const plots = new WeakMap()
  const xOf = (u, ms) => u.valToPos(ms / 1000, 'x', true)

  const init = (u) => {
    const readout = document.createElement('div')
    readout.className = 'chart-alert-readout'
    readout.setAttribute('aria-hidden', 'true')
    readout.hidden = true
    u.over.appendChild(readout)
    const own = { readout, inside: false, paint: palette() }
    const enter = () => { own.inside = true }
    const leave = () => { own.inside = false; readout.hidden = true }
    u.over.addEventListener('pointerenter', enter)
    u.over.addEventListener('pointerleave', leave)
    own.off = () => {
      u.over.removeEventListener('pointerenter', enter)
      u.over.removeEventListener('pointerleave', leave)
    }
    plots.set(u, own)
  }

  /** Each band's left and right edge on the canvas, kept to the plot area. */
  const spans = (u) => {
    const { left, width } = u.bbox
    return bands.map(b => ({
      b,
      x0: Math.max(left, Math.min(left + width, xOf(u, b.from))),
      x1: Math.max(left, Math.min(left + width, xOf(u, b.to))),
    })).filter(s => s.x1 > s.x0)
  }

  const fill = (u) => {
    const own = plots.get(u)
    if (!own) return
    const { ctx, bbox } = u
    ctx.save()
    ctx.fillStyle = own.paint.fill
    for (const { x0, x1 } of spans(u)) ctx.fillRect(x0, bbox.top, x1 - x0, bbox.height)
    ctx.restore()
  }

  const mark = (u) => {
    const own = plots.get(u)
    if (!own) return
    const { ctx, bbox } = u
    const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
    ctx.save()
    ctx.strokeStyle = own.paint.edge
    ctx.fillStyle = own.paint.text
    ctx.lineWidth = 2 * ratio
    ctx.font = own.paint.font.replace(/^(\d+)px/, (m, px) => `${Number(px) * ratio}px`)
    for (const { b, x0, x1 } of spans(u)) {
      for (const [inside, x] of [[b.startsInside, x0], [b.endsInside, x1]]) {
        if (!inside) continue
        ctx.beginPath()
        ctx.moveTo(x, bbox.top)
        ctx.lineTo(x, bbox.top + bbox.height)
        ctx.stroke()
      }
      if (x1 - x0 >= NAMED_PX * ratio) {
        const name = fitted(ctx, b.name, x1 - x0 - 8 * ratio)
        if (name) ctx.fillText(name, x0 + 4 * ratio, bbox.top + bbox.height - 4 * ratio)
      }
    }
    ctx.restore()
  }

  const hover = (u) => {
    const own = plots.get(u)
    if (!own) return
    const left = u.cursor.left
    const over = own.inside && left !== null && left !== undefined && left >= 0
      ? bandsAt(bands, u.posToVal(left, 'x') * 1000) : []
    if (over.length === 0) {
      own.readout.hidden = true
      return
    }
    const width = u.over.clientWidth || 1
    own.readout.replaceChildren(...over.map(b => {
      const line = document.createElement('div')
      line.textContent = bandText(b)
      return line
    }))
    own.readout.style.left = `${left}px`
    own.readout.dataset.edge = left / width > 0.7 ? 'end' : left / width < 0.3 ? 'start' : 'middle'
    own.readout.hidden = false
  }

  const destroy = (u) => {
    plots.get(u)?.off()
    plots.delete(u)
  }

  return { hooks: { init: [init], drawClear: [fill], draw: [mark], setCursor: [hover], destroy: [destroy] } }
}
