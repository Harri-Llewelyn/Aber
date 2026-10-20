import fs from 'node:fs'
import path from 'node:path'
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { TabStrip } from '../components/common/TabStrip'
import { HelpTip } from '../components/common/HelpTip'
import { TOOLTIP_DELAY_MS } from '../components/common/Tooltip'
import { useEscapeKey } from '../hooks/useEscapeKey'

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
