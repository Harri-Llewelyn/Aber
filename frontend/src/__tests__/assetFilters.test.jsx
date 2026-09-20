import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CellsTab } from '../components/tabs/CellsTab'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import { DevicesTab } from '../components/tabs/DevicesTab'
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
  cell_id: 'cell-1', status: 'ONLINE', deployment: 'remote', is_archived: false,
  last_heartbeat: new Date(NOW - 20_000).toISOString(), device_count: 2, devices: []
}
// Heartbeat older than the 90s staleness threshold, so gatewayLiveStatus() reports STALE even
// though the stored status column still says ONLINE.
const staleHostGateway = {
  ...onlineGateway,
  gateway_id: 'gw-2', gateway_name: 'Sim_Gateway', sparkplug_id: 'gwy200000000000400080000',
  cell_id: 'cell-2', deployment: 'host',
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
    gateways: [staleHostGateway], devices: [neverBornDevice, quarantinedDevice] },
  // Empty: no gateways at all.
  { cell_id: 'cell-3', cell_name: 'Spare Bay 3', is_archived: false, gateways: [], devices: [] }
]

const routeGet = (overrides = {}) => (path) => {
  if (path.startsWith('/api/v1/cells'))          return Promise.resolve(overrides.cells ?? cells)
  if (path.startsWith('/api/v1/gateways'))       return Promise.resolve(overrides.gateways ?? [onlineGateway, staleHostGateway])
  if (path.startsWith('/api/v1/quarantine'))     return Promise.resolve(overrides.quarantine ?? [quarantinedDevice])
  if (path.startsWith('/api/v1/metric-catalog')) return Promise.resolve(overrides.catalog ?? CATALOG)
  if (path.startsWith('/api/v1/schemas'))        return Promise.resolve(overrides.schemas ?? SCHEMAS)
  if (path.startsWith('/api/v1/devices'))        return Promise.resolve(overrides.devices ?? ALL_DEVICES)
  if (path.startsWith('/api/v1/telemetry'))      return Promise.resolve(overrides.telemetry ?? [])
  return Promise.resolve([])
}

const allowAll = () => true
const noop = () => {}

/**
 * The devices table, found by a column only it has. Was "the last table on the page", which was
 * true only while the quarantine queue rendered above it -- the queue is now a card of its own
 * below, and position silently selected the wrong table rather than failing.
 */
const deviceTableRows = () => {
  const table = [...document.querySelectorAll('table')]
    .find(t => within(t).queryByText('Device UUID'))
  if (!table) throw new Error('no table on the page carries a Device UUID column')
  return within(table.querySelector('tbody')).queryAllByRole('row')
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

  it('keeps a device that has never spoken out of the "Offline / DDEATH" lane', async () => {
    // The two are neighbouring options with different meanings, and the label of this one is a
    // claim: a DDEATH is something a device sends, and Robot_03 has never sent anything. Before
    // the status fix the question could not even arise -- a never-born device was stored ONLINE.
    api.get.mockImplementation(routeGet())
    renderDevices()
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())

    fireEvent.change(screen.getByTitle('Filter by operational state'), { target: { value: 'offline' } })
    await waitFor(() => expect(screen.getByText('CNC_02')).toBeTruthy())
    expect(screen.queryByText('Robot_03')).toBeNull()
  })

  it('draws a registered device as awaiting its first birth, never as running', async () => {
    // The defect, at the render site: Robot_03 has never sent a DBIRTH, and the row must not carry
    // an Online badge for it under any status the database happens to hold.
    api.get.mockImplementation(routeGet())
    renderDevices()
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())

    fireEvent.change(screen.getByTitle('Filter by operational state'), { target: { value: 'unborn' } })
    await waitFor(() => expect(screen.getByText('Robot_03')).toBeTruthy())

    // Scoped to the row: "Online" is also the text of an option in the filter above it.
    const row = screen.getByText('Robot_03').closest('tr')
    expect(within(row).getByText('Awaiting first birth')).toBeTruthy()
    expect(within(row).queryByText('Online')).toBeNull()
    expect(row.querySelector('.badge-online')).toBeNull()
  })

  it('surfaces only devices needing operator action', async () => {
    api.get.mockImplementation(routeGet())
    renderDevices()
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())

    // Selected by its visible label rather than its title text, so rewording the tooltip does not
    // break the test.
    fireEvent.click(screen.getByRole('button', { name: /Needs attention/i }))

    await waitFor(() => expect(screen.queryByText('CNC_01')).toBeNull())
    // Robot_03 is overdue its first birth; the quarantined device is listed in the queue above.
    expect(screen.getByText('Robot_03')).toBeTruthy()
  })

  // A quarantined device renders in the onboarding queue only, not again in the table below with
  // edit/archive actions that do not apply to it.
  it('lists a quarantined device in the onboarding queue but not in the devices table', async () => {
    api.get.mockImplementation(routeGet())
    renderDevices()
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())

    // Present on the page exactly once -- in the quarantine queue.
    expect(screen.getAllByText('Unknown_Thing')).toHaveLength(1)

    // ...and that one occurrence is not in the devices table.
    const tableNames = deviceTableRows().map(r => r.textContent)
    expect(tableNames.some(t => t.includes('Unknown_Thing'))).toBe(false)
    expect(tableNames.some(t => t.includes('CNC_01'))).toBe(true)
  })

  it('keeps quarantined devices out of the table even when a filter would match them', async () => {
    api.get.mockImplementation(routeGet())
    renderDevices()
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())

    // gw-2 / cell-2 is the quarantined device's gateway. Only Robot_03 should surface.
    fireEvent.change(screen.getByTitle('Filter by serving edge gateway'), { target: { value: 'gw-2' } })

    await waitFor(() => expect(screen.queryByText('CNC_01')).toBeNull())
    const tableNames = deviceTableRows().map(r => r.textContent)
    expect(tableNames.some(t => t.includes('Robot_03'))).toBe(true)
    expect(tableNames.some(t => t.includes('Unknown_Thing'))).toBe(false)
  })

  // The badge must agree with what switching the filter on reveals. Quarantined devices are counted
  // by the queue's own badge.
  it('excludes quarantined devices from the needs-attention count', async () => {
    api.get.mockImplementation(routeGet())
    renderDevices()
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())

    // Of the four fixtures only Robot_03 (overdue) qualifies once the quarantined one is out.
    expect(screen.getByRole('button', { name: /Needs attention \(1\)/i })).toBeTruthy()
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

  it('separates gateways by the type the column reports', async () => {
    // The filter reads the derived type through the same helper that prints the column: a simulated
    // gateway is host-run, so filtering on `deployment` alone cannot separate it from the real
    // connectors.
    api.get.mockImplementation(routeGet())
    renderGateways()
    await waitFor(() => expect(screen.getByText('Line_A_Gateway')).toBeTruthy())

    fireEvent.change(screen.getByTitle(/filter by the type column/i), { target: { value: 'remote' } })
    await waitFor(() => expect(screen.queryByText('Sim_Gateway')).toBeNull())
    expect(screen.getByText('Line_A_Gateway')).toBeTruthy()
  })

  it('tells a simulated gateway apart from the host-run connector it shares a deployment with', async () => {
    // The case a `deployment` filter cannot express: both are `deployment: 'host'`, which
    // gateways_simulated_is_host requires of the simulated one.
    api.get.mockImplementation(routeGet({
      gateways: [
        { ...staleHostGateway, gateway_name: 'Host_Connector', is_simulated: false },
        { ...staleHostGateway, gateway_id: 'gw-3', gateway_name: 'Sim_Fleet', is_simulated: true }
      ]
    }))
    renderGateways()
    await waitFor(() => expect(screen.getByText('Host_Connector')).toBeTruthy())

    fireEvent.change(screen.getByTitle(/filter by the type column/i), { target: { value: 'simulated' } })
    await waitFor(() => expect(screen.queryByText('Host_Connector')).toBeNull())
    expect(screen.getByText('Sim_Fleet')).toBeTruthy()
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

// The fleet-wide metric filter has no equivalent in the per-device telemetry drawer; see
// deviceTelemetryAccordion.test.jsx.
