/**
 * The sign-in challenge: a person with a second factor gives its code after their password, before
 * the dashboard opens. It is asked when getAuthenticatorAssuranceLevel() says the session is aal1
 * and the next level aal2, never for a federated sign-in (`amr`), and Sign Out stays offered.
 * GoTrue checks the code (challenge, then verify); its new aal2 session reaches App through
 * onAuthStateChange, and the dashboard opens.
 */
import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { supabase } from '../lib/supabaseClient'

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(),
      getUser: vi.fn(),
      onAuthStateChange: vi.fn(),
      signInWithPassword: vi.fn(),
      signOut: vi.fn(),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn(),
        listFactors: vi.fn(),
        challengeAndVerify: vi.fn(),
      },
    },
    rpc: vi.fn(),
    channel: vi.fn().mockReturnValue({ on: vi.fn().mockReturnThis(), subscribe: vi.fn().mockReturnThis() }),
    removeChannel: vi.fn(),
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: [], error: null })
    })
  }
}))

vi.mock('../utils/studioSignOut', () => ({
  signOutOfStudio: vi.fn(() => Promise.resolve(true)),
  signOutOfForge: vi.fn(() => Promise.resolve(true))
}))

const user = { id: 'user-op-123', email: 'operator@aber.local', app_metadata: { role: 'Operator' } }
const session = { access_token: 'aal1-token', user }
const PHONE = { id: 'f-phone', friendly_name: 'Work phone', factor_type: 'totp', status: 'verified' }
const TABLET = { id: 'f-tablet', friendly_name: 'Tablet', factor_type: 'totp', status: 'verified' }
const level = (currentLevel, nextLevel, method = 'password') =>
  ({ data: { currentLevel, nextLevel, currentAuthenticationMethods: [{ method, timestamp: 1 }] }, error: null })

let authCallback

beforeEach(() => {
  vi.clearAllMocks()
  window.history.pushState({}, '', '/')
  supabase.auth.getSession.mockResolvedValue({ data: { session } })
  supabase.auth.getUser.mockResolvedValue({ data: { user }, error: null })
  supabase.auth.signOut.mockResolvedValue({ error: null })
  supabase.auth.onAuthStateChange.mockImplementation((cb) => {
    authCallback = cb
    return { data: { subscription: { unsubscribe: vi.fn() } } }
  })
  supabase.auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue(level('aal1', 'aal2'))
  supabase.auth.mfa.listFactors.mockResolvedValue({ data: { all: [PHONE], totp: [PHONE] }, error: null })
  supabase.auth.mfa.challengeAndVerify.mockResolvedValue({ data: { access_token: 'aal2-token' }, error: null })
  supabase.rpc.mockReturnValue({ abortSignal: vi.fn().mockResolvedValue({ data: 0, error: null }) })
})

const dashboardOpen = () => screen.queryByText('The shopfloor data platform')

describe('the sign-in challenge', () => {
  it('asks for the code before the dashboard opens, then opens it once GoTrue accepts one', async () => {
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Enter your code' })).toBeInTheDocument()
    expect(dashboardOpen()).toBeNull()
    expect(document.title).toMatch(/Enter your code/)
    const code = await screen.findByLabelText('Code')
    expect(code).toHaveAttribute('autocomplete', 'one-time-code')
    expect(code).toHaveAttribute('inputmode', 'numeric')
    // One factor: nothing to choose.
    expect(screen.queryByLabelText('Authenticator')).toBeNull()

    fireEvent.change(code, { target: { value: '123 456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }))
    await waitFor(() => expect(supabase.auth.mfa.challengeAndVerify).toHaveBeenCalledWith({ factorId: 'f-phone', code: '123456' }))

    // GoTrue's aal2 session, as auth-js announces it.
    supabase.auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue(level('aal2', 'aal2', 'totp'))
    act(() => authCallback('MFA_CHALLENGE_VERIFIED', { ...session, access_token: 'aal2-token' }))
    await waitFor(() => expect(dashboardOpen()).toBeInTheDocument())
    expect(screen.queryByRole('heading', { name: 'Enter your code' })).toBeNull()
  })

  it('says a wrong code is wrong, clears it and stays', async () => {
    supabase.auth.mfa.challengeAndVerify.mockResolvedValue({
      data: null, error: { code: 'mfa_verification_failed', message: 'Invalid TOTP code entered', status: 422 },
    })
    render(<App />)
    const code = await screen.findByLabelText('Code')
    fireEvent.change(code, { target: { value: '000000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('That code is not right. Enter the code your app shows now.')
    expect(code).toHaveValue('')
    expect(dashboardOpen()).toBeNull()
  })

  it('lets a person with two choose which app the code is from', async () => {
    supabase.auth.mfa.listFactors.mockResolvedValue({ data: { all: [PHONE, TABLET], totp: [PHONE, TABLET] }, error: null })
    render(<App />)
    const choice = await screen.findByLabelText('Authenticator')
    fireEvent.change(choice, { target: { value: 'f-tablet' } })
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: '654321' } })
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }))
    await waitFor(() => expect(supabase.auth.mfa.challengeAndVerify).toHaveBeenCalledWith({ factorId: 'f-tablet', code: '654321' }))
  })

  it('offers Sign Out, which signs this browser out', async () => {
    render(<App />)
    await screen.findByLabelText('Code')
    fireEvent.click(screen.getByRole('button', { name: 'Sign Out' }))
    await waitFor(() => expect(supabase.auth.signOut).toHaveBeenCalledWith({ scope: 'local' }))
  })

  it('opens the dashboard for a session that gave its code, and for a person with no factor', async () => {
    for (const answer of [level('aal2', 'aal2', 'totp'), level('aal1', 'aal1')]) {
      supabase.auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue(answer)
      const view = render(<App />)
      await waitFor(() => expect(dashboardOpen()).toBeInTheDocument())
      expect(screen.queryByRole('heading', { name: 'Enter your code' })).toBeNull()
      expect(supabase.auth.mfa.listFactors).not.toHaveBeenCalled()
      view.unmount()
    }
  })

  it('never asks a federated sign-in twice', async () => {
    for (const method of ['oauth', 'sso/saml']) {
      supabase.auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue(level('aal1', 'aal2', method))
      const view = render(<App />)
      await waitFor(() => expect(dashboardOpen()).toBeInTheDocument())
      expect(screen.queryByRole('heading', { name: 'Enter your code' })).toBeNull()
      view.unmount()
    }
  })

  it('opens the dashboard rather than holding the person when the level cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    supabase.auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue({ data: null, error: { message: 'no session' } })
    render(<App />)
    await waitFor(() => expect(dashboardOpen()).toBeInTheDocument())
    expect(warn).toHaveBeenCalledWith('[mfa] could not read how this session signed in:', expect.any(String))
    warn.mockRestore()
  })

  it('tells someone whose factor was reset since they signed in to sign in again', async () => {
    supabase.auth.mfa.listFactors.mockResolvedValue({ data: { all: [], totp: [] }, error: null })
    render(<App />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Your account has no second factor now.')
    expect(screen.queryByLabelText('Code')).toBeNull()
    expect(screen.getByRole('button', { name: 'Sign Out' })).toBeInTheDocument()
  })

  it('asks before a password reset too, which GoTrue refuses from an aal1 session', async () => {
    window.history.pushState({}, '', '/reset-password')
    render(<App />)
    act(() => authCallback('PASSWORD_RECOVERY', session))
    expect(await screen.findByRole('heading', { name: 'Enter your code' })).toBeInTheDocument()
    expect(screen.queryByLabelText(/New password/)).toBeNull()
  })
})
