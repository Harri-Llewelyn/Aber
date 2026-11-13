import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * The alert reconciler stays quiet about a rejected session, which the strip under the top bar
 * reports with Sign In Again, and still warns about anything else.
 */

let outcome
let reads

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: { getSession: () => Promise.resolve({ data: { session: { access_token: 't' } } }) },
    from: () => ({
      select: () => ({ order: () => { reads += 1; return Promise.resolve(outcome) } })
    }),
    channel: () => ({ on() { return this }, subscribe() { return this } }),
    removeChannel: () => {}
  }
}))

const { usePlatformAlerts } = await import('../hooks/usePlatformAlerts')

describe('usePlatformAlerts on a failed read', () => {
  let warn

  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { vi.restoreAllMocks() })

  const refreshWith = async (error) => {
    outcome = { data: null, error }
    reads = 0
    renderHook(() => usePlatformAlerts(vi.fn()))
    await waitFor(() => expect(reads).toBeGreaterThan(0))
    // Let the read's answer be handled before asserting on what it logged.
    await act(async () => {})
  }

  it.each([
    ['an expired token', { code: 'PGRST303', message: 'JWT expired' }],
    ['an undecodable token', { code: 'PGRST301', message: 'JWSError JWSInvalidSignature' }],
    ['a 401 with its status', { status: 401, message: 'Unauthorized' }]
  ])('does not warn about %s', async (_label, error) => {
    await refreshWith(error)
    expect(warn).not.toHaveBeenCalled()
  })

  it('still warns when the read fails for another reason', async () => {
    await refreshWith({ message: 'TypeError: Failed to fetch', code: '' })
    expect(warn).toHaveBeenCalledWith('[alerts] refresh failed:', 'TypeError: Failed to fetch')
  })
})
