/**
 * Settings is in every role's rail and opens for every role, read-only for anyone but an
 * Administrator. The page itself is stubbed: what is under test is App's wiring of the role to it,
 * which the page's own tests cannot see.
 */
import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import App from '../App'

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(),
      getUser: vi.fn(),
      onAuthStateChange: vi.fn(),
      signInWithPassword: vi.fn(),
      signOut: vi.fn(),
    },
    channel: vi.fn().mockReturnValue({ on: vi.fn().mockReturnThis(), subscribe: vi.fn().mockReturnThis() }),
    removeChannel: vi.fn(),
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    }),
  },
}))

vi.mock('../components/tabs/SettingsTab', () => ({
  SettingsTab: ({ readOnly }) => <div data-testid="settings-page" data-read-only={String(readOnly)} />,
}))

import { supabase } from '../lib/supabaseClient'

function signInAs(role) {
  const user = { id: `user-${role}`, email: `${role.toLowerCase()}@site.test`, app_metadata: { role } }
  const session = { access_token: 'token', user }
  supabase.auth.getSession.mockResolvedValue({ data: { session } })
  supabase.auth.getUser.mockResolvedValue({ data: { user }, error: null })
  supabase.auth.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  window.history.pushState({}, '', '/settings')
})

describe('the Settings page', () => {
  it.each(['Operator', 'Auditor', 'Shopfloor_Manager'])('opens read-only for a %s, from the rail', async (role) => {
    signInAs(role)
    render(<App />)
    const page = await screen.findByTestId('settings-page')
    expect(page).toHaveAttribute('data-read-only', 'true')
    const rail = within(document.querySelector('.sidebar')).getByRole('navigation', { name: /primary/i })
    expect(within(rail).getByRole('button', { name: 'Settings' })).toBeInTheDocument()
    // Not bounced to the Site Map once the role arrives: the page is theirs to read.
    await waitFor(() => expect(window.location.pathname).toBe('/settings'))
  })

  it('opens editable for an Administrator', async () => {
    signInAs('Administrator')
    render(<App />)
    expect(await screen.findByTestId('settings-page')).toHaveAttribute('data-read-only', 'false')
  })
})
