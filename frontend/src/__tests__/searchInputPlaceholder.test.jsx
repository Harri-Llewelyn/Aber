/**
 * SearchInput draws its placeholder itself, through OverflowText, so one too long for the box is cut
 * with an ellipsis and slides on hover over the box, or on the field's focus, while the box is empty.
 * The field keeps its native placeholder for a screen reader. jsdom lays nothing out, so the line is
 * given the widths a browser would measure.
 */
import React, { useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { SearchInput } from '../components/common/SearchInput'

const APP_CSS = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8')
const PLACEHOLDER = 'Search subject, proposer or reason…'

function Box({ start = '' }) {
  const [value, setValue] = useState(start)
  return <SearchInput value={value} onChange={setValue} placeholder={PLACEHOLDER} ariaLabel="Search decided approvals" />
}

const drawn = () => document.querySelector('.search-input-placeholder')
const line = () => {
  const el = drawn().querySelector('.overflow-text')
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: 260 })
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: 220 })
  return el
}
const shift = (el) => el.style.getPropertyValue('--overflow-shift')

afterEach(() => vi.restoreAllMocks())

describe('SearchInput’s placeholder', () => {
  it('is drawn over the empty field, hidden from a screen reader, which reads the field’s own', () => {
    render(<Box />)
    expect(drawn()).toHaveTextContent(PLACEHOLDER)
    expect(drawn()).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByPlaceholderText(PLACEHOLDER)).toBe(screen.getByRole('searchbox', { name: 'Search decided approvals' }))
  })

  it('goes once something is typed, and comes back when the box is emptied', () => {
    render(<Box />)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'press' } })
    expect(drawn()).toBeNull()
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' })
    expect(drawn()).toHaveTextContent(PLACEHOLDER)
  })

  it('is not drawn while the box holds a search', () => {
    render(<Box start="press" />)
    expect(drawn()).toBeNull()
  })

  it('slides, cut, while the pointer is anywhere on the box, and on the field’s keyboard focus', () => {
    render(<Box />)
    const el = line()
    const field = screen.getByRole('searchbox')
    vi.spyOn(field, 'matches').mockImplementation((selector) => selector === ':focus-visible')

    fireEvent.mouseEnter(document.querySelector('.search-input'))
    expect(shift(el)).toBe('-40px')
    fireEvent.mouseLeave(document.querySelector('.search-input'))
    expect(shift(el)).toBe('0px')

    fireEvent.focusIn(field)
    expect(shift(el)).toBe('-40px')
  })

  it('makes the native placeholder transparent, and sets its own inside the field’s padding', () => {
    expect(APP_CSS).toMatch(/\n\.search-input \.search-input-field::placeholder \{ color: transparent; \}/)
    const rule = APP_CSS.match(/\n\.search-input-placeholder \{([^}]*)\}/)?.[1]
    expect(rule).toMatch(/position:\s*absolute/)
    expect(rule).toMatch(/pointer-events:\s*none/)
    expect(rule).toMatch(/color:\s*var\(--text-muted\)/)
    // The field's padding, 30px and 28px, inside its 1px border.
    expect(APP_CSS).toMatch(/\n\.search-input \.search-input-field \{ padding-left: 30px; padding-right: 28px; \}/)
    expect(rule).toMatch(/left:\s*31px/)
    expect(rule).toMatch(/right:\s*29px/)
  })
})
