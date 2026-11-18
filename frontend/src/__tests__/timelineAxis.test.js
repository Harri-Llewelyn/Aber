/**
 * The shared time axis's ticks: round local times, and labels that never touch at any span or
 * width, down to a phone's. In London's zone, so the days and the clock change are fixed.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { TICK_GAP_PX, labelPx, pointerWords, timelineTicks } from '../utils/timelineAxis'

const MACHINE_TZ = process.env.TZ
process.env.TZ = 'Europe/London'
afterAll(() => {
  if (MACHINE_TZ === undefined) delete process.env.TZ
  else process.env.TZ = MACHINE_TZ
})

const at = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).getTime()

/** The spans the time control offers, over London's Monday 2 November 2026, and a rolling day and a short one. */
const SPANS = {
  Day: [at(2026, 11, 2), at(2026, 11, 3)],
  Week: [at(2026, 11, 2), at(2026, 11, 9)],
  Month: [at(2026, 11, 1), at(2026, 12, 1)],
  Year: [at(2026, 1, 1), at(2027, 1, 1)],
  'Last 24 hours': [at(2026, 11, 1, 15, 21), at(2026, 11, 2, 15, 21)],
  'Last 7 days': [at(2026, 10, 26, 15, 21), at(2026, 11, 2, 15, 21)],
  'an hour': [at(2026, 11, 2, 10), at(2026, 11, 2, 11)],
  'a minute': [at(2026, 11, 2, 10), at(2026, 11, 2, 10, 1)],
}
/** A plot area's width in a window as narrow as a phone's (360 px, less the gutters) and up to a wide screen's. */
const WIDTHS = [244, 360, 600, 1000, 1800]

/** Each label's edges in pixels along the axis, as it is drawn: centred, or held inside an end. */
const edges = (t, width) => {
  const x = t.f * width
  const px = labelPx(t.label)
  return t.align === 'start' ? [x, x + px] : t.align === 'end' ? [x - px, x] : [x - px / 2, x + px / 2]
}

describe('the shared axis ticks', () => {
  for (const [name, [start, end]] of Object.entries(SPANS)) {
    it(`keeps the labels of ${name} apart at every width, and inside the axis`, () => {
      for (const width of WIDTHS) {
        const ticks = timelineTicks(start, end, width)
        expect(ticks.length, `${name} at ${width}px`).toBeGreaterThan(0)
        const boxes = ticks.map(t => edges(t, width))
        boxes.forEach(([left, right], i) => {
          expect(left, `${ticks[i].label} at ${width}px`).toBeGreaterThanOrEqual(-0.5)
          expect(right, `${ticks[i].label} at ${width}px`).toBeLessThanOrEqual(width + 0.5)
          if (i > 0) expect(left - boxes[i - 1][1], `${ticks[i - 1].label} then ${ticks[i].label} at ${width}px`).toBeGreaterThanOrEqual(TICK_GAP_PX - 0.5)
        })
        // In time order, and no label beside itself.
        expect(ticks.map(t => t.at)).toEqual([...ticks.map(t => t.at)].sort((a, b) => a - b))
        ticks.forEach((t, i) => { if (i > 0) expect(t.label).not.toBe(ticks[i - 1].label) })
      }
    })
  }

  it('puts a tick on a round local time, and every one inside the window, ends included', () => {
    const [start, end] = SPANS.Day
    const ticks = timelineTicks(start, end, 1000)
    expect(ticks.map(t => t.label)).toEqual(['00:00', '03:00', '06:00', '09:00', '12:00', '15:00', '18:00', '21:00', '00:00'])
    expect(ticks[0].f).toBe(0)
    expect(ticks.at(-1).f).toBe(1)
    expect(ticks[0].align).toBe('start')
    expect(ticks.at(-1).align).toBe('end')
    expect(ticks.every(t => t.at >= start && t.at <= end)).toBe(true)
  })

  it('takes fewer, coarser ticks as the axis narrows, rather than labels that run together', () => {
    const [start, end] = SPANS.Day
    const counts = WIDTHS.map(w => timelineTicks(start, end, w).length)
    expect(counts).toEqual([...counts].sort((a, b) => a - b))
    expect(timelineTicks(start, end, 244).map(t => t.label)).toEqual(['00:00', '12:00', '00:00'])
    expect(timelineTicks(start, end, 600).map(t => t.label)).toEqual(['00:00', '06:00', '12:00', '18:00', '00:00'])
  })

  it('names a Week by its days and a longer window by its dates', () => {
    expect(timelineTicks(...SPANS.Week, 1000).map(t => t.label)).toEqual(['Mon 2', 'Tue 3', 'Wed 4', 'Thu 5', 'Fri 6', 'Sat 7', 'Sun 8', 'Mon 9'])
    expect(timelineTicks(...SPANS.Week, 1800).map(t => t.label).slice(0, 3)).toEqual(['Mon 2', '12:00', 'Tue 3'])
    expect(timelineTicks(...SPANS.Month, 1000).map(t => t.label).every(l => /^\d+ Nov$/.test(l))).toBe(true)
    expect(timelineTicks(...SPANS.Year, 1000).map(t => t.label)).toEqual(['Jan 2026', 'Apr 2026', 'Jul 2026', 'Oct 2026', 'Jan 2027'])
    expect(timelineTicks(...SPANS.Year, 1800).map(t => t.label).slice(0, 3)).toEqual(['Jan 2026', 'Feb 2026', 'Mar 2026'])
  })

  it('says the day at each midnight on a window longer than a day, and the clock between', () => {
    const labels = timelineTicks(at(2026, 11, 2), at(2026, 11, 5), 1800).map(t => t.label)
    expect(labels).toContain('Tue 3')
    expect(labels).toContain('06:00')
    expect(labels).not.toContain('00:00')
  })

  it('keeps a tick on its round time across the clock change', () => {
    // The clocks went back at 02:00 on Sunday 25 October 2026: the day is 25 hours long.
    const [start, end] = [at(2026, 10, 25), at(2026, 10, 26)]
    const ticks = timelineTicks(start, end, 1000)
    expect(ticks.every(t => new Date(t.at).getMinutes() === 0)).toBe(true)
    expect(new Set(ticks.map(t => t.at)).size).toBe(ticks.length)
  })

  it("draws every label centred for an axis that cannot hold one at its end, and leaves out one that would run past the gutters", () => {
    const [start, end] = SPANS.Week
    const room = [56, 28]
    for (const width of WIDTHS) {
      const ticks = timelineTicks(start, end, width, { centred: true, roomPx: room })
      expect(ticks.length).toBeGreaterThan(0)
      expect(ticks.every(t => t.align === 'middle')).toBe(true)
      ticks.forEach((t, i) => {
        const [left, right] = edges(t, width)
        expect(left).toBeGreaterThanOrEqual(-room[0] - 0.5)
        expect(right).toBeLessThanOrEqual(width + room[1] + 0.5)
        if (i > 0) expect(left - edges(ticks[i - 1], width)[1]).toBeGreaterThanOrEqual(TICK_GAP_PX - 0.5)
      })
    }
    // A label of 5 glyphs is 35px: centred on the last tick it runs 17px past the end, within 28.
    expect(timelineTicks(start, end, 1000, { centred: true, roomPx: room }).at(-1).label).toBe('Mon 9')
    // With no room at the ends, the ticks at the ends go.
    expect(timelineTicks(start, end, 1000, { centred: true }).some(t => t.f === 0 || t.f === 1)).toBe(false)
  })

  it('draws no tick for a window with no length', () => {
    expect(timelineTicks(at(2026, 11, 2), at(2026, 11, 2), 600)).toEqual([])
  })

  it('reads an axis it cannot measure yet at a default width, so a first render draws labels apart', () => {
    expect(timelineTicks(...SPANS.Week, 0).length).toBeGreaterThan(1)
  })
})

describe("the pointer's time on the axis", () => {
  it('is to the second inside an hour, the clock inside a day, and the date and clock beyond', () => {
    const t = at(2026, 11, 2, 10, 5)
    expect(pointerWords(t, 30 * 60 * 1000)).toBe('10:05:00')
    expect(pointerWords(t, 24 * 60 * 60 * 1000)).toBe('10:05')
    expect(pointerWords(t, 7 * 24 * 60 * 60 * 1000)).toBe('2 Nov 10:05')
  })
})
