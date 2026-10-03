import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { api } from '../api'
import { formatDateTime } from '../utils/format'

/**
 * The Devices page is one card with two tabs: Registered, the roster, which opens on Active and
 * keeps its secondary filters in a popover; and Quarantine, the queue, which carries the attention
 * state while a birth waits.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

vi.mock('../lib/supabaseClient', () => ({
  supabase: { functions: { invoke: vi.fn() } }
}))

const device = (overrides = {}) => ({
  asset_id: 'aaaaaaaa-0000-4000-8000-000000000001',
  asset_name: 'CNC_01',
  sparkplug_id: 'devaaaaaaaa000040008000',
  status: 'ONLINE',
  is_quarantined: false,
  is_archived: false,
  active_gateway_id: 'gw-1',
  cell_id: null,
  location_scope: 'cell',
  effective_cell_id: 'cell-1',
  gateway_cell_id: 'cell-1',
  location_source: 'inherited',
  cell_mismatch: false,
  first_dbirth_at: '2026-07-27T12:00:00Z',
  created_at: '2026-07-20T12:00:00Z',
  ...overrides
})

const GATEWAYS = [
  { gateway_id: 'gw-1', gateway_name: 'Line_A_Gateway', cell_id: 'cell-1', location_scope: 'cell', status: 'ONLINE', is_archived: false, devices: [] }
]
const CELLS = [{ cell_id: 'cell-1', cell_name: 'Assembly', is_archived: false }]

const DISCOVERED = new Date(Date.now() - 3 * 3600 * 1000).toISOString()
const queued = {
  quarantine_id: 'qtn-1',
  asset_id: 'cccccccc-0000-4000-8000-000000000003',
  asset_name: 'Unknown_Robot',
  reported_identity: 'devffffffffffffffffffff1',
  quarantine_reason: 'UNKNOWN_DEVICE',
  gateway_id: 'gw-1',
  gateway_name: null,
  discovered_at: DISCOVERED,
  entity_type: 'DEVICE'
}

const routeGet = (rows, quarantine) => (path) => {
  if (path.startsWith('/api/v1/gateways')) return Promise.resolve(GATEWAYS)
  if (path.startsWith('/api/v1/cells')) return Promise.resolve(CELLS)
  if (path.startsWith('/api/v1/quarantine')) return Promise.resolve(quarantine)
  if (path.startsWith('/api/v1/devices')) return Promise.resolve(rows)
  return Promise.resolve([])
}

const show = async (rows, quarantine = [], hasPermission = () => true, props = {}) => {
  api.get.mockImplementation(routeGet(rows, quarantine))
  render(<DevicesTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={hasPermission} {...props} />)
  await waitFor(() => expect(document.querySelector('.tab-strip')).toBeTruthy())
  await waitFor(() => expect(document.querySelector('.loading-wrap')).toBeNull())
}

const card = () => document.querySelector('.page-main > .card')
const tab = (name) => screen.getByRole('tab', { name })
const openFilters = () => {
  fireEvent.click(screen.getByRole('button', { name: /^Filters/ }))
  return within(screen.getByRole('dialog', { name: 'Filters' }))
}
const panelOpen = () => !!document.querySelector('.context-panel-open')

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState({}, '', '/devices')
})

describe('the Devices card', () => {
  it('is the page\'s one card, its heading carrying the rail icon, the title and one sentence', async () => {
    await show([device()])

    expect(document.querySelectorAll('.page-main > .card')).toHaveLength(1)
    expect(document.querySelector('.page-heading')).toBeNull()
    const heading = card().querySelector(':scope > .card-heading')
    expect(heading.querySelector('h3.section-title').textContent).toBe('Devices')
    expect(heading.querySelector('h3 svg')).toBeTruthy()
    const sentence = heading.querySelector('.card-heading-description').textContent
    expect(sentence.match(/[.!?](\s|$)/g)).toHaveLength(1)
    expect(sentence.split(' ').length).toBeLessThanOrEqual(28)
  })

  it('puts the tab bar straight under the heading, Registered selected, with no counts', async () => {
    await show([device()], [queued])

    const strip = card().querySelector(':scope > .card-heading + .tab-strip')
    expect(strip).toBeTruthy()
    expect(within(strip).getAllByRole('tab').map(t => t.textContent.replace(/\d+$/, ''))).toEqual(['Registered', 'Quarantine'])
    expect(tab('Registered')).toHaveAttribute('aria-selected', 'true')
    expect(card().querySelector('.section-count')).toBeNull()
  })

  it('gives the scrolling to the card, its table the scroller', async () => {
    await show([device()])

    expect(document.querySelector('.page-layout')).toHaveClass('page-fill')
    expect(card()).toHaveClass('card-fill')
    expect(card().querySelector(':scope > .table-wrap')).toBeTruthy()
  })

  it('closes the panel when the tab changes, since it belongs to the list it came from', async () => {
    await show([device()], [queued])
    fireEvent.click(within(card()).getByText('CNC_01'))
    expect(panelOpen()).toBe(true)

    fireEvent.click(tab(/^Quarantine/))
    expect(panelOpen()).toBe(false)
  })
})

describe('the Quarantine tab', () => {
  it('is plain and says so with one line while nothing is waiting', async () => {
    await show([device()])

    expect(tab('Quarantine')).not.toHaveClass('tab-strip-tab-attention')
    fireEvent.click(tab('Quarantine'))
    expect(within(card()).getByText('Nothing is waiting to be let in.')).toBeInTheDocument()
    expect(card().querySelector('table')).toBeNull()
  })

  it('carries the attention state while a device waits: colour, icon and number', async () => {
    await show([device()], [queued])

    const waiting = tab('Quarantine, 1 waiting')
    expect(waiting).toHaveClass('tab-strip-tab-attention')
    expect(waiting.querySelector('.tab-strip-attention svg')).toBeTruthy()
    expect(waiting.querySelector('.tab-strip-attention').textContent).toBe('1')
    // No border on any card, and the roster stays where it was.
    expect(document.querySelector('.card-attention')).toBeNull()
    expect(tab('Registered')).toHaveAttribute('aria-selected', 'true')
  })

  it('lists the waiting device straight under the bar, its HelpTip in the bar and no toolbar row', async () => {
    await show([device()], [queued])
    fireEvent.click(tab(/^Quarantine/))

    // The tab has no filters or actions, so it draws no row; its "?" follows the tab names.
    expect(card().querySelector('.filter-bar')).toBeNull()
    expect(card().querySelector(':scope > .tab-strip + .table-wrap')).toBeTruthy()
    expect(card().querySelector('.tab-strip-help .help-tip')).toHaveAccessibleName('About the Quarantine queue')
    expect(screen.queryByRole('button', { name: 'About registered devices' })).toBeNull()
    const row = within(card()).getByText('Unknown_Robot').closest('tr')
    // Relative time, with the exact time on hover; a plain dash for the missing gateway name.
    const when = within(row).getByText('3h ago')
    expect(when).toHaveAttribute('title', formatDateTime(DISCOVERED))
    const gatewayCell = row.querySelectorAll('td')[2]
    expect(gatewayCell.textContent).toBe('—')
    expect(gatewayCell.querySelector('.mono')).toBeNull()
    expect(row.querySelector('td.row-actions')).toBeTruthy()
    expect(within(row).getByRole('button', { name: 'Approve & Onboard' })).toBeEnabled()
  })

  it('names the roles that can approve on a disabled button', async () => {
    await show([device()], [queued], () => false)
    fireEvent.click(tab(/^Quarantine/))

    const button = within(card()).getByRole('button', { name: 'Approve & Onboard' })
    expect(button).toBeDisabled()
    expect(button.title).toMatch(/^Requires /)
    expect(button.title).not.toMatch(/Admin permissions/)
  })

  it('opens on the Quarantine tab when App hands it over, and clears the hand-over', async () => {
    const onClearSection = vi.fn()
    await show([device()], [queued], () => true, { initialSection: 'quarantine', onClearSection })

    expect(tab(/^Quarantine/)).toHaveAttribute('aria-selected', 'true')
    expect(onClearSection).toHaveBeenCalled()
  })

  it('lands a quarantined device named by another page on the Quarantine tab, with no panel', async () => {
    const held = device({ asset_id: queued.asset_id, asset_name: 'Unknown_Robot', is_quarantined: true })
    await show([device(), held], [queued], () => true, { initialSearchFilter: queued.asset_id })

    await waitFor(() => expect(tab(/^Quarantine/)).toHaveAttribute('aria-selected', 'true'))
    expect(panelOpen()).toBe(false)
    expect(within(card()).getByText('Unknown_Robot')).toBeInTheDocument()
  })
})

describe('the Registered tab', () => {
  const archived = device({
    asset_id: 'aaaaaaaa-0000-4000-8000-000000000002', asset_name: 'Old_Lathe', is_archived: true
  })

  it('keeps search, status and Needs attention in the toolbar, and New Device at its end', async () => {
    await show([device()])

    const bar = within(card().querySelector(':scope > .tab-strip + .filter-bar'))
    expect(card().querySelector('.filter-bar .help-tip')).toBeNull()
    expect(card().querySelector('.tab-strip-help .help-tip')).toHaveAccessibleName('About registered devices')
    expect(bar.getByRole('searchbox', { name: 'Search devices' })).toBeInTheDocument()
    expect(bar.getByTitle('Filter by operational state')).toBeInTheDocument()
    expect(bar.getByRole('button', { name: /Needs attention/ })).toBeInTheDocument()
    expect(within(card().querySelector('.filter-bar-actions')).getByRole('button', { name: /New Device/ })).toBeInTheDocument()
    // The rest wait in the popover.
    expect(screen.queryByTitle('Filter by serving gateway')).toBeNull()
  })

  it('holds lifecycle, type, schema, gateway and cell in the Filters popover', async () => {
    await show([device()])

    const popover = openFilters()
    for (const name of ['Lifecycle', 'Type', 'Schema', 'Gateway', 'Cell']) {
      expect(popover.getByRole('combobox', { name })).toBeInTheDocument()
    }
  })

  it('opens on Active and lists no archived row', async () => {
    await show([device(), archived])

    expect(within(card()).queryByText('Old_Lathe')).toBeNull()
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument()
    const popover = openFilters()
    expect(popover.getByRole('combobox', { name: 'Lifecycle' })).toHaveValue('active')
    expect(popover.getByRole('option', { name: 'Archived (1)' })).toBeInTheDocument()
    // Active is the default, so it is not a filter to clear.
    expect(within(card()).queryByRole('button', { name: /Clear filters/ })).toBeNull()
  })

  it('shows archived rows one filter away, tinted and badged, and counts the filter', async () => {
    await show([device(), archived])
    fireEvent.change(openFilters().getByRole('combobox', { name: 'Lifecycle' }), { target: { value: 'archived' } })

    const row = within(card()).getByText('Old_Lathe').closest('tr')
    expect(row).toHaveClass('row-archived')
    expect(within(row).getAllByText('ARCHIVED').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Filters (1)' })).toBeInTheDocument()
    expect(within(card()).getByRole('button', { name: /Clear filters \(1\)/ })).toBeInTheDocument()
  })

  it('clears only its own filters from the popover, and everything from the toolbar', async () => {
    await show([device(), archived])
    fireEvent.change(within(card()).getByPlaceholderText(/Search name, UUID or Sparkplug ID/), { target: { value: 'CNC' } })
    const popover = openFilters()
    fireEvent.change(popover.getByRole('combobox', { name: 'Gateway' }), { target: { value: 'gw-1' } })
    expect(screen.getByRole('button', { name: 'Filters (1)' })).toBeInTheDocument()
    expect(within(card()).getByRole('button', { name: /Clear filters \(2\)/ })).toBeInTheDocument()

    fireEvent.click(popover.getByRole('button', { name: 'Clear' }))
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument()
    expect(within(card()).getByPlaceholderText(/Search name, UUID or Sparkplug ID/)).toHaveValue('CNC')

    fireEvent.click(within(card()).getByRole('button', { name: /Clear filters \(1\)/ }))
    expect(within(card()).getByPlaceholderText(/Search name, UUID or Sparkplug ID/)).toHaveValue('')
  })

  it('says "none yet" on an empty stack and "none match" once a filter is on', async () => {
    await show([])
    expect(within(card()).getByText('No devices yet.')).toBeInTheDocument()

    fireEvent.change(within(card()).getByPlaceholderText(/Search name, UUID or Sparkplug ID/), { target: { value: 'zzz' } })
    expect(within(card()).getByText('No devices match these filters.')).toBeInTheDocument()
  })

  it('opens a row from the keyboard, and leaves a key on a control inside it to that control', async () => {
    await show([device()])
    const row = within(card()).getByText('CNC_01').closest('tr')
    expect(row).toHaveClass('row-selectable')
    expect(row).toHaveAttribute('tabindex', '0')

    const copy = within(row).getByRole('button', { name: /Device UUID/i })
    fireEvent.keyDown(copy, { key: 'Enter' })
    fireEvent.keyDown(copy, { key: ' ' })
    expect(panelOpen()).toBe(false)

    fireEvent.keyDown(row, { key: 'Enter' })
    expect(panelOpen()).toBe(true)
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(panelOpen()).toBe(false)

    // Space as well, without scrolling the card.
    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    row.dispatchEvent(space)
    await waitFor(() => expect(panelOpen()).toBe(true))
    expect(space.defaultPrevented).toBe(true)
  })
})
