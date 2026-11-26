import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import { RestoreEntityModal } from '../components/modals/RestoreEntityModal'
import { api } from '../api'

/**
 * What the Restore dialog tells a person to do next, and what the drawer then offers. Archiving
 * disables a gateway's broker account and stamps credential_revoked_at, and a restore leaves the
 * stamp (0308). A restored Remote gateway that had enrolled therefore has an enrolment older than the
 * stamp, and the drawer offers Set Up Gateway. A restored Host, Simulated or Third-party gateway is
 * offered Generate Broker Credential. The dialog names each, so what it says can be followed.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), enrolmentReadiness: vi.fn(), gatewayHoldsBrokerCredential: vi.fn() }
  }
})

const UUID = 'bbbbbbbb-0000-4000-8000-000000001558'

// A gateway as a restore leaves it: no longer archived, its stamp as archiving wrote it.
const restored = (overrides = {}) => ({
  gateway_id: UUID,
  gateway_name: 'Production_Flow',
  sparkplug_id: 'gwybbbbbbbb00004000800002',
  sparkplug_group: 'Aber',
  status: 'OFFLINE',
  deployment: 'remote',
  is_simulated: false,
  is_shadow: false,
  is_archived: false,
  cell_id: 'cell-1',
  location_scope: 'cell',
  access_url: '',
  enrolled_at: '2026-11-01T09:00:00Z',
  credential_revoked_at: '2026-11-05T09:00:00Z',
  devices: [],
  ...overrides
})

const openDrawer = async (row) => {
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/cells')) return Promise.resolve([{ cell_id: 'cell-1', cell_name: 'Assembly' }])
    if (path.startsWith('/api/v1/gateways')) return Promise.resolve([row])
    return Promise.resolve([])
  })
  api.enrolmentReadiness.mockResolvedValue({ ready: true, addresses: [] })
  api.gatewayHoldsBrokerCredential.mockResolvedValue(false)
  render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} userRole="Shopfloor_Manager" />)
  await waitFor(() => expect(screen.getAllByText(row.gateway_name).length).toBeGreaterThan(0))
  fireEvent.click(within(document.querySelector('.page-main')).getByText(row.gateway_name))
  return within(document.querySelector('.context-panel'))
}

const dialogText = () => {
  render(<RestoreEntityModal type="gateway" name="Production_Flow" credentialRevoked onConfirm={vi.fn()} onCancel={vi.fn()} />)
  return screen.getByRole('dialog', { name: /^Restore Gateway — / }).textContent
}

beforeEach(() => vi.clearAllMocks())

describe('a Remote gateway that had enrolled, restored', () => {
  it('is offered Set Up Gateway, since the revocation is newer than its enrolment', async () => {
    const panel = await openDrawer(restored())
    expect(panel.getByRole('button', { name: /Set Up Gateway/ })).toBeInTheDocument()
  })

  it('is offered no setup while it is online, since setting it up would replace a working credential', async () => {
    const panel = await openDrawer(restored({ status: 'ONLINE', last_heartbeat: new Date().toISOString() }))
    expect(panel.queryByRole('button', { name: /Set Up Gateway|Re-issue Setup/ })).toBeNull()
  })
})

describe('a restored gateway issued its credential in the dashboard', () => {
  it.each([
    ['Host', { deployment: 'host' }],
    ['Simulated', { deployment: 'host', is_simulated: true }],
    ['Third-party', { deployment: 'third_party' }],
  ])('is offered Generate Broker Credential: %s', async (_type, overrides) => {
    const panel = await openDrawer(restored({ enrolled_at: null, ...overrides }))
    expect(panel.getByRole('button', { name: /Generate Broker Credential/ })).toBeInTheDocument()
  })
})

describe('the Restore dialog for a gateway whose credential was revoked', () => {
  it('names Host, Simulated and Third-party where a credential is issued again, and Set Up Gateway for Remote', () => {
    const text = dialogText()
    expect(text).toContain('(Generate Broker Credential) for a Host, Simulated or Third-party gateway')
    expect(text).toContain('set a Remote gateway up again from its drawer (Set Up Gateway)')
  })

  it('says nothing of a credential for a gateway that never had one revoked', () => {
    render(<RestoreEntityModal type="gateway" name="Production_Flow" onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByRole('dialog', { name: /^Restore Gateway — / }).textContent).not.toMatch(/broker credential/)
  })
})
