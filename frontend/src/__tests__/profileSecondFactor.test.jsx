/**
 * Profile > MFA. It lists the person's verified
 * authenticator apps. Add Authenticator names one, shows GoTrue's QR code and the secret as text,
 * then takes a code, which GoTrue checks before the factor counts; Cancel removes a half-made one.
 * Remove asks first with a button that repeats its name, and asks for a code when this session has
 * not given one (aal1), as GoTrue requires.
 */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProfileTab } from '../components/tabs/ProfileTab'
import { tabLink } from '../test/tabBar'

vi.mock('../lib/supabaseClient', () => ({
  SUPABASE_URL: 'https://api.site.test',
  SUPABASE_GATEWAY_KEY: 'sb_publishable_test',
  supabase: { auth: { getSession: vi.fn(() => new Promise(() => {})) } },
}))

vi.mock('../api', () => ({
  api: {
    listMySessions: vi.fn(),
    listMyFactors: vi.fn(),
    assuranceLevel: vi.fn(),
    startFactorEnrolment: vi.fn(),
    verifyFactorCode: vi.fn(),
    cancelFactorEnrolment: vi.fn(),
    removeFactor: vi.fn(),
  },
}))

import { api } from '../api'

const PHONE = { id: 'f-phone', friendly_name: 'Work phone', factor_type: 'totp', status: 'verified', created_at: '2026-10-20T09:15:00Z' }
const TABLET = { id: 'f-tablet', friendly_name: 'Tablet', factor_type: 'totp', status: 'verified', created_at: '2026-10-21T09:15:00Z' }
const HALF_MADE = { id: 'f-half', friendly_name: 'Authenticator app', factor_type: 'totp', status: 'unverified', created_at: '2026-10-22T09:15:00Z' }

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect style="fill:#000"/></svg>'
// A made-up key, 32 base32 characters as GoTrue's are.
const KEY = 'AAAABBBB'.repeat(4)
const ENROLMENT = {
  id: 'f-new', friendly_name: 'Authenticator app', qr_code: `data:image/svg+xml;utf-8,${SVG}`,
  secret: KEY, uri: 'otpauth://totp/site:me',
}

const AAL2 = { currentLevel: 'aal2', nextLevel: 'aal2', currentAuthenticationMethods: [{ method: 'totp' }] }
const AAL1 = { currentLevel: 'aal1', nextLevel: 'aal1', currentAuthenticationMethods: [{ method: 'password' }] }

beforeEach(() => {
  window.history.replaceState({}, '', '/profile/mfa')
  api.listMySessions.mockReset().mockResolvedValue([])
  api.listMyFactors.mockReset().mockResolvedValue([])
  api.assuranceLevel.mockReset().mockResolvedValue(AAL1)
  api.startFactorEnrolment.mockReset().mockResolvedValue(ENROLMENT)
  api.verifyFactorCode.mockReset().mockResolvedValue({})
  api.cancelFactorEnrolment.mockReset().mockResolvedValue(undefined)
  api.removeFactor.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  window.history.replaceState({}, '', '/')
})

const renderMfa = (props = {}) => {
  const showToast = vi.fn()
  render(<ProfileTab email="operator@site.test" userRole="Operator" theme="dark" sidebarMode="hover" showToast={showToast} {...props} />)
  return { showToast }
}

const factorRows = () => [...document.querySelectorAll('tr[data-factor]')]

describe('the MFA tab', () => {
  it('is a tab of its own, after Sessions, and offers Add Authenticator to every role, filled in its toolbar', async () => {
    renderMfa({ userRole: 'Auditor' })
    expect(tabLink('MFA')).toHaveAttribute('aria-current', 'page')
    expect(await screen.findByText('You have not set up MFA. Your password alone signs you in.')).toBeInTheDocument()
    const add = screen.getByRole('button', { name: /Add Authenticator/ })
    expect(add).toBeEnabled()
    // The tab explains itself in its tooltip: no heading, About tip or line under the bar.
    expect(screen.queryAllByRole('heading', { level: 4 })).toEqual([])
    expect(screen.queryByRole('button', { name: /^About / })).toBeNull()
    expect(add.closest('.filter-bar-actions')).toBeTruthy()
    expect(add).toHaveClass('btn-primary')
  })

  it('lists verified factors by name, and leaves a half-made one out', async () => {
    api.listMyFactors.mockResolvedValue([PHONE, HALF_MADE, TABLET])
    renderMfa()
    await waitFor(() => expect(factorRows()).toHaveLength(2))
    expect(factorRows().map(r => r.cells[0].textContent)).toEqual(['Work phone', 'Tablet'])
    expect(within(factorRows()[0]).getByRole('button', { name: 'Remove the authenticator: Work phone' })).toBeInTheDocument()
  })

  it('has nothing to add for a machine identity', () => {
    renderMfa({ email: null })
    expect(screen.getByText('A machine identity signs in with a token, so it has no MFA.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Add Authenticator/ })).toBeNull()
    expect(api.listMyFactors).not.toHaveBeenCalled()
  })

  it('says why the list could not be read', async () => {
    api.listMyFactors.mockRejectedValue(new Error('Could not list your authenticators'))
    renderMfa()
    expect(await screen.findByText('Could not list your authenticators')).toBeInTheDocument()
  })
})

describe('adding one', () => {
  const openAdd = async () => {
    renderMfa()
    await screen.findByText(/You have not set up MFA/)
    fireEvent.click(screen.getByRole('button', { name: /Add Authenticator/ }))
    return screen.findByRole('dialog')
  }

  it('names it, says it signs the other sessions out, then shows the QR code and the key', async () => {
    const dialog = await openAdd()
    expect(dialog).toHaveTextContent('Adding it signs you out of your other browsers and services')
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Authenticator app')
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: '  Work phone ' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(api.startFactorEnrolment).toHaveBeenCalledWith('Work phone'))

    const qr = await within(dialog).findByRole('img', { name: 'QR code for your authenticator app' })
    // Percent-encoded: the raw SVG's `#` would end a data URL.
    expect(qr.getAttribute('src')).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(SVG)}`)
    expect(dialog).toHaveTextContent('AAAA BBBB AAAA BBBB AAAA BBBB AAAA BBBB')
    expect(within(dialog).getByLabelText('Code')).toHaveAttribute('autocomplete', 'one-time-code')
  })

  it('refuses a name already in use before asking GoTrue', async () => {
    api.listMyFactors.mockResolvedValue([PHONE])
    renderMfa()
    await waitFor(() => expect(factorRows()).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: /Add Authenticator/ }))
    const dialog = await screen.findByRole('dialog')
    // The next free name is offered.
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Authenticator app')
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'work phone' } })
    expect(dialog).toHaveTextContent('You already have an authenticator with that name.')
    expect(within(dialog).getByRole('button', { name: 'Continue' })).toBeDisabled()
  })

  it('confirms it with a code, says so, and reads the list again', async () => {
    const { showToast } = renderMfa()
    await screen.findByText(/You have not set up MFA/)
    fireEvent.click(screen.getByRole('button', { name: /Add Authenticator/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }))
    const code = await within(dialog).findByLabelText('Code')

    api.listMyFactors.mockResolvedValue([{ ...PHONE, id: 'f-new', friendly_name: 'Authenticator app' }])
    fireEvent.change(code, { target: { value: '123 456' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Authenticator' }))
    await waitFor(() => expect(api.verifyFactorCode).toHaveBeenCalledWith('f-new', '123 456'))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      'Authenticator added: Authenticator app. You give its code each time you sign in.', 'success',
      { to: '/profile/mfa' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(factorRows()).toHaveLength(1))
    expect(api.cancelFactorEnrolment).not.toHaveBeenCalled()
  })

  it('keeps the dialog open on a wrong code, with GoTrue\'s refusal in it', async () => {
    api.verifyFactorCode.mockRejectedValue(new Error('That code is not right. Enter the code your app shows now.'))
    const dialog = await openAdd()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }))
    const code = await within(dialog).findByLabelText('Code')
    fireEvent.change(code, { target: { value: '000000' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Authenticator' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('That code is not right.')
    expect(code).toHaveValue('')
  })

  it('refuses something that is not six digits before asking GoTrue, and says so', async () => {
    const dialog = await openAdd()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }))
    const code = await within(dialog).findByLabelText('Code')
    const confirm = within(dialog).getByRole('button', { name: 'Add Authenticator' })
    // The name typed at the first step does not make the code step scold before its own edit.
    expect(dialog.querySelector('.modal-problem')).toHaveTextContent(/^$/)
    expect(confirm).toHaveClass('btn-disabled')
    fireEvent.change(code, { target: { value: '12345' } })
    expect(dialog.querySelector('.modal-problem')).toHaveTextContent('Enter the 6-digit code your app shows')
    expect(confirm).toBeDisabled()
    fireEvent.keyDown(code, { key: 'Enter' })
    expect(api.verifyFactorCode).not.toHaveBeenCalled()
  })

  it('removes the half-made factor when cancelled after the QR code', async () => {
    const dialog = await openAdd()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }))
    await within(dialog).findByLabelText('Code')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(api.cancelFactorEnrolment).toHaveBeenCalledWith('f-new'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})

describe('removing one', () => {
  it('asks first, then removes it, from a session that gave a code', async () => {
    api.listMyFactors.mockResolvedValue([PHONE])
    api.assuranceLevel.mockResolvedValue(AAL2)
    const { showToast } = renderMfa()
    await waitFor(() => expect(factorRows()).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: 'Remove the authenticator: Work phone' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Remove Work phone')
    expect(dialog).toHaveTextContent('your password alone signs you in')
    expect(within(dialog).queryByLabelText(/Code from/)).toBeNull()

    api.listMyFactors.mockResolvedValue([])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Authenticator' }))
    await waitFor(() => expect(api.removeFactor).toHaveBeenCalledWith('f-phone'))
    expect(api.verifyFactorCode).not.toHaveBeenCalled()
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Authenticator removed: Work phone.', 'success', { to: '/profile/mfa' }))
    expect(await screen.findByText(/You have not set up MFA/)).toBeInTheDocument()
  })

  it('asks for a code first from a session that has not given one', async () => {
    api.listMyFactors.mockResolvedValue([PHONE, TABLET])
    api.assuranceLevel.mockResolvedValue({ ...AAL1, nextLevel: 'aal2' })
    renderMfa()
    await waitFor(() => expect(factorRows()).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: 'Remove the authenticator: Tablet' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Your other authenticator still works.')
    const remove = within(dialog).getByRole('button', { name: 'Remove Authenticator' })
    expect(remove).toBeDisabled()

    fireEvent.change(within(dialog).getByLabelText('Code from Tablet'), { target: { value: '654321' } })
    fireEvent.click(remove)
    await waitFor(() => expect(api.removeFactor).toHaveBeenCalledWith('f-tablet'))
    expect(api.verifyFactorCode).toHaveBeenCalledWith('f-tablet', '654321')
    expect(api.verifyFactorCode.mock.invocationCallOrder[0]).toBeLessThan(api.removeFactor.mock.invocationCallOrder[0])
  })

  it('keeps the dialog open with the refusal when GoTrue says no', async () => {
    api.listMyFactors.mockResolvedValue([PHONE])
    api.assuranceLevel.mockResolvedValue(AAL2)
    api.removeFactor.mockRejectedValue(new Error('Enter a code from your authenticator app first.'))
    renderMfa()
    await waitFor(() => expect(factorRows()).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: 'Remove the authenticator: Work phone' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Authenticator' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Enter a code from your authenticator app first.')
  })
})
