/**
 * The time labels on every History axis that is not the Device tab's shared one keep apart at a
 * week and every width: a Metric tab chart's own axis, and Overview's. Both take their ticks
 * from timelineTicks(), so no two labels touch at a phone's width or a wide screen's, and a label
 * at an end stays inside. In London's zone on Monday 2 November 2026 at 15:20. uPlot draws on a
 * canvas jsdom does not have, so a stand-in keeps each chart's options and the test asks its axis
 * for splits and labels at a width, as uPlot does when it draws.
 */
import React from 'react'
import { render, screen, waitFor, cleanup, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { HistoryTab } from '../components/tabs/HistoryTab'
import { PLOT_LEFT_PX, PLOT_RIGHT_PX } from '../components/common/TimeSeriesChart'
import { TICK_CHAR_PX, TICK_GAP_PX } from '../utils/timelineAxis'
import { calendarTicks } from '../utils/timeWindow'
import { api } from '../api'

const MACHINE_TZ = process.env.TZ
process.env.TZ = 'Europe/London'
afterAll(() => {
  if (MACHINE_TZ === undefined) delete process.env.TZ
  else process.env.TZ = MACHINE_TZ
})

const { plots } = vi.hoisted(() => ({ plots: [] }))

vi.mock('../hooks/usePolling', () => ({ usePolling: () => {} }))
vi.mock('uplot', () => {
  class FakePlot {
    constructor(opts, data, target) {
      this.opts = opts
      this.over = document.createElement('div')
      this.over.className = 'u-over'
      target.appendChild(this.over)
      plots.push(this)
    }
    setSize() {}
    destroy() { this.over.remove() }
  }
  FakePlot.paths = { stepped: () => () => null }
  return { default: FakePlot }
})
vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), readCarriedTelemetry: vi.fn(), readTelemetryChanges: vi.fn(), readCoverage: vi.fn() } }
})

const LATHE = '2b3e0c4a-0001-4000-8000-000000000001'
const MILL = '2b3e0c4a-0002-4000-8000-000000000002'
const devices = [
  { asset_id: LATHE, asset_name: 'Lathe 3', status: 'ONLINE', last_birth_metrics: ['Spindle/LOAD'], location_source: 'explicit', effective_cell_id: 'c1' },
  { asset_id: MILL, asset_name: 'Mill 2', status: 'ONLINE', last_birth_metrics: ['Spindle/LOAD'], location_source: 'explicit', effective_cell_id: 'c1' },
]
const cells = [{ cell_id: 'c1', cell_name: 'Turning', name: 'Turning', area_id: 'a1' }]
const areas = [{ area_id: 'a1', area_name: 'Hall B', name: 'Hall B' }]
const catalog = [{ name: 'Spindle/LOAD', units: 'kW', datatype: 10 }]

const readings = ({ from, bucketMinutes, assetIds }) => {
  const width = bucketMinutes * 60000
  const first = Math.floor(Date.parse(from) / width) * width
  return Promise.resolve(assetIds.flatMap(asset => [0, 1, 2].map(i => ({
    bucket_ts: new Date(first + i * width).toISOString(), asset_id: asset, metric_name: 'Spindle/LOAD',
    avg_double: 40 + i, min_double: 39, max_double: 45, last_double: 41, last_string: null, last_bool: null, n_rows: 4, is_carried: false,
  }))))
}
const coverage = ({ from, to, blockMinutes, assetIds }) => {
  const width = blockMinutes * 60000
  const first = Math.floor(Date.parse(from) / width) * width
  return Promise.resolve(assetIds.map(id => ({
    asset_id: id, first_block: new Date(first).toISOString(), block_width: `${String(Math.floor(blockMinutes / 60)).padStart(2, '0')}:${String(blockMinutes % 60).padStart(2, '0')}:00`,
    counts: Array.from({ length: Math.ceil((Date.parse(to) - first) / width) }, () => 6),
    computed_from: '-infinity', computed_to: 'infinity', complete: true,
  })))
}

let axisPx = 0
let originalWidth
beforeEach(() => {
  vi.clearAllMocks()
  plots.length = 0
  axisPx = 0
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 2, 15, 20))
  api.get.mockImplementation((p) => Promise.resolve(
    p.startsWith('/api/v1/devices') ? devices : p.startsWith('/api/v1/cells') ? cells : p.startsWith('/api/v1/areas') ? areas
      : p.startsWith('/api/v1/metric-catalog') ? catalog : []))
  api.readCarriedTelemetry.mockImplementation(readings)
  api.readTelemetryChanges.mockResolvedValue([])
  api.readCoverage.mockImplementation(coverage)
  originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() { return this.classList?.contains('trail-axis-track') ? axisPx : 0 },
  })
})
afterEach(() => {
  vi.useRealTimers()
  if (originalWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalWidth)
  else delete HTMLElement.prototype.clientWidth
  window.history.replaceState(null, '', '/')
})

/** A label's edges along an axis `width` wide, for how it stands on its tick. */
const edges = (at, label, width, stand) => {
  const px = label.length * TICK_CHAR_PX
  const x = at * width
  return stand === 'start' ? [x, x + px] : stand === 'end' ? [x - px, x] : [x - px / 2, x + px / 2]
}

/** The widest a chart is on a 360px phone (card and insets taken off), and on a 1600px screen. */
const CHART_PX = { '360': 304, '1600': 1500 }

describe("a Metric tab chart's own axis", () => {
  const week = '?span=week&at=2026-11-02'

  /** What uPlot asks the chart's time axis for at a canvas `px` wide: where its labels stand, and what they say. */
  const drawnAt = (px) => {
    const [time] = plots.find(p => !p.destroyed).opts.axes
    const u = { width: px }
    const splits = time.splits(u)
    return { splits, labels: time.values(u, splits) }
  }

  it.each(Object.entries(CHART_PX))('keeps the labels of a week apart at %spx, and inside the gutters beside the plot', async (screenPx, px) => {
    window.history.replaceState(null, '', `/history/metric/Spindle%2FLOAD${week}`)
    render(<HistoryTab hasPermission={() => true} showToast={vi.fn()} />)
    await waitFor(() => expect(plots.length).toBeGreaterThan(0))
    const { splits, labels } = drawnAt(px)
    const plot = px - PLOT_LEFT_PX - PLOT_RIGHT_PX
    const start = new Date(2026, 10, 2).getTime() / 1000
    const span = 7 * 24 * 3600
    expect(labels.length, `a week at ${screenPx}px`).toBeGreaterThan(0)
    expect(labels).toHaveLength(splits.length)
    const boxes = splits.map((s, i) => edges((s - start) / span, labels[i], plot, 'middle'))
    boxes.forEach(([left, right], i) => {
      expect(left, labels[i]).toBeGreaterThanOrEqual(-PLOT_LEFT_PX)
      expect(right, labels[i]).toBeLessThanOrEqual(plot + PLOT_RIGHT_PX)
      if (i > 0) expect(left - boxes[i - 1][1], `${labels[i - 1]} then ${labels[i]} at ${screenPx}px`).toBeGreaterThanOrEqual(TICK_GAP_PX - 0.5)
    })
    // The old labels ran together as "Mon 00:00Mon 08:00": none of these is a clock time.
    expect(labels.every(l => !/\d\d:\d\d.*\d\d:\d\d/.test(l))).toBe(true)
    expect(labels.length).toBeGreaterThanOrEqual(px > 1000 ? 7 : 2)
  })

  it('asks for them again at the width the chart has when it draws, and takes fewer on a narrower one', async () => {
    window.history.replaceState(null, '', `/history/metric/Spindle%2FLOAD${week}`)
    render(<HistoryTab hasPermission={() => true} showToast={vi.fn()} />)
    await waitFor(() => expect(plots.length).toBeGreaterThan(0))
    expect(drawnAt(CHART_PX['360']).splits.length).toBeLessThan(drawnAt(CHART_PX['1600']).splits.length)
  })

  it('keeps its own axis under each chart and its gridlines at the labels: a chart outside the shared axis', async () => {
    window.history.replaceState(null, '', `/history/metric/Spindle%2FLOAD${week}`)
    render(<HistoryTab hasPermission={() => true} showToast={vi.fn()} />)
    await waitFor(() => expect(plots.length).toBeGreaterThan(0))
    const [time] = plots[0].opts.axes
    expect(time.size).toBeUndefined()
    expect(time.grid.width).toBe(1)
    expect(document.querySelector('.chart-axis')).toBeNull()
  })
})

describe("Overview's axis", () => {
  const ticks = () => [...document.querySelectorAll('.trail-axis-track .trail-tick')]
  /** Each tick's label and the edges it takes along the track, from its place and how it stands on it. */
  const shown = (width) => ticks().map((t) => {
    const stand = t.style.transform === 'none' ? 'start' : t.style.transform === 'translateX(-100%)' ? 'end' : 'middle'
    return { label: t.textContent, box: edges(parseFloat(t.style.left) / 100, t.textContent, width, stand) }
  })

  const visit = async (search, px) => {
    axisPx = px
    window.history.replaceState(null, '', `/history/overview${search}`)
    render(<HistoryTab showToast={vi.fn()} userRole="Administrator" />)
    await waitFor(() => expect(ticks().length).toBeGreaterThan(0))
    // The axis measures its track as it mounts, and its ticks follow in the next render.
    await act(async () => {})
  }

  // The label column takes 140px and a gap of 10 on a phone, so a 360px card leaves a track of about 186px.
  it.each([['a week', '?span=week&at=2026-11-02'], ['Last 7 days', '?range=7d'], ['a day', '?span=day&at=2026-11-02'], ['a month', '?span=month&at=2026-11-02']])(
    'keeps the labels of %s apart at 360px and at 1600px, and inside the track',
    async (name, search) => {
      for (const [screenPx, px] of [['360', 186], ['1600', 1100]]) {
        await visit(search, px)
        const labels = shown(px)
        expect(labels.length, `${name} at ${screenPx}px`).toBeGreaterThan(0)
        labels.forEach(({ label, box: [left, right] }, i) => {
          expect(left, `${label} of ${name} at ${screenPx}px`).toBeGreaterThanOrEqual(-0.5)
          expect(right, `${label} of ${name} at ${screenPx}px`).toBeLessThanOrEqual(px + 0.5)
          if (i > 0) expect(left - labels[i - 1].box[1], `${labels[i - 1].label} then ${label} of ${name} at ${screenPx}px`).toBeGreaterThanOrEqual(TICK_GAP_PX - 0.5)
        })
        cleanup()
      }
    },
  )

  it("takes a calendar window's ticks from the same rule, since its own five or eight fixed ticks crowd a phone's track", () => {
    const [start, end] = [new Date(2026, 10, 2), new Date(2026, 10, 9)]
    const own = calendarTicks('week', start, end)
    const at = own.map(t => (t.at - start) / (end - start))
    // 186px of track, a label each 5 glyphs wide, centred but for the two ends: they overlap.
    const boxes = own.map((t, i) => edges(at[i], t.label, 186, i === 0 ? 'start' : i === own.length - 1 ? 'end' : 'middle'))
    expect(Math.min(...boxes.slice(1).map(([left], i) => left - boxes[i][1]))).toBeLessThan(TICK_GAP_PX)
  })

  it('holds an end label inside the track, and is chosen again for the width the track has', async () => {
    await visit('?span=week&at=2026-11-02', 1100)
    const wide = ticks()
    expect(wide[0].style.transform).toBe('none')
    expect(wide.at(-1).style.transform).toBe('translateX(-100%)')
    expect(wide.map(t => t.textContent).slice(0, 3)).toEqual(['Mon 2', 'Tue 3', 'Wed 4'])
    cleanup()
    await visit('?span=week&at=2026-11-02', 186)
    expect(ticks().length).toBeLessThan(wide.length)
  })

  it('draws a gridline at each tick', async () => {
    await visit('?span=week&at=2026-11-02', 1100)
    const lines = [...document.querySelectorAll('.trail-gridlines .trail-gridline')].map(l => l.style.left)
    expect(lines).toEqual(ticks().map(t => t.style.left))
    expect(screen.getAllByText(/^Now /)).toHaveLength(1)
  })
})
