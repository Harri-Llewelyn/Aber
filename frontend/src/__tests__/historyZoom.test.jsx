/**
 * Zooming History, as the Audit Trail zooms: Zoom in and Zoom out in the time control, and a drag
 * across a chart's plot area or a state's strip, which shades the band on every chart, says what it
 * covers, and on release sets that stretch as the window (`from` and `to`) as a new history entry,
 * so Back undoes it. A press that moves less than BAND_DRAG_PX is a click, Escape drops a band, and
 * touch starts none. In London's zone on Monday 2 November 2026 at 15:20.
 */
import React from 'react'
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { HistoryTab } from '../components/tabs/HistoryTab'
import { BAND_DRAG_PX } from '../hooks/useBandDrag'
import { api } from '../api'

const MACHINE_TZ = process.env.TZ
process.env.TZ = 'Europe/London'
afterAll(() => {
  if (MACHINE_TZ === undefined) delete process.env.TZ
  else process.env.TZ = MACHINE_TZ
})

vi.mock('uplot', () => {
  class FakePlot {
    constructor(opts, data, target) {
      this.opts = opts
      this.over = document.createElement('div')
      this.over.className = 'u-over'
      target.appendChild(this.over)
    }
    setSize() {}
    destroy() { this.over.remove() }
  }
  FakePlot.paths = { stepped: () => () => null }
  return { default: FakePlot }
})

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), readCarriedTelemetry: vi.fn() } }
})

const LATHE = '2b3e0c4a-1111-4000-8000-000000000001'
const ROBOT = '2b3e0c4a-5555-4000-8000-000000000005'
const devices = [
  { asset_id: LATHE, asset_name: 'Lathe 3', last_birth_metrics: ['Spindle/LOAD', 'Spindle/SPEED'] },
  { asset_id: ROBOT, asset_name: 'Robot 5', last_birth_metrics: ['Controller/EXECUTION'] },
]

/** A reading in the first three buckets: numbers, or a state that holds for the whole window. */
const readings = ({ from, bucketMinutes, metricNames }) => {
  const width = bucketMinutes * 60000
  const first = Math.floor(Date.parse(from) / width) * width
  const count = metricNames.includes('Controller/EXECUTION') ? 960 : 3
  return Promise.resolve(metricNames.flatMap(name => Array.from({ length: count }, (_, i) => ({
    bucket_ts: new Date(first + i * width).toISOString(), metric_name: name,
    avg_double: name === 'Controller/EXECUTION' ? null : 40 + i, min_double: null, max_double: null,
    last_double: name === 'Controller/EXECUTION' ? null : 40 + i,
    last_string: name === 'Controller/EXECUTION' ? 'RUNNING' : null, last_bool: null,
    n_rows: 1, is_carried: false,
  }))))
}

/*
 * Every plot area and strip is 1000px wide from x = 100, so a fraction f of the day is at
 * x = 100 + 1000f, and 1000px is 1440 minutes.
 */
const LEFT = 100
const xAt = (h, mi = 0) => LEFT + 1000 * (h * 60 + mi) / 1440
let originalRect
beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 2, 15, 20))
  api.get.mockImplementation((p) => Promise.resolve(p.startsWith('/api/v1/devices') ? devices : []))
  api.readCarriedTelemetry.mockImplementation(readings)
  originalRect = Element.prototype.getBoundingClientRect
  Element.prototype.getBoundingClientRect = function rect() {
    return this.classList?.contains('u-over') || this.classList?.contains('chart-box-states')
      ? { left: LEFT, right: LEFT + 1000, width: 1000, top: 0, bottom: 140, height: 140, x: LEFT, y: 0 }
      : originalRect.call(this)
  }
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  Element.prototype.getBoundingClientRect = originalRect
  window.history.replaceState(null, '', '/')
})

const show = async (device = LATHE, search = '?span=day&at=2026-11-02') => {
  window.history.replaceState(null, '', `/history/device/${device}${search}`)
  render(<HistoryTab hasPermission={() => true} showToast={vi.fn()} />)
  await waitFor(() => expect(screen.getAllByRole('figure').length).toBeGreaterThan(0))
}
const plotAreas = () => [...document.querySelectorAll('.u-over')]
const bands = () => [...document.querySelectorAll('.chart-band')]
const bandWords = () => [...document.querySelectorAll('.chart-band-words')].map(w => w.textContent)
const search = () => window.location.search
const mouse = (clientX, extra = {}) => ({ pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX, ...extra })
const timeControl = () => screen.getByRole('group', { name: 'Time window' })

describe("History's time control", () => {
  it('offers Zoom in and Zoom out, and a zoom is a new history entry that Back undoes', async () => {
    await show()
    const push = vi.spyOn(window.history, 'pushState')
    const zoom = within(timeControl()).getByRole('group', { name: 'Zoom' })
    fireEvent.click(within(zoom).getByRole('button', { name: 'Zoom in' }))
    expect(search()).toBe('?from=2026-11-02T06%3A00&to=2026-11-02T18%3A00')
    expect(push).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(api.readCarriedTelemetry.mock.calls.at(-1)[0].from).toBe(new Date(2026, 10, 2, 6).toISOString()))

    act(() => { window.history.back() })
    await waitFor(() => expect(search()).toBe('?span=day&at=2026-11-02'))
    // Twice the day about its middle would run past now, so it ends with the current minute.
    fireEvent.click(within(zoom).getByRole('button', { name: 'Zoom out' }))
    expect(search()).toBe('?from=2026-10-31T15%3A21&to=2026-11-02T15%3A21')
  })
})

describe('a drag across a chart', () => {
  it('shades the band on every chart with what it covers, and its release sets from and to as a new entry', async () => {
    await show()
    expect(plotAreas()).toHaveLength(2)
    const push = vi.spyOn(window.history, 'pushState')

    fireEvent.pointerDown(plotAreas()[0], mouse(xAt(10, 5)))
    fireEvent.pointerMove(plotAreas()[0], mouse(xAt(10, 40)))
    expect(bands()).toHaveLength(2)
    expect(bands().map(b => b.parentElement)).toEqual(plotAreas())
    expect(bandWords()).toEqual(['10:05 – 10:40, 35 min', '10:05 – 10:40, 35 min'])
    expect(search()).toBe('?span=day&at=2026-11-02')

    fireEvent.pointerUp(plotAreas()[0], mouse(xAt(10, 40)))
    expect(search()).toBe('?from=2026-11-02T10%3A05&to=2026-11-02T10%3A40')
    expect(push).toHaveBeenCalledTimes(1)
    expect(bands()).toHaveLength(0)
    expect(within(timeControl()).getByRole('button', { name: /Mon 2 Nov, 10:05 – 10:40/ })).toBeInTheDocument()

    act(() => { window.history.back() })
    await waitFor(() => expect(search()).toBe('?span=day&at=2026-11-02'))
  })

  it('runs either way, and keeps the metrics and the buckets chosen', async () => {
    await show(LATHE, '?span=day&at=2026-11-02&metric=Spindle/LOAD&bucket=1h')
    fireEvent.pointerDown(plotAreas()[0], mouse(xAt(14)))
    fireEvent.pointerMove(plotAreas()[0], mouse(xAt(13)))
    expect(bandWords()).toEqual(['13:00 – 14:00, 1 h'])
    fireEvent.pointerUp(plotAreas()[0], mouse(xAt(13)))
    expect(Object.fromEntries(new URLSearchParams(search()))).toEqual({
      metric: 'Spindle/LOAD', bucket: '1h', from: '2026-11-02T13:00', to: '2026-11-02T14:00',
    })
  })

  it('is a click when the press moves less than 4 px: no band, and the window stays', async () => {
    await show()
    expect(BAND_DRAG_PX).toBe(4)
    fireEvent.pointerDown(plotAreas()[1], mouse(xAt(10)))
    fireEvent.pointerMove(plotAreas()[1], mouse(xAt(10) + 3))
    expect(bands()).toHaveLength(0)
    fireEvent.pointerUp(plotAreas()[1], mouse(xAt(10) + 3))
    expect(search()).toBe('?span=day&at=2026-11-02')
  })

  it('drops the band on Escape, and the release then changes nothing', async () => {
    await show()
    fireEvent.pointerDown(plotAreas()[0], mouse(xAt(9)))
    fireEvent.pointerMove(plotAreas()[0], mouse(xAt(11)))
    expect(bands()).toHaveLength(2)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(bands()).toHaveLength(0)
    fireEvent.pointerUp(plotAreas()[0], mouse(xAt(11)))
    expect(search()).toBe('?span=day&at=2026-11-02')
  })

  it('starts none from a touch, so a finger scrolls the page', async () => {
    await show()
    fireEvent.pointerDown(plotAreas()[0], mouse(xAt(9), { pointerType: 'touch' }))
    fireEvent.pointerMove(plotAreas()[0], mouse(xAt(12), { pointerType: 'touch' }))
    fireEvent.pointerUp(plotAreas()[0], mouse(xAt(12), { pointerType: 'touch' }))
    expect(bands()).toHaveLength(0)
    expect(search()).toBe('?span=day&at=2026-11-02')
  })

  it("takes the same drag on a state's strip", async () => {
    await show(ROBOT)
    const strip = document.querySelector('.chart-box-states')
    fireEvent.pointerDown(strip.querySelector('.chart-state'), mouse(xAt(8)))
    fireEvent.pointerMove(strip, mouse(xAt(9, 30)))
    expect(bands()).toHaveLength(1)
    expect(bands()[0].parentElement).toHaveClass('chart-overlay')
    expect(bandWords()).toEqual(['08:00 – 09:30, 1 h 30 min'])
    fireEvent.pointerUp(strip, mouse(xAt(9, 30)))
    expect(search()).toBe('?from=2026-11-02T08%3A00&to=2026-11-02T09%3A30')
  })
})
