import React from 'react'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import App from '../App'
import { documentTitle, APP_TITLE } from '../hooks/useDocumentTitle'

/**
 * The browser tab's title names the current page and leads with the alert pill's count. The count
 * must follow the pill, and must not outlive the session that could read it.
 */

const mockSession = {
  user: { id: 'user-admin-123', email: 'admin@aber.local', app_metadata: { role: 'Administrator' } }
}

const firing = [
  { id: 1, fingerprint: 'fp-1', entity_type: 'device', sparkplug_id: 'dev1', alert_name: 'Thermal Excursion', severity: 'critical', summary: '', starts_at: '2026-09-23T09:00:00Z' },
  { id: 2, fingerprint: 'fp-2', entity_type: 'gateway', sparkplug_id: 'gw1', alert_name: 'Gateway Offline', severity: 'warning', summary: '', starts_at: '2026-09-23T09:01:00Z' }
]

let alertRows = []

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(),
      getUser: vi.fn(),
      onAuthStateChange: vi.fn(),
      signInWithPassword: vi.fn(),
      signOut: vi.fn()
    },
    channel: vi.fn().mockReturnValue({ on: vi.fn().mockReturnThis(), subscribe: vi.fn().mockReturnThis() }),
    removeChannel: vi.fn(),
    from: vi.fn()
  }
}))

import { supabase } from '../lib/supabaseClient'

describe('documentTitle', () => {
  it('names the page after the product', () => {
    expect(documentTitle('Gateways')).toBe('Aber | Gateways')
  })

  it('leads with the count only while something is firing', () => {
    expect(documentTitle('Gateways', 0)).toBe('Aber | Gateways')
    expect(documentTitle('Gateways', 3)).toBe('(3) Aber | Gateways')
  })

  it('falls back to the bare product name when there is no page', () => {
    expect(documentTitle(undefined)).toBe(APP_TITLE)
    expect(documentTitle(undefined, 2)).toBe('(2) Aber')
  })
})

describe('the tab title in the app', () => {
  let authCallback

  beforeEach(() => {
    vi.clearAllMocks()
    alertRows = []
    document.title = APP_TITLE
    window.history.pushState({}, '', '/')
    supabase.auth.getSession.mockResolvedValue({ data: { session: mockSession } })
    supabase.auth.getUser.mockResolvedValue({ data: { user: mockSession.user }, error: null })
    supabase.auth.signOut.mockResolvedValue({ error: null })
    supabase.auth.onAuthStateChange.mockImplementation((cb) => {
      authCallback = cb
      return { data: { subscription: { unsubscribe: vi.fn() } } }
    })
    supabase.from.mockImplementation((table) => {
      const rows = table === 'platform_alerts_active' ? alertRows : []
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockImplementation(() => Promise.resolve({ data: rows, error: null }))
      }
    })
  })

  it('names the page the URL opened on', async () => {
    window.history.pushState({}, '', '/gateways')
    render(<App />)
    await waitFor(() => expect(document.title).toBe('Aber | Gateways'))
  })

  it('follows a click in the rail, using the rail label', async () => {
    render(<App />)
    await waitFor(() => expect(document.title).toBe('Aber | Site Map'))
    fireEvent.click(screen.getByRole('button', { name: /^Devices$/ }))
    await waitFor(() => expect(document.title).toBe('Aber | Devices'))
  })

  it('carries the same count as the alert pill', async () => {
    alertRows = firing
    render(<App />)
    await waitFor(() => expect(document.title).toBe('(2) Aber | Site Map'))
    expect(screen.getByRole('button', { name: '2 firing alerts' })).toBeInTheDocument()
  })

  it('drops the page and the count on sign-out', async () => {
    alertRows = firing
    render(<App />)
    await waitFor(() => expect(document.title).toBe('(2) Aber | Site Map'))
    act(() => authCallback('SIGNED_OUT', null))
    await waitFor(() => expect(document.title).toBe('Aber | Sign in'))
  })

  it('names the sign-in screen when there is no session', async () => {
    supabase.auth.getSession.mockResolvedValue({ data: { session: null } })
    render(<App />)
    await waitFor(() => expect(document.title).toBe('Aber | Sign in'))
    fireEvent.click(screen.getByRole('button', { name: /forgot your password/i }))
    expect(document.title).toBe('Aber | Reset password')
  })
})
