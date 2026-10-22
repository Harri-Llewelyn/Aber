import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import { gatewaySparkplugId } from '../utils/sparkplugId'
import { api } from '../api'
import { gatewayUrl } from '../routes'

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

/** Renders the page at the address an alert row or a chip links to, `/gateways?search=<id>`. */
const show = async (rows, arrivingId = '') => {
  api.get.mockImplementation(routeGet(rows))
  if (arrivingId) window.history.replaceState(null, '', gatewayUrl(arrivingId))
  render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} />)
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

  it('shows the bundle and both forge heads with no health report', async () => {
    // Enrolment writes the bundle and the forge writes the heads; an appliance on a bundle that
    // reports no health is when the version matters most.
    await show([gateway({
      deployment: 'remote',
      agent_version: '1.5.0',
      forge_head_sha: 'abcdef0123456789',
      forge_head_at: new Date().toISOString(),
      forge_appliance_sha: '0123456789abcdef',
      forge_appliance_at: new Date().toISOString()
    })])
    const panel = openPanel()
    expect(panel.getByText('1.5.0')).toBeInTheDocument()
    expect(panel.getByText(/^abcdef012345 · /)).toBeInTheDocument()
    expect(panel.getByText(/^0123456789ab · /)).toBeInTheDocument()
    expect(panel.queryByText('Health Reported')).toBeNull()
  })

  it('leaves out the bundle and the forge heads while they have no value', async () => {
    await show([gateway({ deployment: 'remote', health_reported_at: new Date().toISOString() })])
    const panel = openPanel()
    expect(panel.getByText('Health Reported')).toBeInTheDocument()
    for (const label of ['Bundle', 'Committed', 'Reported']) {
      expect(panel.queryByText(label), label).toBeNull()
    }
  })

  it('tells the credential dialog whether the gateway is the Playback gateway', async () => {
    await show([gateway({ is_shadow: true, is_simulated: true })])
    fireEvent.click(openPanel().getByText('Generate Broker Credential'))
    expect(credentialProps).toHaveBeenCalledWith(expect.objectContaining({ is_shadow: true }))
  })
})

describe('a gateway publishing under another Sparkplug group', () => {
  const elsewhere = { sparkplug_group: 'Aber', observed_sparkplug_group: 'Plant-B' }
  const warning = 'Publishes under group Plant-B; registered under Aber'

  it('says so on its row', async () => {
    await show([gateway(elsewhere)])
    expect(within(document.querySelector('.page-main')).getByText(warning)).toBeInTheDocument()
  })

  it('says so in its drawer, with what to change', async () => {
    await show([gateway(elsewhere)])
    const callout = openPanel().getByText(/Set the edge node to publish under Aber/).closest('.callout')
    expect(callout).toHaveClass('callout-warning')
    expect(callout).toHaveTextContent('Publishes under group Plant-B; registered under Aber.')
    expect(callout).toHaveTextContent("change this gateway’s Sparkplug group to Plant-B")
  })

  it('says nothing once it publishes under its own group again', async () => {
    await show([gateway({ ...elsewhere, observed_sparkplug_group: 'Aber' })])
    expect(screen.queryByText(/Publishes under group/)).toBeNull()
    expect(openPanel().queryByText(/Set the edge node to publish under/)).toBeNull()
  })
})
