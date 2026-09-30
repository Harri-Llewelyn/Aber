import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { AssetConfigModal } from '../components/modals/AssetConfigModal'
import { api } from '../api'

/**
 * A device's Description reaches the API on create and on edit, and a device that has never
 * published is not described as having sent a DDEATH.
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
  is_quarantined: false,
  is_archived: false,
  active_gateway_id: 'gw-1',
  cell_id: null,
  location_scope: 'cell',
  first_dbirth_at: '2026-07-27T12:00:00Z',
  created_at: '2026-07-20T12:00:00Z',
  ...overrides
})

const routeGet = (rows) => (path) => {
  if (path.startsWith('/api/v1/gateways')) {
    return Promise.resolve([{ gateway_id: 'gw-1', gateway_name: 'Line_A_Gateway', status: 'ONLINE', is_archived: false, devices: [] }])
  }
  if (path.startsWith('/api/v1/devices')) return Promise.resolve(rows)
  return Promise.resolve([])
}

const show = async (rows) => {
  api.get.mockImplementation(routeGet(rows))
  render(<DevicesTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={() => true} />)
  await waitFor(() => expect(screen.getByText(rows[0].asset_name)).toBeTruthy())
}

const openPanel = () => {
  fireEvent.click(within(document.querySelector('.page-main')).getByText('CNC_01'))
  return within(document.querySelector('.context-panel'))
}

beforeEach(() => vi.clearAllMocks())

describe('a device description', () => {
  it('is sent by the edit form', async () => {
    await show([device({ description: 'Spindle rebuilt' })])
    fireEvent.click(openPanel().getByText('Edit Details'))
    const box = screen.getByPlaceholderText(/Spindle rebuilt 2026-03/)
    expect(box.value).toBe('Spindle rebuilt')
    fireEvent.change(box, { target: { value: 'Runs warm' } })
    fireEvent.click(screen.getByRole('button', { name: /Save Configuration/i }))

    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(api.put.mock.calls[0][1]).toMatchObject({ description: 'Runs warm' })
  })

  it('is sent by the create form', async () => {
    await show([device()])
    fireEvent.click(screen.getByRole('button', { name: /New Device/i }))
    fireEvent.change(screen.getByPlaceholderText(/Sim_CNC_Mill_01/), { target: { value: 'Lathe_02' } })
    fireEvent.change(screen.getByPlaceholderText(/Spindle rebuilt 2026-03/), { target: { value: 'Second lathe' } })
    fireEvent.click(screen.getByRole('button', { name: /Save Configuration/i }))

    await waitFor(() => expect(api.post).toHaveBeenCalled())
    expect(api.post.mock.calls[0][1]).toMatchObject({ asset_name: 'Lathe_02', description: 'Second lathe' })
  })
})

describe('a device that has never published', () => {
  const NEVER = { status: 'OFFLINE', first_dbirth_at: null }

  it('reads as awaiting its first birth in the drawer, not as a DDEATH', async () => {
    await show([device(NEVER)])
    const edit = openPanel().getByText('Edit Details').closest('button')
    expect(edit.getAttribute('title')).toMatch(/Awaiting first birth/)
    expect(edit.getAttribute('title')).not.toMatch(/DDEATH/)
  })

  it('keeps the DDEATH wording for a device that has published before', async () => {
    await show([device({ status: 'OFFLINE' })])
    const edit = openPanel().getByText('Edit Details').closest('button')
    expect(edit.getAttribute('title')).toMatch(/DDEATH received/)
  })

  it('reads as awaiting its first birth in the parameters dialog', async () => {
    api.get.mockResolvedValue([])
    render(<AssetConfigModal asset={device(NEVER)} schemas={[]} onClose={vi.fn()} />)
    expect(await screen.findByText(/Awaiting first birth/)).toBeInTheDocument()
    expect(screen.queryByText(/DDEATH/)).not.toBeInTheDocument()
  })

  it('keeps the DDEATH banner in the parameters dialog for a device that has published', async () => {
    api.get.mockResolvedValue([])
    render(<AssetConfigModal asset={device({ status: 'OFFLINE' })} schemas={[]} onClose={vi.fn()} />)
    expect(await screen.findByText(/Device Offline \(DDEATH Received\)/)).toBeInTheDocument()
  })
})
