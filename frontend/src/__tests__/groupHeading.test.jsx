/**
 * GroupHeading: the shared heading of a group of rows that opens and closes. A disclosure button
 * (WAI-ARIA Disclosure pattern) with a chevron, an optional icon, the name and a count or words in
 * its place, which reports a press and leaves the page to keep which groups are open.
 */
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { GroupHeading } from '../components/common/GroupHeading'
import { IconCpu } from '../components/common/Icons'

const UP = '18 15 12 9 6 15'
const DOWN = '6 9 12 15 18 9'

describe('GroupHeading', () => {
  it('is a button that says whether its group is open and which element it opens', () => {
    render(<GroupHeading open label="Devices" count={12} countLabel="12 lanes" controls="rows" onToggle={() => {}} />)
    const button = screen.getByRole('button', { name: 'Devices, 12 lanes' })
    expect(button).toHaveAttribute('type', 'button')
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(button).toHaveAttribute('aria-controls', 'rows')
  })

  it('draws "Devices · 12", the count beside the name, and speaks the count in words', () => {
    render(<GroupHeading open label="Devices" count={12} countLabel="12 lanes" onToggle={() => {}} />)
    const count = document.querySelector('.group-heading-count')
    expect(count.querySelector('[aria-hidden="true"]')).toHaveTextContent('· 12')
    expect(count.querySelector('.sr-only')).toHaveTextContent(', 12 lanes')
    expect(screen.getByText('Devices')).toHaveClass('table-group-label')
  })

  it('speaks the bare number without a countLabel, and draws no count without a count', () => {
    const { unmount } = render(<GroupHeading open label="Areas" count={3} onToggle={() => {}} />)
    expect(screen.getByRole('button')).toHaveAccessibleName('Areas, 3')
    unmount()
    render(<GroupHeading open label="Areas" onToggle={() => {}} />)
    expect(screen.getByRole('button')).toHaveAccessibleName('Areas')
    expect(document.querySelector('.group-heading-count')).toBeNull()
  })

  it('draws words in place of a count as cut text, "Entity · 2 chosen", and speaks them after the name', () => {
    render(<GroupHeading open={false} label="Entity" detail="2 chosen" onToggle={() => {}} />)
    expect(screen.getByRole('button')).toHaveAccessibleName('Entity, 2 chosen')
    const detail = document.querySelector('.group-heading-detail')
    expect(detail.querySelector('[aria-hidden="true"] .overflow-text')).toHaveTextContent('· 2 chosen')
    expect(detail.querySelector('.sr-only')).toHaveTextContent(', 2 chosen')
    expect(document.querySelector('.group-heading-count:not(.group-heading-detail)')).toBeNull()
  })

  it('points its chevron up while open and down while closed, as the table group rows do', () => {
    const { rerender } = render(<GroupHeading open label="Devices" onToggle={() => {}} />)
    const points = () => document.querySelector('.group-heading-chevron polyline').getAttribute('points')
    expect(points()).toBe(UP)
    rerender(<GroupHeading open={false} label="Devices" onToggle={() => {}} />)
    expect(points()).toBe(DOWN)
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false')
  })

  it('reports a press and keeps no state of its own', () => {
    const onToggle = vi.fn()
    render(<GroupHeading open label="Devices" onToggle={onToggle} />)
    fireEvent.click(screen.getByRole('button'))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true')
  })

  it('hides its chevron and icon from a screen reader', () => {
    render(<GroupHeading open label="Devices" icon={<IconCpu size={12} />} onToggle={() => {}} />)
    expect(document.querySelector('.group-heading-chevron')).toHaveAttribute('aria-hidden', 'true')
    expect(document.querySelector('.group-heading-icon')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByRole('button')).toHaveAccessibleName('Devices')
  })
})
