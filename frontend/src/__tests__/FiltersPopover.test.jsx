import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FiltersPopover } from '../components/common/FiltersPopover'

function setup(activeCount = 0, onClear = vi.fn()) {
  render(
    <div>
      <button type="button">Outside</button>
      <FiltersPopover activeCount={activeCount} onClear={onClear}>
        <select aria-label="Type"><option>Any</option></select>
      </FiltersPopover>
    </div>,
  )
  return { onClear, button: screen.getByRole('button', { name: /^Filters/ }) }
}

describe('FiltersPopover', () => {
  it('reads Filters, or Filters (n) while n are set', () => {
    setup(0)
    expect(screen.getByRole('button', { name: 'Filters' })).toBeTruthy()
  })

  it('shows the count in the label', () => {
    setup(2)
    expect(screen.getByRole('button', { name: 'Filters (2)' })).toBeTruthy()
  })

  it('opens a labelled dialog the button controls', () => {
    const { button } = setup()
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(button)
    const dialog = screen.getByRole('dialog', { name: 'Filters' })
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(button.getAttribute('aria-controls')).toBe(dialog.id)
    expect(screen.getByLabelText('Type')).toBeTruthy()
    fireEvent.click(button)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes on Escape and returns focus to the button', () => {
    const { button } = setup()
    fireEvent.click(button)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(button)
  })

  it('closes on an outside click, returns focus, and stays open for a click inside', () => {
    const { button } = setup()
    fireEvent.click(button)
    fireEvent.mouseDown(screen.getByLabelText('Type'))
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Outside' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(button)
  })

  it('has its own Clear, disabled at 0', () => {
    const { button } = setup(0)
    fireEvent.click(button)
    expect(screen.getByRole('button', { name: 'Clear' }).disabled).toBe(true)
  })

  it('calls onClear from Clear when filters are set', () => {
    const { button, onClear } = setup(2)
    fireEvent.click(button)
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(onClear).toHaveBeenCalledTimes(1)
  })
})
