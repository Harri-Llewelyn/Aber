/**
 * A Filters panel's lists open and close (FiltersPopover, FilterList): each is a section under a
 * heading that says what is chosen in it, one is open at a time, a section with a choice opens
 * first, an open list is at full height, and the panel's own checkboxes stay under the sections.
 * Then the two panels that hold several lists, Devices and the Audit Trail.
 */
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { FiltersPopover } from '../components/common/FiltersPopover'
import { FilterCheck, FilterList, SEARCH_AT, chosenWords } from '../components/common/FilterChecklist'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { AuditTrailTab } from '../components/tabs/AuditTrailTab'
import { api } from '../api'
import { filterList, openFiltersPanel, sectionHeading } from '../test/listFilters'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), listUserAccounts: vi.fn(() => Promise.resolve([])) } }
})

vi.mock('../lib/supabaseClient', () => ({
  supabase: { functions: { invoke: vi.fn() } }
}))

const KINDS = [
  { value: 'AREA', label: 'Areas', group: 'The plant' },
  { value: 'CELL', label: 'Cells', group: 'The plant' },
  { value: 'SCHEMA', label: 'Schemas', group: 'The model' },
]
const ACTIONS = Array.from({ length: SEARCH_AT + 4 }, (_, i) => ({ value: `A${i}`, label: `Action ${i}` }))
const PEOPLE = [{ value: 'p1', label: 'Ada Lovelace' }, { value: 'p2', label: 'Alan Turing' }]

/** A Filters panel as a page holds one: three lists, then a checkbox of its own. */
function Panel({ entity = [], action = [], people = [], lifecycle, onlyOne = false }) {
  const [e, setE] = useState(entity)
  const [a, setA] = useState(action)
  const [p, setP] = useState(people)
  const [l, setL] = useState(lifecycle)
  const [deleted, setDeleted] = useState(false)
  return (
    <FiltersPopover activeCount={0} onClear={() => {}}>
      {lifecycle && (
        <FilterList label="Lifecycle" plural="lifecycles" options={[{ value: 'active', label: 'Active' }, { value: 'archived', label: 'Archived' }]}
          value={l} defaultValue={['active']} onChange={setL} />
      )}
      <FilterList label="Entity" plural="kinds" options={KINDS} value={e} onChange={setE} />
      {/* A checkbox written between the lists still draws under the sections. */}
      <FilterCheck label="Show deleted entities" checked={deleted} onChange={setDeleted} count={2} />
      {!onlyOne && (
        <>
          <FilterList label="Action" plural="actions" options={ACTIONS} value={a} onChange={setA} tip="The database action." />
          <FilterList label="Changed by" plural="names" options={PEOPLE} value={p} onChange={setP} />
        </>
      )}
    </FiltersPopover>
  )
}

const heading = (label) => sectionHeading(label)
const expanded = () => [...document.querySelectorAll('.filter-section-head > button')]
  .filter(b => b.getAttribute('aria-expanded') === 'true')
  .map(b => b.querySelector('.group-heading-label').textContent)

describe('a Filters panel with several lists', () => {
  it('draws each list as a section under a heading, in order, the panel\'s checkbox under them', () => {
    render(<Panel />)
    const panel = openFiltersPanel()
    const sections = [...panel.querySelectorAll('.filter-section')]
    expect(sections.map(s => s.querySelector('.group-heading-label').textContent)).toEqual(['Entity', 'Action', 'Changed by'])
    // The checkbox comes after every section, though the page wrote it between them.
    const box = within(panel).getByRole('checkbox', { name: 'Show deleted entities 2' })
    expect(sections.every(s => s.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
    expect(box.closest('.filter-sections')).toBeNull()
    // A tip stays beside its list's heading, outside the button.
    expect(within(sections[1]).getByRole('button', { name: 'About action' }).closest('.group-heading')).toBeNull()
  })

  it('opens the first section when nothing is chosen, and one at a time', () => {
    render(<Panel />)
    openFiltersPanel()
    expect(expanded()).toEqual(['Entity'])
    expect(screen.getByRole('group', { name: 'Entity' })).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Action' })).toBeNull()

    fireEvent.click(heading('Action'))
    expect(expanded()).toEqual(['Action'])
    expect(screen.queryByRole('group', { name: 'Entity' })).toBeNull()
    expect(screen.getByRole('group', { name: 'Action' })).toBeInTheDocument()

    // Its own heading closes it, and then none is open.
    fireEvent.click(heading('Action'))
    expect(expanded()).toEqual([])
    expect(screen.queryByRole('group', { name: 'Action' })).toBeNull()
  })

  it('opens the first section with something chosen', () => {
    render(<Panel people={['p2']} action={['A1', 'A2']} />)
    openFiltersPanel()
    expect(expanded()).toEqual(['Action'])
  })

  it('does not count a list at its default as chosen', () => {
    render(<Panel lifecycle={['active']} people={['p1']} />)
    openFiltersPanel()
    expect(expanded()).toEqual(['Changed by'])
    // Its heading still says what it holds.
    expect(heading('Lifecycle')).toHaveAccessibleName('Lifecycle, Active')
  })

  it('names each heading with the list and what is chosen in it, and says whether it is open', () => {
    render(<Panel entity={['CELL']} action={['A1', 'A3']} />)
    openFiltersPanel()
    expect(heading('Entity')).toHaveAccessibleName('Entity, Cells')
    expect(heading('Action')).toHaveAccessibleName('Action, 2 chosen')
    expect(heading('Changed by')).toHaveAccessibleName('Changed by')
    // Drawn as "Entity · Cells": the dot is the GroupHeading's, as a count's is.
    expect(heading('Entity').querySelector('.group-heading-detail [aria-hidden="true"]')).toHaveTextContent('· Cells')
    expect(heading('Changed by').querySelector('.group-heading-detail')).toBeNull()

    expect(heading('Entity')).toHaveAttribute('aria-expanded', 'true')
    expect(heading('Action')).toHaveAttribute('aria-expanded', 'false')
    // Each heading controls the element its list is drawn in, which is hidden while it is shut.
    const body = (label) => document.getElementById(heading(label).getAttribute('aria-controls'))
    expect(body('Entity')).not.toHaveAttribute('hidden')
    expect(within(body('Entity')).getByRole('group', { name: 'Entity' })).toBeInTheDocument()
    expect(body('Action')).toHaveAttribute('hidden')
  })

  it('says what is chosen in a closed section as the choice changes', () => {
    render(<Panel />)
    openFiltersPanel()
    fireEvent.click(within(filterList('Changed by')).getByRole('checkbox', { name: 'Alan Turing' }))
    fireEvent.click(heading('Entity'))
    expect(heading('Changed by')).toHaveAttribute('aria-expanded', 'false')
    expect(heading('Changed by')).toHaveAccessibleName('Changed by, Alan Turing')
  })

  it('draws an open list at full height, with its search box over a long one', () => {
    render(<Panel />)
    const action = filterList('Action')
    expect(action.closest('.filter-dropdown-panel')).toBeNull()
    expect(action.closest('.filter-section-body')).toBeTruthy()
    expect(within(action.closest('.filter-section-body')).getByRole('searchbox', { name: 'Search action' })).toBeInTheDocument()
    expect(within(action).getAllByRole('checkbox')).toHaveLength(ACTIONS.length)
  })

  it('reaches each heading by Tab: a native button, so Enter and Space press it', () => {
    render(<Panel />)
    const panel = openFiltersPanel()
    for (const button of panel.querySelectorAll('.filter-section-head > .group-heading')) {
      expect(button.tagName).toBe('BUTTON')
      expect(button).toHaveAttribute('type', 'button')
      expect(button).not.toHaveAttribute('tabindex')
    }
    // The panel takes the focus to its first control as it opens: the first heading.
    expect(document.activeElement).toBe(heading('Entity'))
  })

  it('keeps the focus on the heading pressed, though the list it was in closes', () => {
    render(<Panel />)
    openFiltersPanel()
    const box = within(filterList('Entity')).getByRole('checkbox', { name: 'Areas' })
    box.focus()
    expect(document.activeElement).toBe(box)
    fireEvent.click(heading('Action'))
    expect(box.isConnected).toBe(false)
    expect(document.activeElement).toBe(heading('Action'))
    // Closing a section with its own heading leaves the focus there too.
    fireEvent.click(heading('Action'))
    expect(document.activeElement).toBe(heading('Action'))
  })

  it('still moves through a list with ↑ and ↓ inside a section', () => {
    render(<Panel />)
    openFiltersPanel()
    const list = filterList('Action')
    const search = screen.getByRole('searchbox', { name: 'Search action' })
    search.focus()
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    const boxes = within(list).getAllByRole('checkbox')
    expect(document.activeElement).toBe(boxes[0])
    fireEvent.keyDown(boxes[0], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(boxes[1])
  })

  it('brings a heading back into the panel\'s view when a list closing above moved it out', () => {
    render(<Panel />)
    const panel = openFiltersPanel()
    const scroller = panel.querySelector('.filters-popover-controls')
    scroller.style.overflowY = 'auto'
    scroller.scrollTop = 900
    scroller.getBoundingClientRect = () => ({ top: 100, bottom: 500, left: 0, right: 320, height: 400, width: 320 })
    // After Entity closes, Changed by's heading sits 60px above the scroller's top edge.
    const head = heading('Changed by').closest('.filter-section-head')
    head.getBoundingClientRect = () => ({ top: 40, bottom: 72, left: 0, right: 320, height: 32, width: 320 })
    fireEvent.click(heading('Changed by'))
    expect(scroller.scrollTop).toBe(840)
  })

  it('starts again each time the panel opens, and keeps nothing in the address', () => {
    window.history.replaceState({}, '', '/audit-trail?type=CELL')
    render(<Panel />)
    openFiltersPanel()
    fireEvent.click(heading('Changed by'))
    expect(expanded()).toEqual(['Changed by'])
    expect(window.location.search).toBe('?type=CELL')
    fireEvent.keyDown(document, { key: 'Escape' })
    openFiltersPanel()
    expect(expanded()).toEqual(['Entity'])
  })
})

describe('a Filters panel with one list', () => {
  it('draws no heading: the list\'s label, then the list', () => {
    render(<Panel onlyOne />)
    const panel = openFiltersPanel()
    expect(panel.querySelector('.filter-section')).toBeNull()
    expect(within(panel).queryByRole('button', { name: 'Entity' })).toBeNull()
    expect(within(panel).getByText('Entity')).toHaveClass('form-label')
    expect(within(panel).getByRole('group', { name: 'Entity' })).toBeInTheDocument()
  })
})

describe('chosenWords', () => {
  it('says nothing, the one value\'s name (its short words first), or how many', () => {
    expect(chosenWords([], KINDS)).toBeNull()
    expect(chosenWords(['CELL'], KINDS)).toBe('Cells')
    expect(chosenWords(['x'], [{ value: 'x', label: 'Long words', short: 'Short' }])).toBe('Short')
    expect(chosenWords(['gone'], KINDS)).toBe('gone')
    expect(chosenWords(['AREA', 'CELL'], KINDS)).toBe('2 chosen')
  })
})

// The pages whose Filters panel holds more than one list.

const GATEWAYS = [
  { gateway_id: 'gw-1', gateway_name: 'Line_A_Gateway', cell_id: 'cell-1', location_scope: 'cell', status: 'ONLINE', is_archived: false, devices: [] }
]
const CELLS = [{ cell_id: 'cell-1', cell_name: 'Assembly', is_archived: false }]
const DEVICE = {
  asset_id: 'aaaaaaaa-0000-4000-8000-000000000001', asset_name: 'CNC_01', sparkplug_id: 'devaaaaaaaa000040008000',
  status: 'ONLINE', is_quarantined: false, is_archived: false, active_gateway_id: 'gw-1', cell_id: null,
  location_scope: 'cell', effective_cell_id: 'cell-1', gateway_cell_id: 'cell-1', location_source: 'inherited',
  cell_mismatch: false, first_dbirth_at: '2026-07-27T12:00:00Z', created_at: '2026-07-20T12:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/gateways')) return Promise.resolve(GATEWAYS)
    if (path.startsWith('/api/v1/cells')) return Promise.resolve(CELLS)
    if (path.startsWith('/api/v1/devices')) return Promise.resolve([DEVICE])
    return Promise.resolve([])
  })
})

describe('the Devices page', () => {
  const show = async () => {
    render(<DevicesTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={() => true} />)
    await waitFor(() => expect(document.querySelector('.loading-wrap')).toBeNull())
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeInTheDocument())
  }

  it('makes its five lists sections, opening on Lifecycle at Active', async () => {
    window.history.replaceState({}, '', '/devices')
    await show()
    const panel = openFiltersPanel()
    expect([...panel.querySelectorAll('.filter-section .group-heading-label')].map(l => l.textContent))
      .toEqual(['Lifecycle', 'Type', 'Schema', 'Gateway', 'Cell'])
    expect(expanded()).toEqual(['Lifecycle'])
    expect(heading('Lifecycle')).toHaveAccessibleName('Lifecycle, Active')
  })

  it('opens the gateway an address chose, not Lifecycle at its default', async () => {
    window.history.replaceState({}, '', '/devices?gateway=gw-1')
    await show()
    openFiltersPanel()
    expect(expanded()).toEqual(['Gateway'])
    expect(heading('Gateway')).toHaveAccessibleName('Gateway, Line_A_Gateway')
  })
})

describe('the Audit Trail', () => {
  const show = async () => {
    render(<AuditTrailTab />)
    await waitFor(() => expect(api.get.mock.calls.some(c => c[0].startsWith('/api/v1/audit-trail'))).toBe(true))
  }

  it('makes Entity, Action and Changed by sections, with Show deleted entities under them', async () => {
    window.history.replaceState({}, '', '/audit-trail')
    await show()
    const panel = openFiltersPanel()
    expect([...panel.querySelectorAll('.filter-section .group-heading-label')].map(l => l.textContent))
      .toEqual(['Entity', 'Action', 'Changed by'])
    expect(expanded()).toEqual(['Entity'])
  })

  it('opens the action an address chose, and says so on its heading', async () => {
    window.history.replaceState({}, '', '/audit-trail?action=INSERT,DELETE')
    await show()
    openFiltersPanel()
    expect(expanded()).toEqual(['Action'])
    expect(heading('Action')).toHaveAccessibleName('Action, 2 chosen')
    expect(heading('Entity')).toHaveAccessibleName('Entity')
  })
})
