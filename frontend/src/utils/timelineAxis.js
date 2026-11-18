/**
 * The shared time axis's arithmetic: ticks at round local times, spaced so no two labels touch at
 * the width the axis has, and the words for the time under the pointer. Pure, so each rule is
 * unit-tested; frontend/README.md, "History and its chart".
 */

/**
 * The plot area's gutters, in pixels: the value axis on the left, and room on the right for the
 * last time label. A text strip takes the same, and so does the shared time axis, so one time is
 * at one place across every chart.
 */
export const PLOT_LEFT_PX = 56
export const PLOT_RIGHT_PX = 28

/**
 * What one glyph of the axis's 11px monospace takes, and the clear space two labels are never
 * closer than. A step is chosen for more room than that: COMFORT_GAP_PX beyond its widest label,
 * and MIN_TICK_SPACE_PX from tick to tick (a quarter of a narrow axis at most), so a long window is
 * not a ruler.
 */
export const TICK_CHAR_PX = 7
export const TICK_GAP_PX = 14
const COMFORT_GAP_PX = 24
const MIN_TICK_SPACE_PX = 90

/** The width assumed for an axis with none to measure yet (a first render, a test). */
export const DEFAULT_AXIS_PX = 720

/** The narrowest stretch of the axis's future part that holds "No readings yet". */
export const FUTURE_WORDS_PX = 110

/** The most ticks one axis draws, however wide: a safeguard for the generator, not a design. */
const MAX_TICKS = 200

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * The steps between ticks, finest first. Each is aligned on the local clock or calendar, so a
 * tick falls on a round time whatever the window's own ends are: seconds, minutes and hours from
 * local midnight, days at midnight, weeks on a Monday, months and years on the 1st.
 */
const STEPS = [
  ...[1, 2, 5, 10, 15, 30].map(n => ({ unit: 'second', n, ms: n * SECOND })),
  ...[1, 2, 5, 10, 15, 30].map(n => ({ unit: 'minute', n, ms: n * MINUTE })),
  ...[1, 2, 3, 6, 12].map(n => ({ unit: 'hour', n, ms: n * HOUR })),
  ...[1, 2].map(n => ({ unit: 'day', n, ms: n * DAY })),
  { unit: 'week', n: 1, ms: 7 * DAY },
  ...[1, 3, 6].map(n => ({ unit: 'month', n, ms: n * 30.4 * DAY })),
  { unit: 'year', n: 1, ms: 365 * DAY },
]

const midnight = (ms) => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** The times of `step` inside [start, end], both ends included, as milliseconds. */
function alignedAt(step, start, end) {
  const out = []
  const push = (d) => {
    const t = d.getTime()
    if (t >= start && t <= end && out[out.length - 1] !== t) out.push(t)
    return t <= end
  }
  const first = new Date(start)
  const [y, mo, d] = [first.getFullYear(), first.getMonth(), first.getDate()]
  if (['second', 'minute', 'hour'].includes(step.unit)) {
    // Wall-clock seconds from local midnight: Date carries an overflow into the next day, and a
    // clock change moves no tick off the round time.
    const stepSeconds = step.ms / SECOND
    const base = midnight(start).getTime()
    // An hour back covers a clock change between midnight and the window's start.
    let k = Math.floor((start - base - HOUR) / SECOND / stepSeconds)
    for (let guard = 0; guard < 100000 && out.length < MAX_TICKS; guard++, k++) {
      if (!push(new Date(y, mo, d, 0, 0, k * stepSeconds))) break
    }
  } else if (step.unit === 'day') {
    // Two days apart: on the days an even number of days after the epoch, the same on every page.
    for (let k = 0; out.length < MAX_TICKS; k++) {
      const day = new Date(y, mo, d + k)
      if (Math.round(day.getTime() / DAY) % step.n === 0 && !push(day)) break
      if (day.getTime() > end) break
    }
  } else if (step.unit === 'week') {
    const back = (new Date(y, mo, d).getDay() + 6) % 7
    for (let k = 0; out.length < MAX_TICKS; k++) if (!push(new Date(y, mo, d - back + 7 * k))) break
  } else if (step.unit === 'month') {
    const month = Math.floor(mo / step.n) * step.n
    for (let k = 0; out.length < MAX_TICKS; k++) if (!push(new Date(y, month + step.n * k, 1))) break
  } else {
    for (let k = 0; out.length < MAX_TICKS; k++) if (!push(new Date(y + k, 0, 1))) break
  }
  return out
}

const SECONDS = { hour: '2-digit', minute: '2-digit', second: '2-digit' }
const CLOCK = { hour: '2-digit', minute: '2-digit' }

/**
 * One tick's label for `step`, in a window `spanMs` long: the clock inside a day, with the day at
 * each midnight on a longer window, then the date, the month, the year. In the viewer's locale, as
 * the rest of the dashboard's dates are; only the steps that can fit are labelled (timelineTicks()).
 */
function labelOf(ms, step, spanMs) {
  const d = new Date(ms)
  const date = (options) => d.toLocaleDateString(undefined, options)
  if (step.unit === 'second') return d.toLocaleTimeString(undefined, SECONDS)
  if (step.unit === 'minute' || step.unit === 'hour') {
    const atMidnight = d.getHours() === 0 && d.getMinutes() === 0
    return atMidnight && spanMs > DAY * 1.05 ? date({ weekday: 'short', day: 'numeric' }) : d.toLocaleTimeString(undefined, CLOCK)
  }
  if (step.unit === 'day') return date(spanMs <= 14 * DAY ? { weekday: 'short', day: 'numeric' } : { day: 'numeric', month: 'short' })
  if (step.unit === 'week') return date({ day: 'numeric', month: 'short' })
  if (step.unit === 'month') return date({ month: 'short', year: 'numeric' })
  return date({ year: 'numeric' })
}

/** How wide a label is drawn, in pixels, by the glyph count. */
export const labelPx = (label) => String(label).length * TICK_CHAR_PX

/**
 * Where a tick's label sits on its tick: centred, held inside the axis where a centred label would
 * run past one of its ends, unless the axis draws every label centred (`centred`).
 */
function alignOf(f, px, widthPx, centred) {
  const half = px / 2
  return centred ? 'middle' : f * widthPx < half ? 'start' : (1 - f) * widthPx < half ? 'end' : 'middle'
}

/** The label's left and right edge in pixels along the axis, for its alignment. */
const boxOf = (t, widthPx) => {
  const at = t.f * widthPx
  const px = labelPx(t.label)
  return t.align === 'start' ? [at, at + px] : t.align === 'end' ? [at - px, at] : [at - px / 2, at + px / 2]
}

/** Whether no two labels of `ticks`, as drawn, are closer than TICK_GAP_PX. */
function clearOf(ticks, widthPx) {
  let edge = -Infinity
  for (const t of ticks) {
    const [left, right] = boxOf(t, widthPx)
    if (left < edge + TICK_GAP_PX) return false
    edge = right
  }
  return true
}

/**
 * The axis's ticks for [startMs, endMs) at `widthPx`: the finest step whose ticks are each as far
 * apart as their widest label and a comfortable gap need, with no two labels closer than
 * TICK_GAP_PX as they are drawn, at any span and any width. Each is `{ at, f, label, align }`: its
 * time in milliseconds, its fraction of the window, its words and where the label sits on it
 * (`start`, `middle` or `end`: held inside the axis near its ends). Where no step has the room,
 * the coarsest is thinned from the left until nothing touches.
 *
 * An axis that can only draw every label centred on its tick, a chart's own (`centred`), gets
 * `align: 'middle'` throughout, and a tick whose label would run more than `roomPx`, `[left, right]`,
 * past either end of the axis is left out: the gutters beside the plot are what is there to run into.
 */
export function timelineTicks(startMs, endMs, widthPx = DEFAULT_AXIS_PX, { centred = false, roomPx = [0, 0] } = {}) {
  const span = endMs - startMs
  if (!(span > 0)) return []
  const width = widthPx > 0 ? widthPx : DEFAULT_AXIS_PX
  const least = Math.min(MIN_TICK_SPACE_PX, width / 4)
  let ticks = []
  for (const step of STEPS) {
    // A step nearer than the least spacing at this width cannot be chosen: its ticks are not made.
    if ((step.ms / span) * width < least && step !== STEPS[STEPS.length - 1]) continue
    const at = alignedAt(step, startMs, endMs)
    if (at.length === 0) continue
    const labels = at.map(t => labelOf(t, step, span))
    ticks = at.map((t, i) => {
      const f = (t - startMs) / span
      return { at: t, f, label: labels[i], align: alignOf(f, labelPx(labels[i]), width, centred) }
    })
    if (centred) {
      ticks = ticks.filter((t) => {
        const [left, right] = boxOf(t, width)
        return left >= -roomPx[0] && right <= width + roomPx[1]
      })
      if (ticks.length === 0) continue
    }
    const room = Math.max(Math.max(...labels.map(labelPx)) + COMFORT_GAP_PX, least)
    if ((step.ms / span) * width >= room && clearOf(ticks, width)) return ticks
  }
  const kept = []
  let edge = -Infinity
  for (const t of ticks) {
    const [left, right] = boxOf(t, width)
    if (left < edge + TICK_GAP_PX) continue
    kept.push(t)
    edge = right
  }
  return kept
}

/** The pointer's time for the axis's readout: to the second under an hour, the clock inside a day, else the date and clock. */
export function pointerWords(ms, spanMs) {
  const d = new Date(ms)
  if (spanMs < HOUR) return d.toLocaleTimeString(undefined, SECONDS)
  if (spanMs <= DAY * 1.05) return d.toLocaleTimeString(undefined, CLOCK)
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString(undefined, CLOCK)}`
}
