/**
 * Digital Thread filter bar and actor attribution.
 *
 * The attribution half exists because `changed_by IS NULL` was the normal case, not an anomaly:
 * on a stack with one simulated gateway and one device the audit table was taking 175 anonymous
 * rows/hour, of which every one was either a heartbeat stamp or a write where `old_data =
 * new_data`. Migration 0005 stops recording those and stamps `actor_source` on what remains, so
 * a blank author now means a genuine gap rather than "a machine did something routine".
 */
import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { DigitalThreadTab } from '../components/tabs/DigitalThreadTab'
import { api } from '../api'

const APP_CSS = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8')

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const CELLS = [{ cell_id: 'cell-1', cell_name: 'Assembly Line 1' }]
const GATEWAYS = [{ gateway_id: 'gw-1', gateway_name: 'Virtual_Gateway_NodeRED', devices: [] }]
const DEVICES = [
  { asset_id: 'dev-1', asset_name: 'Simulated_CNC_01', last_birth_metrics: [] },
  { asset_id: 'dev-2', asset_name: 'Press_02', last_birth_metrics: [] }
]

const EVENTS = [
  {
    event_id: 1, entity_type: 'devices', entity_id: 'dev-1', event_type: 'UPDATE',
    timestamp: '2026-08-02T12:00:00Z', description: 'Action UPDATE on devices [dev-1]',
    changed_by: 'user-uuid-1', actor_source: 'user', metadata: {}
  },
  {
    event_id: 2, entity_type: 'gateways', entity_id: 'gw-1', event_type: 'INSERT',
    timestamp: '2026-08-02T11:00:00Z', description: 'Action INSERT on gateways [gw-1]',
    changed_by: null, actor_source: 'ingestion', metadata: {}
  },
  {
    event_id: 3, entity_type: 'cells', entity_id: 'cell-1', event_type: 'DELETE',
    timestamp: '2026-08-02T10:00:00Z', description: 'Action DELETE on cells [cell-1]',
    changed_by: null, actor_source: null, metadata: {}
  }
]

const urls = () => api.get.mock.calls.map(c => c[0]).filter(u => u.includes('/digital-thread'))
const lastThreadUrl = () => urls()[urls().length - 1]

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/digital-thread')) return Promise.resolve(EVENTS)
    if (path.startsWith('/api/v1/devices'))  return Promise.resolve(DEVICES)
    if (path.startsWith('/api/v1/gateways')) return Promise.resolve(GATEWAYS)
    if (path.startsWith('/api/v1/cells'))    return Promise.resolve(CELLS)
    return Promise.resolve([])
  })
})

const show = async () => {
  render(<DigitalThreadTab />)
  await waitFor(() => expect(screen.getByText(/Action UPDATE on devices/)).toBeInTheDocument())
}

describe('Digital Thread filter bar', () => {
  it('offers entity type, entity name and event type, in the shared filter bar', async () => {
    await show()

    // The same `.filter-bar` the Gateways and Devices pages use, not a row of controls wedged
    // into the section header.
    expect(document.querySelector('.filter-bar')).toBeTruthy()
    expect(screen.getByTitle(/Show only events against one kind of asset/)).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/Search by entity name or ID/)).toBeInTheDocument()
    expect(screen.getByTitle(/Show only one kind of audit event/)).toBeInTheDocument()
  })

  it('filters by entity type', async () => {
    await show()
    fireEvent.change(screen.getByTitle(/Show only events against one kind of asset/), { target: { value: 'GATEWAY' } })

    await waitFor(() => expect(lastThreadUrl()).toContain('entity_type=GATEWAY'))
  })

  it('filters by audit event type', async () => {
    await show()
    fireEvent.change(screen.getByTitle(/Show only one kind of audit event/), { target: { value: 'DELETE' } })

    await waitFor(() => expect(lastThreadUrl()).toContain('action=DELETE'))
  })

  // Resolved to ids rather than filtered after the fetch: the row limit is applied by the
  // database, so post-filtering a 200-row page would show whichever fraction happened to match.
  it('resolves an entity NAME to ids and filters on those', async () => {
    await show()
    fireEvent.change(screen.getByPlaceholderText(/Search by entity name or ID/), { target: { value: 'Simulated' } })

    await waitFor(() => expect(lastThreadUrl()).toContain('entity_ids=dev-1'))
    expect(lastThreadUrl()).not.toContain('dev-2')
  })

  it('still matches on a raw id, so an id pasted from elsewhere works', async () => {
    await show()
    fireEvent.change(screen.getByPlaceholderText(/Search by entity name or ID/), { target: { value: 'gw-1' } })

    await waitFor(() => expect(lastThreadUrl()).toContain('entity_ids=gw-1'))
  })

  it('counts the active filters and clears them together', async () => {
    await show()
    fireEvent.change(screen.getByTitle(/Show only one kind of audit event/), { target: { value: 'UPDATE' } })
    fireEvent.change(screen.getByPlaceholderText(/Search by entity name or ID/), { target: { value: 'Press' } })

    const clear = await screen.findByTitle('Clear every filter')
    expect(clear.textContent).toContain('(2)')

    fireEvent.click(clear)
    await waitFor(() => expect(lastThreadUrl()).not.toContain('action='))
  })
})

describe('Digital Thread attribution', () => {
  it('shows the asset name alongside the id, not the id alone', async () => {
    await show()

    // The operator recognises the machine, not its UUID.
    expect(screen.getByText('Simulated_CNC_01')).toBeInTheDocument()
    // The id is a CopyableId button now, not a bracketed span -- it is the value carried out of
    // this page into a query or a ticket, and selecting it by hand was the only way to get it.
    expect(screen.getByRole('button', { name: /Copy entity id dev-1/ })).toBeInTheDocument()
  })

  it('offers the audit row its own id, distinct from the entity it touched', async () => {
    // Two edits a second apart on the same device are one entity id and two mutation ids, so
    // quoting the entity does not identify the change being talked about.
    await show()
    expect(screen.getByRole('button', { name: /Copy mutation id 1$/ })).toBeInTheDocument()
  })

  it('labels a user-made change as User', async () => {
    await show()
    expect(screen.getAllByText('User').length).toBeGreaterThan(0)
  })

  it('names the machine behind an unattributed change rather than leaving it blank', async () => {
    await show()
    // Previously this row would have rendered nothing at all for its author.
    expect(screen.getByText('Ingestion daemon')).toBeInTheDocument()
  })

  it('flags a row with no actor_source at all, so a real gap is visible', async () => {
    await show()
    // Rows written before 0005. After it, this should never appear -- which is the point of
    // making it loud rather than blank.
    expect(screen.getByText(/Unattributed/)).toBeInTheDocument()
  })
})

// The "Any device type" tag filter was a holdover and has been removed. Asserted negatively so
// it cannot drift back in: it also pulled a /api/v1/schemas fetch and the whole deviceTags
// derivation into a page that has no other use for either.
describe('Digital Thread — removed tag filter', () => {
  it('offers no device-type filter', async () => {
    await show()

    expect(screen.queryByText('Any device type')).not.toBeInTheDocument()
    expect(screen.queryByTitle(/carry this tag/i)).not.toBeInTheDocument()
  })

  it('leaves exactly three filter controls', async () => {
    await show()

    // Direct children only. Export and auto-refresh now fold into the right-hand end of this
    // same bar (`.filter-bar-actions`), and the refresh interval is a <select> -- so a
    // descendant selector would count a control that filters nothing and this guard would be
    // asserting the wrong thing.
    const controls = document.querySelectorAll('.filter-bar > select, .filter-bar > input')
    expect(controls.length).toBe(3)
  })

  it('folds export and auto-refresh into the filter bar rather than a row of their own', async () => {
    // What the export writes is decided by the filters, so the button belongs at the end of the
    // row that decides it. Removing the separate `.page-actions` row is also a whole band of
    // vertical space off the top of the page.
    await show()

    expect(document.querySelector('.page-actions')).toBeNull()
    const actions = document.querySelector('.filter-bar .filter-bar-actions')
    expect(actions).toBeTruthy()
    expect(within(actions).getByTitle('Download audit events as CSV')).toBeInTheDocument()
    expect(within(actions).getByTitle('Auto-refresh interval')).toBeInTheDocument()
  })

  it('no longer fetches schemas, which it needed only to derive tags', async () => {
    await show()

    expect(api.get.mock.calls.map(c => c[0]).some(u => u.startsWith('/api/v1/schemas'))).toBe(false)
  })

  it('still filters by name, which was sharing the id-restriction path with tags', async () => {
    await show()
    fireEvent.change(screen.getByPlaceholderText(/Search by entity name or ID/), { target: { value: 'Press' } })

    await waitFor(() => expect(lastThreadUrl()).toContain('entity_ids=dev-2'))
  })
})

/**
 * Timeline density.
 *
 * This page renders up to 200 audit rows and each is a bordered box: at 16px between boxes and
 * 14px of padding inside them, the separation was being paid for three times over -- margin,
 * border and padding all saying the same thing. jsdom does no layout, so the numbers are read
 * from App.css; the point of guarding them is that "tighten the spacing" is the kind of change
 * that gets reverted by the next person who finds the page cramped without knowing it holds 200
 * rows rather than a dozen.
 */
describe('Digital Thread timeline density', () => {
  const rule = (selector) =>
    APP_CSS.match(new RegExp(`\\n${selector.replace(/[.:()\\-]/g, '\\$&')} \\{([\\s\\S]*?)\\n\\}`))?.[1]

  it('keeps the gap between events to 10px', () => {
    expect(rule('.timeline-item')).toMatch(/margin-bottom:\s*10px/)
  })

  it('keeps the padding inside an event to 10px', () => {
    expect(rule('.timeline-content')).toMatch(/padding:\s*10px/)
  })
})
