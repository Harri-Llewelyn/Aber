import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { TagList } from '../components/common/TagList'

const tag = (key, extra = {}) => ({ key, content: key, className: 'badge badge-neutral', ...extra })

const SIX = ['Axes', 'Controller', 'Machine', 'MotionDevice', 'OEE', 'Systems'].map(t => tag(t))

describe('TagList', () => {
  it('shows everything when under the limit', () => {
    render(<TagList tags={[tag('Axes'), tag('OEE')]} limit={2} />)
    expect(screen.getByText('Axes')).toBeInTheDocument()
    expect(screen.getByText('OEE')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('collapses past the limit and counts the remainder', () => {
    render(<TagList tags={SIX} limit={2} />)
    expect(screen.getByText('Axes')).toBeInTheDocument()
    expect(screen.getByText('Controller')).toBeInTheDocument()
    expect(screen.queryByText('Systems')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '+4' })).toBeInTheDocument()
  })

  it('names the hidden tags in the tooltip, so the row can be scanned without expanding', () => {
    render(<TagList tags={SIX} limit={2} />)
    expect(screen.getByRole('button', { name: '+4' }).title)
      .toBe('Machine, MotionDevice, OEE, Systems')
  })

  it('expands and collapses again', () => {
    render(<TagList tags={SIX} limit={2} />)
    fireEvent.click(screen.getByRole('button', { name: '+4' }))

    expect(screen.getByText('Systems')).toBeInTheDocument()
    const collapse = screen.getByRole('button', { name: 'show less' })
    expect(collapse.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(collapse)
    expect(screen.queryByText('Systems')).not.toBeInTheDocument()
  })

  it('never collapses a priority tag, however late it appears in the list', () => {
    // deviceTagList() appends Unmodelled LAST, so a plain truncation would hide precisely the tag
    // that calls for action and keep the six that are merely descriptive.
    render(<TagList tags={[...SIX, tag('Unmodelled', { priority: true })]} limit={2} />)

    // Seven tags, two shown (Unmodelled pinned first, then Axes), so five remain hidden.
    expect(screen.getByText('Unmodelled')).toBeInTheDocument()
    expect(screen.getByText('Axes')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '+5' })).toBeInTheDocument()
  })

  it('keeps the order of the non-priority tags', () => {
    render(<TagList tags={[...SIX, tag('Unmodelled', { priority: true })]} limit={3} />)
    // Unmodelled floats to the front; Axes and Controller follow in their original order.
    const shown = screen.getAllByText(/Unmodelled|Axes|Controller|Machine/).map(n => n.textContent)
    expect(shown).toEqual(['Unmodelled', 'Axes', 'Controller'])
  })

  it('renders the empty label rather than an empty container', () => {
    const { container } = render(<TagList tags={[]} />)
    expect(container.textContent).toBe('—')
  })

  it('tolerates a list with holes, which callers build conditionally', () => {
    render(<TagList tags={[tag('Axes'), null, undefined, tag('OEE')]} limit={5} />)
    expect(screen.getByText('Axes')).toBeInTheDocument()
    expect(screen.getByText('OEE')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
