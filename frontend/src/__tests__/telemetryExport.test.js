import { describe, it, expect } from 'vitest'
import {
  EXPORT_RESOLUTIONS, bestResolutionFor, commentRow, coversRange, exportColumns,
  provenanceRow, resolutionByKey, toExportRow
} from '../utils/telemetryExport'
import { telemetryValue, telemetryValueType } from '../utils/telemetryValue'
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

/** A stack with the default policies: raw 90 days, then 180 days, 1 year, 5 years. */
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

  it('raw sends no resolution parameter, because absent means raw and "raw" is refused', () => {
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

describe('the CSV shape', () => {
  const rawRow = {
    time: '2026-09-15T10:00:00Z', asset_id: 'gwy1', metric_name: 'Speed',
    val_double: 42.5, val_string: null, val_bool: null
  }
  const bucketRow = {
    bucket: '2026-09-15T10:00:00Z', asset_id: 'gwy1', metric_name: 'Speed',
    avg_double: 42.5, min_double: 40, max_double: 45, last_double: 44,
    last_string: null, last_bool: null, n_double: 60, n_rows: 60
  }
  const shape = (key, row) => toExportRow(row, key, { value: telemetryValue, valueType: telemetryValueType })

  it('raw keeps the flattened value/value_type columns', () => {
    expect(shape('raw', rawRow)).toEqual({
      time: '2026-09-15T10:00:00Z', asset_id: 'gwy1', metric_name: 'Speed',
      value: 42.5, value_type: 'double'
    })
  })

  it('a rollup carries its own columns rather than being squeezed into the raw shape', () => {
    // The issue's load-bearing requirement: a CSV that silently switched would break anyone
    // parsing it and would hand a user averages when they asked for samples.
    const out = shape('1h', bucketRow)
    expect(Object.keys(out)).toEqual(exportColumns('1h'))
    expect(out.bucket).toBe('2026-09-15T10:00:00Z')
    expect(out).not.toHaveProperty('time')
    expect(out).not.toHaveProperty('value')
    expect(out.avg_double).toBe(42.5)
    expect(out.min_double).toBe(40)
    expect(out.max_double).toBe(45)
  })

  it('the two shapes share no value column, so a parser cannot mistake one for the other', () => {
    const raw = new Set(exportColumns('raw'))
    const rollup = new Set(exportColumns('1h'))
    expect([...raw].filter(c => rollup.has(c))).toEqual(['asset_id', 'metric_name'])
  })

  it('a comment row carries exactly the resolution\'s columns, so it adds none to the file', () => {
    // downloadCSV takes the UNION of the rows' keys; a comment row with keys of its own would
    // silently widen the file.
    for (const key of ['raw', '1h']) {
      expect(Object.keys(commentRow(key, '# hello'))).toEqual(exportColumns(key))
      expect(Object.keys(provenanceRow(key))).toEqual(exportColumns(key))
    }
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
