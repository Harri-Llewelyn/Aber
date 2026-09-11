import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { HelpTip } from '../components/common/HelpTip'

const show = () => render(
  <h3 className="section-title">
    Devices
    <HelpTip label="About devices" text="A device publishes telemetry through a gateway." />
  </h3>
)

describe('HelpTip', () => {
  it('renders a named button and no bubble at rest', () => {
    show()
    expect(screen.getByRole('button', { name: 'About devices' })).toBeInTheDocument()
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('shows the text on hover and hides it again', () => {
    show()
    const trigger = screen.getByRole('button', { name: 'About devices' })
    fireEvent.mouseEnter(trigger)
    const tip = screen.getByRole('tooltip')
    expect(tip).toHaveTextContent('A device publishes telemetry through a gateway.')
    // Tied to the trigger for assistive technology, and portalled out of the card.
    expect(trigger).toHaveAttribute('aria-describedby', tip.id)
    expect(tip.parentElement).toBe(document.body)

    fireEvent.mouseLeave(trigger)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('shows on keyboard focus, which a hover-only tip would not', () => {
    show()
    const trigger = screen.getByRole('button', { name: 'About devices' })
    fireEvent.focus(trigger)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    fireEvent.blur(trigger)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('pins on click for touch screens, and Escape unpins', () => {
    show()
    const trigger = screen.getByRole('button', { name: 'About devices' })
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('tooltip')).toBeInTheDocument()

    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('is a plain button, so it never submits a form it sits inside', () => {
    show()
    expect(screen.getByRole('button', { name: 'About devices' })).toHaveAttribute('type', 'button')
  })
})
