/**
 * History's Device tab under one time axis (ChartTimeline): the labels, the Now badge and "No
 * readings yet" once, between the row above the charts and the first group; the charts keep their
 * gridlines at its ticks, a thin Now line and the hatch; one pointer across every chart and strip,
 * the time under it on the axis; a drag on the axis zooms; and it is pinned as the Audit Trail's is.
 * In London's zone on Monday 2 November 2026 at 15:20. uPlot draws on a canvas jsdom does not have,
 * so a stand-in keeps a cursor, maps a position to a time over a plot 1000 px wide, and records
 * what each chart was built with.
 */
import React from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { render, screen, waitFor, fireEvent, within, act, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { HistoryTab } from '../components/tabs/HistoryTab'
import { PLOT_LEFT_PX, PLOT_RIGHT_PX } from '../components/common/TimeSeriesChart'
import { api } from '../api'

const MACHINE_TZ = process.env.TZ
process.env.TZ = 'Europe/London'
afterAll(() => {
  if (MACHINE_TZ === undefined) delete process.env.TZ
  else process.env.TZ = MACHINE_TZ
})

const { plots } = vi.hoisted(() => ({ plots: [] }))

vi.mock('uplot', () => {
  const PLOT_PX = 1000
  class FakePlot {
    constructor(opts, data, target) {
      this.opts = opts
      this.data = data
      this.cursor = { left: -10, idx: null }
      this.redraws = []
      this.cursorSets = []
      this.over = document.createElement('div')
      this.over.className = 'u-over'
      target.appendChild(this.over)
      plots.push(this)
    }
    get span() { return this.opts.scales.x.range }
    posToVal(left) { const [a, b] = this.span; return a + (left / PLOT_PX) * (b - a) }
    valToPos(value) { const [a, b] = this.span; return ((value - a) / (b - a)) * PLOT_PX }
    // The pointer put on the plot, and the bucket nearest it, as uPlot does.
    place(left) {
      this.cursor.left = left
      const at = this.posToVal(left)
      this.cursor.idx = left < 0 ? null : this.data[0].reduce((best, x, i) => (Math.abs(x - at) < Math.abs(this.data[0][best] - at) ? i : best), 0)
    }
    // The pointer over this plot, as uPlot's mousemove or a synced plot has it.
    hover(left) {
      this.place(left)
      this.opts.hooks.setCursor[0](this)
    }
    setCursor(where, fire = true, publish = true) {
      this.cursorSets.push({ ...where, fire, publish })
      this.place(where.left)
      if (fire !== false) this.opts.hooks.setCursor[0](this)
    }
    redraw(...args) { this.redraws.push(args) }
    setSize(size) { this.size = size }
    destroy() { this.destroyed = true; this.over.remove() }
  }
  FakePlot.paths = { stepped: () => () => null }
  return { default: FakePlot }
})

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), readCarriedTelemetry: vi.fn(), readTelemetryChanges: vi.fn() } }
})

const MIXED = '2b3e0c4a-9999-4000-8000-000000000009'
const devices = [{ asset_id: MIXED, asset_name: 'Lathe 9', last_birth_metrics: ['Spindle/LOAD', 'Spindle/SPEED', 'Controller/EXECUTION'] }]
const catalog = [
  { name: 'Spindle/LOAD', units: 'kW', datatype: 10 }, { name: 'Spindle/SPEED', units: 'rpm', datatype: 10 },
  { name: 'Controller/EXECUTION', datatype: 12 },
]

/** Three readings of a number a bucket apart from the window's start, and RUNNING all through for the state. */
const readings = ({ from, bucketMinutes, metricNames }) => {
  const width = bucketMinutes * 60000
  const first = Math.floor(Date.parse(from) / width) * width
  return Promise.resolve(metricNames.flatMap(name => Array.from({ length: name === 'Controller/EXECUTION' ? 960 : 3 }, (_, i) => ({
    bucket_ts: new Date(first + i * width).toISOString(), asset_id: 'dev', metric_name: name,
    avg_double: name === 'Controller/EXECUTION' ? null : (name === 'Spindle/LOAD' ? 40 : 1200) + i, min_double: null, max_double: null,
    last_double: name === 'Controller/EXECUTION' ? null : 40 + i, last_string: name === 'Controller/EXECUTION' ? 'RUNNING' : null,
    last_bool: null, n_rows: 1, is_carried: false,
  }))))
}

/*
 * Every plot area, strip and the axis's track is 1000px wide from x = 100, so a fraction f of the
 * day is at x = 100 + 1000f.
 */
const LEFT = 100
const xAt = (h, mi = 0) => LEFT + 1000 * (h * 60 + mi) / 1440
const TRACKS = ['u-over', 'chart-box-states', 'chart-axis-track']
let originalRect
let axisPx = 0
let originalWidth

beforeEach(() => {
  vi.clearAllMocks()
  plots.length = 0
  axisPx = 0
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 2, 15, 20))
  api.get.mockImplementation((p) => Promise.resolve(p.startsWith('/api/v1/devices') ? devices : p.startsWith('/api/v1/metric-catalog') ? catalog : []))
  api.readCarriedTelemetry.mockImplementation(readings)
  api.readTelemetryChanges.mockResolvedValue([])
  originalRect = Element.prototype.getBoundingClientRect
  Element.prototype.getBoundingClientRect = function rect() {
    return TRACKS.some(c => this.classList?.contains(c))
      ? { left: LEFT, right: LEFT + 1000, width: 1000, top: 0, bottom: 140, height: 140, x: LEFT, y: 0 }
      : originalRect.call(this)
  }
  originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() { return this.classList?.contains('chart-axis-track') ? axisPx : 0 },
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  Element.prototype.getBoundingClientRect = originalRect
  if (originalWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalWidth)
  else delete HTMLElement.prototype.clientWidth
  delete window.ResizeObserver
  window.history.replaceState(null, '', '/')
})

const show = async (search = '?span=day&at=2026-11-02') => {
  window.history.replaceState(null, '', `/history/device/${MIXED}${search}`)
  render(<HistoryTab hasPermission={() => true} showToast={vi.fn()} userRole="Administrator" />)
  await waitFor(() => expect(screen.getAllByRole('figure').length).toBeGreaterThan(0))
  // The axis measures itself as it mounts, and its ticks follow in the next render.
  await act(async () => {})
}
const axis = () => document.querySelector('.chart-axis')
const track = () => document.querySelector('.chart-axis-track')
const ticks = () => [...document.querySelectorAll('.chart-tick')]
const live = () => plots.filter(p => !p.destroyed)
const numberHead = (name) => within(screen.getByRole('figure', { name })).getByText((_, el) => el.classList.contains('history-chart-hover'))
const css = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8')
/** The declarations of the rule for exactly this selector, at the start of a line. */
const rule = (selector) => {
  const at = css.indexOf(`\n${selector} {`)
  return at < 0 ? '' : css.slice(at, css.indexOf('}', at))
}

describe('one axis over the charts', () => {
  it('sits between the row above the charts and the first group, in the scroller, and takes the charts gutters', async () => {
    await show()
    const timeline = axis().parentElement
    expect(timeline).toHaveClass('chart-timeline', 'history-groups')
    expect(timeline.parentElement).toHaveClass('trail-scroll')
    expect(timeline.firstElementChild).toBe(axis())
    expect(axis().nextElementSibling).toHaveClass('history-group')
    expect(document.querySelectorAll('.chart-axis')).toHaveLength(1)
    // The row above the charts stays outside the scroller, over the axis.
    expect(document.querySelector('.groups-header').compareDocumentPosition(axis()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The charts' own two gutters, from the one place that holds them.
    expect(timeline.style.getPropertyValue('--plot-left')).toBe(`${PLOT_LEFT_PX}px`)
    expect(timeline.style.getPropertyValue('--plot-right')).toBe(`${PLOT_RIGHT_PX}px`)
    expect(rule('.chart-axis-track')).toMatch(/margin: 0 calc\(var\(--inset\) \+ var\(--plot-right\)\) 0 calc\(var\(--inset\) \+ var\(--plot-left\)\);/)
    // The strip and the plot area it lines up with take the same two.
    const strip = document.querySelector('.chart-box-states')
    expect(strip.style.marginLeft).toBe(`${PLOT_LEFT_PX}px`)
    expect(strip.style.marginRight).toBe(`${PLOT_RIGHT_PX}px`)
  })

  it('is hidden from assistive technology: each chart says its window in its own summary', async () => {
    await show()
    expect(axis()).toHaveAttribute('aria-hidden', 'true')
  })

  it('says Now once and "No readings yet" once, on the axis, and no chart says either', async () => {
    await show()
    expect(screen.getAllByText(/^Now \d\d:\d\d$/)).toHaveLength(1)
    expect(within(axis()).getByText('Now 15:20')).toBeInTheDocument()
    expect(screen.getAllByText('No readings yet')).toHaveLength(1)
    expect(within(axis().querySelector('.chart-axis-future-row')).getByText('No readings yet')).toBeInTheDocument()
    for (const figure of screen.getAllByRole('figure')) {
      expect(within(figure).queryByText(/^Now /)).toBeNull()
      expect(within(figure).queryByText('No readings yet')).toBeNull()
    }
  })

  it('draws the hatch and a thin line at now in every chart and strip, at the axis', async () => {
    await show()
    const at = within(axis()).getByText('Now 15:20').style.left
    // Two number charts and a strip.
    const futures = [...document.querySelectorAll('.history-chart .chart-future')]
    expect(futures).toHaveLength(3)
    for (const future of futures) {
      expect(future.style.left).toBe(at)
      expect(future).toBeEmptyDOMElement()
    }
    expect(document.querySelector('.chart-axis-future-row .trail-shade-future').style.left).toBe(at)
  })

  it('says no words in a future part too narrow for them, and keeps the Now badge', async () => {
    axisPx = 260
    await show()
    expect(screen.queryByText('No readings yet')).toBeNull()
    expect(within(axis()).getByText('Now 15:20')).toBeInTheDocument()
  })

  it('draws no Now badge, no hatch and no future row on a window that ends at now', async () => {
    await show('?range=24h')
    expect(screen.queryByText(/^Now /)).toBeNull()
    expect(document.querySelector('.chart-axis-future-row')).toBeNull()
    expect(document.querySelector('.chart-timeline')).not.toHaveClass('chart-timeline-future')
  })

  it('is pinned under the toolbar as the Audit Trail axis is, and the group headings pin under it', async () => {
    await show()
    // jsdom applies no stylesheet: the rules the layout rests on are read from App.css.
    const mine = rule('.chart-axis')
    const trail = rule('.trail-lane.trail-axis')
    for (const text of [mine, trail]) {
      expect(text).toMatch(/position: sticky;/)
      expect(text).toMatch(/top: 0;/)
      expect(text).toMatch(/background: var\(--bg-base\);/)
    }
    // Above the headings it holds, which are z-index 3.
    expect(Number(mine.match(/z-index: (\d+);/)[1])).toBeGreaterThan(3)
    expect(rule('.history-group-head')).toMatch(/top: var\(--chart-axis-height, 0px\);/)
    expect(rule('.chart-timeline-future')).toMatch(/--chart-axis-height: 44px;/)
    expect(rule('.chart-timeline')).toMatch(/--chart-axis-height: 24px;/)
    expect(document.querySelector('.chart-timeline')).toHaveClass('chart-timeline-future')
  })
})

describe('the ticks', () => {
  const labels = () => ticks().map(t => t.textContent)

  it('are round times, each label held inside the axis at its ends', async () => {
    axisPx = 1000
    await show()
    expect(labels()).toEqual(['00:00', '03:00', '06:00', '09:00', '12:00', '15:00', '18:00', '21:00', '00:00'])
    expect(ticks()[0]).toHaveClass('chart-tick-start')
    expect(ticks()[4]).toHaveClass('chart-tick-middle')
    expect(ticks().at(-1)).toHaveClass('chart-tick-end')
    expect(ticks()[4].style.left).toBe('50%')
  })

  it('keep their labels apart as the window grows to a week, a month and a year, at a phone width and a wide one', async () => {
    const seen = {}
    for (const [span, search] of [['day', '?span=day&at=2026-11-02'], ['week', '?span=week&at=2026-11-02'], ['month', '?span=month&at=2026-11-02'], ['year', '?span=year&at=2026-11-02']]) {
      for (const px of [244, 1000, 1800]) {
        axisPx = px
        await show(search)
        const shown = ticks().map(t => ({ f: parseFloat(t.style.left) / 100, label: t.textContent, align: t.className.match(/chart-tick-(\w+)/)[1] }))
        seen[`${span}@${px}`] = shown.length
        // Each label, at 7px a glyph, stands clear of the last by at least the 14px gap.
        const box = ({ f, label, align }) => {
          const w = label.length * 7
          const x = f * px
          return align === 'start' ? [x, x + w] : align === 'end' ? [x - w, x] : [x - w / 2, x + w / 2]
        }
        shown.forEach((t, i) => {
          const [left, right] = box(t)
          expect(left, `${t.label} in ${span} at ${px}`).toBeGreaterThanOrEqual(-0.5)
          expect(right, `${t.label} in ${span} at ${px}`).toBeLessThanOrEqual(px + 0.5)
          if (i > 0) expect(left - box(shown[i - 1])[1], `${shown[i - 1].label} then ${t.label} in ${span} at ${px}`).toBeGreaterThanOrEqual(13.5)
        })
        cleanup()
        plots.length = 0
      }
    }
    // Wider takes more ticks, never fewer.
    for (const span of ['day', 'week', 'month', 'year']) {
      expect(seen[`${span}@1800`]).toBeGreaterThanOrEqual(seen[`${span}@1000`])
      expect(seen[`${span}@1000`]).toBeGreaterThanOrEqual(seen[`${span}@244`])
      expect(seen[`${span}@244`]).toBeGreaterThan(0)
    }
  })

  it('are chosen again when the axis is measured at another width', async () => {
    const watchers = []
    window.ResizeObserver = class { constructor(cb) { watchers.push(cb) } observe() {} disconnect() {} }
    axisPx = 1000
    await show()
    const wide = labels().length
    axisPx = 244
    act(() => { watchers.forEach(cb => cb([])) })
    expect(labels().length).toBeLessThan(wide)
    expect(labels()).toEqual(['00:00', '12:00', '00:00'])
  })

  it("are the charts' gridlines too, and a chart draws no time labels of its own", async () => {
    axisPx = 1000
    await show()
    await waitFor(() => expect(live()).toHaveLength(2))
    const seconds = ticks().length
    for (const { opts } of live()) {
      const [time] = opts.axes
      // No label, no tick mark, no room: only the gridline at each tick of the axis.
      expect(time.size).toBe(0)
      expect(time.ticks).toEqual({ show: false })
      expect(time.values({}, [1, 2, 3])).toEqual(['', '', ''])
      const splits = time.splits()
      expect(splits).toHaveLength(seconds)
      expect(splits[0]).toBe(new Date(2026, 10, 2).getTime() / 1000)
      expect(splits.at(-1)).toBe(new Date(2026, 10, 3).getTime() / 1000)
      expect(time.grid.width).toBe(1)
    }
  })

  it('give a chart the room its own axis took, and move its gridlines without building it again', async () => {
    const watchers = []
    window.ResizeObserver = class { constructor(cb) { watchers.push(cb) } observe() {} disconnect() {} }
    axisPx = 1000
    await show()
    await waitFor(() => expect(live()).toHaveLength(2))
    expect(live()[0].opts.height).toBe(140 - 25)
    expect(live()[0].opts.padding).toEqual([10, PLOT_RIGHT_PX, 10, null])
    const built = plots.length
    axisPx = 244
    act(() => { watchers.forEach(cb => cb([])) })
    await waitFor(() => expect(live()[0].redraws).toEqual([[false, true]]))
    expect(plots).toHaveLength(built)
  })
})

describe('one pointer across every chart and strip', () => {
  const pill = () => document.querySelector('.chart-axis-pointer')

  it("draws a vertical line alone in a number chart, and the time under a pointer on one chart on the axis", async () => {
    await show()
    await waitFor(() => expect(live()).toHaveLength(2))
    expect(live()[0].opts.cursor.y).toBe(false)
    expect(pill()).toBeNull()
    act(() => { live()[0].hover(500) })
    // Half a day in.
    expect(pill()).toHaveTextContent('12:00')
    expect(pill()).toHaveClass('trail-band-words')
    expect(parseFloat(pill().style.left)).toBeCloseTo(50, 5)
    // The pointer leaves.
    act(() => { live()[0].hover(-10) })
    expect(pill()).toBeNull()
  })

  it('draws it through a strip too, with the strip head reading its own run at that time', async () => {
    await show()
    await waitFor(() => expect(live()).toHaveLength(2))
    const strip = document.querySelector('.chart-box-states')
    expect(strip.querySelector('.chart-cursor')).toBeNull()
    act(() => { live()[0].hover(250) })
    const line = strip.querySelector('.chart-cursor')
    expect(parseFloat(line.style.left)).toBeCloseTo(25, 5)
    expect(line).toHaveAttribute('aria-hidden', 'true')
    expect(within(screen.getByRole('figure', { name: 'Controller/EXECUTION' })).getByText(/ · RUNNING, /)).toBeInTheDocument()
    act(() => { live()[0].hover(-10) })
    expect(strip.querySelector('.chart-cursor')).toBeNull()
    expect(within(screen.getByRole('figure', { name: 'Controller/EXECUTION' })).queryByText(/ · RUNNING, /)).toBeNull()
  })

  it("puts a strip's pointer on every number chart, each head reading its own value", async () => {
    await show()
    await waitFor(() => expect(live()).toHaveLength(2))
    const strip = document.querySelector('.chart-box-states')
    fireEvent.pointerMove(strip, { clientX: xAt(0, 1) })
    // 00:01 across both plot areas, set without a publish of its own, so the charts do not echo it.
    for (const plot of live()) {
      expect(plot.cursorSets.at(-1)).toMatchObject({ top: 0, fire: true, publish: false })
      expect(plot.cursorSets.at(-1).left).toBeCloseTo(1000 / 1440, 5)
    }
    expect(pill()).toHaveTextContent('00:01')
    // Each reads its own value in the bucket there.
    expect(numberHead('Spindle/LOAD (kW)')).toHaveTextContent('2 Nov 00:01 · 41 kW')
    expect(numberHead('Spindle/SPEED (rpm)')).toHaveTextContent('2 Nov 00:01 · 1,201 rpm')
    expect(parseFloat(strip.querySelector('.chart-cursor').style.left)).toBeCloseTo(100 / 1440, 3)
    // It leaves: the charts' cursors are put away and the heads read the latest again.
    fireEvent.pointerLeave(strip)
    for (const plot of live()) expect(plot.cursorSets.at(-1)).toMatchObject({ left: -10, publish: false })
    expect(pill()).toBeNull()
    expect(strip.querySelector('.chart-cursor')).toBeNull()
    expect(numberHead('Spindle/LOAD (kW)')).toHaveTextContent(/^Latest /)
  })

  it('shows the time under the pointer on the axis, and puts the same cursor on every chart and strip', async () => {
    await show()
    await waitFor(() => expect(live()).toHaveLength(2))
    fireEvent.pointerMove(track(), { clientX: xAt(9, 30) })
    expect(pill()).toHaveTextContent('09:30')
    for (const plot of live()) expect(plot.cursorSets.at(-1).left).toBeCloseTo(395.83, 1)
    expect(parseFloat(document.querySelector('.chart-box-states .chart-cursor').style.left)).toBeCloseTo(39.58, 1)
    fireEvent.pointerLeave(track())
    expect(pill()).toBeNull()
    expect(document.querySelector('.chart-box-states .chart-cursor')).toBeNull()
  })

  it('shows no pointer on the axis while a band is drawn: the band says its words there', async () => {
    await show()
    fireEvent.pointerDown(track(), { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: xAt(10) })
    fireEvent.pointerMove(track(), { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: xAt(11) })
    expect(pill()).toBeNull()
    expect(axis().querySelector('.trail-band-words')).toBeInTheDocument()
  })
})

describe('a drag on the axis', () => {
  const mouse = (clientX, extra = {}) => ({ pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX, ...extra })

  it('shades the band on the axis and on every chart, says it once, and on release zooms as a new history entry', async () => {
    await show()
    await waitFor(() => expect(live()).toHaveLength(2))
    const push = vi.spyOn(window.history, 'pushState')
    fireEvent.pointerDown(track(), mouse(xAt(10, 5)))
    fireEvent.pointerMove(track(), mouse(xAt(10, 40)))
    expect(axis().querySelector('.trail-band')).toBeInTheDocument()
    expect([...document.querySelectorAll('.chart-band')]).toHaveLength(3)
    expect([...document.querySelectorAll('.trail-band-words, .chart-band-words')].map(w => w.textContent)).toEqual(['10:05 – 10:40, 35 min'])
    expect(window.location.search).toBe('?span=day&at=2026-11-02')

    fireEvent.pointerUp(track(), mouse(xAt(10, 40)))
    expect(window.location.search).toBe('?from=2026-11-02T10%3A05&to=2026-11-02T10%3A40')
    expect(push).toHaveBeenCalledTimes(1)
    expect(axis().querySelector('.trail-band')).toBeNull()
  })

  it('is a click, and drops on Escape, as a drag across a chart is', async () => {
    await show()
    fireEvent.pointerDown(track(), mouse(xAt(10)))
    fireEvent.pointerMove(track(), mouse(xAt(10) + 3))
    expect(axis().querySelector('.trail-band')).toBeNull()
    fireEvent.pointerUp(track(), mouse(xAt(10) + 3))
    expect(window.location.search).toBe('?span=day&at=2026-11-02')

    fireEvent.pointerDown(track(), mouse(xAt(9)))
    fireEvent.pointerMove(track(), mouse(xAt(11)))
    expect(axis().querySelector('.trail-band')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(axis().querySelector('.trail-band')).toBeNull()
    fireEvent.pointerUp(track(), mouse(xAt(11)))
    expect(window.location.search).toBe('?span=day&at=2026-11-02')
  })
})
