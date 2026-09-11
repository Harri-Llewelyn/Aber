/**
 * The ISA-95 rung above the cells: the Areas page files cells into areas, and the Overview
 * cycles the map one area at a time. Both read the same lists every other page reads.
 */
import React from 'react'
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AreasTab } from '../components/tabs/AreasTab'
import { OverviewTab } from '../components/tabs/OverviewTab'
import { api } from '../api'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), relocateDevices: vi.fn() }
  }
})

const NOW = Date.parse('2026-09-11T12:00:00Z')

const areaA = { area_id: 'area-a', area_name: 'Building A', description: null, cells: [], cell_count: 0 }
const areaB = { area_id: 'area-b', area_name: 'Building B', description: 'The annexe', cells: [], cell_count: 0 }

const gateway = {
  gateway_id: 'gw-1', gateway_name: 'Line_Gateway', cell_id: 'cell-1', location_scope: 'cell', sparkplug_group: 'ACS-Cymru',
  status: 'ONLINE', deployment: 'remote', is_archived: false,
  last_heartbeat: new Date(NOW - 20_000).toISOString(), device_count: 1, devices: []
}

const device = {
  asset_id: 'dev-1', asset_name: 'CNC_01', status: 'ONLINE', active_gateway_id: 'gw-1',
  gateway_name: 'Line_Gateway', cell_id: null, area_id: null, location_scope: 'cell',
  effective_cell_id: 'cell-1', gateway_cell_id: 'cell-1', location_source: 'inherited',
  cell_mismatch: false, effective_area_id: 'area-a'
}

const bms = {
  asset_id: 'dev-bms', asset_name: 'BMS_A', status: 'ONLINE', active_gateway_id: null,
  cell_id: null, area_id: 'area-a', location_scope: 'area_wide', effective_cell_id: null,
  gateway_cell_id: null, location_source: 'area_wide', cell_mismatch: false, effective_area_id: 'area-a'
}

const cells = [
  { cell_id: 'cell-1', cell_name: 'Bay 1', area_id: 'area-a', floor: 0, is_archived: false, description: 'Five-axis machining, two shifts', gateways: [gateway], gateway_count: 1 },
  { cell_id: 'cell-2', cell_name: 'Bay 2', area_id: 'area-a', floor: 1, is_archived: false, gateways: [], gateway_count: 0 },
  { cell_id: 'cell-3', cell_name: 'Paint Shop', area_id: 'area-b', floor: null, is_archived: false, gateways: [], gateway_count: 0 },
  { cell_id: 'cell-4', cell_name: 'Loose End', area_id: null, floor: null, is_archived: false, gateways: [], gateway_count: 0 }
]

const routeGet = (overrides = {}) => (path) => {
  if (path.startsWith('/api/v1/areas')) return Promise.resolve(overrides.areas ?? [areaA, areaB])
  if (path.startsWith('/api/v1/cells')) return Promise.resolve(overrides.cells ?? cells)
  if (path.startsWith('/api/v1/gateways')) return Promise.resolve(overrides.gateways ?? [gateway])
  if (path.startsWith('/api/v1/devices')) return Promise.resolve(overrides.devices ?? [device, bms])
  if (path.startsWith('/api/v1/settings')) return Promise.resolve(overrides.settings ?? [])
  return Promise.resolve([])
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)
  api.get.mockImplementation(routeGet())
  api.put.mockResolvedValue({})
})

afterEach(() => {
  vi.useRealTimers()
})

const cellTiles = () => [...document.querySelectorAll('.shopfloor-grid > .shopfloor-cell')]
const tileNames = () => cellTiles().map(t => t.querySelector('.zone-name')?.textContent || t.textContent)
const laneTiles = () => [...document.querySelectorAll('.shopfloor-lanes > .shopfloor-lane')]
const laneTitled = (re) => laneTiles().find(l => re.test(l.textContent))
// An area's Area-Wide tile lives in the grid with its cells, not in the campus lane row.
const areaTiles = () => [...document.querySelectorAll('.shopfloor-grid > .shopfloor-lane-area')]
const areaTitled = (re) => areaTiles().find(t => re.test(t.textContent))
const follows = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

describe('OverviewTab cycles the map by area', () => {
  const renderOverview = async () => {
    render(<OverviewTab showToast={vi.fn()} hasPermission={() => true} onSelectCell={vi.fn()} onNavigateTab={vi.fn()} />)
    await waitFor(() => expect(cellTiles().length).toBeGreaterThan(0))
  }

  it('names the enterprise and the site above the lanes, and says when the site is not set', async () => {
    // The whole ISA-95 ladder on one page: the enterprise is the gateways' Sparkplug group, the
    // site is the setting the Unified Namespace publishes under.
    await renderOverview()
    const hierarchy = screen.getByRole('group', { name: 'Hierarchy' })
    expect(within(hierarchy).getByText('ACS-Cymru')).toBeInTheDocument()
    expect(within(hierarchy).getByText(/Not set — name it on the Settings page/)).toBeInTheDocument()
    expect(follows(hierarchy, document.querySelector('.shopfloor-lanes'))).toBe(true)
    // The card is the site map, with its explanation folded into the title's help tip and no
    // standing paragraph, and no ribbon of counts above it.
    expect(screen.getByText('Site Map')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'About the site map' })).toBeInTheDocument()
    expect(document.querySelector('.kpi-ribbon')).toBeNull()
  })

  it("puts a help tip beside a described cell's name, and none beside an undescribed one", async () => {
    await renderOverview()
    const bay = cellTiles().find(t => within(t).queryByText('Bay 1'))
    expect(within(bay).getByRole('button', { name: 'About Bay 1' })).toBeInTheDocument()
    const paint = cellTiles().find(t => within(t).queryByText('Paint Shop'))
    expect(within(paint).queryByRole('button', { name: /^About/ })).toBeNull()
  })

  it('names the site once the setting holds a name', async () => {
    api.get.mockImplementation(routeGet({ settings: [{ key: 'site.name', value: 'Broughton' }] }))
    await renderOverview()
    const hierarchy = screen.getByRole('group', { name: 'Hierarchy' })
    await waitFor(() => expect(within(hierarchy).getByText('Broughton')).toBeInTheDocument())
    expect(within(hierarchy).queryByText(/Not set/)).toBeNull()
  })

  it('shows every area grouped, with unfiled cells last, until one is chosen', async () => {
    await renderOverview()
    const headings = [...document.querySelectorAll('.shopfloor-floor-heading')].map(h => h.textContent)
    expect(headings).toEqual(['Building A', 'Building B', 'Unfiled — in no area yet'])
    expect(cellTiles()).toHaveLength(4)
    expect(screen.getByRole('button', { name: 'All areas' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('keeps the campus lanes above the area selector, with no Area-Wide lane among them', async () => {
    // Site-Wide, Simulated and Unassigned belong to no area, so they sit above the control
    // that chooses one. Area-Wide belongs to an area, so it is not in that row.
    await renderOverview()
    expect(laneTiles().map(l => l.querySelector('.zone-name')?.textContent)).toEqual(['Site-Wide', 'Simulated', 'Unassigned'])
    expect(laneTitled(/Area-Wide/)).toBeUndefined()
    const lanes = document.querySelector('.shopfloor-lanes')
    const selector = document.querySelector('.shopfloor-areas')
    const grid = document.querySelector('.shopfloor-grid')
    expect(follows(lanes, selector)).toBe(true)
    expect(follows(selector, grid)).toBe(true)
  })

  it('leads each area\'s cells with its own Area-Wide tile, holding that area\'s BMS', async () => {
    await renderOverview()
    const kids = [...document.querySelector('.shopfloor-grid').children]
    const afterHeading = (label) => kids[kids.findIndex(k => k.textContent === label) + 1]
    // The tile is the first thing under the area's heading, beside its first cell.
    expect(afterHeading('Building A').className).toMatch(/shopfloor-lane-area/)
    expect(within(afterHeading('Building A')).getByText('BMS_A')).toBeInTheDocument()
    expect(afterHeading('Building B').className).toMatch(/shopfloor-lane-area/)
    expect(within(afterHeading('Building B')).queryByText('BMS_A')).toBeNull()
    // Unfiled cells are in no area, so they get no such tile.
    expect(afterHeading('Unfiled — in no area yet').className).toMatch(/shopfloor-cell/)
    expect(areaTiles()).toHaveLength(2)
  })

  it('narrows to one area, by floor, and keeps Site-Wide and Unassigned as context', async () => {
    await renderOverview()
    fireEvent.click(screen.getByRole('button', { name: /Building A/ }))

    await waitFor(() => expect(cellTiles()).toHaveLength(2))
    const headings = [...document.querySelectorAll('.shopfloor-floor-heading')].map(h => h.textContent)
    expect(headings).toEqual(['Ground floor', 'Floor 1'])
    expect(tileNames().join(' ')).toMatch(/Bay 1/)
    expect(tileNames().join(' ')).not.toMatch(/Paint Shop/)

    // The lanes stay: an area's operator still wants the campus BMS and the queue.
    expect(laneTitled(/^Site-Wide/)).toBeTruthy()
    expect(laneTitled(/Unassigned/)).toBeTruthy()
    // And the area's Area-Wide tile leads the grid, above its floors, holding its BMS.
    expect(areaTiles()).toHaveLength(1)
    const areaTile = areaTitled(/Area-Wide — Building A/)
    expect(document.querySelector('.shopfloor-grid').children[0]).toBe(areaTile)
    expect(within(areaTile).getByText('BMS_A')).toBeInTheDocument()
  })

  it('does not show an area that has no area-wide assets as holding another area\'s BMS', async () => {
    await renderOverview()
    fireEvent.click(screen.getByRole('button', { name: /Building B/ }))
    await waitFor(() => expect(cellTiles()).toHaveLength(1))
    const areaTile = areaTitled(/Area-Wide — Building B/)
    expect(within(areaTile).queryByText('BMS_A')).toBeNull()
  })

  it('cycles with the arrows, wrapping from the last area back to every area', async () => {
    await renderOverview()
    fireEvent.click(screen.getByRole('button', { name: 'Next area' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Building A/ })).toHaveAttribute('aria-pressed', 'true'))
    fireEvent.click(screen.getByRole('button', { name: 'Next area' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next area' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'All areas' })).toHaveAttribute('aria-pressed', 'true'))
    fireEvent.click(screen.getByRole('button', { name: 'Previous area' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Building B/ })).toHaveAttribute('aria-pressed', 'true'))
  })

  it('offers no area selector and no Area-Wide lane on a plant with no areas', async () => {
    api.get.mockImplementation(routeGet({ areas: [], devices: [device] }))
    await renderOverview()
    expect(screen.queryByRole('button', { name: 'All areas' })).toBeNull()
    expect(laneTitled(/Area-Wide/)).toBeUndefined()
    expect(areaTiles()).toHaveLength(0)
    expect(document.querySelectorAll('.shopfloor-floor-heading')).toHaveLength(0)
  })

  it('files an Area-Wide drop under the area whose tile took it, with no area chosen', async () => {
    // Each area has its own tile, so a drop always knows its area: nothing to ask.
    api.relocateDevices.mockResolvedValue({ applied: 1, unchanged: 0, devices: [] })
    const showToast = vi.fn()
    render(<OverviewTab showToast={showToast} hasPermission={() => true} onSelectCell={vi.fn()} onNavigateTab={vi.fn()} />)
    await waitFor(() => expect(cellTiles().length).toBeGreaterThan(0))
    fireEvent.click(screen.getByRole('button', { name: /Rearrang/i }))

    const tile = areaTitled(/Area-Wide — Building B/)
    const dataTransfer = { getData: () => JSON.stringify(device), setData: vi.fn() }
    fireEvent.dragOver(tile, { dataTransfer })
    fireEvent.drop(tile, { dataTransfer })

    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/Building B/), 'success')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Apply \d+ move/ }))
    })
    expect(api.relocateDevices.mock.calls[0][0]).toEqual([
      { device_id: 'dev-1', cell_id: null, area_id: 'area-b', location_scope: 'area_wide' }
    ])
  })

  it('stages an Area-Wide drop in an area view with that area, and sends it in the batch', async () => {
    api.relocateDevices.mockResolvedValue({ applied: 1, unchanged: 0, devices: [] })
    render(<OverviewTab showToast={vi.fn()} hasPermission={() => true} onSelectCell={vi.fn()} onNavigateTab={vi.fn()} />)
    await waitFor(() => expect(cellTiles().length).toBeGreaterThan(0))
    fireEvent.click(screen.getByRole('button', { name: /Building A/ }))
    await waitFor(() => expect(cellTiles()).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: /Rearrang/i }))

    const lane = areaTitled(/Area-Wide — Building A/)
    const dataTransfer = { getData: () => JSON.stringify(device), setData: vi.fn() }
    fireEvent.dragOver(lane, { dataTransfer })
    fireEvent.drop(lane, { dataTransfer })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Apply \d+ move/ }))
    })
    expect(api.relocateDevices.mock.calls[0][0]).toEqual([
      { device_id: 'dev-1', cell_id: null, area_id: 'area-a', location_scope: 'area_wide' }
    ])
  })
})

describe('AreasTab files cells into areas', () => {
  const renderAreas = async (props = {}) => {
    render(<AreasTab showToast={vi.fn()} hasPermission={() => true} onSelectCell={vi.fn()} onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} {...props} />)
    await waitFor(() => expect(screen.getByText('Building A')).toBeInTheDocument())
  }

  const rowFor = (name) => screen.getByText(name).closest('tr')

  it('lists the unfiled cells in a banner above the card, and each area\'s cells by floor', async () => {
    await renderAreas()
    const banner = screen.getByText(/1 unfiled cell/).parentElement
    // Above the card, as the Cells and Gateways pages report their unfinished business.
    expect(banner.closest('.card')).toBeNull()
    expect(follows(banner, document.querySelector('.card'))).toBe(true)
    expect(screen.getByText('Loose End')).toBeInTheDocument()
    const rowA = rowFor('Building A')
    expect(within(rowA).getByText('Ground floor')).toBeInTheDocument()
    expect(within(rowA).getByText('Floor 1')).toBeInTheDocument()
    expect(within(rowA).getByText('Bay 1')).toBeInTheDocument()
    expect(within(rowFor('Building B')).getByText('No floor set')).toBeInTheDocument()
  })

  it('shows no banner at all once every cell is filed', async () => {
    api.get.mockImplementation(routeGet({ cells: cells.filter(c => c.area_id) }))
    await renderAreas()
    expect(screen.queryByText(/unfiled cell/)).toBeNull()
    expect(screen.queryByText(/Every cell is filed/)).toBeNull()
  })

  it('saves the chosen icon with a new area, and shows it on the row', async () => {
    api.post.mockResolvedValue({})
    await renderAreas()
    fireEvent.click(screen.getByRole('button', { name: /New Area/ }))
    fireEvent.change(screen.getByLabelText('Area Name'), { target: { value: 'Stores' } })
    expect(screen.getByRole('radio', { name: 'Office & general' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('radio', { name: 'Warehouse & stores' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(api.post.mock.calls[0][1]).toMatchObject({ area_name: 'Stores', icon: 'Warehouse' })
  })

  it('counts the devices resolving to an area and its area-wide assets separately', async () => {
    await renderAreas()
    const rowA = rowFor('Building A')
    expect(within(rowA).getByText('1')).toBeInTheDocument()
    expect(within(rowA).getByText('+1 area-wide')).toBeInTheDocument()
  })

  it('files a dropped cell with one write naming the area, and says so', async () => {
    const showToast = vi.fn()
    await renderAreas({ showToast })
    const dataTransfer = { getData: () => JSON.stringify({ cell_id: 'cell-4' }), setData: vi.fn() }
    const rowB = rowFor('Building B')
    fireEvent.dragOver(rowB, { dataTransfer })
    await act(async () => { fireEvent.drop(rowB, { dataTransfer }) })

    expect(api.put).toHaveBeenCalledTimes(1)
    expect(api.put.mock.calls[0][0]).toBe('/api/v1/cells/cell-4')
    expect(api.put.mock.calls[0][1]).toMatchObject({ area_id: 'area-b' })
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/Loose End.*Building B/), 'success')
  })

  it('un-files a cell dropped back onto the queue', async () => {
    await renderAreas()
    const dataTransfer = { getData: () => JSON.stringify({ cell_id: 'cell-1' }), setData: vi.fn() }
    const queue = screen.getByText(/1 unfiled cell/).parentElement
    fireEvent.dragOver(queue, { dataTransfer })
    await act(async () => { fireEvent.drop(queue, { dataTransfer }) })
    expect(api.put.mock.calls[0][1]).toMatchObject({ area_id: '' })
  })

  it('does not write for a drop that changes nothing', async () => {
    await renderAreas()
    const dataTransfer = { getData: () => JSON.stringify({ cell_id: 'cell-1' }), setData: vi.fn() }
    const rowA = rowFor('Building A')
    fireEvent.dragOver(rowA, { dataTransfer })
    await act(async () => { fireEvent.drop(rowA, { dataTransfer }) })
    expect(api.put).not.toHaveBeenCalled()
  })

  it('refuses a new area whose name would break a topic', async () => {
    await renderAreas()
    fireEvent.click(screen.getByRole('button', { name: /New Area/ }))
    fireEvent.change(screen.getByLabelText('Area Name'), { target: { value: 'Block/2' } })
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Area Name'), { target: { value: 'Block 2' } })
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled()
  })

  it('withholds the drag and the actions from somebody who may not manage cells', async () => {
    await renderAreas({ hasPermission: () => false })
    expect(screen.getByRole('button', { name: /New Area/ })).toBeDisabled()
    const dataTransfer = { getData: () => JSON.stringify({ cell_id: 'cell-4' }), setData: vi.fn() }
    const rowB = rowFor('Building B')
    fireEvent.dragOver(rowB, { dataTransfer })
    await act(async () => { fireEvent.drop(rowB, { dataTransfer }) })
    expect(api.put).not.toHaveBeenCalled()
  })
})
