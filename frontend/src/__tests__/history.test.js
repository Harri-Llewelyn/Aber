import { describe, it, expect } from 'vitest'
import { HISTORY_MAX_ROWS, HISTORY_RESOLUTIONS } from '../api'
import { pathSegments } from '../hooks/useUrlState'
import { windowFromQuery, windowToQuery } from '../utils/timeWindow'
import {
  DEFAULT_HISTORY_WINDOW, HISTORY_BUCKETS, HISTORY_RANGES, HISTORY_REFRESH_EVERY, HISTORY_SPANS, bucketCount, bucketOptions,
  bucketStarts, chartPalette, chartSeries, chartSummary, deviceHistoryPath, deviceMatches, deviceMetrics, historyDevices,
  historyPath, inReads, nowFraction, pickResolution, pickedAddress, resolutionFor, splitCarried, validRangeWords,
  validRanges, withAlpha, STATE_KEY_MAX, durationWords, keyWords, latestReading, latestWords, momentWords, runWords,
  shareWords, stateHue, stateKey, stateRuns, stateShares, TEXT_BUCKET_MIN_PX, datatypeKind, readPlan, readableResolution,
  OTHER_GROUP, metricGroups,
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

describe('the Buckets choice', () => {
  it('offers Auto, then each resolution', () => {
    expect(HISTORY_BUCKETS).toEqual(['auto', '1m', '5m', '1h', '1d'])
  })

  it("takes Auto's pick under Auto, and a coarser size with every series in one read", () => {
    expect(resolutionFor(T0, T0 + DAY, 4, 'auto')).toMatchObject({ resolution: { id: '5m', perRead: 4 }, refused: null })
    expect(resolutionFor(T0, T0 + DAY, 4, '1h')).toMatchObject({ resolution: { id: '1h', perRead: 4 }, refused: null })
    expect(resolutionFor(T0, T0 + DAY, 4, '5m')).toMatchObject({ resolution: { id: '5m', perRead: 4 }, refused: null })
  })

  it("refuses a size finer than Auto's pick, which would pass the row cap, and reads at Auto's", () => {
    // Four metrics over a day: 5,764 one-minute rows, over the cap of 5,000.
    expect(resolutionFor(T0, T0 + DAY, 4, '1m')).toMatchObject({ resolution: { id: '5m' }, refused: { id: '1m' } })
  })

  it("keeps Auto's parts when the size chosen is Auto's own", () => {
    expect(resolutionFor(T0, T0 + 365 * DAY, 15, '1d')).toMatchObject({ resolution: { id: '1d', perRead: 13 }, refused: null })
    expect(resolutionFor(T0, T0 + 5001 * DAY, 1, '1d')).toEqual({ resolution: null, refused: null })
  })

  it("turns off each size finer than Auto's pick, and none coarser", () => {
    const on = (auto) => bucketOptions(auto).map(o => [o.value, o.on])
    expect(on(pickResolution(T0, T0 + DAY, 4))).toEqual([['auto', true], ['1m', false], ['5m', true], ['1h', true], ['1d', true]])
    expect(on(pickResolution(T0, T0 + DAY, 1))).toEqual([['auto', true], ['1m', true], ['5m', true], ['1h', true], ['1d', true]])
    expect(on(null)).toEqual([['auto', true], ['1m', false], ['5m', false], ['1h', false], ['1d', false]])
    expect(bucketOptions(null).map(o => o.label)).toEqual(['Auto buckets', '1-minute buckets', '5-minute buckets', '1-hour buckets', '1-day buckets'])
  })
})

describe("a text chart's buckets", () => {
  it("knows a metric's kind before it is read, from its catalog datatype", () => {
    expect([12, 14, 15].map(datatypeKind)).toEqual(['text', 'text', 'text'])
    expect(datatypeKind(11)).toBe('flag')
    expect([1, 4, 8, 9, 10, 13].map(datatypeKind)).toEqual(Array(6).fill('number'))
    expect(datatypeKind(undefined)).toBeNull()
    expect(datatypeKind(null)).toBeNull()
  })

  it('takes the finest whose buckets are each at least 5 px across the chart, within the row cap', () => {
    expect(TEXT_BUCKET_MIN_PX).toBe(5)
    // A day at 960 px: 1,440 one-minute and 288 five-minute buckets are too narrow; 24 hourly are 40 px.
    expect(readableResolution(T0, T0 + DAY, 1, 960)).toMatchObject({ id: '1h' })
    // An hour: 60 one-minute buckets are 16 px at 960, and 3.3 px at 200, where 12 five-minute are 16.
    expect(readableResolution(T0, T0 + HOUR, 1, 960)).toMatchObject({ id: '1m' })
    expect(readableResolution(T0, T0 + HOUR, 1, 200)).toMatchObject({ id: '5m' })
    // Wide enough is not enough: 300 one-minute buckets at 6,000 px are 20 px, but 20 metrics pass the cap.
    expect(readableResolution(T0, T0 + 300 * MINUTE, 20, 6000)).toMatchObject({ id: '5m' })
    // Too narrow for any: the coarsest.
    expect(readableResolution(T0, T0 + 365 * DAY, 1, 300)).toMatchObject({ id: '1d' })
  })

  it('reads text apart under Auto, and the rest as before', () => {
    const plan = readPlan(T0, T0 + DAY, { names: ['A', 'B', 'S'], textNames: new Set(['S']), widthPx: 960 })
    expect(plan.groups.map(g => [g.names, g.resolution.id, Boolean(g.text)])).toEqual([[['A', 'B'], '1m', false], [['S'], '1h', true]])
    expect(plan.refused).toBeNull()
    expect(readPlan(T0, T0 + DAY, { names: ['S'], textNames: new Set(['S']) }).groups.map(g => g.resolution.id)).toEqual(['1h'])
  })

  it('reads every metric at a Buckets choice, text included, and apart again when the choice is too fine', () => {
    const chosen = readPlan(T0, T0 + DAY, { names: ['A', 'S'], textNames: new Set(['S']), bucket: '5m', widthPx: 960 })
    expect(chosen.groups.map(g => [g.names, g.resolution.id])).toEqual([[['A', 'S'], '5m']])
    // Four metrics over a day are too many at 1 minute, so Auto reads them, text apart.
    const refused = readPlan(T0, T0 + DAY, { names: ['A', 'B', 'C', 'S'], textNames: new Set(['S']), bucket: '1m', widthPx: 960 })
    expect(refused.refused).toMatchObject({ id: '1m' })
    expect(refused.groups.map(g => g.resolution.id)).toEqual(['1m', '1h'])
  })

  it('refuses a window too long for one series even in day buckets', () => {
    expect(readPlan(T0, T0 + 5001 * DAY, { names: ['A'], textNames: new Set() })).toMatchObject({ problem: true })
  })
})

describe("the charts' groups", () => {
  it('groups by catalog datatype, named as the Metrics page names it: numbers, then Boolean, then text, then Other', () => {
    const catalog = [
      { name: 'a/STATE', datatype: 12 }, { name: 'b/DOOR', datatype: 11 }, { name: 'c/COUNT', datatype: 3 },
      { name: 'd/TEMP', datatype: 10 }, { name: 'e/NOTE', datatype: 14 }, { name: 'f/RATIO', datatype: 9 },
      { name: 'g/WHEN', datatype: 13 }, { name: 'h/TEMP2', datatype: 10 },
    ]
    const names = ['a/STATE', 'b/DOOR', 'c/COUNT', 'd/TEMP', 'e/NOTE', 'f/RATIO', 'g/WHEN', 'h/TEMP2', 'z/UNKNOWN']
    expect(metricGroups(names, catalog).map(g => [g.label, g.names])).toEqual([
      ['Double', ['d/TEMP', 'h/TEMP2']], ['Float', ['f/RATIO']], ['Int32', ['c/COUNT']], ['Boolean', ['b/DOOR']],
      ['String', ['a/STATE']], ['Text', ['e/NOTE']], ['DateTime', ['g/WHEN']], [OTHER_GROUP, ['z/UNKNOWN']],
    ])
    expect(metricGroups(names, catalog).map(g => g.key)).toEqual(['10', '9', '3', '11', '12', '14', '13', 'other'])
    expect(metricGroups([], catalog)).toEqual([])
  })
})

describe('the refresh timer', () => {
  it('offers Off, 30 s, 1 min and 5 min, and no 10 s, since each read reads every chart again', () => {
    expect(HISTORY_REFRESH_EVERY).toEqual([
      { value: 0, label: 'Off' }, { value: 30, label: '30 s' }, { value: 60, label: '1 min' }, { value: 300, label: '5 min' },
    ])
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

  it('carries the metrics chosen and the bucket choice, and writes neither at its default', () => {
    const win = { kind: 'rolling', range: '7d', ms: 7 * DAY, label: 'Last 7 days' }
    expect(pickedAddress('dev0123', win, { metrics: ['Spindle/LOAD', 'Axis,X'], bucket: '1h' }))
      .toBe('/history/device/dev0123?range=7d&metric=Spindle%2FLOAD,Axis%252CX&bucket=1h')
    expect(pickedAddress('dev0123', DEFAULT_HISTORY_WINDOW, { metrics: [], bucket: 'auto' })).toBe('/history/device/dev0123')
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

  const bucket = (i) => momentWords(T0 + i * 5 * MINUTE, 5)

  it('names the metric, the window, the resolution, the latest reading and its bucket, lowest and highest, and what carried', () => {
    const series = chartSeries([
      at(0, { avg_double: 41.25, min_double: 30.1, max_double: 52, last_double: 43, n_rows: 10, is_carried: false }),
      at(1, { avg_double: 44, min_double: 40, max_double: 49.5, last_double: 45, n_rows: 8, is_carried: false }),
      at(2, { avg_double: 45, min_double: 45, max_double: 45, last_double: 45, n_rows: 0, is_carried: true }),
      at(3, { avg_double: 45, min_double: 45, max_double: 45, last_double: 45, n_rows: 0, is_carried: true }),
    ], starts)
    expect(chartSummary({
      metric: 'Spindle/LOAD', unit: 'kW', windowText: 'Today, Mon 2 Nov', resolution, series, starts,
      validRange: { minimum: 0, maximum: 120 },
    })).toBe(`Spindle/LOAD (kW), Today, Mon 2 Nov, in 5-minute buckets. Latest 45 kW, in the bucket from ${bucket(1)}.`
      + ' Lowest 30.1 kW, highest 52 kW. 2 of 4 buckets had no reading and carry the last one forward. Valid range 0 to 120 kW.')
  })

  it('says when no reading arrived in the window, and the value carried into it', () => {
    const series = chartSeries([
      at(0, { avg_double: 7, min_double: 7, max_double: 7, last_double: 7, n_rows: 0, is_carried: true }),
      at(1, { avg_double: 7, min_double: 7, max_double: 7, last_double: 7, n_rows: 0, is_carried: true }),
    ], starts)
    expect(chartSummary({ metric: 'Axis/X', unit: 'mm', windowText: 'Last 1 hour', resolution, series, starts }))
      .toBe('Axis/X (mm), Last 1 hour, in 5-minute buckets. No reading in this window; 7 mm is carried forward from before it.'
        + ' Lowest 7 mm, highest 7 mm. 2 of 4 buckets had no reading and carry the last one forward.')
  })

  it('says when a series has nothing to show', () => {
    expect(chartSummary({ metric: 'Axis/X', unit: null, windowText: 'Last 1 hour', resolution, series: chartSeries([], starts) }))
      .toBe('Axis/X, Last 1 hour, in 5-minute buckets. No readings in this window, and none before it.')
  })

  it("gives a state its latest value and each value's share of the time, and a flag its word", () => {
    const state = chartSeries([
      at(0, { last_string: 'ACTIVE' }), at(1, { last_string: 'READY' }),
      at(2, { last_string: 'READY', is_carried: true }), at(3, { last_string: 'READY', is_carried: true }),
    ], starts)
    const span = { start: T0, end: T0 + 20 * MINUTE, now: T0 + DAY }
    expect(chartSummary({ metric: 'Controller/EXECUTION', windowText: 'Last 1 hour', resolution, series: state, starts, span }))
      .toBe(`Controller/EXECUTION, Last 1 hour, in 5-minute buckets. Latest READY, in the bucket from ${bucket(1)}.`
        + ' Time in each value: READY 75%, ACTIVE 25%. 2 of 4 buckets had no reading and carry the last one forward.')
    const flag = chartSeries([at(0, { last_bool: false }), at(3, { last_bool: true })], starts)
    expect(chartSummary({ metric: 'Door/OPEN', windowText: 'Last 1 hour', resolution, series: flag, starts }))
      .toBe(`Door/OPEN, Last 1 hour, in 5-minute buckets. Latest true, in the bucket from ${bucket(3)}.`)
  })

  it('words a valid range with either bound alone', () => {
    expect(validRangeWords({ minimum: 0, maximum: null }, '°C')).toBe('Valid range at least 0 °C')
    expect(validRangeWords({ minimum: null, maximum: 9.5 }, null)).toBe('Valid range at most 9.5')
    expect(validRangeWords(null, 'kW')).toBeNull()
  })
})

describe('the latest reading', () => {
  const starts = bucketStarts(T0, T0 + 4 * MINUTE, 1)
  const at = (i, values) => ({ bucket_ts: new Date(T0 + i * MINUTE).toISOString(), ...values })

  it("keeps each bucket's last value as it was read", () => {
    expect(chartSeries([at(0, { avg_double: 2, last_double: 3 })], starts).last).toEqual([3, null, null, null])
    expect(chartSeries([at(1, { last_bool: false })], starts).last).toEqual([null, false, null, null])
    expect(chartSeries([at(2, { last_string: 'IDLE' })], starts).last).toEqual([null, null, 'IDLE', null])
  })

  it('is the newest bucket a reading arrived in, never a carried one', () => {
    const series = chartSeries([
      at(0, { avg_double: 20, last_double: 21.3, is_carried: false }),
      at(1, { avg_double: 21.3, last_double: 21.3, is_carried: true }),
      at(2, { avg_double: 21.3, last_double: 21.3, is_carried: true }),
    ], starts)
    expect(latestReading(series)).toEqual({ i: 0, value: 21.3 })
    expect(latestWords(series, starts, 1, '°C')).toBe(`Latest 21.3 °C · ${momentWords(T0, 1)}`)
  })

  it('says a flag as true or false and a state as its text, and when only carried buckets hold a value', () => {
    expect(latestWords(chartSeries([at(3, { last_bool: false })], starts), starts, 1)).toBe(`Latest false · ${momentWords(T0 + 3 * MINUTE, 1)}`)
    expect(latestWords(chartSeries([at(1, { last_string: 'IDLE' })], starts), starts, 1)).toBe(`Latest IDLE · ${momentWords(T0 + MINUTE, 1)}`)
    expect(latestWords(chartSeries([at(0, { last_double: 4, avg_double: 4, is_carried: true })], starts), starts, 1)).toBe('No reading in this window')
    expect(latestWords(chartSeries([], starts), starts, 1)).toBeNull()
  })

  it("says a bucket's time as its date and clock, or its date alone for a day bucket", () => {
    const d = new Date(2026, 10, 2, 12, 40)
    expect(momentWords(d.getTime(), 5)).toMatch(/^2 Nov 12:40$/)
    expect(momentWords(d.getTime(), 1440)).toMatch(/^2 Nov$/)
  })
})

describe("a state chart's runs and key", () => {
  const starts = bucketStarts(T0, T0 + 10 * MINUTE, 1)
  const series = (values, carried = []) => ({
    kind: 'state', states: values, carried: values.map((_, i) => carried.includes(i)),
  })
  const span = { start: T0, end: T0 + 10 * MINUTE, now: T0 + DAY, minutes: 1 }

  it('joins buckets of one value into a run, with the stretches carried forward inside it', () => {
    const runs = stateRuns(series(['A', 'A', 'A', 'B', 'B', null, 'A', 'A', 'A', 'A'], [1, 2, 8, 9]), starts, span)
    expect(runs.map(r => [r.state, (r.startMs - T0) / MINUTE, (r.endMs - T0) / MINUTE])).toEqual([['A', 0, 3], ['B', 3, 5], ['A', 6, 10]])
    expect(runs[0].carried.map(c => [(c.startMs - T0) / MINUTE, (c.endMs - T0) / MINUTE])).toEqual([[1, 3]])
    expect(runs[2].carried.map(c => [(c.startMs - T0) / MINUTE, (c.endMs - T0) / MINUTE])).toEqual([[8, 10]])
  })

  it('clips a run to the window and to now, so the future is no share of the time', () => {
    const runs = stateRuns(series(['A', 'A', 'A', 'A', 'B', 'B', 'B', 'B', 'B', 'B']), starts,
      { ...span, start: T0 + 30 * 1000, now: T0 + 6 * MINUTE })
    expect(runs.map(r => [r.state, (r.startMs - T0) / 1000, (r.endMs - T0) / 1000])).toEqual([['A', 30, 240], ['B', 240, 360]])
    const shares = stateShares(runs)
    expect(shares.map(s => [s.state, s.share])).toEqual([['A', 210 / 330], ['B', 120 / 330]])
  })

  it("shares the time over the buckets that have a value, carried included, the most first", () => {
    const shares = stateShares(stateRuns(series(['B', 'A', 'A', 'A', null, null, 'C', 'C', 'C', 'C'], [2, 3, 8, 9]), starts, span))
    expect(shares.map(s => [s.state, s.share])).toEqual([['C', 0.5], ['A', 0.375], ['B', 0.125]])
    expect(keyWords(stateKey(shares))).toBe('C 50%, A 38%, B 13%')
  })

  it('names at most six values in the key, the most time first, and counts the rest as others', () => {
    expect(STATE_KEY_MAX).toBe(6)
    const values = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']
    const key = stateKey(stateShares(stateRuns(series(values), starts, span)))
    expect(key.shown.map(s => s.state)).toEqual(['A', 'B', 'C', 'D', 'E', 'F'])
    expect(key.others).toMatchObject({ count: 4 })
    expect(key.others.share).toBeCloseTo(0.4)
    expect(keyWords(key)).toBe('A 10%, B 10%, C 10%, D 10%, E 10%, F 10%, 4 others 40%')
  })

  it("takes a value's hue from its text alone, the same on every call", () => {
    // Pinned, so a change to the hash, which would recolour every value people know, is seen.
    expect(['RUNNING', 'IDLE', 'FAULT', 'PICK_BIN_A', 'PICK_BIN_B'].map(stateHue)).toEqual([127, 301, 10, 26, 305])
    expect(stateHue('RUNNING')).toBe(stateHue(`RUN${'NING'}`))
    expect(stateHue('')).toBeGreaterThanOrEqual(0)
    for (const v of ['O1000', 'Ünïcode ✓', 'a'.repeat(500)]) {
      expect(Number.isInteger(stateHue(v)) && stateHue(v) >= 0 && stateHue(v) < 360, v).toBe(true)
    }
  })

  it('spreads values that differ by one character across the wheel, not a degree apart', () => {
    const bins = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(c => stateHue(`PICK_BIN_${c}`))
    expect(new Set(bins.map(h => Math.floor(h / 30))).size).toBeGreaterThanOrEqual(10)
    const programs = Array.from({ length: 1200 }, (_, i) => stateHue(`O${1000 + i}`))
    const perSector = new Array(12).fill(0)
    for (const h of programs) perSector[Math.floor(h / 30)] += 1
    // A uniform spread puts 100 in each; none here is under 60 or over 140.
    expect(Math.min(...perSector)).toBeGreaterThan(60)
    expect(Math.max(...perSector)).toBeLessThan(140)
  })

  it('says a sliver of a share as under one per cent', () => {
    expect(shareWords(0.004)).toBe('<1%')
    expect(shareWords(0)).toBe('0%')
    expect(shareWords(0.625)).toBe('63%')
  })

  it('reads the run under the pointer with its stretch, its length and what of it was carried', () => {
    const [a, b] = stateRuns(series(['A', 'A', 'A', 'B', 'B'], [1, 2, 3, 4]), starts, span)
    const clock = (m) => momentWords(T0 + m * MINUTE, 1).split(' ').pop()
    expect(runWords(a, 1)).toBe(`${momentWords(T0, 1)} – ${clock(3)} · A, 3 min, 2 min carried forward`)
    expect(runWords(b, 1)).toBe(`${momentWords(T0 + 3 * MINUTE, 1)} – ${clock(5)} · B, 2 min, carried forward`)
  })

  it('says a stretch in minutes, hours and days', () => {
    expect(durationWords(35 * MINUTE)).toBe('35 min')
    expect(durationWords(125 * MINUTE)).toBe('2 h 5 min')
    expect(durationWords(2 * HOUR)).toBe('2 h')
    expect(durationWords(3 * DAY + 4 * HOUR)).toBe('3 d 4 h')
    expect(durationWords(20 * 1000)).toBe('under 1 min')
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
