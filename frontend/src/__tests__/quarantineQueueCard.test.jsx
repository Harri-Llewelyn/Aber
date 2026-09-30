import React from 'react'
import { render, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { api } from '../api'
import { formatDateTime } from '../utils/format'

/**
 * The Quarantine queue is always the Devices page's first card, and the roster under it opens on
 * Active, counts its rows and tells "none yet" from "none match".
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

const show = async (rows, quarantine = [], hasPermission = () => true) => {
  api.get.mockImplementation(routeGet(rows, quarantine))
  render(<DevicesTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={hasPermission} />)
  await waitFor(() => expect(document.querySelector('.queue-card')).toBeTruthy())
  await waitFor(() => expect(document.querySelector('.loading-wrap')).toBeNull())
}

const queueCard = () => document.querySelector('.queue-card')
const rosterCard = () => document.querySelector('.page-main .card-fill')
const titleCount = (card) => card.querySelector('.section-title .section-count').textContent

beforeEach(() => vi.clearAllMocks())

describe('the Quarantine queue card', () => {
  it('is the first card and says so with a zero and one line while nothing is waiting', async () => {
    await show([device()])

    const card = queueCard()
    expect(card.querySelector('h3.section-title').textContent).toMatch(/Quarantine queue/)
    expect(titleCount(card)).toBe('0')
    expect(within(card).getByText('Nothing is waiting to be let in.')).toBeInTheDocument()
    expect(card.querySelector('table')).toBeNull()
    expect(card).not.toHaveClass('card-attention')
    expect(document.querySelector('.page-main .card')).toBe(card)
    expect(card.compareDocumentPosition(rosterCard()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('wears the attention border and lists the device while it holds one', async () => {
    await show([device()], [queued])

    const card = queueCard()
    expect(card).toHaveClass('card-attention')
    expect(titleCount(card)).toBe('1')
    const row = within(card).getByText('Unknown_Robot').closest('tr')
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

    const button = within(queueCard()).getByRole('button', { name: 'Approve & Onboard' })
    expect(button).toBeDisabled()
    expect(button.title).toMatch(/^Requires /)
    expect(button.title).not.toMatch(/Admin permissions/)
  })
})

describe('the Devices roster', () => {
  const archived = device({
    asset_id: 'aaaaaaaa-0000-4000-8000-000000000002', asset_name: 'Old_Lathe', is_archived: true
  })

  it('opens on Active and counts what it lists', async () => {
    await show([device(), archived])

    expect(within(rosterCard()).queryByText('Old_Lathe')).toBeNull()
    expect(titleCount(rosterCard())).toBe('1')
    expect(rosterCard().querySelector('select').value).toBe('active')
    expect(within(rosterCard()).getByRole('option', { name: 'Archived (1)' })).toBeInTheDocument()
    // Active is the default, so it is not a filter to clear.
    expect(within(rosterCard()).queryByRole('button', { name: /Clear filters/ })).toBeNull()
  })

  it('shows archived rows one filter away, tinted and badged', async () => {
    await show([device(), archived])
    fireEvent.change(rosterCard().querySelector('select'), { target: { value: 'archived' } })

    const row = within(rosterCard()).getByText('Old_Lathe').closest('tr')
    expect(row).toHaveClass('row-archived')
    expect(within(row).getAllByText('ARCHIVED').length).toBeGreaterThan(0)
    expect(titleCount(rosterCard())).toBe('1')
    expect(within(rosterCard()).getByRole('button', { name: /Clear filters \(1\)/ })).toBeInTheDocument()
  })

  it('reads shown / total while a search narrows the list', async () => {
    await show([device(), device({ asset_id: 'aaaaaaaa-0000-4000-8000-000000000009', asset_name: 'Press_02' })])
    expect(titleCount(rosterCard())).toBe('2')

    fireEvent.change(within(rosterCard()).getByPlaceholderText(/Search name, UUID or Sparkplug ID/), { target: { value: 'Press' } })
    expect(titleCount(rosterCard())).toBe('1 / 2')
  })

  it('says "none yet" on an empty stack and "none match" once a filter is on', async () => {
    await show([])
    expect(within(rosterCard()).getByText('No devices yet.')).toBeInTheDocument()
    expect(titleCount(rosterCard())).toBe('0')

    fireEvent.change(within(rosterCard()).getByPlaceholderText(/Search name, UUID or Sparkplug ID/), { target: { value: 'zzz' } })
    expect(within(rosterCard()).getByText('No devices match these filters.')).toBeInTheDocument()
  })

  it('gives the scrolling to the roster card and keeps the queue card at its height', async () => {
    await show([device()])

    expect(document.querySelector('.page-layout')).toHaveClass('page-fill')
    expect(rosterCard()).toBe(document.querySelectorAll('.page-main > .card')[1])
    expect(queueCard()).not.toHaveClass('card-fill')
    expect(rosterCard().querySelector(':scope > .table-wrap')).toBeTruthy()
  })
})
