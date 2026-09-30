import { describe, it, expect } from 'vitest'
import {
  formatDateTime, formatDate, formatRelative, formatDuration, formatBytes, plural, NO_VALUE
} from '../utils/format'

const NOW = new Date(2026, 8, 29, 15, 0, 0).getTime()

describe('formatDateTime and formatDate', () => {
  it('writes the day, short month, year and minute, without seconds', () => {
    expect(formatDateTime(new Date(2026, 8, 29, 14, 30, 45))).toBe('29 Sept 2026, 14:30')
    expect(formatDate(new Date(2026, 0, 5, 9, 5))).toBe('5 Jan 2026')
  })

  it('accepts an ISO string or epoch milliseconds', () => {
    const d = new Date(2026, 8, 29, 14, 30)
    expect(formatDateTime(d.toISOString())).toBe('29 Sept 2026, 14:30')
    expect(formatDate(d.getTime())).toBe('29 Sept 2026')
  })

  it('falls back to a dash for a missing or invalid timestamp', () => {
    for (const bad of [null, undefined, '', 'not a date', NaN]) {
      expect(formatDateTime(bad)).toBe(NO_VALUE)
      expect(formatDate(bad)).toBe(NO_VALUE)
    }
  })
})

describe('formatRelative', () => {
  it.each([
    [0, 'just now'],
    [9, 'just now'],
    [12, '12s ago'],
    [60, '1m ago'],
    [5 * 60, '5m ago'],
    [3 * 3600, '3h ago'],
    [4 * 86400, '4d ago'],
    [29 * 86400, '29d ago']
  ])('%is ago reads as "%s"', (seconds, expected) => {
    expect(formatRelative(NOW - seconds * 1000, NOW)).toBe(expected)
  })

  it('switches to the date from 30 days', () => {
    const ts = NOW - 30 * 86400 * 1000
    expect(formatRelative(ts, NOW)).toBe(formatDate(ts))
  })

  it('reads a future timestamp as just now and a bad one as a dash', () => {
    expect(formatRelative(NOW + 5000, NOW)).toBe('just now')
    expect(formatRelative(null, NOW)).toBe(NO_VALUE)
    expect(formatRelative('nope', NOW)).toBe(NO_VALUE)
  })
})

describe('formatDuration', () => {
  it('gives the two largest units', () => {
    expect(formatDuration(45)).toBe('45s')
    expect(formatDuration(720)).toBe('12m')
    expect(formatDuration(3 * 3600 + 300)).toBe('3h 5m')
    expect(formatDuration(2 * 86400 + 4 * 3600)).toBe('2d 4h')
  })

  it('falls back to a dash for a value that is not a non-negative number', () => {
    for (const bad of [null, undefined, '', -1, 'abc', NaN]) expect(formatDuration(bad)).toBe(NO_VALUE)
  })
})

describe('formatBytes', () => {
  it('uses binary units with one decimal from KiB', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1.0 KiB')
    expect(formatBytes(13_002_342)).toBe('12.4 MiB')
    expect(formatBytes(1024 ** 3)).toBe('1.0 GiB')
  })

  it('falls back to a dash for null or a value that is not a non-negative number', () => {
    for (const bad of [null, undefined, '', -1, 'abc', NaN]) expect(formatBytes(bad)).toBe(NO_VALUE)
  })
})

describe('plural', () => {
  it('counts with the right noun', () => {
    expect(plural(1, 'cell')).toBe('1 cell')
    expect(plural(0, 'cell')).toBe('0 cells')
    expect(plural(3, 'cell')).toBe('3 cells')
    expect(plural(2, 'entity', 'entities')).toBe('2 entities')
  })

  it('reads a count that is not a number as zero', () => {
    expect(plural(undefined, 'cell')).toBe('0 cells')
  })
})
