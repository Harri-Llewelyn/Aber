import React, { useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Tooltip, TOOLTIP_DELAY_MS } from '../components/common/Tooltip'
import { FieldError, fieldErrorProps } from '../components/common/FieldError'
import { escapeStackDepth } from '../hooks/useEscapeKey'
import { useFormCheck } from '../hooks/useFormCheck'

/**
 * A press that finds a field wrong moves the focus to it. The field's tooltip opens just below it, where
 * what is wrong is said, so a field that is wrong shows its tooltip to the pointer alone.
 */

const tip = () => screen.queryByRole('tooltip')

function Form() {
  const [name, setName] = useState('')
  const check = useFormCheck({ name: { id: 'name', missing: !name.trim() && 'Give it a name' } })
  return (
    <>
      <label htmlFor="name">Name</label>
      <Tooltip text="What the value is called.">
        <input id="name" value={name} onChange={e => setName(e.target.value)} {...fieldErrorProps(check.errors.name, 'name-error')} />
      </Tooltip>
      <FieldError id="name-error" error={check.errors.name} />
      <button type="button" onClick={() => check.press(() => {})}>Add</button>
    </>
  )
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("a field's tooltip", () => {
  it('opens on keyboard focus while nothing is wrong', () => {
    render(<Form />)
    act(() => screen.getByLabelText('Name').focus())
    expect(tip()).toHaveTextContent('What the value is called.')
  })

  it('stays shut when a press moves the focus to the field, and does not open as the field is filled', () => {
    const depth = escapeStackDepth()
    render(<Form />)
    const field = screen.getByLabelText('Name')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(field).toHaveFocus()
    expect(screen.getByRole('alert')).toHaveTextContent('Give it a name')
    expect(tip()).toBeNull()
    expect(escapeStackDepth()).toBe(depth)
    fireEvent.change(field, { target: { value: 'a' } })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(tip()).toBeNull()
  })

  it('stays shut when the focus comes back to a field that is still wrong, and opens for the pointer', () => {
    render(<Form />)
    const field = screen.getByLabelText('Name')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    act(() => screen.getByRole('button', { name: 'Add' }).focus())
    act(() => field.focus())
    expect(tip()).toBeNull()
    fireEvent.mouseEnter(field)
    act(() => { vi.advanceTimersByTime(TOOLTIP_DELAY_MS) })
    expect(tip()).toHaveTextContent('What the value is called.')
  })
})
