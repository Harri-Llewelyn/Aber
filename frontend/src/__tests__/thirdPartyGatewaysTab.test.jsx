import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import { api } from '../api'

/**
 * A Third-party gateway on the Gateways page. Register Gateway offers it beside Remote and Host,
 * and saving one opens its credential at once, as saving a Remote one opens Set up. Its drawer
 * offers the credential a Host gateway gets, says what it does not get, and shows no appliance
 * health, since Aber does not manage the node.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: {
      get: vi.fn(), post: vi.fn(), put: vi.fn(), enrolmentReadiness: vi.fn(),
      mintGatewayCredential: vi.fn(), showGatewayCredential: vi.fn(),
    }
  }
})

const gateway = (overrides = {}) => ({
  gateway_id: '4c000000-0000-4000-8000-000000000001',
  gateway_name: 'Vendor_Node',
  sparkplug_id: 'gwy4c0000000000400080000',
  sparkplug_group: 'Plant-A',
  status: 'ONLINE',
  deployment: 'third_party',
  is_simulated: false,
  is_shadow: false,
  is_archived: false,
  cell_id: 'cell-1',
  location_scope: 'cell',
  access_url: '',
  last_heartbeat: new Date().toISOString(),
  devices: [],
  ...overrides
})

const CREDENTIAL = {
  mqtt_username: 'gwy4d0000000000400080000',
  password: 'new-third-party-password',
  audit_recorded: true,
  credential_kept: true
}

const routeGet = (rows) => (path) => {
  if (path.startsWith('/api/v1/cells')) return Promise.resolve([{ cell_id: 'cell-1', cell_name: 'Assembly', is_archived: false }])
  if (path.startsWith('/api/v1/gateways')) return Promise.resolve(rows)
  return Promise.resolve([])
}

const show = async (rows = [gateway()], { userRole = 'Shopfloor_Manager' } = {}) => {
  api.get.mockImplementation(routeGet(rows))
  api.enrolmentReadiness.mockResolvedValue({ ready: true, addresses: [] })
  render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} userRole={userRole} />)
  await waitFor(() => expect(screen.getByText(rows[0].gateway_name)).toBeTruthy())
}

const openDrawer = (name = 'Vendor_Node') => {
  fireEvent.click(within(document.querySelector('.page-main')).getByText(name))
  return within(document.querySelector('.context-panel'))
}

beforeEach(() => {
  vi.clearAllMocks()
  globalThis.__ABER_CONFIG__ = { VITE_PRIMARY_HOST_ID: 'plant1' }
})
afterEach(() => { delete globalThis.__ABER_CONFIG__ })

describe('a Third-party gateway in the list', () => {
  it('reads Third-party in the Type column and the drawer', async () => {
    await show()
    expect(within(document.querySelector('table')).getByText('Third-party')).toBeTruthy()
    expect(openDrawer().getByText('Third-party')).toBeTruthy()
  })

  it('is what the Type filter lists under Third-party', async () => {
    await show([gateway(), gateway({ gateway_id: 'gw-host', gateway_name: 'Host_Node', deployment: 'host' })])
    const filter = screen.getByRole('combobox', { name: 'Type' })
    expect([...filter.options].map(o => o.textContent)).toContain('Third-party')
    fireEvent.change(filter, { target: { value: 'third_party' } })
    const names = [...document.querySelectorAll('tbody tr td strong')].map(el => el.textContent)
    expect(names).toEqual(['Vendor_Node'])
  })
})

describe('registering a Third-party gateway', () => {
  it('is offered beside Remote and Host, and saving it issues its credential at once', async () => {
    api.post.mockResolvedValue({
      id: '4d000000-0000-4000-8000-000000000001', name: 'New_Vendor_Node',
      sparkplug_id: 'gwy4d0000000000400080000', sparkplug_group: 'Plant-A'
    })
    api.mintGatewayCredential.mockResolvedValue(CREDENTIAL)
    await show()

    fireEvent.click(screen.getByRole('button', { name: /New Gateway/ }))
    const type = document.querySelector('#gateway-type')
    expect([...type.options].map(o => o.textContent)).toEqual(['Remote', 'Third-party', 'Host', 'Simulated'])
    fireEvent.change(screen.getByLabelText('Gateway Name'), { target: { value: 'New_Vendor_Node' } })
    fireEvent.change(type, { target: { value: 'third_party' } })
    expect(screen.getByText(/On save you will be given its broker credential and every setting/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.post).toHaveBeenCalled())
    expect(api.post.mock.calls[0][1].deployment).toBe('third_party')
    await waitFor(() => expect(api.mintGatewayCredential).toHaveBeenCalledWith('4d000000-0000-4000-8000-000000000001'))
    await waitFor(() => expect(screen.getByLabelText('Password').value).toBe(CREDENTIAL.password))
    expect(screen.getByLabelText('Sparkplug group').value).toBe('Plant-A')
    expect(screen.queryByText(/Set up “/)).toBeNull()
  })
})

describe("a Third-party gateway's drawer", () => {
  it('offers the broker credential, and no setup', async () => {
    await show([gateway({ status: 'OFFLINE' })])
    const panel = openDrawer()
    expect(panel.getByRole('button', { name: /Generate Broker Credential/ })).toBeTruthy()
    expect(panel.queryByRole('button', { name: /Set Up Gateway/ })).toBeNull()
    expect(panel.getByRole('button', { name: /Archive Gateway/ })).toBeTruthy()
    // Show Broker Credential is the Administrator's alone.
    expect(panel.queryByRole('button', { name: /Show Broker Credential/ })).toBeNull()
  })

  it('lets an Administrator show the credential again, with every setting', async () => {
    api.showGatewayCredential.mockResolvedValue({ mqtt_username: 'gwy4c0000000000400080000', password: 'kept', issued_at: null })
    await show([gateway()], { userRole: 'Administrator' })
    fireEvent.click(openDrawer().getByRole('button', { name: /Show Broker Credential/ }))
    fireEvent.click(screen.getByRole('button', { name: /Show Credential/ }))
    await waitFor(() => expect(screen.getByLabelText('Password').value).toBe('kept'))
    expect(screen.getByLabelText('Edge node ID').value).toBe('gwy4c0000000000400080000')
    expect(screen.getByLabelText('Sparkplug group').value).toBe('Plant-A')
  })

  it('confirms before issuing again from the drawer, and gives the settings once issued', async () => {
    api.mintGatewayCredential.mockResolvedValue({ ...CREDENTIAL, mqtt_username: 'gwy4c0000000000400080000' })
    await show()
    fireEvent.click(openDrawer().getByRole('button', { name: /Generate Broker Credential/ }))
    const confirm = screen.getByLabelText('Type Vendor_Node to confirm')
    expect(api.mintGatewayCredential).not.toHaveBeenCalled()
    fireEvent.change(confirm, { target: { value: 'Vendor_Node' } })
    fireEvent.click(screen.getByText(/Issue Credential/))
    await waitFor(() => expect(screen.getByLabelText('Primary host ID').value).toBe('plant1'))
  })

  it('says what it does not get, and shows no appliance health', async () => {
    await show([gateway({ health_reported_at: new Date().toISOString(), cert_expires_at: '2030-01-01T00:00:00Z', disk_free_bytes: 1 })])
    const panel = openDrawer()
    expect(panel.getByText('Not Provided')).toBeTruthy()
    expect(panel.getByText('No setup bundle, no forge repository, no flow drift check and no appliance health.')).toBeTruthy()
    expect(panel.queryByText('CA Expires')).toBeNull()
    expect(panel.queryByText('Disk Free')).toBeNull()
  })

  it('shows no bundle and no forge heads, even with values left on its row', async () => {
    // Hidden by the gateway's type, not by its values: a row edited to Third-party keeps its columns.
    await show([gateway({ agent_version: '1.5.0', forge_head_sha: 'abcdef0123456789', forge_appliance_sha: '0123456789abcdef' })])
    const panel = openDrawer()
    for (const label of ['Bundle', 'Committed', 'Reported']) {
      expect(panel.queryByText(label), label).toBeNull()
    }
  })

  it('gives the reason it has no repository', async () => {
    await show()
    expect(openDrawer().getByText(/A Third-party gateway has no repository of its own/)).toBeTruthy()
  })

  it('is placed in its cell, as a Remote gateway is', async () => {
    await show()
    expect(openDrawer().getByText('Assembly')).toBeTruthy()
  })
})
