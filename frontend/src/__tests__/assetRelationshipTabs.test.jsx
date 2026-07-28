import React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CellsTab } from '../components/tabs/CellsTab'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import { OverviewTab } from '../components/tabs/OverviewTab'
import { TelemetryTab } from '../components/tabs/TelemetryTab'
import { PERMISSION_UUIDS } from '../constants'
import { api } from '../api'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn() }
  }
})

const NOW = Date.parse('2026-07-28T12:00:00Z')

const gateway = {
  gateway_id: 'gw-1',
  gateway_name: 'Virtual_Gateway_NodeRED',
  cell_id: 'cell-1',
  status: 'ONLINE',
  ip_address: '192.168.1.50',
  is_virtual: true,
  is_archived: false,
  last_heartbeat: new Date(NOW - 20_000).toISOString(),
  device_count: 1,
  devices: [
    { asset_id: 'dev-1', asset_name: 'Simulated_CNC_01', status: 'ONLINE', gateway_name: 'Virtual_Gateway_NodeRED', active_gateway_id: 'gw-1' }
  ]
}

const staleGateway = {
  ...gateway,
  gateway_id: 'gw-2',
  gateway_name: 'Quiet_Gateway',
  last_heartbeat: new Date(NOW - 10 * 60_000).toISOString(),
  device_count: 0,
  devices: []
}

const cell = {
  cell_id: 'cell-1',
  cell_name: 'Assembly Line 1',
  is_archived: false,
  gateways: [gateway],
  devices: gateway.devices,
  gateway_count: 1,
  device_count: 1
}

const routeGet = (overrides = {}) => (path) => {
  if (path.startsWith('/api/v1/cells')) return Promise.resolve(overrides.cells ?? [cell])
  if (path.startsWith('/api/v1/gateways')) return Promise.resolve(overrides.gateways ?? [gateway])
  if (path.startsWith('/api/v1/devices')) return Promise.resolve(overrides.devices ?? gateway.devices)
  if (path.startsWith('/api/v1/telemetry')) return Promise.resolve(overrides.telemetry ?? [])
  return Promise.resolve([])
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('CellsTab shows the gateways and devices attached to a cell', () => {
  it('lists a cell\'s gateways and the devices reachable through them', async () => {
    api.get.mockImplementation(routeGet())

    render(<CellsTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={() => true} />)

    await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())

    expect(screen.getByText('Assigned Edge Gateways (1)')).toBeInTheDocument()
    // Once in the gateway table, once as the device's resolved gateway (it used to
    // render the raw gateway UUID there).
    expect(screen.getAllByText('Virtual_Gateway_NodeRED')).toHaveLength(2)
    expect(screen.getByText('Assigned Devices (1)')).toBeInTheDocument()
    expect(screen.getByText('Simulated_CNC_01')).toBeInTheDocument()
    // Heartbeat age, not a raw timestamp
    expect(screen.getByText('20s ago')).toBeInTheDocument()
  })

  it('flags devices that belong to no cell instead of hiding them', async () => {
    api.get.mockImplementation(routeGet({
      cells: [{ ...cell, gateways: [], devices: [], gateway_count: 0, device_count: 0 }],
      devices: [{ asset_id: 'dev-9', asset_name: 'Orphan_CNC', status: 'ONLINE', cell_id: null }]
    }))

    render(<CellsTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={() => true} />)

    await waitFor(() => expect(screen.getByText(/1 device not linked to any cell zone/i)).toBeInTheDocument())
    expect(screen.getByText(/Orphan_CNC/)).toBeInTheDocument()
  })
})

describe('GatewaysTab reflects heartbeats and device assignment', () => {
  it('shows assigned devices and a fresh heartbeat as ONLINE', async () => {
    api.get.mockImplementation(routeGet())

    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Virtual_Gateway_NodeRED')).toBeInTheDocument())

    expect(screen.getByText('1 Online / 0 Offline')).toBeInTheDocument()
    expect(screen.getByText('Simulated_CNC_01')).toBeInTheDocument()
    expect(screen.getByText('20s ago')).toBeInTheDocument()
    expect(screen.getByTitle('Operational Status: ONLINE')).toBeInTheDocument()
    // Cell membership is visible, so an unlinked gateway is diagnosable from here.
    expect(screen.getByText('Assembly Line 1')).toBeInTheDocument()
  })

  it('downgrades a gateway with an aged-out heartbeat to STALE', async () => {
    api.get.mockImplementation(routeGet({ gateways: [staleGateway] }))

    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Quiet_Gateway')).toBeInTheDocument())

    expect(screen.getByTitle('Operational Status: STALE')).toBeInTheDocument()
    expect(screen.getByText('No devices assigned')).toBeInTheDocument()
  })
})

describe('OverviewTab shopfloor map', () => {
  it('places a cell\'s gateways and devices on its zone', async () => {
    api.get.mockImplementation(routeGet({ telemetry: [] }))

    render(
      <OverviewTab
        onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={vi.fn()}
        hasPermission={() => true} onNavigateTab={vi.fn()}
      />
    )

    await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())

    expect(screen.getByText('Active Edge Gateways (1)')).toBeInTheDocument()
    expect(screen.getByText('Operating Devices (1)')).toBeInTheDocument()
    expect(screen.getByText('Simulated_CNC_01')).toBeInTheDocument()
    // Gateway and device stat cards both read 1 online -- the gateway counts as online
    // because its heartbeat is fresh.
    expect(screen.getAllByText('1 Online / 0 Offline / 0 Archived')).toHaveLength(2)
  })

  it('refuses to "reassign" a device into a cell that has no gateway', async () => {
    const showToast = vi.fn()
    api.get.mockImplementation(routeGet({
      cells: [{ ...cell, gateways: [], devices: [], gateway_count: 0, device_count: 0 }],
      gateways: []
    }))

    render(
      <OverviewTab
        onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={showToast}
        hasPermission={() => true} onNavigateTab={vi.fn()}
      />
    )

    await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())

    const zone = screen.getByTitle(/Drag device node here to reassign/)
    fireEvent.drop(zone, {
      dataTransfer: { getData: () => JSON.stringify({ asset_id: 'dev-1', asset_name: 'Simulated_CNC_01' }) }
    })

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(expect.stringContaining('no active edge gateway'), 'error')
    )
    // No write attempted -- the old code PUT a cell_id that PostgREST silently dropped.
    expect(api.put).not.toHaveBeenCalled()
  })
})

describe('TelemetryTab renders the full stream', () => {
  const page = (n, metric = 'temperature') =>
    Array.from({ length: n }, (_, i) => ({
      time: new Date(NOW - i * 1000).toISOString(),
      asset_id: 'Simulated_CNC_01',
      metric_name: i % 2 === 0 ? metric : 'vibration',
      val_double: i
    }))

  it('offers a Load More control while full pages keep coming back', async () => {
    api.get.mockImplementation((path) =>
      path.startsWith('/api/v1/telemetry') ? Promise.resolve(page(500)) : Promise.resolve([])
    )

    render(<TelemetryTab initialAssetFilter="" onClearFilter={vi.fn()} hasPermission={() => true} />)

    await waitFor(() => expect(screen.getByText(/Showing 500 records/)).toBeInTheDocument())
    expect(screen.getByText(/more available/)).toBeInTheDocument()

    // Metric options come from the data, so a metric the old hardcoded list omitted is selectable.
    expect(screen.getByRole('option', { name: 'vibration' })).toBeInTheDocument()

    api.get.mockImplementation((path) =>
      path.startsWith('/api/v1/telemetry') ? Promise.resolve(page(20)) : Promise.resolve([])
    )
    fireEvent.click(screen.getByRole('button', { name: /Load 500 More/ }))

    await waitFor(() => expect(screen.getByText(/Showing 520 records/)).toBeInTheDocument())
    expect(screen.getByText(/end of stream/)).toBeInTheDocument()
  })

  it('surfaces a failed telemetry query instead of showing an empty table', async () => {
    api.get.mockImplementation((path) =>
      path.startsWith('/api/v1/telemetry')
        ? Promise.reject(new Error('relation "telemetry" does not exist'))
        : Promise.resolve([])
    )

    render(<TelemetryTab initialAssetFilter="" onClearFilter={vi.fn()} hasPermission={() => true} />)

    await waitFor(() => expect(screen.getByText(/Telemetry query failed/)).toBeInTheDocument())
    expect(screen.getByText(/relation "telemetry" does not exist/)).toBeInTheDocument()
  })

  it('still gates on the telemetry:read permission', () => {
    api.get.mockResolvedValue([])
    render(<TelemetryTab initialAssetFilter="" onClearFilter={vi.fn()} hasPermission={(p) => p !== PERMISSION_UUIDS.TELEMETRY_READ} />)
    expect(screen.getByText('Access Restricted')).toBeInTheDocument()
  })
})
