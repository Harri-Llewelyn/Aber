import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * signOutOfThisBrowser(): the door sessions end before the dashboard's own session does, because
 * the API refuses a token whose session has gone (0205); and nothing about the door sessions can
 * stop or hold up the sign-out for longer than DOOR_SESSIONS_TIMEOUT_MS.
 */

const calls = []

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: { getSession: vi.fn(), signOut: vi.fn() },
    rpc: vi.fn()
  }
}))

vi.mock('../utils/studioSignOut', () => ({
  signOutOfStudio: vi.fn(() => { calls.push('studio beacon'); return Promise.resolve(true) }),
  signOutOfForge: vi.fn(() => { calls.push('forge beacon'); return Promise.resolve(true) })
}))

const { supabase } = await import('../lib/supabaseClient')
const { signOutOfThisBrowser, endDoorSessions, DOOR_SESSIONS_TIMEOUT_MS } = await import('../utils/signOut')

/** What supabase.rpc() returns: a builder whose abortSignal() is the awaited call. */
const rpcAnswering = (answer) => () => ({
  abortSignal: vi.fn((signal) => {
    calls.push('end_my_door_sessions')
    return typeof answer === 'function' ? answer(signal) : answer
  })
})

beforeEach(() => {
  calls.length = 0
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  supabase.auth.getSession.mockResolvedValue({ data: { session: { access_token: 'dashboard-token' } } })
  supabase.auth.signOut.mockImplementation(async () => { calls.push('signOut'); return { error: null } })
  supabase.rpc.mockImplementation(rpcAnswering(Promise.resolve({ data: 2, error: null })))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('signOutOfThisBrowser', () => {
  it('ends the door sessions, then this browser\'s dashboard session, and asks both doors to clear their cookies', async () => {
    await expect(signOutOfThisBrowser()).resolves.toEqual({ error: null })

    expect(supabase.rpc).toHaveBeenCalledWith('end_my_door_sessions')
    expect(supabase.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(calls.indexOf('end_my_door_sessions')).toBeLessThan(calls.indexOf('signOut'))
    expect(calls).toEqual(expect.arrayContaining(['studio beacon', 'forge beacon']))
  })

  it('signs out when the database refuses or fails, or the call throws', async () => {
    for (const answer of [
      Promise.resolve({ data: null, error: { message: 'permission denied', code: '42501' } }),
      Promise.reject(new TypeError('Failed to fetch')),
    ]) {
      answer.catch(() => {})
      supabase.rpc.mockImplementation(rpcAnswering(answer))
      supabase.auth.signOut.mockClear()
      await expect(signOutOfThisBrowser()).resolves.toEqual({ error: null })
      expect(supabase.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
    }
    supabase.rpc.mockImplementation(() => { throw new TypeError('rpc is not a function') })
    supabase.auth.signOut.mockClear()
    await signOutOfThisBrowser()
    expect(supabase.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
  })

  it('waits for the door sessions no longer than the bound, then signs out', async () => {
    vi.useFakeTimers()
    let aborted = false
    supabase.rpc.mockImplementation(rpcAnswering((signal) => new Promise(() => {
      signal.addEventListener('abort', () => { aborted = true })
    })))

    const settled = signOutOfThisBrowser()
    await vi.advanceTimersByTimeAsync(DOOR_SESSIONS_TIMEOUT_MS - 1)
    expect(supabase.auth.signOut).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(settled).resolves.toEqual({ error: null })
    expect(supabase.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(aborted).toBe(true)
  })

  it('skips the door sessions when no session is stored, and still clears the doors and signs out', async () => {
    supabase.auth.getSession.mockResolvedValue({ data: { session: null } })
    await signOutOfThisBrowser()

    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(supabase.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(calls).toEqual(expect.arrayContaining(['studio beacon', 'forge beacon']))
  })

  it("returns the dashboard sign-out's own error", async () => {
    const unreachable = { name: 'AuthRetryableFetchError', message: 'Failed to fetch' }
    supabase.auth.signOut.mockResolvedValue({ error: unreachable })
    await expect(signOutOfThisBrowser()).resolves.toEqual({ error: unreachable })
  })
})

describe('endDoorSessions', () => {
  it('answers whether the database ended them, and never rejects', async () => {
    await expect(endDoorSessions()).resolves.toBe(true)
    supabase.rpc.mockImplementation(rpcAnswering(Promise.resolve({ data: null, error: { message: 'no' } })))
    await expect(endDoorSessions()).resolves.toBe(false)
    supabase.auth.getSession.mockRejectedValue(new Error('storage unavailable'))
    await expect(endDoorSessions()).resolves.toBe(false)
  })
})
