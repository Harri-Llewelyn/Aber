/**
 * Where a control's own words are cut, its tooltip says them whole while they are cut, since reduced
 * motion stops the slide: a group's name (GroupHeading) and a list filter's chosen values
 * (FilterDropdown). jsdom lays nothing out, so the cut line is given the widths a browser would measure.
 */
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { GroupHeading } from '../components/common/GroupHeading'
import { FilterDropdown } from '../components/common/FilterChecklist'
import { tooltipOf } from '../test/tooltips'

const cut = (el, scrollWidth = 400) => {
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: scrollWidth })
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: 120 })
  return el
}

describe('a cut group name', () => {
  it('is the button’s tooltip while it is cut, with its words after it, and describes nothing', () => {
    render(<GroupHeading open={false} label="Applications & User Interfaces" detail="2 chosen" title="Metrics" onToggle={() => {}} />)
    cut(document.querySelector('.group-heading-label'))
    cut(document.querySelector('.group-heading-detail .overflow-text'))
    fireEvent.focusIn(screen.getByRole('button'))
    expect(screen.getByRole('tooltip')).toHaveTextContent('Applications & User Interfaces · 2 chosen')
    expect(screen.getByRole('button')).not.toHaveAccessibleDescription(/Applications/)
  })

  it('leaves the tooltip to the heading’s own words while it fits', () => {
    render(<GroupHeading open={false} label="Axes" title="Metrics named Axes" onToggle={() => {}} />)
    cut(document.querySelector('.group-heading-label'), 100)
    fireEvent.focusIn(screen.getByRole('button'))
    expect(tooltipOf(screen.getByRole('button'))).toBe('Metrics named Axes')
  })
})

describe('a list filter’s cut words', () => {
  const OPTIONS = [
    { value: 'a', label: 'Awaiting first birth' },
    { value: 'b', label: 'Online' },
  ]

  it('are the button’s tooltip while they are cut, the same words as its name', () => {
    render(<FilterDropdown label="Status" noun="status" plural="statuses" options={OPTIONS} value={['a']} onChange={() => {}} width="sm" />)
    const button = screen.getByRole('button', { name: 'Status: Awaiting first birth' })
    expect(tooltipOf(button)).toBeNull()
    cut(button.querySelector('.filter-dropdown-words'))
    fireEvent.focusIn(button)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Status: Awaiting first birth')
  })
})
