import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { ApproveQuarantineModal } from '../components/modals/ApproveQuarantineModal'
import { api } from '../api'

/**
 * A device has no connection method: every device reaches Aber over Sparkplug B, and the API refuses
 * the field. No dashboard form sends one. The row below still holds one, as a row read before the
 * upgrade to 1.10.0 does, to show that saving the form does not write it back.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

vi.mock('../lib/supabaseClient', () => ({
  supabase: { functions: { invoke: vi.fn() } }
}))

const device = (overrides = {}) => ({
  asset_id: 'aaaaaaaa-0000-4000-8000-000000000001',
  asset_name: 'CNC_01',
  sparkplug_id: 'devaaaaaaaa000040008000',
  status: 'ONLINE',
  connection_method: 'Sparkplug B',
  is_quarantined: false,
  is_archived: false,
  active_gateway_id: 'gw-1',
  cell_id: null,
  location_scope: 'gateway',
  first_dbirth_at: '2026-07-27T12:00:00Z',
  created_at: '2026-07-20T12:00:00Z',
  ...overrides
})

const GATEWAY = { gateway_id: 'gw-1', gateway_name: 'Line_A_Gateway', status: 'ONLINE', is_archived: false, devices: [] }

const routeGet = (path) => {
  if (path.startsWith('/api/v1/gateways')) return Promise.resolve([GATEWAY])
  if (path.startsWith('/api/v1/devices')) return Promise.resolve([device()])
  return Promise.resolve([])
}

const showDevices = async () => {
  api.get.mockImplementation(routeGet)
  render(<DevicesTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={() => true} />)
  await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())
}

beforeEach(() => vi.clearAllMocks())

describe('the Devices form', () => {
  it('sends no connection method when it creates a device', async () => {
    await showDevices()
    fireEvent.click(screen.getByRole('button', { name: /New Device/i }))
    fireEvent.change(screen.getByPlaceholderText(/CNC Mill 01/), { target: { value: 'Lathe_02' } })
    fireEvent.click(screen.getByRole('button', { name: /Save Configuration/i }))

    await waitFor(() => expect(api.post).toHaveBeenCalled())
    expect(api.post.mock.calls[0][1]).toMatchObject({ asset_name: 'Lathe_02' })
    expect(api.post.mock.calls[0][1]).not.toHaveProperty('connection_method')
  })

  it('does not write a stored connection method back when it saves an edit', async () => {
    await showDevices()
    fireEvent.click(within(document.querySelector('.page-main')).getByText('CNC_01'))
    fireEvent.click(within(document.querySelector('.context-panel')).getByText('Edit Details'))
    fireEvent.click(screen.getByRole('button', { name: /Save Configuration/i }))

    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(api.put.mock.calls[0][1]).toMatchObject({ asset_name: 'CNC_01' })
    expect(api.put.mock.calls[0][1]).not.toHaveProperty('connection_method')
  })
})

describe('the dialog that approves a device from Quarantine', () => {
  it('sends no connection method', async () => {
    const onApprove = vi.fn().mockResolvedValue(undefined)
    render(
      <ApproveQuarantineModal
        item={{ asset_id: 'qqqqqqqq-0000-4000-8000-000000000001', asset_name: 'Unknown_Robot', reported_identity: 'devffffffffffffffffffff1', entity_type: 'DEVICE', gateway_id: 'gw-1' }}
        cells={[]}
        gateways={[GATEWAY]}
        suggestion={null}
        onApprove={onApprove}
        onMerge={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /Approve & Onboard/i }))

    await waitFor(() => expect(onApprove).toHaveBeenCalled())
    expect(onApprove.mock.calls[0][1]).toMatchObject({ asset_name: 'Unknown_Robot', active_gateway_id: 'gw-1' })
    expect(onApprove.mock.calls[0][1]).not.toHaveProperty('connection_method')
  })
})
