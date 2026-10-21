/**
 * `<Tooltip text>`: the shared bubble on one control, as a wrapper, so a control whose browser
 * `title` became the dashboard's own tooltip is one short change. It shows as useTooltip shows it
 * (after the hover delay, at once on keyboard focus), keeps the control's own ref and handlers, and
 * never remounts the control when its text comes and goes.
 */
import React, { useRef, useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Tooltip, TOOLTIP_DELAY_MS } from '../components/common/Tooltip'

const tip = () => screen.queryByRole('tooltip')
const wait = (ms) => act(() => { vi.advanceTimersByTime(ms) })

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('Tooltip', () => {
  it('shows once the pointer rests on the control, and closes when it leaves', () => {
    render(<Tooltip text="Send the bundle to the gateway again"><button type="button">Resend</button></Tooltip>)
    const button = screen.getByRole('button', { name: 'Resend' })
    fireEvent.mouseEnter(button)
    wait(TOOLTIP_DELAY_MS - 1)
    expect(tip()).toBeNull()
    wait(1)
    expect(tip()).toHaveTextContent('Send the bundle to the gateway again')
    expect(tip()).toHaveClass('tooltip-bubble')

    fireEvent.mouseLeave(button)
    expect(tip()).toBeNull()
  })

  it('shows at once on keyboard focus, describes the control, and closes on blur', () => {
    render(<><button type="button">Before</button>
      <Tooltip text="Send the bundle to the gateway again"><button type="button">Resend</button></Tooltip></>)
    const button = screen.getByRole('button', { name: 'Resend' })
    expect(button).toHaveAccessibleDescription('Send the bundle to the gateway again')
    expect(button).not.toHaveAttribute('title')

    fireEvent.focus(button, { relatedTarget: screen.getByRole('button', { name: 'Before' }) })
    expect(tip()).toHaveTextContent('Send the bundle to the gateway again')
    expect(button).toHaveAttribute('aria-describedby', tip().id)
    fireEvent.blur(button)
    expect(tip()).toBeNull()
  })

  it('stays shut for a press and the press\'s focus', () => {
    const onClick = vi.fn()
    render(<Tooltip text="Copies the address"><button type="button" onClick={onClick}>Copy</button></Tooltip>)
    const button = screen.getByRole('button', { name: 'Copy' })
    fireEvent.mouseEnter(button)
    fireEvent.mouseDown(button)
    fireEvent.focus(button)
    fireEvent.click(button)
    wait(TOOLTIP_DELAY_MS * 10)
    expect(tip()).toBeNull()
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('keeps the control\'s own ref and handlers', () => {
    const seen = []
    function Harness() {
      const ref = useRef(null)
      return (
        <>
          <Tooltip text="What it does">
            <button ref={ref} type="button"
              onMouseEnter={() => seen.push('enter')} onFocus={() => seen.push('focus')}
              onBlur={() => seen.push('blur')} onClick={() => seen.push(`click ${ref.current?.tagName}`)}>Act</button>
          </Tooltip>
        </>
      )
    }
    render(<Harness />)
    const button = screen.getByRole('button', { name: 'Act' })
    fireEvent.mouseEnter(button)
    fireEvent.focus(button)
    fireEvent.blur(button)
    fireEvent.click(button)
    expect(seen).toEqual(['enter', 'focus', 'blur', 'click BUTTON'])
  })

  it('names an icon-only button by its aria-label, and does not read the same words again', () => {
    render(<Tooltip text="Copy link"><button type="button" aria-label="Copy link">⧉</button></Tooltip>)
    const button = screen.getByRole('button', { name: 'Copy link' })
    expect(button).not.toHaveAttribute('aria-describedby')
    fireEvent.mouseEnter(button)
    wait(TOOLTIP_DELAY_MS)
    expect(tip()).toHaveTextContent('Copy link')
  })

  it('adds its description to one the control already has', () => {
    render(<><span id="hint">Needs a semantic id.</span>
      <Tooltip text="Admins only"><button type="button" aria-describedby="hint">Save</button></Tooltip></>)
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAccessibleDescription('Needs a semantic id. Admins only')
  })

  it('draws nothing with no text, and keeps the control in place when text arrives', () => {
    function Harness() {
      const [text, setText] = useState(null)
      return (
        <Tooltip text={text}>
          <button type="button" onClick={() => setText('Enter a semantic id first')}>Use</button>
        </Tooltip>
      )
    }
    render(<Harness />)
    const before = screen.getByRole('button', { name: 'Use' })
    expect(before).not.toHaveAttribute('aria-describedby')
    expect(document.querySelector('.tooltip-bubble')).toBeNull()
    act(() => before.focus())

    fireEvent.click(before)
    const after = screen.getByRole('button', { name: 'Use' })
    expect(after, 'the control was remounted').toBe(before)
    expect(document.activeElement).toBe(before)
    expect(after).toHaveAccessibleDescription('Enter a semantic id first')
  })

  it('draws the bubble inside the open dialog the control sits in', () => {
    render(<dialog open aria-label="Edit"><Tooltip text="Saved for everyone"><button type="button">Save</button></Tooltip></dialog>)
    fireEvent.focus(screen.getByRole('button', { name: 'Save' }), { relatedTarget: null })
    expect(screen.getByRole('dialog')).toContainElement(tip())
  })
})
