/**
 * How often a backup schedule runs, which the Backups page halves for its duration warning. A wrong
 * answer either warns about every backup or never warns, so each form pg_cron takes is pinned here.
 */
import { describe, it, expect } from 'vitest'
import { cronIntervalSeconds } from '../utils/cronInterval'

const HOUR = 3600
const DAY = 24 * HOUR
// A fixed start, so a schedule's first gap does not depend on when the test runs.
const FROM = Date.UTC(2026, 9, 12, 10, 17)

describe('cronIntervalSeconds', () => {
  it.each([
    ['30 2 * * *', DAY],
    ['0 * * * *', HOUR],
    ['*/15 * * * *', 15 * 60],
    ['0 */6 * * *', 6 * HOUR],
    ['0 2,14 * * *', 12 * HOUR],
    // Uneven: the shortest gap is the one a backup has to fit in.
    ['0 2,5 * * *', 3 * HOUR],
    ['0 9-17 * * 1-5', HOUR],
    ['0 3 * * 0', 7 * DAY],
    ['0 3 * * 7', 7 * DAY],
    ['@daily', DAY],
    ['@hourly', HOUR],
    ['@weekly', 7 * DAY],
    ['30 seconds', 30],
  ])('reads %s', (schedule, expected) => {
    expect(cronIntervalSeconds(schedule, FROM)).toBe(expected)
  })

  it('reads a monthly schedule from its two runs', () => {
    // 1 November and 1 December 2026.
    expect(cronIntervalSeconds('0 0 1 * *', FROM)).toBe(30 * DAY)
  })

  it('matches either day when the day of month and the day of week are both given', () => {
    // The 1st, or any Monday: Monday 2 November follows Sunday 1 November by a day.
    expect(cronIntervalSeconds('0 0 1 * 1', FROM)).toBe(DAY)
  })

  it.each([
    [''],
    ['   '],
    [null],
    [undefined],
    ['0 2 * * MON'],
    ['0 25 * * *'],
    ['0 2 * *'],
    ['every day'],
    ['90 seconds'],
    ['0 0 1 1 *'],
  ])('answers null for %j', (schedule) => {
    expect(cronIntervalSeconds(schedule, FROM)).toBeNull()
  })
})
