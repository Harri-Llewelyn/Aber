/**
 * Access Control's lists can be searched and filtered, and what is gone is hidden the same way on
 * every tab: removed people, archived gateways and withdrawn identities each sit behind a "Show
 * ... (N)" toggle. The filters are in the address, so F5 and Back return to the same view, which is
 * why the page has no Refresh button.
 */
import React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { AccessControlTab } from '../components/tabs/AccessControlTab'
import { api } from '../api'

vi.mock('../api', () => ({
  api: {
    listPeople: vi.fn(),
    setPersonRole: vi.fn(),
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
  default: ({ value }) => <span>{value}</span>,
  copyText: vi.fn().mockResolvedValue(true),
}))

const ME = 'a0000000-0000-4000-8000-000000000001'

const person = (n, email, role, status, extra = {}) => ({
  user_id: `a0000000-0000-4000-8000-00000000000${n}`, email, role, status, sign_in_blocked: false,
  role_on_restore: null, invited_at: null,
  last_sign_in_at: status === 'active' ? '2026-10-01T09:00:00Z' : null, ...extra,
})

const PEOPLE = [
  person(1, 'me@site.test', 'Administrator', 'active'),
  person(2, 'lead@site.test', 'Shopfloor_Manager', 'active'),
  person(3, 'operator.one@site.test', 'Operator', 'active'),
  person(4, 'operator.two@site.test', 'Operator', 'invited', { invited_at: '2026-10-06T09:00:00Z' }),
  person(5, 'newcomer@site.test', 'Auditor', 'invited'),
  person(6, 'gone@site.test', null, 'removed', { sign_in_blocked: true, role_on_restore: 'Operator' }),
  person(7, 'leaving@site.test', null, 'removed', { sign_in_blocked: false, role_on_restore: 'Operator' }),
]

const gateway = (n, name, extra = {}) => ({
  id: `1${n}000000-0000-4000-8000-000000000001`, name, sparkplug_id: `gwy1${n}0000000000400080000`,
  deployment: 'host', is_archived: false, status: 'ONLINE', enrolled_at: null,
  credential_revoked_at: null, issued_at: null, ...extra,
})

const IDENTITY = (n, name) => ({
  principal_id: `c000000${n}-0000-4000-8000-000000000001`, name, purpose: `${name}, for tests`,
  permissions: ['telemetry:read'], can_sign_in: false,
})

beforeEach(() => {
  vi.clearAllMocks()
  api.listPeople.mockResolvedValue(PEOPLE)
  api.listGatewayCredentials.mockResolvedValue([])
  api.listBrokerInventory.mockResolvedValue({ clients: [], roles: [], read_at: '2026-09-12T00:00:00Z' })
  api.listServicePrincipals.mockResolvedValue([])
  api.listServiceTokens.mockResolvedValue(new Map())
  api.listRevokedServiceTokens.mockResolvedValue(new Set())
  api.listRevokedServicePrincipals.mockResolvedValue(new Map())
})

const renderPage = () =>
  render(<AccessControlTab showToast={vi.fn()} userRole="Administrator" currentUserId={ME} />)

/** The emails the People table lists, in order. */
const listed = () => [...document.querySelectorAll('tbody tr td:first-child span:first-child')].map(s => s.textContent)
const query = () => Object.fromEntries(new URLSearchParams(window.location.search))

describe('People', () => {
  it('hides removed accounts behind Show removed, and keeps a removal that has not finished', async () => {
    renderPage()
    await screen.findByText('me@site.test')
    expect(listed()).not.toContain('gone@site.test')
    // Sign-in still open needs Remove Access again, so it is never hidden.
    expect(listed()).toContain('leaving@site.test')

    fireEvent.click(screen.getByRole('button', { name: 'Show removed (1)' }))
    expect(listed()).toContain('gone@site.test')
    expect(screen.getByRole('button', { name: 'Show removed (1)' })).toHaveAttribute('aria-pressed', 'true')
    expect(query()).toEqual({ removed: '1' })
  })

  it('offers Show removed only while an account is removed', async () => {
    api.listPeople.mockResolvedValue(PEOPLE.filter(p => p.status !== 'removed'))
    renderPage()
    await screen.findByText('me@site.test')
    expect(screen.queryByRole('button', { name: /Show removed/ })).toBeNull()
  })

  it('searches the email address', async () => {
    renderPage()
    await screen.findByText('me@site.test')
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search people by name or email' }), { target: { value: 'OPERATOR' } })
    expect(listed()).toEqual(['operator.one@site.test', 'operator.two@site.test'])
    expect(query()).toEqual({ search: 'OPERATOR' })
  })

  it('filters by role, with All roles, the four roles and No role, each with its count', async () => {
    renderPage()
    await screen.findByText('me@site.test')
    const role = screen.getByLabelText('Filter people by role')
    expect([...role.options].map(o => o.textContent)).toEqual([
      'All roles (6)', 'Administrator (1)', 'Shopfloor Manager (1)', 'Operator (2)', 'Auditor (1)', 'No role (1)',
    ])

    fireEvent.change(role, { target: { value: 'Operator' } })
    expect(listed()).toEqual(['operator.one@site.test', 'operator.two@site.test'])
    fireEvent.change(role, { target: { value: 'none' } })
    expect(listed()).toEqual(['leaving@site.test'])
  })

  it('filters by the Status column\'s labels, and offers Access removed only while removed accounts are shown', async () => {
    renderPage()
    await screen.findByText('me@site.test')
    const status = screen.getByLabelText('Filter people by status')
    expect([...status.options].map(o => o.textContent)).toEqual([
      'Any status (6)', 'Active (3)', 'Invited (1)', 'Not signed in yet (1)', 'Sign-in still open (1)',
    ])

    fireEvent.change(status, { target: { value: 'not-signed-in' } })
    expect(listed()).toEqual(['newcomer@site.test'])

    fireEvent.click(screen.getByRole('button', { name: 'Show removed (1)' }))
    expect([...status.options].map(o => o.textContent)).toContain('Access removed (1)')
    fireEvent.change(status, { target: { value: 'removed' } })
    expect(listed()).toEqual(['gone@site.test'])

    // Turning the toggle off takes Access removed with it, and the filter falls back to any status.
    fireEvent.click(screen.getByRole('button', { name: 'Show removed (1)' }))
    await waitFor(() => expect(status.value).toBe(''))
    expect(query()).toEqual({})
  })

  it('says when the filters match nobody, and Clear filters resets everything, the toggle included', async () => {
    renderPage()
    await screen.findByText('me@site.test')
    fireEvent.click(screen.getByRole('button', { name: 'Show removed (1)' }))
    fireEvent.change(screen.getByLabelText('Filter people by role'), { target: { value: 'Auditor' } })
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search people by name or email' }), { target: { value: 'nobody' } })
    expect(screen.getByText('No person matches these filters.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Clear filters \(3\)/ }))
    expect(screen.getByRole('button', { name: 'Show removed (1)' })).toHaveAttribute('aria-pressed', 'false')
    expect(listed()).toHaveLength(6)
    expect(query()).toEqual({})
  })

  it('opens on the filters the address names, so a reload keeps them', async () => {
    window.history.replaceState(null, '', '/access-control?role=Operator&status=invited')
    renderPage()
    await screen.findByText('operator.two@site.test')
    expect(listed()).toEqual(['operator.two@site.test'])
    expect(screen.getByLabelText('Filter people by role')).toHaveValue('Operator')
  })

  it('has no Refresh button', async () => {
    renderPage()
    await screen.findByText('me@site.test')
    expect(screen.queryByRole('button', { name: /Refresh/ })).toBeNull()
  })
})

describe('Broker credentials', () => {
  beforeEach(() => {
    api.listGatewayCredentials.mockResolvedValue([
      gateway(1, 'Line 1 Press'),
      gateway(2, 'Paint Shop Robot'),
      gateway(3, 'Old Line', { is_archived: true }),
    ])
  })

  const openCredentials = async () => {
    window.history.replaceState(null, '', '/access-control/credentials')
    renderPage()
    await screen.findByText('Line 1 Press')
  }
  const names = () => [...document.querySelectorAll('tbody tr td:first-child > div:first-child')].map(d => d.textContent)

  it('searches by gateway name and by MQTT username', async () => {
    await openCredentials()
    const search = screen.getByRole('searchbox', { name: /Search credentials/ })
    fireEvent.change(search, { target: { value: 'paint' } })
    expect(names()).toEqual(['Paint Shop Robot'])
    fireEvent.change(search, { target: { value: 'gwy11' } })
    expect(names()).toEqual(['Line 1 Press'])
  })

  it('hides archived gateways behind Show archived, beside the state filter', async () => {
    await openCredentials()
    expect(names()).toEqual(['Line 1 Press', 'Paint Shop Robot'])
    fireEvent.click(screen.getByRole('button', { name: 'Show archived (1)' }))
    expect(names()).toEqual(['Line 1 Press', 'Paint Shop Robot', 'Old Line'])
    expect(query()).toEqual({ archived: '1' })
  })

  it('has no Refresh button', async () => {
    await openCredentials()
    expect(screen.queryByRole('button', { name: /Refresh/ })).toBeNull()
  })
})

describe('Machine identities', () => {
  beforeEach(() => {
    api.listServicePrincipals.mockResolvedValue([IDENTITY(1, 'Line 4 OEE report'), IDENTITY(2, 'Historian export')])
    api.listRevokedServicePrincipals.mockResolvedValue(new Map([[
      IDENTITY(2).principal_id,
      { principal_id: IDENTITY(2).principal_id, revoked_at: '2026-09-03T12:00:00Z', reason: 'leaked' },
    ]]))
  })

  const openIdentities = async () => {
    window.history.replaceState(null, '', '/access-control/identities')
    renderPage()
    await screen.findByText('Line 4 OEE report')
  }

  it('hides a withdrawn identity behind Show withdrawn', async () => {
    await openIdentities()
    await waitFor(() => expect(screen.queryByText('Historian export')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Show withdrawn (1)' }))
    expect(within(screen.getByText('Historian export').closest('tr')).getByText('WITHDRAWN')).toBeInTheDocument()
  })

  it('searches by name', async () => {
    await openIdentities()
    fireEvent.click(await screen.findByRole('button', { name: 'Show withdrawn (1)' }))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search machine identities by name' }), { target: { value: 'histor' } })
    expect(screen.queryByText('Line 4 OEE report')).toBeNull()
    expect(screen.getByText('Historian export')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search machine identities by name' }), { target: { value: 'nothing like it' } })
    expect(screen.getByText('No machine identity matches these filters.')).toBeInTheDocument()
  })
})
