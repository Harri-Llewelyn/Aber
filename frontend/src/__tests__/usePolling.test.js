import { renderHook } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { usePolling } from '../hooks/usePolling'
import {
  CONNECTION_SESSION_ENDED,
  CONNECTION_STALE,
  STALE_AFTER_MS,
  getConnectionSnapshot,
  resetConnectionState
} from '../lib/connectionState'

const networkError = { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' }

describe('usePolling hook', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetConnectionState()
  })

  afterEach(() => {
    resetConnectionState()
    vi.useRealTimers()
  })

  it('executes poll callback on interval when enabled', async () => {
    const callback = vi.fn().mockResolvedValue({})
    renderHook(() => usePolling(callback, 1000, true))

    expect(callback).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1000)
    expect(callback).toHaveBeenCalledTimes(2)
  })

  // Stopping for good froze the page with nothing to say why. It now waits the longest interval, so
  // a token refreshed meanwhile gets through, and the strip offers Sign In Again until then.
  it('keeps polling a rejected session at the longest interval, and reports it', async () => {
    const err401 = new Error('Unauthorized')
    err401.status = 401
    const callback = vi.fn().mockRejectedValue(err401)

    renderHook(() => usePolling(callback, 1000, true))
    expect(callback).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(29999)
    expect(callback).toHaveBeenCalledTimes(1)
    expect(getConnectionSnapshot().status).toBe(CONNECTION_SESSION_ENDED)

    await vi.advanceTimersByTimeAsync(1)
    expect(callback).toHaveBeenCalledTimes(2)
  })

  it('clears the session message once a refreshed token gets through', async () => {
    const err401 = Object.assign(new Error('Unauthorized'), { status: 401 })
    const callback = vi.fn().mockRejectedValueOnce(err401).mockResolvedValue({})

    renderHook(() => usePolling(callback, 1000, true))
    await vi.advanceTimersByTimeAsync(STALE_AFTER_MS)
    expect(getConnectionSnapshot().status).toBe(CONNECTION_SESSION_ENDED)

    await vi.advanceTimersByTimeAsync(30000)
    expect(getConnectionSnapshot().failing).toBe(false)
  })

  it('reports a network failure, backs off, and clears on the next success', async () => {
    const callback = vi.fn().mockRejectedValueOnce(networkError).mockResolvedValue({})

    renderHook(() => usePolling(callback, 1000, true))
    await vi.advanceTimersByTimeAsync(0)
    expect(getConnectionSnapshot().failing).toBe(true)

    // 1.5 times the interval after a failure.
    await vi.advanceTimersByTimeAsync(1499)
    expect(callback).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(callback).toHaveBeenCalledTimes(2)
    expect(getConnectionSnapshot().failing).toBe(false)
  })

  it('leaves the state failing while every poll fails, and shows it after the threshold', async () => {
    const callback = vi.fn().mockRejectedValue(networkError)

    renderHook(() => usePolling(callback, 1000, true))
    await vi.advanceTimersByTimeAsync(STALE_AFTER_MS)
    expect(callback.mock.calls.length).toBeGreaterThan(2)
    expect(getConnectionSnapshot().status).toBe(CONNECTION_STALE)
  })

  it('does not count a bad query as the connection failing', async () => {
    const callback = vi.fn().mockRejectedValue({ code: '42501', message: 'permission denied' })

    renderHook(() => usePolling(callback, 1000, true))
    await vi.advanceTimersByTimeAsync(STALE_AFTER_MS)
    expect(getConnectionSnapshot().failing).toBe(false)
  })

  it('polls at once when the browser comes back online during a backoff', async () => {
    const callback = vi.fn().mockRejectedValueOnce(networkError).mockResolvedValue({})

    renderHook(() => usePolling(callback, 1000, true))
    await vi.advanceTimersByTimeAsync(100)
    expect(callback).toHaveBeenCalledTimes(1)

    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(callback).toHaveBeenCalledTimes(2)
    expect(getConnectionSnapshot().failing).toBe(false)
  })

  it('ignores coming online when it is not backing off', async () => {
    const callback = vi.fn().mockResolvedValue({})

    renderHook(() => usePolling(callback, 1000, true))
    await vi.advanceTimersByTimeAsync(100)
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('reports nothing for a poll that settles after unmount', async () => {
    let reject
    const callback = vi.fn(() => new Promise((_, r) => { reject = r }))

    const { unmount } = renderHook(() => usePolling(callback, 1000, true))
    unmount()
    reject(networkError)
    await vi.advanceTimersByTimeAsync(0)
    expect(getConnectionSnapshot().failing).toBe(false)
  })
})
