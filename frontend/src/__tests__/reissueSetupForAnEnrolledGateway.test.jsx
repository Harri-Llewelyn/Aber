import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import { api } from '../api'

/**
 * Re-issue Setup for a Remote gateway whose appliance enrolled and is not online: one that never
 * published, or one whose machine was replaced or rebuilt. Issuing the setup revokes the credential
 * the enrolled appliance holds at once (0312), so the drawer offers it only while the gateway is not
 * online, never as the primary, and the dialog asks for the gateway's name and says so first.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: {
      get: vi.fn(), post: vi.fn(), put: vi.fn(), enrolmentReadiness: vi.fn(), gatewayHoldsBrokerCredential: vi.fn(),
      downloadGatewayBundle: vi.fn(), installCommand: vi.fn()
    }
  }
})

const UUID = 'bbbbbbbb-0000-4000-8000-000000001562'
const ENROLLED = '2026-11-01T09:00:00Z'
const LONG_AGO = '2026-11-02T09:00:00Z'

// An enrolled Remote gateway that published, then went quiet.
const enrolled = (overrides = {}) => ({
  gateway_id: UUID,
  gateway_name: 'Production_Flow',
  sparkplug_id: 'gwybbbbbbbb00004000800003',
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
  credential_revoked_at: null,
  last_heartbeat: LONG_AGO,
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

const setupAction = (panel) => panel.queryByRole('button', { name: /Set Up Gateway|Re-issue Setup/ })

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())

describe('an enrolled Remote gateway that is not online', () => {
  it('is offered Re-issue Setup when it is offline, and it is not the primary', async () => {
    const panel = await openDrawer(enrolled())
    const action = panel.getByRole('button', { name: /Re-issue Setup/ })
    expect(action.className).not.toMatch(/btn-primary/)
    expect(panel.queryByRole('button', { name: /Set Up Gateway/ })).toBeNull()
  })

  it('is offered Re-issue Setup when it is stale', async () => {
    const panel = await openDrawer(enrolled({ status: 'ONLINE', last_heartbeat: LONG_AGO }))
    expect(panel.getByRole('button', { name: /Re-issue Setup/ })).toBeInTheDocument()
  })

  it('is offered none while it is online, since re-issuing would revoke a working credential', async () => {
    const panel = await openDrawer(enrolled({ status: 'ONLINE', last_heartbeat: new Date().toISOString() }))
    expect(setupAction(panel)).toBeNull()
  })

  it('asks for the name first, and says the old appliance\'s credential is revoked', async () => {
    const panel = await openDrawer(enrolled())
    fireEvent.click(panel.getByRole('button', { name: /Re-issue Setup/ }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toMatch(/revokes the broker credential its appliance is holding/)
    expect(within(dialog).getByRole('button', { name: /Issue & Download/ })).toBeDisabled()
    expect(api.downloadGatewayBundle).not.toHaveBeenCalled()

    fireEvent.change(within(dialog).getByLabelText(/Type Production_Flow to confirm/), { target: { value: 'production_flow' } })
    expect(within(dialog).getByRole('button', { name: /Issue & Download/ })).toBeEnabled()
  })

  it('stops saying so once the dialog has issued, since the credential is already revoked', async () => {
    api.downloadGatewayBundle.mockResolvedValue({
      blob: new Blob(['zip']), filename: 'aber-gateway-gwybbbbbbbb00004000800003.zip',
      expiresAt: new Date(Date.now() + 30 * 60000).toISOString(), sparkplugId: 'gwybbbbbbbb00004000800003'
    })
    // The download is a blob URL and an anchor click; both are stubbed so nothing navigates.
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:bundle')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const panel = await openDrawer(enrolled())
    fireEvent.click(panel.getByRole('button', { name: /Re-issue Setup/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText(/Type Production_Flow to confirm/), { target: { value: 'Production_Flow' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /Issue & Download/ }))
    await waitFor(() => expect(api.downloadGatewayBundle).toHaveBeenCalledWith(UUID))

    fireEvent.click(await within(dialog).findByRole('button', { name: /Re-issue Bundle/ }))
    await waitFor(() => expect(dialog.textContent).toMatch(/invalidates any bundle/))
    expect(dialog.textContent).not.toMatch(/revokes the broker credential/)
  })
})

describe('a Remote gateway with no enrolment standing', () => {
  it('is offered Set Up Gateway as the primary, and the dialog revokes nothing', async () => {
    const panel = await openDrawer(enrolled({ credential_revoked_at: '2026-11-05T09:00:00Z' }))
    const action = panel.getByRole('button', { name: /Set Up Gateway/ })
    expect(action.className).toMatch(/btn-primary/)
    fireEvent.click(action)
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).not.toMatch(/revokes the broker credential/)
  })
})
