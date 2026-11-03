/**
 * The time window's arithmetic (utils/timeWindow.js), in London's time zone, where 2026's clocks
 * went forward on 29 March and back on 25 October. The window is local time by design, so this
 * suite pins a zone, as every suite that reads its words does, and puts the machine's back
 * afterwards. `now` is passed in, never read from the clock, so nothing here depends on the day
 * it runs.
 */
import { describe, it, expect, afterAll } from 'vitest'
import {
  ALL_TIME, SPAN_IDS, TIME_PRESETS, calendarTicks, canStep, chooseSpan, holdsNow, jumpTo, parseLocal,
  rollingWindow, stepNames, stepWindow, timeWindow, windowBounds, windowFromQuery, windowToQuery,
  windowWords
} from '../utils/timeWindow'

const MACHINE_TZ = process.env.TZ
process.env.TZ = 'Europe/London'
afterAll(() => {
  if (MACHINE_TZ === undefined) delete process.env.TZ
  else process.env.TZ = MACHINE_TZ
})

const HOUR = 60 * 60 * 1000
/** A local time in London, as the Date the control would read from the clock. */
const local = (y, m, d, h = 0, mi = 0, s = 0) => new Date(y, m - 1, d, h, mi, s).getTime()
const day = (at) => ({ kind: 'calendar', span: 'day', at })
const span = (s, at) => ({ kind: 'calendar', span: s, at })
const length = (win, now) => {
  const { start, end } = windowBounds(win, now)
  return (end - start) / HOUR
}
/** The window's bounds as UTC instants, which is what the clock change moves. */
const instants = (win, now) => {
  const { start, end } = windowBounds(win, now)
  return [start.toISOString(), end.toISOString()]
}
const NOW = local(2026, 11, 2, 15, 20, 37)

describe('the zone this suite runs in', () => {
  it('is London, with both of 2026\'s clock changes', () => {
    expect(new Date(local(2026, 6, 1)).getTimezoneOffset()).toBe(-60)
    expect(new Date(local(2026, 12, 1)).getTimezoneOffset()).toBe(0)
  })
})

describe('a day is a calendar day in local time', () => {
  it('steps across 29 March 2026, when the clocks went forward, by date', () => {
    const before = day('2026-03-28')
    const spring = stepWindow(before, 1, NOW)
    expect(spring).toEqual(day('2026-03-29'))
    // Midnight GMT to midnight BST: 23 hours, not 24.
    expect(instants(spring, NOW)).toEqual(['2026-03-29T00:00:00.000Z', '2026-03-29T23:00:00.000Z'])
    expect(length(spring, NOW)).toBe(23)
    // And on to the next day, at its own midnight rather than 01:00.
    expect(stepWindow(spring, 1, NOW)).toEqual(day('2026-03-30'))
    expect(windowBounds(stepWindow(spring, 1, NOW), NOW).start.getHours()).toBe(0)
  })

  it('steps across 25 October 2026, when the clocks went back, by date', () => {
    const autumn = stepWindow(day('2026-10-26'), -1, NOW)
    expect(autumn).toEqual(day('2026-10-25'))
    expect(instants(autumn, NOW)).toEqual(['2026-10-24T23:00:00.000Z', '2026-10-26T00:00:00.000Z'])
    expect(length(autumn, NOW)).toBe(25)
    expect(stepWindow(autumn, -1, NOW)).toEqual(day('2026-10-24'))
    expect(length(stepWindow(autumn, -1, NOW), NOW)).toBe(24)
  })

  it('sends the day as since and until, the last millisecond inside', () => {
    expect(timeWindow(day('2026-03-29'), NOW)).toEqual({
      since: '2026-03-29T00:00:00.000Z',
      until: '2026-03-29T22:59:59.999Z',
    })
  })

  it('puts the axis ticks at local hours, so the clock change does not move them', () => {
    const { start, end } = windowBounds(day('2026-03-29'), NOW)
    const ticks = calendarTicks('day', start, end)
    expect(ticks.map(t => t.label)).toEqual(['00:00', '06:00', '12:00', '18:00', '00:00'])
    expect(ticks.map(t => t.at.getHours())).toEqual([0, 6, 12, 18, 0])
    // 06:00 BST is five hours into a 23-hour day, not a quarter of it.
    expect((ticks[1].at - start) / HOUR).toBe(5)
  })
})

describe('weeks start on Monday, and a week steps by seven days', () => {
  it('holds a Sunday in the week that began the Monday before', () => {
    const { start, end } = windowBounds(span('week', '2026-11-01'), NOW)
    expect(start).toEqual(new Date(local(2026, 10, 26)))
    expect(end).toEqual(new Date(local(2026, 11, 2)))
    expect(windowWords(span('week', '2026-11-01'), NOW)).toBe('Mon 26 Oct – Sun 1 Nov')
  })

  it('steps across the clock change at the same local midnight', () => {
    const week = span('week', '2026-10-21')
    const next = stepWindow(week, 1, NOW)
    expect(next).toEqual(span('week', '2026-10-28'))
    const { start, end } = windowBounds(week, NOW)
    // The week of 19 October holds the change, and is an hour longer than seven days.
    expect((end - start) / HOUR).toBe(7 * 24 + 1)
    expect(windowBounds(next, NOW).start.getHours()).toBe(0)
  })

  it('crosses the year boundary, naming both years', () => {
    // Looked at in March 2027, so the step forward is into the past.
    const later = local(2027, 3, 1)
    const turn = span('week', '2026-12-31')
    expect(windowWords(turn, later)).toBe('Mon, 28 Dec 2026 – Sun, 3 Jan 2027')
    const next = stepWindow(turn, 1, later)
    expect(next).toEqual(span('week', '2027-01-07'))
    expect(windowBounds(next, later).start).toEqual(new Date(local(2027, 1, 4)))
    expect(windowWords(next, later)).toBe('Mon 4 Jan – Sun 10 Jan')
    // In 2026 the same week is in the future, so there is no stepping into it.
    expect(stepWindow(turn, 1, NOW)).toBe(turn)
  })

  it('draws a tick at each midnight of the week', () => {
    const { start, end } = windowBounds(span('week', '2026-11-02'), NOW)
    expect(calendarTicks('week', start, end).map(t => t.label))
      .toEqual(['Mon 2', 'Tue 3', 'Wed 4', 'Thu 5', 'Fri 6', 'Sat 7', 'Sun 8', 'Mon 9'])
  })
})

describe('months and years step by date', () => {
  it('keeps the day of the month, or the last day of a shorter one', () => {
    expect(stepWindow(span('month', '2026-01-31'), 1, NOW)).toEqual(span('month', '2026-02-28'))
    expect(windowWords(span('month', '2026-10-15'), NOW)).toBe('October 2026')
  })

  it('crosses into the next year and back', () => {
    expect(stepWindow(span('month', '2026-12-10'), 1, local(2027, 6, 1))).toEqual(span('month', '2027-01-10'))
    expect(stepWindow(span('year', '2026-03-01'), -1, NOW)).toEqual(span('year', '2025-03-01'))
    expect(windowWords(span('year', '2025-03-01'), NOW)).toBe('2025')
    expect(windowBounds(span('year', '2026-07-04'), NOW).start).toEqual(new Date(local(2026, 1, 1)))
    expect(windowBounds(span('year', '2026-07-04'), NOW).end).toEqual(new Date(local(2027, 1, 1)))
  })

  it('names the span in the arrows, and Earlier and Later for a window that steps by its length', () => {
    expect(stepNames(span('week', '2026-11-02'))).toEqual({ earlier: 'Previous week', later: 'Next week' })
    expect(stepNames(rollingWindow('1h'))).toEqual({ earlier: 'Earlier', later: 'Later' })
    expect(stepNames({ kind: 'custom', from: '2026-11-02T10:05', to: '2026-11-02T14:20' }))
      .toEqual({ earlier: 'Earlier', later: 'Later' })
  })
})

describe('a rolling window becomes a fixed one when stepped', () => {
  it('turns Last 1 hour at 15:20, stepped back, into 13:20 to 14:20', () => {
    const fixed = stepWindow(rollingWindow('1h'), -1, NOW)
    expect(fixed).toEqual({ kind: 'custom', from: '2026-11-02T13:20', to: '2026-11-02T14:20' })
    expect(windowWords(fixed, NOW)).toBe('Mon 2 Nov, 13:20 – 14:20')
    // Fixed now, so it can step forward again, to the hour that ends at the minute it was made.
    expect(canStep(fixed, 1, NOW)).toBe(true)
    expect(stepWindow(fixed, 1, NOW)).toEqual({ kind: 'custom', from: '2026-11-02T14:20', to: '2026-11-02T15:20' })
  })

  it('cannot step later while rolling: it always holds now', () => {
    expect(holdsNow(rollingWindow('24h'), NOW)).toBe(true)
    expect(canStep(rollingWindow('24h'), 1, NOW)).toBe(false)
    expect(canStep(rollingWindow('24h'), -1, NOW)).toBe(true)
  })

  it('steps Last 24 hours across the spring clock change by date, at the same clock time', () => {
    const now = local(2026, 3, 30, 12, 0)
    const fixed = stepWindow(rollingWindow('24h'), -1, now)
    expect(fixed).toEqual({ kind: 'custom', from: '2026-03-28T12:00', to: '2026-03-29T12:00' })
  })

  it('leaves the rolling window open at the top when asked for', () => {
    const { since, until } = timeWindow(rollingWindow('1h'), NOW)
    expect(new Date(since).getTime()).toBe(NOW - HOUR)
    expect(until).toBe('')
  })
})

describe('a custom window steps by its own length', () => {
  const custom = { kind: 'custom', from: '2026-11-02T10:05', to: '2026-11-02T14:20' }

  it('moves by four hours and a quarter, back to back', () => {
    expect(stepWindow(custom, -1, NOW)).toEqual({ kind: 'custom', from: '2026-11-02T05:50', to: '2026-11-02T10:05' })
    expect(windowWords(custom, NOW)).toBe('Mon 2 Nov, 10:05 – 14:20')
  })

  it('moves whole days by date, so a clock change keeps midnight at midnight', () => {
    const days = { kind: 'custom', from: '2026-10-24T00:00', to: '2026-10-26T00:00' }
    expect(windowWords(days, NOW)).toBe('Sat 24 Oct – Sun 25 Oct')
    expect(stepWindow(days, 1, NOW)).toEqual({ kind: 'custom', from: '2026-10-26T00:00', to: '2026-10-28T00:00' })
  })

  it('cannot step later while it reaches now, nor at all with an end missing', () => {
    expect(canStep({ kind: 'custom', from: '2026-11-02T10:00', to: '2026-11-02T16:00' }, 1, NOW)).toBe(false)
    expect(canStep({ kind: 'custom', from: '2026-11-02T10:00', to: '' }, -1, NOW)).toBe(false)
    expect(windowWords({ kind: 'custom', from: '2026-11-02T10:00', to: '' }, NOW)).toBe('From Mon 2 Nov, 10:00')
  })
})

describe('choosing a span or a day', () => {
  it('keeps the day shown when the span changes', () => {
    const monday = day('2026-11-02')
    expect(chooseSpan(monday, 'week', NOW)).toEqual(span('week', '2026-11-02'))
    expect(windowWords(chooseSpan(monday, 'month', NOW), NOW)).toBe('November 2026')
    expect(chooseSpan(span('month', '2026-11-02'), 'day', NOW)).toEqual(monday)
  })

  it('shows the span holding the window\'s end, so Last 1 hour becomes Today', () => {
    expect(chooseSpan(rollingWindow('1h'), 'day', NOW)).toEqual(day('2026-11-02'))
    expect(windowWords(day('2026-11-02'), NOW)).toBe('Today, Mon 2 Nov')
    expect(chooseSpan(ALL_TIME, 'week', NOW)).toEqual(span('week', '2026-11-02'))
    // A custom window ending at midnight ends on the day before it.
    expect(chooseSpan({ kind: 'custom', from: '2026-10-30T22:00', to: '2026-10-31T00:00' }, 'day', NOW))
      .toEqual(day('2026-10-30'))
  })

  it('jumps keeping the span: in Week, a month ago is the week holding that day', () => {
    const week = span('week', '2026-11-02')
    expect(jumpTo(week, 'month-ago', NOW)).toEqual(span('week', '2026-10-02'))
    expect(windowWords(jumpTo(week, 'month-ago', NOW), NOW)).toBe('Mon 28 Sept – Sun 4 Oct')
    expect(jumpTo(rollingWindow('1h'), 'yesterday', NOW)).toEqual(day('2026-11-01'))
    expect(jumpTo(week, 'week-ago', NOW)).toEqual(span('week', '2026-10-26'))
    expect(jumpTo(day('2026-01-05'), 'year-start', NOW)).toEqual(day('2026-01-01'))
    expect(jumpTo(day('2026-01-05'), '2026-03-29', NOW)).toEqual(day('2026-03-29'))
    // A date that does not exist leaves the window as it was.
    expect(jumpTo(week, '2026-02-30', NOW)).toBe(week)
  })

  it('jumps from a rolling window to Day, or to the first span a page offers without Day', () => {
    expect(jumpTo(rollingWindow('1h'), 'yesterday', NOW, ['day', 'week'])).toEqual(day('2026-11-01'))
    expect(jumpTo(rollingWindow('1h'), 'yesterday', NOW, ['week', 'month'])).toEqual(span('week', '2026-11-01'))
    expect(jumpTo(span('week', '2026-11-02'), 'month-ago', NOW, ['week', 'month'])).toEqual(span('week', '2026-10-02'))
  })

  it('cannot step past today, and cannot step at all under All time', () => {
    expect(canStep(day('2026-11-02'), 1, NOW)).toBe(false)
    expect(canStep(day('2026-11-01'), 1, NOW)).toBe(true)
    expect(canStep(ALL_TIME, -1, NOW)).toBe(false)
    expect(canStep(ALL_TIME, 1, NOW)).toBe(false)
  })
})

describe('the window in the address', () => {
  const read = (search, opts) => windowFromQuery(new URLSearchParams(search), opts)

  it('reads span and at, range, and from and to, in that order', () => {
    expect(read('span=week&at=2026-11-02&range=1h')).toEqual(span('week', '2026-11-02'))
    expect(read('span=day')).toEqual(day(null))
    expect(read('from=2026-11-02T10:05&to=2026-11-02T14:20&range=1h'))
      .toEqual({ kind: 'custom', from: '2026-11-02T10:05', to: '2026-11-02T14:20' })
    expect(read('range=1h')).toEqual(rollingWindow('1h'))
  })

  it('reads the older since and until as from and to, the same window', () => {
    const win = read('range=custom&since=2026-08-01T09:30&until=2026-08-01T09:45')
    expect(win).toEqual({ kind: 'custom', from: '2026-08-01T09:30', to: '2026-08-01T09:46' })
    expect(timeWindow(win, NOW)).toEqual({
      since: new Date(local(2026, 8, 1, 9, 30)).toISOString(),
      until: new Date(local(2026, 8, 1, 9, 45, 59) + 999).toISOString(),
    })
    // A bare date named a whole day.
    expect(read('since=2026-08-01&until=2026-08-03'))
      .toEqual({ kind: 'custom', from: '2026-08-01T00:00', to: '2026-08-04T00:00' })
  })

  it('falls back on anything the page does not offer', () => {
    expect(read('span=fortnight')).toBe(ALL_TIME)
    expect(read('span=day&at=2026-02-30')).toEqual(day(null))
    expect(read('range=all')).toBe(ALL_TIME)
    const rolling24 = rollingWindow('24h')
    expect(read('range=all', { fallback: rolling24 })).toBe(rolling24)
    expect(read('range=all', { allTime: true, fallback: rolling24 })).toBe(ALL_TIME)
    expect(read('range=6h')).toBe(ALL_TIME)
    expect(read('range=1h', { ranges: TIME_PRESETS.filter(r => r.value !== '1h') })).toBe(ALL_TIME)
  })

  it('passes over a span the page does not offer, to the other keys and then the fallback', () => {
    const spans = ['day', 'week']
    expect(read('span=week&at=2026-11-02', { spans })).toEqual(span('week', '2026-11-02'))
    expect(read('span=month&at=2026-11-02', { spans })).toBe(ALL_TIME)
    expect(read('span=year&range=1h', { spans })).toEqual(rollingWindow('1h'))
    expect(read('span=month&from=2026-11-02T10:05&to=2026-11-02T14:20', { spans }))
      .toEqual({ kind: 'custom', from: '2026-11-02T10:05', to: '2026-11-02T14:20' })
    expect(SPAN_IDS).toEqual(['day', 'week', 'month', 'year'])
  })

  it('writes one way, leaving the default out', () => {
    const blank = { span: null, at: null, range: null, from: null, to: null, since: null, until: null }
    expect(windowToQuery(ALL_TIME)).toEqual(blank)
    expect(windowToQuery(span('month', '2026-11-02'))).toEqual({ ...blank, span: 'month', at: '2026-11-02' })
    expect(windowToQuery(rollingWindow('7d'))).toEqual({ ...blank, range: '7d' })
    expect(windowToQuery(ALL_TIME, rollingWindow('24h'))).toEqual({ ...blank, range: 'all' })
  })

  it('refuses a day or a time that does not exist rather than rolling it over', () => {
    expect(parseLocal('2026-04-31')).toBeNull()
    expect(parseLocal('2026-11-02T24:00')).toBeNull()
    expect(parseLocal('0002-11-02')).toBeNull()
    expect(parseLocal('2026-11-02T10:05')).toEqual(new Date(local(2026, 11, 2, 10, 5)))
  })
})
