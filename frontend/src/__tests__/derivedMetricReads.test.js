/**
 * The browser's side of reading a derived metric (0282): which derived metrics a device's reports
 * make possible, how a read is split from the measured ones, what a window that is too long for one says,
 * how the Area tab folds a cell, what Export leaves out, and the drawer's Applies To line.
 */
import { describe, it, expect } from 'vitest'
import { HISTORY_MAX_ROWS } from '../api'
import {
  DERIVED_MAX_BUCKET_MINUTES, DERIVED_MAX_MINUTES, DERIVED_MAX_ROWS, SHARE_UNIT, appliesToValue, appliesToWords, currentWords,
  derivedDefinitions, derivedInputCount, derivedReportedBy, derivedWindowMinutes, percentWords, splitDerived, unitOf,
} from '../utils/derivedMetric'
import {
  cellMetrics, chartSeries, chartSummary, defaultCellMetric, derivedReadProblem, deviceMetrics, foldByGroup, groupSeries, historyMetrics,
  latestWords, lowWords, metricDevices, pickGroupResolution, readingWords,
} from '../utils/history'
import { DERIVED_EXPORT_NOTE, exportableMetrics } from '../utils/telemetryExport'

const counter = { kind: 'counter_rate', input: 'Controller/PART_COUNT' }
const state = { kind: 'time_in_state', input: 'Controller/EXECUTION', states: ['ACTIVE'] }
const power = { kind: 'sum', inputs: [{ metric: 'Power/A', sign: 1 }, { metric: 'Power/B', sign: -1 }] }
const catalog = [
  { name: 'Controller/PART_COUNT', datatype: 10, units: 'COUNT' },
  { name: 'Controller/EXECUTION', datatype: 12 },
  { name: 'Power/A', datatype: 10, units: 'kW' },
  { name: 'Power/B', datatype: 10, units: 'kW' },
  { name: 'Controller/PARTS_PER_HOUR', datatype: 10, units: 'COUNT/HOUR', derivation: counter },
  { name: 'Controller/UPTIME', datatype: 10, derivation: state },
  { name: 'Power/NET', datatype: 10, units: 'kW', derivation: power },
]
const device = (id, name, metrics) => ({ asset_id: id, asset_name: name, last_birth_metrics: metrics, status: 'ONLINE', location_source: 'inherited' })

describe('which derived metrics a device reports', () => {
  it('is each one whose inputs are all among the metrics it reports, in name order', () => {
    expect(derivedReportedBy(['Controller/PART_COUNT'], catalog)).toEqual(['Controller/PARTS_PER_HOUR'])
    expect(derivedReportedBy(new Set(['Controller/PART_COUNT', 'Controller/EXECUTION', 'Power/A']), catalog))
      .toEqual(['Controller/PARTS_PER_HOUR', 'Controller/UPTIME'])
    expect(derivedReportedBy(['Power/A', 'Power/B'], catalog)).toEqual(['Power/NET'])
    expect(derivedReportedBy([], catalog)).toEqual([])
  })

  it('needs every input of a sum, not one', () => {
    expect(derivedReportedBy(['Power/A'], catalog)).toEqual([])
  })

  it('adds them to what deviceMetrics() lists when it is given the catalog, and not otherwise', () => {
    const press = device('d1', 'Press 1', ['Controller/PART_COUNT', 'Zed/OTHER'])
    expect(deviceMetrics(press, [])).toEqual(['Controller/PART_COUNT', 'Zed/OTHER'])
    expect(deviceMetrics(press, [], catalog)).toEqual(['Controller/PART_COUNT', 'Controller/PARTS_PER_HOUR', 'Zed/OTHER'])
  })

  it('counts a metric a schema models as reported, as the Metric tab does', () => {
    const schemas = [{ schema_uuid: 's1', schema_definition: { properties: { 'Power/A': {}, 'Power/B': {} } } }]
    const press = { ...device('d1', 'Press 1', []), submodel_schema_ids: ['s1'] }
    expect(deviceMetrics(press, schemas, catalog)).toEqual(['Power/A', 'Power/B', 'Power/NET'])
  })

  it("is the Metric tab's devices that report it: all the inputs, among those in service", () => {
    const devices = [
      device('d1', 'Press 1', ['Power/A', 'Power/B']),
      device('d2', 'Press 2', ['Power/A']),
      { ...device('d3', 'Press 3', ['Power/A', 'Power/B']), is_archived: true },
    ]
    expect(metricDevices(devices, [], 'Power/NET', { catalog }).map(d => d.asset_name)).toEqual(['Press 1'])
    expect(metricDevices(devices, [], 'Power/NET').map(d => d.asset_name)).toEqual([])
    expect(cellMetrics(devices.slice(0, 2), [], catalog).map(m => [m.name, m.count])).toContainEqual(['Power/NET', 1])
    const row = historyMetrics(devices, [], catalog).find(m => m.name === 'Power/NET')
    expect(row).toEqual({ name: 'Power/NET', count: 1, unit: 'kW', kind: 'number', derived: true })
    expect(historyMetrics(devices, [], catalog).find(m => m.name === 'Power/A').derived).toBeUndefined()
  })
})

describe('the metric a tab opens on', () => {
  it('is the one most machines report, and never a derived one while a measured one is reported', () => {
    const list = [
      { name: 'A/MEASURED', count: 2 },
      { name: 'B/DERIVED', count: 3, derived: true },
      { name: 'C/MEASURED', count: 2 },
    ]
    expect(defaultCellMetric(list)).toBe('A/MEASURED')
    expect(defaultCellMetric(list.filter(m => m.derived))).toBe('B/DERIVED')
    expect(defaultCellMetric([])).toBe('')
  })
})

describe('a read split from the measured ones', () => {
  it('splits the names by the catalog, keeping the order', () => {
    expect(splitDerived(['Power/A', 'Power/NET', 'Controller/UPTIME', 'Zed/OTHER'], catalog))
      .toEqual({ measured: ['Power/A', 'Zed/OTHER'], derived: ['Power/NET', 'Controller/UPTIME'] })
    expect(derivedDefinitions(catalog).size).toBe(3)
  })

  it('counts the inputs a read takes the minutes of', () => {
    expect(derivedInputCount(['Power/NET', 'Controller/UPTIME', 'Power/A'], catalog)).toBe(3)
    expect(derivedInputCount(['Power/A'], catalog)).toBe(0)
  })

  it('says a window too long for the devices, by the minutes of input, and not by the bucket', () => {
    const day = 24 * 60 * 60 * 1000
    const start = Date.parse('2026-01-05T00:00:00Z')
    // One counter on one device: 250,000 minutes is 173.6 days.
    expect(derivedReadProblem(start, start + 90 * day, 1440, 1, ['Controller/PARTS_PER_HOUR'], catalog)).toBeNull()
    expect(derivedReadProblem(start, start + 180 * day, 1440, 1, ['Controller/PARTS_PER_HOUR'], catalog)).toMatch(/too many of them for it\. Choose a shorter window\.$/)
    // The bucket does not change it.
    expect(derivedReadProblem(start, start + 180 * day, 60, 1, ['Controller/PARTS_PER_HOUR'], catalog)).not.toBeNull()
    // The inputs of a sum and the devices count.
    expect(derivedReadProblem(start, start + 60 * day, 1440, 1, ['Power/NET'], catalog)).toBeNull()
    expect(derivedReadProblem(start, start + 60 * day, 1440, 2, ['Power/NET'], catalog)).not.toBeNull()
    expect(derivedReadProblem(start, start + 30 * day, 1440, 20, ['Controller/PARTS_PER_HOUR'], catalog))
      .toBe('A derived metric is computed from the minutes, and this window has too many of them for 20 devices. Choose a shorter window or fewer devices.')
    // A read of no derived metric has no problem of this kind.
    expect(derivedReadProblem(start, start + 300 * day, 1440, 50, ['Power/A'], catalog)).toBeNull()
  })

  it("holds the database's limits (mirror check 95)", () => {
    expect(DERIVED_MAX_ROWS).toBe(HISTORY_MAX_ROWS)
    expect(DERIVED_MAX_MINUTES).toBe(250000)
    expect(DERIVED_MAX_BUCKET_MINUTES).toBe(5760)
  })
})

describe("a current value's window", () => {
  it('is an hour for a rate and a share and the last whole minute for a sum (mirror check 94)', () => {
    expect([counter, state, power].map(derivedWindowMinutes)).toEqual([60, 60, 0])
    expect(derivedWindowMinutes({ kind: 'average' })).toBeNull()
    expect(derivedWindowMinutes(null)).toBeNull()
  })

  it('is said in words, after the value', () => {
    expect(currentWords(counter)).toBe('over the last hour')
    expect(currentWords(state)).toBe('over the last hour')
    expect(currentWords(power)).toBe('at the last whole minute')
  })
})

describe("the Area tab's fold of a derived metric", () => {
  const row = (asset, at, value, carried = false) => ({ asset_id: asset, bucket_ts: at, avg_double: value, is_carried: carried })
  const T = ['2026-01-05T10:00:00.000Z', '2026-01-05T11:00:00.000Z', '2026-01-05T12:00:00.000Z']
  const groups = [{ key: 'c1', keys: ['a', 'b', 'c'] }, { key: 'c2', keys: ['d'] }]

  it('is the mean of the machines that have a value, and the total only where every machine has one', () => {
    const rows = [
      row('a', T[0], 1), row('b', T[0], 2), row('c', T[0], 3),
      row('a', T[1], 1), row('b', T[1], 2),
      row('d', T[0], 10, true),
    ]
    const folded = foldByGroup(rows, groups)
    expect(folded.map(r => [r.group_key, r.bucket_ts, r.mean_double, r.total_double, r.members, r.with_value, r.measured])).toEqual([
      ['c1', T[0], 2, 6, 3, 3, 3],
      ['c1', T[1], 1.5, null, 3, 2, 2],
      ['c2', T[0], 10, 10, 1, 1, 0],
    ])
  })

  it("is drawn by groupSeries() as the group read's rows are: a withheld total is empty and says so", () => {
    const rows = [row('a', T[0], 1), row('b', T[0], 2), row('c', T[0], 3), row('a', T[1], 1), row('b', T[1], 2), row('c', T[1], 3, true)]
    const folded = foldByGroup(rows, groups).filter(r => r.group_key === 'c1')
    const starts = T.map(t => Date.parse(t) / 1000)
    const total = groupSeries(folded, starts, 'total')
    expect(total.avg).toEqual([6, 6, null])
    // The second bucket had one machine carried, not none: it is still a reading in the cell.
    expect(total.carried).toEqual([false, false, false])
    expect(groupSeries(foldByGroup(rows.map(r => ({ ...r, is_carried: true })), groups), starts, 'mean').carried.slice(0, 2)).toEqual([true, true])
  })

  it('leaves out a machine that is in no group and a row with no value', () => {
    const rows = [row('stranger', T[0], 9), { asset_id: 'a', bucket_ts: T[0], avg_double: null, is_carried: false }]
    expect(foldByGroup(rows, groups)).toEqual([])
  })

  it('picks the finest resolution at which machines times buckets fit one read of rows', () => {
    const start = Date.parse('2026-01-05T00:00:00Z')
    const hour = 60 * 60 * 1000
    // 20 machines over a day: 5-minute buckets are 5,780 rows, over the cap, so hourly.
    expect(pickGroupResolution(start, start + 24 * hour, 20, 4, { readRows: DERIVED_MAX_ROWS }).id).toBe('1h')
    // The measured read takes 50,000 devices times buckets, and picks a finer bucket for the same.
    expect(pickGroupResolution(start, start + 24 * hour, 20, 4).id).toBe('5m')
  })
})

describe('a time in state as a percentage', () => {
  it('is a fraction as a percentage with at most one decimal, a trailing zero dropped', () => {
    expect([0, 0.42, 0.425, 0.4249, 0.4244, 0.9, 1, 0.333, 0.0004, 0.9995].map(percentWords))
      .toEqual(['0%', '42%', '42.5%', '42.5%', '42.4%', '90%', '100%', '33.3%', '0%', '100%'])
  })

  it('says nothing for what is no number', () => {
    expect([null, undefined, NaN, Infinity].map(percentWords)).toEqual(['—', '—', '—', '—'])
  })

  it("is a time in state's unit, and no other metric's", () => {
    expect(unitOf({ derivation: state, units: null })).toBe(SHARE_UNIT)
    expect(unitOf({ derivation: counter, units: 'COUNT/HOUR' })).toBe('COUNT/HOUR')
    expect(unitOf({ derivation: power, units: 'kW' })).toBe('kW')
    expect(unitOf({ units: 'kW' })).toBe('kW')
    expect(unitOf({})).toBeNull()
    expect(unitOf(undefined)).toBeNull()
    expect(SHARE_UNIT).toBe('% of the time')
  })

  it("is how a reading with that unit is said, and a unit with no symbol is said as it was", () => {
    expect(readingWords(0.425, SHARE_UNIT)).toBe('42.5%')
    expect(readingWords(null, SHARE_UNIT)).toBe('—')
    expect(readingWords(4.2, 'kW')).toBe('4.2 kW')
    // A rate says its counter's symbol per hour (utils/units.js).
    expect(readingWords(123.456, 'COUNT/HOUR')).toBe('123.5 count/h')
    // The first of a range carries a percentage's sign, and no other unit.
    expect(lowWords(0, SHARE_UNIT)).toBe('0%')
    expect(lowWords(0, 'kW')).toBe('0')
    expect(lowWords(0)).toBe('0')
  })

  it("is in a chart's latest reading and its summary", () => {
    const starts = [0, 60, 120]
    const rows = [0, 1, 2].map(i => ({ bucket_ts: new Date(starts[i] * 1000).toISOString(), avg_double: [0.2, 0.425, 0.425][i], min_double: [0.2, 0.425, 0.425][i], max_double: [0.2, 0.425, 0.425][i], last_double: [0.2, 0.425, 0.425][i], is_carried: i === 2 }))
    const series = chartSeries(rows, starts)
    expect(latestWords(series, starts, 1, SHARE_UNIT)).toMatch(/^Latest 42[.]5% · /)
    const text = chartSummary({ metric: 'A/UPTIME', unit: SHARE_UNIT, windowText: 'Last hour', resolution: { words: '1-minute buckets', minutes: 1 }, series, validRange: null, starts, span: { start: 0, end: 180000, now: 180000 }, derived: true })
    expect(text).toContain('A/UPTIME (% of the time), a derived metric, Last hour')
    expect(text).toContain('Lowest 20%, highest 42.5%')
  })

  it("is the unit the Metric tab's picker lists for it", () => {
    const row = historyMetrics([device('d1', 'Press 1', ['Controller/EXECUTION'])], [], [...catalog, { name: 'Controller/UPTIME', datatype: 10, derivation: state }]).find(m => m.name === 'Controller/UPTIME')
    expect(row.unit).toBe('% of the time')
  })
})

describe('what Export leaves out', () => {
  it('is the derived metrics, said where they were chosen, and the rest are named as they were', () => {
    expect(exportableMetrics(['Controller/PARTS_PER_HOUR', 'Controller/PART_COUNT', 'Power/NET'], catalog))
      .toEqual({ names: ['Controller/PART_COUNT'], left: ['Controller/PARTS_PER_HOUR', 'Power/NET'] })
    expect(exportableMetrics(['Power/A'], catalog)).toEqual({ names: ['Power/A'], left: [] })
    expect(exportableMetrics([], catalog)).toEqual({ names: [], left: [] })
    expect(exportableMetrics(['Anything'], null)).toEqual({ names: ['Anything'], left: [] })
    expect(DERIVED_EXPORT_NOTE).toBe('A derived metric is computed when it is drawn, and is not exported. Export its inputs.')
  })
})

describe("a derived metric's Applies To line", () => {
  const names = (n) => Array.from({ length: n }, (_, i) => `Press ${i + 1}`)

  it('names the devices that report the inputs, as the dashboard lists them', () => {
    expect(appliesToWords(names(1), counter)).toBe('Applies to: Press 1, the device that reports Controller/PART_COUNT')
    expect(appliesToWords(names(2), counter)).toBe('Applies to: Press 1 and Press 2, the devices that report Controller/PART_COUNT')
    expect(appliesToWords(names(3), counter)).toBe('Applies to: Press 1, Press 2 and Press 3, the devices that report Controller/PART_COUNT')
  })

  it('says how many more past three', () => {
    expect(appliesToWords(names(5), counter)).toBe('Applies to: Press 1, Press 2 and 3 more, the devices that report Controller/PART_COUNT')
    expect(appliesToWords(names(4), counter)).toBe('Applies to: Press 1, Press 2 and 2 more, the devices that report Controller/PART_COUNT')
  })

  it('names the first two as a table sorts them, whatever order the devices were read in', () => {
    const read = ['Press 4', 'Press 10', 'press 2', 'Press 1', 'Press 3']
    expect(appliesToWords(read, counter)).toBe('Applies to: Press 1, press 2 and 3 more, the devices that report Controller/PART_COUNT')
    expect(read[0]).toBe('Press 4')
  })

  it('says every input of a sum', () => {
    expect(appliesToWords(names(2), power)).toBe('Applies to: Press 1 and Press 2, the devices that report Power/A and Power/B')
  })

  it('says what no device reports yet when there is none', () => {
    expect(appliesToWords([], counter)).toBe('Applies to no device yet: none reports Controller/PART_COUNT')
    expect(appliesToWords([], power)).toBe('Applies to no device yet: none reports Power/A and Power/B')
  })

  it("is the same line without 'Applies to' beside the drawer's label", () => {
    expect(appliesToValue(names(5), counter)).toBe('Press 1, Press 2 and 3 more, the devices that report Controller/PART_COUNT')
    expect(appliesToValue([], state)).toBe('No device yet: none reports Controller/EXECUTION')
  })
})
