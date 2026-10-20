import fs from 'node:fs'
import path from 'node:path'
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { TabStrip } from '../components/common/TabStrip'
import { HelpTip } from '../components/common/HelpTip'
import { ARROW_INSET, TOOLTIP_DELAY_MS } from '../components/common/Tooltip'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { blankComments } from '../test/themeColours'

const APP_CSS = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8')

const TABS = [
  { id: 'registered', label: 'Registered', description: 'Devices admitted to Aber.' },
  { id: 'quarantine', label: 'Quarantine', description: 'Births from devices nobody has registered.', attention: 2 },
]

function Harness() {
  const [value, setValue] = useState('registered')
  return <TabStrip tabs={TABS} value={value} onChange={setValue} ariaLabel="Devices" />
}

const tab = (name) => screen.getByRole('tab', { name })
const tip = () => screen.queryByRole('tooltip')
const wait = (ms) => act(() => { vi.advanceTimersByTime(ms) })

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('a tab\'s tooltip', () => {
  it('shows once the pointer rests on the tab, and closes when it leaves', () => {
    render(<Harness />)
    fireEvent.mouseEnter(tab('Registered'))
    wait(TOOLTIP_DELAY_MS - 1)
    expect(tip(), 'shown before the pointer had rested').toBeNull()
    wait(1)
    expect(tip()).toHaveTextContent('Devices admitted to Aber.')

    fireEvent.mouseLeave(tab('Registered'))
    expect(tip()).toBeNull()
  })

  it('never shows for a pointer crossing the bar', () => {
    render(<Harness />)
    fireEvent.mouseEnter(tab('Registered'))
    wait(TOOLTIP_DELAY_MS / 2)
    fireEvent.mouseLeave(tab('Registered'))
    fireEvent.mouseEnter(tab('Quarantine, 2 waiting'))
    wait(TOOLTIP_DELAY_MS / 2)
    fireEvent.mouseLeave(tab('Quarantine, 2 waiting'))
    wait(TOOLTIP_DELAY_MS * 10)
    expect(tip()).toBeNull()
  })

  it('shows at once on keyboard focus, named by the tab\'s aria-describedby, and closes on blur', () => {
    render(<><button type="button">Before</button><Harness /></>)
    fireEvent.focus(tab('Registered'), { relatedTarget: screen.getByRole('button', { name: 'Before' }) })
    expect(tip()).toHaveTextContent('Devices admitted to Aber.')
    expect(tab('Registered')).toHaveAttribute('aria-describedby', tip().id)
    // Portalled out of the card, whose overflow is hidden.
    expect(tip().parentElement).toBe(document.body)

    fireEvent.blur(tab('Registered'))
    expect(tip()).toBeNull()
  })

  it('keeps the waiting count in the name and adds the sentence as the description', () => {
    render(<Harness />)
    const quarantine = tab('Quarantine, 2 waiting')
    expect(quarantine).toHaveAccessibleDescription('Births from devices nobody has registered.')
    // The description is there before the tooltip is: a screen reader reads it with the name.
    expect(tip()).toBeNull()
    expect(document.getElementById(quarantine.getAttribute('aria-describedby'))).toHaveAttribute('hidden')
  })

  it('follows the arrow keys, which move focus and selection exactly as before', () => {
    render(<Harness />)
    act(() => tab('Registered').focus())
    expect(tip()).toHaveTextContent('Devices admitted to Aber.')
    fireEvent.keyDown(tab('Registered'), { key: 'ArrowRight' })
    expect(tab('Quarantine, 2 waiting')).toHaveAttribute('aria-selected', 'true')
    expect(document.activeElement).toBe(tab('Quarantine, 2 waiting'))
    expect(screen.getAllByRole('tooltip')).toHaveLength(1)
    expect(tip()).toHaveTextContent('Births from devices nobody has registered.')
  })

  it('closes on Escape before anything behind it does', () => {
    const behind = vi.fn()
    function Drawer() { useEscapeKey(behind, true); return null }
    render(<><Drawer /><Harness /></>)
    fireEvent.mouseEnter(tab('Registered'))
    wait(TOOLTIP_DELAY_MS)
    expect(tip()).not.toBeNull()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(tip()).toBeNull()
    expect(behind, 'Escape went past the tooltip to the drawer').not.toHaveBeenCalled()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(behind).toHaveBeenCalledTimes(1)
  })

  it('closes on a scroll, rather than drifting from the tab', () => {
    render(<Harness />)
    fireEvent.mouseEnter(tab('Registered'))
    wait(TOOLTIP_DELAY_MS)
    fireEvent.scroll(window)
    expect(tip()).toBeNull()
  })

  /** A click chooses the tab; the explanation was for choosing, and the click's focus is not a Tab. */
  it('stays shut for a click, and for the click\'s focus', () => {
    render(<Harness />)
    fireEvent.mouseEnter(tab('Quarantine, 2 waiting'))
    wait(TOOLTIP_DELAY_MS / 2)
    fireEvent.mouseDown(tab('Quarantine, 2 waiting'))
    fireEvent.focus(tab('Quarantine, 2 waiting'))
    fireEvent.click(tab('Quarantine, 2 waiting'))
    expect(tab('Quarantine, 2 waiting')).toHaveAttribute('aria-selected', 'true')
    wait(TOOLTIP_DELAY_MS * 10)
    expect(tip()).toBeNull()
  })

  it('stays shut when the window comes back to a tab that was clicked', () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    render(<Harness />)
    fireEvent.mouseDown(tab('Registered'))
    fireEvent.focus(tab('Registered'))
    fireEvent.click(tab('Registered'))
    fireEvent.mouseLeave(tab('Registered'))

    hasFocus.mockReturnValue(false)
    fireEvent.blur(tab('Registered'), { relatedTarget: null })
    hasFocus.mockReturnValue(true)
    fireEvent.focus(tab('Registered'), { relatedTarget: null })
    expect(tip(), 'the window coming back showed a tooltip').toBeNull()
  })
})

describe('one bubble for HelpTip and the tabs', () => {
  it('draws both in the same element and class', () => {
    render(<><Harness /><HelpTip label="About this" text="An explanation." /></>)
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'About this' }))
    const helpBubble = tip()
    expect(helpBubble).toHaveClass('tooltip-bubble')
    fireEvent.mouseLeave(screen.getByRole('button', { name: 'About this' }))

    fireEvent.mouseEnter(tab('Registered'))
    wait(TOOLTIP_DELAY_MS)
    expect(tip()).toHaveClass('tooltip-bubble')
    expect(tip().tagName).toBe(helpBubble.tagName)
  })

  it('styles the bubble once, beside the help tip, with no display rule to defeat `hidden`', () => {
    const rule = APP_CSS.match(/\n\.tooltip-bubble \{([\s\S]*?)\n\}/)[1]
    expect(rule).toMatch(/position:\s*fixed/)
    expect(rule).not.toMatch(/display:/)
    expect(APP_CSS).not.toMatch(/\.help-tip-bubble/)
    expect(APP_CSS.indexOf('.tooltip-bubble {')).toBeGreaterThan(APP_CSS.indexOf('.help-tip {'))
  })

})

/**
 * The bubble points at its control with an arrow on the border facing it. jsdom lays nothing out,
 * so the trigger's rectangle and the window are given, and the numbers the bubble is drawn with
 * are checked; the stylesheet half is checked against App.css, and the screenshots in both themes
 * are the check that it lines up.
 */
describe('the bubble points at its control', () => {
  const rect = ({ left, top, width, height = 28 }) =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top })
  const window_ = (width, height = 900) => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(width)
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(height)
  }
  /** A help tip at `at`, hovered; its bubble. */
  const helpTipAt = (at, size = [1440, 900]) => {
    window_(...size)
    render(<HelpTip label="About this" text="An explanation." />)
    const trigger = screen.getByRole('button', { name: 'About this' })
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rect(at))
    fireEvent.mouseEnter(trigger)
    return tip()
  }
  const arrowX = (bubble) => bubble.style.getPropertyValue('--arrow-x')
  /** What the rule that starts a line with `selector {` gives `prop`. */
  const declared = (selector, prop) => {
    const css = blankComments(APP_CSS)
    const start = css.indexOf(`\n${selector} {`)
    if (start < 0) return undefined
    const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start))
    const decl = body.split(';').map(d => d.trim()).find(d => d.startsWith(`${prop}:`))
    return decl?.slice(prop.length + 1).trim()
  }

  it('opens below the control with the arrow over its centre', () => {
    const bubble = helpTipAt({ left: 200, top: 100, width: 120 })
    expect(bubble.style.top).toBe('136px')
    expect(bubble.style.left).toBe('200px')
    expect(arrowX(bubble)).toBe('60px')
    expect(bubble).not.toHaveClass('tooltip-bubble-above')
    expect(bubble).not.toHaveClass('tooltip-bubble-end')
  })

  it('starts left of a control narrower than the arrow\'s inset, so the point is still on its centre', () => {
    // An 18px help tip: the bubble starts ARROW_INSET left of its centre.
    const bubble = helpTipAt({ left: 300, top: 100, width: 18, height: 18 })
    expect(bubble.style.left).toBe(`${309 - ARROW_INSET}px`)
    expect(arrowX(bubble)).toBe(`${ARROW_INSET}px`)
  })

  it('hangs the point from the bottom border when it opens above a low control', () => {
    const bubble = helpTipAt({ left: 200, top: 820, width: 120 })
    expect(bubble).toHaveClass('tooltip-bubble-above')
    expect(bubble.style.bottom).toBe(`${900 - 820 + 8}px`)
    expect(bubble.style.top).toBe('')
    expect(arrowX(bubble)).toBe('60px')
  })

  it('ends at a control near the window\'s right side, measuring the arrow from that edge', () => {
    // The widest bubble would pass the window's side, so a short one is placed by its right edge
    // and still reaches the control.
    const bubble = helpTipAt({ left: 1380, top: 100, width: 40 })
    expect(bubble).toHaveClass('tooltip-bubble-end')
    expect(bubble.style.right).toBe(`${1440 - 1420}px`)
    expect(bubble.style.left).toBe('')
    expect(arrowX(bubble)).toBe('20px')
  })

  it('keeps the arrow inside the bubble when the bubble is held at a window edge', () => {
    const atLeft = helpTipAt({ left: 0, top: 100, width: 10 })
    expect(atLeft.style.left).toBe('8px')
    expect(arrowX(atLeft), 'past the rounded corner on the left').toBe(`${ARROW_INSET}px`)
    cleanup(); vi.restoreAllMocks()

    const atRight = helpTipAt({ left: 1425, top: 100, width: 15 })
    expect(atRight.style.right).toBe('8px')
    expect(arrowX(atRight), 'past the rounded corner on the right').toBe(`${ARROW_INSET}px`)
    cleanup(); vi.restoreAllMocks()

    // A window too narrow for the widest bubble either side of the control: the bubble narrows to
    // fit the window, and the arrow is still over the control.
    const narrow = helpTipAt({ left: 150, top: 100, width: 20 }, [320, 900])
    expect(narrow.style.left).toBe('8px')
    expect(narrow.style.maxWidth).toBe(`${320 - 16}px`)
    expect(arrowX(narrow)).toBe(`${160 - 8}px`)
  })

  it('points a tab\'s tooltip at the tab, shown on focus as on hover', () => {
    window_(1440)
    render(<><button type="button">Before</button><Harness /></>)
    vi.spyOn(tab('Quarantine, 2 waiting'), 'getBoundingClientRect')
      .mockReturnValue(rect({ left: 140, top: 60, width: 150, height: 36 }))
    fireEvent.focus(tab('Quarantine, 2 waiting'), { relatedTarget: screen.getByRole('button', { name: 'Before' }) })
    expect(tip().style.left).toBe('140px')
    expect(arrowX(tip())).toBe('75px')
  })

  it('draws the arrow in the bubble\'s own colours, turned down on the -above variant', () => {
    expect(declared('.tooltip-bubble::before', 'content')).toBe("''")
    expect(declared('.tooltip-bubble::before', 'background')).toBe('var(--bg-card)')
    expect(declared('.tooltip-bubble', 'background'), 'the half inside hides the border').toBe('var(--bg-card)')
    expect(declared('.tooltip-bubble::before', 'border-top')).toBe('1px solid var(--border)')
    expect(declared('.tooltip-bubble::before', 'transform')).toBe('rotate(var(--arrow-turn, 45deg))')
    expect(declared('.tooltip-bubble-above::before', '--arrow-turn')).toBe('225deg')
    expect(declared('.tooltip-bubble-above::before', 'bottom')).toBe('-0.5px')
  })

  it('keeps the arrow ARROW_INSET inside a bubble narrower than the widest, in the stylesheet', () => {
    // The script places the arrow for the widest bubble; a short text draws a narrower one, which
    // only the browser can measure. 100% is the bubble inside its 1px border.
    const clamp = `min(calc(var(--arrow-x) - 1px), calc(100% - ${ARROW_INSET - 1}px))`
    expect(declared('.tooltip-bubble::before', 'left')).toBe(clamp)
    expect(declared('.tooltip-bubble-end::before', 'right')).toBe(clamp)
    expect(declared('.tooltip-bubble-end::before', 'left')).toBe('auto')
  })
})

/**
 * An open dialog is drawn in the top layer and the page outside it is inert, so a bubble portalled
 * to <body> would sit beneath the backdrop. Inside a dialog, the bubble goes into the dialog.
 * (Adapted from the dialogs' own test: here a plain `<dialog open>` stands in for Modal.)
 */
describe('a tooltip inside a dialog', () => {
  it('draws a help tip\'s bubble inside the open dialog', () => {
    render(<dialog open aria-label="Digital Nameplate"><HelpTip text="The year it was built." /></dialog>)
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'More information' }))
    expect(screen.getByRole('dialog')).toContainElement(tip())
    expect(tip().parentElement.tagName).toBe('DIALOG')
  })

  it('still draws it in <body> on a page with no dialog', () => {
    render(<HelpTip text="The year it was built." />)
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'More information' }))
    expect(tip().parentElement).toBe(document.body)
  })

  /* A confirmation opens over a form: the first open dialog in the document is the one beneath. */
  it('draws it in the dialog its trigger sits in, not the first open one', () => {
    render(<>
      <dialog open aria-label="Edit Metric"><p>The form beneath.</p></dialog>
      <dialog open aria-label="Confirm"><HelpTip text="What confirming does." /></dialog>
    </>)
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'More information' }))
    expect(screen.getByRole('dialog', { name: 'Confirm' })).toContainElement(tip())
    expect(screen.getByRole('dialog', { name: 'Edit Metric' })).not.toContainElement(tip())
  })

  it('draws a tab\'s tooltip inside the dialog too', () => {
    render(<dialog open aria-label="Pick"><Harness /></dialog>)
    fireEvent.mouseEnter(tab('Registered'))
    wait(TOOLTIP_DELAY_MS)
    expect(screen.getByRole('dialog')).toContainElement(tip())
  })
})
