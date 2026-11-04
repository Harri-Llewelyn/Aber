/**
 * The History page: the device picker, one chart per metric at the resolution the row cap picks,
 * the now marker, a theme switch, and uPlot's own zoom left off. uPlot draws on a canvas jsdom does
 * not have, so a stand-in records what each chart was built with and gives it a plot area.
 */
import React from 'react'
import { render, screen, waitFor, within, fireEvent, act, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HistoryTab } from '../components/tabs/HistoryTab'
import { CLOSED_GROUPS_KEY } from '../components/tabs/HistoryDevice'
import { PLOT_LEFT_PX, PLOT_RIGHT_PX } from '../components/common/TimeSeriesChart'
import { api } from '../api'
import fs from 'node:fs'
import path from 'node:path'
import { momentWords, stateHue } from '../utils/history'
import { PERMISSION_UUIDS } from '../constants'

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
const MILL = '2b3e0c4a-4444-4000-8000-000000000004'
const ROBOT = '2b3e0c4a-5555-4000-8000-000000000005'
const devices = [
  { asset_id: LATHE, asset_name: 'Lathe 3', effective_cell_id: 'c1', last_birth_metrics: ['Spindle/LOAD', 'Spindle/SPEED'], submodel_schema_ids: ['s1'] },
  { asset_id: PRESS, asset_name: 'Press 1', effective_cell_id: 'c1', last_birth_metrics: [] },
  { asset_id: MILL, asset_name: 'Mill 2', last_birth_metrics: ['Coolant/TEMP', 'Spindle/LOAD'] },
  { asset_id: ROBOT, asset_name: 'Robot 5', last_birth_metrics: ['Arm/TORQUE', 'Controller/EXECUTION'] },
  { asset_id: '2b3e0c4a-3333-4000-8000-000000000003', asset_name: 'Stranger', is_quarantined: true },
]
const schemas = [{ schema_uuid: 's1', schema_definition: { properties: { 'Spindle/LOAD': { type: 'number', minimum: 0, maximum: 120 } } } }]
const catalog = [
  { name: 'Spindle/LOAD', units: 'kW' }, { name: 'Spindle/SPEED', units: 'rpm' },
  { name: 'Arm/TORQUE', units: 'N·m', datatype: 10 }, { name: 'Controller/EXECUTION', datatype: 12 },
]

const routeGet = (path) => {
  if (path.startsWith('/api/v1/devices')) return Promise.resolve(devices)
  if (path.startsWith('/api/v1/cells')) return Promise.resolve([{ cell_id: 'c1', name: 'Turning', area_id: 'a1' }])
  if (path.startsWith('/api/v1/areas')) return Promise.resolve([{ area_id: 'a1', name: 'Hall B' }])
  if (path.startsWith('/api/v1/schemas')) return Promise.resolve(schemas)
  if (path.startsWith('/api/v1/metric-catalog')) return Promise.resolve(catalog)
  return Promise.resolve([])
}

/**
 * A state's runs over the first 60 buckets: RUNNING read at 0 and carried to 29, IDLE read at 30
 * and carried to 44, RUNNING again read at 45 and carried on.
 */
const STATE_AT = (i) => (i < 30 || i >= 45 ? 'RUNNING' : 'IDLE')
const stateRows = (first, width) => Array.from({ length: 60 }, (_, i) => ({
  bucket_ts: new Date(first + i * width).toISOString(), asset_id: 'dev2b3e0c4a555540008000', metric_name: 'Controller/EXECUTION',
  avg_double: null, min_double: null, max_double: null, last_double: null, last_string: STATE_AT(i), last_bool: null,
  n_rows: [0, 30, 45].includes(i) ? 1 : 0, is_carried: ![0, 30, 45].includes(i),
}))

/** A reading in every bucket of the read, for each metric it names. */
const readings = ({ from, bucketMinutes, metricNames }) => {
  const width = bucketMinutes * 60000
  const first = Math.floor(Date.parse(from) / width) * width
  if (metricNames.includes('Controller/EXECUTION')) return Promise.resolve(stateRows(first, width))
  return Promise.resolve(metricNames.flatMap(name => [0, 1, 2].map(i => ({
    bucket_ts: new Date(first + i * width).toISOString(), asset_id: 'dev2b3e0c4a111140008000', metric_name: name,
    avg_double: 40 + i, min_double: 39, max_double: 45, last_double: 41, last_string: null, last_bool: null,
    n_rows: i === 2 ? 0 : 4, is_carried: i === 2,
  }))))
}

/** Every permission unless a test says otherwise: Export CSV needs telemetry:read. */
const visit = async (address, { hasPermission = () => true } = {}) => {
  window.history.pushState({}, '', address)
  render(<HistoryTab hasPermission={hasPermission} showToast={vi.fn()} />)
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
    expect(links.map(l => l.textContent)).toEqual(['Lathe 3', 'Mill 2', 'Press 1', 'Robot 5'])
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
    const width = 5 * 60000
    const first = Math.floor(Date.parse(api.readCarriedTelemetry.mock.calls[0][0].from) / width) * width
    expect(load).toHaveAccessibleDescription(
      `Spindle/LOAD (kW), Last 7 days, in 5-minute buckets. Latest 41 kW, in the bucket from ${momentWords(first + width, 5)}.`
      + ' Lowest 39 kW, highest 45 kW. 1 of 2017 buckets had no reading and carry the last one forward. Valid range 0 to 120 kW.')
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

describe('the toolbar', () => {
  // Three days: 4,320 one-minute buckets, so one metric fits them and two do not.
  const THREE_DAYS = 'from=2026-10-01T00:00&to=2026-10-04T00:00'
  const metricOf = (search) => new URLSearchParams(search).get('metric')
  const lastRead = () => api.readCarriedTelemetry.mock.calls[api.readCarriedTelemetry.mock.calls.length - 1][0]
  const bucketButton = () => screen.getByRole('button', { name: /^Buckets: / })
  const bucketChoices = async () => {
    fireEvent.click(bucketButton())
    const panel = await screen.findByRole('dialog', { name: 'Choose the bucket size' })
    return within(panel).getAllByRole('button')
  }
  const offered = (buttons) => buttons.map(b => [b.textContent, b.getAttribute('aria-disabled') === 'true'])
  const choose = async (label) => {
    fireEvent.click(screen.getByRole('button', { name: /^Metrics: / }))
    const panel = await screen.findByRole('dialog', { name: 'Metrics' })
    fireEvent.click(within(panel).getByRole('checkbox', { name: label }))
  }

  it('lays the toolbar out as Logs does: the filters, then Clear filters before the refresh control', async () => {
    await visit(`/history/device/${LATHE}?range=7d`)
    const bar = document.querySelector('.filter-bar')
    const actions = bar.querySelector('.filter-bar-actions')
    expect(within(actions).getByRole('button', { name: /Clear filters \(1\)/ })).toBeInTheDocument()
    expect(actions.lastElementChild).toBe(within(actions).getByRole('group', { name: 'Refresh' }))
    expect(screen.getByRole('button', { name: 'Metrics: All metrics' })).toBeInTheDocument()
    expect(bucketButton()).toHaveAccessibleName('Buckets: Auto buckets')
  })

  it("offers the device's metrics, and charts only those chosen, in the address", async () => {
    await visit(`/history/device/${LATHE}`)
    await screen.findAllByRole('figure')
    await choose('Spindle/SPEED')
    await waitFor(() => expect(lastRead()).toMatchObject({ metricNames: ['Spindle/SPEED'] }))
    expect(metricOf(window.location.search)).toBe('Spindle/SPEED')
    expect(await screen.findByText('1 of 2 metrics, in 1-minute buckets')).toBeInTheDocument()
    await waitFor(() => expect(screen.getAllByRole('figure')).toHaveLength(1))
    expect(screen.getByRole('figure', { name: 'Spindle/SPEED (rpm)' })).toBeInTheDocument()
  })

  it('gives fewer metrics finer buckets: the row cap counts the metrics chosen', async () => {
    await visit(`/history/device/${LATHE}?${THREE_DAYS}`)
    expect(await screen.findByText('2 metrics, in 5-minute buckets')).toBeInTheDocument()
    await choose('Spindle/LOAD')
    expect(await screen.findByText('1 of 2 metrics, in 1-minute buckets')).toBeInTheDocument()
    expect(lastRead()).toMatchObject({ bucketMinutes: 1, metricNames: ['Spindle/LOAD'] })
  })

  it('opens on a link with the metrics it names, and leaves out a name the device does not have', async () => {
    await visit(`/history/device/${LATHE}?metric=Spindle/LOAD,Nothing/HERE`)
    await waitFor(() => expect(lastRead()).toMatchObject({ metricNames: ['Spindle/LOAD'] }))
    await waitFor(() => expect(metricOf(window.location.search)).toBe('Spindle/LOAD'))
    expect(screen.getByRole('button', { name: 'Metrics: Spindle/LOAD' })).toBeInTheDocument()
  })

  it('keeps the metrics and the buckets on switching device, where the next device has the metrics', async () => {
    await visit(`/history/device/${LATHE}?range=1h&metric=Spindle/LOAD,Spindle/SPEED&bucket=5m`)
    fireEvent.click(screen.getByRole('button', { name: 'Device: Lathe 3' }))
    const panel = await screen.findByRole('dialog', { name: 'Choose a device' })
    const link = within(panel).getByRole('link', { name: /Mill 2/ })
    const query = new URL(link.getAttribute('href'), 'http://x').searchParams
    expect(Object.fromEntries(query)).toEqual({ range: '1h', metric: 'Spindle/LOAD,Spindle/SPEED', bucket: '5m' })
    act(() => { window.history.pushState({}, '', link.getAttribute('href')); window.dispatchEvent(new PopStateEvent('popstate')) })
    await waitFor(() => expect(lastRead()).toMatchObject({ assetIds: [MILL], metricNames: ['Spindle/LOAD'], bucketMinutes: 5 }))
    await waitFor(() => expect(metricOf(window.location.search)).toBe('Spindle/LOAD'))
  })

  it('offers Auto, then each bucket size, and reads at the one chosen, in the address', async () => {
    await visit(`/history/device/${LATHE}?span=day&at=2026-11-02`)
    await waitFor(() => expect(lastRead()).toMatchObject({ bucketMinutes: 1 }))
    const choices = await bucketChoices()
    expect(offered(choices)).toEqual([
      ['Auto buckets', false], ['1-minute buckets', false], ['5-minute buckets', false], ['1-hour buckets', false], ['1-day buckets', false],
    ])
    expect(choices[0]).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(choices[3])
    await waitFor(() => expect(lastRead()).toMatchObject({ bucketMinutes: 60 }))
    expect(new URLSearchParams(window.location.search).get('bucket')).toBe('1h')
    expect(await screen.findByText('2 metrics, in 1-hour buckets')).toBeInTheDocument()
    expect(bucketButton()).toHaveAccessibleName('Buckets: 1-hour buckets')
  })

  it('offers a size finer than Auto takes, but off, and says why', async () => {
    await visit(`/history/device/${LATHE}?${THREE_DAYS}`)
    await screen.findByText('2 metrics, in 5-minute buckets')
    const choices = await bucketChoices()
    expect(offered(choices)).toEqual([
      ['Auto buckets', false], ['1-minute buckets', true], ['5-minute buckets', false], ['1-hour buckets', false], ['1-day buckets', false],
    ])
    expect(choices[1]).toHaveAccessibleDescription('Too many buckets for this window: choose fewer metrics or a shorter window.')
    const reads = api.readCarriedTelemetry.mock.calls.length
    fireEvent.click(choices[1])
    expect(new URLSearchParams(window.location.search).get('bucket')).toBeNull()
    expect(api.readCarriedTelemetry).toHaveBeenCalledTimes(reads)
  })

  it('reads a link that asks for too fine a size at Auto, and says so', async () => {
    await visit(`/history/device/${LATHE}?${THREE_DAYS}&bucket=1m`)
    expect(await screen.findByText('2 metrics, in 5-minute buckets: 1-minute buckets are too many for this window')).toBeInTheDocument()
    expect(lastRead()).toMatchObject({ bucketMinutes: 5 })
  })

  it('counts and clears the window, the metrics and the buckets, and keeps the device', async () => {
    await visit(`/history/device/${LATHE}?range=7d&metric=Spindle/LOAD&bucket=1h`)
    const clear = await screen.findByRole('button', { name: /Clear filters \(3\)/ })
    fireEvent.click(clear)
    await waitFor(() => expect(window.location.pathname + window.location.search).toBe(`/history/device/${LATHE}`))
    expect(screen.queryByRole('button', { name: /Clear filters/ })).not.toBeInTheDocument()
    await waitFor(() => expect(lastRead()).toMatchObject({ bucketMinutes: 1, metricNames: ['Spindle/LOAD', 'Spindle/SPEED'] }))
  })
})

describe("a chart's head", () => {
  it('shows the latest reading while the pointer is elsewhere, from the newest bucket that was not carried', async () => {
    await visit(`/history/device/${LATHE}`)
    await screen.findAllByRole('figure')
    const width = 60000
    const first = Math.floor(Date.parse(api.readCarriedTelemetry.mock.calls[0][0].from) / width) * width
    const head = within(screen.getByRole('figure', { name: 'Spindle/LOAD (kW)' })).getByText(/^Latest /)
    // Bucket 2 carried the value; bucket 1 is the newest a reading arrived in, and its last value is 41.
    expect(head).toHaveTextContent(`Latest 41 kW · ${momentWords(first + width, 1)}`)
  })

  it('reads the bucket under the pointer instead, and the latest again once it leaves', async () => {
    await visit(`/history/device/${LATHE}`)
    await waitFor(() => expect(plots).toHaveLength(2))
    const figure = screen.getByRole('figure', { name: 'Spindle/LOAD (kW)' })
    const { opts, data } = plots[0]
    act(() => { opts.hooks.setCursor[0]({ cursor: { idx: 0 } }) })
    expect(figure.querySelector('.history-chart-hover')).toHaveTextContent(`${momentWords(data[0][0] * 1000, 1)} · 40 kW (39 to 45 kW)`)
    act(() => { opts.hooks.setCursor[0]({ cursor: { idx: null } }) })
    expect(figure.querySelector('.history-chart-hover')).toHaveTextContent(/^Latest 41 kW · /)
  })
})

describe('a state chart', () => {
  const open = async () => {
    await visit(`/history/device/${ROBOT}?range=1h`)
    return screen.findByRole('figure', { name: 'Controller/EXECUTION' })
  }

  it("draws on the number charts' time scale: the same gutters as their plot area", async () => {
    const figure = await open()
    await waitFor(() => expect(plots.length).toBeGreaterThan(0))
    // Every chart's plot area starts after the value axis and stops short of the last time label.
    for (const { opts } of plots) {
      expect(opts.axes[1].size).toBe(PLOT_LEFT_PX)
      expect(opts.padding[1]).toBe(PLOT_RIGHT_PX)
    }
    // The strip has no axis of its own, so it takes the same margins, and one time is at one place.
    const box = figure.querySelector('.chart-box-states')
    expect(box.style.marginLeft).toBe(`${PLOT_LEFT_PX}px`)
    expect(box.style.marginRight).toBe(`${PLOT_RIGHT_PX}px`)
  })

  it('colours each value by the hue its text hashes to, the same wherever it appears, and keeps its name', async () => {
    const figure = await open()
    const runs = [...figure.querySelectorAll('.chart-state')]
    const hue = (el) => el.style.getPropertyValue('--state-hue')
    expect(runs.map(r => [r.textContent, hue(r)])).toEqual([
      ['RUNNING', String(stateHue('RUNNING'))], ['IDLE', String(stateHue('IDLE'))], ['RUNNING', String(stateHue('RUNNING'))],
    ])
    const key = [...figure.querySelectorAll('.chart-state-key-value')]
    expect(key.map(li => hue(li))).toEqual([String(stateHue('RUNNING')), String(stateHue('IDLE'))])
  })

  it('hatches each stretch that was carried forward', async () => {
    const figure = await open()
    const [first] = figure.querySelectorAll('.chart-state')
    const held = first.querySelectorAll('.chart-state-carried')
    expect(held).toHaveLength(1)
    // Bucket 0 was read; buckets 1 to 29 carried it.
    expect(parseFloat(held[0].style.left)).toBeGreaterThan(0)
    expect(parseFloat(held[0].style.left) + parseFloat(held[0].style.width)).toBeCloseTo(100, 5)
  })

  it("keys each value with its share of the charted time, and the hatching", async () => {
    const figure = await open()
    const key = figure.querySelector('.chart-state-key')
    const items = [...key.querySelectorAll('li')].map(li => li.textContent)
    expect(items[0]).toMatch(/^RUNNING\d+%$/)
    expect(items[1]).toMatch(/^IDLE\d+%$/)
    expect(items[2]).toBe('carried forward')
    const share = (text) => Number(text.match(/(\d+)%$/)[1])
    expect(share(items[0]) + share(items[1])).toBeGreaterThanOrEqual(99)
    expect(share(items[0])).toBeGreaterThan(share(items[1]))
  })

  it('reads the run under the pointer in the head, saying how much of it was carried', async () => {
    const figure = await open()
    const box = figure.querySelector('.chart-box-states')
    box.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 34, right: 600, bottom: 34 })
    const [, idle] = figure.querySelectorAll('.chart-state')
    const x = (parseFloat(idle.style.left) + parseFloat(idle.style.width) / 2) * 6
    fireEvent.pointerMove(box, { clientX: x })
    expect(figure.querySelector('.history-chart-hover')).toHaveTextContent(/ · IDLE, 15 min, 14 min carried forward$/)
    fireEvent.pointerLeave(box)
    expect(figure.querySelector('.history-chart-hover')).toHaveTextContent(/^Latest RUNNING · /)
  })

  it("gives a screen reader each value's share", async () => {
    await open()
    const img = screen.getByRole('img', { name: 'Controller/EXECUTION' })
    expect(img).toHaveAccessibleDescription(/Time in each value: RUNNING \d+%, IDLE \d+%\./)
  })
})

describe('exporting the readings shown', () => {
  const exportButton = () => screen.getByRole('button', { name: /Export CSV/ })
  const csvReads = () => api.get.mock.calls.map(c => c[0]).filter(p => p.startsWith('/api/v1/telemetry?'))

  it('sits after Clear filters and before the refresh control, as the Audit Trail places its Export CSV', async () => {
    await visit(`/history/device/${LATHE}?range=7d`)
    const actions = document.querySelector('.filter-bar-actions')
    const order = [...actions.querySelectorAll('button, [role="group"]')]
      .filter(el => !el.closest('[role="group"]') || el.getAttribute('role') === 'group')
      .map(el => el.getAttribute('aria-label') || el.textContent.trim())
    expect(order).toEqual(['✕ Clear filters (1)', 'Export CSV', 'Refresh'])
    expect(exportButton()).toHaveClass('btn-primary')
  })

  it('exports this device, the metrics chosen and the window, at the bounds it has as it opens', async () => {
    await visit(`/history/device/${LATHE}?metric=Spindle/SPEED`)
    await screen.findAllByRole('figure')
    const before = Date.now()
    fireEvent.click(exportButton())
    const dialog = await screen.findByRole('dialog', { name: /Export readings/ })
    expect(within(dialog).getByText(/^Lathe 3 · 1 metric · Last 24 hours \(.+ – .+\)$/)).toBeInTheDocument()
    expect(within(dialog).getByText('Spindle/SPEED')).toBeInTheDocument()
    expect(within(dialog).queryByText('Spindle/LOAD')).toBeNull()

    fireEvent.click(within(dialog).getByRole('button', { name: /^Export CSV$/ }))
    await waitFor(() => expect(csvReads()).toHaveLength(1))
    const query = new URL(csvReads()[0], 'http://x').searchParams
    expect(query.get('asset_id')).toBe(LATHE)
    expect(query.get('metric_name')).toBe('Spindle/SPEED')
    const from = Date.parse(query.get('from'))
    const to = Date.parse(query.get('to'))
    expect(to - from).toBe(24 * 60 * 60 * 1000)
    expect(to).toBeGreaterThanOrEqual(before)
    expect(to).toBeLessThanOrEqual(Date.now())
  })

  it('exports raw readings by default, never a bucket average in their place', async () => {
    await visit(`/history/device/${LATHE}?bucket=1h`)
    await screen.findAllByRole('figure')
    fireEvent.click(exportButton())
    const dialog = await screen.findByRole('dialog', { name: /Export readings/ })
    expect(within(dialog).getByRole('button', { name: /Raw samples/ })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(within(dialog).getByRole('button', { name: /^Export CSV$/ }))
    await waitFor(() => expect(csvReads()).toHaveLength(2))
    expect(csvReads().every(p => !new URL(p, 'http://x').searchParams.has('resolution'))).toBe(true)
  })

  it('exports a past window to its own bounds', async () => {
    await visit(`/history/device/${LATHE}?span=day&at=2026-11-02&metric=Spindle/LOAD`)
    await screen.findAllByRole('figure')
    fireEvent.click(exportButton())
    const dialog = await screen.findByRole('dialog', { name: /Export readings/ })
    fireEvent.click(within(dialog).getByRole('button', { name: /^Export CSV$/ }))
    await waitFor(() => expect(csvReads()).toHaveLength(1))
    const query = new URL(csvReads()[0], 'http://x').searchParams
    expect(query.get('from')).toBe(new Date(2026, 10, 2).toISOString())
    expect(query.get('to')).toBe(new Date(2026, 10, 3).toISOString())
  })

  it('is offered but off without telemetry:read, saying who may', async () => {
    await visit(`/history/device/${LATHE}`, { hasPermission: (p) => p !== PERMISSION_UUIDS.TELEMETRY_READ })
    await screen.findAllByRole('figure')
    expect(exportButton()).toBeDisabled()
    expect(exportButton()).toHaveAccessibleDescription(/^Exporting readings needs telemetry access\. Requires /)
    fireEvent.click(exportButton())
    expect(screen.queryByRole('dialog', { name: /Export readings/ })).toBeNull()
  })

  it('is off for a device with no metric', async () => {
    await visit(`/history/device/${PRESS}`)
    await screen.findByText(/declared no metrics/)
    expect(exportButton()).toBeDisabled()
    expect(exportButton()).toHaveAccessibleDescription('This device has no metric to export.')
  })
})

describe("a text chart's buckets under Auto", () => {
  const readsOf = () => api.readCarriedTelemetry.mock.calls.map(([a]) => [a.metricNames, a.bucketMinutes])
  let originalWidth
  beforeEach(() => { originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth') })
  afterEach(() => {
    if (originalWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalWidth)
    delete window.ResizeObserver
  })
  /** Every chart box `px` wide, and the page 32 px wider, as its insets make it. */
  const widthIs = (px) => Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() { return this.classList?.contains('chart-box') ? px : this.classList?.contains('history-body') ? px + 32 : 0 },
  })

  it('reads text apart, in buckets each at least 3 px wide, and says so', async () => {
    await visit(`/history/device/${ROBOT}`)
    expect(await screen.findByText('2 metrics, in 1-minute buckets; text in 5-minute buckets')).toBeInTheDocument()
    // 960 px across a day: 288 five-minute buckets are 3.3 px; 1,440 one-minute ones would be 0.7.
    expect(readsOf()).toEqual([[['Arm/TORQUE'], 1], [['Controller/EXECUTION'], 5]])
    expect(screen.getByRole('img', { name: 'Controller/EXECUTION' })).toHaveAccessibleDescription(/, in 5-minute buckets\./)
    expect(screen.getByRole('img', { name: 'Arm/TORQUE (N·m)' })).toHaveAccessibleDescription(/, in 1-minute buckets\./)
  })

  it('measures the page: a narrower one gives text wider buckets', async () => {
    widthIs(150)
    await visit(`/history/device/${ROBOT}?range=1h`)
    expect(await screen.findByText('2 metrics, in 1-minute buckets; text in 5-minute buckets')).toBeInTheDocument()
    expect(readsOf()).toEqual([[['Arm/TORQUE'], 1], [['Controller/EXECUTION'], 5]])
  })

  it('reads text again once a change of width settles, and not on each resize, nor on one that changes nothing', async () => {
    const watchers = []
    window.ResizeObserver = class { constructor(cb) { this.cb = cb; watchers.push(this) } observe() {} disconnect() {} }
    widthIs(960)
    await visit(`/history/device/${ROBOT}?range=1h`)
    await screen.findByText('2 metrics, in 1-minute buckets')
    const before = api.readCarriedTelemetry.mock.calls.length
    const page = watchers.find(w => w.cb)
    // The same width settles: the buckets stay, so nothing is read.
    act(() => { watchers.forEach(w => w.cb([])) })
    await new Promise(r => setTimeout(r, 400))
    expect(api.readCarriedTelemetry).toHaveBeenCalledTimes(before)
    // Narrower, in three steps: one read, of the text, at 5 minutes, once the steps settle.
    widthIs(150)
    act(() => { page.cb([]); page.cb([]); watchers.forEach(w => w.cb([])) })
    expect(api.readCarriedTelemetry).toHaveBeenCalledTimes(before)
    await waitFor(() => expect(screen.getByText('2 metrics, in 1-minute buckets; text in 5-minute buckets')).toBeInTheDocument())
    expect(readsOf().slice(before)).toEqual([[['Arm/TORQUE'], 1], [['Controller/EXECUTION'], 5]])
  })

  it('reads every chart at a Buckets choice, text included', async () => {
    await visit(`/history/device/${ROBOT}?bucket=5m`)
    expect(await screen.findByText('2 metrics, in 5-minute buckets')).toBeInTheDocument()
    expect(readsOf()).toEqual([[['Arm/TORQUE', 'Controller/EXECUTION'], 5]])
  })

  it('reads a metric the catalog does not know as before, with the numbers', async () => {
    await visit(`/history/device/${LATHE}`)
    await screen.findByText('2 metrics, in 1-minute buckets')
    expect(readsOf()).toEqual([[['Spindle/LOAD', 'Spindle/SPEED'], 1]])
  })
})

describe("the charts' groups", () => {
  const CELL = '2b3e0c4a-6666-4000-8000-000000000006'
  const cellDevice = {
    asset_id: CELL, asset_name: 'Cell 6 robot',
    last_birth_metrics: ['Arm/TORQUE', 'Axis/COUNT', 'Controller/EXECUTION', 'Door/OPEN', 'Misc/THING'],
  }
  const groupCatalog = [
    { name: 'Arm/TORQUE', datatype: 10 }, { name: 'Axis/COUNT', datatype: 3 },
    { name: 'Controller/EXECUTION', datatype: 12 }, { name: 'Door/OPEN', datatype: 11 },
  ]
  beforeEach(() => {
    api.get.mockImplementation((path) => {
      if (path.startsWith('/api/v1/devices')) return Promise.resolve([cellDevice])
      if (path.startsWith('/api/v1/metric-catalog')) return Promise.resolve(groupCatalog)
      return Promise.resolve([])
    })
  })
  afterEach(() => { window.localStorage.removeItem(CLOSED_GROUPS_KEY) })

  /** A group's heading, named "String, 1 chart": its label, then its count as a screen reader hears it. */
  const heading = (label) => screen.getByRole('button', {
    name: (name) => name.startsWith(`${label}, `) && /^\d+ charts?$/.test(name.slice(label.length + 2)),
  })
  const groupNames = () => [...document.querySelectorAll('.history-group')].map(g => g.getAttribute('aria-label'))
  const chartsIn = (name) => [...document.querySelector(`.history-group[aria-label="${name}"]`).querySelectorAll('figure')]
    .map(f => f.getAttribute('aria-labelledby') && f.querySelector('.history-chart-title').textContent)

  it('groups the charts by datatype, as the Metrics page names it, numbers first and Other last, each with its count', async () => {
    await visit(`/history/device/${CELL}`)
    await screen.findAllByRole('figure')
    expect(groupNames()).toEqual(['Double', 'Int32', 'Boolean', 'String', 'Other'])
    expect(chartsIn('Double')).toEqual(['Arm/TORQUE'])
    expect(chartsIn('Other')).toEqual(['Misc/THING'])
    expect(heading('Double')).toHaveAttribute('aria-expanded', 'true')
    expect(heading('Double')).toHaveTextContent('Double· 1')
  })

  it('closes a group from its heading, hiding its charts and nothing else, and keeps it closed in this browser', async () => {
    await visit(`/history/device/${CELL}`)
    await screen.findAllByRole('figure')
    const reads = api.readCarriedTelemetry.mock.calls.length
    const address = window.location.pathname + window.location.search
    fireEvent.click(heading('String'))
    expect(heading('String')).toHaveAttribute('aria-expanded', 'false')
    expect(chartsIn('String')).toEqual([])
    expect(screen.getAllByRole('figure')).toHaveLength(4)
    // Closing a group is not a filter: the line still counts every metric.
    expect(screen.getByText('5 metrics, in 5-minute buckets; text in 1-hour buckets')).toBeInTheDocument()
    expect(api.readCarriedTelemetry).toHaveBeenCalledTimes(reads)
    expect(window.location.pathname + window.location.search).toBe(address)
    expect(JSON.parse(window.localStorage.getItem(CLOSED_GROUPS_KEY))).toEqual(['12'])

    cleanup()
    await visit(`/history/device/${CELL}`)
    await screen.findAllByRole('figure')
    expect(heading('String')).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(heading('String'))
    expect(chartsIn('String')).toEqual(['Controller/EXECUTION'])
    expect(window.localStorage.getItem(CLOSED_GROUPS_KEY)).toBeNull()
  })

  it("leaves no space under a closed group: its charts' box is hidden, and the stylesheet lets it be", async () => {
    await visit(`/history/device/${CELL}`)
    await screen.findAllByRole('figure')
    fireEvent.click(screen.getByRole('button', { name: /^String/ }))
    const body = document.getElementById(screen.getByRole('button', { name: /^String/ }).getAttribute('aria-controls'))
    expect(body).toHaveAttribute('hidden')
    // jsdom applies no stylesheet: `.history-charts` is display: flex, which outranks [hidden] unless
    // App.css says otherwise.
    const css = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8')
    expect(css).toMatch(/\.history-charts\[hidden\] \{ display: none; \}/)
  })

  it('opens and closes every group from Collapse all and Expand all', async () => {
    await visit(`/history/device/${CELL}`)
    await screen.findAllByRole('figure')
    // At the start of the row above the charts, as on the Audit Trail, and not in the toolbar.
    const toggle = screen.getByRole('button', { name: /Collapse all/ })
    expect(document.querySelector('.history-header').firstElementChild).toContainElement(toggle)
    expect(document.querySelector('.filter-bar')).not.toContainElement(toggle)
    fireEvent.click(toggle)
    expect(screen.queryAllByRole('figure')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: /Expand all/ }))
    expect(screen.getAllByRole('figure')).toHaveLength(5)
  })

  it('goes on with every group open where this browser refuses storage', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    await visit(`/history/device/${CELL}`)
    await screen.findAllByRole('figure')
    expect(groupNames()).toHaveLength(5)
    fireEvent.click(heading('Boolean'))
    expect(heading('Boolean')).toHaveAttribute('aria-expanded', 'false')
    getItem.mockRestore()
    setItem.mockRestore()
  })

  it('lists the Metrics filter under the same groups', async () => {
    await visit(`/history/device/${CELL}`)
    await screen.findAllByRole('figure')
    fireEvent.click(screen.getByRole('button', { name: /^Metrics: / }))
    const panel = await screen.findByRole('dialog', { name: 'Metrics' })
    const sections = [...panel.querySelectorAll('.filter-checklist-section')]
      .map(sec => [sec.querySelector('.filter-checklist-group').textContent, [...sec.querySelectorAll('.filter-checklist-option')].map(o => o.textContent)])
    expect(sections).toEqual([
      ['Double', ['Arm/TORQUE']], ['Int32', ['Axis/COUNT']], ['Boolean', ['Door/OPEN']],
      ['String', ['Controller/EXECUTION']], ['Other', ['Misc/THING']],
    ])
  })
})
