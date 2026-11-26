/**
 * OverflowText's control: a tap never slides the line, a dialog that takes the focus by script is not
 * the control of every line in it, and `host` names a control the line sits beside. jsdom lays
 * nothing out, so each line is given the widths a browser would measure.
 */
import React, { useRef } from 'react'
import { render, screen, fireEvent, createEvent } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { OverflowText } from '../components/common/OverflowText'

const cut = (el) => {
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: 300 })
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: 120 })
  return el
}
const lines = () => [...document.querySelectorAll('.overflow-text')].map(cut)
const sliding = (el) => el.style.getPropertyValue('--overflow-shift') === '-180px'

/** A pointer event of one kind; jsdom's init dictionary may not carry `pointerType`. */
const pointer = (name, el, pointerType) => {
  const event = createEvent[name](el)
  Object.defineProperty(event, 'pointerType', { value: pointerType })
  fireEvent(el, event)
}

afterEach(() => vi.restoreAllMocks())

describe('OverflowText and a touch', () => {
  it('does not slide for the mouse events a tap raises, and slides for a mouse after it', () => {
    render(<button type="button"><OverflowText>A name far too long for its column</OverflowText></button>)
    const [line] = lines()
    const button = screen.getByRole('button')

    pointer('pointerEnter', button, 'touch')
    pointer('pointerDown', button, 'touch')
    fireEvent.mouseEnter(button)
    expect(sliding(line)).toBe(false)
    fireEvent.click(button)
    fireEvent.mouseLeave(button)

    pointer('pointerEnter', button, 'mouse')
    fireEvent.mouseEnter(button)
    expect(sliding(line)).toBe(true)
  })

  it('does not slide for the focus a tap gives, and does for a keyboard’s once the tap is over', () => {
    render(<button type="button"><OverflowText>A name far too long for its column</OverflowText></button>)
    const [line] = lines()
    const button = screen.getByRole('button')
    vi.spyOn(button, 'matches').mockImplementation((selector) => selector === ':focus-visible')

    pointer('pointerDown', button, 'touch')
    fireEvent.focusIn(button)
    expect(sliding(line)).toBe(false)
    fireEvent.click(button)
    fireEvent.focusOut(button)

    fireEvent.focusIn(button)
    expect(sliding(line)).toBe(true)
  })
})

describe('OverflowText’s control', () => {
  it('is never a dialog that takes the focus by script: a line with no control of its own reacts to the pointer on itself', () => {
    render(
      <div role="dialog" tabIndex={-1} data-testid="dialog">
        <p><OverflowText>The first name, too long for its row</OverflowText></p>
        <p><OverflowText>The second name, too long for its row</OverflowText></p>
      </div>
    )
    const [first, second] = lines()
    fireEvent.mouseEnter(screen.getByTestId('dialog'))
    expect([first, second].map(sliding)).toEqual([false, false])
    fireEvent.mouseEnter(second)
    expect([first, second].map(sliding)).toEqual([false, true])
  })

  it('is still a row a keyboard reaches (tabindex 0)', () => {
    render(<table><tbody><tr tabIndex={0} data-testid="row"><td><OverflowText>A note far too long for its column</OverflowText></td></tr></tbody></table>)
    const [line] = lines()
    fireEvent.mouseEnter(screen.getByTestId('row'))
    expect(sliding(line)).toBe(true)
  })

  function Beside({ focusFirst = false }) {
    const box = useRef(null)
    return (
      <div ref={box} data-testid="box">
        <input aria-label="Search" autoFocus={focusFirst} />
        <span><OverflowText host={box}>Search subject, proposer or reason…</OverflowText></span>
      </div>
    )
  }

  it('is `host` where the line sits beside its control: the pointer on it, and the focus in it', () => {
    render(<Beside />)
    const [line] = lines()
    const field = screen.getByRole('textbox')
    vi.spyOn(field, 'matches').mockImplementation((selector) => selector === ':focus-visible')

    fireEvent.mouseEnter(screen.getByTestId('box'))
    expect(sliding(line)).toBe(true)
    fireEvent.mouseLeave(screen.getByTestId('box'))
    expect(sliding(line)).toBe(false)

    fireEvent.focusIn(field)
    expect(sliding(line)).toBe(true)
    fireEvent.focusOut(field)
    expect(sliding(line)).toBe(false)
  })

  it('slides at once when it is drawn while its control has keyboard focus', () => {
    // Measured as it mounts, so the widths are given to every line before any is drawn.
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function () { return this.classList.contains('overflow-text') ? 300 : 0 })
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function () { return this.classList.contains('overflow-text') ? 120 : 0 })
    vi.spyOn(HTMLElement.prototype, 'matches').mockImplementation(function (selector) { return selector === ':focus-visible' ? this === document.activeElement : Element.prototype.matches.call(this, selector) })
    render(<Beside focusFirst />)
    expect(screen.getByRole('textbox')).toHaveFocus()
    expect(document.querySelector('.overflow-text').style.getPropertyValue('--overflow-shift')).toBe('-180px')
  })
})
