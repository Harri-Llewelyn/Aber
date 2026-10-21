/**
 * A segment with a `description` explains itself in the shared tooltip bubble, as a tab does: after
 * the hover delay, at once on keyboard focus, tied by aria-describedby, and with no `title`. A
 * segment without one has no tooltip unless it has a count, which the bubble shows with its name.
 */
import React, { useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SegmentedControl } from '../components/common/SegmentedControl'
import { TOOLTIP_DELAY_MS } from '../components/common/Tooltip'

const LAYOUTS = [
  { id: 'hover', label: 'Hover', description: 'Labels appear while the pointer is over the rail.' },
  { id: 'expanded', label: 'Expanded', description: 'Labels always shown.' },
  { id: 'plain', label: 'Plain' },
]

function Harness() {
  const [value, setValue] = useState('hover')
  return <SegmentedControl menu label="Layout" value={value} onChange={setValue} options={LAYOUTS} />
}

const segment = (name) => screen.getByRole('menuitemradio', { name })
const tip = () => screen.queryByRole('tooltip')
const wait = (ms) => act(() => { vi.advanceTimersByTime(ms) })

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('a segment with a description', () => {
  it('is described by its own tooltip, and has no title', () => {
    render(<Harness />)
    expect(segment('Hover')).toHaveAccessibleDescription('Labels appear while the pointer is over the rail.')
    expect(segment('Expanded')).toHaveAccessibleDescription('Labels always shown.')
    expect(segment('Hover')).not.toHaveAttribute('title')
    // Closed until the segment is pointed at or reached by keyboard.
    expect(tip()).toBeNull()
  })

  it('shows its tooltip once the pointer rests on it, and closes when it leaves', () => {
    render(<Harness />)
    fireEvent.mouseEnter(segment('Expanded'))
    wait(TOOLTIP_DELAY_MS - 1)
    expect(tip()).toBeNull()
    wait(1)
    expect(tip()).toHaveTextContent('Labels always shown.')
    fireEvent.mouseLeave(segment('Expanded'))
    expect(tip()).toBeNull()
  })

  it('shows it at once on keyboard focus, and follows the arrow keys to the next segment', () => {
    render(<Harness />)
    act(() => segment('Hover').focus())
    expect(tip()).toHaveTextContent('Labels appear while the pointer is over the rail.')
    fireEvent.keyDown(segment('Hover'), { key: 'ArrowRight' })
    expect(segment('Expanded')).toHaveFocus()
    expect(screen.getAllByRole('tooltip')).toHaveLength(1)
    expect(tip()).toHaveTextContent('Labels always shown.')
  })

  it('closes on a press, which still chooses the segment', () => {
    render(<Harness />)
    fireEvent.mouseEnter(segment('Expanded'))
    wait(TOOLTIP_DELAY_MS)
    fireEvent.mouseDown(segment('Expanded'))
    fireEvent.click(segment('Expanded'))
    expect(tip()).toBeNull()
    expect(segment('Expanded')).toHaveAttribute('aria-checked', 'true')
  })

  it('draws its bubble outside the group, which holds only the segments', () => {
    render(<Harness />)
    const group = screen.getByRole('group', { name: 'Layout' })
    expect([...group.children].every(c => c.tagName === 'BUTTON')).toBe(true)
  })
})

describe('a segment without one', () => {
  it('has no tooltip and no description, since its label says it all', () => {
    render(<Harness />)
    expect(segment('Plain')).not.toHaveAttribute('title')
    expect(segment('Plain')).not.toHaveAttribute('aria-describedby')
    act(() => segment('Plain').focus())
    expect(tip()).toBeNull()
  })
})
