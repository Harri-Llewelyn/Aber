import React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { personUrl } from '../routes'

import { AccessControlTab } from '../components/tabs/AccessControlTab'
import { api } from '../api'
import { DEFAULT_ROLE_PERMISSIONS_MAP } from '../hooks/usePermissions'
import {
  PERSON_ROLES, administratorsWithAccess, passwordSetBlocked, personRoleWithArticle, removalBlocked, roleChangeBlocked,
} from '../utils/people'
import { findTabLink, queryTabLink, tabLinks } from '../test/tabBar'

vi.mock('../api', () => ({
  api: {
    listPeople: vi.fn(),
    setPersonRole: vi.fn(),
    addPerson: vi.fn(),
    removePersonAccess: vi.fn(),
    restorePersonAccess: vi.fn(),
    managePeople: vi.fn(),
    setDisplayName: vi.fn(),
    personSessionSummary: vi.fn(),
    endPersonSessions: vi.fn(),
    changePersonEmail: vi.fn(),
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
  // The open drawer is in the address, so each test starts on the bare page.
  window.history.replaceState(null, '', '/access-control')
  api.listPeople.mockResolvedValue(PEOPLE)
  api.personSessionSummary.mockResolvedValue({ open_sessions: 2, last_active_at: '2026-10-24T10:00:00Z' })
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

/** The table row holding this email. An open drawer shows the email too, so only the table is searched. */
async function row(email) {
  const table = await screen.findByRole('table')
  return (await within(table).findByText(email)).closest('tr')
}

/** The person drawer, while it is open: a closed one is hidden from assistive technology. */
const queryDrawer = () => screen.queryByRole('complementary', { name: / person$/ })

/** Opens a person's drawer by clicking their row, and returns queries bound to it. */
async function openDrawer(email) {
  fireEvent.click(await row(email))
  return within(await screen.findByRole('complementary', { name: / person$/ }))
}

/** Removed accounts are left off People until this toggle is on. */
async function showRemoved() {
  fireEvent.click(await screen.findByRole('button', { name: /^Show removed/ }))
}

describe('the People tab', () => {
  it('is the first tab for an Administrator, and the page opens on it', async () => {
    renderPeople()
    const tabs = tabLinks()
    expect(tabs[0]).toHaveTextContent('People')
    expect(tabs[0]).toHaveAttribute('aria-current', 'page')
    expect(await screen.findByText('operator@site.test')).toBeInTheDocument()
  })

  it('is not offered to any other role, and the people are not read', async () => {
    for (const role of ['Shopfloor_Manager', 'Operator', 'Auditor', null]) {
      const { unmount } = render(<AccessControlTab showToast={vi.fn()} userRole={role} currentUserId={ME} />)
      await findTabLink('Broker credentials')
      expect(queryTabLink('People')).toBeNull()
      unmount()
    }
    expect(api.listPeople).not.toHaveBeenCalled()
  })

  it('shows each person with their role and state', async () => {
    renderPeople()
    expect(within(await row('operator@site.test')).getByText('Active')).toBeInTheDocument()
    expect(within(await row('invited@site.test')).getByText('Invited')).toBeInTheDocument()
    expect(within(await row('half@site.test')).getByText('Sign-in still open')).toBeInTheDocument()
    await showRemoved()
    const removed = await row('removed@site.test')
    expect(within(removed).getByText('Access removed')).toBeInTheDocument()
    expect(within(removed).getByText('Shopfloor Manager when restored')).toBeInTheDocument()
    expect(within(await row('me@site.test')).getByText('YOU')).toBeInTheDocument()
    // The role is text on the row; Change Role in the drawer changes it.
    const operator = await row('operator@site.test')
    expect(operator.cells[1]).toHaveTextContent(/^Operator$/)
    expect(within(operator).queryByRole('combobox')).toBeNull()
    expect(removed.cells[1]).toHaveTextContent(/^No roleShopfloor Manager when restored$/)
  })

  it('disables your own role and access, saying why', async () => {
    renderPeople()
    const mine = await openDrawer('me@site.test')
    const role = mine.getByRole('button', { name: 'Change Role' })
    expect(role).toBeDisabled()
    expect(role).toHaveAccessibleDescription('You cannot change your own role. Ask another Administrator.')
    const remove = mine.getByRole('button', { name: 'Remove Access' })
    expect(remove).toBeDisabled()
    expect(remove).toHaveAccessibleDescription('You cannot remove your own access. Ask another Administrator.')
    fireEvent.click(remove)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('removes access only after it is confirmed', async () => {
    api.removePersonAccess.mockResolvedValue({ user_id: OPERATOR, access: 'removed' })
    const toast = renderPeople()
    const drawer = await openDrawer('operator@site.test')
    fireEvent.click(drawer.getByRole('button', { name: 'Remove Access' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Remove access for operator@site.test')
    expect(dialog).toHaveTextContent('can no longer sign in')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(api.removePersonAccess).not.toHaveBeenCalled()

    fireEvent.click(drawer.getByRole('button', { name: 'Remove Access' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove Access' }))
    await waitFor(() => expect(api.removePersonAccess).toHaveBeenCalledWith(OPERATOR))
    await waitFor(() => expect(toast).toHaveBeenCalledWith('operator@site.test can no longer sign in', 'success',
      { to: personUrl('operator@site.test', true) }))
  })

  it('restores access after it is confirmed, naming the role that comes back', async () => {
    api.restorePersonAccess.mockResolvedValue({ user_id: REMOVED, access: 'active', role: 'Shopfloor_Manager' })
    const toast = renderPeople()
    await showRemoved()
    const drawer = await openDrawer('removed@site.test')
    expect(drawer.getByRole('button', { name: 'Change Role' })).toBeDisabled()
    expect(drawer.queryByRole('button', { name: 'Remove Access' })).toBeNull()
    fireEvent.click(drawer.getByRole('button', { name: 'Restore Access' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('as Shopfloor Manager')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore Access' }))
    await waitFor(() => expect(api.restorePersonAccess).toHaveBeenCalledWith(REMOVED))
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('removed@site.test can sign in again as Shopfloor Manager', 'success',
        { to: personUrl('removed@site.test') }))
  })

  it('offers removal again when sign-in was not blocked', async () => {
    renderPeople()
    expect(within(await row('half@site.test')).getByText('Sign-in still open')).toBeInTheDocument()
    const drawer = await openDrawer('half@site.test')
    expect(drawer.getByRole('button', { name: 'Remove Access' })).toBeEnabled()
    expect(drawer.getByRole('button', { name: 'Restore Access' })).toBeEnabled()
  })
})

describe('People: sorting by a column (#801)', () => {
  const MANAGER = 'a0000000-0000-4000-8000-000000000007'
  // Listed in none of the orders a sort makes. Half holds no role and signed in before anyone;
  // the invited person never has.
  const SORTABLE = [
    person(ME, 'me@site.test', 'Administrator', 'active'),
    person(OPERATOR, 'operator@site.test', 'Operator', 'active', { last_sign_in_at: '2026-10-10T09:00:00Z' }),
    person(INVITED, 'invited@site.test', 'Auditor', 'invited', { invited_at: '2026-10-06T09:00:00Z' }),
    person(MANAGER, 'manager@site.test', 'Shopfloor_Manager', 'active', { last_sign_in_at: '2026-10-05T09:00:00Z' }),
    person(HALF_REMOVED, 'half@site.test', null, 'removed', {
      sign_in_blocked: false, role_on_restore: 'Operator', last_sign_in_at: '2026-09-20T09:00:00Z',
    }),
    person(REMOVED, 'removed@site.test', null, 'removed', { sign_in_blocked: true, role_on_restore: 'Auditor' }),
  ]

  const at = (url) => window.history.replaceState(null, '', url)
  const address = () => window.location.pathname + window.location.search
  /** The email on each row, in the order shown. */
  const emails = () => screen.getAllByRole('row').slice(1).map(r => r.cells[0].firstElementChild.textContent)
  const sortBy = (label) => fireEvent.click(screen.getByRole('button', { name: label }))

  beforeEach(() => { api.listPeople.mockResolvedValue(SORTABLE) })

  it('sorts roles in the order they are listed everywhere, with no role last', async () => {
    at('/access-control')
    renderPeople()
    await screen.findByText('manager@site.test')

    // Administrator, Shopfloor Manager, Operator, Auditor: not alphabetical.
    sortBy('Role')
    expect(emails()).toEqual(['me@site.test', 'manager@site.test', 'operator@site.test', 'invited@site.test', 'half@site.test'])
    expect(screen.getByRole('columnheader', { name: 'Role' })).toHaveAttribute('aria-sort', 'ascending')
    expect(address()).toBe('/access-control?sort=role')
    sortBy('Role')
    expect(emails()).toEqual(['invited@site.test', 'operator@site.test', 'manager@site.test', 'me@site.test', 'half@site.test'])
    expect(screen.getByRole('columnheader', { name: 'Role' })).toHaveAttribute('aria-sort', 'descending')
    expect(address()).toBe('/access-control?sort=-role')
  })

  it('sorts status by severity, a finished removal first and the active last', async () => {
    renderPeople()
    await showRemoved()
    await screen.findByText('removed@site.test')

    sortBy('Status')
    expect(emails()).toEqual([
      'removed@site.test', 'half@site.test', 'invited@site.test', 'me@site.test', 'operator@site.test', 'manager@site.test',
    ])
    sortBy('Status')
    expect(emails()).toEqual([
      'me@site.test', 'operator@site.test', 'manager@site.test', 'invited@site.test', 'half@site.test', 'removed@site.test',
    ])
  })

  it('sorts by when each person last signed in, with Never last either way', async () => {
    renderPeople()
    await screen.findByText('manager@site.test')

    sortBy('Last signed in')
    expect(emails()).toEqual(['half@site.test', 'me@site.test', 'manager@site.test', 'operator@site.test', 'invited@site.test'])
    sortBy('Last signed in')
    expect(emails()).toEqual(['operator@site.test', 'manager@site.test', 'me@site.test', 'half@site.test', 'invited@site.test'])
  })

  /** People shares its page with four tables on hidden tabs, and none of them tidies its sort away. */
  it('arrives sorted from the address, and keeps the sort there', async () => {
    at('/access-control?sort=-last_sign_in')
    renderPeople()

    await waitFor(() => expect(emails())
      .toEqual(['operator@site.test', 'manager@site.test', 'me@site.test', 'half@site.test', 'invited@site.test']))
    expect(screen.getByRole('columnheader', { name: 'Last signed in' })).toHaveAttribute('aria-sort', 'descending')
    expect(address()).toBe('/access-control?sort=-last_sign_in')
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

    // No name was given, so none is sent.
    await waitFor(() => expect(api.addPerson).toHaveBeenCalledWith('new@site.test', 'Operator', null))
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

describe('display names', () => {
  const NAMED = PEOPLE.map(p => (p.user_id === OPERATOR ? { ...p, display_name: 'Owain Operator' } : p))

  it('shows a name first with the email beside it, and the email alone without one', async () => {
    api.listPeople.mockResolvedValue(NAMED)
    renderPeople()
    const named = await row('operator@site.test')
    const cell = named.cells[0]
    expect(cell).toHaveTextContent('Owain Operator')
    // Both in view, name first: two people can share a name, and anyone can type any name.
    expect(cell.textContent.indexOf('Owain Operator')).toBeLessThan(cell.textContent.indexOf('operator@site.test'))
    expect((await row('invited@site.test')).cells[0].textContent).toBe('invited@site.test')
  })

  it('is matched by the search as well as the email', async () => {
    api.listPeople.mockResolvedValue(NAMED)
    renderPeople()
    await screen.findByText('Owain Operator')
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search people by name or email' }), { target: { value: 'owain' } })
    await waitFor(() => expect(screen.queryByText('invited@site.test')).toBeNull())
    expect(screen.getByText('operator@site.test')).toBeInTheDocument()
  })

  it('is changed from the row with Change Name, and the list is read again', async () => {
    api.listPeople.mockResolvedValue(NAMED)
    api.setDisplayName.mockResolvedValue('Owain ap Rhys')
    const toast = renderPeople()
    fireEvent.click((await openDrawer('operator@site.test')).getByRole('button', { name: 'Change Name' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Change the name for operator@site.test')
    const input = within(dialog).getByLabelText('Display name')
    expect(input).toHaveValue('Owain Operator')
    fireEvent.change(input, { target: { value: '  Owain ap Rhys ' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.setDisplayName).toHaveBeenCalledWith(OPERATOR, 'Owain ap Rhys'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(toast).toHaveBeenCalledWith('operator@site.test is now shown as Owain ap Rhys', 'success',
      { to: personUrl('operator@site.test') })
    await waitFor(() => expect(api.listPeople).toHaveBeenCalledTimes(2))
  })

  it('is cleared by saving an empty name', async () => {
    api.listPeople.mockResolvedValue(NAMED)
    api.setDisplayName.mockResolvedValue(null)
    const toast = renderPeople()
    fireEvent.click((await openDrawer('operator@site.test')).getByRole('button', { name: 'Change Name' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Display name'), { target: { value: '   ' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.setDisplayName).toHaveBeenCalledWith(OPERATOR, null))
    expect(toast).toHaveBeenCalledWith('operator@site.test is now shown by email alone', 'success',
      { to: personUrl('operator@site.test') })
  })

  it('refuses a name the database would refuse before sending it', async () => {
    renderPeople()
    fireEvent.click((await openDrawer('operator@site.test')).getByRole('button', { name: 'Change Name' }))
    const dialog = await screen.findByRole('dialog')
    const input = within(dialog).getByLabelText('Display name')
    fireEvent.change(input, { target: { value: 'N'.repeat(81) } })
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(dialog).toHaveTextContent('A display name is 80 characters at most.')
    fireEvent.change(input, { target: { value: 'Owain\tOperator' } })
    expect(dialog).toHaveTextContent('cannot contain a control character')
    expect(api.setDisplayName).not.toHaveBeenCalled()
  })

  it('keeps the dialog open with the database\'s sentence when it is refused', async () => {
    api.setDisplayName.mockRejectedValue(new Error('A display name is 80 characters at most.'))
    renderPeople()
    fireEvent.click((await openDrawer('operator@site.test')).getByRole('button', { name: 'Change Name' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Display name'), { target: { value: 'Owain' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await within(dialog).findByText('A display name is 80 characters at most.')).toBeInTheDocument()
  })

  it('goes with Add Person when one is given, and a bad one stops the add', async () => {
    api.addPerson.mockResolvedValue({
      user_id: 'n0000000-0000-4000-8000-000000000003', email: 'new@site.test', role: 'Operator',
      invited: true, display_name: 'Nia Newcomer',
    })
    renderPeople()
    fireEvent.click(await screen.findByRole('button', { name: /Add Person/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Email'), { target: { value: 'new@site.test' } })
    const name = within(dialog).getByLabelText('Display name (optional)')
    // A tab: a text box drops a line break by itself.
    fireEvent.change(name, { target: { value: 'Nia\tNewcomer' } })
    expect(within(dialog).getByRole('button', { name: /Add Person/ })).toBeDisabled()
    fireEvent.change(name, { target: { value: ' Nia Newcomer ' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /Add Person/ }))
    await waitFor(() => expect(api.addPerson).toHaveBeenCalledWith('new@site.test', 'Operator', 'Nia Newcomer'))
    expect(await screen.findByText('Nia Newcomer (new@site.test) added')).toBeInTheDocument()
  })

  it('says so when the person was added and their name was not set', async () => {
    api.addPerson.mockResolvedValue({
      user_id: 'n0000000-0000-4000-8000-000000000004', email: 'new@site.test', role: 'Operator',
      invited: true, display_name: null,
      name_error: 'Their display name was not set. Open their row and select Change Name to set it.',
    })
    const toast = renderPeople()
    fireEvent.click(await screen.findByRole('button', { name: /Add Person/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Email'), { target: { value: 'new@site.test' } })
    fireEvent.change(within(dialog).getByLabelText('Display name (optional)'), { target: { value: 'Nia' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /Add Person/ }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(
      'Their display name was not set. Open their row and select Change Name to set it.', 'warning',
      { to: personUrl('new@site.test') }))
  })
})

describe('setting a new password', () => {
  const MINTED = 'h3k9qp-x2a7bn-c4d8ef-gm2jk6'

  it('is offered in each drawer, except your own and a removed person\'s, saying why', async () => {
    renderPeople()
    expect((await openDrawer('operator@site.test')).getByRole('button', { name: 'Set New Password' })).toBeEnabled()
    expect((await openDrawer('invited@site.test')).getByRole('button', { name: 'Set New Password' })).toBeEnabled()
    // Your own drawer links to Profile, where your own password is changed, instead of a dead button.
    const mine = await openDrawer('me@site.test')
    expect(mine.queryByRole('button', { name: 'Set New Password' })).toBeNull()
    expect(mine.getByRole('link', { name: /Open Profile/ })).toHaveAttribute('href', '/profile')
    await showRemoved()
    const removed = (await openDrawer('removed@site.test')).getByRole('button', { name: 'Set New Password' })
    expect(removed).toBeDisabled()
    expect(removed).toHaveAccessibleDescription(expect.stringMatching(/Restore it first/))
  })

  it('sets one only after it is confirmed, then shows it once', async () => {
    api.managePeople.mockResolvedValue({ user_id: OPERATOR, password: MINTED })
    const toast = renderPeople()
    const drawer = await openDrawer('operator@site.test')
    fireEvent.click(drawer.getByRole('button', { name: 'Set New Password' }))

    const confirm = await screen.findByRole('dialog')
    expect(confirm).toHaveTextContent('Set a new password for operator@site.test')
    expect(confirm).toHaveTextContent('current password stops working')
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    expect(api.managePeople).not.toHaveBeenCalled()

    fireEvent.click(drawer.getByRole('button', { name: 'Set New Password' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Set New Password' }))
    await waitFor(() =>
      expect(api.managePeople).toHaveBeenCalledWith({ action: 'set-password', user_id: OPERATOR }))

    const reveal = await screen.findByText('New password for operator@site.test')
    const dialog = reveal.closest('[role="dialog"]')
    expect(dialog).toHaveTextContent('it is not shown again')
    expect(within(dialog).getByLabelText('Password')).toHaveValue(MINTED)
    expect(within(dialog).getByLabelText('Email')).toHaveValue('operator@site.test')
    expect(toast).toHaveBeenCalledWith('operator@site.test has a new password', 'success', { to: personUrl('operator@site.test') })
    // Never in a toast.
    expect(JSON.stringify(toast.mock.calls)).not.toContain(MINTED)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByDisplayValue(MINTED)).toBeNull()
  })

  it('shows the refusal, and no password dialog, when none was set', async () => {
    api.managePeople.mockRejectedValue(new Error("this person's access is removed. Restore it first, then set a new password."))
    const toast = renderPeople()
    fireEvent.click((await openDrawer('operator@site.test')).getByRole('button', { name: 'Set New Password' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Set New Password' }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(
      "this person's access is removed. Restore it first, then set a new password.", 'error'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByLabelText('Password')).toBeNull()
  })
})

describe('a person\'s drawer', () => {
  it('opens on a click on the row, shows who they are, and closes on a second click', async () => {
    api.listPeople.mockResolvedValue(PEOPLE.map(p => (p.user_id === OPERATOR ? { ...p, display_name: 'Owain Operator' } : p)))
    renderPeople()
    const drawer = await openDrawer('operator@site.test')
    // The name is the title, and the email is always there beside it.
    expect(screen.getByRole('complementary', { name: 'Owain Operator person' })).toBeInTheDocument()
    expect(drawer.getByText('Email').nextElementSibling).toHaveTextContent('operator@site.test')
    expect(drawer.getByText('Display name').nextElementSibling).toHaveTextContent('Owain Operator')
    expect(drawer.getByText('Role').nextElementSibling).toHaveTextContent('Operator')
    expect(drawer.getByText('Status').nextElementSibling).toHaveTextContent('Active')
    expect(await drawer.findByText(/^2 open, last active /)).toBeInTheDocument()
    expect(api.personSessionSummary).toHaveBeenCalledWith(OPERATOR)
    expect((await row('operator@site.test')).className).toContain('row-selected')
    expect(window.location.search).toBe('?person=operator%40site.test')

    fireEvent.click(await row('operator@site.test'))
    await waitFor(() => expect(queryDrawer()).toBeNull())
    expect(window.location.search).toBe('')
  })

  it('opens with Enter on the row', async () => {
    renderPeople()
    fireEvent.keyDown(await row('operator@site.test'), { key: 'Enter' })
    expect(await screen.findByRole('complementary', { name: 'operator@site.test person' })).toBeInTheDocument()
  })

  it('opens from the address personUrl() writes, a removed person\'s with the removed', async () => {
    window.history.replaceState(null, '', personUrl('removed@site.test', true))
    renderPeople()
    const drawer = within(await screen.findByRole('complementary', { name: 'removed@site.test person' }))
    expect(drawer.getByText('Status').nextElementSibling).toHaveTextContent('Access removed')
    expect(drawer.getByText('Shopfloor Manager when restored')).toBeInTheDocument()
    expect(within(await row('removed@site.test')).getByText('Access removed')).toBeInTheDocument()
  })

  it('tidies away an address for nobody on the list', async () => {
    window.history.replaceState(null, '', '/access-control?person=nobody%40site.test')
    renderPeople()
    await row('operator@site.test')
    await waitFor(() => expect(window.location.search).toBe(''))
    expect(queryDrawer()).toBeNull()
  })

  it('offers every action, two to a row, with Remove Access last and on its own', async () => {
    renderPeople()
    const drawer = await openDrawer('operator@site.test')
    const names = drawer.getAllByRole('button').map(b => b.textContent.trim()).filter(Boolean)
    expect(names).toEqual(['Change Name', 'Change Email', 'Change Role', 'Set New Password', 'End Sessions', 'Remove Access'])
    expect(drawer.getByRole('button', { name: 'Remove Access' })).toHaveClass('context-action-danger')
    expect(drawer.getByRole('button', { name: 'Change Role' })).not.toHaveClass('context-action-danger')
    for (const name of names) expect(drawer.getByRole('button', { name })).toBeEnabled()
    // The row holds no control of its own, the role included.
    const operator = await row('operator@site.test')
    expect(within(operator).queryAllByRole('button')).toEqual([])
    expect(within(operator).queryAllByRole('combobox')).toEqual([])
  })

  it('in your own drawer, refuses what is refused for yourself and says why', async () => {
    renderPeople()
    const mine = await openDrawer('me@site.test')
    expect(screen.getByRole('complementary', { name: 'me@site.test person' })).toHaveTextContent('YOU')
    expect(mine.getByRole('button', { name: 'Change Name' })).toBeEnabled()
    const email = mine.getByRole('button', { name: 'Change Email' })
    expect(email).toBeDisabled()
    expect(email).toHaveAccessibleDescription('You cannot change your own email address. Ask another Administrator.')
    expect(mine.getByRole('button', { name: 'Change Role' })).toBeDisabled()
    const end = mine.getByRole('button', { name: 'End Sessions' })
    expect(end).toBeDisabled()
    expect(end).toHaveAccessibleDescription('You cannot end your own sessions here. Use Sign Out in the account menu.')
    expect(mine.getByRole('button', { name: 'Remove Access' })).toBeDisabled()
    expect(mine.getByRole('link', { name: /Open Profile/ })).toHaveAttribute('href', '/profile')
  })

  it('for a removed person, offers Restore Access and End Sessions, and no new address', async () => {
    renderPeople()
    await showRemoved()
    const drawer = await openDrawer('removed@site.test')
    expect(drawer.getByRole('button', { name: 'Restore Access' })).toBeEnabled()
    expect(drawer.getByRole('button', { name: 'End Sessions' })).toBeEnabled()
    const email = drawer.getByRole('button', { name: 'Change Email' })
    expect(email).toBeDisabled()
    expect(email).toHaveAccessibleDescription(expect.stringMatching(/Restore it first/))
    expect(drawer.getByRole('button', { name: 'Change Role' })).toBeDisabled()
    expect(drawer.queryByRole('button', { name: 'Remove Access' })).toBeNull()
  })

  it('says None when the person holds no session, and Not read when the count fails', async () => {
    api.personSessionSummary.mockResolvedValueOnce({ open_sessions: 0, last_active_at: null })
    renderPeople()
    const drawer = await openDrawer('operator@site.test')
    await waitFor(() => expect(drawer.getByText('Sessions').nextElementSibling).toHaveTextContent('None'))

    api.personSessionSummary.mockRejectedValueOnce(new Error('insufficient privileges to read a person\'s sessions'))
    const other = await openDrawer('invited@site.test')
    await waitFor(() => expect(other.getByText('Sessions').nextElementSibling).toHaveTextContent('Not read'))
  })
})

describe('ending a person\'s sessions', () => {
  it('asks first, says what ends, then ends them all and reads the count again', async () => {
    api.endPersonSessions.mockResolvedValue(3)
    const toast = renderPeople()
    const drawer = await openDrawer('operator@site.test')
    fireEvent.click(drawer.getByRole('button', { name: 'End Sessions' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('End every session for operator@site.test')
    expect(dialog).toHaveTextContent('the dashboard in each browser, and Studio, the forge, Node-RED and Grafana')
    expect(dialog).toHaveTextContent('The API refuses their access at once')
    expect(dialog).toHaveTextContent('Grafana within the hour')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(api.endPersonSessions).not.toHaveBeenCalled()

    api.personSessionSummary.mockResolvedValue({ open_sessions: 0, last_active_at: null })
    fireEvent.click(drawer.getByRole('button', { name: 'End Sessions' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'End Sessions' }))
    await waitFor(() => expect(api.endPersonSessions).toHaveBeenCalledWith(OPERATOR))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(
      'operator@site.test is signed out everywhere: 3 sessions ended', 'success', { to: personUrl('operator@site.test') }))
    await waitFor(() => expect(drawer.getByText('Sessions').nextElementSibling).toHaveTextContent('None'))
  })

  it('shows the database refusing it', async () => {
    api.endPersonSessions.mockRejectedValue(new Error('insufficient privileges to end a person\'s sessions'))
    const toast = renderPeople()
    fireEvent.click((await openDrawer('operator@site.test')).getByRole('button', { name: 'End Sessions' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'End Sessions' }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith('insufficient privileges to end a person\'s sessions', 'error'))
  })
})

describe('changing a person\'s email address', () => {
  async function openChangeEmail() {
    const drawer = await openDrawer('operator@site.test')
    fireEvent.click(drawer.getByRole('button', { name: 'Change Email' }))
    return within(await screen.findByRole('dialog'))
  }

  it('says they will sign in again, sends the address trimmed and lower-cased, and the drawer follows it', async () => {
    api.changePersonEmail.mockResolvedValue({
      user_id: OPERATOR, email: 'owain@site.test', previous_email: 'operator@site.test', sessions_ended: 2,
    })
    window.history.replaceState(null, '', personUrl('operator@site.test'))
    const toast = renderPeople()
    await screen.findByRole('complementary', { name: 'operator@site.test person' })
    fireEvent.click(within(queryDrawer()).getByRole('button', { name: 'Change Email' }))
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByText(/they will have to sign in again/)).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: 'Change Email' })).toBeDisabled()

    api.listPeople.mockResolvedValue(PEOPLE.map(p => (p.user_id === OPERATOR ? { ...p, email: 'owain@site.test' } : p)))
    fireEvent.change(dialog.getByLabelText('New email address'), { target: { value: '  Owain@Site.TEST ' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Change Email' }))
    await waitFor(() => expect(api.changePersonEmail).toHaveBeenCalledWith(OPERATOR, 'owain@site.test'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(toast).toHaveBeenCalledWith('operator@site.test is now owain@site.test. They sign in again with it.', 'success',
      { to: personUrl('owain@site.test') })
    // The drawer and the search move to the new address rather than closing.
    expect(await screen.findByRole('complementary', { name: 'owain@site.test person' })).toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).get('person')).toBe('owain@site.test')
    expect(new URLSearchParams(window.location.search).get('search')).toBe('owain@site.test')
    expect(await row('owain@site.test')).toBeTruthy()
  })

  it('refuses before sending an address that is not one, or the one they have', async () => {
    renderPeople()
    const dialog = await openChangeEmail()
    const input = dialog.getByLabelText('New email address')
    fireEvent.change(input, { target: { value: 'not an address' } })
    expect(dialog.getByText('That is not an email address.')).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: 'Change Email' })).toBeDisabled()
    fireEvent.change(input, { target: { value: 'OPERATOR@site.test' } })
    expect(dialog.getByText('That is already their email address.')).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: 'Change Email' })).toBeDisabled()
    expect(api.changePersonEmail).not.toHaveBeenCalled()
  })

  it('keeps the dialog open with the reason when it is refused', async () => {
    api.changePersonEmail.mockRejectedValue(new Error('second@site.test already belongs to another account'))
    renderPeople()
    const dialog = await openChangeEmail()
    fireEvent.change(dialog.getByLabelText('New email address'), { target: { value: 'second@site.test' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Change Email' }))
    expect(await dialog.findByText('second@site.test already belongs to another account')).toBeInTheDocument()
  })
})

describe('changing a person\'s role', () => {
  const NAMED = PEOPLE.map(p => (p.user_id === OPERATOR ? { ...p, display_name: 'Owain Operator' } : p))

  async function openChangeRole(email = 'operator@site.test') {
    fireEvent.click((await openDrawer(email)).getByRole('button', { name: 'Change Role' }))
    return within(await screen.findByRole('dialog'))
  }

  it('asks first, starting on their role, and says what the chosen one changes before anything is sent', async () => {
    api.listPeople.mockResolvedValue(NAMED)
    renderPeople()
    const dialog = await openChangeRole()
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Change the role for Owain Operator (operator@site.test)')
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription(/Nothing changes until you select Change Role/)

    // The four roles, theirs chosen and focused, with its description under it as Add Person shows.
    const select = dialog.getByLabelText('Role')
    expect(select).toHaveFocus()
    expect(select).toHaveValue('Operator')
    expect(within(select).getAllByRole('option').map(o => o.textContent))
      .toEqual(['Administrator', 'Shopfloor Manager', 'Operator', 'Auditor'])
    expect(select).toHaveAccessibleDescription(PERSON_ROLES.find(r => r.name === 'Operator').description)
    expect(dialog.getByRole('button', { name: 'Change Role' })).toBeDisabled()
    expect(dialog.queryByText(/becomes/)).toBeNull()

    fireEvent.change(select, { target: { value: 'Auditor' } })
    expect(select).toHaveAccessibleDescription(PERSON_ROLES.find(r => r.name === 'Auditor').description)
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'Owain Operator becomes an Auditor. They can read the Audit Trail, including who was given access, and '
      + 'change nothing, from their next request. Node-RED follows within a minute, and Grafana when they next '
      + 'sign in to it.')
    expect(dialog.getByRole('button', { name: 'Change Role' })).toBeEnabled()

    // Back to their own role, Change Role waits again.
    fireEvent.change(select, { target: { value: 'Operator' } })
    expect(dialog.getByRole('button', { name: 'Change Role' })).toBeDisabled()
    expect(dialog.queryByText(/becomes/)).toBeNull()

    fireEvent.change(select, { target: { value: 'Shopfloor_Manager' } })
    expect(screen.getByRole('dialog')).toHaveTextContent('Owain Operator becomes a Shopfloor Manager.')
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.setPersonRole).not.toHaveBeenCalled()
  })

  it('sets it through the database, with the toast the row\'s select gave, and reads the list again', async () => {
    api.setPersonRole.mockResolvedValue(true)
    const toast = renderPeople()
    const dialog = await openChangeRole()
    fireEvent.change(dialog.getByLabelText('Role'), { target: { value: 'Auditor' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Change Role' }))
    await waitFor(() => expect(api.setPersonRole).toHaveBeenCalledWith(OPERATOR, 'Auditor'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(toast).toHaveBeenCalledWith('operator@site.test is now Auditor', 'success', { to: personUrl('operator@site.test') })
    await waitFor(() => expect(api.listPeople).toHaveBeenCalledTimes(2))
  })

  it('keeps the dialog open with the database\'s sentence when it is refused', async () => {
    api.setPersonRole.mockRejectedValue(new Error('this would leave no Administrator who can sign in.'))
    const toast = renderPeople()
    const dialog = await openChangeRole('second@site.test')
    fireEvent.change(dialog.getByLabelText('Role'), { target: { value: 'Operator' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Change Role' }))
    expect(await dialog.findByText('this would leave no Administrator who can sign in.')).toBeInTheDocument()
    expect(dialog.getByLabelText('Role')).toHaveValue('Operator')
    expect(toast).not.toHaveBeenCalled()
  })

  it('starts on No role for a person who holds none', async () => {
    api.listPeople.mockResolvedValue(PEOPLE.map(p => (p.user_id === INVITED ? { ...p, role: null } : p)))
    renderPeople()
    expect((await row('invited@site.test')).cells[1]).toHaveTextContent(/^No role$/)
    const dialog = await openChangeRole('invited@site.test')
    const select = dialog.getByLabelText('Role')
    expect(select).toHaveValue('')
    expect(select).toHaveAccessibleDescription('They hold no role now.')
    expect(dialog.getByRole('button', { name: 'Change Role' })).toBeDisabled()
    fireEvent.change(select, { target: { value: 'Administrator' } })
    expect(screen.getByRole('dialog')).toHaveTextContent('invited@site.test becomes an Administrator. They can do everything')
    expect(dialog.getByRole('button', { name: 'Change Role' })).toBeEnabled()
  })

  it('is refused for yourself, a removed person and the last Administrator who can sign in, in the select\'s words', async () => {
    // Your own Administrator row is removed here, so the second is the last who can sign in.
    api.listPeople.mockResolvedValue(PEOPLE.map(p => (p.user_id === ME
      ? { ...p, role: null, status: 'removed', sign_in_blocked: true, role_on_restore: 'Administrator' }
      : p)))
    renderPeople()
    const last = (await openDrawer('second@site.test')).getByRole('button', { name: 'Change Role' })
    expect(last).toBeDisabled()
    expect(last).toHaveAccessibleDescription('The only Administrator who can sign in. Make someone else an Administrator first.')
    fireEvent.click(last)
    expect(screen.queryByRole('dialog')).toBeNull()

    await showRemoved()
    const removed = (await openDrawer('removed@site.test')).getByRole('button', { name: 'Change Role' })
    expect(removed).toBeDisabled()
    expect(removed).toHaveAccessibleDescription('Their access is removed. Restore it first, then change their role.')

    const mine = (await openDrawer('me@site.test')).getByRole('button', { name: 'Change Role' })
    expect(mine).toBeDisabled()
    expect(mine).toHaveAccessibleDescription('You cannot change your own role. Ask another Administrator.')
    expect(api.setPersonRole).not.toHaveBeenCalled()
  })
})

describe('the people rules', () => {
  it('offers the four roles the database accepts, in the dashboard\'s order', () => {
    expect(PERSON_ROLES.map(r => r.name)).toEqual(Object.keys(DEFAULT_ROLE_PERMISSIONS_MAP))
  })

  it('says what each role lets a person do, and from when, for Change Role', () => {
    for (const r of PERSON_ROLES) expect(r.consequence).toMatch(/^They can .+, from their next request\.$/)
    expect(PERSON_ROLES.map(r => personRoleWithArticle(r.name)))
      .toEqual(['an Administrator', 'a Shopfloor Manager', 'an Operator', 'an Auditor'])
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

  it('sets anyone a new password but yourself and a removed person, even the last Administrator', () => {
    const solo = [person(ME, 'me@site.test', 'Administrator', 'active')]
    expect(passwordSetBlocked(solo[0], OTHER_ADMIN)).toBeNull()
    expect(passwordSetBlocked(solo[0], ME)).toMatch(/your own password/)
    expect(passwordSetBlocked(PEOPLE[4], ME)).toMatch(/Restore it first/)
    expect(passwordSetBlocked(PEOPLE[5], ME)).toMatch(/Restore it first/)
    expect(passwordSetBlocked(PEOPLE[3], ME)).toBeNull()
  })
})
