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
import { expectCardHeading } from '../test/cardHeading'

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

const areaA = { area_id: 'area-a', area_name: 'North Shop', description: null, icon: 'Factory', cells: [], cell_count: 0, plan_path: 'area-a/plan-1.svg', plan_aspect: 1.5 }
const areaB = { area_id: 'area-b', area_name: 'Press Hall', description: 'The annexe', icon: 'Warehouse', cells: [], cell_count: 0, plan_path: null, plan_aspect: null }

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
    // One card, the Site Map: the ladder, the lanes and the plans share it, under a real heading.
    const cards = [...document.querySelectorAll('.card')]
    expect(cards).toHaveLength(1)
    expect(within(cards[0]).getByRole('heading', { name: /^Site Map/ })).toHaveClass('section-title')
    const header = expectCardHeading('Site Map', /plan/)
    expect(cards[0].querySelector(':scope > .card-header')).toBe(header)
    expect(header.querySelector('.shopfloor-legend')).toHaveTextContent('Alert firing')
    expect(cards[0].querySelector(':scope > .card-body')).toContainElement(hierarchy)
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
    expect(areaCards().map(t => within(t).getByText(/North Shop|Press Hall/).textContent)).toEqual(['North Shop', 'Press Hall'])
    // Cells, gateways and devices in the header; Area-Wide assets count, so North Shop's BMS does,
    // and it is broken out in the same line.
    expect(areaCards()[0].querySelector('.area-card-counts').textContent.trim()).toBe('2 Cells · 1 Gateway · 2 Devices · 1 Area-Wide')
    expect(areaCards()[1].querySelector('.area-card-counts').textContent.trim()).toBe('1 Cell · 0 Gateways · 0 Devices')
    // Both of North Shop's cells are pinned, and the header's count agrees with what is drawn.
    expect(pinNames()).toEqual(['Bay 1', 'Bay 2'])
    expect(within(areaCards()[0]).getByRole('button', { name: 'Bay 1' }).querySelector('.area-plan-pin-label')).toHaveTextContent('Bay 1')
    // Nothing to enter and nothing to come back from.
    expect(screen.queryByRole('button', { name: 'All areas' })).toBeNull()
    expect(screen.queryByRole('group', { name: 'Zoom' })).toBeNull()
    const unfiled = document.querySelector('[data-tray="unfiled"]')
    expect(within(unfiled).getByText('Loose End')).toBeInTheDocument()
  })

  it('offers an area\'s description beside its name, and only where there is one', async () => {
    await renderSiteMap()

    const withOne = areaCards()[1]
    const tip = within(withOne).getByRole('button', { name: 'About Press Hall' })
    expect(tip).toHaveClass('help-tip')

    // The bubble is portalled and shows on hover, so it is absent until the pointer arrives.
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.mouseEnter(tip)
    expect(screen.getByRole('tooltip')).toHaveTextContent('The annexe')

    // North Shop has no description, so it gets no tip.
    expect(within(areaCards()[0]).queryByRole('button', { name: /^About North Shop$/ })).toBeNull()
  })

  /* The grid widens as the plant shrinks, and the pin grows with the tile: at the narrowest a pin
     is still above the 24px a pointer needs. */
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

  it('keeps the three site lanes side by side in the Site Map card, each in its own hue, with no area selector', async () => {
    // Site-Wide, Simulated and Unassigned belong to no area. Area-Wide is not among them: it
    // belongs to an area and is counted on that area's card.
    await renderSiteMap()
    // Named for the ISA-95 level they sit under; "campus" only glosses it.
    expect(screen.getByRole('group', { name: 'Site lanes' })).toBe(document.querySelector('.site-lanes'))
    expect(lanes().map(l => l.textContent.replace(/\d+ Gateways?.*$/, '').trim())).toEqual(['Site-Wide', 'Simulated', 'Unassigned'])
    expect(lanes().map(l => l.className)).toEqual([
      expect.stringContaining('site-lane-site'),
      expect.stringContaining('site-lane-simulated'),
      expect.stringContaining('site-lane-queue')
    ])
    expect(within(document.querySelector('.site-lanes')).queryByText(/Area-Wide/)).toBeNull()
    // Every lane is empty on this fixture, so none draws a status dot.
    expect(lanes().every(l => !l.querySelector('.tile-dot'))).toBe(true)
    // Each lane and each area card opens the panel, so each ends in a chevron, hidden from readers.
    expect(lanes().every(l => l.querySelector('.site-lane-chevron[aria-hidden="true"] svg'))).toBe(true)
    expect(areaCards().every(c => c.querySelector('.area-card-header > .area-card-chevron[aria-hidden="true"]'))).toBe(true)
    // The area cards are the way into an area: no selector, no arrows.
    expect(document.querySelector('.shopfloor-areas')).toBeNull()
    expect(screen.queryByRole('button', { name: /Next area|Previous area/ })).toBeNull()
    // No drag-and-drop: nothing on the page is draggable and nothing offers to rearrange.
    expect(document.querySelectorAll('[draggable="true"]')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /Rearrang/ })).toBeNull()
  })

  // Area-Wide and Site-Wide gateways store no cell_id, so the Unassigned lane must not count them.
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
    // A narrow card shows only the icon, so the button names the lane and its tally itself.
    expect(lanes()[2]).toHaveAttribute('aria-label', 'Unassigned: 1 gateway, 0 devices')
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

  // An action with nothing to act on is a dead end, so each is offered only while there is something.
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

    // The Simulated lane holds nothing, so neither page is offered.
    fireEvent.click(screen.getByRole('button', { name: /Simulated/ }))
    expect(within(panel()).queryByRole('button', { name: /Open Devices page/ })).toBeNull()
    expect(within(panel()).queryByRole('button', { name: /Open Gateways page/ })).toBeNull()
    expect(within(panel()).getByText('No simulated assets.')).toBeInTheDocument()

    // The queue holds one of each, so both are offered, the first as the one primary.
    fireEvent.click(screen.getByRole('button', { name: /Unassigned/ }))
    expect(within(panel()).getByRole('button', { name: /Open Devices page/ })).toHaveClass('btn-primary')
    expect(within(panel()).getByRole('button', { name: /Open Gateways page/ })).not.toHaveClass('btn-primary')
    // The panel's title carries the lane's own icon.
    expect(panel().querySelector('.context-panel-title-row .context-panel-icon svg')).toBeTruthy()
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
    const pinOnCard = (name) => within(areaCards()[0]).getByRole('button', { name })
    fireEvent.click(pinOnCard('Bay 1'))
    expect(within(panel()).getByText('Five-axis machining, two shifts')).toBeInTheDocument()

    fireEvent.click(within(areaCards()[0]).getByRole('button', { name: 'North Shop' }))
    expect(within(panel()).queryByText('Five-axis machining, two shifts')).toBeNull()
    expect(within(panel()).getByText('2 Cells · 1 Gateway · 2 Devices')).toBeInTheDocument()
    expect(pinOnCard('Bay 1')).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(screen.getByRole('button', { name: /Simulated/ }))
    expect(within(panel()).queryByText('2 Cells · 1 Gateway · 2 Devices')).toBeNull()
    expect(within(panel()).getByText('Simulated')).toBeInTheDocument()
    expect(within(areaCards()[0]).getByRole('button', { name: 'North Shop' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('opens an area from its name, listing its cells, gateways and devices as chips', async () => {
    await renderSiteMap()
    fireEvent.click(within(areaCards()[0]).getByRole('button', { name: 'North Shop' }))
    expect(within(panel()).getByText('2 Cells · 1 Gateway · 2 Devices')).toBeInTheDocument()
    // The plan is drawn beside the panel, so the panel does not describe it.
    expect(within(panel()).queryByText(/plan uploaded/i)).toBeNull()
    expect(within(panel()).getByRole('button', { name: /^Line_Gateway/ })).toBeInTheDocument()
    expect(within(panel()).getByRole('button', { name: /^CNC_01/ })).toBeInTheDocument()
    // Area-Wide has no place on any plan, so the panel is where it lives, flagged as the area's own.
    expect(within(panel()).getByRole('button', { name: /^BMS_A/ })).toHaveTextContent('AREA-WIDE')
    expect(within(panel()).getByRole('button', { name: /^CNC_01/ })).not.toHaveTextContent('AREA-WIDE')
    // Everything in A is placed, so no cell is flagged.
    expect(within(panel()).queryByText('NOT PLACED')).toBeNull()
    // The area's own icon on the title; its one primary is the page that edits it.
    expect(panel().querySelector('.context-panel-title-row .context-panel-icon svg')).toBeTruthy()
    expect(panel().querySelector('.context-panel-actions .btn-primary')).toHaveTextContent('Open on Areas page')

    // A cell chip opens that cell's panel.
    fireEvent.click(within(panel()).getByRole('button', { name: /^Bay 1/ }))
    expect(within(panel()).getByText('Five-axis machining, two shifts')).toBeInTheDocument()

    // B's cell has no place, so it is flagged rather than lost.
    fireEvent.click(within(areaCards()[1]).getByRole('button', { name: 'Press Hall' }))
    expect(within(panel()).getByRole('button', { name: /^Paint Shop/ })).toHaveTextContent('NOT PLACED')
    expect(within(panel()).getByText('The annexe')).toBeInTheDocument()
  })

  /* The name is a control, but nobody aims for it: the plan is the biggest thing on the card and
     the cursor already says pointer, so the card takes the click as well. */
  it('opens the area from the card itself, and leaves a pin to its own cell', async () => {
    await renderSiteMap()
    fireEvent.click(areaCards()[0].querySelector('.area-plan'))
    expect(within(panel()).getByText('2 Cells · 1 Gateway · 2 Devices')).toBeInTheDocument()

    // A pin stops its own click, so the cell wins over the area behind it.
    fireEvent.click(within(areaCards()[0]).getByRole('button', { name: 'Bay 1' }))
    expect(within(panel()).queryByText('2 Cells · 1 Gateway · 2 Devices')).toBeNull()
    expect(within(panel()).getByText('Five-axis machining, two shifts')).toBeInTheDocument()

    // And the name still closes what it opened, rather than the card reopening it behind.
    const name = within(areaCards()[0]).getByRole('button', { name: 'North Shop' })
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

  it('opens an area card from the keyboard, and leaves a key on a pin to the pin', async () => {
    await renderSiteMap()
    const card = areaCards()[0]
    expect(card).toHaveAttribute('tabindex', '0')
    fireEvent.keyDown(within(card).getByRole('button', { name: 'Bay 1' }), { key: 'Enter' })
    expect(document.querySelector('.context-panel-open')).toBeNull()
    fireEvent.keyDown(card, { key: 'Enter' })
    expect(within(panel()).getByText('2 Cells · 1 Gateway · 2 Devices')).toBeInTheDocument()
    fireEvent.keyDown(card, { key: ' ' })
    await waitFor(() => expect(document.querySelector('.context-panel-open')).toBeNull())
  })

  it('offers no archived toggle while no area is archived', async () => {
    await renderSiteMap()
    expect(screen.queryByRole('button', { name: /Show archived areas/ })).toBeNull()
  })

  it('leaves an archived cell off its live area\'s plan', async () => {
    api.get.mockImplementation(routeGet({ cells: [cells[0], { ...cells[1], is_archived: true }, cells[2], cells[3]] }))
    await renderSiteMap()
    expect(pinNames()).toEqual(['Bay 1'])
  })

  it('hides an archived area and its pins until asked, then draws it muted', async () => {
    api.get.mockImplementation(routeGet({ areas: [{ ...areaA, is_archived: true, archived_at: '2026-09-01T00:00:00Z' }, areaB] }))
    await renderSiteMap()
    expect(screen.queryByRole('button', { name: 'North Shop' })).toBeNull()
    expect(pinNames()).toEqual([])
    const toggle = screen.getByRole('button', { name: /Show archived areas \(1\)/ })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    // Says what is hidden with it: North Shop's two cells, CNC_01 in Bay 1 and its BMS.
    expect(toggle).toHaveAttribute('title', expect.stringMatching(/2 cells and 2 devices/))

    // Shown, the dot gives way to the archive glyph and the card is muted.
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    const card = screen.getByRole('button', { name: 'North Shop' }).closest('.area-card')
    expect(card).toHaveClass('area-card-archived')
    expect(within(card).getByText('ARCHIVED')).toBeInTheDocument()
    expect(card.querySelector('.area-card-header .tile-dot')).toBeNull()
    expect(screen.getByRole('button', { name: 'North Shop' })).toHaveAttribute('title', expect.stringMatching(/archived/))
    expect(pinNames()).toEqual(expect.arrayContaining(['Bay 1', 'Bay 2']))
    // The one beside it is untouched.
    expect(screen.getByRole('button', { name: 'Press Hall' }).closest('.area-card')).not.toHaveClass('area-card-archived')

    // Hidden again, its open panel closes with it.
    fireEvent.click(screen.getByRole('button', { name: 'North Shop' }))
    expect(document.querySelector('.context-panel-open')).toBeTruthy()
    fireEvent.click(toggle)
    await waitFor(() => expect(document.querySelector('.context-panel-open')).toBeNull())
  })

  it('says so when every area is archived', async () => {
    api.get.mockImplementation(routeGet({ areas: [{ ...areaA, is_archived: true }] }))
    render(<SiteMapTab showToast={vi.fn()} hasPermission={() => true} onSelectCell={vi.fn()} onNavigateTab={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/Every area is archived/)).toBeInTheDocument())
    expect(areaCards()).toHaveLength(0)
  })

  it('opens on the area a plan preview named, drawing it even when archived', async () => {
    const scrolled = vi.fn()
    Element.prototype.scrollIntoView = scrolled
    window.history.replaceState({}, '', '/site-map?area=area-a')
    try {
      api.get.mockImplementation(routeGet({ areas: [{ ...areaA, is_archived: true }, areaB] }))
      render(<SiteMapTab showToast={vi.fn()} hasPermission={() => true} onSelectCell={vi.fn()} onNavigateTab={vi.fn()} />)
      await waitFor(() => expect(document.querySelector('.context-panel-open')).toBeTruthy())
      expect(within(panel()).getByText('2 Cells · 1 Gateway · 2 Devices')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Show archived areas/ })).toHaveAttribute('aria-pressed', 'true')
      const name = screen.getByRole('button', { name: 'North Shop' })
      expect(name).toHaveAttribute('aria-pressed', 'true')
      expect(scrolled.mock.contexts[0]).toBe(name.closest('.area-card'))
    } finally {
      window.history.replaceState({}, '', '/')
      delete Element.prototype.scrollIntoView
    }
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
    expect(within(panel).getByText('North Shop')).toBeInTheDocument()
    // The pin beside it says where; the panel repeats no fractions.
    expect(within(panel).queryByText(/% across/)).toBeNull()
    expect(within(panel).queryByText('Place on plan')).toBeNull()
    // The cell's own icon on the title; with no dashboard, the Cells page is the one primary.
    expect(panel.querySelector('.context-panel-title-row .context-panel-icon svg')).toBeTruthy()
    expect(panel.querySelector('.context-panel-actions .btn-primary')).toHaveTextContent('Open on Cells page')
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
    await waitFor(() => expect(screen.getByText('North Shop')).toBeInTheDocument())
  }

  const rowFor = (name) => screen.getByText(name).closest('tr')

  it('lists the unfiled cells in a banner above the card, and each area\'s cells beside it', async () => {
    await renderAreas()
    const banner = screen.getByText(/1 unfiled cell/).parentElement
    // Above the card, as the Cells and Gateways pages report their unfinished business.
    expect(banner.closest('.card')).toBeNull()
    expect(follows(banner, document.querySelector('.card'))).toBe(true)
    expect(screen.getByText('Loose End')).toBeInTheDocument()
    const rowA = rowFor('North Shop')
    expect(within(rowA).getByText('Bay 1')).toBeInTheDocument()
    expect(within(rowA).getByText('Bay 2')).toBeInTheDocument()
    expect(within(rowFor('Press Hall')).getByText('Paint Shop')).toBeInTheDocument()
  })

  it('opens a row from the keyboard, and leaves a key on a cell chip to the chip', async () => {
    const onSelectCell = vi.fn()
    await renderAreas({ onSelectCell })
    const row = rowFor('North Shop')
    expect(row).toHaveAttribute('tabindex', '0')
    fireEvent.keyDown(within(row).getByText('Bay 1').closest('[role="button"]'), { key: 'Enter' })
    expect(onSelectCell).toHaveBeenCalledWith('cell-1')
    expect(document.querySelector('.context-panel-open')).toBeNull()
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(document.querySelector('.context-panel-open')).toBeTruthy()
    expect(row).toHaveClass('row-selected')
    fireEvent.keyDown(row, { key: ' ' })
    expect(row).not.toHaveClass('row-selected')
  })

  it('attaches links to an area, the way every other asset carries them', async () => {
    // The same modal Cells, Gateways and Devices open.
    await renderAreas()
    fireEvent.click(screen.getByText('North Shop'))

    fireEvent.click(screen.getByRole('button', { name: /Attached Links/ }))

    const modal = document.querySelector('.modal')
    expect(within(modal).getByText(/^Attached Links —/)).toBeInTheDocument()
    expect(within(modal).getByText('North Shop')).toBeInTheDocument()

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
    fireEvent.click(screen.getByText('Press Hall'))
    expect(screen.queryByRole('button', { name: /Delete Area/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Archive Area/ }))
    const dialog = document.querySelector('.modal')
    expect(within(dialog).getByText('Press Hall')).toBeInTheDocument()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' })) })
    expect(api.post).toHaveBeenCalledWith('/api/v1/areas/area-b/archive', { auto_delete_days: 30 })
    expect(api.delete).not.toHaveBeenCalled()
  })

  it('hides an archived area behind the lifecycle filter, and offers Restore on it', async () => {
    api.post.mockResolvedValue({})
    api.get.mockImplementation(routeGet({ areas: [areaA, { ...areaB, is_archived: true, archived_at: '2026-09-01T00:00:00Z' }] }))
    await renderAreas()
    // Every list opens on Active.
    expect(screen.queryByText('Press Hall')).toBeNull()
    fireEvent.change(screen.getByTitle('Filter by lifecycle state'), { target: { value: 'archived' } })
    const row = rowFor('Press Hall')
    expect(within(row).getByText('ARCHIVED')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Press Hall'))
    // Archived, Restore is the one primary and comes first.
    expect(document.querySelectorAll('.context-panel-actions .btn-primary')).toHaveLength(1)
    expect(document.querySelector('.context-panel-actions .context-action')).toHaveTextContent('Restore Area')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Restore Area/ })) })
    expect(api.post).toHaveBeenCalledWith('/api/v1/areas/area-b/restore', {})
  })

  it('says whether an area carries a plan, and how many of its cells sit on it', async () => {
    await renderAreas()
    const rowA = rowFor('North Shop')
    expect(within(rowA).getByText('Plan')).toBeInTheDocument()
    expect(within(rowA).getByText('2 cells placed')).toBeInTheDocument()
    const rowB = rowFor('Press Hall')
    expect(within(rowB).getByText('Default outline')).toBeInTheDocument()
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
    const rowA = rowFor('North Shop')
    // A plain number; the Area-Wide breakdown keeps its badge.
    expect(within(rowA).getByText('1')).not.toHaveClass('badge')
    expect(within(rowA).getByText('+1 Area-Wide')).toHaveClass('badge')
  })

  it('files a dropped cell with one write naming the area, and says so', async () => {
    const showToast = vi.fn()
    await renderAreas({ showToast })
    const dataTransfer = { getData: () => JSON.stringify({ cell_id: 'cell-4' }), setData: vi.fn() }
    const rowB = rowFor('Press Hall')
    fireEvent.dragOver(rowB, { dataTransfer })
    await act(async () => { fireEvent.drop(rowB, { dataTransfer }) })

    expect(api.put).toHaveBeenCalledTimes(1)
    expect(api.put.mock.calls[0][0]).toBe('/api/v1/cells/cell-4')
    expect(api.put.mock.calls[0][1]).toMatchObject({ area_id: 'area-b' })
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/Loose End.*Press Hall/), 'success')
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
    const rowA = rowFor('North Shop')
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
    const rowB = rowFor('Press Hall')
    fireEvent.dragOver(rowB, { dataTransfer })
    await act(async () => { fireEvent.drop(rowB, { dataTransfer }) })
    expect(api.put).not.toHaveBeenCalled()
  })
})

describe('AreasTab is the house list card', () => {
  const renderAreas = async (route = {}) => {
    api.get.mockImplementation(routeGet(route))
    render(<AreasTab showToast={vi.fn()} hasPermission={() => true} onSelectCell={vi.fn()} onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} />)
    await waitFor(() => expect(document.querySelector('.card-header')).toBeInTheDocument())
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
  }

  it('scrolls inside its card, with no count on the heading', async () => {
    await renderAreas()
    expect(document.querySelector('.page-layout')).toHaveClass('page-fill')
    expect(document.querySelector('.card')).toHaveClass('card-fill')
    expect(document.querySelector('.card-header .section-count')).toBeNull()
    expect(document.querySelector('.card-fill > .table-wrap')).toBeInTheDocument()
  })

  it('names the page in its card header, with no title tip', async () => {
    await renderAreas()
    expectCardHeading('Areas', /ISA-95/)
    expect(within(document.querySelector('.card-header')).getByRole('button', { name: /New Area/ })).toBeInTheDocument()
  })

  it('narrows the list under a search, and keeps the counts in the lifecycle options', async () => {
    await renderAreas()
    expect(within(screen.getByLabelText('Lifecycle')).getByRole('option', { name: 'Active (2)' })).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText(/Search by area ID or name/), { target: { value: 'North Shop' } })
    expect(screen.queryByText('Press Hall')).toBeNull()
    expect(document.querySelector('.card-header .section-count')).toBeNull()
  })

  it('draws the unfiled banner as a page callout with one body element', async () => {
    await renderAreas()
    const banner = document.querySelector('.callout.callout-warning.callout-page')
    expect(banner).toBeInTheDocument()
    expect(banner.children).toHaveLength(2)
    expect(banner.children[0]).toHaveClass('callout-icon')
  })

  it('tells none-yet from none-match', async () => {
    await renderAreas({ areas: [] })
    expect(screen.getByText('No areas yet. Add one, then file the cells into it.')).toBeInTheDocument()

    document.body.innerHTML = ''
    await renderAreas()
    fireEvent.change(screen.getByPlaceholderText(/Search by area ID or name/), { target: { value: 'nothing-like-this' } })
    expect(screen.getByText('No areas match these filters.')).toBeInTheDocument()
  })

  it('opens the New Area form in the shared modal, and names the roles when denied', async () => {
    await renderAreas()
    fireEvent.click(screen.getByRole('button', { name: /New Area/ }))
    expect(screen.getByRole('dialog', { name: 'New Area' })).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()

    document.body.innerHTML = ''
    render(<AreasTab showToast={vi.fn()} hasPermission={() => false} onSelectCell={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /New Area/ })).toBeDisabled())
    expect(screen.getByRole('button', { name: /New Area/ })).toHaveAttribute('title', expect.stringMatching(/^Requires /))
    expect(screen.getByRole('button', { name: /New Area/ }).title).not.toMatch(/Admin permissions/)
  })
})

describe('AreasTab manages an area\'s plan from its panel', () => {
  const openArea = async (name = 'North Shop', props = {}) => {
    render(<AreasTab showToast={vi.fn()} hasPermission={() => true} onSelectCell={vi.fn()} onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} {...props} />)
    await waitFor(() => expect(screen.getByText(name)).toBeInTheDocument())
    fireEvent.click(screen.getByText(name))
    return document.querySelector('.context-panel')
  }

  const planRow = () => document.querySelector('.area-plan-panel-row')
  const planPanel = () => document.querySelector('.area-plan-panel')

  it('draws the plan with every cell on it, with the fields and above the actions', async () => {
    const panel = await openArea()
    expect(within(panel).getByText('Area plan')).toBeInTheDocument()
    const preview = planPanel().querySelector('.area-plan-preview')
    expect(preview.querySelector('.area-plan').getAttribute('data-plan')).toBe('uploaded')
    expect([...preview.querySelectorAll('.area-plan-pin-label')].map(l => l.textContent)).toEqual(['Bay 1', 'Bay 2'])
    // Every cell drawn alike, as marks rather than controls.
    expect(preview.querySelector('.area-plan-pin-selected, .area-plan-pin-muted, button')).toBeNull()
    expect(planPanel().closest('.context-panel-facts')).toBeTruthy()
    expect(follows(planPanel(), panel.querySelector('.context-panel-actions'))).toBe(true)
    expect(within(panel).queryByText(/Plan attached|placed on it/)).toBeNull()
  })

  it('opens the Site Map on the area from its plan, by click or Enter', async () => {
    const onShowOnSiteMap = vi.fn()
    await openArea('North Shop', { onShowOnSiteMap })
    const preview = screen.getByRole('link', { name: 'Open North Shop on the Site Map' })
    expect(preview).toHaveAttribute('tabindex', '0')
    fireEvent.click(preview)
    expect(onShowOnSiteMap).toHaveBeenLastCalledWith('area-a')
    fireEvent.keyDown(preview, { key: 'Enter' })
    expect(onShowOnSiteMap).toHaveBeenCalledTimes(2)
  })

  it('titles the panel with the area\'s icon, Edit Details its one primary', async () => {
    const panel = await openArea()
    expect(panel.querySelector('.context-panel-title-row .context-panel-icon svg')).toBeTruthy()
    expect(panel.querySelectorAll('.context-panel-actions .btn-primary')).toHaveLength(1)
    expect(panel.querySelector('.context-panel-actions .btn-primary')).toHaveTextContent('Edit Details')
  })

  it('offers a drop zone on an area with no plan, and Replace and Remove on one with', async () => {
    await openArea('Press Hall')
    expect(planRow().getAttribute('data-plan')).toBe('outline')
    expect(screen.getByRole('button', { name: 'Upload plan for Press Hall' })).toBe(planRow())
    expect(within(planRow()).getByText(/Drop an SVG plan here/)).toBeInTheDocument()
    expect(within(planRow()).getByText(/Default outline · 0 cells placed on it/)).toBeInTheDocument()
    expect(planPanel().querySelector('.area-plan-preview')).toBeNull()
    expect(screen.queryByRole('button', { name: /Remove plan/ })).toBeNull()

    document.body.innerHTML = ''
    await openArea('North Shop')
    expect(within(planPanel()).getByRole('button', { name: /Replace plan/ })).toBeInTheDocument()
    expect(within(planPanel()).getByRole('button', { name: /Remove plan/ })).toBeInTheDocument()
  })

  it('takes a plan dropped onto the zone, not only one browsed for', async () => {
    api.uploadAreaPlan.mockResolvedValue({})
    await openArea('Press Hall')
    const file = new File(['<svg viewBox="0 0 4 3"/>'], 'annexe.svg', { type: 'image/svg+xml' })
    await act(async () => { fireEvent.drop(planRow(), { dataTransfer: { files: [file] } }) })
    expect(api.uploadAreaPlan).toHaveBeenCalledTimes(1)
    expect(api.uploadAreaPlan.mock.calls[0][1]).toBe(file)
  })

  it('uploads a plan against the area itself', async () => {
    api.uploadAreaPlan.mockResolvedValue({})
    await openArea('Press Hall')
    const file = new File(['<svg viewBox="0 0 4 3"/>'], 'annexe.svg', { type: 'image/svg+xml' })
    const input = within(planRow()).getByLabelText('Plan file for Press Hall')
    await act(async () => { fireEvent.change(input, { target: { files: [file] } }) })
    expect(api.uploadAreaPlan).toHaveBeenCalledTimes(1)
    expect(api.uploadAreaPlan.mock.calls[0][0]).toMatchObject({ area_id: 'area-b' })
    expect(api.uploadAreaPlan.mock.calls[0][1]).toBe(file)
  })

  it('removes a plan once the dialog is confirmed', async () => {
    api.removeAreaPlan.mockResolvedValue({})
    await openArea()
    fireEvent.click(within(planPanel()).getByRole('button', { name: /Remove plan/ }))
    const dialog = document.querySelector('.modal')
    expect(within(dialog).getByText(/Remove the plan from North Shop\?/)).toBeInTheDocument()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Remove plan' })) })
    expect(api.removeAreaPlan).toHaveBeenCalledWith(expect.objectContaining({ area_id: 'area-a' }))
  })

  it('refuses a file that is not an SVG before anything is uploaded', async () => {
    const showToast = vi.fn()
    render(<AreasTab showToast={showToast} hasPermission={() => true} onSelectCell={vi.fn()} onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('North Shop')).toBeInTheDocument())
    fireEvent.click(screen.getByText('North Shop'))
    const file = new File(['png'], 'plan.png', { type: 'image/png' })
    const input = within(planPanel()).getByLabelText('Plan file for North Shop')
    await act(async () => { fireEvent.change(input, { target: { files: [file] } }) })
    expect(api.uploadAreaPlan).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/not an SVG/), 'error')
  })

  it('shows the plan read-only to somebody who may not manage cells', async () => {
    render(<AreasTab showToast={vi.fn()} hasPermission={() => false} onSelectCell={vi.fn()} onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('North Shop')).toBeInTheDocument())
    fireEvent.click(screen.getByText('North Shop'))
    expect(planPanel().querySelector('.area-plan-preview [data-plan="uploaded"]')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Upload plan|Replace plan|Remove plan/ })).toBeNull()

    // With no plan, the reader sees the default outline rather than a drop zone they cannot use.
    fireEvent.click(screen.getByText('Press Hall'))
    expect(planPanel().querySelector('.area-plan-preview [data-plan="outline"]')).toBeTruthy()
    expect(planRow()).toBeNull()
  })

  it('clears its filter with the control the other asset pages carry', async () => {
    // Wording and count together: the same control the other asset pages carry.
    render(<AreasTab showToast={vi.fn()} hasPermission={() => true} onSelectCell={vi.fn()} onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('North Shop')).toBeInTheDocument())
    const searchBox = screen.getByPlaceholderText(/Search by area ID or name/)

    // Nothing to clear on arrival, so nothing is offered.
    expect(screen.queryByRole('button', { name: /Clear filters/ })).toBeNull()

    fireEvent.change(searchBox, { target: { value: 'North Shop' } })
    expect(screen.getByRole('button', { name: /Clear filters/ })).toHaveTextContent('Clear filters (1)')

    fireEvent.click(screen.getByRole('button', { name: /Clear filters/ }))
    expect(searchBox).toHaveValue('')
    expect(screen.queryByRole('button', { name: /Clear filters/ })).toBeNull()
  })

  it('counts the lifecycle select and resets it to Active', async () => {
    render(<AreasTab showToast={vi.fn()} hasPermission={() => true} onSelectCell={vi.fn()} onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('North Shop')).toBeInTheDocument())
    const lifecycle = screen.getByTitle('Filter by lifecycle state')
    expect(lifecycle).toHaveValue('active')

    fireEvent.change(lifecycle, { target: { value: 'archived' } })
    expect(screen.getByRole('button', { name: /Clear filters/ })).toHaveTextContent('Clear filters (1)')

    fireEvent.change(screen.getByPlaceholderText(/Search by area ID or name/), { target: { value: 'x' } })
    expect(screen.getByRole('button', { name: /Clear filters/ })).toHaveTextContent('Clear filters (2)')

    fireEvent.click(screen.getByRole('button', { name: /Clear filters/ }))
    expect(lifecycle).toHaveValue('active')
    expect(screen.queryByRole('button', { name: /Clear filters/ })).toBeNull()
  })
})
