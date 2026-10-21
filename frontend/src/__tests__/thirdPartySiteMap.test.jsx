import React from 'react'
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SiteMapTab } from '../components/tabs/SiteMapTab'
import { api } from '../api'
import { tooltipOf } from '../test/tooltips'

/**
 * A Third-party gateway on the Site Map follows Remote: it is shown in the cell it serves, and its
 * chip carries no "Runs on this host" flag, which only a Host gateway does.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const AREA = { area_id: 'area-1', area_name: 'North Shop', icon: 'Factory', plan_path: null, plan_aspect: null, cells: [] }
const CELL = { cell_id: 'cell-1', cell_name: 'Assembly Line 1', is_archived: false, area_id: 'area-1', plan_x: 0.5, plan_y: 0.5 }

const gateway = (overrides) => ({
  is_archived: false, is_simulated: false, is_shadow: false, status: 'ONLINE',
  last_heartbeat: new Date().toISOString(), device_count: 0, location_scope: 'cell', cell_id: null,
  ...overrides
})

const GATEWAYS = [
  gateway({ gateway_id: 'gw-tp', gateway_name: 'Vendor_Node', deployment: 'third_party', cell_id: 'cell-1' }),
  gateway({ gateway_id: 'gw-tp-wide', gateway_name: 'Vendor_Wide', deployment: 'third_party', location_scope: 'site_wide' }),
  gateway({ gateway_id: 'gw-host-wide', gateway_name: 'Host_Wide', deployment: 'host', location_scope: 'site_wide' }),
]

const renderMap = () => {
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/cells')) return Promise.resolve([CELL])
    if (path.startsWith('/api/v1/areas')) return Promise.resolve([AREA])
    if (path.startsWith('/api/v1/gateways')) return Promise.resolve(GATEWAYS)
    return Promise.resolve([])
  })
  return render(
    <SiteMapTab
      onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} onSelectCell={vi.fn()}
      showToast={vi.fn()} hasPermission={() => true} onNavigateTab={vi.fn()} activeAlerts={[]}
    />
  )
}

/** A gateway's chip in the open panel, by its name. */
const chipNamed = (name) => [...document.querySelectorAll('.context-panel .chip-gw')]
  .find(chip => chip.textContent.includes(name))

beforeEach(() => { vi.clearAllMocks() })

describe('a Third-party gateway on the Site Map', () => {
  it('is shown in the cell it serves', async () => {
    renderMap()
    const pin = await waitFor(() => within(document.querySelector('.area-card')).getByRole('button', { name: 'Assembly Line 1' }))
    fireEvent.click(pin)
    await waitFor(() => expect(chipNamed('Vendor_Node')).toBeTruthy())
  })

  it('carries no host flag, which a Host gateway beside it does', async () => {
    renderMap()
    const lane = await screen.findByText('Site-Wide', { selector: '.site-lane-name' })
    fireEvent.click(lane.closest('button'))
    await waitFor(() => expect(chipNamed('Vendor_Wide')).toBeTruthy())

    expect(chipNamed('Vendor_Wide').querySelector('[title="Runs on this host"]')).toBeNull()
    expect(tooltipOf(chipNamed('Vendor_Wide'))).not.toMatch(/Host-run/)
    expect(chipNamed('Host_Wide').querySelector('[title="Runs on this host"]')).not.toBeNull()
  })
})
