/**
 * The Cell tab's arithmetic: its address, the cells and metrics it offers, the resolution the row
 * cap picks for a cell's machines, the one scale its charts share, and the hour-of-day heatmap's
 * grid, shades and words. Pure, so each rule is held here; the page is in historyCellPage.test.jsx.
 */
import { describe, it, expect, vi } from 'vitest'
import { pathSegments } from '../hooks/useUrlState'
import { windowFromQuery } from '../utils/timeWindow'
import { HISTORY_MAX_ROWS, HOUR_OF_DAY_MAX_ROWS } from '../api'
import { cellHistoryUrl } from '../routes'
import {
  CELL_PATH, DEFAULT_HISTORY_WINDOW, HEAT_STEPS, HISTORY_RANGES, HISTORY_SPANS, HOURS_OF_DAY, bandRangeWords, browserTimeZone, cellAddress,
  cellHistoryPath, cellIdFrom, cellMetrics, chartSeries, defaultCellMetric, heatBands, heatCellWords, heatStep, historyCells,
  hourGrid, hourOfDayPlan, hourWords, multiplesWords, pickResolution, sharedScale, silentWords,
} from '../utils/history'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const T0 = Date.UTC(2026, 10, 2)

const device = (id, name, over = {}) => ({
  asset_id: id, asset_name: name, effective_cell_id: 'c1', location_source: 'inherited', last_birth_metrics: [], ...over,
})

describe('the Cell tab address', () => {
  it('is its own path, with the cell as its last segment', () => {
    expect(CELL_PATH).toBe('/history/cell')
    expect(cellHistoryPath('')).toBe('/history/cell')
    expect(cellHistoryPath('2b3e0c4a-0000-4000-8000-000000000001')).toBe('/history/cell/2b3e0c4a-0000-4000-8000-000000000001')
    expect(cellHistoryUrl('c 1')).toBe('/history/cell/c%201')
  })

  it('reads the cell back, and reads none from the picker or another tab', () => {
    expect(cellIdFrom(pathSegments('/history/cell/c%201'))).toBe('c 1')
    expect(cellIdFrom(pathSegments('/history/cell'))).toBe('')
    expect(cellIdFrom(pathSegments('/history/device/c1'))).toBe('')
    expect(cellIdFrom(pathSegments('/history/cell/%E0%A4%A'))).toBe('')
  })

  it('carries the window and the metric, and the metric only when one is chosen', () => {
    const win = { kind: 'calendar', span: 'week', at: '2026-11-02' }
    const address = cellAddress('c1', win, { metric: 'Spindle/LOAD' })
    expect(address).toBe('/history/cell/c1?span=week&at=2026-11-02&metric=Spindle%2FLOAD')
    const [, query] = address.split('?')
    const params = new URLSearchParams(query)
    expect(params.get('metric')).toBe('Spindle/LOAD')
    expect(windowFromQuery(params, { ranges: HISTORY_RANGES, spans: HISTORY_SPANS, fallback: DEFAULT_HISTORY_WINDOW }))
      .toEqual(windowFromQuery(new URLSearchParams('span=week&at=2026-11-02'), { ranges: HISTORY_RANGES, spans: HISTORY_SPANS, fallback: DEFAULT_HISTORY_WINDOW }))
    expect(cellAddress('c1', DEFAULT_HISTORY_WINDOW)).toBe('/history/cell/c1')
  })
})

describe('the cells and metrics the tab offers', () => {
  const cells = [
    { cell_id: 'c2', cell_name: 'Welding', area_id: 'a1' },
    { cell_id: 'c1', cell_name: 'Turning', area_id: 'a1' },
    { cell_id: 'c3', cell_name: 'Old line', area_id: null, is_archived: true },
  ]
  const areas = [{ area_id: 'a1', area_name: 'Hall B' }]

  it('lists the cells in name order, each with the machines in service in it and its area', () => {
    const devices = [
      device('d1', 'Lathe 3'),
      device('d2', 'Press 1', { is_archived: true }),
      device('d3', 'Replay', { shadow_of: 'd1' }),
      device('d4', 'Weld bot', { effective_cell_id: 'c2' }),
      device('d5', 'Loose'),
      device('d6', 'Unplaced', { effective_cell_id: null, location_source: 'unassigned' }),
    ]
    const rows = historyCells(cells, devices, areas)
    expect(rows.map(c => [c.name, c.area_name, c.is_archived, c.machines.map(d => d.asset_name)])).toEqual([
      ['Old line', null, true, []],
      ['Turning', 'Hall B', false, ['Lathe 3', 'Loose']],
      ['Welding', 'Hall B', false, ['Weld bot']],
    ])
  })

  it('names the metrics the machines report, and how many of them report each', () => {
    const machines = [
      device('d1', 'A', { last_birth_metrics: ['Spindle/LOAD', 'Coolant/TEMP'] }),
      device('d2', 'B', { last_birth_metrics: ['Spindle/LOAD'] }),
      device('d3', 'C', { last_birth_metrics: [] }),
    ]
    const metrics = cellMetrics(machines, [])
    expect(metrics).toEqual([{ name: 'Coolant/TEMP', count: 1 }, { name: 'Spindle/LOAD', count: 2 }])
    expect(defaultCellMetric(metrics)).toBe('Spindle/LOAD')
    expect(defaultCellMetric([{ name: 'B', count: 2 }, { name: 'A', count: 2 }].sort((a, b) => a.name.localeCompare(b.name)))).toBe('A')
    expect(defaultCellMetric([])).toBe('')
  })

  it('counts a metric a schema models, as the Device tab does', () => {
    const schemas = [{ schema_uuid: 's1', schema_definition: { properties: { 'Spindle/SPEED': { type: 'number' } } } }]
    const metrics = cellMetrics([device('d1', 'A', { submodel_schema_ids: ['s1'] })], schemas)
    expect(metrics).toEqual([{ name: 'Spindle/SPEED', count: 1 }])
  })

  it('words the machines that do not report it, and the line above the charts', () => {
    expect(silentWords('Press 1', 'Spindle/LOAD')).toBe('Press 1 does not report Spindle/LOAD.')
    const resolution = { words: '5-minute buckets' }
    expect(multiplesWords({ shown: 20, silent: 0, resolution })).toBe('20 machines, in 5-minute buckets')
    expect(multiplesWords({ shown: 1, silent: 1, resolution })).toBe('1 machine, in 5-minute buckets, 1 does not report it')
    expect(multiplesWords({ shown: 3, silent: 2, resolution, reads: 2, stateLine: 'text shows every change' }))
      .toBe('3 machines, in 5-minute buckets, 2 do not report it, read in 2 parts; text shows every change')
  })
})

describe('the resolution the row cap picks for a cell', () => {
  it('is the finest whose buckets times machines fit the cap', () => {
    // Last 24 hours is 1,441 one-minute buckets on the grid: 3 machines fit, 4 do not.
    const end = T0 + DAY
    expect(HISTORY_MAX_ROWS).toBe(5000)
    expect(pickResolution(T0, end, 3).id).toBe('1m')
    expect(pickResolution(T0, end, 3).perRead).toBe(3)
    expect(pickResolution(T0, end, 4).id).toBe('5m')
    // 20 machines: 288 five-minute buckets each is 5,760, over the cap, so an hour.
    expect(pickResolution(T0, end, 20).id).toBe('1h')
  })

  it('is exactly on the boundary at the cap, and one machine over it takes the next', () => {
    // 250 five-minute buckets in a window of 250 x 5 minutes: 20 machines is exactly 5,000 rows.
    const end = T0 + 250 * 5 * 60 * 1000
    expect(pickResolution(T0, end, 20).id).toBe('5m')
    expect(pickResolution(T0, end, 21).id).toBe('1h')
  })

  it('reads in parts when even a day of buckets does not fit every machine', () => {
    const year = pickResolution(T0, T0 + 365 * DAY, 20)
    expect(year.id).toBe('1d')
    expect(year.perRead).toBe(Math.floor(HISTORY_MAX_ROWS / 366))
  })
})

describe('the scale the machines share', () => {
  const series = (min, max) => ({ ...chartSeries([], []), kind: 'number', min, max, avg: min })

  it('runs from the lowest minimum to the highest maximum across every machine, padded', () => {
    const [low, high] = sharedScale([series([10, 12], [20, 22]), series([30, null], [60, null]), series([5], [8])])
    // 5 to 60, padded by 8% of 55 at each end.
    expect(low).toBeCloseTo(5 - 4.4)
    expect(high).toBeCloseTo(60 + 4.4)
  })

  it('pads a flat metric by a tenth of its value, or 1', () => {
    expect(sharedScale([series([100], [100])])).toEqual([90, 110])
    expect(sharedScale([series([0], [0])])).toEqual([-1, 1])
  })

  it('leaves out a text, a flag and a series with no number, and is null when none is a number', () => {
    expect(sharedScale([{ kind: 'state', min: [], max: [] }, { kind: 'flag', min: [0], max: [1] }, series([null], [null])])).toBeNull()
    expect(sharedScale([])).toBeNull()
    expect(sharedScale([{ kind: 'flag', min: [0], max: [1] }, series([2], [4])])[0]).toBeLessThan(2)
  })
})

describe('the hour-of-day read', () => {
  it('is checked before it is asked for: hours times machines against the function bound', () => {
    expect(HOUR_OF_DAY_MAX_ROWS).toBe(50000)
    // A cell of 20: 2,500 hours is exactly the bound, 104 days and a bit.
    expect(hourOfDayPlan(T0, T0 + 2500 * HOUR, 20)).toEqual({ hours: 2500 })
    const over = hourOfDayPlan(T0, T0 + 2501 * HOUR, 20)
    expect(over.hours).toBe(2501)
    expect(over.problem).toBe('The heatmap reads every hour of the window for each machine, so for 20 machines it covers at most 104 days. Choose a shorter window.')
  })

  it('counts the bucket the window opens in, as the function does', () => {
    expect(hourOfDayPlan(T0 + 30 * 60 * 1000, T0 + 2 * HOUR, 1).hours).toBe(2)
  })

  it('allows a Week and a Month for 20 machines, and a Year for 5', () => {
    expect(hourOfDayPlan(T0, T0 + 7 * DAY, 20).problem).toBeUndefined()
    expect(hourOfDayPlan(T0, T0 + 31 * DAY, 20).problem).toBeUndefined()
    expect(hourOfDayPlan(T0, T0 + 365 * DAY, 5).problem).toBeUndefined()
    expect(hourOfDayPlan(T0, T0 + 365 * DAY, 6).problem).toMatch(/at most 347 days/)
  })

  it('says so in words when even a day of hours is too many machines', () => {
    expect(hourOfDayPlan(T0, T0 + DAY, 2100).problem).toBe('2100 machines are too many for the heatmap. It reads every hour of the window for each machine.')
  })

  it('asks for no read of no machines', () => {
    expect(hourOfDayPlan(T0, T0 + 3650 * DAY, 0).problem).toBeUndefined()
  })

  it('reads in the browser zone, and in UTC where the browser cannot say', () => {
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
    spy.mockReturnValueOnce({ timeZone: 'Pacific/Auckland' })
    expect(browserTimeZone()).toBe('Pacific/Auckland')
    spy.mockReturnValueOnce({ timeZone: undefined })
    expect(browserTimeZone()).toBe('UTC')
    spy.mockImplementationOnce(() => { throw new Error('no Intl') })
    expect(browserTimeZone()).toBe('UTC')
    spy.mockRestore()
  })
})

describe('the heatmap grid', () => {
  const rows = [
    { asset_id: 'a', hour_of_day: 0, mean_value: 10, days: 7 },
    { asset_id: 'a', hour_of_day: 23, mean_value: 50, days: 7 },
    { asset_id: 'b', hour_of_day: 12, mean_value: 30, days: 1 },
    { asset_id: 'stranger', hour_of_day: 3, mean_value: 99, days: 1 },
    { asset_id: 'b', hour_of_day: 24, mean_value: 99, days: 1 },
    { asset_id: 'b', hour_of_day: 5, mean_value: null, days: 1 },
  ]

  it('has 24 columns for each machine asked for, 00 to 23, empty where an hour has no value', () => {
    expect(HOURS_OF_DAY).toHaveLength(24)
    expect(HOURS_OF_DAY[0]).toBe(0)
    expect(HOURS_OF_DAY[23]).toBe(23)
    const grid = hourGrid(rows, ['a', 'b', 'c'])
    expect([...grid.cells.keys()]).toEqual(['a', 'b', 'c'])
    for (const cells of grid.cells.values()) expect(cells).toHaveLength(24)
    expect(grid.cells.get('a')[0]).toEqual({ value: 10, days: 7 })
    expect(grid.cells.get('a')[23]).toEqual({ value: 50, days: 7 })
    expect(grid.cells.get('a')[5]).toBeNull()
    expect(grid.cells.get('b')[12]).toEqual({ value: 30, days: 1 })
    // A row for a machine not asked for, an hour out of range and a null mean are left out.
    expect(grid.cells.get('b')[5]).toBeNull()
    expect(grid.cells.get('c').every(c => c === null)).toBe(true)
  })

  it('has one scale across every machine: the lowest and the highest value', () => {
    expect(hourGrid(rows, ['a', 'b']).low).toBe(10)
    expect(hourGrid(rows, ['a', 'b']).high).toBe(50)
    expect(hourGrid([], ['a'])).toMatchObject({ low: null, high: null })
  })

  it('steps through the shades in equal widths, the highest value in the last', () => {
    expect(HEAT_STEPS).toBe(4)
    expect([10, 19.9, 20, 29.9, 30, 39.9, 40, 50].map(v => heatStep(v, 10, 50))).toEqual([1, 1, 2, 2, 3, 3, 4, 4])
    expect(heatStep(7, 7, 7)).toBe(1)
  })

  it('names the values each shade stands for, in words', () => {
    const bands = heatBands(10, 50)
    expect(bands).toEqual([
      { step: 1, from: 10, to: 20 }, { step: 2, from: 20, to: 30 }, { step: 3, from: 30, to: 40 }, { step: 4, from: 40, to: 50 },
    ])
    expect(bands.map(b => bandRangeWords(b, 'kW'))).toEqual(['10 to 20 kW', '20 to 30 kW', '30 to 40 kW', '40 to 50 kW'])
    expect(heatBands(7, 7)).toEqual([{ step: 1, from: 7, to: 7 }])
    expect(bandRangeWords({ step: 1, from: 7, to: 7 }, 'kW')).toBe('7 kW')
    expect(heatBands(null, null)).toEqual([])
  })

  it('reads a cell in words: the machine, the hour and the value, and what it is the mean of', () => {
    expect(hourWords(0)).toBe('00:00–01:00')
    expect(hourWords(14)).toBe('14:00–15:00')
    expect(hourWords(23)).toBe('23:00–00:00')
    expect(heatCellWords('Lathe 3', 14, { value: 21.34, days: 7 }, 'kW')).toBe('Lathe 3 · 14:00–15:00 · 21.34 kW, the mean of 7 days')
    expect(heatCellWords('Lathe 3', 14, { value: 21.34, days: 1 })).toBe('Lathe 3 · 14:00–15:00 · 21.34, the mean of 1 day')
    expect(heatCellWords('Lathe 3', 3, null, 'kW')).toBe('Lathe 3 · 03:00–04:00 · No value in this window')
  })
})
