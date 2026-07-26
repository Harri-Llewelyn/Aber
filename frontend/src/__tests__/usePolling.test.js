import { renderHook } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { usePolling } from '../hooks/usePolling'

describe('usePolling hook', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('executes poll callback on interval when enabled', async () => {
    const callback = vi.fn().mockResolvedValue({})
    renderHook(() => usePolling(callback, 1000, true))

    expect(callback).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1000)
    expect(callback).toHaveBeenCalledTimes(2)
  })

  it('halts polling immediately on 401 error', async () => {
    const err401 = new Error('Unauthorized')
    err401.status = 401
    const callback = vi.fn().mockRejectedValue(err401)

    renderHook(() => usePolling(callback, 1000, true))
    expect(callback).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(5000)
    // Polling loop stopped, no additional calls
    expect(callback).toHaveBeenCalledTimes(1)
  })
})
