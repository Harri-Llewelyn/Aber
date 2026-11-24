import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import { AccessControlTab } from '../components/tabs/AccessControlTab'
import { GatewayBundleModal } from '../components/modals/GatewayBundleModal'
import { setupRevokesCredential } from '../utils/credentialState'
import { api } from '../api'

/**
 * Setting a Remote gateway up revokes the credential its enrolled appliance holds, at once. The setup
 * dialog says so from the gateway's own row, so it says it from the Gateways drawer, from Access
 * Control's Bundle and straight after registering alike. The same states are tried at each.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: {
      get: vi.fn(), post: vi.fn(), put: vi.fn(), enrolmentReadiness: vi.fn(), gatewayHoldsBrokerCredential: vi.fn(),
      downloadGatewayBundle: vi.fn(), installCommand: vi.fn(), listGatewayCredentials: vi.fn(),
      listBrokerInventory: vi.fn(), listServicePrincipals: vi.fn(), listServiceTokens: vi.fn(),
      listRevokedServiceTokens: vi.fn(), listRevokedServicePrincipals: vi.fn(),
    }
  }
})

const ID = 'bbbbbbbb-0000-4000-8000-000000001604'
const NAME = 'Production_Flow'
const ENROLLED = '2026-11-01T09:00:00Z'
const REVOKED = '2026-11-05T09:00:00Z'
const REVOKES = /this also revokes the broker credential its appliance is holding/

/** Each state a Remote gateway is set up in, whether the setup revokes, and what its drawer names it. */
const STATES = [
  { what: 'online', revokes: true, action: null,
    row: { status: 'ONLINE', enrolled_at: ENROLLED, last_heartbeat: 'now' } },
  { what: 'stale, its heartbeat long past', revokes: true, action: 'Re-issue Setup',
    row: { status: 'ONLINE', enrolled_at: ENROLLED, last_heartbeat: ENROLLED } },
  { what: 'offline, but enrolled', revokes: true, action: 'Re-issue Setup',
    row: { status: 'OFFLINE', enrolled_at: ENROLLED, last_heartbeat: ENROLLED } },
  { what: 'enrolled and not published yet', revokes: true, action: 'Re-issue Setup',
    row: { status: 'AWAITING_BIRTH', enrolled_at: ENROLLED } },
  { what: 'enrolled again after a revocation', revokes: true, action: 'Re-issue Setup',
    row: { status: 'OFFLINE', enrolled_at: '2026-11-06T09:00:00Z', credential_revoked_at: REVOKED, last_heartbeat: ENROLLED } },
  { what: 'never enrolled, and never set up', revokes: false, action: 'Set Up Gateway',
    row: { status: 'OFFLINE' } },
  { what: 'never enrolled, with a setup issued', revokes: false, action: 'Set Up Gateway',
    row: { status: 'PENDING_ENROLLMENT' } },
  { what: 'set up again already, and waiting', revokes: false, action: 'Set Up Gateway',
    row: { status: 'PENDING_ENROLLMENT', enrolled_at: ENROLLED, credential_revoked_at: REVOKED, last_heartbeat: ENROLLED } },
  { what: 'archived and restored', revokes: false, action: 'Set Up Gateway',
    row: { status: 'OFFLINE', enrolled_at: ENROLLED, credential_revoked_at: REVOKED, last_heartbeat: ENROLLED } },
  { what: 'archived and restored before it published', revokes: false, action: 'Set Up Gateway',
    row: { status: 'AWAITING_BIRTH', enrolled_at: ENROLLED, credential_revoked_at: REVOKED } },
]

const facts = (row) => ({
  sparkplug_id: 'gwybbbbbbbb00004000801604', sparkplug_group: 'Aber', deployment: 'remote', is_simulated: false,
  is_shadow: false, is_archived: false, enrolled_at: null, credential_revoked_at: null, ...row,
  last_heartbeat: row.last_heartbeat === 'now' ? new Date().toISOString() : row.last_heartbeat ?? null
})

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/')
  api.enrolmentReadiness.mockResolvedValue({ ready: true, addresses: [] })
  api.gatewayHoldsBrokerCredential.mockResolvedValue(false)
  api.listBrokerInventory.mockResolvedValue({ clients: [], roles: [], read_at: ENROLLED })
  for (const read of ['listServicePrincipals', 'listServiceTokens', 'listRevokedServiceTokens', 'listRevokedServicePrincipals']) {
    api[read].mockResolvedValue([])
  }
  api.downloadGatewayBundle.mockResolvedValue({
    blob: new Blob(['PK']), filename: 'aber-gateway-production-flow.zip',
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), sparkplugId: 'gwybbbbbbbb00004000801604'
  })
  // The download is a blob URL and an anchor click; both are stubbed so nothing navigates.
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:bundle')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

/** What the dialog asks, once its typed gate is on screen: nothing is issued until the name is typed. */
const askedWith = async () => {
  const dialog = await screen.findByRole('dialog')
  within(dialog).getByLabelText(`Type ${NAME} to confirm`)
  expect(within(dialog).getByRole('button', { name: /Issue & Download/ })).toBeDisabled()
  expect(api.downloadGatewayBundle).not.toHaveBeenCalled()
  return dialog.textContent
}

const openDrawer = async (rows) => {
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/cells')) return Promise.resolve([{ cell_id: 'cell-1', cell_name: 'Assembly' }])
    if (path.startsWith('/api/v1/gateways')) return Promise.resolve(rows)
    return Promise.resolve([])
  })
  render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} userRole="Shopfloor_Manager" />)
  const list = () => within(document.querySelector('.page-main'))
  await waitFor(() => expect(list().getByText(NAME)).toBeInTheDocument())
  fireEvent.click(list().getByText(NAME))
  return within(document.querySelector('.context-panel'))
}

const inDrawer = (row) => ({
  gateway_id: ID, gateway_name: NAME, cell_id: 'cell-1', location_scope: 'cell', access_url: '', devices: [], ...facts(row)
})

const openAccessControl = async (row) => {
  api.listGatewayCredentials.mockResolvedValue([{ id: ID, name: NAME, issued_at: null, ...facts(row) }])
  api.get.mockResolvedValue([])
  window.history.replaceState(null, '', '/access-control/credentials')
  render(<AccessControlTab showToast={vi.fn()} hasPermission={() => true} userRole="Administrator" />)
  await screen.findByText(NAME)
}

const expectSaid = (text, revokes) => {
  expect(text).toMatch(/invalidates any bundle or\s+command already issued/)
  if (revokes) expect(text).toMatch(REVOKES)
  else expect(text).not.toMatch(/revokes/)
}

describe.each(STATES)('a Remote gateway $what', ({ revokes, action, row }) => {
  it(`Access Control's Bundle ${revokes ? 'says its credential is revoked' : 'says nothing of a credential'}`, async () => {
    await openAccessControl(row)
    fireEvent.click(await screen.findByRole('button', { name: 'Bundle' }))
    expectSaid(await askedWith(), revokes)
  })

  it(action
    ? `the drawer's ${action} ${revokes ? 'says its credential is revoked' : 'says nothing of a credential'}`
    : 'the drawer offers no setup', async () => {
    const panel = await openDrawer([inDrawer(row)])
    if (!action) {
      expect(panel.queryByRole('button', { name: /Set Up Gateway|Re-issue Setup/ })).toBeNull()
      return
    }
    fireEvent.click(panel.getByRole('button', { name: action }))
    expectSaid(await askedWith(), revokes)
  })

  it('setupRevokesCredential() answers the same', () => {
    expect(setupRevokesCredential(facts(row))).toBe(revokes)
  })
})

describe('an archived Remote gateway', () => {
  const archived = { status: 'OFFLINE', enrolled_at: ENROLLED, credential_revoked_at: REVOKED, is_archived: true }

  it('is offered no setup on Access Control', async () => {
    window.history.replaceState(null, '', '/access-control/credentials')
    api.listGatewayCredentials.mockResolvedValue([{ id: ID, name: NAME, issued_at: null, ...facts(archived) }])
    api.get.mockResolvedValue([])
    render(<AccessControlTab showToast={vi.fn()} hasPermission={() => true} userRole="Administrator" />)
    fireEvent.click(await screen.findByRole('button', { name: /Show archived/ }))
    expect(await screen.findByText('Restore to issue')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Bundle' })).toBeNull()
  })

  it('is offered no setup in its drawer', async () => {
    window.history.replaceState(null, '', '/gateways?lifecycle=archived')
    const panel = await openDrawer([inDrawer({ ...archived, archived_at: REVOKED })])
    expect(panel.getByRole('button', { name: /Restore Gateway/ })).toBeInTheDocument()
    expect(panel.queryByRole('button', { name: /Set Up Gateway|Re-issue Setup/ })).toBeNull()
  })
})

describe('straight after registering a Remote gateway', () => {
  it('issues on open, and a re-issue from the same dialog has nothing to revoke', async () => {
    render(
      <GatewayBundleModal gateway={{ gateway_id: ID, gateway_name: NAME, sparkplug_id: 'gwybbbbbbbb00004000801604' }}
                          onClose={vi.fn()} showToast={vi.fn()} />
    )
    fireEvent.click(await screen.findByRole('button', { name: /Re-issue Bundle/ }))
    const dialog = screen.getByRole('dialog')
    await within(dialog).findByLabelText(`Type ${NAME} to confirm`)
    expectSaid(dialog.textContent, false)
  })
})

describe('setupRevokesCredential()', () => {
  it('is false for no gateway, as the drawer asks it with none open', () => {
    expect(setupRevokesCredential(null)).toBe(false)
  })
})
