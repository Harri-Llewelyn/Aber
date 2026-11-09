/**
 * The History page's Cell tab: the cell picker, one metric across the machines of a cell as small
 * multiples on one scale, the resolution the row cap picks for them, a text metric's strips, and
 * the hour-of-day heatmap. uPlot draws on a canvas jsdom does not have, so a stand-in records what
 * each chart was built with.
 */
import React from 'react'
import { render, screen, waitFor, within, fireEvent, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HistoryTab } from '../components/tabs/HistoryTab'
import { api } from '../api'
import { telemetryKey } from '../utils/history'

const { plots, polls } = vi.hoisted(() => ({ plots: [], polls: [] }))

vi.mock('../hooks/usePolling', () => ({
  usePolling: (callback, intervalMs, enabled) => { polls.push({ callback, intervalMs, enabled }) },
}))

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
  return {
    ...actual,
    api: {
      get: vi.fn(), readCarriedTelemetry: vi.fn(), readTelemetryChanges: vi.fn(), readHourOfDay: vi.fn(), readAlertOccurrences: vi.fn(),
    },
  }
})

const id = (n) => `2b3e0c4a-${n}${n}${n}${n}-4000-8000-00000000000${n}`
const LATHE3 = id(1)
const LATHE4 = id(2)
const MILL = id(3)
const PRESS = id(4)
const ROBOT = id(5)
const WELD = id(6)
const inCell = { location_source: 'inherited', status: 'ONLINE' }
const devices = [
  { asset_id: LATHE3, asset_name: 'Lathe 3', effective_cell_id: 'c1', last_birth_metrics: ['Spindle/LOAD', 'Spindle/SPEED'], ...inCell },
  { asset_id: LATHE4, asset_name: 'Lathe 4', effective_cell_id: 'c1', last_birth_metrics: ['Spindle/LOAD'], ...inCell },
  { asset_id: MILL, asset_name: 'Mill 2', effective_cell_id: 'c1', last_birth_metrics: ['Spindle/LOAD', 'Coolant/TEMP'], ...inCell, status: 'OFFLINE' },
  { asset_id: PRESS, asset_name: 'Press 1', effective_cell_id: 'c1', last_birth_metrics: [], ...inCell },
  { asset_id: ROBOT, asset_name: 'Robot 5', effective_cell_id: 'c1', last_birth_metrics: ['Controller/EXECUTION'], ...inCell },
  { asset_id: WELD, asset_name: 'Weld bot', effective_cell_id: 'c2', last_birth_metrics: ['Weld/CURRENT'], ...inCell },
]
const cells = [
  { cell_id: 'c1', cell_name: 'Turning', area_id: 'a1' },
  { cell_id: 'c2', cell_name: 'Welding', area_id: 'a1' },
  { cell_id: 'c3', cell_name: 'Empty cell', area_id: null },
]
const areas = [{ area_id: 'a1', area_name: 'Hall B' }]
const catalog = [
  { name: 'Spindle/LOAD', units: 'kW', datatype: 10 }, { name: 'Spindle/SPEED', units: 'rpm', datatype: 10 },
  { name: 'Coolant/TEMP', units: '°C', datatype: 10 }, { name: 'Controller/EXECUTION', datatype: 12 },
  { name: 'Weld/CURRENT', units: 'A', datatype: 10 },
]

const routeGet = (path) => {
  if (path.startsWith('/api/v1/devices')) return Promise.resolve(devices)
  if (path.startsWith('/api/v1/cells')) return Promise.resolve(cells)
  if (path.startsWith('/api/v1/areas')) return Promise.resolve(areas)
  if (path.startsWith('/api/v1/schemas')) return Promise.resolve([])
  if (path.startsWith('/api/v1/metric-catalog')) return Promise.resolve(catalog)
  return Promise.resolve([])
}

/** Each machine's level, so a scale shared across them shows in the plots' data. */
const LEVEL = { [telemetryKey({ asset_id: LATHE3 })]: 40, [telemetryKey({ asset_id: LATHE4 })]: 20, [telemetryKey({ asset_id: MILL })]: 80 }

/** Three buckets for each machine asked for: its level, and a minimum and a maximum a degree either side. */
const carried = ({ from, bucketMinutes, assetIds, metricNames }) => {
  const width = bucketMinutes * 60000
  const first = Math.floor(Date.parse(from) / width) * width
  return Promise.resolve(assetIds.flatMap(asset => [0, 1, 2].map(i => {
    const level = (LEVEL[asset] ?? 50) + i
    return {
      bucket_ts: new Date(first + i * width).toISOString(), asset_id: asset, metric_name: metricNames[0],
      avg_double: level, min_double: level - 1, max_double: level + 1, last_double: level, last_string: null, last_bool: null,
      n_rows: i === 2 ? 0 : 4, is_carried: i === 2,
    }
  })))
}

/** A mean at each hour, the machine's level plus the hour, for each machine asked for. */
const hours = ({ assetIds }) => Promise.resolve(assetIds.flatMap(asset => Array.from({ length: 24 }, (_, h) => ({
  asset_id: asset, hour_of_day: h, mean_value: (LEVEL[asset] ?? 50) + h, days: 7,
}))))

const visit = async (address) => {
  window.history.pushState({}, '', address)
  render(<HistoryTab hasPermission={() => true} showToast={vi.fn()} />)
  await waitFor(() => expect(screen.queryByText(/Loading devices/)).not.toBeInTheDocument())
}

const heatmap = () => screen.getByRole('grid', { name: /the mean at each hour of the day/ })
const rowsOf = (grid) => within(grid).getAllByRole('row')

beforeEach(() => {
  vi.clearAllMocks()
  plots.length = 0
  polls.length = 0
  api.get.mockImplementation(routeGet)
  api.readCarriedTelemetry.mockImplementation(carried)
  api.readTelemetryChanges.mockResolvedValue([])
  api.readHourOfDay.mockImplementation(hours)
  api.readAlertOccurrences.mockResolvedValue([])
  document.documentElement.setAttribute('data-theme', 'dark')
  document.documentElement.style.setProperty('--accent', '#00d4ff')
})

afterEach(() => {
  cleanup()
  document.documentElement.style.removeProperty('--accent')
  window.history.pushState({}, '', '/')
})

describe('the Cell tab and its address', () => {
  it('is a tab after Device, with a path of its own, and picks a cell at /history/cell', async () => {
    await visit('/history/cell?range=7d')
    const tabs = within(screen.getByRole('navigation', { name: 'History' })).getAllByRole('link')
    expect(tabs.map(t => t.textContent)).toEqual(['Overview', 'Device', 'Cell', 'Alerts'])
    expect(tabs[2]).toHaveAttribute('aria-current', 'page')
    expect(tabs[2]).toHaveAttribute('href', '/history/cell')
    const table = screen.getByRole('table', { name: /choose a cell/i })
    const links = within(table).getAllByRole('link')
    expect(links.map(l => l.textContent)).toEqual(['Empty cell', 'Turning', 'Welding'])
    expect(links[1]).toHaveAttribute('href', '/history/cell/c1?range=7d')
    expect(within(table).getAllByText('Hall B')).toHaveLength(2)
    expect(api.readCarriedTelemetry).not.toHaveBeenCalled()
  })

  it('opens a cell from its link, keeping the window', async () => {
    await visit('/history/cell?span=week&at=2026-11-02')
    fireEvent.click(screen.getByRole('link', { name: 'Turning' }))
    expect(window.location.pathname).toBe('/history/cell/c1')
    expect(window.location.search).toBe('?span=week&at=2026-11-02')
  })

  it('is reached from the tab bar, starting afresh at its picker', async () => {
    await visit('/history/device?range=7d')
    fireEvent.click(screen.getByRole('link', { name: 'Cell' }))
    expect(window.location.pathname + window.location.search).toBe('/history/cell')
  })

  it('says when no cell answers to the address', async () => {
    await visit('/history/cell/no-such-cell')
    expect(screen.getByText(/No cell answers to this address/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Choose another cell' })).toHaveAttribute('href', '/history/cell')
    expect(api.readCarriedTelemetry).not.toHaveBeenCalled()
  })

  it('says when a cell has no machine in service, and reads nothing', async () => {
    await visit('/history/cell/c3')
    expect(await screen.findByText(/No device is in service in this cell/)).toBeInTheDocument()
    expect(api.readCarriedTelemetry).not.toHaveBeenCalled()
    expect(api.readHourOfDay).not.toHaveBeenCalled()
  })

  it('does not list the cell, as a table of devices and their status: it opens on charts', async () => {
    await visit('/history/cell/c1')
    await waitFor(() => expect(plots.length).toBeGreaterThan(0))
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})

describe('the metric', () => {
  it('opens on the metric most of the cell reports, and says what it is in the toolbar', async () => {
    await visit('/history/cell/c1')
    expect(await screen.findByRole('button', { name: 'Metric: Spindle/LOAD' })).toBeInTheDocument()
    expect(api.readCarriedTelemetry.mock.calls[0][0].metricNames).toEqual(['Spindle/LOAD'])
  })

  it('takes the metric in the address, and lists each metric with how many machines report it', async () => {
    await visit('/history/cell/c1?metric=Coolant%2FTEMP')
    await waitFor(() => expect(api.readCarriedTelemetry).toHaveBeenCalled())
    expect(api.readCarriedTelemetry.mock.calls[0][0].metricNames).toEqual(['Coolant/TEMP'])
    fireEvent.click(screen.getByRole('button', { name: 'Metric: Coolant/TEMP' }))
    const list = within(await screen.findByRole('dialog', { name: 'Choose a metric' })).getAllByRole('link')
    expect(list.map(l => l.textContent)).toEqual([
      'Controller/EXECUTION1 of 5 machines', 'Coolant/TEMP1 of 5 machines', 'Spindle/LOAD3 of 5 machines', 'Spindle/SPEED1 of 5 machines',
    ])
    expect(list[2]).toHaveAttribute('href', '/history/cell/c1?metric=Spindle%2FLOAD')
  })

  it('reads a metric the cell does not report as the one it opens on, and tidies the address', async () => {
    await visit('/history/cell/c1?metric=Weld%2FCURRENT')
    await waitFor(() => expect(api.readCarriedTelemetry).toHaveBeenCalled())
    expect(api.readCarriedTelemetry.mock.calls[0][0].metricNames).toEqual(['Spindle/LOAD'])
    await waitFor(() => expect(window.location.search).toBe(''))
  })

  it('lists the cells to compare instead, at the same window and metric', async () => {
    await visit('/history/cell/c1?metric=Spindle%2FLOAD&range=7d')
    await waitFor(() => expect(api.readCarriedTelemetry).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Cell: Turning' }))
    const options = within(await screen.findByRole('dialog', { name: 'Choose a cell' })).getAllByRole('link')
    expect(options.map(o => o.textContent)).toEqual(['Empty cell0 machines', 'TurningHall B · 5 machines', 'WeldingHall B · 1 machine'])
    expect(options[2]).toHaveAttribute('href', '/history/cell/c2?range=7d&metric=Spindle%2FLOAD')
  })
})

describe('the machines compared', () => {
  it('reads every machine that reports the metric in one call, at the finest resolution the row cap allows, and says which', async () => {
    await visit('/history/cell/c1')
    await waitFor(() => expect(api.readCarriedTelemetry).toHaveBeenCalledTimes(1))
    const [args] = api.readCarriedTelemetry.mock.calls[0]
    // Three machines over Last 24 hours: 1,441 one-minute buckets each is 4,323 rows, under 5,000.
    expect(args).toMatchObject({ bucketMinutes: 1, metricNames: ['Spindle/LOAD'] })
    expect([...args.assetIds].sort()).toEqual([LATHE3, LATHE4, MILL].map(d => telemetryKey({ asset_id: d })).sort())
    expect(Date.parse(args.to) - Date.parse(args.from)).toBe(24 * 60 * 60 * 1000)
    expect(await screen.findByText('3 machines, in 1-minute buckets, 2 do not report it')).toBeInTheDocument()
  })

  it('takes a coarser resolution when the machines would pass the cap, and names it', async () => {
    await visit('/history/cell/c1?range=7d')
    // A week of five-minute buckets is 2,017, so three machines are 6,051 rows: an hour.
    await waitFor(() => expect(api.readCarriedTelemetry).toHaveBeenCalledTimes(1))
    expect(api.readCarriedTelemetry.mock.calls[0][0].bucketMinutes).toBe(60)
    expect(await screen.findByText('3 machines, in 1-hour buckets, 2 do not report it')).toBeInTheDocument()
  })

  it('draws a chart a machine, named by the machine, each with a summary a screen reader is given', async () => {
    await visit('/history/cell/c1')
    await waitFor(() => expect(plots).toHaveLength(3))
    const figures = screen.getAllByRole('figure')
    expect(figures.map(f => f.getAttribute('aria-label'))).toEqual(['Lathe 3', 'Lathe 4', 'Mill 2'])
    expect(screen.getByRole('img', { name: 'Lathe 4' }).getAttribute('aria-describedby')).toBeTruthy()
    expect(document.getElementById(screen.getByRole('img', { name: 'Lathe 4' }).getAttribute('aria-describedby')).textContent)
      .toMatch(/^Lathe 4\. Spindle\/LOAD \(kW\), Last 24 hours, in 1-minute buckets\. Latest 21 kW/)
  })

  it('labels each chart with its machine, a link to its charts, with its status dot, and says Offline in words', async () => {
    await visit('/history/cell/c1')
    await waitFor(() => expect(plots).toHaveLength(3))
    const lathe = within(screen.getByRole('figure', { name: 'Lathe 3' }))
    expect(lathe.getByRole('link', { name: 'Lathe 3' })).toHaveAttribute('href', `/history/device/${LATHE3}?metric=Spindle%2FLOAD`)
    expect(lathe.getByText('Online')).toBeInTheDocument()
    expect(lathe.queryByText('Offline')).not.toBeInTheDocument()
    const mill = within(screen.getByRole('figure', { name: 'Mill 2' }))
    expect(mill.getByText('Offline')).toBeInTheDocument()
    expect(mill.queryByText('Online')).not.toBeInTheDocument()
    // A dot for each of the five machines, the two that draw no chart included.
    expect(document.querySelectorAll('.multiples .device-status-dot .badge-dot')).toHaveLength(5)
  })

  it('draws every chart on one value scale, from the lowest minimum to the highest maximum of them all', async () => {
    await visit('/history/cell/c1')
    await waitFor(() => expect(plots).toHaveLength(3))
    // Levels 20 (Lathe 4) to 82 (Mill 2, the last bucket), a degree wider each side: 19 to 83, padded by 8% of 64.
    const ranges = plots.map(p => p.opts.scales.y.range)
    for (const range of ranges) expect(range).toEqual(ranges[0])
    expect(ranges[0][0]).toBeCloseTo(19 - 64 * 0.08)
    expect(ranges[0][1]).toBeCloseTo(83 + 64 * 0.08)
    expect(screen.getByText('One scale for every machine: 13.88 to 88.12 kW.')).toBeInTheDocument()
  })

  it('shares one pointer and one time axis across the charts, and leaves uPlot\'s own zoom off', async () => {
    await visit('/history/cell/c1')
    await waitFor(() => expect(plots).toHaveLength(3))
    for (const { opts } of plots) {
      expect(opts.cursor.sync).toEqual({ key: 'history-cell-c1' })
      expect(opts.cursor.drag).toEqual({ x: false, y: false, setScale: false })
      expect(opts.scales.x.range).toEqual(plots[0].opts.scales.x.range)
    }
  })

  it('says in words that a machine does not report the metric, and draws no chart for it', async () => {
    await visit('/history/cell/c1?metric=Spindle%2FSPEED')
    const multiples = await waitFor(() => {
      const found = document.querySelector('.multiples')
      expect(found).toBeTruthy()
      return within(found)
    })
    expect(multiples.getByText('Lathe 4 does not report Spindle/SPEED.')).toBeInTheDocument()
    expect(multiples.getByText('Mill 2 does not report Spindle/SPEED.')).toBeInTheDocument()
    expect(multiples.getByText('Press 1 does not report Spindle/SPEED.')).toBeInTheDocument()
    await waitFor(() => expect(plots).toHaveLength(1))
    expect(screen.getAllByRole('figure')).toHaveLength(1)
    expect(screen.getAllByRole('figure')[0]).toHaveAttribute('aria-label', 'Lathe 3')
    // One machine alone has no other to share a scale with, so none is said.
    expect(screen.queryByText(/One scale for every machine/)).not.toBeInTheDocument()
  })

  it('reads again on Refresh, and by the refresh timer, both reads at once', async () => {
    await visit('/history/cell/c1')
    await waitFor(() => expect(api.readHourOfDay).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: /^Refresh$/ }))
    await waitFor(() => expect(api.readCarriedTelemetry).toHaveBeenCalledTimes(2))
    expect(api.readHourOfDay).toHaveBeenCalledTimes(2)
    expect(polls[polls.length - 1].enabled).toBe(false)
  })

  it('refuses a window too long for one machine even in day buckets, and reads nothing', async () => {
    await visit('/history/cell/c1?from=2000-01-01T00:00&to=2026-01-01T00:00')
    expect(await screen.findByText(/This window is too long to chart/)).toBeInTheDocument()
    expect(api.readCarriedTelemetry).not.toHaveBeenCalled()
  })

  it('says what the read refused', async () => {
    api.readCarriedTelemetry.mockRejectedValue(new Error('the historian is out'))
    await visit('/history/cell/c1')
    expect(await screen.findByText('The readings could not be read: the historian is out')).toBeInTheDocument()
  })

  it('closes a section from its heading, and all of them from Collapse all', async () => {
    await visit('/history/cell/c1')
    await waitFor(() => expect(plots).toHaveLength(3))
    await waitFor(() => expect(screen.queryByRole('grid')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /^Over the window/ }))
    expect(screen.queryAllByRole('figure')).toHaveLength(0)
    expect(screen.getByRole('grid')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
    expect(screen.queryByRole('grid')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }))
    expect(screen.getAllByRole('figure')).toHaveLength(3)
    expect(screen.getByRole('grid')).toBeInTheDocument()
  })
})

describe("a text metric's strips", () => {
  const change = (asset) => ({
    asset_id: asset, metric_name: 'Controller/EXECUTION', read: 'changes',
    change_ts: ['2026-11-02T10:00:00Z', '2026-11-02T10:30:00Z'], val_string: ['ACTIVE', 'READY'], val_bool: null,
    carried_string: null, carried_bool: null, n_changes: 2, marked_ts: null, marked_values: null, raw_from: null,
  })

  it('takes the change read for every machine that reports it, and draws strips, not lines', async () => {
    api.readCarriedTelemetry.mockResolvedValue([])
    api.readTelemetryChanges.mockImplementation(({ assetIds }) => Promise.resolve(assetIds.map(change)))
    await visit('/history/cell/c1?metric=Controller%2FEXECUTION&from=2026-11-02T09:00&to=2026-11-02T12:00')
    await waitFor(() => expect(api.readTelemetryChanges).toHaveBeenCalledTimes(1))
    const [args] = api.readTelemetryChanges.mock.calls[0]
    expect(args).toMatchObject({ metricNames: ['Controller/EXECUTION'], assetIds: [telemetryKey({ asset_id: ROBOT })] })
    expect(await screen.findByText('1 machine, in 1-minute buckets, 4 do not report it; text shows every change')).toBeInTheDocument()
    const figure = screen.getByRole('figure', { name: 'Robot 5' })
    // Each state in its box and in the key under the strip.
    expect((await within(figure).findAllByText('ACTIVE')).length).toBeGreaterThan(0)
    expect(within(figure).getAllByText('READY').length).toBeGreaterThan(0)
    expect(plots).toHaveLength(0)
  })

  it('reads no change for a number metric', async () => {
    await visit('/history/cell/c1')
    await waitFor(() => expect(plots).toHaveLength(3))
    expect(api.readTelemetryChanges).not.toHaveBeenCalled()
  })
})

describe('the hour-of-day heatmap', () => {
  it('is a row a machine and a column an hour, 00 to 23, a cell for every hour of every machine that reports it', async () => {
    await visit('/history/cell/c1')
    await waitFor(() => expect(screen.queryByRole('grid')).toBeInTheDocument())
    const grid = heatmap()
    const rows = rowsOf(grid)
    // A header row, then a row for each of the five machines in the cell.
    expect(rows).toHaveLength(6)
    expect(within(rows[0]).getAllByRole('columnheader')).toHaveLength(25)
    expect(within(rows[0]).getByRole('columnheader', { name: '00:00–01:00' })).toBeInTheDocument()
    expect(within(rows[0]).getByRole('columnheader', { name: '23:00–00:00' })).toBeInTheDocument()
    // Each row header's name is its own element, apart from the status dot's words.
    expect(rows.slice(1).map(r => within(r).getByRole('rowheader').querySelector('.heatmap-name').textContent)).toEqual(
      ['Lathe 3', 'Lathe 4', 'Mill 2', 'Press 1', 'Robot 5']
    )
    for (const r of rows.slice(1, 4)) expect(within(r).getAllByRole('gridcell')).toHaveLength(24)
    expect(rows.slice(4).map(r => within(r).getAllByRole('gridcell').length)).toEqual([1, 1])
    expect(within(rows[4]).getByRole('gridcell').textContent).toBe('Press 1 does not report Spindle/LOAD.')
  })

  it('reads the mean at each hour in this browser\'s time zone, across the window, for the machines that report the metric', async () => {
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ timeZone: 'Pacific/Auckland' })
    await visit('/history/cell/c1')
    await waitFor(() => expect(api.readHourOfDay).toHaveBeenCalledTimes(1))
    const [args] = api.readHourOfDay.mock.calls[0]
    expect(args).toMatchObject({ metricName: 'Spindle/LOAD', timeZone: 'Pacific/Auckland' })
    expect([...args.assetIds].sort()).toEqual([LATHE3, LATHE4, MILL].map(d => telemetryKey({ asset_id: d })).sort())
    expect(Date.parse(args.to) - Date.parse(args.from)).toBe(24 * 60 * 60 * 1000)
    expect(await screen.findByText(/in this browser's time zone, Pacific\/Auckland\./)).toBeInTheDocument()
    spy.mockRestore()
  })

  it('has a key in words, each shade named by the values it stands for, and one for no value', async () => {
    await visit('/history/cell/c1')
    await waitFor(() => expect(screen.queryByRole('grid')).toBeInTheDocument())
    const key = within(document.querySelector('.heatmap-key'))
    // Means run from 20 (Lathe 4, 00:00) to 103 (Mill 2, 23:00), in four equal shades.
    expect(key.getByText('No value')).toBeInTheDocument()
    expect(key.getByText('20 to 40.75 kW')).toBeInTheDocument()
    expect(key.getByText('82.25 to 103 kW')).toBeInTheDocument()
    expect(document.querySelectorAll('.heatmap-key .heatmap-swatch')).toHaveLength(5)
  })

  it('colours the busiest machine at the busiest hour in the darkest shade, on one scale across the machines', async () => {
    await visit('/history/cell/c1')
    await waitFor(() => expect(screen.queryByRole('grid')).toBeInTheDocument())
    const cell = (row, hour) => document.querySelector(`[data-cell="${row}-${hour}"]`)
    expect(cell(1, 0).className).toContain('heatmap-step-1')
    expect(cell(2, 23).className).toContain('heatmap-step-4')
    // Lathe 3 at 40 + 20 is nearer the middle than Mill 2's 80 + 0: the same hour differs by machine.
    expect(cell(0, 20).className).toContain('heatmap-step-2')
    expect(cell(2, 0).className).toContain('heatmap-step-3')
  })

  it('reads a cell in words, with its machine, its hour and its value, on the pointer', async () => {
    await visit('/history/cell/c1')
    await waitFor(() => expect(screen.queryByRole('grid')).toBeInTheDocument())
    const readout = document.querySelector('.heatmap-readout')
    expect(readout.textContent).toMatch(/^Point at a cell/)
    fireEvent.pointerEnter(document.querySelector('[data-cell="0-14"]'))
    expect(readout.textContent).toBe('Lathe 3 · 14:00–15:00 · 54 kW, the mean of 7 days')
    fireEvent.pointerLeave(heatmap())
    expect(readout.textContent).toMatch(/^Point at a cell/)
  })

  it('reads a cell in words on keyboard focus, and moves between cells with the arrow keys', async () => {
    await visit('/history/cell/c1')
    await waitFor(() => expect(screen.queryByRole('grid')).toBeInTheDocument())
    const readout = document.querySelector('.heatmap-readout')
    const first = document.querySelector('[data-cell="0-0"]')
    // One cell is in the tab order: the first.
    expect(document.querySelectorAll('.heatmap-cell[tabindex="0"]')).toHaveLength(1)
    expect(first).toHaveAttribute('tabindex', '0')
    fireEvent.focus(first)
    expect(readout.textContent).toBe('Lathe 3 · 00:00–01:00 · 40 kW, the mean of 7 days')
    expect(first).toHaveAttribute('aria-label', 'Lathe 3 · 00:00–01:00 · 40 kW, the mean of 7 days')
    fireEvent.keyDown(first, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(document.querySelector('[data-cell="0-1"]'))
    expect(readout.textContent).toBe('Lathe 3 · 01:00–02:00 · 41 kW, the mean of 7 days')
    fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(document.querySelector('[data-cell="1-1"]'))
    fireEvent.keyDown(document.activeElement, { key: 'End' })
    expect(document.activeElement).toBe(document.querySelector('[data-cell="1-23"]'))
    fireEvent.keyDown(document.activeElement, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(document.querySelector('[data-cell="1-23"]'))
    // A machine that does not report the metric has no cells to land on: down from Mill 2 stops there.
    fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' })
    fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(document.querySelector('[data-cell="2-23"]'))
    expect(document.querySelectorAll('.heatmap-cell[tabindex="0"]')).toHaveLength(1)
    // Up and Home within a row, then Ctrl with Home or End for the grid's first and last cells.
    fireEvent.keyDown(document.activeElement, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(document.querySelector('[data-cell="1-23"]'))
    fireEvent.keyDown(document.activeElement, { key: 'Home' })
    expect(document.activeElement).toBe(document.querySelector('[data-cell="1-0"]'))
    fireEvent.keyDown(document.activeElement, { key: 'End', ctrlKey: true })
    expect(document.activeElement).toBe(document.querySelector('[data-cell="2-23"]'))
    fireEvent.keyDown(document.activeElement, { key: 'Home', ctrlKey: true })
    expect(document.activeElement).toBe(document.querySelector('[data-cell="0-0"]'))
  })

  it('says a text or a flag metric needs a number, and reads none', async () => {
    await visit('/history/cell/c1?metric=Controller%2FEXECUTION')
    expect(await screen.findByText(/The heatmap needs a number\. Controller\/EXECUTION is text or a flag/)).toBeInTheDocument()
    expect(api.readHourOfDay).not.toHaveBeenCalled()
    expect(screen.queryByRole('grid')).not.toBeInTheDocument()
  })

  it('says what window the heatmap allows when the machines times the hours pass what it reads, and charts on', async () => {
    // Three machines over 800 days, 19,200 hours each, is over the 50,000 bound; the charts read day buckets.
    await visit('/history/cell/c1?from=2024-01-01T00:00&to=2026-03-11T00:00')
    expect(await screen.findByText(/The heatmap reads every hour of the window for each machine, so for 3 machines it covers at most 694 days\. Choose a shorter window\./)).toBeInTheDocument()
    expect(api.readHourOfDay).not.toHaveBeenCalled()
    await waitFor(() => expect(api.readCarriedTelemetry).toHaveBeenCalled())
    expect(screen.queryByRole('grid')).not.toBeInTheDocument()
  })

  it('says what its read refused, and the charts go on', async () => {
    api.readHourOfDay.mockRejectedValue(new Error('not a time zone'))
    await visit('/history/cell/c1')
    expect(await screen.findByText('The hours of the day could not be read: not a time zone')).toBeInTheDocument()
    await waitFor(() => expect(plots).toHaveLength(3))
  })

  it('says when no machine has a value in the window', async () => {
    api.readHourOfDay.mockResolvedValue([])
    await visit('/history/cell/c1')
    expect(await screen.findByText('No machine has a value for Spindle/LOAD in this window.')).toBeInTheDocument()
  })
})
