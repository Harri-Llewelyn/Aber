/**
 * The History page's Area tab: the area picker, one metric across the cells of an area as small
 * multiples on one scale, each cell's mean or total, a total withheld where a machine had no value, the
 * resolution the function's bounds allow, a text metric's refusal, and the heatmap with a row a cell.
 * uPlot draws on a canvas jsdom does not have, so a stand-in records what each chart was built with.
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
      get: vi.fn(), readCarriedByGroup: vi.fn(), readCarriedTelemetry: vi.fn(), readTelemetryChanges: vi.fn(), readHourOfDay: vi.fn(),
      readAlertOccurrences: vi.fn(),
    },
  }
})

const id = (n) => `2b3e0c4a-${n}${n}${n}${n}-4000-8000-00000000000${n}`
const LATHE3 = id(1)
const LATHE4 = id(2)
const MILL = id(3)
const ROBOT = id(4)
const PRESS = id(5)
const METER = id(6)
const inCell = (cell) => ({ effective_cell_id: cell, location_source: 'inherited', status: 'ONLINE' })
const devices = [
  { asset_id: LATHE3, asset_name: 'Lathe 3', last_birth_metrics: ['Spindle/LOAD', 'Spindle/SPEED'], ...inCell('c1') },
  { asset_id: LATHE4, asset_name: 'Lathe 4', last_birth_metrics: ['Spindle/LOAD'], ...inCell('c1') },
  { asset_id: MILL, asset_name: 'Mill 2', last_birth_metrics: ['Spindle/LOAD', 'Coolant/TEMP'], ...inCell('c1'), status: 'OFFLINE' },
  { asset_id: ROBOT, asset_name: 'Robot 5', last_birth_metrics: ['Controller/EXECUTION', 'Spindle/LOAD'], ...inCell('c2') },
  { asset_id: PRESS, asset_name: 'Press 1', last_birth_metrics: ['Press/FORCE'], ...inCell('c3') },
  { asset_id: METER, asset_name: 'Area meter', last_birth_metrics: ['Spindle/LOAD'], effective_cell_id: null, location_source: 'area_wide', effective_area_id: 'a1', status: 'ONLINE' },
]
const cells = [
  { cell_id: 'c1', cell_name: 'Turning', area_id: 'a1' },
  { cell_id: 'c2', cell_name: 'Welding', area_id: 'a1' },
  { cell_id: 'c3', cell_name: 'Press line', area_id: 'a1' },
  { cell_id: 'c4', cell_name: 'Quiet cell', area_id: 'a2' },
  { cell_id: 'c5', cell_name: 'Old line', area_id: 'a1', is_archived: true },
]
const areas = [{ area_id: 'a1', area_name: 'Hall B' }, { area_id: 'a2', area_name: 'Hall C' }, { area_id: 'a3', area_name: 'Empty hall' }]
const catalog = [
  { name: 'Spindle/LOAD', units: 'kW', datatype: 10 }, { name: 'Spindle/SPEED', units: 'rpm', datatype: 10 },
  { name: 'Coolant/TEMP', units: '°C', datatype: 10 }, { name: 'Controller/EXECUTION', datatype: 12 },
  { name: 'Press/FORCE', units: 'kN', datatype: 10 },
]

const routeGet = (path) => {
  if (path.startsWith('/api/v1/devices')) return Promise.resolve(devices)
  if (path.startsWith('/api/v1/cells')) return Promise.resolve(cells)
  if (path.startsWith('/api/v1/areas')) return Promise.resolve(areas)
  if (path.startsWith('/api/v1/schemas')) return Promise.resolve([])
  if (path.startsWith('/api/v1/metric-catalog')) return Promise.resolve(catalog)
  return Promise.resolve([])
}

/**
 * Four buckets for each group asked for. Turning's mean climbs from 10, and its total (three machines)
 * is withheld in the third bucket, where one had no value. Welding has one machine, so its total is its mean.
 */
const byGroup = ({ from, bucketMinutes, groupKeys }) => {
  const width = bucketMinutes * 60000
  const first = Math.floor(Date.parse(from) / width) * width
  return Promise.resolve([...new Set(groupKeys)].flatMap(group => [0, 1, 2, 3].map(i => {
    const turning = group === 'c1'
    const partial = turning && i === 2
    return {
      group_key: group, bucket_ts: new Date(first + i * width).toISOString(),
      mean_double: (turning ? 10 : 50) + i, total_double: partial ? null : turning ? 30 + 3 * i : 50 + i,
      members: turning ? 3 : 1, with_value: partial ? 2 : turning ? 3 : 1, measured: i === 3 ? 0 : 1,
    }
  })))
}

/** A mean at each hour, a machine's level plus the hour. */
const LEVEL = { [telemetryKey({ asset_id: LATHE3 })]: 10, [telemetryKey({ asset_id: LATHE4 })]: 30, [telemetryKey({ asset_id: MILL })]: 20, [telemetryKey({ asset_id: ROBOT })]: 60 }
const hours = ({ assetIds }) => Promise.resolve(assetIds.flatMap(asset => Array.from({ length: 24 }, (_, h) => ({
  asset_id: asset, hour_of_day: h, mean_value: (LEVEL[asset] ?? 50) + h, days: 7,
}))))

const visit = async (address) => {
  window.history.pushState({}, '', address)
  render(<HistoryTab hasPermission={() => true} showToast={vi.fn()} />)
  await waitFor(() => expect(screen.queryByText(/Loading devices/)).not.toBeInTheDocument())
}

const heatmap = () => screen.getByRole('grid', { name: /the mean at each hour of the day/ })
const keysOf = (...ids) => ids.map(d => telemetryKey({ asset_id: d }))

beforeEach(() => {
  vi.clearAllMocks()
  plots.length = 0
  polls.length = 0
  api.get.mockImplementation(routeGet)
  api.readCarriedByGroup.mockImplementation(byGroup)
  api.readCarriedTelemetry.mockResolvedValue([])
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

describe('the Area tab and its address', () => {
  it('is a tab after Cell, with a path of its own, and picks an area at /history/area', async () => {
    await visit('/history/area?range=7d')
    const tabs = within(screen.getByRole('navigation', { name: 'History' })).getAllByRole('link')
    expect(tabs.map(t => t.textContent)).toEqual(['Overview', 'Device', 'Metric', 'Cell', 'Area', 'Alerts'])
    expect(tabs[4]).toHaveAttribute('aria-current', 'page')
    expect(tabs[4]).toHaveAttribute('href', '/history/area')
    const table = screen.getByRole('table', { name: /choose an area/i })
    const links = within(table).getAllByRole('link')
    expect(links.map(l => l.textContent)).toEqual(['Empty hall', 'Hall B', 'Hall C'])
    expect(links[1]).toHaveAttribute('href', '/history/area/a1?range=7d')
    // Cells in service and the machines in them: Hall B's archived cell is not counted, nor its Area-Wide meter.
    const row = links[1].closest('tr')
    expect(within(row).getAllByRole('cell').map(c => c.textContent)).toEqual(['Hall B', '3', '5'])
    expect(api.readCarriedByGroup).not.toHaveBeenCalled()
  })

  it('is reached from the tab bar, starting afresh at its picker', async () => {
    await visit('/history/cell?range=7d')
    fireEvent.click(screen.getByRole('link', { name: 'Area' }))
    expect(window.location.pathname + window.location.search).toBe('/history/area')
  })

  it('says when no area answers to the address, and reads nothing', async () => {
    await visit('/history/area/no-such-area')
    expect(screen.getByText(/No area answers to this address/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Choose another area' })).toHaveAttribute('href', '/history/area')
    expect(api.readCarriedByGroup).not.toHaveBeenCalled()
  })

  it('says when no cell of the area has a device in service, and reads nothing', async () => {
    await visit('/history/area/a3')
    expect(await screen.findByText(/No cell in this area has a device in service/)).toBeInTheDocument()
    expect(api.readCarriedByGroup).not.toHaveBeenCalled()
    expect(api.readHourOfDay).not.toHaveBeenCalled()
  })

  it('opens on the metric most machines report, takes one in the address, and lists them with how many report each', async () => {
    await visit('/history/area/a1')
    expect(await screen.findByRole('button', { name: 'Metric: Spindle/LOAD' })).toBeInTheDocument()
    expect(api.readCarriedByGroup.mock.calls[0][0].metricName).toBe('Spindle/LOAD')
    fireEvent.click(screen.getByRole('button', { name: 'Metric: Spindle/LOAD' }))
    const list = within(await screen.findByRole('dialog', { name: 'Choose a metric' })).getAllByRole('link')
    expect(list.map(l => l.textContent)).toEqual([
      'Controller/EXECUTION1 of 5 machines', 'Coolant/TEMP1 of 5 machines', 'Press/FORCE1 of 5 machines',
      'Spindle/LOAD4 of 5 machines', 'Spindle/SPEED1 of 5 machines',
    ])
    expect(list[4]).toHaveAttribute('href', '/history/area/a1?metric=Spindle%2FSPEED')
  })

  it('lists the areas to compare instead, at the same window, metric and total', async () => {
    await visit('/history/area/a1?metric=Spindle%2FLOAD&range=7d&agg=total')
    await waitFor(() => expect(api.readCarriedByGroup).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Area: Hall B' }))
    const options = within(await screen.findByRole('dialog', { name: 'Choose an area' })).getAllByRole('link')
    expect(options.map(o => o.textContent)).toEqual(['Empty hall0 cells', 'Hall B3 cells', 'Hall C1 cell'])
    expect(options[2]).toHaveAttribute('href', '/history/area/a2?range=7d&metric=Spindle%2FLOAD&agg=total')
  })
})

describe('the cells compared', () => {
  it('reads every machine that reports the metric in one call, a group key for each, at the finest resolution its bounds allow', async () => {
    await visit('/history/area/a1')
    await waitFor(() => expect(api.readCarriedByGroup).toHaveBeenCalledTimes(1))
    const [args] = api.readCarriedByGroup.mock.calls[0]
    // Four machines in two cells over Last 24 hours: 1,441 minutes each is 5,764 read and 2,882 returned, inside the bounds.
    expect(args).toMatchObject({ bucketMinutes: 1, metricName: 'Spindle/LOAD' })
    expect(args.assetIds).toEqual(keysOf(LATHE3, LATHE4, MILL, ROBOT))
    expect(args.groupKeys).toEqual(['c1', 'c1', 'c1', 'c2'])
    expect(Date.parse(args.to) - Date.parse(args.from)).toBe(24 * 60 * 60 * 1000)
    expect(await screen.findByText(/^2 cells, each the mean of its machines that have a value, in 1-minute buckets, 1 does not report it/)).toBeInTheDocument()
  })

  it('takes a coarser resolution over a longer window, where the cells times buckets would pass the cap, and names it', async () => {
    await visit('/history/area/a1?range=30d')
    // 30 days is 43,201 minutes and 8,641 five-minute buckets of two cells: past 5,000 returned. An hour is 721 each.
    await waitFor(() => expect(api.readCarriedByGroup).toHaveBeenCalledTimes(1))
    expect(api.readCarriedByGroup.mock.calls[0][0].bucketMinutes).toBe(60)
    expect(await screen.findByText(/in 1-hour buckets/)).toBeInTheDocument()
  })

  it('draws a chart a cell, named by the cell, with its machines counted and a link to its Cell tab at the same window and metric', async () => {
    await visit('/history/area/a1?range=7d')
    await waitFor(() => expect(plots).toHaveLength(2))
    const figures = screen.getAllByRole('figure')
    expect(figures.map(f => f.getAttribute('aria-label'))).toEqual(['Turning', 'Welding'])
    const turning = within(screen.getByRole('figure', { name: 'Turning' }))
    expect(turning.getByText('3 machines')).toBeInTheDocument()
    expect(turning.getByRole('link', { name: 'Turning' })).toHaveAttribute('href', '/history/cell/c1?range=7d&metric=Spindle%2FLOAD')
    expect(within(screen.getByRole('figure', { name: 'Welding' })).getByText('1 machine')).toBeInTheDocument()
    expect(document.getElementById(screen.getByRole('img', { name: 'Turning' }).getAttribute('aria-describedby')).textContent)
      .toMatch(/^Turning\. Spindle\/LOAD \(kW\), Last 7 days, mean of 3 machines\./)
  })

  it('says in words that a cell has no machine reporting the metric, and draws no chart for it', async () => {
    await visit('/history/area/a1')
    expect(await screen.findAllByText('None of the machines in Press line reports Spindle/LOAD.')).not.toHaveLength(0)
    expect(within(document.querySelector('.multiples')).getByText('None of the machines in Press line reports Spindle/LOAD.')).toBeInTheDocument()
    await waitFor(() => expect(plots).toHaveLength(2))
    expect(screen.getAllByRole('figure')).toHaveLength(2)
  })

  it('draws every chart on one value scale, from the lowest to the highest value of them all, and says so', async () => {
    await visit('/history/area/a1')
    await waitFor(() => expect(plots).toHaveLength(2))
    const ranges = plots.map(p => p.opts.scales.y.range)
    expect(ranges[1]).toEqual(ranges[0])
    // Turning's means are 10 to 13 and Welding's 50 to 53: 10 to 53, padded by 8% of 43.
    expect(ranges[0][0]).toBeCloseTo(10 - 43 * 0.08)
    expect(ranges[0][1]).toBeCloseTo(53 + 43 * 0.08)
    expect(screen.getByText('One scale for every cell: 6.56 to 56.44 kW.')).toBeInTheDocument()
    for (const { opts } of plots) expect(opts.cursor.sync).toEqual({ key: 'history-area-a1' })
  })

  it('names the devices that are Area-Wide, in no cell, as not charted', async () => {
    await visit('/history/area/a1')
    expect(await screen.findByText(/1 device is Area-Wide, in no cell, so not charted/)).toBeInTheDocument()
  })

  it('refuses a window too long for the area even in day buckets, and reads nothing', async () => {
    await visit('/history/area/a1?from=2000-01-01T00:00&to=2026-01-01T00:00')
    expect(await screen.findByText(/This window is too long to chart/)).toBeInTheDocument()
    expect(api.readCarriedByGroup).not.toHaveBeenCalled()
  })

  it('says what the read refused', async () => {
    api.readCarriedByGroup.mockRejectedValue(new Error('the historian is out'))
    await visit('/history/area/a1')
    expect(await screen.findByText('The readings could not be read: the historian is out')).toBeInTheDocument()
  })

  it('reads again on Refresh, both reads at once, and keeps the timer off for a window that has ended', async () => {
    await visit('/history/area/a1')
    await waitFor(() => expect(api.readHourOfDay).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: /^Refresh$/ }))
    await waitFor(() => expect(api.readCarriedByGroup).toHaveBeenCalledTimes(2))
    expect(api.readHourOfDay).toHaveBeenCalledTimes(2)
    expect(polls[polls.length - 1].enabled).toBe(false)
  })
})

describe('mean or total', () => {
  const firstLine = () => plots[0].data[1]

  it('opens on the mean, and has the one control in the toolbar naming both', async () => {
    await visit('/history/area/a1')
    await waitFor(() => expect(plots).toHaveLength(2))
    const control = screen.getByRole('radiogroup', { name: /Each cell's chart is its/ })
    expect(within(control).getByRole('radio', { name: /Mean/ })).toBeChecked()
    expect(within(control).getByRole('radio', { name: /Total/ })).not.toBeChecked()
    expect(firstLine().slice(0, 4)).toEqual([10, 11, 12, 13])
  })

  it('shows the total, in the address, without reading again', async () => {
    await visit('/history/area/a1')
    await waitFor(() => expect(plots).toHaveLength(2))
    fireEvent.click(screen.getByRole('radio', { name: /Total/ }))
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('agg')).toBe('total'))
    await waitFor(() => expect(plots.some(p => p.data[1].slice(0, 2).join() === '30,33')).toBe(true))
    expect(api.readCarriedByGroup).toHaveBeenCalledTimes(1)
    expect(await screen.findByText(/each the total of its machines, withheld where one has no value/)).toBeInTheDocument()
  })

  it('opens on the total from the address, and goes back to the mean with the address clean', async () => {
    await visit('/history/area/a1?agg=total')
    await waitFor(() => expect(plots.length).toBeGreaterThan(0))
    expect(screen.getByRole('radio', { name: /Total/ })).toBeChecked()
    fireEvent.click(screen.getByRole('radio', { name: /Mean/ }))
    await waitFor(() => expect(window.location.search).toBe(''))
  })

  it('draws a total only where every machine of the cell had a value, and says where it was withheld, in words', async () => {
    await visit('/history/area/a1?agg=total')
    await waitFor(() => expect(plots.length).toBeGreaterThan(0))
    const turning = plots.find(p => p.data[1].slice(0, 2).join() === '30,33')
    // The third bucket, where one of three machines had no value, has no point; the rest are the sums.
    expect(turning.data[1].slice(0, 4)).toEqual([30, 33, null, 39])
    const figure = within(screen.getByRole('figure', { name: 'Turning' }))
    expect(figure.getByText(/^total of 3 machines, withheld from .+ to .+, where a machine had no value$/)).toBeInTheDocument()
    expect(document.getElementById(screen.getByRole('img', { name: 'Turning' }).getAttribute('aria-describedby')).textContent)
      .toMatch(/total of 3 machines, withheld from /)
    // The mean of the same buckets is drawn whole, over the two machines that had a value.
    fireEvent.click(screen.getByRole('radio', { name: /Mean/ }))
    await waitFor(() => expect(plots.some(p => p.data[1].slice(0, 4).join() === '10,11,12,13')).toBe(true))
    expect(screen.getByRole('figure', { name: 'Turning' }).textContent).not.toMatch(/withheld/)
  })

  it('says a cell has no total at all when a machine had no value in any bucket', async () => {
    api.readCarriedByGroup.mockImplementation(async (args) => (await byGroup(args)).map(r => (r.group_key === 'c1' ? { ...r, total_double: null, with_value: 2 } : r)))
    await visit('/history/area/a1?agg=total')
    expect(await screen.findByText('Turning has no total in this window: a machine had no value in every bucket.')).toBeInTheDocument()
    await waitFor(() => expect(plots).toHaveLength(1))
    // The mean is there.
    fireEvent.click(screen.getByRole('radio', { name: /Mean/ }))
    await waitFor(() => expect(plots).toHaveLength(3))
  })
})

describe("the heatmap's row a cell", () => {
  it('reads every machine that reports the metric in one call, and draws a row a cell, the mean of its machines at each hour', async () => {
    await visit('/history/area/a1')
    await waitFor(() => expect(api.readHourOfDay).toHaveBeenCalledTimes(1))
    const [args] = api.readHourOfDay.mock.calls[0]
    expect(args).toMatchObject({ metricName: 'Spindle/LOAD' })
    expect(args.assetIds).toEqual(keysOf(LATHE3, LATHE4, MILL, ROBOT))
    const grid = await waitFor(() => heatmap())
    const rows = within(grid).getAllByRole('row')
    // The header, then a row a cell of the area, in name order: Press line reports nothing.
    expect(rows).toHaveLength(4)
    expect(within(rows[1]).getByRole('rowheader')).toHaveTextContent('Press line')
    expect(within(rows[1]).getByText('None of the machines in Press line reports Spindle/LOAD.')).toBeInTheDocument()
    expect(within(rows[2]).getByRole('rowheader')).toHaveTextContent('Turning')
    expect(within(rows[3]).getByRole('rowheader')).toHaveTextContent('Welding')
    expect(within(grid).getByRole('columnheader', { name: 'Cell' })).toBeInTheDocument()
    // Lathe 3, Lathe 4 and Mill 2 are 10, 30 and 20 plus the hour: Turning at 14:00 is their mean, 20 + 14 = 34.
    expect(within(rows[2]).getAllByRole('gridcell')[14]).toHaveAttribute('aria-label', 'Turning · 14:00–15:00 · 34 kW, the mean of 7 days, across 3 machines')
    expect(within(rows[3]).getAllByRole('gridcell')[14]).toHaveAttribute('aria-label', 'Welding · 14:00–15:00 · 74 kW, the mean of 7 days')
    expect(screen.getByText(/Each square is the mean of the cell's machines at that hour across the window's days/)).toBeInTheDocument()
  })

  it('stays the mean when the total is chosen', async () => {
    await visit('/history/area/a1?agg=total')
    const grid = await waitFor(() => heatmap())
    expect(within(within(grid).getAllByRole('row')[2]).getAllByRole('gridcell')[14]).toHaveAttribute('aria-label', expect.stringContaining('34 kW'))
  })

  it('says in words how long a window the heatmap allows, while the charts go on', async () => {
    // Four machines read at most 50,000 / 4 / 24 = 520 days; this window is two years.
    await visit('/history/area/a1?from=2024-01-01T00:00&to=2026-01-01T00:00')
    expect(await screen.findByText(/The heatmap reads every hour of the window for each machine, so for 4 machines it covers at most 520 days/)).toBeInTheDocument()
    expect(api.readHourOfDay).not.toHaveBeenCalled()
    await waitFor(() => expect(api.readCarriedByGroup).toHaveBeenCalledTimes(1))
    expect(api.readCarriedByGroup.mock.calls[0][0].bucketMinutes).toBe(1440)
  })
})

describe('a text or a flag metric', () => {
  it('says it has no mean or total, offers each cell\'s own tab, and reads nothing', async () => {
    await visit('/history/area/a1?metric=Controller%2FEXECUTION&range=7d')
    expect(await screen.findAllByText(/A mean or a total needs a number\. Controller\/EXECUTION is text or a flag/)).not.toHaveLength(0)
    const links = screen.getAllByRole('link', { name: 'Open Welding on the Cell tab' })
    expect(links[0]).toHaveAttribute('href', '/history/cell/c2?range=7d&metric=Controller%2FEXECUTION')
    expect(api.readCarriedByGroup).not.toHaveBeenCalled()
    expect(api.readHourOfDay).not.toHaveBeenCalled()
    expect(plots).toHaveLength(0)
  })
})
