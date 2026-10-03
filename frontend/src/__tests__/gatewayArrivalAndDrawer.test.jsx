import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import { gatewaySparkplugId } from '../utils/sparkplugId'
import { api } from '../api'

/**
 * Arriving on Gateways by Sparkplug id, the drawer's uptime, and what the credential dialog is
 * told about the gateway it opens for.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const credentialProps = vi.fn()
vi.mock('../components/modals/GatewayCredentialModal', () => ({
  GatewayCredentialModal: (props) => { credentialProps(props.gateway); return null }
}))

const UUID = 'aaaaaaaa-0000-4000-8000-000000000001'

const gateway = (overrides = {}) => ({
  gateway_id: UUID,
  gateway_name: 'Host_Gateway_NodeRED',
  cell_id: 'cell-1',
  status: 'ONLINE',
  deployment: 'host',
  is_archived: false,
  last_heartbeat: new Date().toISOString(),
  device_count: 0,
  devices: [],
  ...overrides
})

const routeGet = (rows) => (path) => {
  if (path.startsWith('/api/v1/cells')) return Promise.resolve([{ cell_id: 'cell-1', cell_name: 'Assembly Line 1' }])
  if (path.startsWith('/api/v1/gateways')) return Promise.resolve(rows)
  return Promise.resolve([])
}

const show = async (rows, initialSearchFilter = '') => {
  api.get.mockImplementation(routeGet(rows))
  render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter={initialSearchFilter} onClearFilter={vi.fn()} />)
  await waitFor(() => expect(screen.getAllByText(rows[0].gateway_name).length).toBeGreaterThan(0))
}

// The panel is always mounted; aria-hidden says whether it is open.
const panelOpen = () => document.querySelector('.context-panel')?.getAttribute('aria-hidden') === 'false'

const openPanel = () => {
  fireEvent.click(within(document.querySelector('.page-main')).getByText('Host_Gateway_NodeRED'))
  return within(document.querySelector('.context-panel'))
}

beforeEach(() => vi.clearAllMocks())

describe('arriving with a Sparkplug id', () => {
  it('opens the drawer for the stored id', async () => {
    await show([gateway({ sparkplug_id: 'gwy100000000000400080000' })], 'gwy100000000000400080000')
    await waitFor(() => expect(panelOpen()).toBe(true))
  })

  it('opens the drawer for an id derived from the row uuid when none is stored', async () => {
    await show([gateway()], gatewaySparkplugId(UUID))
    await waitFor(() => expect(panelOpen()).toBe(true))
  })

  it('opens nothing for an id that names no gateway', async () => {
    await show([gateway()], 'Host_Gateway')
    expect(panelOpen()).toBe(false)
  })
})

describe('the drawer', () => {
  it('shows uptime past a day as a duration, not a date', async () => {
    await show([gateway({ health_reported_at: new Date().toISOString(), uptime_seconds: 3 * 86400 + 4 * 3600 + 120 })])
    expect(openPanel().getByText('3d 4h')).toBeInTheDocument()
  })

  it('tells the credential dialog whether the gateway is the Playback gateway', async () => {
    await show([gateway({ is_shadow: true, is_simulated: true })])
    fireEvent.click(openPanel().getByText('Generate Broker Credential'))
    expect(credentialProps).toHaveBeenCalledWith(expect.objectContaining({ is_shadow: true }))
  })
})
