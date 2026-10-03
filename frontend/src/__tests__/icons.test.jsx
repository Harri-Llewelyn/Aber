import React from 'react'
import { render } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import * as Icons from '../components/common/Icons'

/**
 * Every icon forwards `className`, `style` and any other prop (`aria-hidden`, `title`) to its svg.
 * Each icon is written out by hand, so a new one copied from an older signature can silently drop a
 * prop its caller passes.
 */

const ICONS = Object.entries(Icons).filter(([name, value]) => /^Icon[A-Z]/.test(name) && typeof value === 'function')

describe('icons', () => {
  it('finds the icons it checks', () => {
    expect(ICONS.length).toBeGreaterThan(50)
  })

  it.each(ICONS)('%s forwards className and style', (name, Icon) => {
    const { container } = render(<Icon className="probe" style={{ verticalAlign: '-2px' }} />)
    const svg = container.querySelector('svg')
    expect(svg).toHaveClass('probe')
    expect(svg).toHaveStyle({ verticalAlign: '-2px' })
  })

  it.each(ICONS)('%s forwards aria-hidden, and adds none of its own', (name, Icon) => {
    const { container, rerender } = render(<Icon aria-hidden="true" />)
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    rerender(<Icon />)
    expect(container.querySelector('svg')).not.toHaveAttribute('aria-hidden')
  })
})
