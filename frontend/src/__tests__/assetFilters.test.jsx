import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CellsTab } from '../components/tabs/CellsTab'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import { DevicesTab } from '../components/tabs/DevicesTab'
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

vi.mock('../lib/supabaseClient', () => ({
  supabase: { functions: { invoke: vi.fn() } }
}))

const NOW = Date.parse('2026-07-28T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000

const onlineGateway = {
  gateway_id: 'gw-1', gateway_name: 'Line_A_Gateway', sparkplug_id: 'gwy100000000000400080000',
  cell_id: 'cell-1', status: 'ONLINE', is_virtual: false, is_archived: false,
  last_heartbeat: new Date(NOW - 20_000).toISOString(), device_count: 2, devices: []
}
// Heartbeat older than the 90s staleness threshold, so gatewayLiveStatus() reports STALE even
// though the stored status column still says ONLINE.
const staleVirtualGateway = {
  ...onlineGateway,
  gateway_id: 'gw-2', gateway_name: 'Sim_Gateway', sparkplug_id: 'gwy200000000000400080000',
  cell_id: 'cell-2', is_virtual: true,
  last_heartbeat: new Date(NOW - 10 * 60_000).toISOString(), device_count: 1
}

const healthyDevice = {
  asset_id: 'aaaaaaaa-0000-4000-8000-000000000001', asset_name: 'CNC_01',
  sparkplug_id: 'devaaaaaaaa000040008000', status: 'ONLINE', is_quarantined: false,
  is_archived: false, active_gateway_id: 'gw-1', cell_id: 'cell-1',
  schema_id: 'schema-cnc', first_dbirth_at: new Date(NOW - DAY).toISOString(),
  created_at: new Date(NOW - 5 * DAY).toISOString(), identity_source: 'sparkplug_id'
}
const offlineDevice = {
  ...healthyDevice,
  asset_id: 'aaaaaaaa-0000-4000-8000-000000000002', asset_name: 'CNC_02',
  sparkplug_id: 'devaaaaaaaa000040008001', status: 'OFFLINE', schema_id: 'schema-robot'
}
// Provisioned 5 days ago, never sent a birth -> overdue, and therefore "needs attention".
const neverBornDevice = {
  ...healthyDevice,
  asset_id: 'aaaaaaaa-0000-4000-8000-000000000003', asset_name: 'Robot_03',
  sparkplug_id: 'devaaaaaaaa000040008002', status: 'OFFLINE', first_dbirth_at: null,
  schema_id: 'schema-robot', active_gateway_id: 'gw-2', cell_id: 'cell-2'
}
const quarantinedDevice = {
  ...healthyDevice,
  asset_id: 'aaaaaaaa-0000-4000-8000-000000000004', asset_name: 'Unknown_Thing',
  sparkplug_id: 'devaaaaaaaa000040008003', is_quarantined: true, schema_id: null,
  active_gateway_id: 'gw-2', cell_id: 'cell-2', quarantine_id: 'aaaaaaaa-0000-4000-8000-000000000004',
  reported_identity: 'devfffffffffffffffffffff', quarantine_reason: 'UNKNOWN_DEVICE',
  discovered_at: new Date(NOW - 60_000).toISOString(), reported_metrics: []
}

const ALL_DEVICES = [healthyDevice, offlineDevice, neverBornDevice, quarantinedDevice]

const SCHEMAS = [
  { schema_uuid: 'schema-cnc', schema_name: 'CNC-Standard', schema_definition: {} },
  { schema_uuid: 'schema-robot', schema_name: 'Robot-Arm-Standard', schema_definition: {} }
]

const CATALOG = [
  { metric_uuid: 'm1', name: 'temperature', datatype: 10, deprecated: false },
  { metric_uuid: 'm2', name: 'vibration', datatype: 10, deprecated: false },
  { metric_uuid: 'm3', name: 'legacy_rpm', datatype: 10, deprecated: true }
]

const cells = [
  // Healthy: online gateway, devices attached.
  { cell_id: 'cell-1', cell_name: 'Assembly Line 1', is_archived: false,
    gateways: [onlineGateway], devices: [healthyDevice, offlineDevice] },
  // Attention: stale gateway AND a quarantined device.
  { cell_id: 'cell-2', cell_name: 'Weld Cell 2', is_archived: false,
    gateways: [staleVirtualGateway], devices: [neverBornDevice, quarantinedDevice] },
  // Empty: no gateways at all.
  { cell_id: 'cell-3', cell_name: 'Spare Bay 3', is_archived: false, gateways: [], devices: [] }
]

const routeGet = (overrides = {}) => (path) => {
  if (path.startsWith('/api/v1/cells'))          return Promise.resolve(overrides.cells ?? cells)
  if (path.startsWith('/api/v1/gateways'))       return Promise.resolve(overrides.gateways ?? [onlineGateway, staleVirtualGateway])
  if (path.startsWith('/api/v1/quarantine'))     return Promise.resolve(overrides.quarantine ?? [quarantinedDevice])
  if (path.startsWith('/api/v1/metric-catalog')) return Promise.resolve(overrides.catalog ?? CATALOG)
  if (path.startsWith('/api/v1/schemas'))        return Promise.resolve(overrides.schemas ?? SCHEMAS)
  if (path.startsWith('/api/v1/devices'))        return Promise.resolve(overrides.devices ?? ALL_DEVICES)
  if (path.startsWith('/api/v1/telemetry'))      return Promise.resolve(overrides.telemetry ?? [])
  return Promise.resolve([])
}

const allowAll = () => true
const noop = () => {}

/** The devices table is the last table on the page; the quarantine queue renders above it. */
const deviceTableRows = () => {
  const tables = document.querySelectorAll('table')
  const body = tables[tables.length - 1].querySelector('tbody')
  return within(body).queryAllByRole('row')
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)
  window.history.replaceState({}, '', '/devices')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('DevicesTab filters', () => {
  const renderDevices = (props = {}) =>
    render(<DevicesTab showToast={noop} onSelectDevice={noop} hasPermission={allowAll} {...props} />)

  it('narrows to a single schema when handed one from the Schemas page', async () => {
    api.get.mockImplementation(routeGet())
    renderDevices({ initialSchemaFilter: 'schema-robot' })

    await waitFor(() => expect(screen.getByText('Robot_03')).toBeTruthy())
    // CNC_01 carries schema-cnc and must be filtered out.
    expect(screen.queryByText('CNC_01')).toBeNull()
    expect(screen.getByText('CNC_02')).toBeTruthy()
    expect(screen.getByText(/provisioned with schema/i).textContent).toContain('Robot-Arm-Standard')
  })

  it('reads the schema filter from the ?schema= query parameter', async () => {
    window.history.replaceState({}, '', '/devices?schema=schema-cnc')
    api.get.mockImplementation(routeGet())
    renderDevices()

    await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())
    expect(screen.queryByText('Robot_03')).toBeNull()
  })

  it('filters by operational status', async () => {
    api.get.mockImplementation(routeGet())
    renderDevices()
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())

    fireEvent.change(screen.getByTitle('Filter by operational state'), { target: { value: 'online' } })
    await waitFor(() => expect(screen.queryByText('CNC_02')).toBeNull())
    expect(screen.getByText('CNC_01')).toBeTruthy()
  })

  it('distinguishes "never sent a birth" from plain offline', async () => {
    api.get.mockImplementation(routeGet())
    renderDevices()
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())

    fireEvent.change(screen.getByTitle('Filter by operational state'), { target: { value: 'unborn' } })
    // CNC_02 is OFFLINE but has a first_dbirth_at, so it is not "never seen".
    await waitFor(() => expect(screen.queryByText('CNC_02')).toBeNull())
    expect(screen.getByText('Robot_03')).toBeTruthy()
  })

  it('surfaces only devices needing operator action', async () => {
    api.get.mockImplementation(routeGet())
    renderDevices()
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())

    fireEvent.click(screen.getByTitle(/quarantined, overdue their first birth, or still matched by legacy name/i))

    await waitFor(() => expect(screen.queryByText('CNC_01')).toBeNull())
    // Robot_03 is overdue its first birth; the quarantined device is listed in the queue above.
    expect(screen.getByText('Robot_03')).toBeTruthy()
  })

  it('filters by serving gateway', async () => {
    api.get.mockImplementation(routeGet())
    renderDevices()
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())

    fireEvent.change(screen.getByTitle('Filter by serving edge gateway'), { target: { value: 'gw-2' } })
    await waitFor(() => expect(screen.queryByText('CNC_01')).toBeNull())
    expect(screen.getByText('Robot_03')).toBeTruthy()
  })

  it('clears every filter at once and reports how many were active', async () => {
    api.get.mockImplementation(routeGet())
    renderDevices({ initialSchemaFilter: 'schema-robot' })
    await waitFor(() => expect(screen.getByText('Robot_03')).toBeTruthy())

    fireEvent.change(screen.getByTitle('Filter by operational state'), { target: { value: 'offline' } })
    const clear = await screen.findByTitle('Clear every filter')
    expect(clear.textContent).toContain('2')

    fireEvent.click(clear)
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())
    expect(screen.queryByTitle('Clear every filter')).toBeNull()
  })
})

describe('GatewaysTab filters', () => {
  const renderGateways = () =>
    render(<GatewaysTab showToast={noop} hasPermission={allowAll} />)

  it('filters on live heartbeat status rather than the stored status column', async () => {
    api.get.mockImplementation(routeGet())
    renderGateways()
    await waitFor(() => expect(screen.getByText('Line_A_Gateway')).toBeTruthy())

    // Both rows have status: 'ONLINE' stored; only one is live.
    fireEvent.change(screen.getByTitle(/live heartbeat status/i), { target: { value: 'STALE' } })
    await waitFor(() => expect(screen.queryByText('Line_A_Gateway')).toBeNull())
    expect(screen.getByText('Sim_Gateway')).toBeTruthy()
  })

  it('separates virtual gateways from physical hardware', async () => {
    api.get.mockImplementation(routeGet())
    renderGateways()
    await waitFor(() => expect(screen.getByText('Line_A_Gateway')).toBeTruthy())

    fireEvent.change(screen.getByTitle(/simulated\/virtual edge nodes/i), { target: { value: 'physical' } })
    await waitFor(() => expect(screen.queryByText('Sim_Gateway')).toBeNull())
    expect(screen.getByText('Line_A_Gateway')).toBeTruthy()
  })

  it('points at the gateway reporting quarantined devices', async () => {
    api.get.mockImplementation(routeGet())
    renderGateways()
    await waitFor(() => expect(screen.getByText('Line_A_Gateway')).toBeTruthy())

    fireEvent.click(screen.getByTitle(/gateways currently reporting devices held in quarantine/i))
    await waitFor(() => expect(screen.queryByText('Line_A_Gateway')).toBeNull())
    expect(screen.getByText('Sim_Gateway')).toBeTruthy()
  })
})

describe('CellsTab filters', () => {
  const renderCells = () =>
    render(<CellsTab showToast={noop} onSelectDevice={noop} hasPermission={allowAll} />)

  it('rolls gateway and device condition up to the cell', async () => {
    api.get.mockImplementation(routeGet())
    renderCells()
    await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeTruthy())

    fireEvent.click(screen.getByTitle(/offline or stale gateway, or any quarantined device/i))
    await waitFor(() => expect(screen.queryByText('Assembly Line 1')).toBeNull())
    expect(screen.getByText('Weld Cell 2')).toBeTruthy()
  })

  it('finds cells with no gateways or no devices', async () => {
    api.get.mockImplementation(routeGet())
    renderCells()
    await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeTruthy())

    fireEvent.click(screen.getByTitle(/no gateways, or gateways serving no devices/i))
    await waitFor(() => expect(screen.queryByText('Assembly Line 1')).toBeNull())
    expect(screen.getByText('Spare Bay 3')).toBeTruthy()
  })
})

describe('TelemetryTab metric filter', () => {
  it('offers registered catalog metrics even when none have arrived in the stream', async () => {
    api.get.mockImplementation(routeGet({ telemetry: [] }))
    render(<TelemetryTab hasPermission={() => true} />)

    const select = await screen.findByTitle(/registered catalog metric/i)
    await waitFor(() => expect(within(select).queryByRole('option', { name: 'temperature' })).toBeTruthy())
    expect(within(select).queryByRole('option', { name: 'vibration' })).toBeTruthy()
  })

  it('omits deprecated catalog metrics', async () => {
    api.get.mockImplementation(routeGet({ telemetry: [] }))
    render(<TelemetryTab hasPermission={() => true} />)

    const select = await screen.findByTitle(/registered catalog metric/i)
    await waitFor(() => expect(within(select).queryByRole('option', { name: 'temperature' })).toBeTruthy())
    expect(within(select).queryByRole('option', { name: 'legacy_rpm' })).toBeNull()
  })

  it('separates metrics seen in the stream that no catalog entry covers', async () => {
    api.get.mockImplementation(routeGet({
      telemetry: [
        { time: new Date(NOW).toISOString(), asset_id: 'devaaaaaaaa000040008000', metric_name: 'tempreature', val_double: 42 }
      ]
    }))
    render(<TelemetryTab hasPermission={() => true} />)

    const select = await screen.findByTitle(/registered catalog metric/i)
    // A typo'd metric name is exactly what this grouping is meant to expose.
    await waitFor(() => expect(within(select).queryByRole('option', { name: 'tempreature' })).toBeTruthy())
    const groups = select.querySelectorAll('optgroup')
    expect([...groups].map(g => g.label)).toEqual(['Metric catalog', 'Uncatalogued (seen in stream)'])
  })
})
