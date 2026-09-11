/**
 * The ISA-95 rung above the cells: the Areas page files cells into areas and manages their floors,
 * and the Overview draws each area's floors on the Site Map. Both read the same lists every other
 * page reads.
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
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), uploadFloorPlan: vi.fn(), removeFloorPlan: vi.fn() }
  }
})

const NOW = Date.parse('2026-09-11T12:00:00Z')

const groundA = { floor_id: 'floor-a0', area_id: 'area-a', level: 0, name: 'Ground floor', plan_path: null, plan_aspect: null }
const firstA = { floor_id: 'floor-a1', area_id: 'area-a', level: 1, name: 'Floor 1', plan_path: 'area-a/floor-a1/plan-1.svg', plan_aspect: 1.5 }
const basementA = { floor_id: 'floor-ab', area_id: 'area-a', level: -1, name: 'Deep basement', plan_path: null, plan_aspect: null }
const groundB = { floor_id: 'floor-b0', area_id: 'area-b', level: 0, name: 'Ground floor', plan_path: null, plan_aspect: null }

const areaA = { area_id: 'area-a', area_name: 'Building A', description: null, icon: 'Factory', cells: [], cell_count: 0, floors: [firstA, groundA, basementA], floor_count: 3 }
const areaB = { area_id: 'area-b', area_name: 'Building B', description: 'The annexe', icon: 'Warehouse', cells: [], cell_count: 0, floors: [groundB], floor_count: 1 }

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
  // Placed on the ground floor of A.
  { cell_id: 'cell-1', cell_name: 'Bay 1', area_id: 'area-a', floor_id: 'floor-a0', plan_x: 0.3, plan_y: 0.4, is_archived: false, description: 'Five-axis machining, two shifts', gateways: [gateway], gateway_count: 1 },
  // On the first floor of A, not yet placed.
  { cell_id: 'cell-2', cell_name: 'Bay 2', area_id: 'area-a', floor_id: 'floor-a1', plan_x: null, plan_y: null, is_archived: false, gateways: [], gateway_count: 0 },
  // In B, on no floor.
  { cell_id: 'cell-3', cell_name: 'Paint Shop', area_id: 'area-b', floor_id: null, plan_x: null, plan_y: null, is_archived: false, gateways: [], gateway_count: 0 },
  // In no area.
  { cell_id: 'cell-4', cell_name: 'Loose End', area_id: null, floor_id: null, plan_x: null, plan_y: null, is_archived: false, gateways: [], gateway_count: 0 }
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

const thumbs = () => [...document.querySelectorAll('.shopfloor-grid > .area-thumb')]
const pins = () => [...document.querySelectorAll('.site-map-stage .floor-pin')]
const pinNames = () => pins().map(p => p.getAttribute('aria-label'))
const lanes = () => [...document.querySelectorAll('.site-lanes > .site-lane')]
const panel = () => document.querySelector('.context-panel')
const follows = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
/** The floor the open area shows: the pressed button on the rail. */
const shownFloor = () => within(screen.getByRole('group', { name: 'Floor' })).getAllByRole('button').find(b => b.getAttribute('aria-pressed') === 'true')?.textContent
const hierarchy = () => screen.getByRole('group', { name: 'Hierarchy' })

describe('OverviewTab draws the areas on the Site Map', () => {
  const renderOverview = async () => {
    render(<OverviewTab showToast={vi.fn()} hasPermission={() => true} onSelectCell={vi.fn()} onNavigateTab={vi.fn()} />)
    await waitFor(() => expect(thumbs().length).toBeGreaterThan(0))
  }

  it('names the enterprise and the site in the Overview card, and says when the site is not set', async () => {
    await renderOverview()
    const hierarchy = screen.getByRole('group', { name: 'Hierarchy' })
    expect(within(hierarchy).getByText('ACS-Cymru')).toBeInTheDocument()
    expect(within(hierarchy).getByText(/Not set — name it on the Settings page/)).toBeInTheDocument()
    // One card, the Site Map: the ladder, the lanes and the plans share it.
    const titles = [...document.querySelectorAll('.shopfloor-title')].map(t => t.textContent)
    expect(titles).toEqual([expect.stringMatching(/^Site Map/)])
    expect(screen.getByRole('button', { name: 'About the site map' })).toBeInTheDocument()
    expect(document.querySelectorAll('.shopfloor-map-card')).toHaveLength(1)
  })

  it('names the site once the setting holds a name', async () => {
    api.get.mockImplementation(routeGet({ settings: [{ key: 'site.name', value: 'Broughton' }] }))
    await renderOverview()
    const hierarchy = screen.getByRole('group', { name: 'Hierarchy' })
    await waitFor(() => expect(within(hierarchy).getByText('Broughton')).toBeInTheDocument())
    expect(within(hierarchy).queryByText(/Not set/)).toBeNull()
  })

  it('shows every area as its ground floor with its counts at the top, and the unfiled cells beside them', async () => {
    await renderOverview()
    expect(thumbs().map(t => within(t).getByText(/Building/).textContent)).toEqual(['Building A', 'Building B'])
    // Cells, gateways and devices in the header; Area-Wide assets count, so Building A's BMS does.
    expect(within(thumbs()[0].querySelector('.area-thumb-header')).getByText('2 cells · GW 1 · Dev 2')).toBeInTheDocument()
    expect(within(thumbs()[1].querySelector('.area-thumb-header')).getByText('1 cell · GW 0 · Dev 0')).toBeInTheDocument()
    expect(screen.queryByText(/\d floors?$/)).toBeNull()
    // The ground floor's placed cell is a small pin on the thumbnail, named; the first-floor cell is not.
    expect(within(thumbs()[0]).getByRole('button', { name: 'Bay 1' })).toBeInTheDocument()
    expect(within(thumbs()[0]).getByRole('button', { name: 'Bay 1' }).querySelector('.floor-pin-label')).toHaveTextContent('Bay 1')
    expect(within(thumbs()[0]).queryByRole('button', { name: 'Bay 2' })).toBeNull()
    // All areas is the way back from an area, so it is not offered while every area is shown.
    expect(screen.queryByRole('button', { name: 'All areas' })).toBeNull()
    const unfiled = document.querySelector('[data-tray="unfiled"]')
    expect(within(unfiled).getByText('Loose End')).toBeInTheDocument()
  })

  it('keeps the three campus lanes side by side in the Overview card, each in its own hue, with no area selector', async () => {
    // Site-Wide, Simulated and Unassigned belong to no area. Area-Wide is not among them: it
    // belongs to an area and is listed beside that area's plan.
    await renderOverview()
    expect(lanes().map(l => l.textContent.replace(/GW.*$/, '').trim())).toEqual(['Site-Wide', 'Simulated', 'Unassigned'])
    expect(lanes().map(l => l.className)).toEqual([
      expect.stringContaining('site-lane-site'),
      expect.stringContaining('site-lane-simulated'),
      expect.stringContaining('site-lane-queue')
    ])
    expect(screen.queryByText(/Area-Wide/)).toBeNull()
    // Every lane is empty on this fixture, so none draws a status dot.
    expect(lanes().every(l => !l.querySelector('.tile-dot'))).toBe(true)
    // The thumbnails are the way into an area: no selector, no arrows.
    expect(document.querySelector('.shopfloor-areas')).toBeNull()
    expect(screen.queryByRole('button', { name: /Next area|Previous area/ })).toBeNull()
    // No drag-and-drop: nothing on the page is draggable and nothing offers to rearrange.
    expect(document.querySelectorAll('[draggable="true"]')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /Rearrang/ })).toBeNull()
  })

  it('opens a lane into the details panel listing its assets, one lane at a time', async () => {
    api.get.mockImplementation(routeGet({ devices: [device, bms, { ...device, asset_id: 'dev-2', asset_name: 'Loose_Device', effective_cell_id: null, gateway_cell_id: null, location_source: 'unassigned', effective_area_id: null }] }))
    await renderOverview()
    expect(document.querySelector('.context-panel-open')).toBeNull()
    // The one lane holding something draws its dot; the empty two do not.
    expect(lanes().map(l => !!l.querySelector('.tile-dot'))).toEqual([false, false, true])
    fireEvent.click(screen.getByRole('button', { name: /Unassigned/ }))
    expect(document.querySelector('.context-panel-open')).toBeTruthy()
    expect(within(panel()).getByText('Unassigned')).toBeInTheDocument()
    expect(within(panel()).getByText('Loose_Device')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Unassigned/ })).toHaveAttribute('aria-pressed', 'true')
    // Another lane takes the panel over; the first is no longer pressed.
    fireEvent.click(screen.getByRole('button', { name: /Site-Wide/ }))
    expect(within(panel()).queryByText('Loose_Device')).toBeNull()
    expect(within(panel()).getByText(/A permanent home, not a queue/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Unassigned/ })).toHaveAttribute('aria-pressed', 'false')
    // A second click on the open lane closes the panel.
    fireEvent.click(screen.getByRole('button', { name: /Site-Wide/ }))
    await waitFor(() => expect(document.querySelector('.context-panel-open')).toBeNull())
  })

  it('gives the panel to whichever of a lane or a pin was clicked last', async () => {
    await renderOverview()
    fireEvent.click(screen.getByRole('button', { name: 'Building A' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Bay 1' }))
    expect(within(panel()).getByText('Building A · Ground floor')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Simulated/ }))
    expect(within(panel()).queryByText('Building A · Ground floor')).toBeNull()
    expect(within(panel()).getByText('Simulated')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Bay 1' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('opens an area on its ground floor, with a floor rail, its pins, and the tray beside the plan', async () => {
    await renderOverview()
    fireEvent.click(within(thumbs()[0]).getByText('Building A'))

    await waitFor(() => expect(pins().length).toBe(1))
    expect(pinNames()).toEqual(['Bay 1'])
    expect(shownFloor()).toMatch(/Ground floor/)
    // No heading restates the area: the hierarchy row names it, the rail names the floor.
    expect(screen.queryByRole('heading', { level: 4 })).toBeNull()
    // The rail lists the floors top-down, the ground floor pressed.
    const rail = screen.getByRole('group', { name: 'Floor' })
    const railButtons = within(rail).getAllByRole('button').filter(b => /floor|basement/i.test(b.textContent))
    expect(railButtons.map(b => b.textContent.trim())).toEqual(['1 Floor 1', '0 Ground floor', '-1 Deep basement'])
    expect(within(rail).getByRole('button', { name: /Ground floor/ })).toHaveAttribute('aria-pressed', 'true')
    // Floor 1 carries a plan and says so; the ground floor draws the outline and does not.
    expect(within(rail).getByRole('button', { name: /Floor 1/ }).querySelector('.floor-plan-flag')).toBeTruthy()
    expect(within(rail).getByRole('button', { name: /Ground floor/ }).querySelector('.floor-plan-flag')).toBeNull()
    // The hierarchy row gains the area.
    expect(within(screen.getByRole('group', { name: 'Hierarchy' })).getByText('Building A')).toBeInTheDocument()
    // Area-Wide sits in the tray, with the BMS, and not as a pin.
    const wide = document.querySelector('[data-tray="area-wide"]')
    expect(within(wide).getByText('BMS_A')).toBeInTheDocument()
    expect(document.querySelector('[data-tray="unplaced"]')).toBeNull()
  })

  it('walks the floors from the rail and from the arrows, listing an unplaced cell beside the plan', async () => {
    await renderOverview()
    fireEvent.click(screen.getByRole('button', { name: 'Building A' }))
    await waitFor(() => expect(pins().length).toBe(1))

    fireEvent.click(screen.getByRole('button', { name: /^1 Floor 1/ }))
    expect(shownFloor()).toMatch(/Floor 1/)
    expect(pins()).toHaveLength(0)
    // Bay 2 is on this floor but has no place: it is in the tray, not lost.
    const tray = document.querySelector('[data-tray="unplaced"]')
    expect(within(tray).getByText('Bay 2')).toBeInTheDocument()
    // The plan itself is the uploaded one for this floor.
    expect(document.querySelector('.site-map-stage .floor-plan').getAttribute('data-plan')).toBe('uploaded')

    fireEvent.click(screen.getByRole('button', { name: 'Floor below' }))
    expect(shownFloor()).toMatch(/Ground floor/)
    fireEvent.click(screen.getByRole('button', { name: 'Floor below' }))
    expect(shownFloor()).toMatch(/Deep basement/)
    expect(screen.getByRole('button', { name: 'Floor below' })).toBeDisabled()
    expect(document.querySelector('.site-map-stage .floor-plan').getAttribute('data-plan')).toBe('outline')
  })

  it('lists a cell on no floor beside the plan, and shows the default outline for a floor with no plan', async () => {
    await renderOverview()
    fireEvent.click(screen.getByRole('button', { name: 'Building B' }))
    await waitFor(() => expect(within(hierarchy()).getByText('Building B')).toBeInTheDocument())
    expect(shownFloor()).toMatch(/Ground floor/)
    const tray = document.querySelector('[data-tray="no-floor"]')
    expect(within(tray).getByText('Paint Shop')).toBeInTheDocument()
    expect(document.querySelector('.site-map-stage .floor-plan').getAttribute('data-plan')).toBe('outline')
    expect(within(document.querySelector('[data-tray="area-wide"]')).queryByText('BMS_A')).toBeNull()
  })

  it('zooms the plan in and out, and fits it again', async () => {
    await renderOverview()
    fireEvent.click(screen.getByRole('button', { name: 'Building A' }))
    await waitFor(() => expect(pins().length).toBe(1))
    const inner = () => document.querySelector('.site-map-stage-inner')
    expect(inner().style.width).toBe('100%')
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(inner().style.width).toBe('150%')
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    expect(inner().style.width).toBe('125%')
    fireEvent.click(screen.getByRole('button', { name: 'Fit' }))
    expect(inner().style.width).toBe('100%')
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeDisabled()
  })

  it('opens a pin into the details panel, naming where the cell is and what it holds', async () => {
    await renderOverview()
    fireEvent.click(screen.getByRole('button', { name: 'Building A' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Bay 1' }))
    const panel = document.querySelector('.context-panel')
    expect(within(panel).getByText('Bay 1')).toBeInTheDocument()
    expect(within(panel).getByText('Building A · Ground floor')).toBeInTheDocument()
    expect(within(panel).getByText('30% across, 40% down')).toBeInTheDocument()
    expect(within(panel).getByText('Line_Gateway')).toBeInTheDocument()
    expect(within(panel).getByText('CNC_01')).toBeInTheDocument()
    expect(within(panel).getByText('Five-axis machining, two shifts')).toBeInTheDocument()
    // A second click on the same pin closes it.
    fireEvent.click(screen.getByRole('button', { name: 'Bay 1' }))
    await waitFor(() => expect(document.querySelector('.context-panel-open')).toBeNull())
  })

  it('keeps the tray under the floor rail, and the plan sized from the room the page measured', async () => {
    await renderOverview()
    fireEvent.click(screen.getByRole('button', { name: 'Building A' }))
    await waitFor(() => expect(pins().length).toBe(1))
    const side = document.querySelector('.site-map-side')
    // The way back and the zoom sit above the rail, the tray below it.
    expect(within(side).getByRole('button', { name: 'All areas' })).toBeInTheDocument()
    expect(within(side).getByRole('group', { name: 'Zoom' })).toBeInTheDocument()
    expect(follows(within(side).getByRole('group', { name: 'Zoom' }), within(side).getByRole('group', { name: 'Floor' }))).toBe(true)
    expect(within(side).getByRole('group', { name: 'Floor' })).toBeInTheDocument()
    expect(side.querySelector('[data-tray="area-wide"]')).toBeTruthy()
    const stage = document.querySelector('.site-map-stage')
    expect(follows(side, stage)).toBe(true)
    // jsdom lays nothing out: every rect is at 0, so the room is the whole 768px window.
    expect(stage.style.getPropertyValue('--map-fit-height')).toBe('768px')
    expect(stage.style.getPropertyValue('--plan-aspect')).toBe(String(4 / 3))
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(stage.style.getPropertyValue('--map-zoom')).toBe('1.25')
  })

  it('steps a thumbnail through its floors without opening the area, and opens on the floor shown', async () => {
    await renderOverview()
    const stepper = () => within(thumbs()[0]).getByRole('group', { name: 'Floor of Building A' })
    // One button per floor, the lowest leftmost, the ground floor pressed to start.
    const floorButtons = () => within(stepper()).getAllByRole('button').filter(b => /floor|basement/i.test(b.textContent))
    expect(floorButtons().map(b => b.textContent.trim())).toEqual(['-1 Deep basement', '0 Ground floor', '1 Floor 1'])
    expect(within(stepper()).getByRole('button', { name: /Ground floor/ })).toHaveAttribute('aria-pressed', 'true')
    expect(within(stepper()).getByRole('button', { name: 'Floor above' })).not.toBeDisabled()
    fireEvent.click(within(stepper()).getByRole('button', { name: 'Floor above' }))
    // Still the thumbnails: the click was the selector's, not the thumbnail's.
    expect(thumbs()).toHaveLength(2)
    expect(within(stepper()).getByRole('button', { name: /^1 Floor 1/ })).toHaveAttribute('aria-pressed', 'true')
    expect(within(stepper()).getByRole('button', { name: 'Floor above' })).toBeDisabled()
    expect(within(thumbs()[0]).queryByRole('button', { name: 'Bay 1' })).toBeNull()
    // The strip is clipped, not scrollable, and the page slides the track to centre the pressed
    // floor; jsdom measures nothing, so the slide is zero, but it is the page that set it.
    const strip = stepper().querySelector('.area-thumb-floors-scroll')
    expect(strip.querySelector('.area-thumb-floors-track').style.transform).toBe('translateX(0px)')
    // A floor's own button goes straight there.
    fireEvent.click(within(stepper()).getByRole('button', { name: /Deep basement/ }))
    expect(within(stepper()).getByRole('button', { name: /Deep basement/ })).toHaveAttribute('aria-pressed', 'true')
    expect(within(stepper()).getByRole('button', { name: 'Floor below' })).toBeDisabled()
    fireEvent.click(within(stepper()).getByRole('button', { name: 'Floor above' }))
    fireEvent.click(within(stepper()).getByRole('button', { name: 'Floor above' }))
    // Building B has one floor, so neither arrow does anything there.
    const other = within(thumbs()[1]).getByRole('group', { name: 'Floor of Building B' })
    expect(within(other).getByRole('button', { name: 'Floor above' })).toBeDisabled()
    expect(within(other).getByRole('button', { name: 'Floor below' })).toBeDisabled()
    // Opening the area lands on the floor the thumbnail was showing.
    fireEvent.click(within(thumbs()[0]).getByText('Building A'))
    await waitFor(() => expect(within(hierarchy()).getByText('Building A')).toBeInTheDocument())
    expect(shownFloor()).toMatch(/Floor 1/)
  })

  it('returns to every area with All areas', async () => {
    await renderOverview()
    fireEvent.click(screen.getByRole('button', { name: 'Building B' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'All areas' })).toBeInTheDocument())
    expect(thumbs()).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'All areas' }))
    await waitFor(() => expect(thumbs()).toHaveLength(2))
  })

  it('offers no area selector and says what to do on a plant with no areas', async () => {
    api.get.mockImplementation(routeGet({ areas: [], devices: [device] }))
    render(<OverviewTab showToast={vi.fn()} hasPermission={() => true} onSelectCell={vi.fn()} onNavigateTab={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/No areas yet/)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'All areas' })).toBeNull()
    expect(thumbs()).toHaveLength(0)
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

  it('deletes an area only once its name has been typed', async () => {
    api.delete.mockResolvedValue(true)
    await renderAreas()
    fireEvent.click(screen.getByText('Building B'))
    fireEvent.click(screen.getByRole('button', { name: /Delete Area/ }))
    const dialog = document.querySelector('.modal')
    expect(within(dialog).getByText(/Delete area 'Building B'\?/)).toBeInTheDocument()
    const confirm = within(dialog).getByRole('button', { name: 'Delete area' })
    expect(confirm).toBeDisabled()
    fireEvent.change(within(dialog).getByLabelText(/Type the area name to confirm/), { target: { value: 'Building B' } })
    expect(confirm).not.toBeDisabled()
    await act(async () => { fireEvent.click(confirm) })
    expect(api.delete).toHaveBeenCalledWith('/api/v1/areas/area-b')
  })

  it('counts each area\'s floors and how many carry a plan', async () => {
    await renderAreas()
    const rowA = rowFor('Building A')
    expect(within(rowA).getByText('3 floors')).toBeInTheDocument()
    expect(within(rowA).getByText('1 with a plan')).toBeInTheDocument()
    const rowB = rowFor('Building B')
    expect(within(rowB).getByText('1 floor')).toBeInTheDocument()
    expect(within(rowB).getByText('No plans uploaded')).toBeInTheDocument()
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

describe('AreasTab manages an area\'s floors from its panel', () => {
  const openArea = async (name = 'Building A') => {
    render(<AreasTab showToast={vi.fn()} hasPermission={() => true} onSelectCell={vi.fn()} onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(name)).toBeInTheDocument())
    fireEvent.click(screen.getByText(name))
    return document.querySelector('.context-panel')
  }

  const floorRows = () => [...document.querySelectorAll('.area-floor-row:not(.area-floor-row-form)')]

  it('lists the floors top-down with their cell counts and plan state', async () => {
    const panel = await openArea()
    expect(within(panel).getByText('Floors')).toBeInTheDocument()
    expect(floorRows().map(r => r.getAttribute('data-level'))).toEqual(['1', '0', '-1'])
    expect(within(floorRows()[0]).getByText(/1 cell · plan attached/)).toBeInTheDocument()
    expect(within(floorRows()[1]).getByText(/1 cell · default outline/)).toBeInTheDocument()
    expect(within(floorRows()[2]).getByText(/0 cells · default outline/)).toBeInTheDocument()
  })

  it('adds a floor above the top one with the next level and the level\'s name suggested', async () => {
    api.post.mockResolvedValue({})
    await openArea()
    fireEvent.click(screen.getByRole('button', { name: /Floor above/ }))
    const form = screen.getByRole('group', { name: 'New floor' })
    expect(within(form).getByLabelText('Level')).toHaveValue(2)
    expect(within(form).getByLabelText('Floor name')).toHaveValue('Floor 2')
    fireEvent.change(within(form).getByLabelText('Floor name'), { target: { value: 'Mezzanine' } })
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: /Add/ })) })
    expect(api.post).toHaveBeenCalledWith('/api/v1/floors', { area_id: 'area-a', level: '2', name: 'Mezzanine' })
  })

  it('adds a basement below the lowest one', async () => {
    api.post.mockResolvedValue({})
    await openArea('Building B')
    fireEvent.click(screen.getByRole('button', { name: /Basement/ }))
    const form = screen.getByRole('group', { name: 'New floor' })
    expect(within(form).getByLabelText('Level')).toHaveValue(-1)
    expect(within(form).getByLabelText('Floor name')).toHaveValue('Basement')
  })

  it('renames a floor with one write naming only what changed', async () => {
    await openArea()
    fireEvent.click(within(floorRows()[2]).getByTitle(/Rename this floor/))
    fireEvent.change(screen.getByLabelText('Floor name'), { target: { value: 'Plant room' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save/ })) })
    expect(api.put).toHaveBeenCalledWith('/api/v1/floors/floor-ab', { level: '-1', name: 'Plant room' })
  })

  it('says why a floor holding cells cannot be deleted, rather than ignoring the click', async () => {
    const showToast = vi.fn()
    render(<AreasTab showToast={showToast} hasPermission={() => true} onSelectCell={vi.fn()} onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Building A')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Building A'))
    const button = within(floorRows()[0]).getByTitle(/Move its cells to another floor first/)
    expect(button).not.toBeDisabled()
    fireEvent.click(button)
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/still holds 1 cell/), 'error')
    expect(document.querySelector('.modal')).toBeNull()
    expect(api.delete).not.toHaveBeenCalled()
  })

  it('deletes an empty floor once its name has been typed', async () => {
    api.delete.mockResolvedValue(true)
    await openArea()
    fireEvent.click(within(floorRows()[2]).getByTitle('Delete this floor'))
    const dialog = document.querySelector('.modal')
    expect(within(dialog).getByText(/Delete floor 'Deep basement' from Building A/)).toBeInTheDocument()
    const confirm = within(dialog).getByRole('button', { name: 'Delete floor' })
    expect(confirm).toBeDisabled()
    fireEvent.change(within(dialog).getByLabelText(/Type the floor name to confirm/), { target: { value: 'Deep basement' } })
    expect(confirm).not.toBeDisabled()
    await act(async () => { fireEvent.click(confirm) })
    expect(api.delete).toHaveBeenCalledWith('/api/v1/floors/floor-ab')
  })

  it('uploads a plan for a floor and offers to replace or remove one that is there', async () => {
    api.uploadFloorPlan.mockResolvedValue({})
    await openArea()
    expect(within(floorRows()[0]).getByRole('button', { name: /Replace plan/ })).toBeInTheDocument()
    expect(within(floorRows()[0]).getByRole('button', { name: /Remove plan/ })).toBeInTheDocument()
    expect(within(floorRows()[1]).getByRole('button', { name: /Upload plan/ })).toBeInTheDocument()

    const file = new File(['<svg viewBox="0 0 4 3"/>'], 'ground.svg', { type: 'image/svg+xml' })
    const input = within(floorRows()[1]).getByLabelText('Plan file for Ground floor')
    await act(async () => { fireEvent.change(input, { target: { files: [file] } }) })
    expect(api.uploadFloorPlan).toHaveBeenCalledTimes(1)
    expect(api.uploadFloorPlan.mock.calls[0][0]).toMatchObject({ floor_id: 'floor-a0' })
    expect(api.uploadFloorPlan.mock.calls[0][1]).toBe(file)
  })

  it('refuses a file that is not an SVG before anything is uploaded', async () => {
    const showToast = vi.fn()
    render(<AreasTab showToast={showToast} hasPermission={() => true} onSelectCell={vi.fn()} onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Building A')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Building A'))
    const file = new File(['png'], 'ground.png', { type: 'image/png' })
    const input = within(floorRows()[1]).getByLabelText('Plan file for Ground floor')
    await act(async () => { fireEvent.change(input, { target: { files: [file] } }) })
    expect(api.uploadFloorPlan).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/not an SVG/), 'error')
  })

  it('shows the floors read-only to somebody who may not manage cells', async () => {
    render(<AreasTab showToast={vi.fn()} hasPermission={() => false} onSelectCell={vi.fn()} onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Building A')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Building A'))
    expect(floorRows()).toHaveLength(3)
    expect(screen.queryByRole('button', { name: /Floor above/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Upload plan/ })).toBeNull()
  })
})
