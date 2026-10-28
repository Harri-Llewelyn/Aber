/**
 * Profile > Security: the Second factor section, after Sessions. It lists the person's verified
 * authenticator apps. Add Second Factor names one, shows GoTrue's QR code and the secret as text,
 * then takes a code, which GoTrue checks before the factor counts; Cancel removes a half-made one.
 * Remove asks first with a button that repeats its name, and asks for a code when this session has
 * not given one (aal1), as GoTrue requires.
 */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProfileTab } from '../components/tabs/ProfileTab'

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
  window.history.replaceState({}, '', '/profile/security')
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

const renderSecurity = (props = {}) => {
  const showToast = vi.fn()
  render(<ProfileTab email="operator@site.test" userRole="Operator" theme="dark" sidebarMode="hover" showToast={showToast} {...props} />)
  return { showToast }
}

const factorRows = () => [...document.querySelectorAll('tr[data-factor]')]

describe('the Second factor section', () => {
  it('follows Sessions, with an About tip, and offers Add Second Factor to every role', async () => {
    renderSecurity({ userRole: 'Auditor' })
    const headings = screen.getAllByRole('heading', { level: 4 }).map(h => h.textContent)
    expect(headings).toEqual(['Sessions', 'Second factor', 'Apps you have allowed'])
    expect(screen.getByRole('button', { name: 'About second factors' })).toBeInTheDocument()
    expect(await screen.findByText('You have no second factor. Your password alone signs you in.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Add Second Factor/ })).toBeEnabled()
  })

  it('lists verified factors by name, and leaves a half-made one out', async () => {
    api.listMyFactors.mockResolvedValue([PHONE, HALF_MADE, TABLET])
    renderSecurity()
    await waitFor(() => expect(factorRows()).toHaveLength(2))
    expect(factorRows().map(r => r.cells[0].textContent)).toEqual(['Work phone', 'Tablet'])
    expect(within(factorRows()[0]).getByRole('button', { name: 'Remove the second factor: Work phone' })).toBeInTheDocument()
  })

  it('has nothing to add for a machine identity', () => {
    renderSecurity({ email: null })
    expect(screen.getByText('A machine identity signs in with a token, so it has no second factor.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Add Second Factor/ })).toBeNull()
    expect(api.listMyFactors).not.toHaveBeenCalled()
  })

  it('says why the list could not be read', async () => {
    api.listMyFactors.mockRejectedValue(new Error('Could not list your second factors'))
    renderSecurity()
    expect(await screen.findByText('Could not list your second factors')).toBeInTheDocument()
  })
})

describe('adding one', () => {
  const openAdd = async () => {
    renderSecurity()
    await screen.findByText(/You have no second factor/)
    fireEvent.click(screen.getByRole('button', { name: /Add Second Factor/ }))
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
    renderSecurity()
    await waitFor(() => expect(factorRows()).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: /Add Second Factor/ }))
    const dialog = await screen.findByRole('dialog')
    // The next free name is offered.
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Authenticator app')
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'work phone' } })
    expect(dialog).toHaveTextContent('You already have a second factor with that name.')
    expect(within(dialog).getByRole('button', { name: 'Continue' })).toBeDisabled()
  })

  it('confirms it with a code, says so, and reads the list again', async () => {
    const { showToast } = renderSecurity()
    await screen.findByText(/You have no second factor/)
    fireEvent.click(screen.getByRole('button', { name: /Add Second Factor/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }))
    const code = await within(dialog).findByLabelText('Code')

    api.listMyFactors.mockResolvedValue([{ ...PHONE, id: 'f-new', friendly_name: 'Authenticator app' }])
    fireEvent.change(code, { target: { value: '123 456' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Second Factor' }))
    await waitFor(() => expect(api.verifyFactorCode).toHaveBeenCalledWith('f-new', '123 456'))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      'Second factor added: Authenticator app. You give its code each time you sign in.', 'success',
      { to: '/profile/security' }))
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
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Second Factor' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('That code is not right.')
    expect(code).toHaveValue('')
  })

  it('refuses something that is not six digits before asking GoTrue', async () => {
    const dialog = await openAdd()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }))
    fireEvent.change(await within(dialog).findByLabelText('Code'), { target: { value: '12345' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Second Factor' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Enter the 6-digit code your app shows.')
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
    const { showToast } = renderSecurity()
    await waitFor(() => expect(factorRows()).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: 'Remove the second factor: Work phone' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Remove Work phone')
    expect(dialog).toHaveTextContent('your password alone signs you in')
    expect(within(dialog).queryByLabelText(/Code from/)).toBeNull()

    api.listMyFactors.mockResolvedValue([])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Second Factor' }))
    await waitFor(() => expect(api.removeFactor).toHaveBeenCalledWith('f-phone'))
    expect(api.verifyFactorCode).not.toHaveBeenCalled()
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Second factor removed: Work phone.', 'success', { to: '/profile/security' }))
    expect(await screen.findByText(/You have no second factor/)).toBeInTheDocument()
  })

  it('asks for a code first from a session that has not given one', async () => {
    api.listMyFactors.mockResolvedValue([PHONE, TABLET])
    api.assuranceLevel.mockResolvedValue({ ...AAL1, nextLevel: 'aal2' })
    renderSecurity()
    await waitFor(() => expect(factorRows()).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: 'Remove the second factor: Tablet' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Your other second factor still works.')
    const remove = within(dialog).getByRole('button', { name: 'Remove Second Factor' })
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
    renderSecurity()
    await waitFor(() => expect(factorRows()).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: 'Remove the second factor: Work phone' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Second Factor' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Enter a code from your authenticator app first.')
  })
})
