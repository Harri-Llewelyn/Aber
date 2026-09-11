import React from 'react'
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CellsTab } from '../components/tabs/CellsTab'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import { OverviewTab } from '../components/tabs/OverviewTab'
import { PERMISSION_UUIDS } from '../constants'
import { api } from '../api'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), relocateDevices: vi.fn() }
  }
})

const NOW = Date.parse('2026-07-28T12:00:00Z')

const gateway = {
  gateway_id: 'gw-1',
  gateway_name: 'Virtual_Gateway_NodeRED',
  cell_id: 'cell-1',
  // NOT NULL DEFAULT 'cell' (archived migration 0036), so every real payload carries it. Virtual and
  // site-wide are independent: this fixture is a virtual gateway that has been given a cell.
  location_scope: 'cell',
  status: 'ONLINE',
  deployment: 'host',
  is_archived: false,
  last_heartbeat: new Date(NOW - 20_000).toISOString(),
  device_count: 1,
  devices: [
    {
      asset_id: 'dev-1', asset_name: 'Simulated_CNC_01', status: 'ONLINE',
      gateway_name: 'Virtual_Gateway_NodeRED', active_gateway_id: 'gw-1',
      // Location as api.js merges it from device_locations: no explicit override, so the device
      // inherits its gateway's cell. Cell membership is grouped from the device list by the tabs.
      cell_id: null, location_scope: 'cell', effective_cell_id: 'cell-1',
      gateway_cell_id: 'cell-1', location_source: 'inherited', cell_mismatch: false
    }
  ]
}

/* A device whose cell is its own, not its gateway's. Dropping onto Unassigned clears the explicit
   cell, and the default fixture has none to clear; staging compares each move against the committed
   row and drops the ones that change nothing. */
const explicitlyFiledDevice = {
  ...gateway.devices[0],
  cell_id: 'cell-1',
  explicit_cell_id: 'cell-1',
  location_source: 'explicit'
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

// Drag-and-drop is gated behind an explicit Rearrange mode, off by default, so every drop test
// enters that mode first.
const enableRearrange = () => fireEvent.click(screen.getByRole('button', { name: /Rearrang/i }))

/* A drop does not write. Moves are staged and applied together as one transaction, so a test that
   wants to see the write presses Apply. `relocateDevices` is called once with the whole batch, and
   the tests assert that shape. */
const applyRearrange = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Apply \d+ move/ }))
  })
}

/** The single batch the page sent, as an array of moves. */
const sentBatch = () => api.relocateDevices.mock.calls[0][0]

// Two grids: lanes carry .shopfloor-lane and live in .shopfloor-lanes; cells carry .shopfloor-cell
// and live in .shopfloor-grid.
const cellTiles = () => [...document.querySelectorAll('.shopfloor-grid > .shopfloor-cell')]
const cellTileFor = (name) => cellTiles().find(z => within(z).queryByText(name))
const laneTiles = () => [...document.querySelectorAll('.shopfloor-lanes > .shopfloor-lane')]

describe('CellsTab shows the gateways and devices attached to a cell', () => {
  it('names a cell\'s gateways and the devices reachable through them, on one row', async () => {
    api.get.mockImplementation(routeGet())

    render(<CellsTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={() => true} />)

    await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())

    // A cell names the gateways assigned to it and the devices that resolve to it, as two columns
    // of one table.
    const row = screen.getByText('Assembly Line 1').closest('tr')
    expect(within(row).getByText('Virtual_Gateway_NodeRED')).toBeTruthy()
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
    expect(screen.queryByText(/not linked to any cell zone/i)).not.toBeInTheDocument()
  })

  it('flags devices that belong to no cell instead of hiding them', async () => {
    api.get.mockImplementation(routeGet({
      cells: [{ ...cell, gateways: [], gateway_count: 0 }],
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

  it('shows Site-Wide as its own state, not as a missing cell', async () => {
    // Three states, not two. A host-run connector serving the facility has answered the
    // question; rendering it the same as "no cell" invites someone to keep trying to fix it.
    api.get.mockImplementation(routeGet({
      gateways: [{ ...gateway, cell_id: null, location_scope: 'site_wide' }]
    }))

    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Virtual_Gateway_NodeRED')).toBeInTheDocument())
    expect(screen.getByText('Site-Wide')).toBeInTheDocument()
    expect(screen.queryByText('No cell')).not.toBeInTheDocument()
  })

  it('clears the cell when a gateway is set to Site-Wide, mirroring the CHECK constraint', async () => {
    api.get.mockImplementation(routeGet())
    api.put.mockResolvedValue({})

    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Virtual_Gateway_NodeRED')).toBeInTheDocument())

    // Edit moved into the context panel with the rest of the gateway ACTIONS column.
    fireEvent.click(within(document.querySelector('.page-main')).getByText('Virtual_Gateway_NodeRED'))
    fireEvent.click(within(document.querySelector('.context-panel')).getByText('Edit Details'))
    // Site-Wide is one radio of three, not a checkbox beside the cell picker: you cannot choose
    // Site-Wide and a cell because they are the same question.
    fireEvent.click(screen.getByRole('radio', { name: /Site-Wide/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }))

    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(api.put.mock.calls[0][1]).toMatchObject({ location_scope: 'site_wide', cell_id: '' })
  })

  it('does not treat the Type control as a location assertion', async () => {
    // Virtual is a deployment fact; site-wide is a claim about location. A virtual gateway is
    // usually site-wide, but tying them together would relocate assets on a checkbox.
    api.get.mockImplementation(routeGet())
    api.put.mockResolvedValue({})

    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Virtual_Gateway_NodeRED')).toBeInTheDocument())

    fireEvent.click(within(document.querySelector('.page-main')).getByText('Virtual_Gateway_NodeRED'))
    fireEvent.click(within(document.querySelector('.context-panel')).getByText('Edit Details'))
    // Changing the type must not move the cell: where the connector runs and where its assets are
    // are different questions.
    fireEvent.change(document.querySelector('#gateway-type'), { target: { value: 'host' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }))

    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(api.put.mock.calls[0][1]).toMatchObject({ location_scope: 'cell', cell_id: 'cell-1' })
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

    // The per-tile section headings were replaced by one count pair in the header.
    const zone = cellTileFor('Assembly Line 1')
    expect(within(zone).getByText('GW: 1 | Dev: 1')).toBeInTheDocument()
    expect(screen.getByText('Simulated_CNC_01')).toBeInTheDocument()
    expect(within(zone).getByText('Virtual_Gateway_NodeRED')).toBeInTheDocument()
  })

  it('files a dropped device into the target cell even when that cell has no gateway', async () => {
    // With devices.cell_id the drop writes location directly and leaves the gateway alone, so a
    // cell with no gateway can take a device.
    const showToast = vi.fn()
    api.get.mockImplementation(routeGet({
      cells: [{ ...cell, gateways: [], gateway_count: 0 }],
      gateways: []
    }))

    render(
      <OverviewTab
        onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={showToast}
        hasPermission={() => true} onNavigateTab={vi.fn()}
      />
    )

    await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())

    enableRearrange()
    const zone = screen.getByTitle(/Drag device node here to reassign/)
    fireEvent.drop(zone, {
      dataTransfer: { getData: () => JSON.stringify({ asset_id: 'dev-1', asset_name: 'Simulated_CNC_01' }) }
    })

    // Staged, not written -- the toast says so at the drop, which is when the operator can still
    // change their mind.
    expect(api.relocateDevices).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Assembly Line 1'), 'success')

    await applyRearrange()
    expect(sentBatch()).toEqual([
      { device_id: 'dev-1', cell_id: 'cell-1', area_id: null, location_scope: 'cell' }
    ])
    // The data path is not touched: dragging a machine across the floor plan says where it is,
    // not which connector reaches it. The move carries no gateway at all.
    expect('active_gateway_id' in sentBatch()[0]).toBe(false)
  })

  describe('Rearrange mode gates drag-and-drop', () => {
    const renderMap = (hasPermission = () => true, showToast = vi.fn()) => {
      api.get.mockImplementation(routeGet())
      api.put.mockResolvedValue({})
      return render(
        <OverviewTab onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={showToast}
          hasPermission={hasPermission} onNavigateTab={vi.fn()} />
      )
    }

    it('is off by default, so a stray drop writes nothing', async () => {
      // The whole point of the mode. Without this assertion the drop tests above would pass
      // whether or not the gate exists, because they enable it first.
      renderMap()
      await waitFor(() => expect(screen.getByText('Site-Wide')).toBeInTheDocument())

      fireEvent.drop(screen.getByTitle(/permanent home, not a queue/i), {
        dataTransfer: { getData: () => JSON.stringify({ asset_id: 'dev-1', asset_name: 'Simulated_CNC_01', location_source: 'inherited' }) }
      })

      await new Promise(r => setTimeout(r, 20))
      expect(api.put).not.toHaveBeenCalled()
      expect(api.relocateDevices).not.toHaveBeenCalled()
      // Nothing staged either: a drop outside the mode must not quietly accumulate work that a
      // later Apply would write.
      expect(screen.queryByRole('button', { name: /Apply/ })).not.toBeInTheDocument()
    })

    it('leaves device chips undraggable until it is on', async () => {
      const { container } = renderMap()
      await waitFor(() => expect(screen.getByText('Simulated_CNC_01')).toBeInTheDocument())

      // `:not(.chip-gw)` because the first chip in the DOM is the cell's gateway chip, which is
      // never draggable. React omits the attribute for draggable={false}, so read the DOM property.
      const deviceChipEl = () => container.querySelector('.zone-chips .chip:not(.chip-gw)')
      expect(deviceChipEl().draggable).toBe(false)

      enableRearrange()
      expect(deviceChipEl().draggable).toBe(true)
    })

    it('accepts the drop once enabled', async () => {
      renderMap()
      await waitFor(() => expect(screen.getByText('Site-Wide')).toBeInTheDocument())

      enableRearrange()
      fireEvent.drop(screen.getByTitle(/permanent home, not a queue/i), {
        dataTransfer: { getData: () => JSON.stringify({ asset_id: 'dev-1', asset_name: 'Simulated_CNC_01', location_source: 'inherited' }) }
      })

      // Accepted means STAGED. The commit bar appearing is the page saying it took the drop --
      // which is now the immediate feedback, where it used to be a write completing.
      expect(await screen.findByRole('button', { name: /Apply 1 move/ })).toBeInTheDocument()
      expect(api.relocateDevices).not.toHaveBeenCalled()
    })

    it('can be switched back off', async () => {
      renderMap()
      await waitFor(() => expect(screen.getByText('Site-Wide')).toBeInTheDocument())

      enableRearrange()
      enableRearrange()  // toggle back off

      fireEvent.drop(screen.getByTitle(/permanent home, not a queue/i), {
        dataTransfer: { getData: () => JSON.stringify({ asset_id: 'dev-1', asset_name: 'Simulated_CNC_01', location_source: 'inherited' }) }
      })

      await new Promise(r => setTimeout(r, 20))
      expect(api.put).not.toHaveBeenCalled()
      expect(api.relocateDevices).not.toHaveBeenCalled()
      // Nothing staged either: a drop outside the mode must not quietly accumulate work that a
      // later Apply would write.
      expect(screen.queryByRole('button', { name: /Apply/ })).not.toBeInTheDocument()
    })

    it('explains the consequence only while the mode is on', async () => {
      renderMap()
      await waitFor(() => expect(screen.getByText('Site-Wide')).toBeInTheDocument())

      expect(screen.queryByText(/Nothing is written until you apply/i)).not.toBeInTheDocument()
      enableRearrange()
      expect(screen.getByText(/Nothing is written until you apply/i)).toBeInTheDocument()
    })

    it('is not offered at all without device:manage', async () => {
      renderMap(() => false)
      await waitFor(() => expect(screen.getByText('Site-Wide')).toBeInTheDocument())

      expect(screen.queryByRole('button', { name: /Rearrang/i })).not.toBeInTheDocument()
      expect(screen.getByText(/Drag-and-Drop locked/i)).toBeInTheDocument()
    })
  })

  it('renders the Unassigned and Site-Wide lanes beside the cells', async () => {
    // Devices resolving to no cell used to appear nowhere on this page at all.
    api.get.mockImplementation(routeGet({
      devices: [
        { ...gateway.devices[0], asset_id: 'dev-u', asset_name: 'Orphan_CNC',
          effective_cell_id: null, gateway_cell_id: null, location_source: 'unassigned' },
        { ...gateway.devices[0], asset_id: 'dev-s', asset_name: 'Site_BMS',
          effective_cell_id: null, location_scope: 'site_wide', location_source: 'site_wide' }
      ]
    }))

    render(
      <OverviewTab onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={vi.fn()}
        hasPermission={() => true} onNavigateTab={vi.fn()} />
    )

    await waitFor(() => expect(screen.getByText('Unassigned')).toBeInTheDocument())
    expect(screen.getByText('Site-Wide')).toBeInTheDocument()
    expect(screen.getByText('Orphan_CNC')).toBeInTheDocument()
    expect(screen.getByText('Site_BMS')).toBeInTheDocument()
    // Marked as derived by tint, border and name title rather than by a pill that would eat the
    // name. See 'shows the lane names in full' below.
    expect(laneTiles().map(t => t.className.includes('shopfloor-lane'))).toEqual([true, true, true])
  })

  it('gives synthetic assets the Simulated lane rather than the Unassigned queue', async () => {
    // A device behind a simulated gateway is simulated-scoped, not cell-scoped, so it does not land
    // in Unassigned, a queue whose every remedy is refused by gateways_synthetic_has_no_cell.
    api.get.mockImplementation(routeGet({
      gateways: [
        { ...gateway, gateway_id: 'gw-sim', gateway_name: 'Sim_Connector',
          cell_id: null, location_scope: 'cell', is_simulated: true },
        { ...gateway, gateway_id: 'gw-un', gateway_name: 'Homeless_Gateway',
          cell_id: null, location_scope: 'cell' }
      ],
      devices: [
        { ...gateway.devices[0], asset_id: 'dev-sim', asset_name: 'Sim_Spindle',
          active_gateway_id: 'gw-sim', effective_cell_id: null, location_source: 'simulated' },
        { ...gateway.devices[0], asset_id: 'dev-u', asset_name: 'Orphan_CNC',
          active_gateway_id: 'gw-un', effective_cell_id: null, location_source: 'unassigned' }
      ]
    }))

    render(
      <OverviewTab onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={vi.fn()}
        hasPermission={() => true} onNavigateTab={vi.fn()} />
    )
    await waitFor(() => expect(screen.getByText('Simulated')).toBeInTheDocument())

    const simulatedLane = screen.getByTitle(/generated rather than observed/i)
    const unassignedLane = screen.getByTitle(/work queue, not a location/i)

    expect(within(simulatedLane).getByText('Sim_Spindle')).toBeInTheDocument()
    expect(within(simulatedLane).getByText('Sim_Connector')).toBeInTheDocument()
    // And the queue keeps only what an operator can actually act on.
    expect(within(unassignedLane).getByText('Orphan_CNC')).toBeInTheDocument()
    expect(within(unassignedLane).queryByText('Sim_Spindle')).not.toBeInTheDocument()
    expect(within(unassignedLane).queryByText('Sim_Connector')).not.toBeInTheDocument()
  })

  it('does not accept a drop onto the Simulated lane', async () => {
    // The other lanes take drops because they are statements about location. This one is a
    // statement about the gateway's provenance.
    api.get.mockImplementation(routeGet())

    render(
      <OverviewTab onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={vi.fn()}
        hasPermission={() => true} onNavigateTab={vi.fn()} />
    )
    await waitFor(() => expect(screen.getByText('Simulated')).toBeInTheDocument())

    // The two settable lanes wire a drop handler; this one deliberately does not.
    expect(screen.getByTitle(/permanent home, not a queue/i)).toHaveAttribute('data-droppable', 'true')
    expect(screen.getByTitle(/generated rather than observed/i)).not.toHaveAttribute('data-droppable', 'true')
  })

  it('lists gateways in the lanes, not just devices', async () => {
    // A gateway with no cell is as stranded as a device with no cell -- and is usually WHY the
    // devices beside it are stranded, since they had nothing to inherit.
    api.get.mockImplementation(routeGet({
      gateways: [
        { ...gateway, gateway_id: 'gw-sw', gateway_name: 'Site_Connector', cell_id: null, location_scope: 'site_wide' },
        { ...gateway, gateway_id: 'gw-un', gateway_name: 'Homeless_Gateway', cell_id: null, location_scope: 'cell' },
        { ...gateway, gateway_id: 'gw-ok', gateway_name: 'Line_A_Gateway', cell_id: 'cell-1', location_scope: 'cell' }
      ]
    }))

    render(
      <OverviewTab onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={vi.fn()}
        hasPermission={() => true} onNavigateTab={vi.fn()} />
    )

    await waitFor(() => expect(screen.getByText('Site-Wide')).toBeInTheDocument())

    const siteWideLane = screen.getByTitle(/permanent home, not a queue/i)
    const unassignedLane = screen.getByTitle(/work queue, not a location/i)

    expect(within(siteWideLane).getByText('Site_Connector')).toBeInTheDocument()
    expect(within(unassignedLane).getByText('Homeless_Gateway')).toBeInTheDocument()
    // A gateway that has a cell belongs to that cell's card, not to either lane.
    expect(within(siteWideLane).queryByText('Line_A_Gateway')).not.toBeInTheDocument()
    expect(within(unassignedLane).queryByText('Line_A_Gateway')).not.toBeInTheDocument()
  })

  it('does not put a site-wide gateway in the Unassigned queue', async () => {
    // Both have a null cell_id. Only one of them is an unanswered question.
    api.get.mockImplementation(routeGet({
      gateways: [{ ...gateway, gateway_name: 'Site_Connector', cell_id: null, location_scope: 'site_wide' }]
    }))

    render(
      <OverviewTab onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={vi.fn()}
        hasPermission={() => true} onNavigateTab={vi.fn()} />
    )

    await waitFor(() => expect(screen.getByText('Site-Wide')).toBeInTheDocument())
    const unassignedLane = screen.getByTitle(/work queue, not a location/i)
    expect(within(unassignedLane).queryByText('Site_Connector')).not.toBeInTheDocument()
    // Nothing stranded, so the queue has collapsed to its one-line form.
    expect(within(unassignedLane).getByText(/No Unassigned Assets/i)).toBeInTheDocument()
  })

  /**
   * The tiles are uniform: an empty tile keeps its shape, still says "All clear" rather than
   * describing what could go in it, and is still a drop target.
   */
  describe('empty tiles keep their shape and their meaning', () => {
    const laneOf = (title) => screen.getByTitle(title)

    it('says the queue has drained rather than collapsing to say so', async () => {
      api.get.mockImplementation(routeGet())

      render(
        <OverviewTab onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={vi.fn()}
          hasPermission={() => true} onNavigateTab={vi.fn()} />
      )
      await waitFor(() => expect(screen.getByText('Unassigned')).toBeInTheDocument())

      const lane = laneOf(/work queue, not a location/i)
      // Same shape as every other tile: header, counts, body.
      expect(lane.querySelector('.zone-body')).toBeTruthy()
      expect(within(lane).getByText('GW: 0 | Dev: 0')).toBeInTheDocument()
      // "All clear" -- empty here is a RESULT, not an invitation to fill it.
      expect(within(lane).getByText(/No Unassigned Assets/i)).toBeInTheDocument()
    })

    it('gives the lanes a row of their own, at the same tile size as the cells', async () => {
      api.get.mockImplementation(routeGet())

      const { container } = render(
        <OverviewTab onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={vi.fn()}
          hasPermission={() => true} onNavigateTab={vi.fn()} />
      )
      await waitFor(() => expect(screen.getByText('Unassigned')).toBeInTheDocument())

      // Separate grids, one tile shape: the lanes are in their own grid rather than held at the
      // front of the cell grid by CSS `order`.
      expect(container.querySelector('.shopfloor-lanes')).not.toBeNull()
      expect(laneTiles()).toHaveLength(3)
      // No lane leaked into the cell grid, which is what the split has to guarantee.
      expect(container.querySelectorAll('.shopfloor-grid > .shopfloor-lane')).toHaveLength(0)
      // Still the same object in a different place -- no tile opts out of the shared shape.
      expect(container.querySelectorAll('.shopfloor-zone-mini')).toHaveLength(0)
    })

    it('is still a drop target while empty', async () => {
      // An empty queue is exactly when someone wants to drag something into it.
      // Default fixture: the only gateway serves a cell, so nothing is stranded.
      const showToast = vi.fn()
      api.get.mockImplementation(routeGet({ devices: [explicitlyFiledDevice] }))
      api.put.mockResolvedValue({})

      render(
        <OverviewTab onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={showToast}
          hasPermission={() => true} onNavigateTab={vi.fn()} />
      )
      await waitFor(() => expect(screen.getByText('Unassigned')).toBeInTheDocument())

      const lane = laneOf(/work queue, not a location/i)
      expect(within(lane).getByText(/No Unassigned Assets/i)).toBeInTheDocument()

      enableRearrange()
      fireEvent.drop(lane, {
        dataTransfer: {
          getData: () => JSON.stringify({
            asset_id: 'dev-1', asset_name: 'Simulated_CNC_01',
            active_gateway_id: 'gw-1', location_source: 'explicit'
          })
        }
      })

      await applyRearrange()
      expect(sentBatch()).toEqual([
        { device_id: 'dev-1', cell_id: null, area_id: null, location_scope: 'cell' }
      ])
    })

    it('fills with the stranded asset as soon as there is one', async () => {
      api.get.mockImplementation(routeGet({
        devices: [{ ...gateway.devices[0], asset_id: 'dev-u', asset_name: 'Orphan_CNC',
                    effective_cell_id: null, gateway_cell_id: null, location_source: 'unassigned' }]
      }))

      render(
        <OverviewTab onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={vi.fn()}
          hasPermission={() => true} onNavigateTab={vi.fn()} />
      )
      await waitFor(() => expect(screen.getByText('Orphan_CNC')).toBeInTheDocument())

      const lane = laneOf(/work queue, not a location/i)
      expect(within(lane).queryByText(/No Unassigned Assets/i)).toBeNull()
      expect(within(lane).getByText('GW: 0 | Dev: 1')).toBeInTheDocument()
      expect(within(lane).getByText('Orphan_CNC')).toBeInTheDocument()
    })

    it('holds a stranded gateway even with no stranded devices', async () => {
      api.get.mockImplementation(routeGet({
        gateways: [{ ...gateway, gateway_name: 'Homeless_Gateway', cell_id: null, location_scope: 'cell' }]
      }))

      render(
        <OverviewTab onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={vi.fn()}
          hasPermission={() => true} onNavigateTab={vi.fn()} />
      )
      await waitFor(() => expect(screen.getByText('Unassigned')).toBeInTheDocument())

      const lane = laneOf(/work queue, not a location/i)
      expect(within(lane).queryByText(/No Unassigned Assets/i)).toBeNull()
      expect(within(lane).getByText('Homeless_Gateway')).toBeInTheDocument()
    })

    it('gives an empty physical cell the same tile as a full one', async () => {
      api.get.mockImplementation(routeGet({
        cells: [cell, { cell_id: 'cell-empty', cell_name: 'Bay 9', is_archived: false, gateways: [], gateway_count: 0 }]
      }))

      render(
        <OverviewTab onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={vi.fn()}
          hasPermission={() => true} onNavigateTab={vi.fn()} />
      )
      await waitFor(() => expect(screen.getByText('Bay 9')).toBeInTheDocument())

      const empty = cellTileFor('Bay 9')
      const populated = cellTileFor('Assembly Line 1')

      // Both have a body; the empty one states its emptiness inside it rather than by shrinking.
      expect(empty.querySelector('.zone-body')).toBeTruthy()
      expect(within(empty).getByText('GW: 0 | Dev: 0')).toBeInTheDocument()
      expect(within(empty).getByText(/No gateways or devices in this cell zone/i)).toBeInTheDocument()
      expect(populated.querySelector('.zone-body')).toBeTruthy()
      expect(within(populated).getByText('GW: 1 | Dev: 1')).toBeInTheDocument()
    })

    it('keeps an empty cell a drop target, and keeps its zone id reachable', async () => {
      api.get.mockImplementation(routeGet({
        cells: [{ cell_id: 'cell-empty', cell_name: 'Bay 9', is_archived: false, gateways: [], gateway_count: 0 }]
      }))
      api.put.mockResolvedValue({})

      render(
        <OverviewTab onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={vi.fn()}
          hasPermission={() => true} onNavigateTab={vi.fn()} />
      )
      await waitFor(() => expect(screen.getByText('Bay 9')).toBeInTheDocument())

      const zone = cellTileFor('Bay 9')
      // The header slot carries the GW/Dev counts; the zone id is on the name's title.
      expect(within(zone).getByTitle(/Zone #cell-empty/)).toBeInTheDocument()

      enableRearrange()
      fireEvent.drop(zone, {
        dataTransfer: { getData: () => JSON.stringify({ asset_id: 'dev-1', asset_name: 'Simulated_CNC_01', effective_cell_id: 'cell-1' }) }
      })

      await applyRearrange()
      expect(sentBatch()[0]).toMatchObject({ device_id: 'dev-1', cell_id: 'cell-empty' })
    })

    it('fills a cell that has a gateway but no devices', async () => {
      api.get.mockImplementation(routeGet({ devices: [] }))

      render(
        <OverviewTab onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={vi.fn()}
          hasPermission={() => true} onNavigateTab={vi.fn()} />
      )
      await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())

      const zone = cellTileFor('Assembly Line 1')
      expect(within(zone).getByText('Virtual_Gateway_NodeRED')).toBeInTheDocument()
      expect(within(zone).getByText('GW: 1 | Dev: 0')).toBeInTheDocument()
    })

    it('describes an empty Site-Wide as a home to fill, not as a queue that has drained', async () => {
      // The two lanes mean different things and their empty states have to say so: Site-Wide is
      // somewhere to put things, Unassigned is somewhere things should stop being.
      api.get.mockImplementation(routeGet())

      render(
        <OverviewTab onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={vi.fn()}
          hasPermission={() => true} onNavigateTab={vi.fn()} />
      )
      await waitFor(() => expect(screen.getByText('Site-Wide')).toBeInTheDocument())

      const lane = laneOf(/permanent home, not a queue/i)
      expect(within(lane).getByText(/No site-wide assets/i)).toBeInTheDocument()
      expect(within(lane).queryByText(/No Unassigned Assets/i)).toBeNull()
    })
  })

  it('puts every lane above the cell grid, and nothing else with them', async () => {
    // What keeps the queue in place is structural: it is in a different grid, not held by a CSS
    // `order` hint.
    api.get.mockImplementation(routeGet())

    const { container } = render(
      <OverviewTab onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={vi.fn()}
        hasPermission={() => true} onNavigateTab={vi.fn()} />
    )
    await waitFor(() => expect(screen.getByText('Site-Wide')).toBeInTheDocument())

    const lanes = container.querySelector('.shopfloor-lanes')
    const grid = container.querySelector('.shopfloor-grid')

    // The lane row holds the lanes and only the lanes.
    expect([...lanes.querySelectorAll(':scope > .shopfloor-zone')]).toEqual(laneTiles())
    // The cell grid holds the areas' contents: cells, and an area's Area-Wide tile, which
    // belongs to that area and not to the campus row. No area here, so cells only.
    expect([...grid.querySelectorAll(':scope > .shopfloor-zone')]
      .every(t => t.className.includes('shopfloor-cell') || t.className.includes('shopfloor-lane-area'))).toBe(true)
    expect(grid.querySelectorAll('.shopfloor-lane-area')).toHaveLength(0)
    // And the lanes come first in the document, which is what "above" means without layout.
    expect(lanes.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('orders the lanes infrastructure-first, context-second, queue-last', async () => {
    api.get.mockImplementation(routeGet())

    render(
      <OverviewTab onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={vi.fn()}
        hasPermission={() => true} onNavigateTab={vi.fn()} />
    )
    await waitFor(() => expect(screen.getByText('Site-Wide')).toBeInTheDocument())

    const [first, second, third] = laneTiles()
    expect(within(first).getByText('Site-Wide')).toBeInTheDocument()
    expect(within(second).getByText('Simulated')).toBeInTheDocument()
    expect(within(third).getByText('Unassigned')).toBeInTheDocument()
    // Each lane carries its own hue: a permanent home, a statement about provenance, and a queue
    // that should drain. Simulated is the neutral one.
    expect(first.className).toMatch(/shopfloor-lane-site/)
    expect(second.className).toMatch(/shopfloor-lane-simulated/)
    expect(third.className).toMatch(/shopfloor-lane-queue/)
  })

  it('gives the whole chip to the asset name, and keeps the id on its title', async () => {
    // The UUID is not printed beside the name. Removing it is only safe while the id stays
    // reachable, which the second half pins.
    api.get.mockImplementation(routeGet({ telemetry: [] }))

    render(
      <OverviewTab onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={vi.fn()}
        hasPermission={() => true} onNavigateTab={vi.fn()} />
    )
    await waitFor(() => expect(screen.getByText('Simulated_CNC_01')).toBeInTheDocument())

    const zone = cellTileFor('Assembly Line 1')
    expect(zone.querySelectorAll('.chip-id')).toHaveLength(0)
    expect(within(zone).queryByText(/dev-1/)).toBeNull()
    expect(within(zone).queryByText(/gw-1/)).toBeNull()

    // Both ids survive on the chip each belongs to.
    expect(within(zone).getByText('Simulated_CNC_01').closest('.chip'))
      .toHaveAttribute('title', expect.stringContaining('dev-1'))
    expect(within(zone).getByText('Virtual_Gateway_NodeRED').closest('.chip'))
      .toHaveAttribute('title', expect.stringContaining('gw-1'))
    // The gateway's own device count went the same way as the ids -- the tile header totals both
    // for the zone, and the per-gateway figure is a hover away.
    expect(within(zone).getByText('Virtual_Gateway_NodeRED').closest('.chip'))
      .toHaveAttribute('title', expect.stringContaining('1 device(s)'))
  })

  it('shows the lane names in full, rather than a badge explaining what they are', async () => {
    // The word DERIVED is on the name's title, not a pill that would shrink "Site-Wide" to "S...";
    // the tint and border carry "not a cell".
    api.get.mockImplementation(routeGet())

    render(
      <OverviewTab onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={vi.fn()}
        hasPermission={() => true} onNavigateTab={vi.fn()} />
    )
    await waitFor(() => expect(screen.getByText('Site-Wide')).toBeInTheDocument())

    for (const [tile, name] of [[laneTiles()[0], 'Site-Wide'], [laneTiles()[1], 'Simulated'],
                                [laneTiles()[2], 'Unassigned']]) {
      const label = within(tile).getByText(name)
      expect(label).toHaveClass('zone-name')
      expect(label).toHaveAttribute('title', expect.stringContaining('derived lane, not a cell'))
    }
    expect(screen.queryByText('DERIVED')).toBeNull()
  })

  it('renders the lanes even when no cell exists at all', async () => {
    // That state is precisely the one where every device is Unassigned, so hiding the queue
    // there would hide the entire fleet.
    api.get.mockImplementation(routeGet({ cells: [], gateways: [] }))

    render(
      <OverviewTab onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={vi.fn()}
        hasPermission={() => true} onNavigateTab={vi.fn()} />
    )

    await waitFor(() => expect(screen.getByText('Unassigned')).toBeInTheDocument())
    expect(screen.getByText('Site-Wide')).toBeInTheDocument()
  })

  it('marks a device Site-Wide when dropped on that lane', async () => {
    const showToast = vi.fn()
    api.get.mockImplementation(routeGet())
    api.put.mockResolvedValue({})

    render(
      <OverviewTab onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={showToast}
        hasPermission={() => true} onNavigateTab={vi.fn()} />
    )
    await waitFor(() => expect(screen.getByText('Site-Wide')).toBeInTheDocument())

    enableRearrange()
    fireEvent.drop(screen.getByTitle(/permanent home, not a queue/i), {
      dataTransfer: { getData: () => JSON.stringify({ asset_id: 'dev-1', asset_name: 'Simulated_CNC_01', location_source: 'inherited' }) }
    })

    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Site-Wide'), 'success')

    await applyRearrange()
    expect(sentBatch()).toEqual([
      { device_id: 'dev-1', cell_id: null, area_id: null, location_scope: 'site_wide' }
    ])
  })

  it('clears the explicit cell when dropped on Unassigned, and says what it inherited instead', async () => {
    // Unassigned is derived: it cannot be set. The drop clears the override and reports where
    // the device actually landed rather than pretending it moved.
    const showToast = vi.fn()
    api.get.mockImplementation(routeGet({ devices: [explicitlyFiledDevice] }))
    api.put.mockResolvedValue({})

    render(
      <OverviewTab onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={showToast}
        hasPermission={() => true} onNavigateTab={vi.fn()} />
    )
    await waitFor(() => expect(screen.getByText('Unassigned')).toBeInTheDocument())

    enableRearrange()
    fireEvent.drop(screen.getByTitle(/work queue, not a location/i), {
      dataTransfer: {
        getData: () => JSON.stringify({
          asset_id: 'dev-1', asset_name: 'Simulated_CNC_01',
          active_gateway_id: 'gw-1', location_source: 'explicit'
        })
      }
    })

    // The gateway serves Assembly Line 1, so the device inherits it, and the toast says so at the
    // drop.
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining("inherits 'Assembly Line 1'"), 'warning'
    )

    await applyRearrange()
    expect(sentBatch()).toEqual([
      { device_id: 'dev-1', cell_id: null, area_id: null, location_scope: 'cell' }
    ])
    // And the data path is untouched.
    expect('active_gateway_id' in sentBatch()[0]).toBe(false)
  })

  it('reports a plain move to Unassigned when no gateway supplies a cell', async () => {
    const showToast = vi.fn()
    api.get.mockImplementation(routeGet({
      gateways: [{ ...gateway, cell_id: null }],
      devices: [{ ...explicitlyFiledDevice, gateway_cell_id: null }]
    }))
    api.put.mockResolvedValue({})

    render(
      <OverviewTab onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={showToast}
        hasPermission={() => true} onNavigateTab={vi.fn()} />
    )
    await waitFor(() => expect(screen.getByText('Unassigned')).toBeInTheDocument())

    enableRearrange()
    fireEvent.drop(screen.getByTitle(/work queue, not a location/i), {
      dataTransfer: {
        getData: () => JSON.stringify({
          asset_id: 'dev-1', asset_name: 'Simulated_CNC_01',
          active_gateway_id: 'gw-1', location_source: 'explicit'
        })
      }
    })

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('→ Unassigned'), 'success'
    ))
  })

  /* Deferred commit. Staging buys atomicity and a single causation_id; each test here is one of the
     things it costs. */
  describe('staged moves are a transaction, not a queue of writes', () => {
    const renderMap = (showToast = vi.fn()) => {
      api.get.mockImplementation(routeGet({ devices: [explicitlyFiledDevice] }))
      api.relocateDevices.mockResolvedValue({
        causation_id: 7, requested: 1, applied: 1, unchanged: 0, devices: []
      })
      return render(
        <OverviewTab onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={showToast}
          hasPermission={() => true} onNavigateTab={vi.fn()} />
      )
    }

    const dragTo = (title) => fireEvent.drop(screen.getByTitle(title), {
      dataTransfer: {
        getData: () => JSON.stringify({
          asset_id: 'dev-1', asset_name: 'Simulated_CNC_01',
          active_gateway_id: 'gw-1', cell_id: 'cell-1',
          effective_cell_id: 'cell-1', location_source: 'explicit'
        })
      }
    })

    it('sends every staged move in ONE call, which is the whole point', async () => {
      api.get.mockImplementation(routeGet({
        cells: [cell, { cell_id: 'cell-9', cell_name: 'Paint Shop', is_archived: false, gateways: [], gateway_count: 0 }],
        devices: [
          explicitlyFiledDevice,
          { ...explicitlyFiledDevice, asset_id: 'dev-2', asset_name: 'Simulated_CNC_02' }
        ]
      }))
      api.relocateDevices.mockResolvedValue({
        causation_id: 7, requested: 2, applied: 2, unchanged: 0, devices: []
      })
      render(
        <OverviewTab onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={vi.fn()}
          hasPermission={() => true} onNavigateTab={vi.fn()} />
      )
      await waitFor(() => expect(screen.getByText('Paint Shop')).toBeInTheDocument())
      enableRearrange()

      const paintShop = /Zone #cell-9: Drag device node here to reassign/
      fireEvent.drop(screen.getByTitle(paintShop), {
        dataTransfer: { getData: () => JSON.stringify({ asset_id: 'dev-1', asset_name: 'A', effective_cell_id: 'cell-1' }) }
      })
      fireEvent.drop(screen.getByTitle(paintShop), {
        dataTransfer: { getData: () => JSON.stringify({ asset_id: 'dev-2', asset_name: 'B', effective_cell_id: 'cell-1' }) }
      })

      await applyRearrange()

      // TWO MOVES, ONE CALL. Two calls would be two transactions and therefore two causation_ids
      // -- exactly the behaviour this replaced, just relocated to a later moment.
      expect(api.relocateDevices).toHaveBeenCalledTimes(1)
      expect(sentBatch()).toHaveLength(2)
      expect(sentBatch().map(m => m.device_id).sort()).toEqual(['dev-1', 'dev-2'])
    })

    it('UNSTAGES a device dragged back where it started', async () => {
      // A drag back must cancel out and leave nothing to apply, rather than writing twice.
      renderMap()
      await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())
      enableRearrange()

      dragTo(/permanent home, not a queue/i)
      expect(await screen.findByRole('button', { name: /Apply 1 move/ })).toBeInTheDocument()

      fireEvent.drop(screen.getByTitle(/Zone #cell-1: Drag device node here to reassign/), {
        dataTransfer: {
          getData: () => JSON.stringify({
            asset_id: 'dev-1', asset_name: 'Simulated_CNC_01',
            active_gateway_id: 'gw-1', effective_cell_id: null, location_source: 'site_wide'
          })
        }
      })

      await waitFor(() => expect(screen.queryByRole('button', { name: /Apply/ })).not.toBeInTheDocument())
      expect(api.relocateDevices).not.toHaveBeenCalled()
    })

    it('asks before discarding, and writes nothing when it does', async () => {
      const showToast = vi.fn()
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
      renderMap(showToast)
      await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())
      enableRearrange()
      dragTo(/permanent home, not a queue/i)

      fireEvent.click(await screen.findByRole('button', { name: /Discard/ }))

      expect(confirmSpy).toHaveBeenCalled()
      expect(screen.queryByRole('button', { name: /Apply/ })).not.toBeInTheDocument()
      expect(api.relocateDevices).not.toHaveBeenCalled()
      confirmSpy.mockRestore()
    })

    it('keeps the batch when the discard is declined', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
      renderMap()
      await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())
      enableRearrange()
      dragTo(/permanent home, not a queue/i)

      fireEvent.click(await screen.findByRole('button', { name: /Discard/ }))

      expect(screen.getByRole('button', { name: /Apply 1 move/ })).toBeInTheDocument()
      confirmSpy.mockRestore()
    })

    it('refuses to leave the mode silently with work staged', async () => {
      // Leaving has to MEAN something. Silently discarding is the one thing it must not mean.
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
      renderMap()
      await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())
      enableRearrange()
      dragTo(/permanent home, not a queue/i)

      enableRearrange()   // click "Rearranging — click to finish"

      expect(confirmSpy).toHaveBeenCalledWith(expect.stringMatching(/not been applied/))
      // Declined, so the mode stays on AND the work is still there.
      expect(screen.getByRole('button', { name: /Apply 1 move/ })).toBeInTheDocument()
      confirmSpy.mockRestore()
    })

    it('leaves the mode and drops the work when that is confirmed', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
      renderMap()
      await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())
      enableRearrange()
      dragTo(/permanent home, not a queue/i)

      enableRearrange()

      expect(screen.queryByRole('button', { name: /Apply/ })).not.toBeInTheDocument()
      expect(api.relocateDevices).not.toHaveBeenCalled()
      confirmSpy.mockRestore()
    })
  })

  it('ignores a drop onto the lane a device is already in', async () => {
    api.get.mockImplementation(routeGet())
    api.put.mockResolvedValue({})

    render(
      <OverviewTab onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={vi.fn()}
        hasPermission={() => true} onNavigateTab={vi.fn()} />
    )
    await waitFor(() => expect(screen.getByText('Site-Wide')).toBeInTheDocument())

    enableRearrange()
    fireEvent.drop(screen.getByTitle(/permanent home, not a queue/i), {
      dataTransfer: { getData: () => JSON.stringify({ asset_id: 'dev-1', location_source: 'site_wide' }) }
    })

    await new Promise(r => setTimeout(r, 20))
    expect(api.put).not.toHaveBeenCalled()
  })

  it('says so when filing a device detaches it from its gateway\'s cell', async () => {
    const showToast = vi.fn()
    api.get.mockImplementation(routeGet({
      cells: [{ cell_id: 'cell-9', cell_name: 'Paint Shop', is_archived: false, gateways: [], gateway_count: 0 }]
    }))

    render(
      <OverviewTab
        onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={showToast}
        hasPermission={() => true} onNavigateTab={vi.fn()}
      />
    )

    await waitFor(() => expect(screen.getByText('Paint Shop')).toBeInTheDocument())

    enableRearrange()
    fireEvent.drop(screen.getByTitle(/Drag device node here to reassign/), {
      dataTransfer: {
        getData: () => JSON.stringify({
          asset_id: 'dev-1', asset_name: 'Simulated_CNC_01',
          active_gateway_id: 'gw-1', effective_cell_id: 'cell-1'
        })
      }
    })

    // The device is now pinned and no longer follows its gateway. That is what the drop asked
    // for, but nothing on screen would otherwise show it.
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.stringContaining('will stay there regardless of its gateway'), 'success'
      )
    )
  })
})

// Paging a fleet-wide stream has no equivalent in the per-device drawer, which shows the latest
// value per metric and defers history to the CSV export. See deviceTelemetryAccordion.test.jsx.

// Overview -> Cells hand-over: Overview emits the cell id, and Cells consumes it the way Gateways
// and Devices consume theirs.
describe('Overview hands a cell over to the Cells page', () => {
  const renderOverview = (props = {}) => render(
    <OverviewTab
      onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={vi.fn()}
      hasPermission={() => true} onNavigateTab={vi.fn()} {...props}
    />
  )

  it('passes the clicked cell id to onSelectCell', async () => {
    api.get.mockImplementation(routeGet({ telemetry: [] }))
    const onSelectCell = vi.fn()
    renderOverview({ onSelectCell })

    await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())
    fireEvent.click(screen.getByTitle(/Cell 'Assembly Line 1'.*Click to view on Cells page/))

    // The id, not the name: it is stable and unique, and CellsTab's predicate matches either.
    expect(onSelectCell).toHaveBeenCalledWith('cell-1')
  })

  it('still navigates when no onSelectCell is wired, rather than doing nothing', async () => {
    api.get.mockImplementation(routeGet({ telemetry: [] }))
    const onNavigateTab = vi.fn()
    renderOverview({ onNavigateTab })

    await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())
    fireEvent.click(screen.getByTitle(/Cell 'Assembly Line 1'.*Click to view on Cells page/))

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
    fireEvent.change(screen.getByPlaceholderText(/Search by Cell ID or name/), { target: { value: 'Weld' } })

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
