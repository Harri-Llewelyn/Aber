import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import { EntitiesTab } from '../components/tabs/EntitiesTab'
import { AccessControlTab } from '../components/tabs/AccessControlTab'
import { GatewayBundleModal } from '../components/modals/GatewayBundleModal'
import { CLEAR_BUNDLE_ENROLMENT, CLEAR_INSTALLED_ENROLMENT } from '../utils/applianceCommands'
import { hadEnrolled } from '../utils/credentialState'
import { api } from '../api'

/**
 * Setting a Remote gateway up again on the machine it enrolled on needs the old enrolment there
 * cleared first. The setup dialog shows how for a gateway that has ever enrolled, whatever its
 * credential is now, and the Restore dialog says where to find it. A gateway that never enrolled, and
 * one with no appliance, is told nothing about it.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: {
      get: vi.fn(), post: vi.fn(), put: vi.fn(), enrolmentReadiness: vi.fn(), gatewayHoldsBrokerCredential: vi.fn(),
      downloadGatewayBundle: vi.fn(), installCommand: vi.fn(), displayNamesFor: vi.fn(),
      listGatewayCredentials: vi.fn(), listBrokerInventory: vi.fn(), listServicePrincipals: vi.fn(),
      listServiceTokens: vi.fn(), listRevokedServiceTokens: vi.fn(), listRevokedServicePrincipals: vi.fn(),
    }
  }
})

const ENROLLED = '2026-11-01T09:00:00Z'
const REVOKED = '2026-11-05T09:00:00Z'
const COMMAND = 'curl -fsSL https://api.plant/functions/v1/gateway-install | sudo env ABER_ENROLMENT_TOKEN=x bash'
const INSTALLER = { available: true, reason: null }

const expiresAt = () => new Date(Date.now() + 30 * 60_000).toISOString()

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/')
  api.installCommand.mockResolvedValue({
    command: COMMAND, expiresAt: expiresAt(), sparkplugId: 'gwy01', caPin: 'abcdefghijklmnop', installUrl: 'https://api.plant'
  })
  api.downloadGatewayBundle.mockResolvedValue({
    blob: new Blob(['PK']), filename: 'aber-gateway-press-gwy01.zip', expiresAt: expiresAt(), sparkplugId: 'gwy01'
  })
  // The download is a blob URL and an anchor click; both are stubbed so nothing navigates.
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:bundle')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

const CLEAN_UP = 'Setting up the same machine again? Clear its old enrolment first'
const blocks = () => [...document.querySelectorAll('dialog pre')].map(p => p.textContent)

const setUp = async ({ enrolled_at, installer = INSTALLER }) => {
  render(
    <GatewayBundleModal
      gateway={{ gateway_id: 'g1', gateway_name: 'Press', sparkplug_id: 'gwy01', enrolled_at }}
      installer={installer} onClose={vi.fn()} showToast={vi.fn()}
    />
  )
  await waitFor(() => expect(blocks()).not.toHaveLength(0))
}

describe('the setup dialog, for a gateway that has never enrolled', () => {
  it('shows the install command alone, for a fresh machine', async () => {
    await setUp({ enrolled_at: null })
    expect(blocks()).toEqual([COMMAND])
    expect(screen.queryByText(CLEAN_UP)).toBeNull()
    expect(screen.getByRole('dialog').textContent).toContain('On a fresh Ubuntu machine')
  })

  it('shows a bundle\'s commands alone', async () => {
    await setUp({ enrolled_at: undefined, installer: null })
    expect(blocks()).toHaveLength(1)
    expect(screen.queryByText(CLEAN_UP)).toBeNull()
  })
})

describe('the setup dialog, for a gateway that has enrolled before', () => {
  it('shows the clean-up above the install command, with what it deletes and who does not need it', async () => {
    await setUp({ enrolled_at: ENROLLED })
    expect(blocks()).toEqual([CLEAR_INSTALLED_ENROLMENT, COMMAND])
    const block = screen.getByText(CLEAN_UP).closest('.form-group')
    expect(block.textContent).toContain(
      'This deletes the old enrolment and anything the appliance has not reported; a fresh machine does not need it.'
    )
    expect(within(block).getByRole('link', { name: 'Commands on the appliance' }))
      .toHaveAttribute('data-help', 'site/remote-gateways#commands-on-the-appliance')
    // The command's own hint no longer says the machine is fresh.
    expect(screen.getByRole('dialog').textContent).toContain('On an Ubuntu machine')
    expect(screen.getByRole('dialog').textContent).not.toContain('On a fresh Ubuntu machine')
  })

  it('is not a warning, since a re-install on a fresh machine has nothing to clear', async () => {
    await setUp({ enrolled_at: ENROLLED })
    expect(screen.getByText(CLEAN_UP).closest('.callout')).toBeNull()
  })

  it('copies the clean-up and the install command each with its own button', async () => {
    const written = []
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async (t) => { written.push(t) }) } })
    await setUp({ enrolled_at: ENROLLED })
    fireEvent.click(screen.getByRole('button', { name: 'Copy Clean-up' }))
    await waitFor(() => expect(written).toEqual([CLEAR_INSTALLED_ENROLMENT]))
    fireEvent.click(screen.getByRole('button', { name: 'Copy Command' }))
    await waitFor(() => expect(written).toEqual([CLEAR_INSTALLED_ENROLMENT, COMMAND]))
  })

  it('shows the bundle\'s clean-up in bundle mode, and where to run it', async () => {
    await setUp({ enrolled_at: ENROLLED, installer: null })
    expect(blocks()[0]).toBe(CLEAR_BUNDLE_ENROLMENT)
    expect(blocks()[1]).toContain('cd aber-gateway-press-gwy01')
    expect(screen.getByText(CLEAN_UP).closest('.form-group').textContent).toContain('Run it in the old bundle’s folder.')
  })
})

// A Remote gateway as a restore leaves it: no longer archived, its credential still revoked.
const gateway = (overrides = {}) => ({
  gateway_id: 'bbbbbbbb-0000-4000-8000-000000001597',
  gateway_name: 'Production_Flow',
  sparkplug_id: 'gwybbbbbbbb00004000801597',
  sparkplug_group: 'Aber',
  status: 'OFFLINE',
  deployment: 'remote',
  is_simulated: false,
  is_shadow: false,
  is_archived: false,
  cell_id: 'cell-1',
  location_scope: 'cell',
  access_url: '',
  enrolled_at: ENROLLED,
  credential_revoked_at: REVOKED,
  devices: [],
  ...overrides
})

const openDrawer = async (row) => {
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/cells')) return Promise.resolve([{ cell_id: 'cell-1', cell_name: 'Assembly' }])
    if (path.startsWith('/api/v1/gateways')) return Promise.resolve([row])
    return Promise.resolve([])
  })
  api.enrolmentReadiness.mockResolvedValue({ ready: true, addresses: [], installer: INSTALLER })
  api.gatewayHoldsBrokerCredential.mockResolvedValue(false)
  render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} userRole="Shopfloor_Manager" />)
  const list = () => within(document.querySelector('.page-main'))
  await waitFor(() => expect(list().getByText(row.gateway_name)).toBeInTheDocument())
  fireEvent.click(list().getByText(row.gateway_name))
  return within(document.querySelector('.context-panel'))
}

const issueFrom = async (panel, action) => {
  // The setup dialog offers the command once the deployment has said it can serve the installer.
  await waitFor(() => expect(api.enrolmentReadiness).toHaveBeenCalled())
  fireEvent.click(panel.getByRole('button', { name: action }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.change(within(dialog).getByLabelText(/Type Production_Flow to confirm/), { target: { value: 'Production_Flow' } })
  fireEvent.click(within(dialog).getByRole('button', { name: /^Issue/ }))
  await waitFor(() => expect(blocks()).not.toHaveLength(0))
}

describe('the drawer\'s setup action', () => {
  it('shows the clean-up for a restored gateway, whose credential was revoked when it was archived', async () => {
    await issueFrom(await openDrawer(gateway()), /Set Up Gateway/)
    expect(blocks()).toEqual([CLEAR_INSTALLED_ENROLMENT, COMMAND])
  })

  it('shows it for an enrolled gateway set up again, whose credential still stands', async () => {
    await issueFrom(await openDrawer(gateway({ credential_revoked_at: null, last_heartbeat: ENROLLED })), /Re-issue Setup/)
    expect(blocks()).toEqual([CLEAR_INSTALLED_ENROLMENT, COMMAND])
  })

  it('shows none for a gateway whose appliance never enrolled', async () => {
    await issueFrom(
      await openDrawer(gateway({ enrolled_at: null, credential_revoked_at: null, status: 'PENDING_ENROLLMENT' })), /Set Up Gateway/
    )
    expect(blocks()).toEqual([COMMAND])
  })
})

describe('Access Control, where a Remote gateway\'s bundle is issued too', () => {
  it('shows the clean-up for a gateway that has enrolled before', async () => {
    api.listGatewayCredentials.mockResolvedValue([{
      id: 'g1', name: 'Production_Flow', sparkplug_id: 'gwy01', deployment: 'remote', is_archived: false, is_shadow: false,
      status: 'OFFLINE', enrolled_at: ENROLLED, credential_revoked_at: REVOKED, issued_at: null
    }])
    api.listBrokerInventory.mockResolvedValue({ clients: [], roles: [], read_at: ENROLLED })
    for (const read of ['listServicePrincipals', 'listServiceTokens', 'listRevokedServiceTokens', 'listRevokedServicePrincipals']) {
      api[read].mockResolvedValue([])
    }
    api.get.mockResolvedValue([])
    window.history.replaceState(null, '', '/access-control/credentials')
    render(<AccessControlTab showToast={vi.fn()} hasPermission={() => true} userRole="Administrator" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Bundle' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText(/Type Production_Flow to confirm/), { target: { value: 'Production_Flow' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /^Issue/ }))
    await waitFor(() => expect(blocks()[0]).toBe(CLEAR_BUNDLE_ENROLMENT))
  })
})

const SENTENCE = 'Setting it up on the same machine needs the old enrolment there cleared first: Set Up Gateway in its drawer shows the command.'

const restoreFromArchives = async (row) => {
  api.get.mockResolvedValue([{
    entity_id: 'g1', name: 'Production_Flow', entity_type: 'gateway',
    archived_at: REVOKED, auto_delete_at: null, credential_revoked_at: REVOKED, ...row
  }])
  api.displayNamesFor.mockResolvedValue(new Map())
  window.history.replaceState(null, '', '/entities/archived')
  render(<EntitiesTab showToast={vi.fn()} hasPermission={() => true} />)
  fireEvent.click(await screen.findByRole('button', { name: /Restore/ }))
  return (await screen.findByRole('dialog', { name: 'Restore gateway' })).textContent
}

describe('the Restore dialog', () => {
  it('says the same machine is cleared first, and where the command is, for a Remote gateway that had enrolled', async () => {
    expect(await restoreFromArchives({ deployment: 'remote', enrolled_at: ENROLLED })).toContain(SENTENCE)
  })

  it.each([
    ['a Remote gateway that never enrolled', { deployment: 'remote', enrolled_at: null }],
    ['a Host gateway', { deployment: 'host', enrolled_at: null }],
    ['a gateway that enrolled and was made a Host one since', { deployment: 'host', enrolled_at: ENROLLED }],
    ['a Third-party gateway', { deployment: 'third_party', enrolled_at: null }],
  ])('says nothing of it for %s', async (_what, row) => {
    const text = await restoreFromArchives(row)
    expect(text).toContain('broker credential was revoked')
    expect(text).not.toContain('same machine')
  })

  it('says it from the drawer as from Entities', async () => {
    window.history.replaceState(null, '', '/gateways?lifecycle=archived')
    const panel = await openDrawer(gateway({ is_archived: true, archived_at: REVOKED }))
    fireEvent.click(panel.getByRole('button', { name: /Restore Gateway/ }))
    expect((await screen.findByRole('dialog', { name: 'Restore gateway' })).textContent).toContain(SENTENCE)
  })
})

describe('hadEnrolled()', () => {
  it('is a Remote gateway that enrolled, whatever its credential is now', () => {
    expect(hadEnrolled(gateway())).toBe(true)
    expect(hadEnrolled(gateway({ credential_revoked_at: null }))).toBe(true)
    expect(hadEnrolled(gateway({ enrolled_at: null }))).toBe(false)
    expect(hadEnrolled(gateway({ deployment: 'host' }))).toBe(false)
    expect(hadEnrolled(null)).toBe(false)
  })
})
