import React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import { api } from '../api'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const device = (n, overrides = {}) => ({
  asset_id: `dev-${n}`,
  asset_name: `CNC_${String(n).padStart(2, '0')}`,
  status: 'ONLINE',
  is_quarantined: false,
  active_gateway_id: 'gw-1',
  ...overrides
})

const gateway = (devices) => ({
  gateway_id: 'gw-1',
  gateway_name: 'Line_A_Gateway',
  sparkplug_id: 'gwy100000000000400080000',
  cell_id: 'cell-1',
  status: 'ONLINE',
  deployment: 'remote',
  is_archived: false,
  last_heartbeat: new Date().toISOString(),
  device_count: devices.length,
  devices
})

const show = async (devices) => {
  const gw = gateway(devices)
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/cells')) return Promise.resolve([{ cell_id: 'cell-1', cell_name: 'Assembly Line 1' }])
    if (path.startsWith('/api/v1/gateways')) return Promise.resolve([gw])
    if (path.startsWith('/api/v1/devices')) return Promise.resolve(devices)
    return Promise.resolve([])
  })
  render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()} />)
  await waitFor(() => expect(screen.getByText('Line_A_Gateway')).toBeInTheDocument())
}

const twenty = Array.from({ length: 20 }, (_, i) => device(i + 1))

beforeEach(() => vi.clearAllMocks())

describe('gateway connected devices column', () => {
  it('shows every device when the fleet is small', async () => {
    await show([device(1), device(2)])

    expect(screen.getByText('2 Online / 0 Offline')).toBeInTheDocument()
    expect(screen.getByText('CNC_01')).toBeInTheDocument()
    expect(screen.getByText('CNC_02')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^\+/ })).not.toBeInTheDocument()
  })

  it('collapses a large fleet instead of rendering one chip per device', async () => {
    // Unlike the Devices Type column this count is unbounded, so it collapses past a limit.
    await show(twenty)

    expect(screen.getByText('CNC_01')).toBeInTheDocument()
    expect(screen.getByText('CNC_02')).toBeInTheDocument()
    expect(screen.queryByText('CNC_20')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '+18' })).toBeInTheDocument()
  })

  it('never collapses the Online/Offline summary', async () => {
    // It is the answer to "is this gateway healthy" -- the question the column exists to answer.
    // Hiding it behind a "+18" would defeat the column entirely.
    await show(twenty)
    expect(screen.getByText('20 Online / 0 Offline')).toBeInTheDocument()
  })

  it('pins a quarantined device however deep in the fleet it sits', async () => {
    // Same rule as Unmodelled on the Devices row: it is the one entry that calls for action, and
    // it would otherwise be lost among nineteen healthy ones.
    const fleet = [...twenty.slice(0, 19), device(20, { is_quarantined: true, status: 'OFFLINE' })]
    await show(fleet)

    expect(screen.getByText('CNC_20 (quarantined)')).toBeInTheDocument()
    // ...and it displaced a healthy device rather than widening the row.
    expect(screen.queryByText('CNC_02')).not.toBeInTheDocument()
  })

  it('names the hidden devices in the tooltip, not their UUIDs', async () => {
    // The entries are keyed by asset_id; a tooltip full of UUIDs would be worse than none.
    await show(twenty)

    const title = screen.getByRole('button', { name: '+18' }).title
    expect(title).toMatch(/^CNC_03, CNC_04/)
    expect(title).not.toMatch(/dev-/)
  })

  it('expands to the full fleet on demand', async () => {
    await show(twenty)
    fireEvent.click(screen.getByRole('button', { name: '+18' }))

    expect(screen.getByText('CNC_20')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'show less' })).toBeInTheDocument()
  })

  it('still reports an empty gateway plainly rather than as a zero count', async () => {
    await show([])
    expect(screen.getByText(/No devices assigned/i)).toBeInTheDocument()
  })
})
