import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { OverflowText } from '../components/common/OverflowText'

/**
 * Cut text in a label, as a row of a list is: it slides with the pointer on its own row or keyboard
 * focus on the row's checkbox, and with neither on another row. jsdom lays nothing out, so the lines
 * are given the widths a browser would measure.
 */

/** A dialog is focusable, so it would be the control of every line in it but for the labels. */
const rows = () => render(
  <div role="dialog" tabIndex={-1}>
    <label><input type="checkbox" aria-label="First" /><OverflowText>The first name, too long for its row</OverflowText></label>
    <label><input type="checkbox" aria-label="Second" /><OverflowText>The second name, too long for its row</OverflowText></label>
  </div>
)
const lines = () => [...document.querySelectorAll('.overflow-text')].map(el => {
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: 300 })
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: 120 })
  return el
})
const sliding = (el) => el.style.getPropertyValue('--overflow-shift') === '-180px'

afterEach(() => vi.restoreAllMocks())

describe('OverflowText in a label', () => {
  it('slides while the pointer is anywhere on its own row, and no other row’s does', () => {
    rows()
    const [first, second] = lines()
    fireEvent.mouseEnter(screen.getByRole('dialog'))
    expect([first, second].map(sliding)).toEqual([false, false])
    fireEvent.mouseEnter(second.closest('label'))
    expect([first, second].map(sliding)).toEqual([false, true])
    fireEvent.mouseLeave(second.closest('label'))
    expect([first, second].map(sliding)).toEqual([false, false])
  })

  it('slides while its checkbox has keyboard focus, and not for the focus a click gives it', () => {
    rows()
    const [first, second] = lines()
    const checkbox = screen.getByRole('checkbox', { name: 'First' })
    const matches = vi.spyOn(checkbox, 'matches')

    matches.mockImplementation((selector) => selector === ':focus-visible')
    fireEvent.focusIn(checkbox)
    expect([first, second].map(sliding)).toEqual([true, false])
    fireEvent.focusOut(checkbox)
    expect([first, second].map(sliding)).toEqual([false, false])

    matches.mockImplementation(() => false)
    fireEvent.focusIn(checkbox)
    expect([first, second].map(sliding)).toEqual([false, false])
  })
})
