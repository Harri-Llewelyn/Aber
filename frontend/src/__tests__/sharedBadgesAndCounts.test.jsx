import React from 'react'
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { SectionCount, countLabel } from '../components/common/SectionCount'
import { Badge, ArchivedBadge, TONE_CLASS } from '../components/common/Badge'
import { StatusBadge } from '../components/common/StatusBadge'

describe('countLabel', () => {
  it('is a bare total when nothing is filtered', () => {
    expect(countLabel(undefined, 12)).toBe('12')
    expect(countLabel(null, 12)).toBe('12')
    expect(countLabel(12, 12)).toBe('12')
  })

  it('is shown / total while only part of the rows are drawn', () => {
    expect(countLabel(3, 12)).toBe('3 / 12')
    expect(countLabel(0, 12)).toBe('0 / 12')
  })

  it('shows zero rather than nothing', () => {
    expect(countLabel(undefined, 0)).toBe('0')
    expect(countLabel(0, 0)).toBe('0')
  })

  it('draws what it has when the total is unknown', () => {
    expect(countLabel(200, undefined)).toBe('200')
    expect(countLabel(undefined, undefined)).toBe('0')
  })
})

describe('SectionCount', () => {
  it('renders the section-count pill, including for 0', () => {
    const { container } = render(<SectionCount total={0} />)
    const pill = container.querySelector('.section-count')
    expect(pill).not.toBeNull()
    expect(pill.textContent).toBe('0')
  })

  it('reads shown / total when filtered', () => {
    const { container } = render(<SectionCount total={40} shown={7} />)
    expect(container.querySelector('.section-count').textContent).toBe('7 / 40')
  })
})

describe('Badge', () => {
  it.each(['success', 'info', 'warning', 'danger', 'neutral', 'pending', 'brand'])('tone %s draws its class', (tone) => {
    const { container } = render(<Badge tone={tone}>x</Badge>)
    const el = container.querySelector('.badge')
    expect(el.className).toContain(TONE_CLASS[tone])
    expect(el.textContent).toBe('x')
  })

  it('takes the small size, the title and an icon', () => {
    const { container } = render(<Badge tone="success" size="sm" title="Hover" icon={<i data-testid="ic" />}>ok</Badge>)
    const el = container.querySelector('.badge')
    expect(el.className).toContain('badge-sm')
    expect(el.getAttribute('title')).toBe('Hover')
    expect(el.querySelector('[data-testid="ic"]')).not.toBeNull()
  })

  it('is 12px by default: no size class', () => {
    const { container } = render(<Badge tone="info">x</Badge>)
    expect(container.querySelector('.badge').className).not.toContain('badge-sm')
  })

  it('accepts the names the helpers and the old vocabulary return', () => {
    expect(TONE_CLASS.ok).toBe('badge-success')
    expect(TONE_CLASS.online).toBe('badge-success')
    expect(TONE_CLASS.critical).toBe('badge-danger')
    expect(TONE_CLASS.offline).toBe('badge-danger')
  })

  it('falls back to neutral for a tone it does not know', () => {
    const { container } = render(<Badge tone="mystery">x</Badge>)
    expect(container.querySelector('.badge').className).toContain('badge-neutral')
  })

  it('adds the provider colour class to a brand badge', () => {
    const { container } = render(<Badge tone="brand" brand="drive">Drive</Badge>)
    expect(container.querySelector('.badge').className).toContain('badge-drive')
  })
})

describe('ArchivedBadge', () => {
  it('is the bordered warning form with the icon and the word ARCHIVED', () => {
    const { container } = render(<ArchivedBadge />)
    const el = container.querySelector('.badge')
    expect(el.className).toContain('badge-warning')
    expect(el.className).toContain('badge-archived')
    expect(el.querySelector('svg')).not.toBeNull()
    expect(el.textContent.trim()).toBe('ARCHIVED')
  })

  it('takes a size and a title', () => {
    const { container } = render(<ArchivedBadge size="sm" title="Out of commission" />)
    const el = container.querySelector('.badge')
    expect(el.className).toContain('badge-sm')
    expect(el.getAttribute('title')).toBe('Out of commission')
  })
})

describe('StatusBadge through Badge', () => {
  it('keeps the dot and the label', () => {
    const { container } = render(<StatusBadge status="ONLINE" />)
    expect(container.querySelector('.badge .badge-dot')).not.toBeNull()
    expect(container.querySelector('.badge').textContent).toBe('ONLINE')
  })
})
