/**
 * The Metric and Area tabs' arithmetic: their addresses, the metrics, devices and areas they offer,
 * the filters, the row cap and the paging boundary, the mean and total of a cell, the words for a
 * total withheld, and the heatmap's grid of cells. Pure, so each rule is held here; the pages are in
 * historyMetricPage.test.jsx and historyAreaPage.test.jsx.
 */
import { describe, it, expect } from 'vitest'
import { pathSegments } from '../hooks/useUrlState'
import { windowFromQuery } from '../utils/timeWindow'
import { HISTORY_GROUP_READ_ROWS, HISTORY_MAX_ROWS } from '../api'
import { areaHistoryUrl } from '../routes'
import {
  AGG_MODES, AREA_PATH, DEFAULT_AGG, DEFAULT_HISTORY_WINDOW, HISTORY_RANGES, HISTORY_SPANS, METRIC_DRAW_MAX, METRIC_PAGE_SIZE,
  METRIC_PATH, areaAddress, areaHistoryPath, areaIdFrom, bucketCount, bucketStarts, cellHourGrid, cellsWords, chartAddress,
  groupSeries, heatCellWords, historyAreas, historyCells, historyDevices, historyMetrics, hourGrid, metricAddress, metricDevices,
  metricHistoryPath, metricNameFrom, metricPages, multiplesWords, pageFrom, pagingWords, pickGroupResolution, pickResolution,
  pickedAddress, silentCellWords, telemetryKey, withheldRuns, withheldWords,
} from '../utils/history'

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const T0 = Date.UTC(2026, 10, 2)

const device = (id, name, over = {}) => ({
  asset_id: id, asset_name: name, effective_cell_id: 'c1', location_source: 'inherited', last_birth_metrics: [], ...over,
})
const WINDOW_OPTS = { ranges: HISTORY_RANGES, spans: HISTORY_SPANS, fallback: DEFAULT_HISTORY_WINDOW }

describe('the Metric tab address', () => {
  it('is its own path, with the metric as its last segment, its slashes encoded', () => {
    expect(METRIC_PATH).toBe('/history/metric')
    expect(metricHistoryPath('')).toBe('/history/metric')
    expect(metricHistoryPath('Spindle/LOAD')).toBe('/history/metric/Spindle%2FLOAD')
  })

  it('reads the metric back, and reads none from the picker or another tab', () => {
    expect(metricNameFrom(pathSegments('/history/metric/Spindle%2FLOAD'))).toBe('Spindle/LOAD')
    expect(metricNameFrom(pathSegments('/history/metric'))).toBe('')
    expect(metricNameFrom(pathSegments('/history/cell/Spindle%2FLOAD'))).toBe('')
    expect(metricNameFrom(pathSegments('/history/metric/%E0%A4%A'))).toBe('')
  })

  it('carries the window, the area, cell and device lists, and the page only when it is not the first', () => {
    const win = { kind: 'calendar', span: 'week', at: '2026-11-02' }
    const address = metricAddress('Spindle/LOAD', win, { areas: ['a1', 'a2'], cells: ['c1'], devices: ['dev1', 'dev2'], page: 3 })
    expect(address).toBe('/history/metric/Spindle%2FLOAD?span=week&at=2026-11-02&area=a1,a2&cell=c1&devices=dev1,dev2&page=3')
    const params = new URLSearchParams(address.split('?')[1])
    expect(windowFromQuery(params, WINDOW_OPTS)).toEqual(windowFromQuery(new URLSearchParams('span=week&at=2026-11-02'), WINDOW_OPTS))
    expect(metricAddress('Spindle/LOAD', DEFAULT_HISTORY_WINDOW, { page: 1 })).toBe('/history/metric/Spindle%2FLOAD')
    expect(metricAddress('', DEFAULT_HISTORY_WINDOW, { devices: ['dev1'] })).toBe('/history/metric?devices=dev1')
  })

  it('reads a page number as a whole number from 1', () => {
    expect([null, '', '1', '0', '-2', '2', '2.5', 'x', '7'].map(pageFrom)).toEqual([1, 1, 1, 1, 1, 2, 1, 1, 7])
  })
})

describe('the metrics and devices the Metric tab offers', () => {
  const cells = [{ cell_id: 'c1', cell_name: 'Turning', area_id: 'a1' }, { cell_id: 'c2', cell_name: 'Welding', area_id: 'a2' }]
  const areas = [{ area_id: 'a1', area_name: 'Hall B' }, { area_id: 'a2', area_name: 'Hall C' }]
  const uuid = (n) => `2b3e0c4a-000${n}-4000-8000-00000000000${n}`
  const raw = [
    device(uuid(1), 'Lathe 3', { last_birth_metrics: ['Spindle/LOAD', 'Coolant/TEMP'] }),
    device(uuid(2), 'Lathe 4', { effective_cell_id: 'c2', last_birth_metrics: ['Spindle/LOAD'] }),
    device(uuid(3), 'Press 1', { is_archived: true, last_birth_metrics: ['Spindle/LOAD'] }),
    device(uuid(4), 'Held', { is_quarantined: true, last_birth_metrics: ['Spindle/LOAD'] }),
    device(uuid(5), 'Loose', { effective_cell_id: null, location_source: 'unassigned', last_birth_metrics: ['Spindle/LOAD'] }),
  ]
  const devices = historyDevices(raw, cells, areas)

  it('gives each History device the ids of its cell and area, which the filters use', () => {
    const byName = Object.fromEntries(devices.map(d => [d.asset_name, d]))
    expect([byName['Lathe 3'].cell_id, byName['Lathe 3'].area_id]).toEqual(['c1', 'a1'])
    expect([byName['Lathe 4'].cell_id, byName['Lathe 4'].area_id]).toEqual(['c2', 'a2'])
    expect([byName.Loose.cell_id, byName.Loose.area_id]).toEqual([null, null])
  })

  it('lists each metric some device in service reports, with how many do and the catalog\'s unit and kind', () => {
    const catalog = [{ name: 'Spindle/LOAD', units: 'kW', datatype: 10 }, { name: 'Controller/EXECUTION', datatype: 12 }]
    expect(historyMetrics(devices, [], catalog)).toEqual([
      { name: 'Coolant/TEMP', count: 1, unit: null, kind: null },
      { name: 'Spindle/LOAD', count: 3, unit: 'kW', kind: 'number' },
    ])
    // A metric no device reports is not offered, whatever the catalog holds.
    expect(historyMetrics(devices, [], catalog).map(m => m.name)).not.toContain('Controller/EXECUTION')
    expect(historyMetrics([], [], catalog)).toEqual([])
  })

  it('finds the devices in service that report the metric, wherever they sit', () => {
    expect(metricDevices(devices, [], 'Spindle/LOAD').map(d => d.asset_name)).toEqual(['Lathe 3', 'Lathe 4', 'Loose'])
    expect(metricDevices(devices, [], 'Coolant/TEMP').map(d => d.asset_name)).toEqual(['Lathe 3'])
    expect(metricDevices(devices, [], 'Nothing/HERE')).toEqual([])
  })

  it('narrows by area, by cell and by a list of telemetry keys, each only when it is given', () => {
    const names = (opts) => metricDevices(devices, [], 'Spindle/LOAD', opts).map(d => d.asset_name)
    expect(names({ areas: ['a1'] })).toEqual(['Lathe 3'])
    expect(names({ areas: ['a1', 'a2'] })).toEqual(['Lathe 3', 'Lathe 4'])
    expect(names({ cells: ['c2'] })).toEqual(['Lathe 4'])
    expect(names({ areas: ['a1'], cells: ['c2'] })).toEqual([])
    const lathe4 = devices.find(d => d.asset_name === 'Lathe 4')
    const loose = devices.find(d => d.asset_name === 'Loose')
    expect(names({ keys: [telemetryKey(lathe4), telemetryKey(loose)] })).toEqual(['Lathe 4', 'Loose'])
    expect(names({ keys: ['dev000000000000000000000'] })).toEqual([])
  })
})

describe('the row cap and the paging boundary', () => {
  const at = (days, devicesCount, page) => metricPages(T0, T0 + days * DAY, devicesCount, page)

  it('draws every device in one page while one read carries them at some resolution', () => {
    const one = at(1, 20)
    expect(one).toMatchObject({ paged: false, page: 1, pages: 1, from: 0, to: 20 })
    // 20 devices over a day: 1,441 minute buckets and 289 five-minute ones are past the cap, an hour fits.
    expect(one.resolution.id).toBe('1h')
    expect(one.resolution.perRead).toBe(20)
  })

  it('pages once the cap cannot carry the devices even at the coarsest resolution, METRIC_PAGE_SIZE to a page', () => {
    const buckets = bucketCount(T0, T0 + 365 * DAY, 1440)
    const fits = Math.floor(HISTORY_MAX_ROWS / buckets)
    expect(fits).toBe(13)
    expect(at(365, fits).paged).toBe(false)
    const over = at(365, fits + 1)
    expect(over).toMatchObject({ paged: true, page: 1, pages: 2, from: 0, to: METRIC_PAGE_SIZE, size: METRIC_PAGE_SIZE })
    expect(at(365, fits + 1, 2)).toMatchObject({ page: 2, from: METRIC_PAGE_SIZE, to: fits + 1 })
  })

  it('reads a page at the finest resolution its own devices fit, which is finer than the whole set would get', () => {
    const page = at(1, 1000, 1)
    expect(page.paged).toBe(true)
    expect(page.resolution.id).toBe('5m')
    expect(pickResolution(T0, T0 + DAY, 1000).id).toBe('1d')
  })

  it('pages past METRIC_DRAW_MAX devices even where the cap would carry them all', () => {
    expect(at(1, METRIC_DRAW_MAX).paged).toBe(false)
    expect(at(1, METRIC_DRAW_MAX + 1).paged).toBe(true)
    expect(at(1, 1000)).toMatchObject({ paged: true, pages: Math.ceil(1000 / METRIC_PAGE_SIZE) })
  })

  it('keeps a page number inside the pages there are', () => {
    expect(at(1, 1000, 0).page).toBe(1)
    expect(at(1, 1000, 9999).page).toBe(Math.ceil(1000 / METRIC_PAGE_SIZE))
    expect(at(1, 1000, 9999).to).toBe(1000)
    expect(at(1, 1000, 2.5).page).toBe(2)
  })

  it('says it has no resolution when one device does not fit even at a day', () => {
    expect(at(HISTORY_MAX_ROWS + 10, 3).resolution).toBeNull()
    expect(at(1, 0).resolution).not.toBeNull()
  })

  it('says why the devices come a page at a time, and which', () => {
    expect(pagingWords({ total: 57, from: 12, to: 24, size: 12 }))
      .toBe('57 devices are too many to chart at once, so they come 12 to a page: devices 13 to 24.')
  })

  it('words the line above the devices\' charts in devices', () => {
    expect(multiplesWords({ shown: 20, silent: 0, resolution: { words: '1-hour buckets' }, noun: 'device' })).toBe('20 devices, in 1-hour buckets')
    expect(multiplesWords({ shown: 1, silent: 0, resolution: { words: '1-hour buckets' }, noun: 'device' })).toBe('1 device, in 1-hour buckets')
  })
})

describe("Chart in Overview's selection box", () => {
  const lathe = device('2b3e0c4a-0001-4000-8000-000000000001', 'Lathe 3', { last_birth_metrics: ['Spindle/LOAD', 'Spindle/SPEED'] })
  const mill = device('2b3e0c4a-0002-4000-8000-000000000002', 'Mill 2', { last_birth_metrics: ['Spindle/LOAD', 'Coolant/TEMP'] })
  const press = device('2b3e0c4a-0003-4000-8000-000000000003', 'Press 1', { last_birth_metrics: ['Coolant/TEMP'] })
  const win = { kind: 'calendar', span: 'day', at: '2026-11-02' }

  it('opens the Device tab for one device, as it did', () => {
    expect(chartAddress([lathe], [], win)).toBe(pickedAddress(telemetryKey(lathe), win))
  })

  it('opens the Metric tab, narrowed to the devices, on the metric most of them report', () => {
    const keys = [lathe, mill, press].map(telemetryKey).join(',')
    expect(chartAddress([lathe, mill, press], [], win)).toBe(`/history/metric/Coolant%2FTEMP?span=day&at=2026-11-02&devices=${keys}`)
    expect(chartAddress([lathe, mill], [], win)).toBe(`/history/metric/Spindle%2FLOAD?span=day&at=2026-11-02&devices=${[lathe, mill].map(telemetryKey).join(',')}`)
  })

  it('opens the picker, narrowed to them, when none reports any metric', () => {
    const a = device('2b3e0c4a-0004-4000-8000-000000000004', 'A')
    const b = device('2b3e0c4a-0005-4000-8000-000000000005', 'B')
    expect(chartAddress([a, b], [], win)).toBe(`/history/metric?span=day&at=2026-11-02&devices=${[a, b].map(telemetryKey).join(',')}`)
  })
})

describe('the Area tab address', () => {
  it('is its own path, with the area as its last segment', () => {
    expect(AREA_PATH).toBe('/history/area')
    expect(areaHistoryPath('')).toBe('/history/area')
    expect(areaHistoryPath('a 1')).toBe('/history/area/a%201')
    expect(areaHistoryUrl('a 1')).toBe(areaHistoryPath('a 1'))
  })

  it('reads the area back, and reads none from the picker or another tab', () => {
    expect(areaIdFrom(pathSegments('/history/area/a%201'))).toBe('a 1')
    expect(areaIdFrom(pathSegments('/history/area'))).toBe('')
    expect(areaIdFrom(pathSegments('/history/cell/a1'))).toBe('')
  })

  it('carries the window, the metric, and the mean or total only when it is not the mean', () => {
    expect(AGG_MODES).toEqual(['mean', 'total'])
    expect(DEFAULT_AGG).toBe('mean')
    const win = { kind: 'calendar', span: 'week', at: '2026-11-02' }
    expect(areaAddress('a1', win, { metric: 'Spindle/LOAD', agg: 'total' })).toBe('/history/area/a1?span=week&at=2026-11-02&metric=Spindle%2FLOAD&agg=total')
    expect(areaAddress('a1', win, { metric: 'Spindle/LOAD', agg: 'mean' })).toBe('/history/area/a1?span=week&at=2026-11-02&metric=Spindle%2FLOAD')
    expect(areaAddress('a1', DEFAULT_HISTORY_WINDOW)).toBe('/history/area/a1')
  })
})

describe('the areas the Area tab offers', () => {
  const areas = [
    { area_id: 'a2', area_name: 'Hall C' },
    { area_id: 'a1', area_name: 'Hall B' },
    { area_id: 'a3', area_name: 'Old hall', is_archived: true },
  ]
  const cells = [
    { cell_id: 'c1', cell_name: 'Turning', area_id: 'a1' },
    { cell_id: 'c2', cell_name: 'Welding', area_id: 'a1' },
    { cell_id: 'c3', cell_name: 'Press line', area_id: 'a2' },
    { cell_id: 'c4', cell_name: 'Retired line', area_id: 'a1', is_archived: true },
  ]

  it('lists the areas in name order, each with the cells in service and their machines', () => {
    const devices = [
      device('d1', 'Lathe 3'), device('d2', 'Lathe 4'), device('d3', 'Weld bot', { effective_cell_id: 'c2' }),
      device('d4', 'Press', { effective_cell_id: 'c3' }),
      device('d5', 'Area-wide meter', { effective_cell_id: null, location_source: 'area_wide', effective_area_id: 'a1' }),
    ]
    const rows = historyAreas(areas, historyCells(cells, devices, areas))
    expect(rows.map(a => [a.name, a.is_archived, a.cells.map(c => c.name), a.machines.map(d => d.asset_name)])).toEqual([
      ['Hall B', false, ['Turning', 'Welding'], ['Lathe 3', 'Lathe 4', 'Weld bot']],
      ['Hall C', false, ['Press line'], ['Press']],
      ['Old hall', true, [], []],
    ])
  })

  it('gives each History cell the id of its area', () => {
    expect(historyCells(cells, [], areas).map(c => [c.name, c.area_id])).toEqual([
      ['Press line', 'a2'], ['Retired line', 'a1'], ['Turning', 'a1'], ['Welding', 'a1'],
    ])
  })
})

describe('the resolution an area is read at', () => {
  it('is the finest whose cells times buckets fit the row cap and whose machines times buckets fit the read bound', () => {
    expect(HISTORY_GROUP_READ_ROWS).toBe(50000)
    // 4 cells of 5 machines: a Day is 5-minute buckets (289 x 20 = 5,780 read, 1,156 returned), not minutes
    // (1,441 x 4 = 5,764 returned, past the cap) and not the hour the same machines would get as series.
    expect(pickGroupResolution(T0, T0 + DAY, 20, 4).id).toBe('5m')
    expect(pickResolution(T0, T0 + DAY, 20).id).toBe('1h')
    expect(pickGroupResolution(T0, T0 + 7 * DAY, 20, 4).id).toBe('1h')
    expect(pickGroupResolution(T0, T0 + 30 * DAY, 20, 4).id).toBe('1h')
    expect(pickResolution(T0, T0 + 30 * DAY, 20).id).toBe('1d')
  })

  it('is limited by the machines read when the cells returned would fit', () => {
    // 100 machines in 2 cells over a Day: minutes are 1,441 x 2 returned, but 144,100 read, so 5 minutes.
    expect(pickGroupResolution(T0, T0 + DAY, 100, 2).id).toBe('5m')
    expect(pickGroupResolution(T0, T0 + 30 * DAY, 100, 2).id).toBe('1d')
  })

  it('is null when not even a day fits, and counts at least one of each', () => {
    expect(pickGroupResolution(T0, T0 + 365 * DAY, 200, 4)).toBeNull()
    expect(pickGroupResolution(T0, T0 + DAY, 0, 0).id).toBe('1m')
  })
})

describe("a cell's mean and total", () => {
  const starts = bucketStarts(T0, T0 + 5 * 5 * MINUTE, 5)
  const row = (i, over = {}) => ({
    bucket_ts: new Date(T0 + i * 5 * MINUTE).toISOString(), mean_double: 10 + i, total_double: 50 + i, members: 5, with_value: 5, measured: 3, ...over,
  })

  it('lays the mean on the buckets, empty where the function returned no row', () => {
    const series = groupSeries([row(0), row(1), row(3)], starts, 'mean')
    expect(series.kind).toBe('number')
    expect(series.avg).toEqual([10, 11, null, 13, null])
    // A line only: its band is its value, so the shared scale is the lowest to the highest value.
    expect(series.min).toEqual(series.avg)
    expect(series.max).toEqual(series.avg)
    expect(series.withheld).toEqual([false, false, false, false, false])
  })

  it('lays the total on the buckets, and withholds it where a machine had no value', () => {
    const series = groupSeries([row(0), row(1, { total_double: null, with_value: 4 }), row(2), row(4, { total_double: null, with_value: 2 })], starts, 'total')
    expect(series.avg).toEqual([50, null, 52, null, null])
    expect(series.withheld).toEqual([false, true, false, false, true])
    // The mean is there in the same buckets, over the machines that had a value.
    expect(groupSeries([row(1, { total_double: null, with_value: 4 })], starts, 'mean').avg[1]).toBe(11)
  })

  it('carries a bucket in which no machine had a reading', () => {
    const series = groupSeries([row(0, { measured: 0 }), row(1, { measured: 1 })], starts, 'mean')
    expect(series.carried).toEqual([true, false, false, false, false])
  })

  it('is a series of nothing when no row came back, or every total was withheld', () => {
    expect(groupSeries([], starts, 'mean').kind).toBe('none')
    expect(groupSeries([row(0, { total_double: null }), row(1, { total_double: null })], starts, 'total').kind).toBe('none')
  })

  it('finds the stretches a total was withheld in, and says where in words', () => {
    expect(withheldRuns([false, true, true, false, true])).toEqual([{ from: 1, to: 3 }, { from: 4, to: 5 }])
    expect(withheldRuns([false, false])).toEqual([])
    const hours = bucketStarts(T0, T0 + 6 * HOUR, 60)
    expect(withheldWords([false, false, false, false, false, false, false], hours, 60)).toBeNull()
    const one = withheldWords([false, true, true, false, false, false, false], hours, 60)
    expect(one).toMatch(/^withheld from .+ to .+, where a machine had no value$/)
    const two = withheldWords([false, true, false, true, false, false, false], hours, 60)
    expect(two).toMatch(/^withheld in 2 stretches, the first from .+ to .+, where a machine had no value$/)
  })

  it('words the line above the cells\' charts, and a cell that has no machine reporting the metric', () => {
    const resolution = { words: '5-minute buckets' }
    expect(cellsWords({ shown: 4, silent: 0, agg: 'mean', resolution })).toBe('4 cells, each the mean of its machines that have a value, in 5-minute buckets')
    expect(cellsWords({ shown: 1, silent: 1, agg: 'total', resolution, areaWide: 2 }))
      .toBe('1 cell, each the total of its machines, withheld where one has no value, in 5-minute buckets, 1 does not report it; 2 devices are Area-Wide, in no cell, so not charted')
    expect(silentCellWords('Welding', 'Spindle/LOAD')).toBe('None of the machines in Welding reports Spindle/LOAD.')
  })
})

describe("the Area tab's heatmap grid", () => {
  const machines = hourGrid([
    { asset_id: 'a', hour_of_day: 0, mean_value: 10, days: 7 },
    { asset_id: 'b', hour_of_day: 0, mean_value: 30, days: 7 },
    { asset_id: 'b', hour_of_day: 5, mean_value: 40, days: 3 },
    { asset_id: 'c', hour_of_day: 0, mean_value: 100, days: 7 },
  ], ['a', 'b', 'c', 'd'])

  it('has a row a cell: the mean of its machines that have a value at each hour', () => {
    const grid = cellHourGrid(machines, [{ key: 'c1', keys: ['a', 'b'] }, { key: 'c2', keys: ['c', 'd'] }])
    expect([...grid.cells.keys()]).toEqual(['c1', 'c2'])
    expect(grid.cells.get('c1')[0]).toEqual({ value: 20, days: 7, machines: 2 })
    // Only one machine had a value at five o'clock.
    expect(grid.cells.get('c1')[5]).toEqual({ value: 40, days: 3, machines: 1 })
    expect(grid.cells.get('c1')[6]).toBeNull()
    expect(grid.cells.get('c2')[0]).toEqual({ value: 100, days: 7, machines: 1 })
  })

  it('has one scale across every cell, and no row for a cell nothing has a value for', () => {
    const grid = cellHourGrid(machines, [{ key: 'c1', keys: ['a', 'b'] }, { key: 'c2', keys: ['c'] }, { key: 'c3', keys: ['d'] }, { key: 'c4', keys: [] }])
    expect([...grid.cells.keys()]).toEqual(['c1', 'c2'])
    expect([grid.low, grid.high]).toEqual([20, 100])
    expect(cellHourGrid(machines, [])).toEqual({ cells: new Map(), low: null, high: null })
  })

  it('says how many machines a cell hour is the mean of', () => {
    expect(heatCellWords('Turning', 14, { value: 20, days: 7, machines: 5 }, 'kW')).toBe('Turning · 14:00–15:00 · 20 kW, the mean of 7 days, across 5 machines')
    expect(heatCellWords('Lathe 3', 14, { value: 20, days: 1 }, 'kW')).toBe('Lathe 3 · 14:00–15:00 · 20 kW, the mean of 1 day')
    expect(heatCellWords('Turning', 14, { value: 20, days: 7, machines: 1 }, 'kW')).toBe('Turning · 14:00–15:00 · 20 kW, the mean of 7 days')
  })
})
