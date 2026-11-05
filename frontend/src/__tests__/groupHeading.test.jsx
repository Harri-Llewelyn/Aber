/**
 * GroupHeading: the shared heading of a group of rows that opens and closes. A disclosure button
 * (WAI-ARIA Disclosure pattern) with a chevron, an optional icon, the name and a count or words in
 * its place, which reports a press and leaves the page to keep which groups are open.
 */
import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GroupHeading } from '../components/common/GroupHeading'
import { IconCpu } from '../components/common/Icons'
import { TOOLTIP_DELAY_MS } from '../components/common/Tooltip'

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

/**
 * A cut `detail` is the button's tooltip as well: under reduced motion the cut text does not slide,
 * so the tooltip is the only way to read the rest. jsdom lays nothing out, so each test gives the
 * line the widths a browser would measure.
 */
describe('GroupHeading with a detail cut short', () => {
  const LONG = 'Assembly line one, press seven hydraulic pressure'
  const had = Object.prototype.hasOwnProperty.call(window, 'matchMedia')
  const before = window.matchMedia
  /** jsdom has no matchMedia of its own; this one answers for reduced motion. */
  const reduceMotion = (on) => {
    window.matchMedia = (query) => ({ matches: on && query === '(prefers-reduced-motion: reduce)', media: query })
  }

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => {
    vi.useRealTimers()
    if (had) window.matchMedia = before
    else delete window.matchMedia
  })

  /** The heading, its detail measured `scrollWidth` wide in a `clientWidth` box. */
  const heading = (scrollWidth, clientWidth) => {
    render(<GroupHeading open={false} label="Entity" detail={LONG} onToggle={() => {}} />)
    const line = document.querySelector('.group-heading-detail .overflow-text')
    Object.defineProperty(line, 'scrollWidth', { configurable: true, value: scrollWidth })
    Object.defineProperty(line, 'clientWidth', { configurable: true, value: clientWidth })
    return screen.getByRole('button')
  }
  const tooltip = () => screen.queryByRole('tooltip')
  const rest = () => act(() => { vi.advanceTimersByTime(TOOLTIP_DELAY_MS) })

  it('shows the whole value in the tooltip on hover, under reduced motion', () => {
    reduceMotion(true)
    const button = heading(400, 120)
    fireEvent.mouseEnter(button)
    rest()
    expect(tooltip()).toHaveTextContent(LONG)
    // Still: the tooltip carries the rest, not a slide.
    expect(document.querySelector('.overflow-text')).not.toHaveClass('overflow-text-sliding')
    fireEvent.mouseLeave(button)
    expect(tooltip()).toBeNull()
  })

  it('shows it at once on keyboard focus, under reduced motion', () => {
    reduceMotion(true)
    const button = heading(400, 120)
    fireEvent.focusIn(button)
    expect(tooltip()).toHaveTextContent(LONG)
    fireEvent.focusOut(button)
    expect(tooltip()).toBeNull()
  })

  it('shows it as well where the cut text slides, on hover and on focus', () => {
    reduceMotion(false)
    const button = heading(400, 120)
    fireEvent.mouseEnter(button)
    rest()
    expect(tooltip()).toHaveTextContent(LONG)
    fireEvent.mouseLeave(button)
    fireEvent.focusIn(button)
    expect(tooltip()).toHaveTextContent(LONG)
  })

  it('gives a value that fits no tooltip', () => {
    reduceMotion(true)
    const button = heading(100, 120)
    fireEvent.mouseEnter(button)
    rest()
    expect(tooltip()).toBeNull()
    fireEvent.focusIn(button)
    expect(tooltip()).toBeNull()
  })

  it('is not read a second time: the button is named with the value, and the tooltip describes nothing', () => {
    reduceMotion(true)
    const button = heading(400, 120)
    fireEvent.focusIn(button)
    expect(tooltip()).toHaveTextContent(LONG)
    expect(button).toHaveAccessibleName(`Entity, ${LONG}`)
    expect(button).not.toHaveAttribute('aria-describedby')
    expect(button).toHaveAccessibleDescription('')
  })
})
