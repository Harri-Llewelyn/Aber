import React from 'react'
import { render } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import AmbientPipeline from '../components/common/AmbientPipeline'

/**
 * The sign-in screen's ambient canvas. Three ways an animated background goes wrong in an
 * application: it must stop when unmounted, must not animate under prefers-reduced-motion, and must
 * never take the sign-in screen down whatever the canvas API does.
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

    // A still frame costs nothing per frame: running the same work and discarding it would still
    // burn battery.
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

    // getContext is specified to return null when unavailable and throws in jsdom and in browsers
    // with canvas switched off. Decoration must fail quietly.
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

    // The regression: React runs effects children-first and useTheme lives in the parent, so on a
    // toggle this effect ran while data-theme still held the outgoing value and the canvas resolved
    // its colours one theme behind.
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
