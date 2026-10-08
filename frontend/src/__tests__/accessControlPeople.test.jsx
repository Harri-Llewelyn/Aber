import React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { AccessControlTab } from '../components/tabs/AccessControlTab'
import { api } from '../api'
import { DEFAULT_ROLE_PERMISSIONS_MAP } from '../hooks/usePermissions'
import { PERSON_ROLES, administratorsWithAccess, removalBlocked, roleChangeBlocked } from '../utils/people'

vi.mock('../api', () => ({
  api: {
    listPeople: vi.fn(),
    setPersonRole: vi.fn(),
    addPerson: vi.fn(),
    removePersonAccess: vi.fn(),
    restorePersonAccess: vi.fn(),
    // The rest of the page's reads, answered empty: this suite is about the People tab.
    listGatewayCredentials: vi.fn(),
    listBrokerInventory: vi.fn(),
    listServicePrincipals: vi.fn(),
    listServiceTokens: vi.fn(),
    listRevokedServiceTokens: vi.fn(),
    listRevokedServicePrincipals: vi.fn(),
  }
}))

// jsdom has no clipboard; copying is not what this suite is about.
vi.mock('../components/common/CopyableId', () => ({
  __esModule: true,
  default: () => null,
  copyText: vi.fn().mockResolvedValue(true),
}))

const ME = 'a0000000-0000-4000-8000-000000000001'
const OTHER_ADMIN = 'a0000000-0000-4000-8000-000000000002'
const OPERATOR = 'a0000000-0000-4000-8000-000000000003'
const INVITED = 'a0000000-0000-4000-8000-000000000004'
const REMOVED = 'a0000000-0000-4000-8000-000000000005'
const HALF_REMOVED = 'a0000000-0000-4000-8000-000000000006'

const person = (user_id, email, role, status, extra = {}) => ({
  user_id, email, role, status, sign_in_blocked: false, role_on_restore: null,
  invited_at: null, last_sign_in_at: status === 'active' ? '2026-10-01T09:00:00Z' : null,
  created_at: '2026-09-01T09:00:00Z', ...extra,
})

const PEOPLE = [
  person(ME, 'me@site.test', 'Administrator', 'active'),
  person(OTHER_ADMIN, 'second@site.test', 'Administrator', 'active'),
  person(OPERATOR, 'operator@site.test', 'Operator', 'active'),
  person(INVITED, 'invited@site.test', 'Auditor', 'invited', { invited_at: '2026-10-06T09:00:00Z' }),
  person(REMOVED, 'removed@site.test', null, 'removed', { sign_in_blocked: true, role_on_restore: 'Shopfloor_Manager' }),
  person(HALF_REMOVED, 'half@site.test', null, 'removed', { sign_in_blocked: false, role_on_restore: 'Operator' }),
]

beforeEach(() => {
  vi.clearAllMocks()
  api.listPeople.mockResolvedValue(PEOPLE)
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

/** The table row holding this email. */
async function row(email) {
  return (await screen.findByText(email)).closest('tr')
}

describe('the People tab', () => {
  it('is the first tab for an Administrator, and the page opens on it', async () => {
    renderPeople()
    const tabs = screen.getAllByRole('tab')
    expect(tabs[0]).toHaveTextContent('People')
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByText('operator@site.test')).toBeInTheDocument()
  })

  it('is not offered to any other role, and the people are not read', async () => {
    for (const role of ['Shopfloor_Manager', 'Operator', 'Auditor', null]) {
      const { unmount } = render(<AccessControlTab showToast={vi.fn()} userRole={role} currentUserId={ME} />)
      await screen.findByRole('tab', { name: 'Broker credentials' })
      expect(screen.queryByRole('tab', { name: 'People' })).toBeNull()
      unmount()
    }
    expect(api.listPeople).not.toHaveBeenCalled()
  })

  it('shows each person with their role and state', async () => {
    renderPeople()
    expect(within(await row('operator@site.test')).getByText('Active')).toBeInTheDocument()
    expect(within(await row('invited@site.test')).getByText('Invited')).toBeInTheDocument()
    const removed = await row('removed@site.test')
    expect(within(removed).getByText('Access removed')).toBeInTheDocument()
    expect(within(removed).getByText('Shopfloor Manager when restored')).toBeInTheDocument()
    expect(within(await row('me@site.test')).getByText('YOU')).toBeInTheDocument()
    expect(within(await row('operator@site.test')).getByRole('combobox')).toHaveValue('Operator')
  })

  it('sets a role through the database and reads the list again', async () => {
    api.setPersonRole.mockResolvedValue(true)
    const toast = renderPeople()
    const select = within(await row('operator@site.test')).getByRole('combobox')
    fireEvent.change(select, { target: { value: 'Auditor' } })
    await waitFor(() => expect(api.setPersonRole).toHaveBeenCalledWith(OPERATOR, 'Auditor'))
    await waitFor(() => expect(api.listPeople).toHaveBeenCalledTimes(2))
    expect(toast).toHaveBeenCalledWith('operator@site.test is now Auditor', 'success')
  })

  it('shows the database refusing a role change', async () => {
    api.setPersonRole.mockRejectedValue(new Error('this would leave no Administrator who can sign in.'))
    const toast = renderPeople()
    fireEvent.change(within(await row('second@site.test')).getByRole('combobox'), { target: { value: 'Operator' } })
    await waitFor(() => expect(toast).toHaveBeenCalledWith('this would leave no Administrator who can sign in.', 'error'))
  })

  it('disables your own role and access, saying why', async () => {
    renderPeople()
    const mine = await row('me@site.test')
    const select = within(mine).getByRole('combobox')
    expect(select).toBeDisabled()
    expect(select).toHaveAttribute('title', 'You cannot change your own role. Ask another Administrator.')
    const remove = within(mine).getByRole('button', { name: 'Remove Access' })
    expect(remove).toBeDisabled()
    expect(remove).toHaveAttribute('title', 'You cannot remove your own access. Ask another Administrator.')
    fireEvent.click(remove)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('removes access only after it is confirmed', async () => {
    api.removePersonAccess.mockResolvedValue({ user_id: OPERATOR, access: 'removed' })
    const toast = renderPeople()
    fireEvent.click(within(await row('operator@site.test')).getByRole('button', { name: 'Remove Access' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Remove access for operator@site.test')
    expect(dialog).toHaveTextContent('can no longer sign in')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(api.removePersonAccess).not.toHaveBeenCalled()

    fireEvent.click(within(await row('operator@site.test')).getByRole('button', { name: 'Remove Access' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove Access' }))
    await waitFor(() => expect(api.removePersonAccess).toHaveBeenCalledWith(OPERATOR))
    await waitFor(() => expect(toast).toHaveBeenCalledWith('operator@site.test can no longer sign in', 'success'))
  })

  it('restores access after it is confirmed, naming the role that comes back', async () => {
    api.restorePersonAccess.mockResolvedValue({ user_id: REMOVED, access: 'active', role: 'Shopfloor_Manager' })
    const toast = renderPeople()
    const removed = await row('removed@site.test')
    expect(within(removed).getByRole('combobox')).toBeDisabled()
    expect(within(removed).queryByRole('button', { name: 'Remove Access' })).toBeNull()
    fireEvent.click(within(removed).getByRole('button', { name: 'Restore Access' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('as Shopfloor Manager')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore Access' }))
    await waitFor(() => expect(api.restorePersonAccess).toHaveBeenCalledWith(REMOVED))
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('removed@site.test can sign in again as Shopfloor Manager', 'success'))
  })

  it('offers removal again when sign-in was not blocked', async () => {
    renderPeople()
    const half = await row('half@site.test')
    expect(within(half).getByText('Sign-in still open')).toBeInTheDocument()
    expect(within(half).getByRole('button', { name: 'Remove Access' })).toBeEnabled()
    expect(within(half).getByRole('button', { name: 'Restore Access' })).toBeEnabled()
  })
})

describe('adding a person', () => {
  async function submit(email, role) {
    fireEvent.click(await screen.findByRole('button', { name: /Add Person/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Email'), { target: { value: email } })
    fireEvent.change(within(dialog).getByLabelText('Role'), { target: { value: role } })
    fireEvent.click(within(dialog).getByRole('button', { name: /Add Person/ }))
    return dialog
  }

  it('without a mail relay, shows the password once', async () => {
    const MINTED = 'k7m2qp-x9a4bn-c3d8ef-gh2jk5'
    api.addPerson.mockResolvedValue({
      user_id: 'n0000000-0000-4000-8000-000000000001', email: 'new@site.test', role: 'Operator',
      invited: false, password: MINTED,
    })
    renderPeople()
    await submit('new@site.test', 'Operator')

    await waitFor(() => expect(api.addPerson).toHaveBeenCalledWith('new@site.test', 'Operator'))
    const reveal = await screen.findByRole('dialog')
    expect(reveal).toHaveTextContent('it is not shown again')
    expect(within(reveal).getByLabelText('Password')).toHaveValue(MINTED)
    // The list behind the dialog is read again so the person appears.
    await waitFor(() => expect(api.listPeople).toHaveBeenCalledTimes(2))

    fireEvent.click(within(reveal).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByDisplayValue(MINTED)).toBeNull()
  })

  it('with a mail relay, says an invitation was sent and shows no password', async () => {
    api.addPerson.mockResolvedValue({
      user_id: 'n0000000-0000-4000-8000-000000000002', email: 'invitee@site.test', role: 'Auditor', invited: true,
    })
    renderPeople()
    await submit('invitee@site.test', 'Auditor')

    const done = await screen.findByText(/An invitation was sent to invitee@site.test/)
    const dialog = done.closest('[role="dialog"]')
    expect(within(dialog).queryByLabelText('Password')).toBeNull()
    expect(dialog).toHaveTextContent('They choose their own password')
  })

  it('keeps the form open with the reason when the person was not added', async () => {
    api.addPerson.mockRejectedValue(new Error('An account with this email address already exists.'))
    renderPeople()
    const dialog = await submit('operator@site.test', 'Operator')
    expect(await within(dialog).findByText('An account with this email address already exists.')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Email')).toHaveValue('operator@site.test')
  })

  it('cannot be sent without an address', async () => {
    renderPeople()
    fireEvent.click(await screen.findByRole('button', { name: /Add Person/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('button', { name: /Add Person/ })).toBeDisabled()
  })
})

describe('the people rules', () => {
  it('offers the four roles the database accepts, in the dashboard\'s order', () => {
    expect(PERSON_ROLES.map(r => r.name)).toEqual(Object.keys(DEFAULT_ROLE_PERMISSIONS_MAP))
  })

  it('refuses the last Administrator who can sign in, and no other', () => {
    const solo = [
      person(ME, 'me@site.test', 'Administrator', 'active'),
      person(OTHER_ADMIN, 'second@site.test', 'Administrator', 'removed', { sign_in_blocked: true }),
      person(OPERATOR, 'operator@site.test', 'Operator', 'active'),
    ]
    expect(administratorsWithAccess(solo)).toBe(1)
    // Seen by somebody else -- a second Administrator holding a token from before their ban.
    expect(removalBlocked(solo[0], solo, OTHER_ADMIN)).toMatch(/only Administrator who can sign in/)
    expect(roleChangeBlocked(solo[0], solo, OTHER_ADMIN)).toMatch(/only Administrator who can sign in/)
    expect(removalBlocked(solo[2], solo, ME)).toBeNull()
    expect(removalBlocked(PEOPLE[1], PEOPLE, ME)).toBeNull()
  })
})
