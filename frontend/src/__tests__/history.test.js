import { describe, it, expect } from 'vitest'
import { HISTORY_MAX_ROWS, HISTORY_RESOLUTIONS } from '../api'
import { pathSegments } from '../hooks/useUrlState'
import { windowFromQuery, windowToQuery } from '../utils/timeWindow'
import {
  DEFAULT_HISTORY_WINDOW, HISTORY_RANGES, HISTORY_SPANS, bucketCount, bucketStarts, chartPalette, chartSeries, chartSummary,
  deviceHistoryPath, deviceMatches, deviceMetrics, historyDevices, historyPath, inReads, nowFraction, pickResolution,
  pickedAddress, splitCarried, validRangeWords, validRanges, withAlpha,
} from '../utils/history'
import { deviceHistoryUrl } from '../routes'

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
// A Monday at midnight UTC, on every bucket grid.
const T0 = Date.UTC(2026, 10, 2)

describe('the resolution the row cap picks', () => {
  it('names the resolutions finest first, as History offers them, under the telemetry routes\' cap', () => {
    expect(HISTORY_RESOLUTIONS.map(r => r.id)).toEqual(['1m', '5m', '1h', '1d'])
    expect(HISTORY_RESOLUTIONS.map(r => r.minutes)).toEqual([1, 5, 60, 1440])
    expect(HISTORY_RESOLUTIONS.map(r => r.words)).toEqual(['1-minute buckets', '5-minute buckets', '1-hour buckets', '1-day buckets'])
    expect(HISTORY_MAX_ROWS).toBe(5000)
  })

  it('counts the bucket a window opens inside, as the read lays them on the epoch grid', () => {
    expect(bucketCount(T0, T0 + DAY, 5)).toBe(288)
    expect(bucketCount(T0 + 3 * MINUTE, T0 + DAY, 5)).toBe(288)
    expect(bucketCount(T0 + 3 * MINUTE, T0 + DAY + 3 * MINUTE, 5)).toBe(289)
  })

  it('takes the finest whose rows, buckets times series, fit', () => {
    // #319's Cell view: 20 devices over 24 hours are 28,800 rows at 1 minute and 5,760 at 5.
    expect(pickResolution(T0, T0 + DAY, 20)).toMatchObject({ id: '1h', perRead: 20 })
    expect(pickResolution(T0, T0 + DAY, 3)).toMatchObject({ id: '1m', perRead: 3 })
    expect(pickResolution(T0, T0 + DAY, 4)).toMatchObject({ id: '5m', perRead: 4 })
    expect(pickResolution(T0, T0 + DAY, 15)).toMatchObject({ id: '5m', perRead: 15 })
    expect(pickResolution(T0, T0 + 7 * DAY, 15)).toMatchObject({ id: '1h', perRead: 15 })
    expect(pickResolution(T0, T0 + 31 * DAY, 15)).toMatchObject({ id: '1d', perRead: 15 })
  })

  it('takes exactly the cap, and no row over it', () => {
    expect(pickResolution(T0, T0 + 5000 * MINUTE, 1)).toMatchObject({ id: '1m' })
    expect(pickResolution(T0, T0 + 5001 * MINUTE, 1)).toMatchObject({ id: '5m' })
  })

  it('reads the series in parts at the coarsest when no resolution fits them all', () => {
    // A year of 15 metrics is 5,475 day buckets: two reads of up to 13.
    const year = pickResolution(T0, T0 + 365 * DAY, 15)
    expect(year).toMatchObject({ id: '1d', perRead: 13 })
    expect(inReads(Array.from({ length: 15 }, (_, i) => `m${i}`), year.perRead).map(r => r.length)).toEqual([13, 2])
  })

  it('refuses a window one series cannot fit even in day buckets', () => {
    expect(pickResolution(T0, T0 + 5001 * DAY, 1)).toBeNull()
  })
})

describe("History's address", () => {
  it('names the device in the path and the window in the query, and reads both back', () => {
    const win = { kind: 'calendar', span: 'week', at: '2026-11-02' }
    const address = pickedAddress('2b3e0c4a-0000-4000-8000-000000000001', win)
    expect(address).toBe('/history/device/2b3e0c4a-0000-4000-8000-000000000001?span=week&at=2026-11-02')
    const [path, query] = address.split('?')
    expect(historyPath(pathSegments(path))).toEqual({ tab: 'device', deviceId: '2b3e0c4a-0000-4000-8000-000000000001' })
    expect(windowFromQuery(new URLSearchParams(query), { ranges: HISTORY_RANGES, spans: HISTORY_SPANS, fallback: DEFAULT_HISTORY_WINDOW }))
      .toEqual(win)
  })

  it('writes no window when it is the one History opens on, Last 24 hours', () => {
    expect(DEFAULT_HISTORY_WINDOW).toMatchObject({ kind: 'rolling', range: '24h' })
    expect(pickedAddress('dev0123', DEFAULT_HISTORY_WINDOW)).toBe('/history/device/dev0123')
    expect(Object.values(windowToQuery(DEFAULT_HISTORY_WINDOW, DEFAULT_HISTORY_WINDOW)).filter(Boolean)).toEqual([])
    expect(pickedAddress('', { kind: 'rolling', range: '7d', ms: 7 * DAY, label: 'Last 7 days' })).toBe('/history?range=7d')
  })

  it('reads the picker from any path that names no device', () => {
    for (const path of ['/history', '/history/device', '/history/elsewhere/x']) {
      expect(historyPath(pathSegments(path)), path).toEqual({ tab: 'device', deviceId: '' })
    }
  })

  it('offers every rolling range and span, and no All time', () => {
    expect(HISTORY_SPANS).toEqual(['day', 'week', 'month', 'year'])
    expect(HISTORY_RANGES.map(r => r.value)).not.toContain('all')
    expect(windowFromQuery(new URLSearchParams('range=all'), { ranges: HISTORY_RANGES, fallback: DEFAULT_HISTORY_WINDOW }))
      .toBe(DEFAULT_HISTORY_WINDOW)
  })

  it('is the address the device drawer links to', () => {
    expect(deviceHistoryUrl('2b3e0c4a-0000-4000-8000-000000000001')).toBe(deviceHistoryPath('2b3e0c4a-0000-4000-8000-000000000001'))
  })
})

describe('the device picker', () => {
  const cells = [{ cell_id: 'c1', name: 'Press line', area_id: 'a1' }]
  const areas = [{ area_id: 'a1', name: 'Hall B' }]
  const devices = [
    { asset_id: '00000000-0000-4000-8000-0000000000b2', asset_name: 'Lathe 2', effective_cell_id: 'c1' },
    { asset_id: '00000000-0000-4000-8000-0000000000a1', asset_name: 'Air compressor', effective_area_id: 'a1' },
    { asset_id: '00000000-0000-4000-8000-0000000000c3', asset_name: 'Unknown box', is_quarantined: true },
  ]

  it('offers every device but a quarantined one, by name, with its cell and area', () => {
    const shown = historyDevices(devices, cells, areas)
    expect(shown.map(d => [d.asset_name, d.cell_name, d.area_name])).toEqual([
      ['Air compressor', null, 'Hall B'],
      ['Lathe 2', 'Press line', 'Hall B'],
    ])
  })

  it('finds a device by its name, its Sparkplug id, its cell or its area', () => {
    const [compressor, lathe] = historyDevices(devices, cells, areas)
    expect(deviceMatches(lathe, 'lathe')).toBe(true)
    expect(deviceMatches(lathe, 'press')).toBe(true)
    expect(deviceMatches(lathe, 'dev000000000000400080000')).toBe(true)
    expect(deviceMatches(compressor, 'hall b')).toBe(true)
    expect(deviceMatches(compressor, 'lathe')).toBe(false)
    expect(deviceMatches(compressor, '  ')).toBe(true)
  })

  it('charts what the last birth declared and what the schemas model, and their valid ranges', () => {
    const schemas = [{
      schema_uuid: 's1',
      schema_definition: { properties: { 'Spindle/LOAD': { type: 'number', minimum: 0, maximum: 120 }, 'Axis/X': { type: 'number' } } },
    }]
    const device = { asset_id: 'd', last_birth_metrics: ['Spindle/LOAD', 'Controller/EXECUTION'], submodel_schema_ids: ['s1'] }
    expect(deviceMetrics(device, schemas)).toEqual(['Axis/X', 'Controller/EXECUTION', 'Spindle/LOAD'])
    expect(validRanges(device, schemas).get('Spindle/LOAD')).toEqual({ minimum: 0, maximum: 120 })
    expect(validRanges(device, schemas).get('Axis/X')).toEqual({ minimum: null, maximum: null })
    expect(deviceMetrics({ asset_id: 'd' }, [])).toEqual([])
  })
})

describe("a chart's series", () => {
  const starts = bucketStarts(T0, T0 + 5 * MINUTE, 1)
  const row = (i, values) => ({ bucket_ts: new Date(T0 + i * MINUTE).toISOString(), ...values })

  it('lays the rows on every bucket of the window, null where there is none', () => {
    expect(starts).toEqual([0, 1, 2, 3, 4].map(i => (T0 + i * MINUTE) / 1000))
    const s = chartSeries([
      row(1, { avg_double: 5, min_double: 4, max_double: 6, n_rows: 2, is_carried: false }),
      row(2, { avg_double: 6, min_double: 6, max_double: 6, last_double: 6, n_rows: 0, is_carried: true }),
    ], starts)
    expect(s.kind).toBe('number')
    expect(s.avg).toEqual([null, 5, 6, null, null])
    expect(s.min).toEqual([null, 4, 6, null, null])
    expect(s.carried).toEqual([false, false, true, false, false])
  })

  it('draws a carried stretch dashed, meeting the solid line at the readings either side', () => {
    const { read, held } = splitCarried({ avg: [1, 2, 2, 2, 3], carried: [false, false, true, true, false] })
    expect(read).toEqual([1, 2, null, null, 3])
    expect(held).toEqual([null, 2, 2, 2, 3])
  })

  it('charts a flag as 1 and 0, and keeps a state as text', () => {
    const flags = chartSeries([row(0, { last_bool: true }), row(1, { last_bool: false, is_carried: true })], starts)
    expect(flags.kind).toBe('flag')
    expect(flags.avg.slice(0, 2)).toEqual([1, 0])
    const states = chartSeries([row(0, { last_string: 'ACTIVE' }), row(1, { last_string: 'READY' })], starts)
    expect(states.kind).toBe('state')
    expect(states.states.slice(0, 3)).toEqual(['ACTIVE', 'READY', null])
    expect(chartSeries([], starts).kind).toBe('none')
  })
})

describe('the now marker', () => {
  it('stands where now falls across the window', () => {
    expect(nowFraction(T0, T0 + DAY, T0 + 6 * HOUR)).toBe(0.25)
    expect(nowFraction(T0, T0 + DAY, T0 + 18 * HOUR)).toBe(0.75)
  })

  it('is not drawn when the window ends at or before now, or has not begun', () => {
    expect(nowFraction(T0, T0 + DAY, T0 + DAY)).toBeNull()
    expect(nowFraction(T0, T0 + DAY, T0 + 2 * DAY)).toBeNull()
    expect(nowFraction(T0, T0 + DAY, T0 - 1)).toBeNull()
    expect(nowFraction(T0, T0, T0)).toBeNull()
  })
})

describe("a chart's text for a screen reader", () => {
  const resolution = HISTORY_RESOLUTIONS[1]
  const starts = bucketStarts(T0, T0 + 4 * 5 * MINUTE, 5)
  const at = (i, values) => ({ bucket_ts: new Date(T0 + i * 5 * MINUTE).toISOString(), ...values })

  it('names the metric, the window, the resolution, the latest, lowest and highest, and what carried', () => {
    const series = chartSeries([
      at(0, { avg_double: 41.25, min_double: 30.1, max_double: 52, n_rows: 10, is_carried: false }),
      at(1, { avg_double: 44, min_double: 40, max_double: 49.5, n_rows: 8, is_carried: false }),
      at(2, { avg_double: 45, min_double: 45, max_double: 45, n_rows: 0, is_carried: true }),
      at(3, { avg_double: 45, min_double: 45, max_double: 45, n_rows: 0, is_carried: true }),
    ], starts)
    expect(chartSummary({
      metric: 'Spindle/LOAD', unit: 'kW', windowText: 'Today, Mon 2 Nov', resolution, series,
      validRange: { minimum: 0, maximum: 120 },
    })).toBe('Spindle/LOAD (kW), Today, Mon 2 Nov, in 5-minute buckets. Latest 45 kW. Lowest 30.1 kW, highest 52 kW.'
      + ' 2 of 4 buckets had no reading and carry the last one forward. Valid range 0 to 120 kW.')
  })

  it('says when a series has nothing to show', () => {
    expect(chartSummary({ metric: 'Axis/X', unit: null, windowText: 'Last 1 hour', resolution, series: chartSeries([], starts) }))
      .toBe('Axis/X, Last 1 hour, in 5-minute buckets. No readings in this window, and none before it.')
  })

  it('gives a state its latest value and a flag its word', () => {
    const state = chartSeries([at(0, { last_string: 'ACTIVE' }), at(1, { last_string: 'READY', is_carried: true })], starts)
    expect(chartSummary({ metric: 'Controller/EXECUTION', windowText: 'Last 1 hour', resolution, series: state }))
      .toBe('Controller/EXECUTION, Last 1 hour, in 5-minute buckets. Latest READY. 1 of 4 buckets had no reading and carry the last one forward.')
    const flag = chartSeries([at(0, { last_bool: false }), at(3, { last_bool: true })], starts)
    expect(chartSummary({ metric: 'Door/OPEN', windowText: 'Last 1 hour', resolution, series: flag }))
      .toBe('Door/OPEN, Last 1 hour, in 5-minute buckets. Latest true.')
  })

  it('words a valid range with either bound alone', () => {
    expect(validRangeWords({ minimum: 0, maximum: null }, '°C')).toBe('Valid range at least 0 °C')
    expect(validRangeWords({ minimum: null, maximum: 9.5 }, null)).toBe('Valid range at most 9.5')
    expect(validRangeWords(null, 'kW')).toBeNull()
  })
})

describe("a chart's colours", () => {
  it("come from the theme's tokens", () => {
    const tokens = { '--accent': ' #00d4ff', '--text-muted': '#858ea3', '--border': 'rgba(255, 255, 255, 0.08)', '--warning': '#ffb300', '--font-mono': "'JetBrains Mono', monospace" }
    expect(chartPalette(name => tokens[name])).toEqual({
      line: '#00d4ff', band: 'rgba(0, 212, 255, 0.18)', text: '#858ea3', grid: 'rgba(255, 255, 255, 0.08)',
      range: '#ffb300', font: "11px 'JetBrains Mono', monospace",
    })
  })

  it('tints a hex token, and leaves any other form as it is', () => {
    expect(withAlpha('#0284c7', 0.5)).toBe('rgba(2, 132, 199, 0.5)')
    expect(withAlpha('#fff', 1)).toBe('rgba(255, 255, 255, 1)')
    expect(withAlpha('rgba(1, 2, 3, 0.4)', 0.5)).toBe('rgba(1, 2, 3, 0.4)')
  })
})
