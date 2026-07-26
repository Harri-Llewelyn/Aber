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
      expect(screen.getByText('Factory+ Asset Tracking Platform')).toBeInTheDocument()
    })

    expect(screen.getByText('Supabase BaaS + Standalone TimescaleDB Architecture')).toBeInTheDocument()
    expect(screen.getByText('admin@factoryplus.local')).toBeInTheDocument()
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
