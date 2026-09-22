import React from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import App from '../App'
import { supabase } from '../lib/supabaseClient'

const session = {
  user: { id: 'user-1', email: 'someone@example.com', app_metadata: { role: 'Operator' } }
}

let authListener = null

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(),
      getUser: vi.fn(),
      onAuthStateChange: vi.fn(),
      signInWithPassword: vi.fn(),
      resetPasswordForEmail: vi.fn(),
      updateUser: vi.fn(),
      signOut: vi.fn()
    },
    channel: vi.fn().mockReturnValue({ on: vi.fn().mockReturnThis(), subscribe: vi.fn().mockReturnThis() }),
    removeChannel: vi.fn(),
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: [], error: null })
    })
  }
}))

beforeEach(() => {
  vi.clearAllMocks()
  authListener = null
  window.history.pushState({}, '', '/')
  supabase.auth.getSession.mockResolvedValue({ data: { session: null } })
  supabase.auth.getUser.mockResolvedValue({ data: { user: session.user }, error: null })
  supabase.auth.onAuthStateChange.mockImplementation((cb) => {
    authListener = cb
    return { data: { subscription: { unsubscribe: vi.fn() } } }
  })
})

/** What supabase-js does after exchanging a recovery link's token for a session. */
const arriveFromResetLink = async () => {
  render(<App />)
  await screen.findByText('Sign In')
  await act(async () => { authListener('PASSWORD_RECOVERY', session) })
}

describe('arriving from a password-reset link', () => {
  it('asks for a new password instead of opening the dashboard', async () => {
    await arriveFromResetLink()
    expect(await screen.findByText('Choose a new password')).toBeInTheDocument()
    expect(screen.getByText('for someone@example.com')).toBeInTheDocument()
    expect(screen.queryByText('Aber')).toBeNull()
  })

  it('refuses two passwords that differ, without calling the server', async () => {
    await arriveFromResetLink()
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'correct-horse' } })
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'correct-h0rse' } })
    fireEvent.click(screen.getByText('Set password and continue'))

    expect(await screen.findByRole('alert')).toHaveTextContent('do not match')
    expect(supabase.auth.updateUser).not.toHaveBeenCalled()
  })

  it('sets the password and continues into the dashboard on the same session', async () => {
    supabase.auth.updateUser.mockResolvedValue({ data: { user: session.user }, error: null })
    await arriveFromResetLink()
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'correct-horse' } })
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'correct-horse' } })
    fireEvent.click(screen.getByText('Set password and continue'))

    await waitFor(() => expect(supabase.auth.updateUser).toHaveBeenCalledWith({ password: 'correct-horse' }))
    expect(await screen.findByText('Aber')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/site-map')
  })

  it('shows the server refusal and clears both fields', async () => {
    supabase.auth.updateUser.mockResolvedValue({ data: null, error: new Error('Password should be at least 6 characters') })
    await arriveFromResetLink()
    const first = screen.getByLabelText('New password')
    fireEvent.change(first, { target: { value: 'abcdef' } })
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'abcdef' } })
    fireEvent.click(screen.getByText('Set password and continue'))

    expect(await screen.findByRole('alert')).toHaveTextContent('at least 6 characters')
    expect(first).toHaveValue('')
  })
})

describe('a spent or expired reset link', () => {
  it('sends the user back to sign in with an explanation', async () => {
    // The reset URL with no token to exchange: no session arrives, and no recovery event fires.
    window.history.pushState({}, '', '/reset-password')
    render(<App />)
    expect(await screen.findByText('Sign In')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(/expired or was already used/i)
  })
})
