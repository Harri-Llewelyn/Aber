import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OverviewTab } from '../components/tabs/OverviewTab'
import { api } from '../api'

/**
 * The Shopfloor Dashboard legend and its alert category. The map paints a device chip red when
 * Grafana has an alert firing against it, and the legend must name that colour. The two halves are
 * tested together: a legend entry promising a red chip is only true while the chip is also legible
 * without colour.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), relocateDevices: vi.fn() } }
})

const CELL = {
  cell_id: 'cell-1', cell_name: 'Assembly Line 1', is_archived: false,
  gateways: [], gateway_count: 0
}

const device = (overrides = {}) => ({
  asset_id: 'dev-1',
  asset_name: 'Simulated_CNC_01',
  sparkplug_id: 'spb-cnc-01',
  status: 'ONLINE',
  is_quarantined: false,
  is_archived: false,
  active_gateway_id: 'gw-1',
  cell_id: 'cell-1',
  location_scope: 'cell',
  effective_cell_id: 'cell-1',
  location_source: 'explicit',
  ...overrides
})

const alert = (overrides = {}) => ({
  alert_name: 'Thermal Excursion',
  summary: 'Spindle temperature above the declared limit',
  severity: 'warning',
  entity_type: 'device',
  entity_id: 'dev-1',
  sparkplug_id: 'spb-cnc-01',
  ...overrides
})

const routeGet = (devices = []) => (path) => {
  if (path.startsWith('/api/v1/cells')) return Promise.resolve([CELL])
  if (path.startsWith('/api/v1/gateways')) return Promise.resolve([])
  if (path.startsWith('/api/v1/devices')) return Promise.resolve(devices)
  if (path.startsWith('/api/v1/telemetry')) return Promise.resolve([])
  return Promise.resolve([])
}

const renderMap = ({ devices = [], activeAlerts = [] } = {}) => {
  api.get.mockImplementation(routeGet(devices))
  return render(
    <OverviewTab
      onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} onSelectCell={vi.fn()}
      showToast={vi.fn()} hasPermission={() => true} onNavigateTab={vi.fn()}
      activeAlerts={activeAlerts}
    />
  )
}

/** The chip for the one device in the fixture, once the map has loaded. */
const chip = async () => {
  const name = await screen.findByText('Simulated_CNC_01')
  return name.closest('.chip')
}

beforeEach(() => { vi.clearAllMocks() })

// The legend

describe('shopfloor legend categories', () => {
  it('names four categories, the fourth being the alert state', async () => {
    renderMap()

    await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())
    const legend = document.querySelector('.shopfloor-legend')

    for (const label of ['Online', 'Needs attention', 'Nothing live', 'Alert firing']) {
      expect(within(legend).getByText(label, { exact: false })).toBeInTheDocument()
    }
  })

  /* The swatch is a chip, not a dot: the three dots roll up connectivity for a whole tile, and an
     alert belongs to one device inside one tile. A fourth dot would promise a tile-level state
     rollupDeviceStatus() never computes. */
  it('draws the alert entry as a chip swatch, leaving the tile dots at three', async () => {
    renderMap()

    await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())
    const legend = document.querySelector('.shopfloor-legend')

    expect(legend.querySelector('.legend-chip-danger')).toBeInTheDocument()
    expect(legend.querySelectorAll('.tile-dot')).toHaveLength(3)
    expect(legend.querySelector('.tile-dot-alert')).toBeNull()
  })

  it('says who raised the alert, since that is what permits red here at all', async () => {
    renderMap()

    await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())
    const entry = screen.getByTitle(/Alert firing/)

    // The dashboard withdrew its own threshold evaluation; this red RELAYS Grafana's verdict. A
    // legend that did not say so would read as the old client-side alarm coming back.
    expect(entry.getAttribute('title')).toMatch(/Grafana/)
  })
})

// The chip the legend describes

describe('alerting device chip', () => {
  it('carries no alert flag when nothing is firing', async () => {
    renderMap({ devices: [device()] })

    expect(await chip()).not.toHaveTextContent(/ALARM|WARN/)
  })

  it('flags a warning alert as well as reddening the chip', async () => {
    renderMap({ devices: [device()], activeAlerts: [alert()] })

    const el = await chip()
    // Both halves: the colour the legend promises, and a mark that survives without it.
    expect(el.className).toMatch(/chip-danger/)
    expect(el).toHaveTextContent('WARN')
  })

  it('flags a critical alert as ALARM, matching the Devices page', async () => {
    renderMap({ devices: [device()], activeAlerts: [alert({ severity: 'critical' })] })

    // One device must not answer to two different names on two pages.
    expect(await chip()).toHaveTextContent('ALARM')
  })

  /* Archived wins, as deviceChipClass() resolves it: the chip is grey by then, and an ALARM flag
     beside it would contradict its own colour. */
  it('shows ARCH and no alert flag on an archived device with an alert firing', async () => {
    renderMap({
      devices: [device({ is_archived: true })],
      activeAlerts: [alert({ severity: 'critical' })]
    })

    const el = await chip()
    expect(el).toHaveTextContent('ARCH')
    expect(el).not.toHaveTextContent(/ALARM|WARN/)
    expect(el.className).not.toMatch(/chip-danger/)
  })
})
