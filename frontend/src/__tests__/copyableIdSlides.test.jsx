/**
 * CopyableId's value is an OverflowText: cut, it slides on hover or keyboard focus, and with
 * `truncate="start"` the head slides towards the tail it is cut before, so the end stays in view.
 * jsdom lays nothing out, so the cut part is given the widths a browser would measure.
 */
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import CopyableId from '../components/common/CopyableId'

const LONG = 'https://aber.local/semantics/iso22400/EFFECTIVENESS'
const clip = (el) => {
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: 300 })
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: 100 })
  return el
}
const shift = (el) => el.style.getPropertyValue('--overflow-shift')

afterEach(() => vi.restoreAllMocks())

describe('CopyableId’s cut value', () => {
  it('slides the whole value, cut at its end, while the pointer is on the chip', () => {
    render(<CopyableId value={LONG} label="semantic id" />)
    const value = clip(document.querySelector('.copyable-id-value'))
    expect(value).toHaveClass('overflow-text')
    fireEvent.mouseEnter(screen.getByRole('button'))
    expect(shift(value)).toBe('-200px')
    fireEvent.mouseLeave(screen.getByRole('button'))
    expect(shift(value)).toBe('0px')
  })

  it('slides the head of a "start" value, and never the tail that keeps the end', () => {
    render(<CopyableId value={LONG} label="semantic id" truncate="start" />)
    const head = clip(document.querySelector('.copyable-id-head'))
    const tail = document.querySelector('.copyable-id-tail')
    expect(head).toHaveClass('overflow-text')
    expect(tail.closest('.overflow-text')).toBeNull()
    fireEvent.mouseEnter(screen.getByRole('button'))
    expect(shift(head)).toBe('-200px')
    expect(head.textContent + tail.textContent).toBe(LONG)
  })

  it('does not move a value that fits, and its tooltip offers the copy rather than the value', () => {
    render(<CopyableId value="short-id" label="device id" />)
    const value = document.querySelector('.copyable-id-value')
    fireEvent.mouseEnter(screen.getByRole('button'))
    expect(shift(value)).toBe('')
    fireEvent.focus(screen.getByRole('button'))
    expect(document.querySelector('[role=tooltip]')).toHaveTextContent('Click to copy this device id')
  })
})
