/**
 * An area is archived only when nothing is Area-Wide in it (0199). The database refuses the
 * archive while any device or gateway is Area-Wide in the area, archived ones included, because
 * the nightly purge cannot delete an area one of them names. The Areas page says so before the
 * click, and the location picker stops offering an archived area to make anything Area-Wide in.
 */
import React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AreasTab } from '../components/tabs/AreasTab'
import { LocationPicker } from '../components/common/LocationPicker'
import { areaWideIn, archiveRefusal } from '../utils/areaArchive'
import { api } from '../api'
import { tooltipOf } from '../test/tooltips'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    loadAreaPlanUrl: vi.fn().mockResolvedValue('blob:plan-1'),
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), uploadAreaPlan: vi.fn(), removeAreaPlan: vi.fn() }
  }
})

const hall = { area_id: 'area-a', area_name: 'North Shop', description: null, icon: 'Factory', cells: [], plan_path: null, plan_aspect: null }
const annexe = { area_id: 'area-b', area_name: 'Press Hall', description: null, icon: 'Warehouse', cells: [], plan_path: null, plan_aspect: null }

const areaWideDevice = (id, extra = {}) => ({
  asset_id: id, asset_name: id, status: 'OFFLINE', cell_id: null, area_id: 'area-a', location_scope: 'area_wide',
  effective_cell_id: null, location_source: 'area_wide', effective_area_id: 'area-a', ...extra
})
const areaWideGateway = {
  gateway_id: 'gw-bms', gateway_name: 'BMS_Gateway', cell_id: null, area_id: 'area-a', location_scope: 'area_wide',
  status: 'ONLINE', deployment: 'remote', is_archived: false, devices: []
}
// In a cell filed in the annexe: archiving the annexe keeps it where it is.
const cell = { cell_id: 'cell-1', cell_name: 'Bay 1', area_id: 'area-b', is_archived: false, gateways: [], gateway_count: 0 }
const deviceInCell = {
  asset_id: 'dev-cnc', asset_name: 'CNC_01', status: 'ONLINE', cell_id: 'cell-1', area_id: null, location_scope: 'cell',
  effective_cell_id: 'cell-1', location_source: 'explicit', effective_area_id: 'area-b'
}

const routeGet = ({ devices, gateways }) => (path) => {
  if (path.startsWith('/api/v1/areas')) return Promise.resolve([hall, annexe])
  if (path.startsWith('/api/v1/cells')) return Promise.resolve([cell])
  if (path.startsWith('/api/v1/gateways')) return Promise.resolve(gateways)
  if (path.startsWith('/api/v1/devices')) return Promise.resolve(devices)
  return Promise.resolve([])
}

const renderAreas = async ({ devices = [deviceInCell], gateways = [] } = {}) => {
  api.get.mockImplementation(routeGet({ devices, gateways }))
  render(<AreasTab showToast={vi.fn()} hasPermission={() => true} onSelectCell={vi.fn()} onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} />)
  await waitFor(() => expect(screen.getByText('North Shop')).toBeInTheDocument())
}
const archiveButton = () => screen.getByRole('button', { name: /Archive Area/ })

describe('Archive Area waits until nothing is Area-Wide in the area', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('is disabled while devices and a gateway are Area-Wide in it, and says what to do', async () => {
    await renderAreas({
      devices: [areaWideDevice('BMS_A'), areaWideDevice('Meter_B', { is_archived: true }), deviceInCell],
      gateways: [areaWideGateway]
    })
    fireEvent.click(screen.getByText('North Shop'))
    expect(archiveButton()).toBeDisabled()
    expect(tooltipOf(archiveButton())).toBe(
      'This area still holds 2 Area-Wide devices and 1 Area-Wide gateway. Make each one Site-Wide or ' +
      'put it in a cell, or delete it, then archive the area. They are listed under Area-Wide Assets.')
    fireEvent.click(archiveButton())
    expect(document.querySelector('.modal')).toBeNull()
  })

  it('is offered for an area that holds only cells', async () => {
    await renderAreas({ devices: [areaWideDevice('BMS_A'), deviceInCell] })
    fireEvent.click(screen.getByText('Press Hall'))
    expect(archiveButton()).not.toBeDisabled()
    expect(tooltipOf(archiveButton())).toMatch(/^Archive this area/)
  })

  it('names the roles first for someone who may not archive at all', async () => {
    api.get.mockImplementation(routeGet({ devices: [areaWideDevice('BMS_A')], gateways: [] }))
    render(<AreasTab showToast={vi.fn()} hasPermission={() => false} onSelectCell={vi.fn()} onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('North Shop')).toBeInTheDocument())
    fireEvent.click(screen.getByText('North Shop'))
    expect(tooltipOf(archiveButton())).toMatch(/^Requires /)
  })
})

describe('what counts, as the database counts it', () => {
  it('counts every device and gateway whose area_id is the area, and nothing in its cells', () => {
    const held = areaWideIn('area-a', [areaWideDevice('a'), areaWideDevice('b', { is_quarantined: true }), deviceInCell], [areaWideGateway])
    expect(held.devices.map(d => d.asset_id)).toEqual(['a', 'b'])
    expect(held.gateways).toHaveLength(1)
    expect(areaWideIn('area-b', [deviceInCell], [])).toEqual({ devices: [], gateways: [] })
  })

  it('says nothing for an area nothing names, and each count in the singular or the plural', () => {
    expect(archiveRefusal({ devices: [], gateways: [] })).toBeNull()
    expect(archiveRefusal({ devices: [{}], gateways: [] })).toMatch(/^This area still holds 1 Area-Wide device\./)
    expect(archiveRefusal({ devices: [], gateways: [{}, {}] })).toMatch(/^This area still holds 2 Area-Wide gateways\./)
  })
})

describe('the location picker leaves archived areas out', () => {
  it('offers only live areas for Area-Wide', () => {
    const areas = [
      { area_id: 'area-a', area_name: 'North Shop' },
      { area_id: 'area-old', area_name: 'Old Store', is_archived: true },
      { area_id: 'area-b', area_name: 'Press Hall' }
    ]
    render(<LocationPicker idPrefix="t" form={{ location_scope: 'area_wide', area_id: '' }} onChange={vi.fn()} areas={areas} />)
    const options = [...document.querySelectorAll('option')].map(o => o.textContent)
    expect(options).toContain('North Shop')
    expect(options).toContain('Press Hall')
    expect(options).not.toContain('Old Store')
  })

  it('chooses the one live area without asking when the rest are archived', () => {
    const onChange = vi.fn()
    render(<LocationPicker idPrefix="t" form={{ location_scope: 'cell', area_id: '' }} onChange={onChange}
      areas={[{ area_id: 'area-a', area_name: 'North Shop' }, { area_id: 'area-old', area_name: 'Old Store', is_archived: true }]} />)
    fireEvent.click(screen.getByRole('radio', { name: /Area-Wide/ }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ location_scope: 'area_wide', area_id: 'area-a' }))
  })
})
