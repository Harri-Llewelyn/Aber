import React from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError } from '@supabase/supabase-js'
import App from '../App'

const mockSession = {
  user: {
    id: 'user-admin-123',
    email: 'admin@aber.local',
    app_metadata: { role: 'Administrator' }
  }
}

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(),
      // getSession() only reads localStorage; App validates it with getUser().
      getUser: vi.fn(),
      onAuthStateChange: vi.fn(),
      signInWithPassword: vi.fn(),
      signUp: vi.fn(),
      signOut: vi.fn()
    },
    channel: vi.fn().mockReturnValue({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnThis()
    }),
    removeChannel: vi.fn(),
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: [], error: null })
    })
  }
}))

import { supabase } from '../lib/supabaseClient'

describe('App Component', () => {
  let authCallback

  beforeEach(() => {
    vi.clearAllMocks()
    window.history.pushState({}, '', '/')
    supabase.auth.getSession.mockResolvedValue({ data: { session: null } })
    supabase.auth.getUser.mockResolvedValue({ data: { user: mockSession.user }, error: null })
    supabase.auth.signOut.mockResolvedValue({ error: null })
    supabase.auth.onAuthStateChange.mockImplementation((cb) => {
      authCallback = cb
      return { data: { subscription: { unsubscribe: vi.fn() } } }
    })
  })

  afterEach(() => vi.restoreAllMocks())

  it('renders Supabase authentication screen when no session is active', async () => {
    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('Sign In')).toBeInTheDocument()
    })

    expect(screen.getByText('Sign in to Aber')).toBeInTheDocument()
    expect(screen.getByText('Email Address')).toBeInTheDocument()
  })

  it('renders application topbar and header title correctly when authenticated', async () => {
    supabase.auth.getSession.mockResolvedValue({ data: { session: mockSession } })

    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('Aber')).toBeInTheDocument()
    })

    expect(screen.getByText('The shopfloor data platform')).toBeInTheDocument()
    // The account control is an icon button with no text, so its `title` is both the hover text and
    // its accessible name; the address is asserted on the attribute.
    expect(screen.getByRole('button', { name: /account menu/i })).toHaveAttribute(
      'title', expect.stringContaining('admin@aber.local')
    )
  })

  it('returns to the login screen when the stored session no longer exists on the server', async () => {
    // The browser holds a signature-valid JWT but auth.sessions was wiped. PostgREST would still
    // serve reads, so without the getUser() check the dashboard renders as signed in and only Edge
    // Functions fail.
    supabase.auth.getSession.mockResolvedValue({ data: { session: mockSession } })
    supabase.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: { status: 403, message: 'Session from session_id claim in JWT does not exist' }
    })

    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('Sign in to Aber')).toBeInTheDocument()
    })

    expect(screen.getByText(/session is no longer valid/i)).toBeInTheDocument()
    // Stale tokens are dropped locally; the server-side session is already gone.
    expect(supabase.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(screen.queryByText('Aber')).not.toBeInTheDocument()
  })

  it('shows sign-in with the notice when auth-js drops a session the server has ended, reading nothing on it', async () => {
    // GoTrue answers 403 session_not_found; auth-js turns that into an AuthSessionMissingError with
    // status 400, deletes the stored session (SIGNED_OUT) and only then returns.
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    supabase.auth.getSession.mockResolvedValue({ data: { session: mockSession } })
    let answer
    supabase.auth.getUser.mockImplementation(() => new Promise(resolve => { answer = resolve }))

    render(<App />)
    await waitFor(() => expect(supabase.auth.getUser).toHaveBeenCalled())
    // What supabase-js announces for the stored session before the auth server has checked it.
    act(() => {
      authCallback('INITIAL_SESSION', mockSession)
      authCallback('SIGNED_IN', mockSession)
    })
    expect(screen.getByText(/Connecting to Supabase Auth/)).toBeInTheDocument()

    await act(async () => {
      supabase.auth.getSession.mockResolvedValue({ data: { session: null } })
      authCallback('SIGNED_OUT', null)
      answer({ data: { user: null }, error: new AuthSessionMissingError() })
    })

    expect(await screen.findByText(/session is no longer valid on the server/i)).toBeInTheDocument()
    expect(screen.getByText('Sign in to Aber')).toBeInTheDocument()
    expect(screen.queryByText('Aber')).not.toBeInTheDocument()
    // The dashboard never mounted, so nothing read or subscribed on the dead token.
    expect(supabase.from).not.toHaveBeenCalled()
    expect(supabase.channel).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('never puts back a session supabase-js has dropped, whatever auth-js calls the error', async () => {
    supabase.auth.getSession
      .mockResolvedValueOnce({ data: { session: mockSession } })
      .mockResolvedValue({ data: { session: null } })
    supabase.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: new AuthApiError('A name this release has not seen', 400, 'some_new_code')
    })

    render(<App />)

    expect(await screen.findByText(/session is no longer valid on the server/i)).toBeInTheDocument()
    expect(screen.queryByText('Aber')).not.toBeInTheDocument()
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it.each([
    ['a network error', new AuthRetryableFetchError('Failed to fetch', 0)],
    ['a 503 from the gateway', new AuthRetryableFetchError('no healthy upstream', 503)]
  ])('stays signed in on the stored session when the auth server is unreachable (%s)', async (_, error) => {
    // supabase-js keeps the session through a retryable failure, so the page opens on it and the
    // connection strip, not the sign-in screen, says whether it is updating.
    supabase.auth.getSession.mockResolvedValue({ data: { session: mockSession } })
    supabase.auth.getUser.mockResolvedValue({ data: { user: null }, error })

    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('Aber')).toBeInTheDocument()
    })
    expect(supabase.auth.signOut).not.toHaveBeenCalled()
    expect(screen.queryByText(/session is no longer valid/i)).not.toBeInTheDocument()
  })

  it('ends a session another tab signs out once the stored one is restored', async () => {
    supabase.auth.getSession.mockResolvedValue({ data: { session: mockSession } })

    render(<App />)
    await waitFor(() => expect(screen.getByText('Aber')).toBeInTheDocument())

    act(() => authCallback('SIGNED_OUT', null))
    expect(await screen.findByText('Sign in to Aber')).toBeInTheDocument()
  })

  it('navigates between navigation tabs when clicked', async () => {
    supabase.auth.getSession.mockResolvedValue({ data: { session: mockSession } })

    render(<App />)

    await waitFor(() => {
      expect(screen.getAllByText('Site Map').length).toBeGreaterThan(0)
    })

    const devicesTab = screen.getByText('Devices')
    fireEvent.click(devicesTab)

    await waitFor(() => {
      expect(window.location.pathname).toBe('/devices')
    })
  })

  describe('when the auth server does not answer', () => {
    // Only the timer restoreSession races getUser() against is faked; the page's own intervals and
    // React's scheduling keep running.
    beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) })
    afterEach(() => { vi.useRealTimers() })

    const advance = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

    it('opens on the stored session after ten seconds, with no notice', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      supabase.auth.getSession.mockResolvedValue({ data: { session: mockSession } })
      supabase.auth.getUser.mockImplementation(() => new Promise(() => {}))

      render(<App />)
      await advance(9900)
      expect(screen.getByText(/Connecting to Supabase Auth/)).toBeInTheDocument()

      await advance(100)
      expect(screen.getByText('Aber')).toBeInTheDocument()
      expect(screen.queryByText(/session is no longer valid/i)).not.toBeInTheDocument()
      expect(supabase.auth.signOut).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledWith(
        '[auth] the auth server did not answer within 10 s; opening on the stored session'
      )
    })

    it('still honours a refusal that arrives after the dashboard opened, with the notice', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      supabase.auth.getSession.mockResolvedValue({ data: { session: mockSession } })
      let answer
      supabase.auth.getUser.mockImplementation(() => new Promise(resolve => { answer = resolve }))

      render(<App />)
      await advance(10000)
      expect(screen.getByText('Aber')).toBeInTheDocument()

      // At 12 s auth-js gets GoTrue's session_not_found: it drops the session, then returns.
      await advance(2000)
      await act(async () => {
        supabase.auth.getSession.mockResolvedValue({ data: { session: null } })
        authCallback('SIGNED_OUT', null)
        answer({ data: { user: null }, error: new AuthSessionMissingError() })
      })
      await advance(0)

      expect(screen.getByText('Sign in to Aber')).toBeInTheDocument()
      expect(screen.getByText(/session is no longer valid on the server/i)).toBeInTheDocument()
      expect(supabase.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
    })
  })
})
