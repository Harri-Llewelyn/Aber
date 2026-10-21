import React from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FiltersPopover } from '../components/common/FiltersPopover'
import { blankComments } from '../test/themeColours'

/**
 * The four panels that open from a button point at it with an arrow, and share one shape. jsdom
 * lays nothing out, so the CSS half is asserted against the stylesheet: each panel has an arrow,
 * the arrow is drawn where the panel cannot clip it, and the numbers that place it agree with the
 * panel's own. The screenshots in both themes and every rail mode are the check that it lines up.
 */

const APP_CSS = blankComments(fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8'))

/** Every rule whose selector list includes `selector` exactly, as [selectors, body]. */
const rulesFor = (selector) => [...APP_CSS.matchAll(/(?<=^|[{}])\s*([^{}@]+)\{([^{}]*)\}/g)]
  .map(m => [m[1].split(',').map(s => s.trim()), m[2]])
  .filter(([selectors]) => selectors.includes(selector))
/** The value the last of those rules gives `prop`, as the cascade would for equal specificity. */
const declared = (selector, prop) => {
  let value
  for (const [, body] of rulesFor(selector)) {
    for (const decl of body.split(';')) {
      const i = decl.indexOf(':')
      if (i > 0 && decl.slice(0, i).trim() === prop) value = decl.slice(i + 1).trim()
    }
  }
  return value
}

const PANELS = [
  { panel: '.alert-pill-panel', arrow: '.alert-pill-wrap:has(> .alert-pill-panel)::after' },
  { panel: '.notif-panel', arrow: '.notif-wrap:has(> .notif-panel)::after' },
  { panel: '.user-popover', arrow: '.user-menu:has(> .user-popover)::after' },
  { panel: '.filters-popover', arrow: '.filters-popover::before' }
]

describe('the popover arrows', () => {
  it.each(PANELS)('$panel has an arrow, drawn by the one shared rule', ({ arrow }) => {
    const shared = rulesFor(arrow).find(([selectors]) => selectors.length === PANELS.length)
    expect(shared, `${arrow} is not in the shared arrow rule`).toBeTruthy()
    for (const { arrow: other } of PANELS) expect(shared[0]).toContain(other)
    expect(declared(arrow, 'content')).toBe("''")
    expect(declared(arrow, 'background')).toBe('var(--bg-card)')
    expect(declared(arrow, 'border-top')).toBe('1px solid var(--border)')
    expect(declared(arrow, 'pointer-events')).toBe('none')
  })

  it.each(PANELS)('$panel shares one radius and one shadow with the others', ({ panel }) => {
    expect(declared(panel, 'border-radius')).toBe('var(--radius-sm)')
    expect(declared(panel, 'box-shadow')).toBe('var(--shadow-popover)')
  })

  it('draws the arrow outside a panel that clips or scrolls its overflow', () => {
    expect(declared('.user-popover', 'overflow')).toBe('hidden')
    expect(declared('.notif-panel', 'overflow-y')).toBe('auto')
    expect(declared('.alert-pill-panel', 'overflow-y')).toBe('auto')
    // The Filters panel clips nothing itself; its list scrolls inside it.
    expect(declared('.filters-popover', 'overflow')).toBeUndefined()
    expect(declared('.filters-popover', 'overflow-y')).toBeUndefined()
  })

  it('points the top-bar arrows up, at the button, on the panel border and above the panel', () => {
    for (const { panel, arrow } of PANELS.slice(0, 2)) {
      expect(declared(panel, 'top')).toBe('calc(100% + 8px)')
      expect(declared(arrow, 'top')).toBe('calc(100% + 8.5px)')
      expect(declared(arrow, 'left')).toBe('50%')
      expect(Number(declared(arrow, 'z-index'))).toBeGreaterThan(Number(declared(panel, 'z-index')))
    }
  })

  it('points the account menu\'s arrow left, from the panel\'s left border, in both rail positions', () => {
    for (const { panel, arrow } of PANELS.slice(2, 3)) {
      expect(declared(panel, 'position')).toBe('fixed')
      expect(declared(arrow, 'position')).toBe('fixed')
      expect(declared(arrow, '--arrow-turn')).toBe('-45deg')
      expect(declared(arrow, 'left')).toBe(`${parseFloat(declared(panel, 'left')) + 0.5}px`)
      expect(Number(declared(arrow, 'z-index'))).toBeGreaterThan(Number(declared(panel, 'z-index')))
      expect(declared(`.sidebar-mode-expanded ${arrow}`, 'left'))
        .toBe(`${parseFloat(declared(`.sidebar-mode-expanded ${panel}`, 'left')) + 0.5}px`)
    }
    // Level with the account row: the foot's 10px, the 34px Collapse all tabs row, a 2px gap and half
    // of the 38px account row.
    expect(declared(PANELS[2].arrow, 'bottom')).toBe('65px')
    expect(declared('.sidebar-collapse-all', 'padding')).toBe('6px 9px')
  })

  it('places the Filters arrow from the --arrow-x its component sets', () => {
    expect(declared('.filters-popover::before', 'left')).toBe('calc(var(--arrow-x, 50%) - 1px)')
  })
})

describe('FiltersPopover points at its button', () => {
  afterEach(() => vi.restoreAllMocks())

  const openAt = (rect, innerWidth = 1440) => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(innerWidth)
    render(<FiltersPopover><select aria-label="Type"><option>Any</option></select></FiltersPopover>)
    const button = screen.getByRole('button', { name: 'Filters' })
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height })
    fireEvent.click(button)
    return screen.getByRole('dialog', { name: 'Filters' })
  }

  it('opens 8px under the button, with the arrow over its centre', () => {
    const panel = openAt({ left: 200, top: 100, width: 80, height: 28 })
    expect(panel.style.top).toBe('136px')
    expect(panel.style.left).toBe('200px')
    expect(panel.style.getPropertyValue('--arrow-x')).toBe('40px')
  })

  it('keeps the arrow over the button when the panel shifts to stay inside the window', () => {
    // The button is near the right edge: the panel moves left and the arrow moves right with it.
    const panel = openAt({ left: 1360, top: 100, width: 70, height: 28 })
    expect(panel.style.left).toBe(`${1440 - 320 - 8}px`)
    expect(panel.style.getPropertyValue('--arrow-x')).toBe(`${1360 + 35 - (1440 - 328)}px`)
  })

  it('keeps the arrow off the panel\'s rounded corner', () => {
    const panel = openAt({ left: 0, top: 100, width: 10, height: 28 })
    expect(panel.style.left).toBe('8px')
    expect(panel.style.getPropertyValue('--arrow-x')).toBe('16px')
  })
})
