import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { OverflowText } from '../components/common/OverflowText'

/**
 * OverflowText's `active`: an option a person highlighted while the focus is elsewhere, as in a combobox's
 * list, slides as a focused control does. overflowText.test.jsx holds the rest.
 */
const line = () => document.querySelector('.overflow-text')
const sliding = () => line().classList.contains('overflow-text-sliding')
const shift = () => line().style.getPropertyValue('--overflow-shift')
const measure = (scrollWidth, clientWidth) => {
  Object.defineProperty(line(), 'scrollWidth', { configurable: true, value: scrollWidth })
  Object.defineProperty(line(), 'clientWidth', { configurable: true, value: clientWidth })
}
const option = (active, extra = {}) => <button type="button"><OverflowText active={active} {...extra}>A name far too long for its row</OverflowText></button>

afterEach(() => { vi.useRealTimers() })

describe('an active line', () => {
  it('slides when it becomes active, and back when it stops being', () => {
    vi.useFakeTimers()
    const { rerender } = render(option(false))
    measure(300, 120)
    rerender(option(true))
    expect(sliding()).toBe(true)
    expect(shift()).toBe('-180px')
    rerender(option(false))
    expect(shift()).toBe('0px')
    act(() => { vi.advanceTimersByTime(300) })
    expect(sliding()).toBe(false)
  })

  it('holds while it is active, whatever the pointer does', () => {
    const { rerender } = render(option(false))
    measure(300, 120)
    rerender(option(true))
    fireEvent.mouseEnter(screen.getByRole('button'))
    fireEvent.mouseLeave(screen.getByRole('button'))
    expect(shift()).toBe('-180px')
  })

  it('does not move where the text fits', () => {
    const { rerender } = render(option(false))
    measure(40, 120)
    rerender(option(true))
    expect(sliding()).toBe(false)
  })

  it('is measured only as it changes, so a list of them reads no layout as it is drawn', () => {
    const onMeasure = vi.fn()
    const { rerender, unmount } = render(option(false, { onMeasure }))
    expect(onMeasure).not.toHaveBeenCalled()
    rerender(option(true, { onMeasure }))
    expect(onMeasure).toHaveBeenCalledTimes(1)
    rerender(option(true, { onMeasure }))
    expect(onMeasure).toHaveBeenCalledTimes(1)
    unmount()
    expect(onMeasure).toHaveBeenCalledTimes(1)
  })
})
