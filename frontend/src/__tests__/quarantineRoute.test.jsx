import React from 'react'
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import App from '../App'
import { api } from '../api'

/**
 * Routes into the Devices page's Quarantine tab, through App: the rail's quarantine signal and the
 * search's Quarantine entry both open that tab, and a plain visit opens Registered.
 */

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(),
      getUser: vi.fn(),
      onAuthStateChange: vi.fn(),
      signInWithPassword: vi.fn(),
      signUp: vi.fn(),
      signOut: vi.fn()
    },
    channel: vi.fn().mockReturnValue({ on: vi.fn().mockReturnThis(), subscribe: vi.fn().mockReturnThis() }),
    removeChannel: vi.fn(),
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: [], error: null })
    }),
    functions: { invoke: vi.fn() }
  }
}))

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { ...actual.api, get: vi.fn() } }
})

import { supabase } from '../lib/supabaseClient'

// The JWT role; with no role_permissions rows the built-in map applies, which grants quarantine.
const session = { user: { id: 'user-admin-123', email: 'admin@aber.local', app_metadata: { role: 'Administrator' } } }

const HELD = {
  asset_id: 'cccccccc-0000-4000-8000-000000000003', asset_name: 'Unknown_Robot', is_quarantined: true,
  is_archived: false, status: 'ONLINE', active_gateway_id: 'gw-1'
}
const QUEUED = {
  quarantine_id: 'qtn-1', asset_id: HELD.asset_id, asset_name: 'Unknown_Robot',
  reported_identity: 'devffffffffffffffffffff1', quarantine_reason: 'UNKNOWN_DEVICE', gateway_id: 'gw-1',
  discovered_at: new Date().toISOString()
}

const serve = (held) => (path) => {
  if (path.startsWith('/api/v1/devices')) return Promise.resolve(held ? [HELD] : [])
  if (path.startsWith('/api/v1/quarantine')) return Promise.resolve(held ? [QUEUED] : [])
  return Promise.resolve([])
}

const railItem = () => within(document.querySelector('.sidebar')).getByRole('button', { name: /^Devices/ })
const selectedTab = () => screen.getByRole('tab', { selected: true })

const renderApp = async (held) => {
  api.get.mockImplementation(serve(held))
  render(<App />)
  await waitFor(() => expect(screen.getByText('Aber')).toBeInTheDocument())
}

beforeEach(() => {
  vi.clearAllMocks()
  window.history.pushState({}, '', '/')
  supabase.auth.getSession.mockResolvedValue({ data: { session } })
  supabase.auth.getUser.mockResolvedValue({ data: { user: session.user }, error: null })
  supabase.auth.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } })
})

describe('the routes into the Quarantine tab', () => {
  it('opens Quarantine from the rail while the rail flags a waiting device, every time', async () => {
    await renderApp(true)
    await waitFor(() => expect(railItem()).toHaveAccessibleName(/awaiting/))

    fireEvent.click(railItem())
    // The first visit loads the lazy page.
    await waitFor(() => expect(selectedTab()).toHaveAccessibleName('Quarantine, 1 waiting'), { timeout: 5000 })

    fireEvent.click(screen.getByRole('tab', { name: 'Registered' }))
    fireEvent.click(railItem())
    await waitFor(() => expect(selectedTab()).toHaveAccessibleName('Quarantine, 1 waiting'))
  })

  it('opens Registered from the rail when nothing is waiting', async () => {
    await renderApp(false)
    fireEvent.click(railItem())
    await waitFor(() => expect(selectedTab()).toHaveAccessibleName('Registered'))
  })

  it('opens Quarantine from the search', async () => {
    await renderApp(false)
    const search = screen.getByRole('combobox', { name: /search/i })
    fireEvent.focus(search)
    fireEvent.change(search, { target: { value: 'quarantine' } })
    fireEvent.click(await screen.findByRole('option', { name: /^Quarantine/ }))
    await waitFor(() => expect(selectedTab()).toHaveAccessibleName('Quarantine'))
    expect(window.location.pathname).toBe('/devices')
  })
})
