/**
 * A pin's label on an area's plan is an OverflowText: cut, it slides on the pin's hover or focus, and
 * while it is cut the pin's tooltip leads with it, since reduced motion stops the slide. A pin that is
 * a mark, inside a card that takes the focus, is still its label's control. jsdom lays nothing out,
 * so the label is given the widths a browser would measure.
 */
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { AreaPlanPin } from '../components/common/AreaPlan'

const label = () => {
  const el = document.querySelector('.area-plan-pin-label')
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: 240 })
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: 150 })
  return el
}
const shift = (el) => el.style.getPropertyValue('--overflow-shift')
const NAME = 'Final assembly and end-of-line test, bay four'

describe('a pin’s cut label', () => {
  it('slides on the pin’s hover, and the tooltip leads with it while it is cut', () => {
    render(<AreaPlanPin x={0.5} y={0.5} status="normal" label={NAME} title="Normal — 2 gateways, 5 devices" onClick={() => {}} />)
    const el = label()
    const pin = screen.getByRole('button', { name: NAME })
    fireEvent.mouseEnter(pin)
    expect(shift(el)).toBe('-90px')
    fireEvent.focus(pin)
    expect(screen.getByRole('tooltip')).toHaveTextContent(`${NAME}. Normal — 2 gateways, 5 devices`)
  })

  it('keeps the tooltip to what the label does not say while it fits', () => {
    render(<AreaPlanPin x={0.5} y={0.5} status="normal" label="Bay 4" title="Normal" onClick={() => {}} />)
    fireEvent.focus(screen.getByRole('button', { name: 'Bay 4' }))
    expect(screen.getByRole('tooltip')).toHaveTextContent(/^Normal$/)
  })

  it('takes the pin, not the card around it, as its control where the pin is a mark', () => {
    render(
      <div tabIndex={0} data-testid="card">
        <AreaPlanPin x={0.5} y={0.5} status="idle" label={NAME} title="Idle" />
      </div>
    )
    const el = label()
    fireEvent.mouseEnter(screen.getByTestId('card'))
    expect(shift(el)).toBe('')
    fireEvent.mouseEnter(document.querySelector('.area-plan-pin'))
    expect(shift(el)).toBe('-90px')
  })
})
