import { renderHook, waitFor, act } from '@testing-library/react'
import { vi } from 'vitest'

// Captured per test so assertions can drive the subscribe callback and the change handlers.
let channels = []
let session = { access_token: 'token' }

const makeChannel = (topic) => {
  const channel = {
    topic,
    bindings: [],
    subscribeCallback: null,
    on(_event, filter, handler) {
      this.bindings.push({ filter, handler })
      return this
    },
    subscribe(cb) {
      this.subscribeCallback = cb
      return this
    },
    /** Drive every binding as if Postgres had emitted a change. */
    emit(payload = {}) {
      this.bindings.forEach(b => b.handler(payload))
    },
  }
  channels.push(channel)
  return channel
}

const removeChannel = vi.fn()

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    channel: (topic) => makeChannel(topic),
    removeChannel: (...args) => removeChannel(...args),
    auth: { getSession: () => Promise.resolve({ data: { session } }) },
  },
}))

const { useRealtimeTable } = await import('../hooks/useRealtimeTable')

describe('useRealtimeTable hook', () => {
  beforeEach(() => {
    channels = []
    session = { access_token: 'token' }
    removeChannel.mockClear()
    vi.useRealTimers()
  })

  it('opens no channel when disabled', async () => {
    renderHook(() => useRealtimeTable('devices', vi.fn(), { enabled: false }))
    await new Promise(r => setTimeout(r, 20))
    expect(channels).toHaveLength(0)
  })

  // The security property: an unauthenticated socket still receives the event
  // envelope (redacted payload plus a 401 error), so it must never be opened pre-login.
  it('opens no channel when there is no session', async () => {
    session = null
    renderHook(() => useRealtimeTable('devices', vi.fn()))
    await new Promise(r => setTimeout(r, 20))
    expect(channels).toHaveLength(0)
  })

  it('binds one handler per table on a single channel', async () => {
    renderHook(() => useRealtimeTable(['devices', 'gateways', 'cells'], vi.fn()))
    await waitFor(() => expect(channels).toHaveLength(1))
    expect(channels[0].bindings.map(b => b.filter.table)).toEqual(['devices', 'gateways', 'cells'])
    expect(channels[0].bindings.every(b => b.filter.schema === 'public')).toBe(true)
  })

  // Closes the lazy-replication-slot window: the client can be SUBSCRIBED
  // while the slot does not yet exist, so changes in that gap are never delivered.
  it('reconciles once on SUBSCRIBED', async () => {
    const onChange = vi.fn()
    renderHook(() => useRealtimeTable('devices', onChange))
    await waitFor(() => expect(channels).toHaveLength(1))
    expect(onChange).not.toHaveBeenCalled()

    await act(async () => { channels[0].subscribeCallback('SUBSCRIBED') })
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('coalesces a burst of changes into a single reload', async () => {
    const onChange = vi.fn()
    renderHook(() => useRealtimeTable('devices', onChange, { debounceMs: 30 }))
    await waitFor(() => expect(channels).toHaveLength(1))

    await act(async () => {
      channels[0].emit()
      channels[0].emit()
      channels[0].emit()
      await new Promise(r => setTimeout(r, 80))
    })
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('removes the channel on unmount', async () => {
    const { unmount } = renderHook(() => useRealtimeTable('devices', vi.fn()))
    await waitFor(() => expect(channels).toHaveLength(1))
    unmount()
    expect(removeChannel).toHaveBeenCalledWith(channels[0])
  })

  // A literal array prop changes identity every render; keying the effect on contents is what
  // stops the channel being torn down and rebuilt on each one.
  it('does not rebuild the channel when the table array is re-created', async () => {
    const { rerender } = renderHook(({ t }) => useRealtimeTable(t, vi.fn()), {
      initialProps: { t: ['devices', 'gateways'] },
    })
    await waitFor(() => expect(channels).toHaveLength(1))
    rerender({ t: ['devices', 'gateways'] })
    await new Promise(r => setTimeout(r, 20))
    expect(channels).toHaveLength(1)
    expect(removeChannel).not.toHaveBeenCalled()
  })
})
