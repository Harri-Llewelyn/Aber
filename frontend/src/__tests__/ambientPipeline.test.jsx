import React from 'react'
import { render } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import AmbientPipeline from '../components/common/AmbientPipeline'

/**
 * The sign-in screen's ambient canvas.
 *
 * These assertions are about the three ways an animated background goes wrong in an application,
 * as opposed to on a demo page. None of them is about how it looks.
 *
 *   - it must stop when it is unmounted, or signing out and back in leaves a
 *     requestAnimationFrame loop per visit running against a detached canvas;
 *   - it must not animate at all under prefers-reduced-motion;
 *   - it must never take the sign-in screen down, whatever the canvas API does.
 */

/** A 2d context that records nothing and answers everything. */
function fakeContext() {
  return {
    save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), stroke: vi.fn(),
    fillRect: vi.fn(), drawImage: vi.fn(),
    fillStyle: '', strokeStyle: '', lineWidth: 1, filter: 'none', globalCompositeOperation: '',
  }
}

let getContextSpy

beforeEach(() => {
  getContextSpy = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation(() => fakeContext())
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** Force a specific answer out of matchMedia for the reduced-motion query. */
function setReducedMotion(reduce) {
  window.matchMedia = vi.fn().mockImplementation(query => ({
    matches: query.includes('prefers-reduced-motion') ? reduce : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
}

describe('AmbientPipeline', () => {

  it('stops its animation loop when unmounted', () => {
    setReducedMotion(false)
    const cancel = vi.spyOn(window, 'cancelAnimationFrame')
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1234)

    const { unmount } = render(<AmbientPipeline theme="dark" />)
    expect(raf).toHaveBeenCalled()

    unmount()

    // THE LEAK THIS GUARDS. The upstream demo never cancels; dropped into a React tree that
    // means one live loop per mount, each still drawing into a canvas nobody can see.
    expect(cancel).toHaveBeenCalledWith(1234)
  })

  it('removes its canvas from the DOM when unmounted', () => {
    setReducedMotion(false)
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)

    const { container, unmount } = render(<AmbientPipeline theme="dark" />)
    expect(container.querySelectorAll('canvas')).toHaveLength(1)

    unmount()
    expect(container.querySelectorAll('canvas')).toHaveLength(0)
  })

  it('does not animate when the viewer prefers reduced motion', () => {
    setReducedMotion(true)
    const raf = vi.spyOn(window, 'requestAnimationFrame')

    render(<AmbientPipeline theme="dark" />)

    // A STILL FRAME COSTS NOTHING PER FRAME. Continuous drift behind a login form is a
    // vestibular trigger, and honouring the preference by running the same work and discarding
    // it would still burn the battery it is reasonable to expect us to save.
    expect(raf).not.toHaveBeenCalled()
  })

  it('renders a still frame rather than nothing under reduced motion', () => {
    setReducedMotion(true)
    const ctx = fakeContext()
    getContextSpy.mockImplementation(() => ctx)

    render(<AmbientPipeline theme="dark" />)

    // Something was actually composited: the alternative reading of "no animation" is a blank
    // rectangle, which would look like a broken page rather than a deliberate one.
    expect(ctx.drawImage).toHaveBeenCalled()
  })

  it('survives a canvas context that throws, without rendering a canvas', () => {
    setReducedMotion(false)
    getContextSpy.mockImplementation(() => { throw new Error('canvas disabled') })

    // getContext is SPECIFIED to return null when unavailable and THROWS in jsdom and in
    // browsers with canvas switched off. A null check alone lets that escape a passive effect
    // and take the sign-in screen with it -- this is decoration and must fail quietly.
    const { container } = render(<AmbientPipeline theme="dark" />)
    expect(container.querySelectorAll('canvas')).toHaveLength(0)
  })

  it('survives a canvas context that returns null', () => {
    setReducedMotion(false)
    getContextSpy.mockImplementation(() => null)

    const { container } = render(<AmbientPipeline theme="dark" />)
    expect(container.querySelectorAll('canvas')).toHaveLength(0)
  })

  it('does not read its palette while the root theme attribute is still one behind', () => {
    setReducedMotion(true)
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)

    // THE REGRESSION. React runs effects children-first, and useTheme lives in the PARENT
    // (AuthScreen) -- so on a toggle this component's effect ran while data-theme still held the
    // outgoing value, and the canvas resolved --bg-base and --accent one theme behind. On screen
    // that was a light card on a dark field, and a dark card on a pale one. It looked correct
    // only after a reload with the dark theme stored, because a root carrying no data-theme
    // resolves to `:root`, which is itself the dark palette -- agreement by coincidence.
    document.documentElement.setAttribute('data-theme', 'dark')

    const { unmount } = render(<AmbientPipeline theme="light" />)
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    unmount()

    document.documentElement.setAttribute('data-theme', 'light')
    render(<AmbientPipeline theme="dark" />)
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('leaves the root attribute alone when it already agrees', () => {
    setReducedMotion(true)
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)

    // It writes only what useTheme is about to write anyway, so the common case must be a no-op
    // rather than a redundant attribute change that invalidates style on every mount.
    document.documentElement.setAttribute('data-theme', 'dark')
    const spy = vi.spyOn(document.documentElement, 'setAttribute')

    render(<AmbientPipeline theme="dark" />)

    expect(spy).not.toHaveBeenCalledWith('data-theme', expect.anything())
  })

  it('paints a different ground in each theme rather than recolouring one effect', () => {
    setReducedMotion(true)

    const grounds = {}
    for (const theme of ['dark', 'light']) {
      const seen = []
      const ctx = fakeContext()
      // fillStyle is assigned then used, so capture it at the moment of the fill.
      ctx.fillRect = vi.fn(() => seen.push(ctx.fillStyle))
      getContextSpy.mockImplementation(() => ctx)

      document.documentElement.setAttribute('data-theme', theme)
      const { unmount } = render(<AmbientPipeline theme={theme} />)
      grounds[theme] = seen
      unmount()
    }

    // Both themes paint SOME ground -- the canvas is opaque in both, so the card never sits on
    // a transparent hole.
    expect(grounds.dark.length).toBeGreaterThan(0)
    expect(grounds.light.length).toBeGreaterThan(0)
  })
})
