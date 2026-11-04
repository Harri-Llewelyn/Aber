/**
 * The History page: the device picker, one chart per metric at the resolution the row cap picks,
 * the now marker, a theme switch, and uPlot's own zoom left off. uPlot draws on a canvas jsdom does
 * not have, so a stand-in records what each chart was built with and gives it a plot area.
 */
import React from 'react'
import { render, screen, waitFor, within, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HistoryTab } from '../components/tabs/HistoryTab'
import { api } from '../api'

const { plots, polls } = vi.hoisted(() => ({ plots: [], polls: [] }))

// The refresh timer as the page sets it: the read, the interval and whether it runs.
vi.mock('../hooks/usePolling', () => ({
  usePolling: (callback, intervalMs, enabled) => { polls.push({ callback, intervalMs, enabled }) },
}))
const lastPoll = () => polls[polls.length - 1]

vi.mock('uplot', () => {
  class FakePlot {
    constructor(opts, data, target) {
      this.opts = opts
      this.data = data
      this.over = document.createElement('div')
      this.over.className = 'u-over'
      target.appendChild(this.over)
      plots.push(this)
    }
    setSize(size) { this.size = size }
    destroy() { this.destroyed = true; this.over.remove() }
  }
  FakePlot.paths = { stepped: () => () => null }
  return { default: FakePlot }
})

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), readCarriedTelemetry: vi.fn() } }
})

const LATHE = '2b3e0c4a-1111-4000-8000-000000000001'
const PRESS = '2b3e0c4a-2222-4000-8000-000000000002'
const devices = [
  { asset_id: LATHE, asset_name: 'Lathe 3', effective_cell_id: 'c1', last_birth_metrics: ['Spindle/LOAD', 'Spindle/SPEED'], submodel_schema_ids: ['s1'] },
  { asset_id: PRESS, asset_name: 'Press 1', effective_cell_id: 'c1', last_birth_metrics: [] },
  { asset_id: '2b3e0c4a-3333-4000-8000-000000000003', asset_name: 'Stranger', is_quarantined: true },
]
const schemas = [{ schema_uuid: 's1', schema_definition: { properties: { 'Spindle/LOAD': { type: 'number', minimum: 0, maximum: 120 } } } }]
const catalog = [{ name: 'Spindle/LOAD', units: 'kW' }, { name: 'Spindle/SPEED', units: 'rpm' }]

const routeGet = (path) => {
  if (path.startsWith('/api/v1/devices')) return Promise.resolve(devices)
  if (path.startsWith('/api/v1/cells')) return Promise.resolve([{ cell_id: 'c1', name: 'Turning', area_id: 'a1' }])
  if (path.startsWith('/api/v1/areas')) return Promise.resolve([{ area_id: 'a1', name: 'Hall B' }])
  if (path.startsWith('/api/v1/schemas')) return Promise.resolve(schemas)
  if (path.startsWith('/api/v1/metric-catalog')) return Promise.resolve(catalog)
  return Promise.resolve([])
}

/** A reading in every bucket of the read, for each metric it names. */
const readings = ({ from, bucketMinutes, metricNames }) => {
  const width = bucketMinutes * 60000
  const first = Math.floor(Date.parse(from) / width) * width
  return Promise.resolve(metricNames.flatMap(name => [0, 1, 2].map(i => ({
    bucket_ts: new Date(first + i * width).toISOString(), asset_id: 'dev2b3e0c4a111140008000', metric_name: name,
    avg_double: 40 + i, min_double: 39, max_double: 45, last_double: 41, last_string: null, last_bool: null,
    n_rows: i === 2 ? 0 : 4, is_carried: i === 2,
  }))))
}

const visit = async (address) => {
  window.history.pushState({}, '', address)
  render(<HistoryTab />)
  await waitFor(() => expect(screen.queryByText(/Loading devices/)).not.toBeInTheDocument())
}

beforeEach(() => {
  vi.clearAllMocks()
  plots.length = 0
  polls.length = 0
  api.get.mockImplementation(routeGet)
  api.readCarriedTelemetry.mockImplementation(readings)
  document.documentElement.setAttribute('data-theme', 'dark')
  document.documentElement.style.setProperty('--accent', '#00d4ff')
})

afterEach(() => {
  document.documentElement.style.removeProperty('--accent')
  window.history.pushState({}, '', '/')
})

describe('the device picker', () => {
  it('lists every device but a quarantined one, each a link to its charts at the window shown', async () => {
    await visit('/history?range=7d')
    const table = screen.getByRole('table', { name: /choose a device/i })
    const links = within(table).getAllByRole('link')
    expect(links.map(l => l.textContent)).toEqual(['Lathe 3', 'Press 1'])
    expect(links[0]).toHaveAttribute('href', `/history/device/${LATHE}?range=7d`)
    expect(within(table).getAllByText('Turning')).toHaveLength(2)
    expect(within(table).getAllByText('Hall B')).toHaveLength(2)
    expect(api.readCarriedTelemetry).not.toHaveBeenCalled()
  })

  it('narrows to what the search box names, and says when nothing matches', async () => {
    await visit('/history?search=press')
    expect(within(screen.getByRole('table')).getAllByRole('link').map(l => l.textContent)).toEqual(['Press 1'])
    fireEvent.change(screen.getByRole('searchbox', { name: /find a device/i }), { target: { value: 'nothing like it' } })
    expect(await screen.findByText('No device matches "nothing like it".')).toBeInTheDocument()
  })

  it('opens a device from its link, keeping the window', async () => {
    await visit('/history?span=week&at=2026-11-02')
    fireEvent.click(screen.getByRole('link', { name: 'Lathe 3' }))
    expect(window.location.pathname).toBe(`/history/device/${LATHE}`)
    expect(window.location.search).toBe('?span=week&at=2026-11-02')
  })
})

describe("a device's charts", () => {
  it('reads every metric at the finest resolution the row cap allows, and says which', async () => {
    await visit(`/history/device/${LATHE}`)
    await waitFor(() => expect(api.readCarriedTelemetry).toHaveBeenCalledTimes(1))
    const [args] = api.readCarriedTelemetry.mock.calls[0]
    // Two metrics over Last 24 hours: 1,441 one-minute buckets each, 2,882 rows, under 5,000.
    expect(args).toMatchObject({ bucketMinutes: 1, assetIds: [LATHE], metricNames: ['Spindle/LOAD', 'Spindle/SPEED'] })
    expect(Date.parse(args.to) - Date.parse(args.from)).toBe(24 * 60 * 60 * 1000)
    expect(await screen.findByText('2 metrics, in 1-minute buckets')).toBeInTheDocument()
  })

  it('draws one chart per metric, named with its unit, with a summary a screen reader is given', async () => {
    await visit(`/history/device/${LATHE}?range=7d`)
    const figures = await screen.findAllByRole('figure')
    expect(figures).toHaveLength(2)
    expect(screen.getByRole('figure', { name: 'Spindle/LOAD (kW)' })).toBe(figures[0])
    expect(screen.getByRole('figure', { name: 'Spindle/SPEED (rpm)' })).toBe(figures[1])
    const load = screen.getByRole('img', { name: 'Spindle/LOAD (kW)' })
    expect(load).toHaveAccessibleDescription(
      'Spindle/LOAD (kW), Last 7 days, in 5-minute buckets. Latest 42 kW. Lowest 39 kW, highest 45 kW.'
      + ' 1 of 2017 buckets had no reading and carry the last one forward. Valid range 0 to 120 kW.')
    expect(screen.getByText('Valid range 0 to 120 kW')).toBeInTheDocument()
    expect(plots).toHaveLength(2)
  })

  it('draws the average solid, a carried bucket dashed, and the range as a band', async () => {
    await visit(`/history/device/${LATHE}`)
    await waitFor(() => expect(plots).toHaveLength(2))
    const { opts, data } = plots[0]
    expect(opts.series.map(s => s.label)).toEqual([undefined, 'Highest', 'Lowest', 'Average', 'Carried forward'])
    expect(opts.series[4].dash).toEqual([5, 4])
    expect(opts.series[3].dash).toBeUndefined()
    expect(opts.bands).toEqual([{ series: [1, 2], fill: 'rgba(0, 212, 255, 0.18)' }])
    // Bucket 2 was carried: off the solid line, on the dashed one with the reading before it.
    expect(data[3].slice(0, 3)).toEqual([40, 41, null])
    expect(data[4].slice(0, 3)).toEqual([null, 41, 42])
  })

  it("leaves uPlot's own drag-to-zoom off: the page's window is the only zoom", async () => {
    await visit(`/history/device/${LATHE}`)
    await waitFor(() => expect(plots).toHaveLength(2))
    for (const { opts } of plots) {
      expect(opts.cursor.drag).toEqual({ x: false, y: false, setScale: false })
      expect(opts.select).toEqual({ show: false })
      expect(opts.cursor.sync).toEqual({ key: `history-${LATHE}` })
    }
  })

  it('fixes the time axis to the window, so a chart fits its width', async () => {
    await visit(`/history/device/${LATHE}?span=day&at=2026-11-02`)
    await waitFor(() => expect(plots).toHaveLength(2))
    expect(plots[0].opts.scales.x.range).toEqual([new Date(2026, 10, 2).getTime() / 1000, new Date(2026, 10, 3).getTime() / 1000])
  })

  it('marks now and hatches the rest of a window that runs past it', async () => {
    await visit(`/history/device/${LATHE}?span=day`)
    await waitFor(() => expect(plots).toHaveLength(2))
    const over = plots[0].over
    await waitFor(() => expect(within(over).getByText(/^Now \d\d:\d\d$/)).toBeInTheDocument())
    const now = within(over).getByText(/^Now /)
    const start = new Date(); start.setHours(0, 0, 0, 0)
    const end = new Date(start); end.setDate(end.getDate() + 1)
    const expected = ((Date.now() - start) / (end - start)) * 100
    expect(Math.abs(parseFloat(now.style.left) - expected)).toBeLessThan(1)
    expect(over.querySelector('.chart-future').style.left).toBe(now.style.left)
  })

  it('draws no now marker on a window that ends at now', async () => {
    await visit(`/history/device/${LATHE}`)
    await waitFor(() => expect(plots).toHaveLength(2))
    expect(within(plots[0].over).queryByText(/^Now /)).not.toBeInTheDocument()
  })

  it('follows a theme switch without a reload', async () => {
    await visit(`/history/device/${LATHE}`)
    await waitFor(() => expect(plots).toHaveLength(2))
    expect(plots[0].opts.series[3].stroke).toBe('#00d4ff')
    await act(async () => {
      document.documentElement.style.setProperty('--accent', '#0284c7')
      document.documentElement.setAttribute('data-theme', 'light')
    })
    await waitFor(() => expect(plots).toHaveLength(4))
    expect(plots[0].destroyed).toBe(true)
    expect(plots[2].opts.series[3].stroke).toBe('#0284c7')
    expect(plots[2].opts.bands[0].fill).toBe('rgba(2, 132, 199, 0.18)')
    expect(api.readCarriedTelemetry).toHaveBeenCalledTimes(1)
  })

  it('says when a device declares no metric', async () => {
    await visit(`/history/device/${PRESS}`)
    expect(await screen.findByText(/declared no metrics/)).toBeInTheDocument()
    expect(api.readCarriedTelemetry).not.toHaveBeenCalled()
  })

  it('says when no device answers to the address', async () => {
    await visit('/history/device/no-such-device')
    expect(screen.getByText(/No device answers to this address/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Choose another device' })).toHaveAttribute('href', '/history')
  })

  it('refuses a window too long for one series even in day buckets, and reads nothing', async () => {
    await visit(`/history/device/${LATHE}?from=2000-01-01T00:00&to=2026-01-01T00:00`)
    expect(await screen.findByText(/This window is too long to chart/)).toBeInTheDocument()
    expect(api.readCarriedTelemetry).not.toHaveBeenCalled()
  })

  it('says what the read refused', async () => {
    api.readCarriedTelemetry.mockRejectedValue(new Error('the historian is out'))
    await visit(`/history/device/${LATHE}`)
    expect(await screen.findByText('The readings could not be read: the historian is out')).toBeInTheDocument()
  })

  it('names the device in the toolbar, and lists the others to chart instead', async () => {
    await visit(`/history/device/${LATHE}?range=1h`)
    fireEvent.click(screen.getByRole('button', { name: 'Device: Lathe 3' }))
    const panel = await screen.findByRole('dialog', { name: 'Choose a device' })
    const option = within(panel).getByRole('link', { name: /Press 1/ })
    expect(option).toHaveAttribute('href', `/history/device/${PRESS}?range=1h`)
    expect(within(panel).getByRole('link', { name: /Lathe 3/ })).toHaveAttribute('aria-current', 'true')
  })
})

describe('refreshing', () => {
  const control = () => screen.getByRole('group', { name: 'Refresh' })
  const interval = () => within(control()).getByRole('combobox', { name: 'Refresh automatically' })

  it('offers Off, 30 s, 1 min and 5 min, and starts Off', async () => {
    await visit(`/history/device/${LATHE}`)
    await waitFor(() => expect(api.readCarriedTelemetry).toHaveBeenCalledTimes(1))
    expect([...interval().options].map(o => o.textContent)).toEqual(['Off', '30 s', '1 min', '5 min'])
    expect(interval()).toHaveDisplayValue('Off')
    expect(lastPoll()).toMatchObject({ enabled: false })
  })

  it('reads again on the timer while the window reaches now', async () => {
    await visit(`/history/device/${LATHE}`)
    await waitFor(() => expect(api.readCarriedTelemetry).toHaveBeenCalledTimes(1))
    fireEvent.change(interval(), { target: { value: '60' } })
    expect(lastPoll()).toMatchObject({ intervalMs: 60000, enabled: true })
    await act(async () => { await lastPoll().callback(new AbortController().signal) })
    expect(api.readCarriedTelemetry).toHaveBeenCalledTimes(2)
  })

  it('keeps the timer off, and says why, for a window that has ended; Refresh still reads', async () => {
    await visit(`/history/device/${LATHE}?span=day&at=2026-11-02`)
    await waitFor(() => expect(api.readCarriedTelemetry).toHaveBeenCalledTimes(1))
    expect(interval()).toBeDisabled()
    expect(interval()).toHaveAccessibleDescription(/This window has ended, so nothing new can arrive in it/)
    expect(lastPoll()).toMatchObject({ enabled: false })
    fireEvent.click(within(control()).getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(api.readCarriedTelemetry).toHaveBeenCalledTimes(2))
  })

  it('stops the timer when the window moves into the past, and starts it again back at now', async () => {
    await visit(`/history/device/${LATHE}`)
    await waitFor(() => expect(api.readCarriedTelemetry).toHaveBeenCalledTimes(1))
    fireEvent.change(interval(), { target: { value: '30' } })
    expect(lastPoll()).toMatchObject({ intervalMs: 30000, enabled: true })
    act(() => { window.history.pushState({}, '', `/history/device/${LATHE}?span=day&at=2026-11-02`); window.dispatchEvent(new PopStateEvent('popstate')) })
    await waitFor(() => expect(interval()).toBeDisabled())
    expect(lastPoll()).toMatchObject({ enabled: false })
    expect(interval()).toHaveDisplayValue('Off')
    act(() => { window.history.pushState({}, '', `/history/device/${LATHE}`); window.dispatchEvent(new PopStateEvent('popstate')) })
    await waitFor(() => expect(interval()).toBeEnabled())
    expect(interval()).toHaveDisplayValue('30 s')
    expect(lastPoll()).toMatchObject({ intervalMs: 30000, enabled: true })
  })

  it('keeps the charts on screen while it reads again', async () => {
    await visit(`/history/device/${LATHE}`)
    await screen.findAllByRole('figure')
    let finish
    api.readCarriedTelemetry.mockImplementation((args) => new Promise(resolve => { finish = () => resolve(readings(args)) }))
    fireEvent.click(within(control()).getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByText(/reading again…/)).toBeInTheDocument()
    expect(screen.getAllByRole('figure')).toHaveLength(2)
    await act(async () => { finish() })
    await waitFor(() => expect(screen.queryByText(/reading again…/)).not.toBeInTheDocument())
  })
})
