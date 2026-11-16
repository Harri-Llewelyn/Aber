/**
 * The band a state is drawn as: its runs edge to edge on the window's own scale, rounded at its two
 * ends only, named only where the name fits, never narrower than a pixel, and parted by a hairline
 * only where two neighbours' colours are too near to tell apart.
 */
import React from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { render, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StateBand, StateBandKey } from '../components/common/StateBand'
import { NEAR_HUE_DEG, changeCount, hueGap, stateHue, stateKey, stateShares } from '../utils/history'
import { declaration } from '../test/themeColours'

const APP_CSS = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8')

const MIN = 60 * 1000
const T0 = Date.parse('2026-11-02T00:00:00Z')
/** The window is 1000 minutes and the band 1000px, so a minute is a pixel. */
const WINDOW = { start: T0, end: T0 + 1000 * MIN }

const run = (state, from, to, carried = []) => ({
  state, from, to, startMs: T0 + from * MIN, endMs: T0 + to * MIN,
  carried: carried.map(([a, b]) => ({ startMs: T0 + a * MIN, endMs: T0 + b * MIN })),
})

const draw = (runs, marks = [], flag = false) => {
  const { container } = render(<StateBand runs={runs} marks={marks} flag={flag} {...WINDOW} />)
  return [...container.querySelectorAll('.chart-state')]
}
const box = (el) => ({ left: parseFloat(el.style.left), width: parseFloat(el.style.width) })

/** Two values whose hues are, and are not, within NEAR_HUE_DEG of each other. */
const pairs = () => {
  const names = Array.from({ length: 60 }, (_, i) => `PROGRAM_${i}`)
  const near = []
  const far = []
  for (const a of names) {
    for (const b of names) {
      if (a >= b) continue
      if (hueGap(a, b) < NEAR_HUE_DEG - 5 && !near.length) near.push(a, b)
      if (hueGap(a, b) > NEAR_HUE_DEG + 20 && !far.length) far.push(a, b)
    }
  }
  return { near, far }
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('the band of a state', () => {
  it('lays each run where its time is, each starting where the one before stopped, with no gap', () => {
    const boxes = draw([run('A', 0, 100), run('B', 100, 400), run('C', 400, 1000)]).map(box)
    expect(boxes.map(b => b.left)).toEqual([0, 10, 40])
    // A run reaches a hair under the next, so no rounding of the two edges can part them; the band's last ends exactly at the window's.
    const [a, b, c] = boxes
    expect(a.left + a.width).toBeGreaterThan(b.left)
    expect(a.left + a.width - b.left).toBeLessThan(0.05)
    expect(b.left + b.width).toBeGreaterThan(c.left)
    expect(b.left + b.width - c.left).toBeLessThan(0.05)
    expect(c.left + c.width).toBe(100)
  })

  it('rounds only the two ends of a band, and a break in the readings ends one band and starts another', () => {
    const [a, b, c] = draw([run('A', 0, 100), run('B', 100, 400), run('C', 400, 1000)])
    expect([a, b, c].map(r => [r.classList.contains('chart-state-first'), r.classList.contains('chart-state-last')]))
      .toEqual([[true, false], [false, false], [false, true]])
    const [p, q] = draw([run('A', 0, 100), run('B', 200, 300)])
    expect([p, q].map(r => [r.classList.contains('chart-state-first'), r.classList.contains('chart-state-last')]))
      .toEqual([[true, true], [true, true]])
  })

  it('draws the corners and the edge in App.css as the ends of a band, and no run with a border of its own', () => {
    expect(declaration(APP_CSS, '.chart-state', 'border-width')).toBe('1px 0')
    expect(declaration(APP_CSS, '.chart-state', 'border-radius')).toBeNull()
    expect(declaration(APP_CSS, '.chart-state-first', 'border-left-width')).toBe('1px')
    expect(declaration(APP_CSS, '.chart-state-last', 'border-right-width')).toBe('1px')
    expect(declaration(APP_CSS, '.chart-state-first', 'border-top-left-radius')).toBe('var(--radius-xs)')
    expect(declaration(APP_CSS, '.chart-state-last', 'border-bottom-right-radius')).toBe('var(--radius-xs)')
  })

  it('is never narrower than a pixel, and a run that thin is drawn over its neighbours', () => {
    expect(declaration(APP_CSS, '.chart-state', 'min-width')).toBe('1px')
    expect(declaration(APP_CSS, '.chart-state.chart-state-thin', 'z-index')).toBe('1')
    // 0.4 of a minute is 0.4px: its width is its own, and the 1px floor is the stylesheet's.
    const [thin] = draw([run('A', 0, 0.4)])
    expect(box(thin).width).toBeCloseTo(0.04, 5)
  })

  it('names a run only where its name fits, and keeps a narrower run at its own colour and width', () => {
    const [wide, narrow] = draw([run('RUNNING', 0, 100), run('IDLE', 100, 110)])
    expect(wide.textContent).toBe('RUNNING')
    expect(wide.classList.contains('chart-state-thin')).toBe(false)
    expect(narrow.textContent).toBe('')
    expect(narrow.classList.contains('chart-state-thin')).toBe(true)
    expect(narrow.style.getPropertyValue('--state-hue')).toBe(String(stateHue('IDLE')))
    expect(box(narrow).width).toBeCloseTo(1, 5)
  })

  it('hatches the carried stretch inside a run, across the run and not the band', () => {
    const [first] = draw([run('A', 0, 200, [[50, 200]])])
    const [held] = first.querySelectorAll('.chart-state-carried')
    expect(box(held)).toEqual({ left: 25, width: 75 })
  })

  it('parts two neighbours with a hairline only where their hues are too near to tell apart, and only on a run wide enough', () => {
    const { near, far } = pairs()
    expect(near).toHaveLength(2)
    expect(far).toHaveLength(2)
    const divided = (r) => r.classList.contains('chart-state-divided')
    expect(draw([run(near[0], 0, 100), run(near[1], 100, 200)]).map(divided)).toEqual([false, true])
    cleanup()
    expect(draw([run(far[0], 0, 100), run(far[1], 100, 200)]).map(divided)).toEqual([false, false])
    cleanup()
    // A run of 3px would be all hairline.
    expect(draw([run(near[0], 0, 100), run(near[1], 100, 103)]).map(divided)).toEqual([false, false])
    cleanup()
    // Across a break there is nothing to part.
    expect(draw([run(near[0], 0, 100), run(near[1], 200, 300)]).map(divided)).toEqual([false, false])
  })

  it('dots a bucket that held more than one value along the foot of the band', () => {
    const { container } = render(<StateBand runs={[run('A', 0, 500)]} marks={[{ startMs: T0 + 100 * MIN, endMs: T0 + 150 * MIN }]} {...WINDOW} />)
    expect(box(container.querySelector('.chart-state-mixed'))).toEqual({ left: 10, width: 5 })
    expect(declaration(APP_CSS, '.chart-state-mixed', 'z-index')).toBe('2')
  })
})

describe('the band of a flag', () => {
  it('draws true and false in their two fixed colours, never hashed, and parts them with no hairline', () => {
    const runs = draw([run('true', 0, 200), run('false', 200, 210), run('true', 210, 600), run('false', 600, 1000)], [], true)
    expect(runs.map(r => r.className.match(/chart-flag-(true|false)/)[1])).toEqual(['true', 'false', 'true', 'false'])
    expect(runs.some(r => r.style.getPropertyValue('--state-hue'))).toBe(false)
    expect(runs.some(r => r.classList.contains('chart-state-divided'))).toBe(false)
    expect(runs.map(r => r.textContent)).toEqual(['true', '', 'true', 'false'])
    expect(declaration(APP_CSS, '.chart-flag-true', '--tone-fill')).toBe('var(--chart-true)')
  })

  it('is as flush, rounded and thin-run safe as a state', () => {
    const [a, b] = draw([run('true', 0, 500), run('false', 500, 1000)], [], true)
    expect(a.classList.contains('chart-state-first')).toBe(true)
    expect(b.classList.contains('chart-state-last')).toBe(true)
    expect(box(a).left + box(a).width).toBeGreaterThan(box(b).left)
  })
})

describe("a flag's key", () => {
  const key = () => {
    const runs = [run('true', 0, 960), run('false', 960, 1000)]
    return stateKey(stateShares(runs))
  }
  const items = (container) => [...container.querySelectorAll('.chart-state-key li')].map(li => li.textContent)

  it('says each value, its share and its time, then how many times it changed', () => {
    const { container } = render(<StateBandKey stateKey={key()} flag changes={changeCount({ runs: [] }, [run('true', 0, 1), run('false', 1, 2), run('true', 2, 3)])} />)
    expect(items(container)).toEqual(['true96%16 h', 'false4%40 min', '2 changes'])
    expect([...container.querySelectorAll('.chart-state-key-value')].map(li => li.classList.contains('chart-flag-true'))).toEqual([true, false])
    expect(container.querySelector('.chart-state-key-value').style.getPropertyValue('--state-hue')).toBe('')
  })

  it('says at least that many when only buckets were read, and one change in the singular', () => {
    const { container } = render(<StateBandKey stateKey={key()} flag changes={changeCount({}, [run('true', 0, 1), run('false', 1, 2)])} />)
    expect(items(container).at(-1)).toBe('at least 1 change')
  })

  it("leaves a state's key as it was: no time, no count", () => {
    const { container } = render(<StateBandKey stateKey={key()} />)
    expect(items(container)).toEqual(['true96%', 'false4%'])
  })
})
