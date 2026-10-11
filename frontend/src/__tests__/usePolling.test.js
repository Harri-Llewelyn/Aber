import { renderHook } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { usePolling, ONLINE_RETRY_JITTER_MS } from '../hooks/usePolling'
import {
  CONNECTION_SESSION_ENDED,
  CONNECTION_STALE,
  STALE_AFTER_MS,
  getConnectionSnapshot,
  reportRealtimeStatus,
  resetConnectionState,
  watchBrowserConnectivity
} from '../lib/connectionState'
import { refreshInterval } from '../constants'

const networkError = { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' }

describe('usePolling hook', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetConnectionState()
  })

  afterEach(() => {
    resetConnectionState()
    vi.useRealTimers()
    vi.restoreAllMocks()
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

  it('polls within the jitter when the browser comes back online during a backoff', async () => {
    const callback = vi.fn().mockRejectedValueOnce(networkError).mockResolvedValue({})

    renderHook(() => usePolling(callback, 1000, true))
    await vi.advanceTimersByTimeAsync(100)
    expect(callback).toHaveBeenCalledTimes(1)

    // The backoff alone would wait until 1500 ms.
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(ONLINE_RETRY_JITTER_MS)
    expect(callback).toHaveBeenCalledTimes(2)
    expect(getConnectionSnapshot().failing).toBe(false)
  })

  // A short offline spell leaves no poll in a backoff, and with Realtime on the next turn is up to a
  // minute away. Coming back online must not wait for it.
  it('polls on coming back online with no poll in a backoff, and the success clears the strip', async () => {
    const stopWatching = watchBrowserConnectivity()
    const callback = vi.fn().mockResolvedValue({})
    renderHook(() => usePolling(callback, refreshInterval(true), true))
    await vi.advanceTimersByTimeAsync(5000)
    expect(callback).toHaveBeenCalledTimes(1)

    window.dispatchEvent(new Event('offline'))
    expect(getConnectionSnapshot().failing).toBe(true)
    await vi.advanceTimersByTimeAsync(STALE_AFTER_MS)
    expect(getConnectionSnapshot().status).toBe(CONNECTION_STALE)

    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(ONLINE_RETRY_JITTER_MS)
    expect(callback).toHaveBeenCalledTimes(2)
    expect(getConnectionSnapshot().failing).toBe(false)

    // Back on its own schedule afterwards: no extra poll before the interval.
    await vi.advanceTimersByTimeAsync(refreshInterval(true) - ONLINE_RETRY_JITTER_MS - 1)
    expect(callback).toHaveBeenCalledTimes(2)
    stopWatching()
  })

  it('spreads the polls over the jitter rather than firing them together', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.6)
    const callback = vi.fn().mockResolvedValue({})
    renderHook(() => usePolling(callback, refreshInterval(true), true))
    await vi.advanceTimersByTimeAsync(100)

    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(599)
    expect(callback).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(callback).toHaveBeenCalledTimes(2)
  })

  it('leaves a poll in flight to finish when the browser comes back online', async () => {
    let resolve
    const callback = vi.fn(() => new Promise((r) => { resolve = r }))
    renderHook(() => usePolling(callback, refreshInterval(true), true))
    expect(callback).toHaveBeenCalledTimes(1)

    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(ONLINE_RETRY_JITTER_MS)
    expect(callback).toHaveBeenCalledTimes(1)
    resolve({})
    await vi.advanceTimersByTimeAsync(0)
    expect(getConnectionSnapshot().failing).toBe(false)
  })

  // The steady state of a Realtime outage with REST up: the 60 s reconcile poll keeps working.
  it('keeps the strip away while Realtime is down and a 60-second poll keeps working', async () => {
    const callback = vi.fn().mockResolvedValue({})
    renderHook(() => usePolling(callback, refreshInterval(true), true))
    await vi.advanceTimersByTimeAsync(0)
    reportRealtimeStatus('CHANNEL_ERROR')

    for (let i = 0; i < 50; i++) {
      await vi.advanceTimersByTimeAsync(5000)
      if (i % 3 === 0) reportRealtimeStatus('TIMED_OUT')
      expect(getConnectionSnapshot().failing).toBe(false)
    }
    expect(callback.mock.calls.length).toBeGreaterThan(4)
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
