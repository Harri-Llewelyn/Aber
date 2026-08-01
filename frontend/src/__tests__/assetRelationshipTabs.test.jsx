import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
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
  // NOT NULL DEFAULT 'cell' (migration 0036), so every real payload carries it. Virtual and
  // site-wide are independent: this fixture is a virtual gateway that has been given a cell.
  location_scope: 'cell',
  status: 'ONLINE',
  ip_address: '192.168.1.50',
  is_virtual: true,
  is_archived: false,
  last_heartbeat: new Date(NOW - 20_000).toISOString(),
  device_count: 1,
  devices: [
    {
      asset_id: 'dev-1', asset_name: 'Simulated_CNC_01', status: 'ONLINE',
      gateway_name: 'Virtual_Gateway_NodeRED', active_gateway_id: 'gw-1',
      // Location as api.js now merges it from device_locations: no explicit override, so the
      // device inherits its gateway's cell. Cell membership is grouped from the device list by
      // the tabs themselves -- /api/v1/cells no longer carries it.
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

// No `devices`/`device_count`: /api/v1/cells returns gateways only, and membership is resolved
// from the device list by groupDevicesByCell(). Leaving them here would let a regression that
// re-read them from the cell pass unnoticed.
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

// Drag-and-drop is gated behind an explicit Rearrange mode, off by default, so a stray drag on a
// page that is mostly read cannot relocate an asset. Every drop test has to enter that mode first
// -- which is exactly what a user now does.
const enableRearrange = () => fireEvent.click(screen.getByRole('button', { name: /Rearrang/i }))

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

  it('does not flag a Site-Wide device as unlinked', async () => {
    // It resolves to no cell, but that is the operator's answer rather than an omission.
    // Flagging it produced a permanent warning no action could clear, which just teaches people
    // to ignore the banner.
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

  it('clears the cell when a gateway is marked Site-Wide, mirroring the CHECK constraint', async () => {
    api.get.mockImplementation(routeGet())
    api.put.mockResolvedValue({})

    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Virtual_Gateway_NodeRED')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /^Edit/i }))
    fireEvent.click(screen.getByLabelText(/Site-Wide/i))
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }))

    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(api.put.mock.calls[0][1]).toMatchObject({ location_scope: 'site_wide', cell_id: '' })
  })

  it('does not treat the Virtual checkbox as a location assertion', async () => {
    // Virtual is a deployment fact; site-wide is a claim about location. A virtual gateway is
    // usually site-wide, but tying them together would relocate assets on a checkbox.
    api.get.mockImplementation(routeGet())
    api.put.mockResolvedValue({})

    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Virtual_Gateway_NodeRED')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /^Edit/i }))
    fireEvent.click(screen.getByLabelText(/Mark as Virtual Gateway/i))
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

    expect(screen.getByText('Active Edge Gateways (1)')).toBeInTheDocument()
    expect(screen.getByText('Operating Devices (1)')).toBeInTheDocument()
    expect(screen.getByText('Simulated_CNC_01')).toBeInTheDocument()
    // The gateway card keeps its three-bucket breakdown; it reads 1 online because its
    // heartbeat is fresh.
    expect(screen.getAllByText('1 Online / 0 Offline / 0 Archived')).toHaveLength(1)
    // The device card now reports Quarantined as a fourth, mutually exclusive bucket, so its
    // text is read from the node rather than matched whole (it is split across spans so the
    // quarantine figure can be styled independently).
    const statSubs = [...document.querySelectorAll('.stat-sub')].map(n => n.textContent)
    expect(statSubs).toContain('1 Online / 0 Offline / 0 Quarantined / 0 Archived')
  })

  // A quarantined device is stored with status OFFLINE. It used to be counted in the Offline
  // figure AND on a separate Pending Quarantine card -- the same device twice, with the
  // Offline count implying a fault rather than "waiting to be admitted".
  it('counts a quarantined device only as Quarantined, and raises the alert treatment', async () => {
    api.get.mockImplementation(routeGet({
      devices: [{ ...gateway.devices[0], is_quarantined: true, status: 'OFFLINE' }],
    }))
    render(
      <OverviewTab
        onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={vi.fn()}
        hasPermission={() => true} onNavigateTab={vi.fn()}
      />
    )
    await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())

    const statSubs = [...document.querySelectorAll('.stat-sub')].map(n => n.textContent)
    // Not counted as Offline, and the four buckets still sum to the card's total of 1.
    expect(statSubs).toContain('0 Online / 0 Offline / 1 Quarantined / 0 Archived')

    // The card raises the warning treatment so the state is visible without reading the text.
    expect(document.querySelector('.stat-card-alert')).not.toBeNull()
  })

  it('shows no alert treatment when nothing is quarantined', async () => {
    api.get.mockImplementation(routeGet())
    render(
      <OverviewTab
        onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={vi.fn()}
        hasPermission={() => true} onNavigateTab={vi.fn()}
      />
    )
    await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())

    expect(document.querySelector('.stat-card-alert')).toBeNull()
  })

  it('files a dropped device into the target cell even when that cell has no gateway', async () => {
    // This used to be refused outright. A drop had to express location by rewiring the device's
    // GATEWAY, so a cell with no gateway -- or with two -- had nowhere to put the device, and a
    // successful drop changed the data path to say something about geography. With
    // devices.cell_id the drop writes location directly and the gateway is left alone.
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

    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(api.put.mock.calls[0][0]).toBe('/api/v1/devices/dev-1')
    expect(api.put.mock.calls[0][1]).toMatchObject({ cell_id: 'cell-1', location_scope: 'cell' })
    // The data path is not touched: dragging a machine across the floor plan says where it is,
    // not which connector reaches it.
    expect('active_gateway_id' in api.put.mock.calls[0][1]).toBe(false)
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Assembly Line 1'), 'success')
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
    })

    it('leaves device chips undraggable until it is on', async () => {
      const { container } = renderMap()
      await waitFor(() => expect(screen.getByText('Simulated_CNC_01')).toBeInTheDocument())

      // `:not(.chip-gw)` because the first chip in the DOM is the cell's GATEWAY chip, which is
      // never draggable -- selecting it would make this assertion pass for the wrong reason.
      // React omits the attribute for draggable={false}, so read the DOM property.
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

      await waitFor(() => expect(api.put).toHaveBeenCalled())
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
    })

    it('explains the consequence only while the mode is on', async () => {
      renderMap()
      await waitFor(() => expect(screen.getByText('Site-Wide')).toBeInTheDocument())

      expect(screen.queryByText(/recorded in the digital thread/i)).not.toBeInTheDocument()
      enableRearrange()
      expect(screen.getByText(/recorded in the digital thread/i)).toBeInTheDocument()
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
    // Labelled as derived so they do not read as cells someone could rename or archive.
    expect(screen.getAllByText('DERIVED')).toHaveLength(2)
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
    expect(within(unassignedLane).getByText(/All clear/i)).toBeInTheDocument()
  })

  describe('the Unassigned lane minimises when empty', () => {
    const laneOf = (title) => screen.getByTitle(title)

    it('collapses to a single line with no body when nothing is stranded', async () => {
      api.get.mockImplementation(routeGet())

      render(
        <OverviewTab onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={vi.fn()}
          hasPermission={() => true} onNavigateTab={vi.fn()} />
      )
      await waitFor(() => expect(screen.getByText('Unassigned')).toBeInTheDocument())

      const lane = laneOf(/work queue, not a location/i)
      expect(lane.className).toMatch(/shopfloor-zone-mini/)
      expect(lane.querySelector('.zone-body')).toBeNull()
      expect(within(lane).getByText(/All clear/i)).toBeInTheDocument()
      // The two "nothing here" panels are what made an empty queue louder than the cells.
      expect(within(lane).queryByText(/Active Edge Gateways/i)).not.toBeInTheDocument()
      expect(within(lane).queryByText(/Operating Devices/i)).not.toBeInTheDocument()
    })

    it('leaves no gap beside it, because the lanes are stacked', async () => {
      // Side by side, a collapsed queue left half a page of nothing under it, which read as a
      // rendering fault rather than as good news. Stacking is what makes collapsing look right.
      api.get.mockImplementation(routeGet())

      const { container } = render(
        <OverviewTab onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={vi.fn()}
          hasPermission={() => true} onNavigateTab={vi.fn()} />
      )
      await waitFor(() => expect(screen.getByText('Unassigned')).toBeInTheDocument())

      const lanes = container.querySelector('.shopfloor-lanes')
      // One full-width column, so a short lane simply takes less height.
      expect(lanes.className).not.toMatch(/lanes-with-minimised/)
      expect(lanes.querySelectorAll(':scope > .shopfloor-zone')).toHaveLength(2)
    })

    it('is still a drop target while minimised', async () => {
      // An empty queue is exactly when someone wants to drag something into it, so collapsing
      // it must not take that away.
      // Default fixture: the only gateway serves a cell, so nothing is stranded and the lane
      // is in its collapsed form.
      const showToast = vi.fn()
      api.get.mockImplementation(routeGet())
      api.put.mockResolvedValue({})

      render(
        <OverviewTab onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={showToast}
          hasPermission={() => true} onNavigateTab={vi.fn()} />
      )
      await waitFor(() => expect(screen.getByText('Unassigned')).toBeInTheDocument())

      const lane = laneOf(/work queue, not a location/i)
      expect(lane.className).toMatch(/shopfloor-zone-mini/)

      enableRearrange()
      fireEvent.drop(lane, {
        dataTransfer: {
          getData: () => JSON.stringify({
            asset_id: 'dev-1', asset_name: 'Simulated_CNC_01',
            active_gateway_id: 'gw-1', location_source: 'explicit'
          })
        }
      })

      await waitFor(() => expect(api.put).toHaveBeenCalled())
      expect(api.put.mock.calls[0][1]).toMatchObject({ cell_id: '', location_scope: 'cell' })
    })

    it('expands again as soon as something is stranded', async () => {
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
      expect(lane.className).not.toMatch(/shopfloor-zone-mini/)
      expect(lane.querySelector('.zone-body')).toBeTruthy()
      expect(within(lane).getByText(/0 gw \/ 1 dev/)).toBeInTheDocument()
    })

    it('expands for a stranded gateway even with no stranded devices', async () => {
      api.get.mockImplementation(routeGet({
        gateways: [{ ...gateway, gateway_name: 'Homeless_Gateway', cell_id: null, location_scope: 'cell' }]
      }))

      render(
        <OverviewTab onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={vi.fn()}
          hasPermission={() => true} onNavigateTab={vi.fn()} />
      )
      await waitFor(() => expect(screen.getByText('Unassigned')).toBeInTheDocument())

      const lane = laneOf(/work queue, not a location/i)
      expect(lane.className).not.toMatch(/shopfloor-zone-mini/)
      expect(within(lane).getByText('Homeless_Gateway')).toBeInTheDocument()
    })

    it('collapses an empty physical cell the same way', async () => {
      // A newly created cell has neither, so a stack being set up was mostly full-height cards
      // saying "no gateways serving this zone" — pushing the cells that do have contents down.
      api.get.mockImplementation(routeGet({
        cells: [cell, { cell_id: 'cell-empty', cell_name: 'Bay 9', is_archived: false, gateways: [], gateway_count: 0 }]
      }))

      const { container } = render(
        <OverviewTab onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={vi.fn()}
          hasPermission={() => true} onNavigateTab={vi.fn()} />
      )
      await waitFor(() => expect(screen.getByText('Bay 9')).toBeInTheDocument())

      const zones = [...container.querySelectorAll('.shopfloor-grid > .shopfloor-zone')]
      const empty = zones.find(z => within(z).queryByText('Bay 9'))
      const populated = zones.find(z => within(z).queryByText('Assembly Line 1'))

      expect(empty.className).toMatch(/shopfloor-zone-mini/)
      expect(empty.querySelector('.zone-body')).toBeNull()
      expect(within(empty).getByText('empty')).toBeInTheDocument()
      // The cell that has contents is untouched.
      expect(populated.className).not.toMatch(/shopfloor-zone-mini/)
      expect(populated.querySelector('.zone-body')).toBeTruthy()
    })

    it('keeps an empty cell a drop target, and keeps its zone id', async () => {
      api.get.mockImplementation(routeGet({
        cells: [{ cell_id: 'cell-empty', cell_name: 'Bay 9', is_archived: false, gateways: [], gateway_count: 0 }]
      }))
      api.put.mockResolvedValue({})

      const { container } = render(
        <OverviewTab onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={vi.fn()}
          hasPermission={() => true} onNavigateTab={vi.fn()} />
      )
      await waitFor(() => expect(screen.getByText('Bay 9')).toBeInTheDocument())

      const zone = container.querySelector('.shopfloor-grid > .shopfloor-zone')
      expect(within(zone).getByText(/Zone #cell-empty/)).toBeInTheDocument()

      enableRearrange()
      fireEvent.drop(zone, {
        dataTransfer: { getData: () => JSON.stringify({ asset_id: 'dev-1', asset_name: 'Simulated_CNC_01', effective_cell_id: 'cell-1' }) }
      })

      await waitFor(() => expect(api.put).toHaveBeenCalled())
      expect(api.put.mock.calls[0][1]).toMatchObject({ cell_id: 'cell-empty' })
    })

    it('expands a cell that has a gateway but no devices', async () => {
      // A gateway chip is content worth showing; only a zone with nothing at all collapses.
      api.get.mockImplementation(routeGet({ devices: [] }))

      const { container } = render(
        <OverviewTab onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={vi.fn()}
          hasPermission={() => true} onNavigateTab={vi.fn()} />
      )
      await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())

      const zone = container.querySelector('.shopfloor-grid > .shopfloor-zone')
      expect(zone.className).not.toMatch(/shopfloor-zone-mini/)
      expect(within(zone).getByText('Virtual_Gateway_NodeRED')).toBeInTheDocument()
    })

    it('does not minimise Site-Wide, which is not a queue', async () => {
      // An empty Site-Wide is not an achievement, and shrinking it would make the pair jump about.
      api.get.mockImplementation(routeGet())

      render(
        <OverviewTab onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={vi.fn()}
          hasPermission={() => true} onNavigateTab={vi.fn()} />
      )
      await waitFor(() => expect(screen.getByText('Site-Wide')).toBeInTheDocument())

      const lane = laneOf(/permanent home, not a queue/i)
      expect(lane.className).not.toMatch(/shopfloor-zone-mini/)
      expect(lane.querySelector('.zone-body')).toBeTruthy()
    })
  })

  it('places the lanes above the physical cells, outside the cell grid', async () => {
    // Inside the grid they reflowed between the bays as cells were added, so the queue moved
    // somewhere new on every stack.
    api.get.mockImplementation(routeGet())

    const { container } = render(
      <OverviewTab onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={vi.fn()}
        hasPermission={() => true} onNavigateTab={vi.fn()} />
    )
    await waitFor(() => expect(screen.getByText('Site-Wide')).toBeInTheDocument())

    const lanes = container.querySelector('.shopfloor-lanes')
    const grid = container.querySelector('.shopfloor-grid')
    expect(lanes).toBeTruthy()
    expect(lanes.querySelectorAll('.shopfloor-zone')).toHaveLength(2)
    // Neither lane leaked into the cell grid.
    expect(grid.contains(screen.getByTitle(/permanent home, not a queue/i))).toBe(false)
    // And the lanes come first in document order.
    expect(lanes.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('stacks the lanes infrastructure-first, queue-second', async () => {
    api.get.mockImplementation(routeGet())

    const { container } = render(
      <OverviewTab onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} showToast={vi.fn()}
        hasPermission={() => true} onNavigateTab={vi.fn()} />
    )
    await waitFor(() => expect(screen.getByText('Site-Wide')).toBeInTheDocument())

    const [first, second] = container.querySelectorAll('.shopfloor-lanes .shopfloor-zone')
    expect(within(first).getByText('Site-Wide')).toBeInTheDocument()
    expect(within(second).getByText('Unassigned')).toBeInTheDocument()
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

    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(api.put.mock.calls[0][1]).toMatchObject({ cell_id: '', location_scope: 'site_wide' })
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Site-Wide'), 'success')
  })

  it('clears the explicit cell when dropped on Unassigned, and says what it inherited instead', async () => {
    // Unassigned is derived: it cannot be set. The drop clears the override and reports where
    // the device actually landed rather than pretending it moved.
    const showToast = vi.fn()
    api.get.mockImplementation(routeGet())
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

    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(api.put.mock.calls[0][1]).toMatchObject({ cell_id: '', location_scope: 'cell' })
    // The gateway serves Assembly Line 1, so the device inherits it rather than going unassigned.
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining("inherits 'Assembly Line 1'"), 'warning'
    )
    // And the data path is untouched.
    expect('active_gateway_id' in api.put.mock.calls[0][1]).toBe(false)
  })

  it('reports a plain move to Unassigned when no gateway supplies a cell', async () => {
    const showToast = vi.fn()
    api.get.mockImplementation(routeGet({ gateways: [{ ...gateway, cell_id: null }] }))
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
      expect.stringContaining('moved to Unassigned'), 'success'
    ))
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
        expect.stringContaining('stays there regardless of its gateway'), 'success'
      )
    )
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
