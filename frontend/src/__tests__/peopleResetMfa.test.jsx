/**
 * Reset MFA, in a person's drawer on Access Control › People: an Administrator removes the second
 * factor of someone who has lost their authenticator (manage-people's `reset-mfa`). It asks first,
 * says their sessions stay and End Sessions is the act that ends them, then says what it did. Your
 * own is greyed out with the reason, since Profile › Security removes your own.
 */
import React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { personUrl } from '../routes'

import { AccessControlTab } from '../components/tabs/AccessControlTab'
import { api } from '../api'

vi.mock('../api', () => ({
  api: {
    listPeople: vi.fn(),
    personSessionSummary: vi.fn(),
    personSessions: vi.fn(),
    resetPersonMfa: vi.fn(),
    managePeople: vi.fn(),
    // The rest of the page's reads, answered empty: this suite is about one action.
    listGatewayCredentials: vi.fn(),
    listBrokerInventory: vi.fn(),
    listServicePrincipals: vi.fn(),
    listServiceTokens: vi.fn(),
    listRevokedServiceTokens: vi.fn(),
    listRevokedServicePrincipals: vi.fn(),
  }
}))

vi.mock('../components/common/CopyableId', () => ({
  __esModule: true,
  default: () => null,
  copyText: vi.fn().mockResolvedValue(true),
}))

const ME = 'a0000000-0000-4000-8000-000000000001'
const OTHER_ADMIN = 'a0000000-0000-4000-8000-000000000002'
const OPERATOR = 'a0000000-0000-4000-8000-000000000003'
const REMOVED = 'a0000000-0000-4000-8000-000000000005'

const person = (user_id, email, role, status, extra = {}) => ({
  user_id, email, role, status, sign_in_blocked: false, role_on_restore: null,
  invited_at: null, last_sign_in_at: status === 'active' ? '2026-10-01T09:00:00Z' : null,
  created_at: '2026-09-01T09:00:00Z', ...extra,
})

const PEOPLE = [
  person(ME, 'me@site.test', 'Administrator', 'active'),
  person(OTHER_ADMIN, 'second@site.test', 'Administrator', 'active'),
  person(OPERATOR, 'operator@site.test', 'Operator', 'active'),
  person(REMOVED, 'removed@site.test', null, 'removed', { sign_in_blocked: true, role_on_restore: 'Operator' }),
]

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/access-control')
  api.listPeople.mockResolvedValue(PEOPLE)
  api.personSessionSummary.mockResolvedValue({ open_sessions: 1, last_active_at: '2026-10-24T10:00:00Z' })
  api.listGatewayCredentials.mockResolvedValue([])
  api.listBrokerInventory.mockResolvedValue({ clients: [], roles: [] })
  api.listServicePrincipals.mockResolvedValue([])
  api.listServiceTokens.mockResolvedValue(new Map())
  api.listRevokedServiceTokens.mockResolvedValue(new Set())
  api.listRevokedServicePrincipals.mockResolvedValue(new Map())
})

function renderPeople(showToast = vi.fn()) {
  render(<AccessControlTab showToast={showToast} userRole="Administrator" currentUserId={ME} />)
  return showToast
}

async function openDrawer(email) {
  const table = (await screen.findAllByRole('table')).find(t => !t.closest('.context-panel'))
  fireEvent.click((await within(table).findByText(email)).closest('tr'))
  return within(await screen.findByRole('complementary', { name: / person$/ }))
}

describe('Reset MFA', () => {
  it('sits beside End Sessions, and asks first, saying the sessions stay', async () => {
    renderPeople()
    const drawer = await openDrawer('operator@site.test')
    const reset = drawer.getByRole('button', { name: 'Reset MFA' })
    expect(reset).toBeEnabled()
    expect(reset).toHaveAccessibleDescription(expect.stringMatching(/lost their authenticator/))

    fireEvent.click(reset)
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Reset MFA for operator@site.test')
    expect(dialog).toHaveTextContent('signing in asks only for their password')
    expect(dialog).toHaveTextContent('Their sessions stay signed in: to sign them out, use End Sessions as well.')
    expect(within(dialog).getByRole('button', { name: 'Reset MFA' })).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(api.resetPersonMfa).not.toHaveBeenCalled()
  })

  it('removes their factors through manage-people and says so, linking to them', async () => {
    api.resetPersonMfa.mockResolvedValue({ user_id: OPERATOR, factors_removed: 1 })
    const toast = renderPeople()
    fireEvent.click((await openDrawer('operator@site.test')).getByRole('button', { name: 'Reset MFA' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Reset MFA' }))
    await waitFor(() => expect(api.resetPersonMfa).toHaveBeenCalledWith(OPERATOR))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(
      "operator@site.test's second factor is reset: their password alone signs them in", 'success',
      { to: personUrl('operator@site.test') }))
    // Nothing else was asked of manage-people, and no session was ended.
    expect(api.managePeople).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('says when there was nothing to remove', async () => {
    api.resetPersonMfa.mockResolvedValue({ user_id: OPERATOR, factors_removed: 0 })
    const toast = renderPeople()
    fireEvent.click((await openDrawer('operator@site.test')).getByRole('button', { name: 'Reset MFA' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Reset MFA' }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(
      'operator@site.test had no second factor to remove', 'success', { to: personUrl('operator@site.test') }))
  })

  it('shows a refusal as an error', async () => {
    api.resetPersonMfa.mockRejectedValue(new Error('insufficient privileges to reset a person\'s second factor'))
    const toast = renderPeople()
    fireEvent.click((await openDrawer('operator@site.test')).getByRole('button', { name: 'Reset MFA' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Reset MFA' }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(
      'insufficient privileges to reset a person\'s second factor', 'error'))
  })

  it('is greyed out in your own drawer, pointing at Profile', async () => {
    renderPeople()
    const mine = await openDrawer('me@site.test')
    const reset = mine.getByRole('button', { name: 'Reset MFA' })
    expect(reset).toBeDisabled()
    expect(reset).toHaveAccessibleDescription(
      "You cannot reset your own second factor here. Remove it on your Profile page's Security tab.")
  })

  it('is offered for a removed person, so Restore Access lets them in with none', async () => {
    api.resetPersonMfa.mockResolvedValue({ user_id: REMOVED, factors_removed: 1 })
    const toast = renderPeople()
    fireEvent.click(await screen.findByRole('button', { name: /^Show removed/ }))
    const drawer = await openDrawer('removed@site.test')
    fireEvent.click(drawer.getByRole('button', { name: 'Reset MFA' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Reset MFA' }))
    await waitFor(() => expect(api.resetPersonMfa).toHaveBeenCalledWith(REMOVED))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(
      expect.stringMatching(/second factor is reset/), 'success', { to: personUrl('removed@site.test', true) }))
  })
})
