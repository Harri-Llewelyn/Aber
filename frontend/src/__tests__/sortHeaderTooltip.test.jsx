/**
 * A column's hint is said once, on its header, in the shared tooltip: on a sortable header's
 * button (SortHeader), or on a plain header's label, which takes focus (ColumnHeader). Never the
 * browser's `title`, and never repeated on every row.
 */
import React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ColumnHeader, SortHeader } from '../components/common/SortHeader'
import { TOOLTIP_DELAY_MS } from '../components/common/Tooltip'

const tip = () => screen.queryByRole('tooltip')
const sort = { column: null, descending: false, toggle: vi.fn() }

function Table() {
  return (
    <table>
      <thead>
        <tr>
          <SortHeader sort={sort} column="name" title="The name people see">Name</SortHeader>
          <SortHeader sort={sort} column="count">Count</SortHeader>
          <ColumnHeader title="What the device last reported">Value</ColumnHeader>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody><tr><td>Pump 2</td><td>3</td><td>41.2</td><td /></tr></tbody>
    </table>
  )
}

beforeEach(() => { vi.useFakeTimers(); sort.toggle.mockClear() })
afterEach(() => vi.useRealTimers())

describe('a sortable header\'s tooltip', () => {
  it('describes the header\'s button, with no title anywhere in the table', () => {
    render(<Table />)
    expect(screen.getByRole('button', { name: 'Name' })).toHaveAccessibleDescription('The name people see')
    expect(document.querySelector('[title]')).toBeNull()
  })

  it('shows on keyboard focus and on a resting pointer', () => {
    render(<Table />)
    const name = screen.getByRole('button', { name: 'Name' })
    fireEvent.focus(name, { relatedTarget: null })
    expect(tip()).toHaveTextContent('The name people see')
    fireEvent.blur(name)

    fireEvent.mouseEnter(name)
    act(() => { vi.advanceTimersByTime(TOOLTIP_DELAY_MS) })
    expect(tip()).toHaveTextContent('The name people see')
  })

  it('closes on the press that sorts, and still sorts', () => {
    render(<Table />)
    const name = screen.getByRole('button', { name: 'Name' })
    fireEvent.mouseEnter(name)
    act(() => { vi.advanceTimersByTime(TOOLTIP_DELAY_MS) })
    fireEvent.mouseDown(name)
    fireEvent.click(name)
    expect(tip()).toBeNull()
    expect(sort.toggle).toHaveBeenCalledWith('name')
  })

  it('has none where the column has nothing to say', () => {
    render(<Table />)
    expect(screen.getByRole('button', { name: 'Count' })).not.toHaveAttribute('aria-describedby')
  })
})

describe('a plain header\'s tooltip (ColumnHeader)', () => {
  it('puts the sentence on a label that takes focus, inside a header cell', () => {
    render(<Table />)
    const header = screen.getByRole('columnheader', { name: 'Value' })
    const label = header.querySelector('.column-hint')
    expect(label).toHaveAttribute('tabindex', '0')
    expect(label).toHaveAccessibleDescription('What the device last reported')
    fireEvent.focus(label, { relatedTarget: null })
    expect(tip()).toHaveTextContent('What the device last reported')
  })
})
