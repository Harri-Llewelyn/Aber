import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { declaration } from '../test/themeColours'

/**
 * An area card on the Site Map draws its plan on the card itself: no second frame, a margin round
 * the drawing sized to the pin the grid draws, and the cards in a row sharing its height. jsdom
 * lays nothing out, so the geometry is read from App.css and worked out here.
 */

const SRC = path.resolve(__dirname, '..')
const APP_CSS = fs.readFileSync(path.join(SRC, 'App.css'), 'utf8')
const SITE_MAP = fs.readFileSync(path.join(SRC, 'components/tabs/SiteMapTab.jsx'), 'utf8')

const prop = (selector, name) => {
  const value = declaration(APP_CSS, selector, name)
  if (value === null) throw new Error(`no ${name} for ${selector} in App.css`)
  return value
}

/** The pin sizes the Site Map's grid hands its cards, one per column count. */
const PIN_SIZES = [...SITE_MAP.match(/const PIN_SIZE = \{([^}]*)\}/)[1].matchAll(/\d+:\s*(\d+)/g)].map(m => Number(m[1]))

/** An inset written as half the pin plus a constant, as a function of the pin size. */
const halfPinPlus = (value) => {
  const m = value.match(/^calc\(var\(--pin-size, 40px\) \/ 2 \+ ([\d.]+)px\)$/)
  expect(m, `${value} is not half the pin plus a constant`).toBeTruthy()
  return (size) => size / 2 + Number(m[1])
}

/** The four sides of a `padding` shorthand, in px. */
const sides = (value) => {
  const [top, right = top, bottom = top, left = right] = value.split(/\s+/).map(parseFloat)
  return { top, right, bottom, left }
}

describe('An area card on the Site Map', () => {
  it('finds the three pin sizes', () => {
    expect(PIN_SIZES).toEqual([40, 36, 28])
  })

  it('draws the plan straight on the card, with no frame of its own', () => {
    expect(prop('.area-card .area-plan', 'background')).toBe('none')
    expect(prop('.area-card .area-plan', 'border')).toBe('0')
    expect(prop('.area-card .area-plan', 'border-radius')).toBe('0')
    // The drawer previews and the placement picker keep the frame.
    expect(prop('.area-plan', 'background')).toBe('var(--bg-glass)')
    expect(prop('.area-plan', 'border')).toBe('1px solid var(--border)')
  })

  it('keeps a margin round the drawing sized to the pin it draws, at every column count', () => {
    expect(prop('.area-plan-pin-disc', 'width')).toBe('var(--pin-size, 40px)')
    const gap = parseFloat(prop('.area-plan-pin', 'gap'))
    const labelHeight = parseFloat(prop('.area-plan-pin-label', 'font-size')) * Number(prop('.area-plan-pin-label', 'line-height'))
      + 2 * sides(prop('.area-plan-pin-label', 'padding')).top + 2 * parseFloat(prop('.area-plan-pin-label', 'border'))
    // The widest ring a pin draws past its disc: the selection ring, the focus outline (its width
    // plus its offset) or the alert ring at rest (its negative inset).
    const ring = Math.max(
      Number(prop('.area-plan-pin-selected .area-plan-pin-disc', 'box-shadow').match(/^0 0 0 (\d+)px/)[1]),
      parseFloat(prop('.area-plan-pin:focus-visible .area-plan-pin-disc', 'outline'))
        + parseFloat(prop('.area-plan-pin:focus-visible .area-plan-pin-disc', 'outline-offset')),
      -parseFloat(prop('.area-plan-pin-alert .area-plan-pin-disc::after', 'inset'))
    )
    expect(ring).toBe(4)
    const insetX = halfPinPlus(prop('.area-card .area-plan', '--plan-inset-x'))
    const insetY = halfPinPlus(prop('.area-card .area-plan', '--plan-inset-y'))
    for (const disc of PIN_SIZES) {
      // Across: half the disc and the ring. Up and down: half the whole pin, which is centred on its
      // place, and the ring. Enough, and within a pixel of it, so the margin is the pin's, not more.
      const across = disc / 2 + ring
      const down = (disc + gap + labelHeight) / 2 + ring
      expect(insetX(disc), `${disc}px pin across`).toBeGreaterThanOrEqual(across)
      expect(insetX(disc), `${disc}px pin across`).toBeLessThan(across + 1)
      expect(insetY(disc), `${disc}px pin down`).toBeGreaterThanOrEqual(down)
      expect(insetY(disc), `${disc}px pin down`).toBeLessThan(down + 1)
    }
    // At three columns: 18px across and 29px down.
    expect([insetX(28), insetY(28)]).toEqual([18, 29])
  })

  it('adds no padding of the card\'s own at the sides or the bottom of the plan', () => {
    const card = sides(prop('.area-card', 'padding'))
    expect(card).toEqual({ top: 10, right: 0, bottom: 0, left: 0 })
    // The header and the line under the plan pad their own sides, as the card did.
    const header = sides(prop('.area-card-header', 'padding'))
    const aside = sides(prop('.area-card-aside', 'padding'))
    expect([header.left, header.right, header.top, header.bottom]).toEqual([10, 10, 0, 0])
    expect([aside.left, aside.right, aside.top, aside.bottom]).toEqual([10, 10, 0, 10])
  })

  it('stretches the cards in a row to one height, and centres a shorter plan between the header and the line under it', () => {
    expect(declaration(APP_CSS, '.shopfloor-grid', 'align-items') ?? 'stretch').toBe('stretch')
    expect(prop('.area-card', 'display')).toBe('flex')
    expect(prop('.area-card', 'flex-direction')).toBe('column')
    expect(prop('.area-card .area-plan', 'margin')).toBe('auto')
  })

  it('keeps the plan\'s height caps', () => {
    expect(prop('.area-card', '--plan-max-height')).toBe('260px')
    expect(prop('.shopfloor-grid[style*="--map-columns: 2"] .area-card', '--plan-max-height')).toBe('340px')
    expect(prop('.shopfloor-grid[style*="--map-columns: 1"] .area-card', '--plan-max-height')).toBe('440px')
  })
})
