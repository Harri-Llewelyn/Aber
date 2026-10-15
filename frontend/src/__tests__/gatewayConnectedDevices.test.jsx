import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
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
    // Past three tags, the Online / Offline summary counting as one, the rest collapse into +N.
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

describe('the gateways table sorts by a column (#801)', () => {
  const ago = (ms) => new Date(Date.now() - ms).toISOString()
  const MINUTE = 60_000
  const DAY = 24 * 60 * MINUTE
  const devices = (prefix, n) => Array.from({ length: n }, (_, i) => device(`${prefix}-${i}`, { asset_name: `${prefix}_${i}` }))
  const at = (id, name, devs, overrides) => ({ ...gateway(devs), gateway_id: id, gateway_name: name, ...overrides })

  /* In this order from the API. Stale_Gateway is stored ONLINE but its heartbeat has aged out, and
     Enrolled_Gateway keeps a heartbeat from a previous life. Archived_Gateway shows no status and no
     devices, Pending_Gateway has never been heard from, and two have no location: one scoped to a
     cell with none, and one simulated, which cannot hold a cell. */
  const fleet = () => [
    at('gw-archived', 'Archived_Gateway', devices('arch', 4), { is_archived: true, last_heartbeat: ago(2 * DAY), cell_id: 'cell-1' }),
    at('gw-online', 'Online_Gateway', devices('on', 2), { last_heartbeat: ago(10_000), cell_id: 'cell-2' }),
    at('gw-offline', 'Offline_Gateway', devices('off', 1), { status: 'OFFLINE', last_heartbeat: ago(60 * MINUTE), cell_id: null, location_scope: 'site_wide' }),
    at('gw-pending', 'Pending_Gateway', [], { status: 'PENDING_ENROLLMENT', last_heartbeat: null, cell_id: null, location_scope: 'cell' }),
    at('gw-enrolled', 'Enrolled_Gateway', devices('enr', 3), { status: 'AWAITING_BIRTH', last_heartbeat: ago(3 * DAY), cell_id: 'cell-9' }),
    at('gw-stale', 'Stale_Gateway', devices('stale', 5), { last_heartbeat: ago(10 * MINUTE), is_simulated: true, deployment: 'host' })
  ]

  const showFleet = async (url = '/gateways?lifecycle=all') => {
    window.history.replaceState(null, '', url)
    api.get.mockImplementation((path) => {
      if (path.startsWith('/api/v1/cells')) return Promise.resolve([{ cell_id: 'cell-1', cell_name: 'Assembly Line 1' }, { cell_id: 'cell-2', cell_name: 'Boiler Bay' }])
      if (path.startsWith('/api/v1/gateways')) return Promise.resolve(fleet())
      return Promise.resolve([])
    })
    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} />)
    await waitFor(() => expect(document.querySelectorAll('.table-wrap tbody tr')).toHaveLength(6))
  }
  const rows = () => [...document.querySelectorAll('.table-wrap tbody tr')]
  const names = () => rows().map(r => r.querySelector('strong').textContent.replace('_Gateway', ''))
  const address = () => window.location.pathname + window.location.search

  it('ranks Gateway Status by the badge’s severity, not its word, with an archived gateway last either way', async () => {
    await showFleet()
    const header = screen.getByRole('columnheader', { name: 'Gateway Status' })

    // Stale's amber, then waiting on a person, waiting on a machine, grey Offline, green Online.
    fireEvent.click(screen.getByRole('button', { name: 'Gateway Status' }))
    expect(names()).toEqual(['Stale', 'Pending', 'Enrolled', 'Offline', 'Online', 'Archived'])
    expect(header).toHaveAttribute('aria-sort', 'ascending')
    expect(address()).toBe('/gateways?lifecycle=all&sort=status')

    fireEvent.click(screen.getByRole('button', { name: 'Gateway Status' }))
    expect(names()).toEqual(['Online', 'Offline', 'Enrolled', 'Pending', 'Stale', 'Archived'])
    expect(header).toHaveAttribute('aria-sort', 'descending')
    expect(address()).toBe('/gateways?lifecycle=all&sort=-status')
  })

  it('sorts Last Heartbeat by instant with Never last, and Connected Devices by count with an archived gateway last', async () => {
    await showFleet()
    expect(within(rows()[3]).getByText('Never')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Last Heartbeat' }))
    expect(names()).toEqual(['Enrolled', 'Archived', 'Offline', 'Stale', 'Online', 'Pending'])
    fireEvent.click(screen.getByRole('button', { name: 'Last Heartbeat' }))
    expect(names()).toEqual(['Online', 'Stale', 'Offline', 'Archived', 'Enrolled', 'Pending'])

    fireEvent.click(screen.getByRole('button', { name: 'Connected Devices' }))
    expect(names()).toEqual(['Pending', 'Offline', 'Online', 'Enrolled', 'Stale', 'Archived'])
    fireEvent.click(screen.getByRole('button', { name: 'Connected Devices' }))
    expect(names()).toEqual(['Stale', 'Enrolled', 'Online', 'Offline', 'Pending', 'Archived'])
  })

  it('sorts Location by the cell’s name, or its id where the cell is unknown, with no location last either way', async () => {
    await showFleet()
    fireEvent.click(screen.getByRole('button', { name: 'Location' }))
    expect(names()).toEqual(['Archived', 'Online', 'Enrolled', 'Offline', 'Pending', 'Stale'])
    fireEvent.click(screen.getByRole('button', { name: 'Location' }))
    expect(names()).toEqual(['Offline', 'Enrolled', 'Online', 'Archived', 'Pending', 'Stale'])
  })

  /* The open drawer drops the UUID and Connected Devices columns; a sort by one of them stays in the
     address and in the order of the rows, and its header returns marked when the drawer closes. */
  it('opens sorted from the address, and keeps the order while the drawer hides the sorted column', async () => {
    await showFleet('/gateways?lifecycle=all&sort=-devices')
    const sorted = ['Stale', 'Enrolled', 'Online', 'Offline', 'Pending', 'Archived']
    expect(names()).toEqual(sorted)
    expect(screen.getByRole('columnheader', { name: 'Connected Devices' })).toHaveAttribute('aria-sort', 'descending')

    fireEvent.click(screen.getByText('Online_Gateway', { selector: 'tbody strong' }))
    await waitFor(() => expect(screen.queryByRole('columnheader', { name: 'Connected Devices' })).toBeNull())
    expect(screen.queryByRole('columnheader', { name: 'Gateway UUID' })).toBeNull()
    expect(document.querySelectorAll('th[aria-sort]')).toHaveLength(0)
    expect(names()).toEqual(sorted)
    expect(address()).toBe('/gateways?lifecycle=all&sort=-devices&gateway=gw-online')

    fireEvent.click(screen.getByText('Online_Gateway', { selector: 'tbody strong' }))
    await waitFor(() => expect(screen.getByRole('columnheader', { name: 'Connected Devices' })).toHaveAttribute('aria-sort', 'descending'))
    expect(names()).toEqual(sorted)
  })
})
