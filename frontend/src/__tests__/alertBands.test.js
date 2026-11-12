/**
 * The shading of firing periods on History's charts (components/common/alertBands.js): each
 * occurrence clipped to the window, a still-firing one running to now, several alerts each a band
 * of their own, and the uPlot plugin that paints them inside the plot area, marks their edges and
 * names the alerts under the pointer. A stand-in plot records what the plugin draws. In London's
 * zone.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, afterAll } from 'vitest'
import { alertBandPalette, alertBands, alertBandsPlugin, bandText, bandsAt } from '../components/common/alertBands'
import { occurrenceRow } from '../utils/alertHistory'

const MACHINE_TZ = process.env.TZ
process.env.TZ = 'Europe/London'
afterAll(() => {
  if (MACHINE_TZ === undefined) delete process.env.TZ
  else process.env.TZ = MACHINE_TZ
})

const at = (hhmm) => Date.parse(`2026-11-02T${hhmm}:00Z`)
const START = at('10:00')
const END = at('12:00')
const NOW = at('11:30')

const row = (id, starts, ended, over = {}) => occurrenceRow({
  occurrence: {
    id, alert_name: over.name ?? 'Spindle Overload', severity: over.severity ?? 'warning',
    status: ended ? 'resolved' : 'firing', starts_at: `2026-11-02T${starts}:00Z`,
  },
  ended_at: ended ? `2026-11-02T${ended}:00Z` : null,
  replaced: false,
})
const span = { start: START, end: END, now: NOW }

describe('the band maths', () => {
  it('draws an occurrence inside the window from its start to its end, both edges its own', () => {
    expect(alertBands([row('a', '10:15', '10:45')], span)).toEqual([{
      id: 'a', name: 'Spindle Overload', severity: 'warning', from: at('10:15'), to: at('10:45'),
      starts: at('10:15'), ends: at('10:45'), firing: false, startsInside: true, endsInside: true,
    }])
  })

  it('clips one that began before the window or ended after it, and says which edge is the window\'s', () => {
    const [before, after] = alertBands([row('a', '09:00', '10:20'), row('b', '11:50', '12:30')], span)
    expect(before).toMatchObject({ from: START, to: at('10:20'), startsInside: false, endsInside: true })
    expect(after).toMatchObject({ from: at('11:50'), to: END, startsInside: true, endsInside: false })
  })

  it('runs one still firing to now, and to the window\'s end when now is past it', () => {
    expect(alertBands([row('a', '11:00', null)], span)[0]).toMatchObject({ from: at('11:00'), to: NOW, firing: true, endsInside: false })
    expect(alertBands([row('a', '11:00', null)], { ...span, now: at('13:00') })[0]).toMatchObject({ to: END })
    expect(alertBands([row('a', '09:00', null)], span)[0]).toMatchObject({ from: START, to: NOW, startsInside: false })
  })

  it('drops one that leaves nothing inside the window', () => {
    expect(alertBands([
      row('before', '09:00', '10:00'), row('after', '12:00', '12:10'), row('future', '11:45', null),
    ], span)).toEqual([])
  })

  it('gives several alerts a band each, in order of start, and finds every one over a moment', () => {
    const bands = alertBands([
      row('late', '11:00', '11:20', { name: 'Coolant Low', severity: 'critical' }),
      row('early', '10:10', '11:10'),
    ], span)
    expect(bands.map(b => b.id)).toEqual(['early', 'late'])
    expect(bandsAt(bands, at('11:05')).map(b => b.id)).toEqual(['early', 'late'])
    expect(bandsAt(bands, at('10:30')).map(b => b.id)).toEqual(['early'])
    expect(bandsAt(bands, at('11:10')).map(b => b.id)).toEqual(['late'])
    expect(bandsAt(bands, at('11:45'))).toEqual([])
  })

  it('names each band, its severity, and its own times, not the window\'s', () => {
    const [done, firing] = alertBands([row('a', '09:40', '10:15'), row('b', '11:00', null, { severity: 'critical' })], span)
    expect(bandText(done)).toBe('Spindle Overload, warning · 2 Nov 09:40 – 10:15, 35 min')
    expect(bandText(firing)).toBe('Spindle Overload, critical · since 2 Nov 11:00, firing')
  })
})

describe('the palette', () => {
  it('is the danger token, translucent for the fill and solid for the edges, and its text token', () => {
    const tokens = { '--danger': '#ff4d6d', '--danger-text': '#ff6b85', '--font-mono': "'JetBrains Mono', monospace" }
    expect(alertBandPalette(n => tokens[n])).toEqual({
      fill: 'rgba(255, 77, 109, 0.12)', edge: '#ff4d6d', text: '#ff6b85', font: "11px 'JetBrains Mono', monospace",
    })
  })
})

/**
 * A plot 1000 canvas pixels wide from x = 100, 120 tall from y = 10, over 10:00 to 12:00, so a
 * minute is 1000 / 120 px. Its context records each call.
 */
function fakePlot() {
  const calls = []
  const ctx = new Proxy({}, {
    get: (target, key) => (key in target ? target[key]
      : (...args) => { calls.push([key, ...args]); return key === 'measureText' ? { width: String(args[0]).length * 7 } : undefined }),
    set: (target, key, value) => { target[key] = value; calls.push(['set', key, value]); return true },
  })
  const over = document.createElement('div')
  Object.defineProperty(over, 'clientWidth', { value: 1000 })
  const u = {
    ctx, over, bbox: { left: 100, top: 10, width: 1000, height: 120 }, cursor: { left: null },
    valToPos: (s) => 100 + ((s * 1000 - START) / (END - START)) * 1000,
    posToVal: (px) => (START + (px / 1000) * (END - START)) / 1000,
  }
  return { u, calls, over }
}
const run = (plugin, hook, u) => plugin.hooks[hook].forEach(fn => fn(u))
const PAINT = () => ({ fill: 'fill-token', edge: 'edge-token', text: 'text-token', font: '11px monospace' })

describe('the plugin', () => {
  const bands = alertBands([row('a', '09:00', '10:30'), row('b', '11:00', null, { name: 'Coolant Low' })], span)

  it('fills each band across the plot area\'s height, kept inside its left and right', () => {
    const plugin = alertBandsPlugin(bands, { palette: PAINT })
    const { u, calls } = fakePlot()
    run(plugin, 'init', u)
    run(plugin, 'drawClear', u)
    const fills = calls.filter(c => c[0] === 'fillRect')
    expect(fills).toEqual([['fillRect', 100, 10, 250, 120], ['fillRect', 600, 10, 250, 120]])
    expect(calls).toContainEqual(['set', 'fillStyle', 'fill-token'])
    for (const [, x, , w] of fills) {
      expect(x).toBeGreaterThanOrEqual(u.bbox.left)
      expect(x + w).toBeLessThanOrEqual(u.bbox.left + u.bbox.width)
    }
  })

  it('marks only an occurrence\'s own edges inside the window, and names each band wide enough', () => {
    const plugin = alertBandsPlugin(bands, { palette: PAINT })
    const { u, calls } = fakePlot()
    run(plugin, 'init', u)
    run(plugin, 'draw', u)
    // a began before the window, so only its end at 10:30 is an edge; b fires on to now, so only its start.
    expect(calls.filter(c => c[0] === 'moveTo').map(c => c[1])).toEqual([350, 600])
    expect(calls.filter(c => c[0] === 'fillText').map(c => c[1])).toEqual(['Spindle Overload', 'Coolant Low'])
    expect(calls).toContainEqual(['set', 'strokeStyle', 'edge-token'])
    expect(calls).toContainEqual(['set', 'fillStyle', 'text-token'])
  })

  it('names, under the pointer, every alert firing then, on the chart the pointer is on only', () => {
    const plugin = alertBandsPlugin(bands, { palette: PAINT })
    const { u, over } = fakePlot()
    run(plugin, 'init', u)
    const readout = over.querySelector('.chart-alert-readout')
    expect(readout.hidden).toBe(true)
    expect(readout.getAttribute('aria-hidden')).toBe('true')

    // A synced chart moves its cursor too, but the pointer is not on it: no readout there.
    u.cursor.left = 550
    run(plugin, 'setCursor', u)
    expect(readout.hidden).toBe(true)

    over.dispatchEvent(new Event('pointerenter'))
    u.cursor.left = 650
    run(plugin, 'setCursor', u)
    expect(readout.hidden).toBe(false)
    expect(readout.textContent).toBe('Coolant Low, warning · since 2 Nov 11:00, firing')
    expect(readout.style.left).toBe('650px')

    u.cursor.left = 400
    run(plugin, 'setCursor', u)
    expect(readout.hidden).toBe(true)

    u.cursor.left = 100
    run(plugin, 'setCursor', u)
    expect(readout.textContent).toBe('Spindle Overload, warning · 2 Nov 09:00 – 10:30, 1 h 30 min')
    expect(readout.dataset.edge).toBe('start')

    over.dispatchEvent(new Event('pointerleave'))
    expect(readout.hidden).toBe(true)
  })

  it('keeps each plot its own, and lets go of it when the plot goes', () => {
    const plugin = alertBandsPlugin(bands, { palette: PAINT })
    const one = fakePlot()
    const two = fakePlot()
    run(plugin, 'init', one.u)
    run(plugin, 'init', two.u)
    expect(one.over.querySelectorAll('.chart-alert-readout')).toHaveLength(1)
    expect(two.over.querySelectorAll('.chart-alert-readout')).toHaveLength(1)
    run(plugin, 'destroy', one.u)
    run(plugin, 'drawClear', one.u)
    expect(one.calls.filter(c => c[0] === 'fillRect')).toEqual([])
    run(plugin, 'drawClear', two.u)
    expect(two.calls.filter(c => c[0] === 'fillRect')).toHaveLength(2)
  })
})

describe("the readout's size", () => {
  // jsdom lays nothing out, so the rule is read from App.css. An absolute box with no width of its own
  // is as wide as the room between its left and the chart's right edge: near that edge the readout
  // narrowed, wrapped and outgrew the chart before its transform moved it back.
  const css = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'App.css'), 'utf8')
  const rule = css.match(/^\.chart-alert-readout \{([^}]*)\}/m)?.[1] ?? ''

  it('is its own width wherever the pointer is, so it never narrows at the right edge', () => {
    expect(rule).toMatch(/^\s*width: max-content;$/m)
    expect(rule).toMatch(/^\s*max-width: 70%;$/m)
  })
})
