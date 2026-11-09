/**
 * The History page's Metric tab: the metric picker, one metric across every device that reports it as
 * small multiples on one scale, the area, cell and device filters, the resolution the row cap picks, the
 * paging past what the cap carries, and a text metric's strips. uPlot draws on a canvas jsdom does not
 * have, so a stand-in records what each chart was built with.
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
const WELD = id(3)
const ROBOT = id(4)
const LOOSE = id(5)
const inCell = (cell) => ({ effective_cell_id: cell, location_source: 'inherited', status: 'ONLINE' })
const devices = [
  { asset_id: LATHE3, asset_name: 'Lathe 3', last_birth_metrics: ['Spindle/LOAD', 'Spindle/SPEED'], ...inCell('c1') },
  { asset_id: LATHE4, asset_name: 'Lathe 4', last_birth_metrics: ['Spindle/LOAD'], ...inCell('c1') },
  { asset_id: WELD, asset_name: 'Weld bot', last_birth_metrics: ['Spindle/LOAD', 'Weld/CURRENT'], ...inCell('c2'), status: 'OFFLINE' },
  { asset_id: ROBOT, asset_name: 'Robot 5', last_birth_metrics: ['Controller/EXECUTION'], ...inCell('c2') },
  { asset_id: LOOSE, asset_name: 'Loose', last_birth_metrics: ['Spindle/LOAD'], effective_cell_id: null, location_source: 'unassigned', status: 'ONLINE' },
]
const cells = [
  { cell_id: 'c1', cell_name: 'Turning', area_id: 'a1' },
  { cell_id: 'c2', cell_name: 'Welding', area_id: 'a2' },
]
const areas = [{ area_id: 'a1', area_name: 'Hall B' }, { area_id: 'a2', area_name: 'Hall C' }]
const catalog = [
  { name: 'Spindle/LOAD', units: 'kW', datatype: 10 }, { name: 'Spindle/SPEED', units: 'rpm', datatype: 10 },
  { name: 'Controller/EXECUTION', datatype: 12 }, { name: 'Weld/CURRENT', units: 'A', datatype: 10 },
]

const routeGet = (list = devices) => (path) => {
  if (path.startsWith('/api/v1/devices')) return Promise.resolve(list)
  if (path.startsWith('/api/v1/cells')) return Promise.resolve(cells)
  if (path.startsWith('/api/v1/areas')) return Promise.resolve(areas)
  if (path.startsWith('/api/v1/schemas')) return Promise.resolve([])
  if (path.startsWith('/api/v1/metric-catalog')) return Promise.resolve(catalog)
  return Promise.resolve([])
}

/** Each device's level, so a scale shared across them shows in the plots' data. */
const LEVEL = { [telemetryKey({ asset_id: LATHE3 })]: 40, [telemetryKey({ asset_id: LATHE4 })]: 20, [telemetryKey({ asset_id: WELD })]: 80 }

/** Three buckets for each device asked for: its level, and a minimum and a maximum a degree either side. */
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

const visit = async (address, list = devices) => {
  api.get.mockImplementation(routeGet(list))
  window.history.pushState({}, '', address)
  render(<HistoryTab hasPermission={() => true} showToast={vi.fn()} />)
  await waitFor(() => expect(screen.queryByText(/Loading devices/)).not.toBeInTheDocument())
}

/** Many devices that all report the metric, for the paging. */
const crowd = (n) => Array.from({ length: n }, (_, i) => ({
  asset_id: `2b3e0c4a-${String(i + 1).padStart(4, '0')}-4000-8000-000000000000`, asset_name: `Machine ${String(i + 1).padStart(2, '0')}`,
  last_birth_metrics: ['Spindle/LOAD'], ...inCell(i % 2 ? 'c1' : 'c2'),
}))

beforeEach(() => {
  vi.clearAllMocks()
  plots.length = 0
  polls.length = 0
  api.readCarriedTelemetry.mockImplementation(carried)
  api.readTelemetryChanges.mockResolvedValue([])
  api.readHourOfDay.mockResolvedValue([])
  api.readAlertOccurrences.mockResolvedValue([])
  document.documentElement.setAttribute('data-theme', 'dark')
  document.documentElement.style.setProperty('--accent', '#00d4ff')
})

afterEach(() => {
  cleanup()
  document.documentElement.style.removeProperty('--accent')
  window.history.pushState({}, '', '/')
})

describe('the Metric tab and its address', () => {
  it('is a tab after Device, with a path of its own, and lists the metrics some device reports at /history/metric', async () => {
    await visit('/history/metric?range=7d')
    const tabs = within(screen.getByRole('navigation', { name: 'History' })).getAllByRole('link')
    expect(tabs.map(t => t.textContent)).toEqual(['Overview', 'Device', 'Metric', 'Cell', 'Area', 'Alerts'])
    expect(tabs[2]).toHaveAttribute('aria-current', 'page')
    expect(tabs[2]).toHaveAttribute('href', '/history/metric')
    const table = screen.getByRole('table', { name: /choose a metric/i })
    const links = within(table).getAllByRole('link')
    expect(links.map(l => l.textContent)).toEqual(['Controller/EXECUTION', 'Spindle/LOAD', 'Spindle/SPEED', 'Weld/CURRENT'])
    expect(links[1]).toHaveAttribute('href', '/history/metric/Spindle%2FLOAD?range=7d')
    // Each with its unit and how many devices report it.
    const row = links[1].closest('tr')
    expect(within(row).getByText('kW')).toBeInTheDocument()
    expect(within(row).getByText('4')).toBeInTheDocument()
    expect(api.readCarriedTelemetry).not.toHaveBeenCalled()
  })

  it('narrows the picker to the metrics of the devices the address names, and each link keeps them', async () => {
    const keys = [LATHE4, ROBOT].map(d => telemetryKey({ asset_id: d }))
    await visit(`/history/metric?devices=${keys.join(',')}`)
    const links = within(screen.getByRole('table')).getAllByRole('link')
    expect(links.map(l => l.textContent)).toEqual(['Controller/EXECUTION', 'Spindle/LOAD'])
    expect(links[1]).toHaveAttribute('href', `/history/metric/Spindle%2FLOAD?devices=${keys.join(',')}`)
  })

  it('is reached from the tab bar, starting afresh at its picker', async () => {
    await visit('/history/device?range=7d')
    fireEvent.click(screen.getByRole('link', { name: 'Metric' }))
    expect(window.location.pathname + window.location.search).toBe('/history/metric')
  })

  it('says when no device reports the metric the address names, and reads nothing', async () => {
    await visit('/history/metric/No%2FSuch')
    expect(await screen.findByText('No device in service reports No/Such.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Choose another metric' })).toHaveAttribute('href', '/history/metric')
    expect(api.readCarriedTelemetry).not.toHaveBeenCalled()
  })

  it('says when no device is in service that reports any metric', async () => {
    await visit('/history/metric', [])
    expect(await screen.findByText(/No device in service reports a metric yet/)).toBeInTheDocument()
  })
})

describe('one metric across the devices that report it', () => {
  it('reads every device that reports it, wherever it sits, in one call at the finest resolution the cap allows, and says which', async () => {
    await visit('/history/metric/Spindle%2FLOAD')
    await waitFor(() => expect(api.readCarriedTelemetry).toHaveBeenCalledTimes(1))
    const [args] = api.readCarriedTelemetry.mock.calls[0]
    // Four devices over Last 24 hours: 289 five-minute buckets each is 1,156 rows, under 5,000; minutes are 5,764.
    expect(args).toMatchObject({ bucketMinutes: 5, metricNames: ['Spindle/LOAD'] })
    expect([...args.assetIds].sort()).toEqual([LATHE3, LATHE4, WELD, LOOSE].map(d => telemetryKey({ asset_id: d })).sort())
    expect(await screen.findByText('4 devices, in 5-minute buckets')).toBeInTheDocument()
  })

  it('draws a chart a device, in name order, each titled by its device and where it sits', async () => {
    await visit('/history/metric/Spindle%2FLOAD')
    await waitFor(() => expect(plots).toHaveLength(4))
    expect(screen.getAllByRole('figure').map(f => f.getAttribute('aria-label'))).toEqual(['Lathe 3', 'Lathe 4', 'Loose', 'Weld bot'])
    const lathe = within(screen.getByRole('figure', { name: 'Lathe 3' }))
    expect(lathe.getByText('Turning · Hall B')).toBeInTheDocument()
    expect(lathe.getByRole('link', { name: 'Lathe 3' })).toHaveAttribute('href', `/history/device/${LATHE3}?metric=Spindle%2FLOAD`)
    expect(within(screen.getByRole('figure', { name: 'Weld bot' })).getByText('Offline')).toBeInTheDocument()
    // A device in no cell or area says nothing of where it sits.
    expect(screen.getByRole('figure', { name: 'Loose' }).querySelector('.multiple-place')).toBeNull()
  })

  it('draws every chart on one value scale across all the devices, and says so in words', async () => {
    await visit('/history/metric/Spindle%2FLOAD')
    await waitFor(() => expect(plots).toHaveLength(4))
    const ranges = plots.map(p => p.opts.scales.y.range)
    for (const range of ranges) expect(range).toEqual(ranges[0])
    // Levels 20 (Lathe 4) to 82 (Weld bot, the last bucket), a degree wider each side: 19 to 83, padded by 8% of 64.
    expect(ranges[0][0]).toBeCloseTo(19 - 64 * 0.08)
    expect(ranges[0][1]).toBeCloseTo(83 + 64 * 0.08)
    expect(screen.getByText('One scale for every device: 13.88 to 88.12 kW.')).toBeInTheDocument()
    for (const { opts } of plots) expect(opts.cursor.sync).toEqual({ key: 'history-metric-Spindle/LOAD' })
  })

  it('opens a metric one device reports on a single chart, with no scale to say', async () => {
    await visit('/history/metric/Spindle%2FSPEED')
    await waitFor(() => expect(plots).toHaveLength(1))
    expect(await screen.findByText('1 device, in 1-minute buckets')).toBeInTheDocument()
    expect(screen.queryByText(/One scale/)).not.toBeInTheDocument()
  })

  it('lists the metrics to compare instead, at the same window and filters', async () => {
    await visit('/history/metric/Spindle%2FLOAD?range=7d&area=a1')
    await waitFor(() => expect(api.readCarriedTelemetry).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Metric: Spindle/LOAD' }))
    const options = within(await screen.findByRole('dialog', { name: 'Choose a metric' })).getAllByRole('link')
    expect(options.map(o => o.textContent)).toEqual(['Controller/EXECUTION1 device', 'Spindle/LOAD4 devices', 'Spindle/SPEED1 device', 'Weld/CURRENT1 device'])
    expect(options[2]).toHaveAttribute('href', '/history/metric/Spindle%2FSPEED?range=7d&area=a1')
  })

  it('refuses a window too long for one device even in day buckets, and reads nothing', async () => {
    await visit('/history/metric/Spindle%2FLOAD?from=2000-01-01T00:00&to=2026-01-01T00:00')
    expect(await screen.findByText(/This window is too long to chart/)).toBeInTheDocument()
    expect(api.readCarriedTelemetry).not.toHaveBeenCalled()
  })

  it('says what the read refused', async () => {
    api.readCarriedTelemetry.mockRejectedValue(new Error('the historian is out'))
    await visit('/history/metric/Spindle%2FLOAD')
    expect(await screen.findByText('The readings could not be read: the historian is out')).toBeInTheDocument()
  })

  it('reads again on Refresh, and keeps the timer off for a window that has ended', async () => {
    await visit('/history/metric/Spindle%2FLOAD')
    await waitFor(() => expect(api.readCarriedTelemetry).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: /^Refresh$/ }))
    await waitFor(() => expect(api.readCarriedTelemetry).toHaveBeenCalledTimes(2))
    expect(polls[polls.length - 1].enabled).toBe(false)
  })
})

describe('the area, cell and device filters', () => {
  const askedFor = () => [...api.readCarriedTelemetry.mock.calls.at(-1)[0].assetIds].sort()
  const keysOf = (...ids) => ids.map(d => telemetryKey({ asset_id: d })).sort()

  it('narrows the devices to an area, and a cell, by their ids in the address', async () => {
    await visit('/history/metric/Spindle%2FLOAD?area=a2')
    await waitFor(() => expect(api.readCarriedTelemetry).toHaveBeenCalled())
    expect(askedFor()).toEqual(keysOf(WELD))
    cleanup()
    api.readCarriedTelemetry.mockClear()
    await visit('/history/metric/Spindle%2FLOAD?cell=c1')
    await waitFor(() => expect(api.readCarriedTelemetry).toHaveBeenCalled())
    expect(askedFor()).toEqual(keysOf(LATHE3, LATHE4))
  })

  it("narrows to a list of devices, as Overview's selection box sends it", async () => {
    await visit(`/history/metric/Spindle%2FLOAD?devices=${keysOf(LATHE4, LOOSE).join(',')}`)
    await waitFor(() => expect(api.readCarriedTelemetry).toHaveBeenCalled())
    expect(askedFor()).toEqual(keysOf(LATHE4, LOOSE))
    expect(await screen.findByText('2 devices, in 1-minute buckets')).toBeInTheDocument()
  })

  it('drops a value the metric offers none of, and tidies the address', async () => {
    await visit('/history/metric/Spindle%2FLOAD?area=a9&cell=c9')
    await waitFor(() => expect(api.readCarriedTelemetry).toHaveBeenCalled())
    expect(askedFor()).toHaveLength(4)
    await waitFor(() => expect(window.location.search).toBe(''))
  })

  it('offers only the areas, cells and devices that report the metric, the cells under their areas', async () => {
    await visit('/history/metric/Spindle%2FSPEED')
    await waitFor(() => expect(plots).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }))
    const panel = await screen.findByRole('dialog', { name: 'Filters' })
    // The first list, Area, is the one open.
    expect(within(panel).getAllByRole('checkbox').map(c => c.parentElement.textContent)).toEqual(['Hall B'])
    fireEvent.click(within(panel).getByRole('button', { name: /^Cell/ }))
    // The cell sits under a heading naming its area, which chooses every cell under it.
    expect(within(panel).getAllByRole('checkbox').map(c => c.parentElement.textContent)).toEqual(['Hall B', 'Turning'])
  })

  it('shows what narrows it in the Filters button, and Clear filters takes it all away', async () => {
    await visit('/history/metric/Spindle%2FLOAD?area=a1&range=7d')
    await waitFor(() => expect(api.readCarriedTelemetry).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: 'Filters (1)' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Clear filters/ }))
    await waitFor(() => expect(window.location.search).toBe(''))
  })

  it('says when the filters leave no device', async () => {
    await visit('/history/metric/Spindle%2FSPEED?cell=c1&area=a1')
    await waitFor(() => expect(plots).toHaveLength(1))
    cleanup()
    // Lathe 3 is the only device reporting it; Welding is not its cell.
    await visit('/history/metric/Spindle%2FLOAD?area=a1&cell=c2')
    expect(await screen.findByText(/No device that reports Spindle\/LOAD is in the area, cell or devices chosen/)).toBeInTheDocument()
  })
})

describe('paging past what the row cap carries', () => {
  it('reads and draws them all in one page while one read carries them', async () => {
    await visit('/history/metric/Spindle%2FLOAD', crowd(30))
    await waitFor(() => expect(plots).toHaveLength(30))
    expect(screen.queryByRole('navigation', { name: 'Pages of devices' })).not.toBeInTheDocument()
    expect(api.readCarriedTelemetry).toHaveBeenCalledTimes(1)
  })

  it('pages once one read cannot carry them at a day, twelve to a page, and says so in words', async () => {
    // A year of day buckets is 366, so 13 devices fit the cap of 5,000 and 30 do not.
    await visit('/history/metric/Spindle%2FLOAD?span=year&at=2025-01-01', crowd(30))
    await waitFor(() => expect(plots).toHaveLength(12))
    expect(api.readCarriedTelemetry).toHaveBeenCalledTimes(1)
    expect(api.readCarriedTelemetry.mock.calls[0][0].assetIds).toHaveLength(12)
    expect(await screen.findByText('30 devices are too many to chart at once, so they come 12 to a page: devices 1 to 12.')).toBeInTheDocument()
    expect(screen.getByText('12 devices, in 1-day buckets')).toBeInTheDocument()
    expect(screen.getByText(/One scale for every device on this page/)).toBeInTheDocument()
    const pager = screen.getByRole('navigation', { name: 'Pages of devices' })
    expect(within(pager).getByText('Page 1 of 3')).toBeInTheDocument()
    expect(within(pager).getByRole('button', { name: /Previous/ })).toBeDisabled()
  })

  it('goes to the next page, in the address, and reads the next devices', async () => {
    await visit('/history/metric/Spindle%2FLOAD?span=year&at=2025-01-01', crowd(30))
    await waitFor(() => expect(plots.length).toBeGreaterThan(0))
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Pages of devices' })).getByRole('button', { name: /Next/ }))
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('page')).toBe('2'))
    await waitFor(() => expect(api.readCarriedTelemetry).toHaveBeenCalledTimes(2))
    const second = api.readCarriedTelemetry.mock.calls[1][0].assetIds
    const first = api.readCarriedTelemetry.mock.calls[0][0].assetIds
    expect(second).toHaveLength(12)
    expect(second.some(a => first.includes(a))).toBe(false)
    expect(await screen.findByText('30 devices are too many to chart at once, so they come 12 to a page: devices 13 to 24.')).toBeInTheDocument()
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument()
  })

  it('opens on the page the address names, the last one shorter, and a page past the last is the last', async () => {
    await visit('/history/metric/Spindle%2FLOAD?span=year&at=2025-01-01&page=3', crowd(30))
    await waitFor(() => expect(api.readCarriedTelemetry).toHaveBeenCalled())
    expect(api.readCarriedTelemetry.mock.calls[0][0].assetIds).toHaveLength(6)
    expect(await screen.findByText('30 devices are too many to chart at once, so they come 12 to a page: devices 25 to 30.')).toBeInTheDocument()
    cleanup()
    api.readCarriedTelemetry.mockClear()
    await visit('/history/metric/Spindle%2FLOAD?span=year&at=2025-01-01&page=99', crowd(30))
    await waitFor(() => expect(api.readCarriedTelemetry).toHaveBeenCalled())
    expect(api.readCarriedTelemetry.mock.calls[0][0].assetIds).toHaveLength(6)
  })

  it('starts again at the first page when a filter narrows the devices', async () => {
    await visit('/history/metric/Spindle%2FLOAD?span=year&at=2025-01-01&page=2', crowd(30))
    await waitFor(() => expect(plots.length).toBeGreaterThan(0))
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }))
    const panel = await screen.findByRole('dialog', { name: 'Filters' })
    fireEvent.click(within(panel).getAllByRole('checkbox')[0])
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('page')).toBeNull())
  })
})

describe('a text metric', () => {
  it('draws every change of each device as a strip, from telemetry_changes()', async () => {
    const robots = [
      { asset_id: ROBOT, asset_name: 'Robot 5', last_birth_metrics: ['Controller/EXECUTION'], ...inCell('c2') },
      { asset_id: LATHE3, asset_name: 'Lathe 3', last_birth_metrics: ['Controller/EXECUTION'], ...inCell('c1') },
    ]
    api.readCarriedTelemetry.mockResolvedValue([])
    api.readTelemetryChanges.mockResolvedValue([])
    await visit('/history/metric/Controller%2FEXECUTION', robots)
    await waitFor(() => expect(api.readTelemetryChanges).toHaveBeenCalledTimes(1))
    expect(api.readTelemetryChanges.mock.calls[0][0]).toMatchObject({ metricNames: ['Controller/EXECUTION'] })
    expect(api.readTelemetryChanges.mock.calls[0][0].assetIds).toHaveLength(2)
    expect(await screen.findByText(/2 devices, in 1-minute buckets/)).toBeInTheDocument()
    expect(plots).toHaveLength(0)
  })
})
