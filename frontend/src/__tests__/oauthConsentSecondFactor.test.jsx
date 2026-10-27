/**
 * The OAuth consent page and a second factor. Grafana, Node-RED, Studio and the forge sign in
 * through the dashboard's session, so a session that still owes its code gives it here before
 * the authorization request is even read; once GoTrue accepts it, the request is read with the
 * aal2 session. A session that owes nothing goes straight on, as before.
 */
import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OAuthConsent } from '../pages/OAuthConsent'
import { supabase } from '../lib/supabaseClient'

vi.mock('../lib/supabaseClient', () => ({
  SUPABASE_URL: 'https://api.site.test',
  SUPABASE_GATEWAY_KEY: 'sb_publishable_test',
  supabase: {
    auth: {
      getSession: vi.fn(),
      signOut: vi.fn(),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn(),
        listFactors: vi.fn(),
        challengeAndVerify: vi.fn(),
      },
    },
    rpc: vi.fn(),
  },
}))

vi.mock('../utils/studioSignOut', () => ({
  signOutOfStudio: vi.fn(() => Promise.resolve(true)),
  signOutOfForge: vi.fn(() => Promise.resolve(true))
}))

const PHONE = { id: 'f-phone', friendly_name: 'Work phone', factor_type: 'totp', status: 'verified' }
const DETAILS = { client: { name: 'Aber Grafana' }, user: { email: 'operator@site.test' }, scope: 'openid email' }
const level = (currentLevel, nextLevel) =>
  ({ data: { currentLevel, nextLevel, currentAuthenticationMethods: [{ method: 'password' }] }, error: null })

let fetchSpy

beforeEach(() => {
  vi.clearAllMocks()
  window.history.pushState({}, '', '/oauth/consent?authorization_id=auth-123')
  supabase.auth.getSession.mockResolvedValue({ data: { session: { access_token: 'aal1-token', user: { id: 'u1' } } } })
  supabase.auth.signOut.mockResolvedValue({ error: null })
  supabase.auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue(level('aal1', 'aal2'))
  supabase.auth.mfa.listFactors.mockResolvedValue({ data: { all: [PHONE], totp: [PHONE] }, error: null })
  supabase.auth.mfa.challengeAndVerify.mockResolvedValue({ data: { access_token: 'aal2-token' }, error: null })
  supabase.rpc.mockReturnValue({ abortSignal: vi.fn().mockResolvedValue({ data: 0, error: null }) })
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify(DETAILS), { status: 200, headers: { 'Content-Type': 'application/json' } }))
})

afterEach(() => {
  fetchSpy.mockRestore()
  window.history.pushState({}, '', '/')
})

describe('consent with a second factor', () => {
  it('asks for the code before reading the request, then reads it with the new session', async () => {
    render(<OAuthConsent />)
    expect(await screen.findByRole('heading', { name: 'Enter your code' })).toBeInTheDocument()
    expect(fetchSpy).not.toHaveBeenCalled()

    fireEvent.change(await screen.findByLabelText('Code'), { target: { value: '123456' } })
    supabase.auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue(level('aal2', 'aal2'))
    supabase.auth.getSession.mockResolvedValue({ data: { session: { access_token: 'aal2-token', user: { id: 'u1' } } } })
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }))

    expect(await screen.findByRole('heading', { name: 'Authorize Aber Grafana' })).toBeInTheDocument()
    expect(supabase.auth.mfa.challengeAndVerify).toHaveBeenCalledWith({ factorId: 'f-phone', code: '123456' })
    expect(fetchSpy).toHaveBeenCalledWith('https://api.site.test/auth/v1/oauth/authorizations/auth-123',
      { headers: { Authorization: 'Bearer aal2-token' } })
  })

  it('goes straight to the request for a session that owes no code', async () => {
    supabase.auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue(level('aal1', 'aal1'))
    render(<OAuthConsent />)
    expect(await screen.findByRole('heading', { name: 'Authorize Aber Grafana' })).toBeInTheDocument()
    expect(supabase.auth.mfa.listFactors).not.toHaveBeenCalled()
  })

  it('offers Sign Out, after which it asks for a sign-in', async () => {
    render(<OAuthConsent />)
    await screen.findByLabelText('Code')
    fireEvent.click(screen.getByRole('button', { name: 'Sign Out' }))
    expect(await screen.findByRole('heading', { name: 'Sign in required' })).toBeInTheDocument()
    expect(supabase.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
  })
})
