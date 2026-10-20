import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { useHoverIntent } from '../hooks/useHoverIntent'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const wait = (ms) => act(() => { vi.advanceTimersByTime(ms) })

describe('useHoverIntent', () => {
  it('opens once the pointer has rested for the delay, 150ms unless told otherwise', () => {
    const { result } = renderHook(() => useHoverIntent())
    act(() => result.current.onMouseEnter())
    wait(149)
    expect(result.current.open).toBe(false)
    wait(1)
    expect(result.current.open).toBe(true)
  })

  it('takes its delay as a parameter', () => {
    const { result } = renderHook(() => useHoverIntent(300))
    act(() => result.current.onMouseEnter())
    wait(299)
    expect(result.current.open).toBe(false)
    wait(1)
    expect(result.current.open).toBe(true)
  })

  it('cancels the wait when the pointer leaves first, and closes at once when it leaves after', () => {
    const { result } = renderHook(() => useHoverIntent(150))
    act(() => result.current.onMouseEnter())
    wait(100)
    act(() => result.current.onMouseLeave())
    wait(1000)
    expect(result.current.open).toBe(false)

    act(() => result.current.onMouseEnter())
    wait(150)
    act(() => result.current.onMouseLeave())
    expect(result.current.open).toBe(false)
  })

  it('opens at once on show, for keyboard focus, and hide cancels a wait still running', () => {
    const { result } = renderHook(() => useHoverIntent(150))
    act(() => result.current.show())
    expect(result.current.open).toBe(true)
    act(() => result.current.hide())
    expect(result.current.open).toBe(false)

    act(() => result.current.onMouseEnter())
    act(() => result.current.hide())
    wait(1000)
    expect(result.current.open).toBe(false)
  })

  it('leaves no timer behind when the target unmounts mid-wait', () => {
    const { result, unmount } = renderHook(() => useHoverIntent(150))
    act(() => result.current.onMouseEnter())
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
