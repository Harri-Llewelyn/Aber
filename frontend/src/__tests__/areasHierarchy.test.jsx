/**
 * The ISA-95 rung above the cells: the Areas page files cells into areas and carries each area's
 * plan, and the Site Map draws every area at once with its cells pinned on it. Both read the same
 * lists every other page reads.
 */
import React from 'react'
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AreasTab } from '../components/tabs/AreasTab'
import { SiteMapTab } from '../components/tabs/SiteMapTab'
import { api } from '../api'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    // The plan is downloaded through the authenticated client and handed to an <img>; without a
    // stub the download rejects and every plan reads as unavailable rather than as a drawing.
    loadAreaPlanUrl: vi.fn().mockResolvedValue('blob:plan-1'),
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), uploadAreaPlan: vi.fn(), removeAreaPlan: vi.fn() }
  }
})

const NOW = Date.parse('2026-09-11T12:00:00Z')

const areaA = { area_id: 'area-a', area_name: 'Building A', description: null, icon: 'Factory', cells: [], cell_count: 0, plan_path: 'area-a/plan-1.svg', plan_aspect: 1.5 }
const areaB = { area_id: 'area-b', area_name: 'Building B', description: 'The annexe', icon: 'Warehouse', cells: [], cell_count: 0, plan_path: null, plan_aspect: null }

const gateway = {
  gateway_id: 'gw-1', gateway_name: 'Line_Gateway', cell_id: 'cell-1', location_scope: 'cell', sparkplug_group: 'Aber',
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
  // Placed on A's plan.
  { cell_id: 'cell-1', cell_name: 'Bay 1', area_id: 'area-a', plan_x: 0.3, plan_y: 0.4, is_archived: false, description: 'Five-axis machining, two shifts', gateways: [gateway], gateway_count: 1 },
  // Also in A, and placed well clear of Bay 1: BOTH are pins, which is the point of the one view.
  { cell_id: 'cell-2', cell_name: 'Bay 2', area_id: 'area-a', plan_x: 0.8, plan_y: 0.8, is_archived: false, gateways: [], gateway_count: 0 },
  // In B, with no place on its plan.
  { cell_id: 'cell-3', cell_name: 'Paint Shop', area_id: 'area-b', plan_x: null, plan_y: null, is_archived: false, gateways: [], gateway_count: 0 },
  // In no area.
  { cell_id: 'cell-4', cell_name: 'Loose End', area_id: null, plan_x: null, plan_y: null, is_archived: false, gateways: [], gateway_count: 0 }
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

const areaCards = () => [...document.querySelectorAll('.shopfloor-grid > .area-card')]
const pins = () => [...document.querySelectorAll('.area-card .area-plan-pin')]
const pinNames = () => pins().map(p => p.getAttribute('aria-label'))
const lanes = () => [...document.querySelectorAll('.site-lanes > .site-lane')]
const panel = () => document.querySelector('.context-panel')
const follows = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
const grid = () => document.querySelector('.shopfloor-grid')

describe('SiteMapTab draws the areas on the Site Map', () => {
  const renderSiteMap = async () => {
    render(<SiteMapTab showToast={vi.fn()} hasPermission={() => true} onSelectCell={vi.fn()} onNavigateTab={vi.fn()} />)
    await waitFor(() => expect(areaCards().length).toBeGreaterThan(0))
  }

  it('names the enterprise and the site in the Site Map card, and says when the site is not set', async () => {
    await renderSiteMap()
    const hierarchy = screen.getByRole('group', { name: 'Hierarchy' })
    expect(within(hierarchy).getByText('Aber')).toBeInTheDocument()
    expect(within(hierarchy).getByText(/Not set — name it on the Settings page/)).toBeInTheDocument()
    // One card, the Site Map: the ladder, the lanes and the plans share it.
    const titles = [...document.querySelectorAll('.shopfloor-title')].map(t => t.textContent)
    expect(titles).toEqual([expect.stringMatching(/^Site Map/)])
    expect(screen.getByRole('button', { name: 'About the site map' })).toBeInTheDocument()
    expect(document.querySelectorAll('.shopfloor-map-card')).toHaveLength(1)
  })

  it('names the enterprise from the group the site was installed with, before any gateway enrols', async () => {
    // The group is named at install (ingestion.sparkplugGroup), so a fresh stack knows it; a
    // gateway enrolled under another group does not replace it.
    api.get.mockImplementation(routeGet({
      settings: [{ key: 'sparkplug.group_id', value: 'Broughton-Plant' }],
      gateways: [{ ...gateway, sparkplug_group: 'Elsewhere' }],
    }))
    await renderSiteMap()
    const hierarchy = screen.getByRole('group', { name: 'Hierarchy' })
    await waitFor(() => expect(within(hierarchy).getByText('Broughton-Plant')).toBeInTheDocument())
    expect(within(hierarchy).queryByText(/Elsewhere/)).toBeNull()
  })

  it('names the site once the setting holds a name', async () => {
    api.get.mockImplementation(routeGet({ settings: [{ key: 'site.name', value: 'Broughton' }] }))
    await renderSiteMap()
    const hierarchy = screen.getByRole('group', { name: 'Hierarchy' })
    await waitFor(() => expect(within(hierarchy).getByText('Broughton')).toBeInTheDocument())
    expect(within(hierarchy).queryByText(/Not set/)).toBeNull()
  })

  it('shows every area at once, with every placed cell pinned and the counts above it', async () => {
    await renderSiteMap()
    expect(areaCards().map(t => within(t).getByText(/Building/).textContent)).toEqual(['Building A', 'Building B'])
    // Cells, gateways and devices in the header; Area-Wide assets count, so Building A's BMS does,
    // and it is broken out in the same line rather than given one under the plan.
    expect(areaCards()[0].querySelector('.area-card-counts').textContent.trim()).toBe('2 Cells · 1 Gateway · 2 Devices · 1 Area-Wide')
    expect(areaCards()[1].querySelector('.area-card-counts').textContent.trim()).toBe('1 Cell · 0 Gateways · 0 Devices')
    // THE POINT OF THE ONE VIEW: both of Building A's cells are pinned, and the header's count
    // agrees with what is drawn. A floor selector used to show one of them at a time.
    expect(pinNames()).toEqual(['Bay 1', 'Bay 2'])
    expect(within(areaCards()[0]).getByRole('button', { name: 'Bay 1' }).querySelector('.area-plan-pin-label')).toHaveTextContent('Bay 1')
    // Nothing to enter and nothing to come back from.
    expect(screen.queryByRole('button', { name: 'All areas' })).toBeNull()
    expect(screen.queryByRole('group', { name: 'Zoom' })).toBeNull()
    expect(screen.queryByRole('group', { name: 'Floor' })).toBeNull()
    const unfiled = document.querySelector('[data-tray="unfiled"]')
    expect(within(unfiled).getByText('Loose End')).toBeInTheDocument()
  })

  /* The grid is the map, so it widens as the plant shrinks, and the pin grows with the tile: at
     the narrowest a pin is still above the 24px a pointer needs. */
  it('offers an area\'s description beside its name, and only where there is one', async () => {
    /* The description was readable only after clicking into the panel, so the map said what every
       area was CALLED and nothing about what it IS. Conditional: Building A has no description,
       and a "?" there would be a question mark that answers nothing. */
    await renderSiteMap()

    const withOne = areaCards()[1]
    const tip = within(withOne).getByRole('button', { name: 'About Building B' })
    expect(tip).toHaveClass('help-tip')

    // The bubble is portalled and shows on hover, so it is absent until the pointer arrives.
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.mouseEnter(tip)
    expect(screen.getByRole('tooltip')).toHaveTextContent('The annexe')

    // Building A has none, so it gets none.
    expect(within(areaCards()[0]).queryByRole('button', { name: /^About Building A$/ })).toBeNull()
  })

  it('sizes the grid and its pins from the number of areas', async () => {
    await renderSiteMap()
    expect(grid().style.getPropertyValue('--map-columns')).toBe('2')
    expect(grid().style.getPropertyValue('--pin-size')).toBe('36px')

    api.get.mockImplementation(routeGet({ areas: [areaA] }))
    render(<SiteMapTab showToast={vi.fn()} hasPermission={() => true} onSelectCell={vi.fn()} onNavigateTab={vi.fn()} />)
    await waitFor(() => expect(document.querySelectorAll('.shopfloor-grid').length).toBe(2))
    const single = [...document.querySelectorAll('.shopfloor-grid')][1]
    expect(single.style.getPropertyValue('--map-columns')).toBe('1')
    expect(single.style.getPropertyValue('--pin-size')).toBe('44px')
  })

  it('keeps the three campus lanes side by side in the Site Map card, each in its own hue, with no area selector', async () => {
    // Site-Wide, Simulated and Unassigned belong to no area. Area-Wide is not among them: it
    // belongs to an area and is listed beside that area's plan.
    await renderSiteMap()
    expect(lanes().map(l => l.textContent.replace(/\d+ Gateways?.*$/, '').trim())).toEqual(['Site-Wide', 'Simulated', 'Unassigned'])
    expect(lanes().map(l => l.className)).toEqual([
      expect.stringContaining('site-lane-site'),
      expect.stringContaining('site-lane-simulated'),
      expect.stringContaining('site-lane-queue')
    ])
    expect(within(document.querySelector('.site-lanes')).queryByText(/Area-Wide/)).toBeNull()
    // Every lane is empty on this fixture, so none draws a status dot.
    expect(lanes().every(l => !l.querySelector('.tile-dot'))).toBe(true)
    // The area cards are the way into an area: no selector, no arrows.
    expect(document.querySelector('.shopfloor-areas')).toBeNull()
    expect(screen.queryByRole('button', { name: /Next area|Previous area/ })).toBeNull()
    // No drag-and-drop: nothing on the page is draggable and nothing offers to rearrange.
    expect(document.querySelectorAll('[draggable="true"]')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /Rearrang/ })).toBeNull()
  })

  /**
   * A WIDE SCOPE IS AN ANSWER, NOT AN ABSENCE. Area-Wide and Site-Wide gateways both store no
   * `cell_id` -- the CHECK constraints require it -- so an Unassigned lane that asks only whether a
   * cell is set claims a filed gateway is unfiled, and lists it in the queue as well as under its
   * own area. The queue is a work list, so a row nobody can clear is the whole cost.
   */
  it('files an Area-Wide gateway under its area and keeps it out of the Unassigned queue', async () => {
    const areaWideGw = {
      gateway_id: 'gw-aw', gateway_name: 'Test_Remote', cell_id: null, area_id: 'area-a',
      location_scope: 'area_wide', sparkplug_group: 'Aber', status: 'ONLINE',
      deployment: 'remote', is_archived: false, last_heartbeat: new Date(NOW - 20_000).toISOString(),
      device_count: 0, devices: []
    }
    api.get.mockImplementation(routeGet({ gateways: [areaWideGw], cells: [], devices: [] }))
    await renderSiteMap()
    const unassigned = lanes()[2]
    expect(unassigned.textContent).toContain('Unassigned')
    expect(unassigned.querySelector('.site-lane-counts').textContent.trim()).toBe('0 Gateways · 0 Devices')
    // Counted once, under the area that owns it, and named as the area's own rather than a cell's.
    expect(areaCards()[0].querySelector('.area-card-counts').textContent.trim())
      .toBe('0 Cells · 1 Gateway · 0 Devices · 1 Area-Wide')
  })

  it('still queues a gateway that is scoped to a cell and has none', async () => {
    const looseGw = {
      gateway_id: 'gw-loose', gateway_name: 'Loose_Gateway', cell_id: null, area_id: null,
      location_scope: 'cell', sparkplug_group: 'Aber', status: 'ONLINE', deployment: 'remote',
      is_archived: false, last_heartbeat: new Date(NOW - 20_000).toISOString(), device_count: 0, devices: []
    }
    api.get.mockImplementation(routeGet({ gateways: [looseGw], cells: [], devices: [] }))
    await renderSiteMap()
    expect(lanes()[2].querySelector('.site-lane-counts').textContent.trim()).toBe('1 Gateway · 0 Devices')
  })

  it('opens a lane into the details panel listing its assets, one lane at a time', async () => {
    api.get.mockImplementation(routeGet({ devices: [device, bms, { ...device, asset_id: 'dev-2', asset_name: 'Loose_Device', effective_cell_id: null, gateway_cell_id: null, location_source: 'unassigned', effective_area_id: null }] }))
    await renderSiteMap()
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

  /* An action with nothing to act on is a dead end wearing the clothes of a next step. The cell
     panel already gates Open Dashboard on the cell having one; the lane panel was the outlier. */
  /* An empty Unassigned queue is the good state. Amber over 0 · 0 is a standing false alarm, so a
     lane wears its hue only while it holds something. */
  it('mutes a lane that holds nothing and fills one that does', async () => {
    const siteWideDevice = {
      ...device, asset_id: 'dev-sw', asset_name: 'Weather_Station', effective_cell_id: null,
      gateway_cell_id: null, location_source: 'site_wide', effective_area_id: null
    }
    api.get.mockImplementation(routeGet({ devices: [siteWideDevice], gateways: [] }))
    await renderSiteMap()
    const [siteWide, simulated, unassigned] = lanes()
    expect(siteWide).not.toHaveClass('is-empty')
    expect(siteWide.querySelector('.tile-dot')).not.toBeNull()
    expect(simulated).toHaveClass('is-empty')
    expect(unassigned).toHaveClass('is-empty')
    // No dot either: grey beside a zero says nothing twice.
    expect(unassigned.querySelector('.tile-dot')).toBeNull()
  })

  it('offers a lane only the actions it can honour', async () => {
    const looseDevice = {
      ...device, asset_id: 'dev-loose', asset_name: 'Loose_Device', effective_cell_id: null,
      gateway_cell_id: null, location_source: 'unassigned', effective_area_id: null
    }
    const looseGw = {
      gateway_id: 'gw-loose', gateway_name: 'Loose_Gateway', cell_id: null, area_id: null,
      location_scope: 'cell', sparkplug_group: 'Aber', status: 'ONLINE', deployment: 'remote',
      is_archived: false, last_heartbeat: new Date(NOW - 20_000).toISOString(), device_count: 0, devices: []
    }
    api.get.mockImplementation(routeGet({ devices: [looseDevice], gateways: [gateway, looseGw] }))
    await renderSiteMap()

    // Devices but no gateways: only the Devices page is offered, and it says how many.
    fireEvent.click(screen.getByRole('button', { name: /Simulated/ }))
    expect(within(panel()).queryByRole('button', { name: /Open Devices page/ })).toBeNull()
    expect(within(panel()).queryByRole('button', { name: /Open Gateways page/ })).toBeNull()
    expect(within(panel()).getByText('No Simulated Assets.')).toBeInTheDocument()

    // The queue holds one of each, so both are offered.
    fireEvent.click(screen.getByRole('button', { name: /Unassigned/ }))
    expect(within(panel()).getByRole('button', { name: /Open Devices page/ })).toBeInTheDocument()
    expect(within(panel()).getByRole('button', { name: /Open Gateways page/ })).toBeInTheDocument()
    expect(within(panel()).getByTitle('File these 1 device(s) on the Devices page')).toBeInTheDocument()
  })

  it('offers the Devices page alone to a lane holding only devices', async () => {
    const siteWideDevice = {
      ...device, asset_id: 'dev-sw', asset_name: 'Weather_Station', effective_cell_id: null,
      gateway_cell_id: null, location_source: 'site_wide', effective_area_id: null
    }
    api.get.mockImplementation(routeGet({ devices: [siteWideDevice], gateways: [] }))
    await renderSiteMap()
    fireEvent.click(screen.getByRole('button', { name: /Site-Wide/ }))
    expect(within(panel()).getByText('Weather_Station')).toBeInTheDocument()
    expect(within(panel()).getByRole('button', { name: /Open Devices page/ })).toBeInTheDocument()
    expect(within(panel()).queryByRole('button', { name: /Open Gateways page/ })).toBeNull()
  })

  it('gives the panel to whichever of a lane, an area or a pin was clicked last', async () => {
    await renderSiteMap()
    fireEvent.click(await screen.findByRole('button', { name: 'Bay 1' }))
    expect(within(panel()).getByText('Five-axis machining, two shifts')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Building A/ }))
    expect(within(panel()).queryByText('Five-axis machining, two shifts')).toBeNull()
    expect(within(panel()).getByText(/An SVG plan is uploaded/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Bay 1' })).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(screen.getByRole('button', { name: /Simulated/ }))
    expect(within(panel()).queryByText(/An SVG plan is uploaded/)).toBeNull()
    expect(within(panel()).getByText('Simulated')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Building A/ })).toHaveAttribute('aria-pressed', 'false')
  })

  it('opens an area from its name, listing what its plan cannot show', async () => {
    await renderSiteMap()
    fireEvent.click(within(areaCards()[0]).getByRole('button', { name: 'Building A' }))
    expect(within(panel()).getByText('2 Cells · 2 Devices')).toBeInTheDocument()
    // Area-Wide has no place on any plan, so the panel is where it lives.
    expect(within(panel()).getByText('BMS_A')).toBeInTheDocument()
    // Everything in A is placed, so nothing is listed as unplaced.
    expect(within(panel()).queryByText(/Not placed \(/)).toBeNull()

    // B's cell has no place, so it is named rather than lost.
    fireEvent.click(within(areaCards()[1]).getByRole('button', { name: 'Building B' }))
    expect(within(panel()).getByText('Not placed (1)')).toBeInTheDocument()
    expect(within(panel()).getByText('Paint Shop')).toBeInTheDocument()
    expect(within(panel()).getByText(/No plan uploaded/)).toBeInTheDocument()
    expect(within(panel()).getByText('The annexe')).toBeInTheDocument()
  })

  /* The name is a control, but nobody aims for it: the plan is the biggest thing on the card and
     the cursor already says pointer, so the card takes the click as well. */
  it('opens the area from the card itself, and leaves a pin to its own cell', async () => {
    await renderSiteMap()
    fireEvent.click(areaCards()[0].querySelector('.area-plan'))
    expect(within(panel()).getByText('2 Cells · 2 Devices')).toBeInTheDocument()

    // A pin stops its own click, so the cell wins over the area behind it.
    fireEvent.click(within(areaCards()[0]).getByRole('button', { name: 'Bay 1' }))
    expect(within(panel()).queryByText('2 Cells · 2 Devices')).toBeNull()
    expect(within(panel()).getByText('Five-axis machining, two shifts')).toBeInTheDocument()

    // And the name still closes what it opened, rather than the card reopening it behind.
    const name = within(areaCards()[0]).getByRole('button', { name: 'Building A' })
    fireEvent.click(name)
    expect(name).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(name)
    expect(name).toHaveAttribute('aria-pressed', 'false')
  })

  /* The line under a card carries one thing only -- a cell the plan does not draw -- so its
     absence means there is nothing outstanding. An Area-Wide asset is a count, not a job, and
     rides in the header with the others. */
  it('spends a line under the card on unplaced cells alone, and none when there are none', async () => {
    await renderSiteMap()
    expect(within(areaCards()[0]).getByText(/1 Area-Wide/)).toBeInTheDocument()
    expect(areaCards()[0].querySelector('.area-card-aside')).toBeNull()
    expect(within(areaCards()[1]).getByText('1 cell not placed')).toBeInTheDocument()

    api.get.mockImplementation(routeGet({ cells: [cells[0]], devices: [device] }))
    render(<SiteMapTab showToast={vi.fn()} hasPermission={() => true} onSelectCell={vi.fn()} onNavigateTab={vi.fn()} />)
    await waitFor(() => expect(document.querySelectorAll('.shopfloor-grid').length).toBe(2))
    const clean = [...document.querySelectorAll('.shopfloor-grid')][1].querySelector('.area-card')
    expect(clean.querySelector('.area-card-aside')).toBeNull()
  })

  it('keeps drawing an archived area, muted, with its plan and its pins', async () => {
    /* Archiving moves nothing beneath the area: its cells stay filed in it and its topics keep its
       name, so a card that vanished would misplace what is still under it. The dot gives way to
       the archive glyph, the way an archived cell's pin does. */
    api.get.mockImplementation(routeGet({ areas: [{ ...areaA, is_archived: true, archived_at: '2026-09-01T00:00:00Z' }, areaB] }))
    await renderSiteMap()
    const card = screen.getByRole('button', { name: 'Building A' }).closest('.area-card')
    expect(card).toHaveClass('area-card-archived')
    expect(within(card).getByText('ARCHIVED')).toBeInTheDocument()
    expect(card.querySelector('.area-card-header .tile-dot')).toBeNull()
    expect(screen.getByRole('button', { name: 'Building A' })).toHaveAttribute('title', expect.stringMatching(/archived/))
    expect(pinNames()).toEqual(expect.arrayContaining(['Bay 1', 'Bay 2']))
    // The one beside it is untouched.
    expect(screen.getByRole('button', { name: 'Building B' }).closest('.area-card')).not.toHaveClass('area-card-archived')
  })

  it('draws the uploaded plan where there is one, and the default outline where there is not', async () => {
    await renderSiteMap()
    expect(areaCards()[0].querySelector('.area-plan').getAttribute('data-plan')).toBe('uploaded')
    expect(areaCards()[1].querySelector('.area-plan').getAttribute('data-plan')).toBe('outline')
  })

  it('opens a pin into the details panel, naming where the cell is and what it holds', async () => {
    await renderSiteMap()
    fireEvent.click(await screen.findByRole('button', { name: 'Bay 1' }))
    const panel = document.querySelector('.context-panel')
    expect(within(panel).getByText('Bay 1')).toBeInTheDocument()
    expect(within(panel).getByText('Building A')).toBeInTheDocument()
    expect(within(panel).getByText('30% across, 40% down')).toBeInTheDocument()
    expect(within(panel).getByText('Line_Gateway')).toBeInTheDocument()
    expect(within(panel).getByText('CNC_01')).toBeInTheDocument()
    expect(within(panel).getByText('Five-axis machining, two shifts')).toBeInTheDocument()
    // A second click on the same pin closes it.
    fireEvent.click(screen.getByRole('button', { name: 'Bay 1' }))
    await waitFor(() => expect(document.querySelector('.context-panel-open')).toBeNull())
  })

  it('offers no area selector and says what to do on a plant with no areas', async () => {
    api.get.mockImplementation(routeGet({ areas: [], devices: [device] }))
    render(<SiteMapTab showToast={vi.fn()} hasPermission={() => true} onSelectCell={vi.fn()} onNavigateTab={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/No areas yet/)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'All areas' })).toBeNull()
    expect(areaCards()).toHaveLength(0)
    expect(document.querySelector('.shopfloor-grid')).toBeNull()
  })
})

describe('AreasTab files cells into areas', () => {
  const renderAreas = async (props = {}) => {
    render(<AreasTab showToast={vi.fn()} hasPermission={() => true} onSelectCell={vi.fn()} onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} {...props} />)
    await waitFor(() => expect(screen.getByText('Building A')).toBeInTheDocument())
  }

  const rowFor = (name) => screen.getByText(name).closest('tr')

  it('lists the unfiled cells in a banner above the card, and each area\'s cells beside it', async () => {
    await renderAreas()
    const banner = screen.getByText(/1 unfiled cell/).parentElement
    // Above the card, as the Cells and Gateways pages report their unfinished business.
    expect(banner.closest('.card')).toBeNull()
    expect(follows(banner, document.querySelector('.card'))).toBe(true)
    expect(screen.getByText('Loose End')).toBeInTheDocument()
    const rowA = rowFor('Building A')
    expect(within(rowA).getByText('Bay 1')).toBeInTheDocument()
    expect(within(rowA).getByText('Bay 2')).toBeInTheDocument()
    expect(within(rowFor('Building B')).getByText('Paint Shop')).toBeInTheDocument()
  })

  it('attaches links to an area, the way every other asset carries them', async () => {
    /* `links.entity_type` is free text with no CHECK, and the links policies gate on the role
       rather than on the kind of thing, so an area needed no migration to hold them -- only the
       way in. The modal is the same one Cells, Gateways and Devices open. */
    await renderAreas()
    fireEvent.click(screen.getByText('Building A'))

    fireEvent.click(screen.getByRole('button', { name: /Attached Links/ }))

    const modal = document.querySelector('.modal')
    expect(within(modal).getByText(/^Attached Links —/)).toBeInTheDocument()
    expect(within(modal).getByText('Building A')).toBeInTheDocument()

    // The singular noun, and the area's own id: what the modal reads back with.
    expect(api.get).toHaveBeenCalledWith(
      expect.stringContaining('entity_type=area')
    )
  })

  /* An area archives the way a cell does: the same dialog, the same timer, and the row leaves the
     table for the Archived Entities page, which is the only place it can be deleted from. */
  it('archives an area through the shared dialog rather than deleting it from here', async () => {
    api.post.mockResolvedValue({})
    await renderAreas()
    fireEvent.click(screen.getByText('Building B'))
    expect(screen.queryByRole('button', { name: /Delete Area/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Archive Area/ }))
    const dialog = document.querySelector('.modal')
    expect(within(dialog).getByText('Building B')).toBeInTheDocument()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: /Archive & Set Timer/ })) })
    expect(api.post).toHaveBeenCalledWith('/api/v1/areas/area-b/archive', { auto_delete_days: 30 })
    expect(api.delete).not.toHaveBeenCalled()
  })

  it('hides an archived area behind the lifecycle filter, and offers Restore on it', async () => {
    api.post.mockResolvedValue({})
    api.get.mockImplementation(routeGet({ areas: [areaA, { ...areaB, is_archived: true, archived_at: '2026-09-01T00:00:00Z' }] }))
    await renderAreas()
    // Active by default, as the Cells page filters: an archived area is not a place to file into.
    expect(screen.queryByText('Building B')).toBeNull()
    fireEvent.change(screen.getByTitle('Filter by lifecycle state'), { target: { value: 'archived' } })
    const row = rowFor('Building B')
    expect(within(row).getByText('ARCHIVED')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Building B'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Restore Area/ })) })
    expect(api.post).toHaveBeenCalledWith('/api/v1/areas/area-b/restore', {})
  })

  it('says whether an area carries a plan, and how many of its cells sit on it', async () => {
    await renderAreas()
    const rowA = rowFor('Building A')
    expect(within(rowA).getByText('Plan')).toBeInTheDocument()
    expect(within(rowA).getByText('2 cells placed')).toBeInTheDocument()
    const rowB = rowFor('Building B')
    expect(within(rowB).getByText('Outline')).toBeInTheDocument()
    expect(within(rowB).getByText('No cells placed')).toBeInTheDocument()
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

describe('AreasTab manages an area\'s plan from its panel', () => {
  const openArea = async (name = 'Building A') => {
    render(<AreasTab showToast={vi.fn()} hasPermission={() => true} onSelectCell={vi.fn()} onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(name)).toBeInTheDocument())
    fireEvent.click(screen.getByText(name))
    return document.querySelector('.context-panel')
  }

  const planRow = () => document.querySelector('.area-plan-panel-row')

  it('says whether a plan is attached and how many cells are placed on it', async () => {
    const panel = await openArea()
    expect(within(panel).getByText('Area plan')).toBeInTheDocument()
    expect(planRow().getAttribute('data-plan')).toBe('uploaded')
    expect(within(planRow()).getByText('Plan attached')).toBeInTheDocument()
    expect(within(planRow()).getByText('2 cells placed on it')).toBeInTheDocument()
  })

  it('offers a drop zone on an area with no plan, and Replace and Remove on one with', async () => {
    await openArea('Building B')
    expect(planRow().getAttribute('data-plan')).toBe('outline')
    expect(screen.getByRole('button', { name: 'Upload plan for Building B' })).toBe(planRow())
    expect(within(planRow()).getByText(/Drop an SVG plan here/)).toBeInTheDocument()
    expect(within(planRow()).getByText(/Default outline · 0 cells placed on it/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Remove plan/ })).toBeNull()

    document.body.innerHTML = ''
    await openArea('Building A')
    expect(within(planRow()).getByRole('button', { name: /Replace plan/ })).toBeInTheDocument()
    expect(within(planRow()).getByRole('button', { name: /Remove plan/ })).toBeInTheDocument()
  })

  it('takes a plan dropped onto the zone, not only one browsed for', async () => {
    api.uploadAreaPlan.mockResolvedValue({})
    await openArea('Building B')
    const file = new File(['<svg viewBox="0 0 4 3"/>'], 'annexe.svg', { type: 'image/svg+xml' })
    await act(async () => { fireEvent.drop(planRow(), { dataTransfer: { files: [file] } }) })
    expect(api.uploadAreaPlan).toHaveBeenCalledTimes(1)
    expect(api.uploadAreaPlan.mock.calls[0][1]).toBe(file)
  })

  it('uploads a plan against the area itself', async () => {
    api.uploadAreaPlan.mockResolvedValue({})
    await openArea('Building B')
    const file = new File(['<svg viewBox="0 0 4 3"/>'], 'annexe.svg', { type: 'image/svg+xml' })
    const input = within(planRow()).getByLabelText('Plan file for Building B')
    await act(async () => { fireEvent.change(input, { target: { files: [file] } }) })
    expect(api.uploadAreaPlan).toHaveBeenCalledTimes(1)
    expect(api.uploadAreaPlan.mock.calls[0][0]).toMatchObject({ area_id: 'area-b' })
    expect(api.uploadAreaPlan.mock.calls[0][1]).toBe(file)
  })

  it('removes a plan once the dialog is confirmed', async () => {
    api.removeAreaPlan.mockResolvedValue({})
    await openArea()
    fireEvent.click(within(planRow()).getByRole('button', { name: /Remove plan/ }))
    const dialog = document.querySelector('.modal')
    expect(within(dialog).getByText(/Remove the plan from Building A\?/)).toBeInTheDocument()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Remove plan' })) })
    expect(api.removeAreaPlan).toHaveBeenCalledWith(expect.objectContaining({ area_id: 'area-a' }))
  })

  it('refuses a file that is not an SVG before anything is uploaded', async () => {
    const showToast = vi.fn()
    render(<AreasTab showToast={showToast} hasPermission={() => true} onSelectCell={vi.fn()} onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Building A')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Building A'))
    const file = new File(['png'], 'plan.png', { type: 'image/png' })
    const input = within(planRow()).getByLabelText('Plan file for Building A')
    await act(async () => { fireEvent.change(input, { target: { files: [file] } }) })
    expect(api.uploadAreaPlan).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/not an SVG/), 'error')
  })

  it('shows the plan read-only to somebody who may not manage cells', async () => {
    render(<AreasTab showToast={vi.fn()} hasPermission={() => false} onSelectCell={vi.fn()} onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Building A')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Building A'))
    expect(within(planRow()).getByText('Plan attached')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Upload plan|Replace plan|Remove plan/ })).toBeNull()
  })

  it('clears its filter with the control the other asset pages carry', async () => {
    /* Wording, icon and count, asserted together: this page said "Clear" with no count while
       Cells, Gateways, Devices and Schemas said "Clear filters (n)", and a control that is the
       same control on five pages should not be read as a different one on the sixth. */
    render(<AreasTab showToast={vi.fn()} hasPermission={() => true} onSelectCell={vi.fn()} onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Building A')).toBeInTheDocument())
    const searchBox = screen.getByPlaceholderText(/Search by area ID or name/)

    // Nothing to clear on arrival, so nothing is offered.
    expect(screen.queryByTitle('Clear every filter')).toBeNull()

    fireEvent.change(searchBox, { target: { value: 'Building A' } })
    expect(screen.getByTitle('Clear every filter')).toHaveTextContent('Clear filters (1)')

    fireEvent.click(screen.getByTitle('Clear every filter'))
    expect(searchBox).toHaveValue('')
    expect(screen.queryByTitle('Clear every filter')).toBeNull()
  })

  it('counts the lifecycle select and resets it to Active', async () => {
    render(<AreasTab showToast={vi.fn()} hasPermission={() => true} onSelectCell={vi.fn()} onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Building A')).toBeInTheDocument())
    const lifecycle = screen.getByTitle('Filter by lifecycle state')
    expect(lifecycle).toHaveValue('active')

    fireEvent.change(lifecycle, { target: { value: 'archived' } })
    expect(screen.getByTitle('Clear every filter')).toHaveTextContent('Clear filters (1)')

    fireEvent.change(screen.getByPlaceholderText(/Search by area ID or name/), { target: { value: 'x' } })
    expect(screen.getByTitle('Clear every filter')).toHaveTextContent('Clear filters (2)')

    fireEvent.click(screen.getByTitle('Clear every filter'))
    expect(lifecycle).toHaveValue('active')
    expect(screen.queryByTitle('Clear every filter')).toBeNull()
  })
})
