import { describe, it, expect } from 'vitest'
import {
  EXPORT_COLUMNS, EXPORT_DENIED_TITLE, EXPORT_MAX_DAYS, EXPORT_MAX_DEVICES, EXPORT_MAX_METRICS, EXPORT_RESOLUTIONS,
  TELEMETRY_EXPORT_ROLES, areaExportNote, areaExportScope, bestResolutionFor, commentRow, coversRange, exportMaxDays, exportRows,
  exportSizeProblem, exportWindowProblem, mayExportReadings, metricExportNote, metricExportScope, noticeRows, overExportLimit,
  overLimitShort, provenanceRow, resolutionByKey
} from '../utils/telemetryExport'
import { TELEMETRY_RESOLUTION_RELATIONS } from '../api'

/**
 * The export dialog's resolution logic (issue #160).
 *
 * The fault this guards is the one the issue describes: an export over a range older than the raw
 * retention window returned nothing and blamed the device. Every assertion below is about the
 * difference between "nothing was published" and "the rows were dropped and a rollup still holds
 * the period".
 */

const DAY = 24 * 60 * 60 * 1000
const now = Date.parse('2026-09-16T00:00:00Z')
const daysAgo = n => new Date(now - n * DAY)

/** A stack whose raw window is 90 days, with rollups to 180 days, 1 year and 5 years. */
const DEFAULTS = {
  telemetry: daysAgo(90),
  telemetry_1m: daysAgo(180),
  telemetry_5m: daysAgo(365),
  telemetry_1h: daysAgo(365 * 5)
}

describe('the resolutions offered', () => {
  it('are finest first, which is what makes bestResolutionFor pick the least lossy', () => {
    expect(EXPORT_RESOLUTIONS.map(r => r.key)).toEqual(['raw', '1m', '5m', '1h'])
  })

  it('names the rollups as export_telemetry() takes them, and raw as the choice that is none', () => {
    expect(resolutionByKey('raw').param).toBeNull()
    expect(EXPORT_RESOLUTIONS.filter(r => r.param).map(r => r.param)).toEqual(['1m', '5m', '1h'])
  })

  it('each names the relation telemetry_horizons reports, so a label cannot go silently unknown', () => {
    for (const r of EXPORT_RESOLUTIONS) {
      expect(TELEMETRY_RESOLUTION_RELATIONS[r.key]).toBe(r.relation)
    }
  })

  it('an unknown key falls back to raw, never to a rollup', () => {
    // A rollup substituted for an unrecognised choice would hand a reader averages silently --
    // the exact substitution the export refuses to make.
    expect(resolutionByKey('nonsense').key).toBe('raw')
    expect(resolutionByKey(undefined).key).toBe('raw')
  })
})

describe('coversRange', () => {
  it('is true when the resolution reaches back to the range start', () => {
    expect(coversRange(DEFAULTS, 'telemetry', daysAgo(30).toISOString())).toBe(true)
    expect(coversRange(DEFAULTS, 'telemetry_1h', daysAgo(1000).toISOString())).toBe(true)
  })

  it('is false when the range starts before the horizon', () => {
    expect(coversRange(DEFAULTS, 'telemetry', daysAgo(120).toISOString())).toBe(false)
    expect(coversRange(DEFAULTS, 'telemetry_1m', daysAgo(200).toISOString())).toBe(false)
  })

  it('a horizon exactly at the range start covers it, because the query bound is inclusive', () => {
    expect(coversRange(DEFAULTS, 'telemetry', daysAgo(90).toISOString())).toBe(true)
  })

  it('is null, not false, when nothing is known -- the dialog must not warn on its own ignorance', () => {
    expect(coversRange({}, 'telemetry', daysAgo(1).toISOString())).toBeNull()
    expect(coversRange(null, 'telemetry', daysAgo(1).toISOString())).toBeNull()
    // The relation is present but empty: an empty stack covers nothing at any resolution, so
    // there is no better one to offer and nothing useful to say.
    expect(coversRange({ telemetry: null }, 'telemetry', daysAgo(1).toISOString())).toBeNull()
  })

  it('is null for an unparseable range start rather than throwing mid-render', () => {
    expect(coversRange(DEFAULTS, 'telemetry', 'not a date')).toBeNull()
  })
})

describe('bestResolutionFor', () => {
  it('offers the FINEST resolution that covers the range, not the furthest-reaching', () => {
    // 100 days back: raw (90) misses it, the 1-minute rollup (180) holds it. Offering the hourly
    // one would throw away 59 buckets in 60 for no reason.
    expect(bestResolutionFor(DEFAULTS, daysAgo(100).toISOString()).key).toBe('1m')
    expect(bestResolutionFor(DEFAULTS, daysAgo(300).toISOString()).key).toBe('5m')
    expect(bestResolutionFor(DEFAULTS, daysAgo(400).toISOString()).key).toBe('1h')
  })

  it('offers raw when raw covers it', () => {
    expect(bestResolutionFor(DEFAULTS, daysAgo(10).toISOString()).key).toBe('raw')
  })

  it('is null when no resolution reaches that far back', () => {
    expect(bestResolutionFor(DEFAULTS, daysAgo(5000).toISOString())).toBeNull()
  })

  it('follows the horizons reported, not the order the default policies imply', () => {
    // A stack with the 1-minute rollup disabled and empty: the answer is the 5-minute one, and
    // nothing here may assume 1m always outlives raw.
    const patchy = { ...DEFAULTS, telemetry_1m: null }
    expect(bestResolutionFor(patchy, daysAgo(100).toISOString()).key).toBe('5m')
  })

  it('is null when the horizons lookup did not answer, so no switch is offered on a guess', () => {
    expect(bestResolutionFor({}, daysAgo(100).toISOString())).toBeNull()
  })
})

describe('who may export, and for how long', () => {
  it('is an Administrator or a Shopfloor Manager, and the denied title says so', () => {
    expect(TELEMETRY_EXPORT_ROLES).toEqual(['Administrator', 'Shopfloor_Manager'])
    expect(mayExportReadings('Administrator')).toBe(true)
    expect(mayExportReadings('Shopfloor_Manager')).toBe(true)
    for (const role of ['Operator', 'Auditor', null, undefined, '']) expect(mayExportReadings(role)).toBe(false)
    expect(EXPORT_DENIED_TITLE).toBe('Requires Administrator or Shopfloor Manager')
  })

  it('takes the setting as the database reads it: 1 to 366, else 14', () => {
    expect(EXPORT_MAX_DAYS).toBe(14)
    expect(exportMaxDays(1)).toBe(1)
    expect(exportMaxDays(366)).toBe(366)
    expect(exportMaxDays(30)).toBe(30)
    for (const value of [0, 0.5, 367, -3, '30', null, undefined, NaN]) expect(exportMaxDays(value)).toBe(14)
  })

  it('measures a window in seconds, so exactly the limit is allowed and a second more is not', () => {
    const start = Date.parse('2026-11-02T10:00:00Z')
    const day = 24 * 60 * 60 * 1000
    expect(overExportLimit(start, start + 14 * day, 14)).toBe(false)
    expect(overExportLimit(start, start + 14 * day + 1000, 14)).toBe(true)
    expect(overExportLimit(start, start + day, 1)).toBe(false)
  })

  it("says why a window cannot go ahead, in the database's own sentence", () => {
    const start = Date.parse('2026-11-02T10:00:00Z')
    const day = 24 * 60 * 60 * 1000
    expect(exportWindowProblem(start, start + 14 * day, 14)).toBeNull()
    expect(exportWindowProblem(start, start + 14 * day + 1000, 14))
      .toBe('An export can cover at most 14 days, set on Settings › History. This window is 15 days.')
    expect(exportWindowProblem(start, start + 2 * day, 1))
      .toBe('An export can cover at most 1 day, set on Settings › History. This window is 2 days.')
    expect(exportWindowProblem(start, start, 14)).toBe('Set both ends of the custom range to export it.')
    expect(exportWindowProblem(undefined, start, 14)).toBe('Set both ends of the custom range to export it.')
    expect(overLimitShort(14)).toBe('over the 14-day export limit')
  })

  it('refuses more devices or metrics than one export may name, as the database does', () => {
    expect([EXPORT_MAX_DEVICES, EXPORT_MAX_METRICS]).toEqual([1000, 500])
    expect(exportSizeProblem(1000, 500)).toBeNull()
    expect(exportSizeProblem(1001, 3)).toBe('An export names at most 1,000 devices, and this selection has 1,001.')
    expect(exportSizeProblem(3, 501)).toBe('An export names at most 500 metrics, and these devices report 501.')
  })
})

describe("what the Area and Metric tabs' dialogs say", () => {
  it("names the area, the machines behind the charts and the cells they are in, and says the cells' figures are not in the file", () => {
    expect(areaExportScope('Boardroom', [5, 6, 3])).toBe('Boardroom · 14 machines in 3 cells')
    expect(areaExportScope('Hall C', [1])).toBe('Hall C · 1 machine in 1 cell')
    expect(areaExportNote()).toBe("The cells' means and totals are not in the file. It holds each machine's own readings.")
  })

  it('adds the Area-Wide devices, which are in no cell and so in no chart, in words that agree with their number', () => {
    expect(areaExportNote(1)).toMatch(/ 1 Area-Wide device is in no cell, so it is not in the file\.$/)
    expect(areaExportNote(2)).toMatch(/ 2 Area-Wide devices are in no cell, so they are not in the file\.$/)
  })

  it('names the devices a Metric tab lists, and how many of those that report the metric where a filter narrows them', () => {
    expect(metricExportScope(23, 23)).toBe('23 devices')
    expect(metricExportScope(1, 1)).toBe('1 device')
    expect(metricExportScope(23, 40)).toBe('23 of 40 devices')
    expect(metricExportScope(1, 1000)).toBe('1 of 1,000 devices')
    expect(metricExportNote(250, 12)).toBe('The file holds all 250 devices the tab lists, not only the 12 on this page.')
  })
})

describe('the CSV shape', () => {
  const doc = {
    resolution: 'raw', columns: ['time', 'asset_id', 'metric_name', 'value', 'unit'], max_rows: 50000,
    read_from: '2026-09-15T10:00:00.000Z', read_to: '2026-09-16T10:00:00.000Z', truncated: false,
    rows: [
      ['2026-09-15T10:00:00.000Z', 'dev1', 'Speed', 42.5, 'rpm'],
      ['2026-09-15T10:00:01.000Z', 'dev1', 'State', 'RUN', null],
      ['2026-09-15T10:00:02.000Z', 'dev2', 'Running', false, null],
    ],
  }

  it('is one row per reading: time, device, metric, value and unit', () => {
    expect(EXPORT_COLUMNS).toEqual(['time', 'device', 'metric', 'value', 'unit'])
    const rows = exportRows(doc, new Map([['dev1', 'Lathe 3']]))
    expect(rows.map(r => Object.keys(r))).toEqual(rows.map(() => EXPORT_COLUMNS))
    expect(rows[0]).toEqual({ time: '2026-09-15T10:00:00.000Z', device: 'Lathe 3', metric: 'Speed', value: 42.5, unit: 'rpm' })
  })

  it("names a device by the dashboard's name, and by its id where it is not known", () => {
    const rows = exportRows(doc, new Map([['dev1', 'Lathe 3']]))
    expect(rows.map(r => r.device)).toEqual(['Lathe 3', 'Lathe 3', 'dev2'])
  })

  it('keeps a number, a text and a flag as they are, so a genuine false or 0 is a value', () => {
    const rows = exportRows(doc)
    expect(rows.map(r => r.value)).toEqual([42.5, 'RUN', false])
    expect(exportRows({ rows: [['t', 'a', 'm', 0, null]] })[0].value).toBe(0)
  })

  it('is no rows for no document', () => {
    expect(exportRows(undefined)).toEqual([])
    expect(exportRows({})).toEqual([])
  })

  it("a comment row carries exactly the file's columns, so it adds none", () => {
    // downloadCSV takes the UNION of the rows' keys; a comment row with keys of its own would
    // silently widen the file.
    expect(Object.keys(commentRow('# hello', '# more'))).toEqual(EXPORT_COLUMNS)
    for (const key of ['raw', '1h']) expect(Object.keys(provenanceRow(key))).toEqual(EXPORT_COLUMNS)
    expect(commentRow('# hello')).toEqual({ time: '# hello', device: '', metric: '', value: '', unit: '' })
  })

  it('says in the file where it stops short: raw begins late, and rows end at the cap', () => {
    expect(noticeRows(doc, '2026-09-15T10:00:00.000Z', 50000)).toEqual([])
    const late = noticeRows({ ...doc, read_from: '2026-09-15T12:00:00.000Z' }, '2026-09-15T10:00:00.000Z', 50000)
    expect(late).toHaveLength(1)
    expect(Object.values(late[0]).join(' ')).toContain('STARTS AT 2026-09-15T12:00:00.000Z')
    const cut = noticeRows({ ...doc, truncated: true, read_to: '2026-09-15T23:53:00.000Z' }, '2026-09-15T10:00:00.000Z', 50000)
    expect(Object.values(cut[0]).join(' ')).toContain('TRUNCATED at 50000 rows')
    expect(Object.values(cut[0]).join(' ')).toContain('the rows end at 2026-09-15T23:53:00.000Z')
    // A rollup has no raw horizon to begin late at.
    expect(noticeRows({ ...doc, resolution: '1m', read_from: '2026-09-15T12:00:00.000Z' }, '2026-09-15T10:00:00.000Z', 50000)).toEqual([])
  })
})

describe('the provenance line', () => {
  it('names the resolution and the relation that produced the file', () => {
    const line = Object.values(provenanceRow('1h')).join(' ')
    expect(line).toContain('1-hour buckets')
    expect(line).toContain('public.telemetry_1h')
  })

  it('warns on a rollup export that the rows are not individual readings', () => {
    expect(Object.values(provenanceRow('5m')).join(' ')).toContain('NOT individual readings')
  })

  it('is present on a raw export too, so the absence of a line never has to be interpreted', () => {
    const line = Object.values(provenanceRow('raw')).join(' ')
    expect(line).toContain('raw samples')
    expect(line).toContain('public.telemetry')
  })
})
