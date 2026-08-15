import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import App from '../App'

const mockSession = {
  user: {
    id: 'user-admin-123',
    email: 'admin@factoryplus.local',
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
  beforeEach(() => {
    vi.clearAllMocks()
    window.history.pushState({}, '', '/')
    supabase.auth.getSession.mockResolvedValue({ data: { session: null } })
    supabase.auth.getUser.mockResolvedValue({ data: { user: mockSession.user }, error: null })
    supabase.auth.signOut.mockResolvedValue({ error: null })
    supabase.auth.onAuthStateChange.mockReturnValue({
      data: { subscription: { unsubscribe: vi.fn() } }
    })
  })

  it('renders Supabase authentication screen when no session is active', async () => {
    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('Sign In')).toBeInTheDocument()
    })

    expect(screen.getByText('Factory+ Supabase Portal')).toBeInTheDocument()
    expect(screen.getByText('Email Address')).toBeInTheDocument()
  })

  it('renders application topbar and header title correctly when authenticated', async () => {
    supabase.auth.getSession.mockResolvedValue({ data: { session: mockSession } })

    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('AMRC Connectivity Stack - Cymru')).toBeInTheDocument()
    })

    expect(screen.getByText('Shopfloor to Digital Twin Pipeline')).toBeInTheDocument()
    // The address is behind the account pill now, which shows the local part and the role. It is
    // still on the pill's title, so it stays verifiable without opening anything.
    expect(screen.getByRole('button', { name: /admin/i })).toHaveAttribute(
      'title', expect.stringContaining('admin@factoryplus.local')
    )
  })

  it('returns to the login screen when the stored session no longer exists on the server', async () => {
    // The browser still holds a signature-valid JWT, but auth.sessions was wiped (e.g.
    // `docker compose down -v`). PostgREST would still serve reads, so without this
    // check the dashboard renders as if signed in and only Edge Functions fail.
    supabase.auth.getSession.mockResolvedValue({ data: { session: mockSession } })
    supabase.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: { status: 403, message: 'Session from session_id claim in JWT does not exist' }
    })

    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('Factory+ Supabase Portal')).toBeInTheDocument()
    })

    expect(screen.getByText(/session is no longer valid/i)).toBeInTheDocument()
    // Stale tokens are dropped locally; the server-side session is already gone.
    expect(supabase.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(screen.queryByText('AMRC Connectivity Stack - Cymru')).not.toBeInTheDocument()
  })

  it('stays signed in when the auth server is unreachable', async () => {
    supabase.auth.getSession.mockResolvedValue({ data: { session: mockSession } })
    supabase.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: { name: 'AuthRetryableFetchError', message: 'Failed to fetch' }
    })

    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('AMRC Connectivity Stack - Cymru')).toBeInTheDocument()
    })
    expect(supabase.auth.signOut).not.toHaveBeenCalled()
  })

  it('navigates between navigation tabs when clicked', async () => {
    supabase.auth.getSession.mockResolvedValue({ data: { session: mockSession } })

    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('Overview')).toBeInTheDocument()
    })

    const devicesTab = screen.getByText('Devices')
    fireEvent.click(devicesTab)

    await waitFor(() => {
      expect(window.location.pathname).toBe('/devices')
    })
  })
})
