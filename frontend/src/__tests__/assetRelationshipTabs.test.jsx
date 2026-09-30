import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CellsTab } from '../components/tabs/CellsTab'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import { SiteMapTab } from '../components/tabs/SiteMapTab'
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
  gateway_name: 'Host_Gateway_NodeRED',
  cell_id: 'cell-1',
  // NOT NULL DEFAULT 'cell' (archived migration 20260101000036_device_location), so every real payload carries it. Host and
  // site-wide are independent: this fixture is a host-run gateway that has been given a cell.
  location_scope: 'cell',
  status: 'ONLINE',
  deployment: 'host',
  is_archived: false,
  last_heartbeat: new Date(NOW - 20_000).toISOString(),
  device_count: 1,
  devices: [
    {
      asset_id: 'dev-1', asset_name: 'Simulated_CNC_01', status: 'ONLINE',
      gateway_name: 'Host_Gateway_NodeRED', active_gateway_id: 'gw-1',
      // Location as api.js merges it from device_locations: no explicit override, so the device
      // inherits its gateway's cell. Cell membership is grouped from the device list by the tabs.
      cell_id: null, location_scope: 'cell', effective_cell_id: 'cell-1',
      gateway_cell_id: 'cell-1', location_source: 'inherited', cell_mismatch: false
    }
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

// No `devices`/`device_count`: /api/v1/cells returns gateways only, and membership is resolved from
// the device list by groupDevicesByCell().
const cell = {
  cell_id: 'cell-1',
  cell_name: 'Assembly Line 1',
  is_archived: false,
  gateways: [gateway],
  gateway_count: 1
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
  it('names a cell\'s gateways and the devices reachable through them, on one row', async () => {
    api.get.mockImplementation(routeGet())

    render(<CellsTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={() => true} />)

    await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())

    // A cell names the gateways assigned to it and the devices that resolve to it, as two columns
    // of one table.
    const row = screen.getByText('Assembly Line 1').closest('tr')
    expect(within(row).getByText('Host_Gateway_NodeRED')).toBeTruthy()
    expect(within(row).getByText('Simulated_CNC_01')).toBeTruthy()
    // The same summary the Gateways page puts on a gateway's device column.
    expect(within(row).getByText('1 Online / 0 Offline')).toBeTruthy()

    // The heartbeat is not here: per-gateway status and heartbeat age are on the Gateways page, one
    // click away through the drawer's chip.
    expect(screen.queryByText('20s ago')).toBeNull()
  })

  it('does not flag a Site-Wide device as unlinked', async () => {
    // It resolves to no cell, but that is the operator's answer rather than an omission; flagging
    // it would be a permanent warning no action could clear.
    api.get.mockImplementation(routeGet({
      cells: [{ ...cell, gateways: [], gateway_count: 0 }],
      devices: [{ asset_id: 'dev-s', asset_name: 'Site_BMS', status: 'ONLINE',
                  cell_id: null, location_scope: 'site_wide',
                  effective_cell_id: null, location_source: 'site_wide' }]
    }))

    render(<CellsTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={() => true} />)

    await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())
    expect(screen.queryByText(/not linked to any cell/i)).not.toBeInTheDocument()
  })

  it('flags devices that belong to no cell instead of hiding them', async () => {
    api.get.mockImplementation(routeGet({
      cells: [{ ...cell, gateways: [], gateway_count: 0 }],
      devices: [{ asset_id: 'dev-9', asset_name: 'Orphan_CNC', status: 'ONLINE', cell_id: null }]
    }))

    render(<CellsTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={() => true} />)

    await waitFor(() => expect(screen.getByText(/1 device not linked to any cell/i)).toBeInTheDocument())
    expect(screen.getByText(/Orphan_CNC/)).toBeInTheDocument()
    // The banner offers both ways out of a wide scope.
    const banner = screen.getByText(/1 device not linked to any cell/i).closest('.callout-page')
    expect(banner).toHaveClass('callout', 'callout-warning')
    expect(banner).toHaveTextContent(/Site-Wide or Area-Wide/)
  })
})

describe('GatewaysTab reflects heartbeats and device assignment', () => {
  it('shows assigned devices and a fresh heartbeat as ONLINE', async () => {
    api.get.mockImplementation(routeGet())

    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Host_Gateway_NodeRED')).toBeInTheDocument())

    expect(screen.getByText('1 Online / 0 Offline')).toBeInTheDocument()
    expect(screen.getByText('Simulated_CNC_01')).toBeInTheDocument()
    expect(screen.getByText('20s ago')).toBeInTheDocument()
    expect(screen.getByTitle('Operational Status: ONLINE')).toBeInTheDocument()
    // Cell membership is visible, so an unlinked gateway is diagnosable from here.
    expect(screen.getByText('Assembly Line 1')).toBeInTheDocument()
  })

  it('shows Site-Wide as its own state, not as a missing cell', async () => {
    // Three states, not two. A host-run connector serving the facility has answered the
    // question; rendering it the same as "no cell" invites someone to keep trying to fix it.
    api.get.mockImplementation(routeGet({
      gateways: [{ ...gateway, cell_id: null, location_scope: 'site_wide' }]
    }))

    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Host_Gateway_NodeRED')).toBeInTheDocument())
    expect(screen.getByText('Site-Wide')).toBeInTheDocument()
    expect(screen.queryByText('No cell')).not.toBeInTheDocument()
  })

  it('clears the cell when a gateway is set to Site-Wide, mirroring the CHECK constraint', async () => {
    api.get.mockImplementation(routeGet())
    api.put.mockResolvedValue({})

    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Host_Gateway_NodeRED')).toBeInTheDocument())

    // Edit moved into the context panel with the rest of the gateway ACTIONS column.
    fireEvent.click(within(document.querySelector('.page-main')).getByText('Host_Gateway_NodeRED'))
    fireEvent.click(within(document.querySelector('.context-panel')).getByText('Edit Details'))
    // Site-Wide is one radio of three, not a checkbox beside the cell picker: you cannot choose
    // Site-Wide and a cell because they are the same question.
    fireEvent.click(screen.getByRole('radio', { name: /Site-Wide/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }))

    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(api.put.mock.calls[0][1]).toMatchObject({ location_scope: 'site_wide', cell_id: '' })
  })

  it('does not treat the Type control as a location assertion', async () => {
    // Host is a deployment fact; site-wide is a claim about location. A host-run gateway is
    // usually site-wide, but tying them together would relocate assets on a checkbox.
    api.get.mockImplementation(routeGet())
    api.put.mockResolvedValue({})

    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Host_Gateway_NodeRED')).toBeInTheDocument())

    fireEvent.click(within(document.querySelector('.page-main')).getByText('Host_Gateway_NodeRED'))
    fireEvent.click(within(document.querySelector('.context-panel')).getByText('Edit Details'))
    // Changing the type must not move the cell: where the connector runs and where its assets are
    // are different questions.
    fireEvent.change(document.querySelector('#gateway-type'), { target: { value: 'host' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }))

    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(api.put.mock.calls[0][1]).toMatchObject({ location_scope: 'cell', cell_id: 'cell-1' })
  })

  it("names the offline gateways in a banner above the table, matching the rail's amber", async () => {
    // The sidebar turns the Gateways icon amber for an offline gateway; the page has to say which.
    api.get.mockImplementation(routeGet({ gateways: [gateway, staleGateway] }))
    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Quiet_Gateway')).toBeInTheDocument())
    const banner = screen.getByText(/1 gateway offline/).closest('div')
    expect(banner).toHaveTextContent('Quiet_Gateway')
    expect(banner).not.toHaveTextContent('Host_Gateway_NodeRED')
    expect(banner.closest('.card')).toBeNull()
  })

  it('downgrades a gateway with an aged-out heartbeat to STALE', async () => {
    api.get.mockImplementation(routeGet({ gateways: [staleGateway] }))

    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Quiet_Gateway')).toBeInTheDocument())

    expect(screen.getByTitle('Operational Status: STALE')).toBeInTheDocument()
    expect(screen.getByText('No devices assigned')).toBeInTheDocument()
  })
})

// Paging a fleet-wide stream has no equivalent in the per-device telemetry modal, which shows the
// latest value per metric and defers history to the CSV export. See telemetryModal.test.jsx.

// Site Map -> Cells hand-over: a pin on the Site Map opens the cell's panel, whose action emits
// the cell id, and Cells consumes it the way Gateways and Devices consume theirs.
describe('The Site Map hands a cell over to the Cells page', () => {
  const area = { area_id: 'area-1', area_name: 'Building A', icon: 'Factory', plan_path: null, plan_aspect: null, cells: [] }
  const placedCell = { ...cell, area_id: 'area-1', plan_x: 0.4, plan_y: 0.6 }
  const routes = (path) => {
    if (path.startsWith('/api/v1/areas')) return Promise.resolve([area])
    return routeGet({ cells: [placedCell] })(path)
  }

  const renderSiteMap = (props = {}) => render(
    <SiteMapTab
      onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={vi.fn()}
      hasPermission={() => true} onNavigateTab={vi.fn()} {...props}
    />
  )

  const openPanel = async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Building A' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Assembly Line 1' }))
    return screen.findByRole('button', { name: /Open on Cells page/ })
  }

  it('passes the clicked cell id to onSelectCell', async () => {
    api.get.mockImplementation(routes)
    const onSelectCell = vi.fn()
    renderSiteMap({ onSelectCell })

    fireEvent.click(await openPanel())

    // The id, not the name: it is stable and unique, and CellsTab's predicate matches either.
    expect(onSelectCell).toHaveBeenCalledWith('cell-1')
  })

  it('still navigates when no onSelectCell is wired, rather than doing nothing', async () => {
    api.get.mockImplementation(routes)
    const onNavigateTab = vi.fn()
    renderSiteMap({ onNavigateTab })

    fireEvent.click(await openPanel())

    expect(onNavigateTab).toHaveBeenCalledWith('cells')
  })
})

describe('CellsTab consumes a handed-over cell filter', () => {
  const otherCell = { cell_id: 'cell-2', cell_name: 'Weld Bay 2', is_archived: false, gateways: [], gateway_count: 0 }
  const bothCells = routeGet({ cells: [cell, otherCell] })

  afterEach(() => {
    window.history.replaceState({}, '', '/')
  })

  it('isolates the cell named by ?search=', async () => {
    window.history.replaceState({}, '', '/cells?search=cell-1')
    api.get.mockImplementation(bothCells)

    render(<CellsTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={() => true} />)

    await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())
    expect(screen.queryByText('Weld Bay 2')).not.toBeInTheDocument()
    // The existing affordance is what tells the user the list is narrowed.
    expect(screen.getByText(/Clear filters \(1\)/)).toBeInTheDocument()
  })

  it('falls back to the lifted initialSearchFilter prop when no query param was pushed', async () => {
    api.get.mockImplementation(bothCells)

    render(<CellsTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={() => true}
                     initialSearchFilter="cell-2" onClearFilter={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Weld Bay 2')).toBeInTheDocument())
    expect(screen.queryByText('Assembly Line 1')).not.toBeInTheDocument()
  })

  it('matches on cell name too, so the search box keeps working by hand', async () => {
    api.get.mockImplementation(bothCells)

    render(<CellsTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={() => true} />)

    await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText(/Search by Cell UUID or name/), { target: { value: 'Weld' } })

    expect(screen.getByText('Weld Bay 2')).toBeInTheDocument()
    expect(screen.queryByText('Assembly Line 1')).not.toBeInTheDocument()
  })

  // Without this, a reload or a Back re-applies a filter the user just cleared -- the query
  // string outlives the component state.
  it('strips ?search= from the URL and releases the lifted filter when cleared', async () => {
    window.history.replaceState({}, '', '/cells?search=cell-1')
    api.get.mockImplementation(bothCells)
    const onClearFilter = vi.fn()

    render(<CellsTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={() => true}
                     initialSearchFilter="cell-1" onClearFilter={onClearFilter} />)

    await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())
    fireEvent.click(screen.getByText(/Clear filters/))

    expect(window.location.search).toBe('')
    expect(onClearFilter).toHaveBeenCalled()
    await waitFor(() => expect(screen.getByText('Weld Bay 2')).toBeInTheDocument())
  })
})
