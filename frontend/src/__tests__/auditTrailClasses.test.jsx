/**
 * The Audit Trail's classes, counts and narrowing (0228, 0229). The legend's class entries are
 * toggles with their counts, at the right-hand end of their row, and in the address as `?class=`.
 * Entity and Action carry each value's count, and each list offers what can occur with the other
 * lists' choices by the map in constants.js: a possible value with no events is listed with 0, and
 * a chosen value that stops applying stays, marked.
 */
import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AuditTrailTab, MARKERS } from '../components/tabs/AuditTrailTab'
import { api } from '../api'
import { filterList, offered, openFiltersPanel, closePanel, valueName } from '../test/listFilters'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { listUserAccounts: vi.fn(() => Promise.resolve([])), get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const CELL = 'c0000000-0000-4000-8000-0000000000c1'
const BACKUP = 'b0000000-0000-4000-8000-0000000000b1'

const EVENTS = [
  {
    event_id: 2, entity_type: 'cells', entity_id: CELL, event_type: 'UPDATE', class: 'operational',
    timestamp: '2026-08-02T12:00:00Z', description: 'renamed', changed_by: null, actor_source: 'user',
    audit_domain: 'asset', old_data: { name: 'Line 1' }, new_data: { name: 'Line One' },
  },
  {
    event_id: 1, entity_type: 'backups', entity_id: BACKUP, event_type: 'BACKUP_TAKEN', class: 'configuration',
    timestamp: '2026-08-02T11:00:00Z', description: 'taken', changed_by: null, actor_source: 'service',
    audit_domain: 'security', old_data: null, new_data: { stamp: '20260802T110000Z' },
  },
]

/** What the server counts under the other filters: these two rows, and nothing else. */
const COUNTS = {
  class: { operational: 1, configuration: 1 },
  entity_type: { cells: 1, backups: 1 },
  action: { UPDATE: 1, BACKUP_TAKEN: 1 },
}

const page = (events, counts = COUNTS) => {
  const rows = [...events]
  rows.totalMatching = events.length
  rows.counts = counts
  return rows
}

const trailUrls = () => api.get.mock.calls.map(c => c[0]).filter(u => u.startsWith('/api/v1/audit-trail'))
const lastParams = () => new URL(trailUrls().at(-1), 'http://x').searchParams

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/audit-trail')
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/audit-trail')) return Promise.resolve(page(EVENTS))
    if (path.startsWith('/api/v1/cells')) return Promise.resolve([{ cell_id: CELL, cell_name: 'Line One' }])
    return Promise.resolve([])
  })
})

const show = async (userRole = 'Administrator') => {
  render(<AuditTrailTab userRole={userRole} />)
  await waitFor(() => expect(screen.getAllByText('Line One').length).toBeGreaterThan(0))
}

/** A class's toggle, by its label with or without its count. */
const toggle = (label) => screen.getByRole('button', {
  name: (name) => name === label || (name.startsWith(`${label} (`) && /^\d+\)$/.test(name.slice(label.length + 2))),
})

describe('the legend is the class filter', () => {
  it('draws each class as a toggle, Read after Lifecycle, each with its count', async () => {
    await show()
    const legend = screen.getByRole('group', { name: 'Classes' })
    const toggles = within(legend).getAllByRole('button')
    expect(toggles.map(b => b.textContent)).toEqual(
      ['Created (0)', 'Operational (1)', 'Configuration (1)', 'Lifecycle (0)', 'Read (0)'])
    for (const b of toggles) expect(b).toHaveAttribute('aria-pressed', 'false')
    // Each draws the class's own marker.
    expect(toggles.map(b => b.querySelector('.trail-node-mark').getAttribute('data-shape')))
      .toEqual(Object.values(MARKERS).map(m => m.shape))
  })

  it('sits at the right-hand end of its row, after Expand all and Collapse all', async () => {
    await show()
    const header = document.querySelector('.trail-header')
    expect(header.lastElementChild).toBe(screen.getByRole('group', { name: 'Classes' }))
    expect(header.firstElementChild).toHaveTextContent('Collapse all')
  })

  it('asks the server for the chosen classes, several at once, and none is every class', async () => {
    await show()
    expect(lastParams().has('class')).toBe(false)
    fireEvent.click(toggle('Read'))
    await waitFor(() => expect(lastParams().get('class')).toBe('read'))
    expect(toggle('Read')).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(toggle('Lifecycle'))
    // In the legend's order, whatever order they were chosen in.
    await waitFor(() => expect(lastParams().get('class')).toBe('lifecycle,read'))
    fireEvent.click(toggle('Read'))
    fireEvent.click(toggle('Lifecycle'))
    await waitFor(() => expect(lastParams().has('class')).toBe(false))
  })

  it('keeps the classes in the address, and opens a link that names them', async () => {
    window.history.replaceState(null, '', '/audit-trail?class=lifecycle,read')
    await show()
    expect(lastParams().get('class')).toBe('lifecycle,read')
    expect(toggle('Lifecycle')).toHaveAttribute('aria-pressed', 'true')
    expect(toggle('Created')).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle('Read'))
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('class')).toBe('lifecycle'))
  })

  it('counts on Clear filters, which clears the classes with the rest', async () => {
    await show()
    fireEvent.click(toggle('Read'))
    const clear = await screen.findByRole('button', { name: /Clear filters/ })
    fireEvent.click(clear)
    await waitFor(() => expect(lastParams().has('class')).toBe(false))
    expect(toggle('Read')).toHaveAttribute('aria-pressed', 'false')
  })

  it('asks for the counts with the first page only', async () => {
    await show()
    expect(lastParams().get('counts')).toBe('true')
  })

  it('draws the names alone where the server gave no counts', async () => {
    api.get.mockImplementation((path) => Promise.resolve(path.startsWith('/api/v1/audit-trail')
      ? page(EVENTS, null)
      : path.startsWith('/api/v1/cells') ? [{ cell_id: CELL, cell_name: 'Line One' }] : []))
    await show()
    expect(within(screen.getByRole('group', { name: 'Classes' })).getAllByRole('button').map(b => b.textContent))
      .toEqual(['Created', 'Operational', 'Configuration', 'Lifecycle', 'Read'])
  })
})

describe('Entity and Action count and narrow each other', () => {
  it('counts each value, a possible one with no events at 0', async () => {
    await show()
    const kinds = filterList('Entity')
    expect(within(kinds).getByRole('checkbox', { name: 'Cells 1' })).toBeTruthy()
    expect(within(kinds).getByRole('checkbox', { name: 'Areas 0' })).toBeTruthy()
    const actions = filterList('Action')
    expect(within(actions).getByRole('checkbox', { name: 'Backup taken 1' })).toBeTruthy()
    expect(within(actions).getByRole('checkbox', { name: 'Insert 0' })).toBeTruthy()
  })

  it('hides the actions none of the chosen kinds can have, and the kinds none of the chosen actions apply to', async () => {
    await show()
    fireEvent.click(within(filterList('Entity')).getByRole('checkbox', { name: valueName('Cells') }))
    await waitFor(() => expect(lastParams().get('entity_type')).toBe('CELL'))
    const actions = offered(filterList('Action'))
    expect(actions).toEqual(expect.arrayContaining(['Insert', 'Update', 'Delete', 'Proposal applied']))
    // A backup is never a cell's; Backup taken stays only because it occurred in the match.
    expect(actions).not.toContain('Backup requested')
    expect(actions).not.toContain('Role granted')
    closePanel()

    fireEvent.click(within(filterList('Entity')).getByRole('checkbox', { name: valueName('Cells') }))
    fireEvent.click(within(filterList('Action')).getByRole('checkbox', { name: valueName('Backup requested') }))
    await waitFor(() => expect(lastParams().get('action')).toBe('BACKUP_REQUESTED'))
    expect(offered(filterList('Entity'))).not.toContain('Areas')
    expect(offered(filterList('Entity'))).toContain('Backup jobs')
  })

  it('hides the actions the chosen classes cannot hold', async () => {
    await show()
    fireEvent.click(toggle('Read'))
    await waitFor(() => expect(lastParams().get('class')).toBe('read'))
    const actions = offered(filterList('Action'))
    for (const read of ['Logs read', 'Credential shown', 'Capture download issued', 'Exported']) {
      expect(actions).toContain(read)
    }
    expect(actions).not.toContain('Insert')
    expect(actions).not.toContain('Delete')
  })
})

describe('a chosen value no event can have with the others', () => {
  it('stays listed and says what it cannot occur with', async () => {
    api.get.mockImplementation((path) => Promise.resolve(path.startsWith('/api/v1/audit-trail')
      ? page([], { class: {}, entity_type: {}, action: {} })
      : []))
    window.history.replaceState(null, '', '/audit-trail?action=BACKUP_TAKEN&type=CELL')
    render(<AuditTrailTab userRole="Administrator" />)
    await waitFor(() => expect(trailUrls().length).toBeGreaterThan(0))
    openFiltersPanel()
    const taken = within(filterList('Action')).getByRole('checkbox', { name: 'Backup taken not with Cells 0' })
    expect(taken.checked).toBe(true)
    const cells = within(filterList('Entity')).getByRole('checkbox', { name: 'Cells not with Backup taken 0' })
    expect(cells.checked).toBe(true)
    // Not cleared by itself, and undone by unticking. Opening Entity closed Action's section, so the
    // box is found again in its reopened section.
    fireEvent.click(within(filterList('Action')).getByRole('checkbox', { name: 'Backup taken not with Cells 0' }))
    await waitFor(() => expect(lastParams().has('action')).toBe(false))
  })

  it('says which class a chosen action never holds', async () => {
    api.get.mockImplementation((path) => Promise.resolve(path.startsWith('/api/v1/audit-trail')
      ? page([], { class: {}, entity_type: {}, action: {} })
      : []))
    window.history.replaceState(null, '', '/audit-trail?action=INSERT&class=read')
    render(<AuditTrailTab userRole="Administrator" />)
    await waitFor(() => expect(trailUrls().length).toBeGreaterThan(0))
    expect(within(filterList('Action')).getByRole('checkbox', { name: 'Insert never Read 0' }).checked).toBe(true)
  })
})
