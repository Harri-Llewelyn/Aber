/**
 * History draws a derived metric (0282): each tab offers the derived metrics a device's reports make
 * possible, reads them through derived_series() and not telemetry_carried(), tags them, and leaves
 * them out of Export. uPlot draws on a canvas jsdom does not have, so a stand-in records what each
 * chart was built with.
 */
import React from 'react'
import { render, screen, waitFor, within, fireEvent, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HistoryTab } from '../components/tabs/HistoryTab'
import { api } from '../api'
import { DERIVED_EXPORT_NOTE } from '../utils/telemetryExport'
import { telemetryKey } from '../utils/history'

const { plots } = vi.hoisted(() => ({ plots: [] }))

vi.mock('../hooks/usePolling', () => ({ usePolling: () => {} }))

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
      get: vi.fn(), readCarriedTelemetry: vi.fn(), readDerivedSeries: vi.fn(), readTelemetryChanges: vi.fn(),
      readHourOfDay: vi.fn(), readAlertOccurrences: vi.fn(), exportTelemetry: vi.fn(),
    },
  }
})

const id = (n) => `2b3e0c4a-${n}${n}${n}${n}-4000-8000-00000000000${n}`
const PRESS1 = id(1)
const PRESS2 = id(2)
const LATHE = id(3)
const inCell = { location_source: 'inherited', status: 'ONLINE' }
const devices = [
  { asset_id: PRESS1, asset_name: 'Press 1', effective_cell_id: 'c1', last_birth_metrics: ['Controller/PART_COUNT', 'Controller/EXECUTION'], ...inCell },
  { asset_id: PRESS2, asset_name: 'Press 2', effective_cell_id: 'c1', last_birth_metrics: ['Controller/PART_COUNT'], ...inCell },
  { asset_id: LATHE, asset_name: 'Lathe 3', effective_cell_id: 'c2', last_birth_metrics: ['Spindle/LOAD'], ...inCell },
]
const cells = [
  { cell_id: 'c1', cell_name: 'Presses', area_id: 'a1' },
  { cell_id: 'c2', cell_name: 'Lathes', area_id: 'a1' },
]
const areas = [{ area_id: 'a1', area_name: 'Hall B' }]
const RATE = 'Controller/PARTS_PER_HOUR'
const UPTIME = 'Controller/UPTIME'
const catalog = [
  { name: 'Controller/PART_COUNT', units: 'COUNT', datatype: 10 },
  { name: 'Controller/EXECUTION', datatype: 12 },
  { name: 'Spindle/LOAD', units: 'kW', datatype: 10 },
  { name: RATE, units: 'COUNT/HOUR', datatype: 10, derivation: { kind: 'counter_rate', input: 'Controller/PART_COUNT' } },
  { name: UPTIME, datatype: 10, derivation: { kind: 'time_in_state', input: 'Controller/EXECUTION', states: ['ACTIVE'] } },
]

const routeGet = (path) => {
  if (path.startsWith('/api/v1/devices')) return Promise.resolve(devices)
  if (path.startsWith('/api/v1/cells')) return Promise.resolve(cells)
  if (path.startsWith('/api/v1/areas')) return Promise.resolve(areas)
  if (path.startsWith('/api/v1/schemas')) return Promise.resolve([])
  if (path.startsWith('/api/v1/metric-catalog')) return Promise.resolve(catalog)
  return Promise.resolve([])
}

/** Press 1 makes 100 an hour and Press 2 makes 200: three buckets each, the last one carried. */
const LEVEL = { [telemetryKey({ asset_id: PRESS1 })]: 100, [telemetryKey({ asset_id: PRESS2 })]: 200 }
/** A time in state is a fraction from 0 to 1, as the database returns it: 42.5% of the bucket. */
const level = (asset, name) => (name === UPTIME ? 0.425 : LEVEL[asset] ?? 50)
const derived = ({ from, bucketMinutes, assetIds, metricNames }) => {
  const width = bucketMinutes * 60000
  const first = Math.floor(Date.parse(from) / width) * width
  return Promise.resolve(assetIds.flatMap(asset => metricNames.flatMap(name => [0, 1, 2].map(i => ({
    bucket_ts: new Date(first + i * width).toISOString(), asset_id: asset, metric_name: name,
    avg_double: level(asset, name), min_double: level(asset, name), max_double: level(asset, name), last_double: level(asset, name),
    n_rows: i === 2 ? 0 : 4, is_carried: i === 2,
  })))))
}
const measured = ({ from, bucketMinutes, assetIds, metricNames }) => {
  const width = bucketMinutes * 60000
  const first = Math.floor(Date.parse(from) / width) * width
  return Promise.resolve(assetIds.flatMap(asset => metricNames.map(name => ({
    bucket_ts: new Date(first).toISOString(), asset_id: asset, metric_name: name,
    avg_double: 7, min_double: 7, max_double: 7, last_double: 7, last_string: null, last_bool: null, n_rows: 1, is_carried: false,
  }))))
}

const visit = async (address, { userRole = 'Administrator' } = {}) => {
  window.history.pushState({}, '', address)
  render(<HistoryTab showToast={vi.fn()} userRole={userRole} />)
  await waitFor(() => expect(screen.queryByText(/Loading devices/)).not.toBeInTheDocument())
}

beforeEach(() => {
  vi.clearAllMocks()
  plots.length = 0
  api.get.mockImplementation(routeGet)
  api.readCarriedTelemetry.mockImplementation(measured)
  api.readDerivedSeries.mockImplementation(derived)
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

describe('the Device tab', () => {
  it('draws each derived metric the device reports the inputs of, tagged, read by derived_series()', async () => {
    await visit(`/history/device/${PRESS1}?range=24h`)
    const figure = await screen.findByRole('figure', { name: 'Controller/PARTS_PER_HOUR (COUNT/HOUR)' })
    expect(within(figure).getByText('Derived')).toBeInTheDocument()
    expect(screen.getByRole('figure', { name: 'Controller/UPTIME (% of the time)' })).toBeInTheDocument()
    expect(api.readDerivedSeries).toHaveBeenCalledTimes(1)
    expect(api.readDerivedSeries.mock.calls[0][0].metricNames).toEqual([RATE, UPTIME])
    // The measured metrics keep their own read, and a derived name is not asked of it.
    const asked = api.readCarriedTelemetry.mock.calls.flatMap(c => c[0].metricNames)
    expect(asked).toContain('Controller/PART_COUNT')
    expect(asked).not.toContain(RATE)
    expect(asked).not.toContain(UPTIME)
    // A measured metric carries no tag.
    expect(within(screen.getByRole('figure', { name: 'Controller/PART_COUNT (COUNT)' })).queryByText('Derived')).not.toBeInTheDocument()
  })

  it('draws a time in state as a percentage: the axis, the latest reading, the hover and the summary', async () => {
    await visit(`/history/device/${PRESS1}?range=24h`)
    const figure = await screen.findByRole('figure', { name: 'Controller/UPTIME (% of the time)' })
    // The latest reading is the bucket with a reading in it, not the carried one.
    expect(within(figure).getByText(/^Latest 42[.]5% · /)).toBeInTheDocument()
    expect(document.getElementById(figure.querySelector('[role="img"]').getAttribute('aria-describedby')).textContent)
      .toMatch(/Latest 42[.]5%, in the bucket from .*Lowest 42[.]5%, highest 42[.]5%/)
    // Each tick of the value axis says its sign; the data is still the fraction.
    const plot = plots.find(p => p.data[1].some(v => v === 0.425))
    expect(plot).toBeTruthy()
    expect(plot.opts.axes[1].values(null, [0, 0.25, 0.5, 0.125, 1])).toEqual(['0%', '25%', '50%', '12.5%', '100%'])
    // A rate is as it always was.
    const rate = within(screen.getByRole('figure', { name: 'Controller/PARTS_PER_HOUR (COUNT/HOUR)' }))
    expect(rate.getByText(/^Latest 50 COUNT[/]HOUR · /)).toBeInTheDocument()
  })

  it('offers only the derived metrics whose inputs the device reports', async () => {
    await visit(`/history/device/${PRESS2}?range=24h`)
    await screen.findByRole('figure', { name: 'Controller/PARTS_PER_HOUR (COUNT/HOUR)' })
    expect(screen.queryByRole('figure', { name: /^Controller[/]UPTIME/ })).not.toBeInTheDocument()
    expect(api.readDerivedSeries.mock.calls[0][0].metricNames).toEqual([RATE])
  })

  it('offers none to a device that reports no input, and reads none', async () => {
    await visit(`/history/device/${LATHE}?range=24h`)
    await screen.findByRole('figure', { name: 'Spindle/LOAD (kW)' })
    expect(screen.getAllByRole('figure')).toHaveLength(1)
    expect(api.readDerivedSeries).not.toHaveBeenCalled()
  })

  it('tags a derived metric in the Metrics filter', async () => {
    await visit(`/history/device/${PRESS2}?range=24h`)
    await screen.findAllByRole('figure')
    fireEvent.click(screen.getByRole('button', { name: /^Metrics: / }))
    const panel = await screen.findByRole('dialog', { name: 'Metrics' })
    const options = [...panel.querySelectorAll('.filter-checklist-option')].map(o => o.textContent)
    expect(options).toEqual(['Controller/PART_COUNT', 'Controller/PARTS_PER_HOUR Derived'])
  })

  it('says a window too long for a derived metric in its chart, and still draws the measured ones', async () => {
    await visit(`/history/device/${PRESS1}?span=year&at=2025-01-01`)
    await screen.findByRole('figure', { name: 'Controller/PART_COUNT (COUNT)' })
    const figure = screen.getByRole('figure', { name: 'Controller/PARTS_PER_HOUR (COUNT/HOUR)' })
    expect(within(figure).getByText(/computed from the minutes, and this window has too many of them/)).toBeInTheDocument()
    expect(api.readDerivedSeries).not.toHaveBeenCalled()
  })

  it('leaves a derived metric out of Export and says why, where it is chosen', async () => {
    await visit(`/history/device/${PRESS2}?range=24h`)
    await screen.findAllByRole('figure')
    const button = screen.getByRole('button', { name: /Export CSV/ })
    expect(button).not.toBeDisabled()
    expect(button).toHaveAccessibleDescription(expect.stringContaining(DERIVED_EXPORT_NOTE))
    fireEvent.click(button)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Controller/PART_COUNT')).toBeInTheDocument()
    expect(within(dialog).queryByText(RATE)).not.toBeInTheDocument()
    expect(within(dialog).getByText(DERIVED_EXPORT_NOTE)).toBeInTheDocument()
  })

  it('has nothing to export when only a derived metric is chosen', async () => {
    await visit(`/history/device/${PRESS2}?range=24h&metric=${encodeURIComponent(RATE)}`)
    await screen.findByRole('figure', { name: 'Controller/PARTS_PER_HOUR (COUNT/HOUR)' })
    const button = screen.getByRole('button', { name: /Export CSV/ })
    expect(button).toBeDisabled()
    expect(button).toHaveAccessibleDescription(DERIVED_EXPORT_NOTE)
  })
})

describe('the Cell tab', () => {
  it('reads the machines that report every input through derived_series(), and tags the metric', async () => {
    await visit(`/history/cell/c1?metric=${encodeURIComponent(RATE)}`)
    await waitFor(() => expect(plots.length).toBeGreaterThan(0))
    expect(api.readCarriedTelemetry).not.toHaveBeenCalled()
    const call = api.readDerivedSeries.mock.calls[0][0]
    expect(call.metricNames).toEqual([RATE])
    expect(call.assetIds.sort()).toEqual([telemetryKey({ asset_id: PRESS1 }), telemetryKey({ asset_id: PRESS2 })].sort())
    expect(screen.getByRole('button', { name: `Metric: ${RATE} (derived)` })).toBeInTheDocument()
    expect(screen.getByText(/is computed from other metrics. No device reports it./)).toBeInTheDocument()
  })

  it('names the machines that lack an input, and offers the derived metric of the machines that have them', async () => {
    await visit(`/history/cell/c1?metric=${encodeURIComponent(UPTIME)}`)
    await waitFor(() => expect(plots.length).toBeGreaterThan(0))
    // Press 2 does not report EXECUTION, so only Press 1 is charted.
    expect(api.readDerivedSeries.mock.calls[0][0].assetIds).toEqual([telemetryKey({ asset_id: PRESS1 })])
    expect(screen.getByText('Press 2 does not report Controller/UPTIME.')).toBeInTheDocument()
  })

  it('lists the derived metrics in the metric list, tagged', async () => {
    await visit('/history/cell/c1')
    await waitFor(() => expect(api.readCarriedTelemetry).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: /^Metric: / }))
    const list = within(await screen.findByRole('dialog', { name: 'Choose a metric' })).getAllByRole('link')
    expect(list.map(l => l.textContent.replace(/\s+/g, ' ')).some(t => t.startsWith('Controller/PARTS_PER_HOUR') && t.includes('Derived') && t.endsWith('2 of 2 machines'))).toBe(true)
  })

  it('says a derived metric has no mean at each hour, and reads no hours', async () => {
    await visit(`/history/cell/c1?metric=${encodeURIComponent(RATE)}`)
    expect(await screen.findByText(/is a derived metric, computed over a stretch of time, so it has no mean at each hour/)).toBeInTheDocument()
    expect(api.readHourOfDay).not.toHaveBeenCalled()
  })

  it('has nothing to export: the button says so', async () => {
    await visit(`/history/cell/c1?metric=${encodeURIComponent(RATE)}`)
    await waitFor(() => expect(plots.length).toBeGreaterThan(0))
    const button = screen.getByRole('button', { name: /Export CSV/ })
    expect(button).toBeDisabled()
    expect(button).toHaveAccessibleDescription(DERIVED_EXPORT_NOTE)
  })

  it('says a window too long for the machines, and reads nothing', async () => {
    await visit(`/history/cell/c1?metric=${encodeURIComponent(RATE)}&span=year&at=2025-01-01`)
    expect(await screen.findByText(/computed from the minutes, and this window has too many of them for 2 devices/)).toBeInTheDocument()
    expect(api.readDerivedSeries).not.toHaveBeenCalled()
  })
})

describe('the Metric tab', () => {
  it('lists each derived metric with the devices that report all its inputs, and its tag', async () => {
    await visit('/history/metric')
    const table = await screen.findByRole('table', { name: /choose a metric/i })
    const rows = within(table).getAllByRole('row').slice(1).map(r => [...r.querySelectorAll('td')].map(c => c.textContent))
    expect(rows).toEqual([
      ['Controller/EXECUTION', '—', '1'],
      ['Controller/PART_COUNT', 'COUNT', '2'],
      ['Controller/PARTS_PER_HOUR Derived', 'COUNT/HOUR', '2'],
      ['Controller/UPTIME Derived', '% of the time', '1'],
      ['Spindle/LOAD', 'kW', '1'],
    ])
  })

  it('compares the derived metric across the devices that report its inputs', async () => {
    await visit(`/history/metric/${encodeURIComponent(RATE)}`)
    await waitFor(() => expect(plots.length).toBeGreaterThan(0))
    expect(api.readCarriedTelemetry).not.toHaveBeenCalled()
    const call = api.readDerivedSeries.mock.calls[0][0]
    expect(call.assetIds.sort()).toEqual([telemetryKey({ asset_id: PRESS1 }), telemetryKey({ asset_id: PRESS2 })].sort())
    expect(screen.getByRole('button', { name: `Metric: ${RATE} (derived)` })).toBeInTheDocument()
    expect(screen.getByRole('figure', { name: 'Press 1' })).toBeInTheDocument()
    expect(screen.getByRole('figure', { name: 'Press 2' })).toBeInTheDocument()
  })
})

describe('the Area tab', () => {
  it('reads the machines once and folds each cell as the group read does: the mean, and a total where every machine has a value', async () => {
    await visit(`/history/area/a1?metric=${encodeURIComponent(RATE)}`)
    await waitFor(() => expect(plots.some(p => p.data[1].slice(0, 2).join() === '150,150')).toBe(true))
    expect(api.readDerivedSeries).toHaveBeenCalledTimes(1)
    expect(api.readDerivedSeries.mock.calls[0][0].assetIds).toHaveLength(2)
    expect(screen.getByRole('button', { name: `Metric: ${RATE} (derived)` })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: /Total/ }))
    await waitFor(() => expect(plots.some(p => p.data[1].slice(0, 2).join() === '300,300')).toBe(true))
    // Not read again for the other fold.
    expect(api.readDerivedSeries).toHaveBeenCalledTimes(1)
  })

  it('withholds a cell total in a bucket where a machine has no value', async () => {
    api.readDerivedSeries.mockImplementation(async (args) => (await derived(args))
      .filter(r => !(r.asset_id === telemetryKey({ asset_id: PRESS2 }) && r.bucket_ts === derivedFirst(args))))
    await visit(`/history/area/a1?metric=${encodeURIComponent(RATE)}&agg=total`)
    await waitFor(() => expect(plots.length).toBeGreaterThan(0))
    const presses = plots.find(p => p.data[1].some(v => v === 100 || v === 300))
    // The first bucket has Press 1 only, so no total; the next two have both.
    expect(presses.data[1].slice(0, 3)).toEqual([null, 300, 300])
  })

  it("draws a cell's mean time in state as a percentage", async () => {
    await visit(`/history/area/a1?metric=${encodeURIComponent(UPTIME)}`)
    const figure = await screen.findByRole('figure', { name: 'Presses' })
    expect(within(figure).getByText(/^Latest 42[.]5% · /)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: `Metric: ${UPTIME} (derived)` })).toBeInTheDocument()
  })

  it('has no mean at each hour for a derived metric', async () => {
    await visit(`/history/area/a1?metric=${encodeURIComponent(RATE)}`)
    expect(await screen.findByText(/is a derived metric, computed over a stretch of time, so it has no mean at each hour/)).toBeInTheDocument()
    expect(api.readHourOfDay).not.toHaveBeenCalled()
  })
})

/** The first bucket's timestamp of a read, as derived() lays it. */
const derivedFirst = ({ from, bucketMinutes }) => {
  const width = bucketMinutes * 60000
  return new Date(Math.floor(Date.parse(from) / width) * width).toISOString()
}
