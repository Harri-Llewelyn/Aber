/**
 * OverflowText: one line cut with an ellipsis, which slides to show its end while the pointer is on
 * it or on the control it names, or that control has keyboard focus, and slides back after. Only
 * text that is really cut moves, it never moves by itself, and under reduced motion not at all.
 * jsdom lays nothing out, so each test gives the line the widths a browser would measure.
 */
import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { OverflowText, SLIDE_PX_PER_SECOND } from '../components/common/OverflowText'

/** The line, measured as `scrollWidth` of text in a `clientWidth` box. */
function measure(el, scrollWidth, clientWidth) {
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: scrollWidth })
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: clientWidth })
}

const line = () => document.querySelector('.overflow-text')
const sliding = () => line().classList.contains('overflow-text-sliding')
const shift = () => line().style.getPropertyValue('--overflow-shift')

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('OverflowText', () => {
  it('draws the whole text, once, as one line', () => {
    render(<OverflowText className="lane-name">Assembly line one</OverflowText>)
    expect(line()).toHaveClass('lane-name')
    expect(line()).toHaveTextContent('Assembly line one')
    expect(screen.getAllByText('Assembly line one')).toHaveLength(1)
  })

  it('slides a cut line to its end on hover over its control, at reading pace', () => {
    render(<button type="button"><OverflowText>A name far too long for its column</OverflowText></button>)
    measure(line(), 300, 120)
    fireEvent.mouseEnter(screen.getByRole('button'))
    expect(sliding()).toBe(true)
    expect(shift()).toBe('-180px')
    expect(line().style.getPropertyValue('--overflow-ms')).toBe(`${Math.round((180 / SLIDE_PX_PER_SECOND) * 1000)}ms`)
  })

  it('slides back when the pointer leaves, and takes the ellipsis back once there', () => {
    vi.useFakeTimers()
    render(<button type="button"><OverflowText>A name far too long for its column</OverflowText></button>)
    measure(line(), 300, 120)
    fireEvent.mouseEnter(screen.getByRole('button'))
    fireEvent.mouseLeave(screen.getByRole('button'))
    expect(shift()).toBe('0px')
    // Still clipped rather than ellipsised while it moves back.
    expect(sliding()).toBe(true)
    act(() => { vi.advanceTimersByTime(300) })
    expect(sliding()).toBe(false)
  })

  it('does not move a line that fits', () => {
    render(<button type="button"><OverflowText>Line 1</OverflowText></button>)
    measure(line(), 40, 120)
    fireEvent.mouseEnter(screen.getByRole('button'))
    expect(sliding()).toBe(false)
  })

  it('slides on keyboard focus of its control, and not on the focus a click gives it', () => {
    render(<button type="button"><OverflowText>A name far too long for its column</OverflowText></button>)
    const button = screen.getByRole('button')
    measure(line(), 300, 120)
    const matches = vi.spyOn(button, 'matches')

    matches.mockImplementation((selector) => selector === ':focus-visible')
    fireEvent.focusIn(button)
    expect(sliding()).toBe(true)
    fireEvent.focusOut(button)
    expect(shift()).toBe('0px')

    matches.mockImplementation(() => false)
    fireEvent.focusIn(button)
    expect(shift()).toBe('0px')
  })

  it('tells onMeasure whether the line is cut each time it measures, as a tooltip needs to know', () => {
    const onMeasure = vi.fn()
    render(<button type="button"><OverflowText onMeasure={onMeasure}>A name far too long for its column</OverflowText></button>)
    expect(onMeasure).not.toHaveBeenCalled()
    measure(line(), 300, 120)
    fireEvent.mouseEnter(screen.getByRole('button'))
    expect(onMeasure).toHaveBeenLastCalledWith(true)
    fireEvent.mouseLeave(screen.getByRole('button'))
    // A wider column: the line fits now.
    measure(line(), 300, 320)
    fireEvent.focusIn(screen.getByRole('button'))
    expect(onMeasure).toHaveBeenLastCalledWith(false)
  })

  it('reacts to the pointer on itself where no control holds it', () => {
    render(<p><OverflowText>A name far too long for its column</OverflowText></p>)
    measure(line(), 300, 120)
    fireEvent.mouseEnter(line())
    expect(sliding()).toBe(true)
  })

  it('stays still under reduced motion, for the control\'s tooltip to carry the whole text', () => {
    // jsdom has no matchMedia of its own.
    const had = Object.prototype.hasOwnProperty.call(window, 'matchMedia')
    const before = window.matchMedia
    window.matchMedia = (query) => ({ matches: query === '(prefers-reduced-motion: reduce)', media: query })
    try {
      render(<button type="button"><OverflowText>A name far too long for its column</OverflowText></button>)
      measure(line(), 300, 120)
      fireEvent.mouseEnter(screen.getByRole('button'))
      expect(sliding()).toBe(false)
    } finally {
      if (had) window.matchMedia = before
      else delete window.matchMedia
    }
  })
})
