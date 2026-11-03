import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SchemasTab } from '../components/tabs/SchemasTab'
import { api } from '../api'
import { dropdownButton, openDropdown, pick } from '../test/listFilters'
import { schemaUrl } from '../routes'

/**
 * The schema registry's filter bar and its scroll cap. The registry gains a row per publish, so it
 * is the fastest-growing list on the page and needs a filter bar and a bounded height. Archived
 * versions are a value of the status filter rather than a separate toggle: Current is Active and
 * Draft, and two controls on one axis could contradict each other.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const SCHEMAS = [
  {
    schema_uuid: '11111111-0000-4000-8000-000000000001',
    schema_name: 'CNC_Mill_Profile', version: 2, status: 'active',
    change_description: 'Added spindle load sampling',
    parent_schema_id: null, schema_definition: { properties: {} }
  },
  {
    schema_uuid: '22222222-0000-4000-8000-000000000002',
    schema_name: 'CNC_Mill_Profile_v1', version: 1, status: 'archived',
    change_description: 'Initial release',
    parent_schema_id: null, schema_definition: { properties: {} }
  },
  {
    schema_uuid: '33333333-0000-4000-8000-000000000003',
    schema_name: 'Robot_Arm_Profile', version: 1, status: 'draft',
    change_description: 'Trialling joint torque metrics',
    parent_schema_id: null, schema_definition: { properties: {} }
  }
]

const routes = {
  '/api/v1/schemas': SCHEMAS,
  '/api/v1/metric-catalog': [],
  '/api/v1/metric-groups': [],
  '/api/v1/mtconnect-vocabulary': [],
  '/api/v1/iso22400-vocabulary': [],
  '/api/v1/opcua-vocabulary': [],
  '/api/v1/ashrae223-vocabulary': [],
  '/api/v1/gateways': [],
  '/api/v1/devices': []
}

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation((path) => {
    const hit = Object.keys(routes).find(r => path.startsWith(r))
    return Promise.resolve(hit ? routes[hit] : [])
  })
})

const renderTab = (props = {}) => render(
  <SchemasTab showToast={vi.fn()} hasPermission={() => true} onSelectSchema={vi.fn()} {...props} />
)

/**
 * The registry table, located by its card heading rather than by position, for the reason
 * SchemasTab.test.jsx does.
 */
const registryCard = () => [...document.querySelectorAll('.card-header .section-title')]
  .find(h => h.textContent.trim().startsWith('Schemas'))?.closest('.card')

const registryRows = () => [...(registryCard()?.querySelectorAll('tbody tr') || [])]
const registryNames = () => registryRows().map(r => r.querySelector('td')?.textContent.trim())

const searchBox = () => screen.getByLabelText('Search the schema registry')
/** The status filter: a dropdown whose button says what is chosen. */
const statusSelect = () => dropdownButton('Status')
/** A status value's checkbox in the open dropdown, by its words and count. */
const statusValue = (name) => within(openDropdown('Status')).getByRole('checkbox', { name })

const ready = async () => {
  await waitFor(() => expect(registryCard()).toBeTruthy())
  await waitFor(() => expect(registryRows().length).toBeGreaterThan(0))
}

// The default view

describe('schema registry default view', () => {
  /* The default is `current`, not `all`: superseded versions are history, and interleaving them
     would double the length of every registry. */
  it('hides superseded versions until they are asked for', async () => {
    renderTab()
    await ready()

    expect(registryNames()).toContain('CNC_Mill_Profile')
    expect(registryNames()).toContain('Robot_Arm_Profile')
    expect(registryNames()).not.toContain('CNC_Mill_Profile_v1')
  })

  it('offers the archived count without selecting it, so history is known to exist', async () => {
    renderTab()
    await ready()

    // The count survived losing the toggle's badge by moving beside the value.
    expect(statusSelect()).toHaveTextContent('Current')
    expect(statusValue('Archived 1').checked).toBe(false)
    expect(statusValue('Active 1').checked).toBe(true)
    expect(statusValue('Draft 1').checked).toBe(true)
  })

  it('scrolls inside its card, which fills the page', async () => {
    renderTab()
    await ready()

    // The table is the card's own scroller and the page does not scroll.
    expect(registryCard()).toHaveClass('card-fill')
    expect(registryCard().querySelector(':scope > .table-wrap')).toBeTruthy()
    expect(registryCard().querySelector('.table-scroll')).toBeNull()
    expect(registryCard().closest('.page-layout')).toHaveClass('page-fill')
  })
})

// Search

describe('schema registry search', () => {
  it('narrows by schema name', async () => {
    renderTab()
    await ready()

    fireEvent.change(searchBox(), { target: { value: 'robot' } })

    expect(registryNames()).toEqual(['Robot_Arm_Profile'])
  })

  /* UUID and change description are matched too, unlike the metric catalog's name-only search:
     every field matched here is a column of this table, so a hit can always be seen, and a schema
     arrives from a log line as a UUID more often than as a name. */
  it('narrows by UUID', async () => {
    renderTab()
    await ready()

    fireEvent.change(searchBox(), { target: { value: '33333333' } })

    expect(registryNames()).toEqual(['Robot_Arm_Profile'])
  })

  it('narrows by change description', async () => {
    renderTab()
    await ready()

    fireEvent.change(searchBox(), { target: { value: 'spindle load' } })

    expect(registryNames()).toEqual(['CNC_Mill_Profile'])
  })

  it('says what found nothing rather than rendering a blank table', async () => {
    renderTab()
    await ready()

    fireEvent.change(searchBox(), { target: { value: 'no-such-schema' } })

    // A registry that always has rows in it going blank reads as a failed load. "There are no
    // schemas" is a much more alarming thing to believe than "none match this search".
    expect(registryRows()).toHaveLength(0)
    const empty = registryCard().querySelector('.empty-state')
    expect(empty).toHaveTextContent('No schema matches')
    expect(empty).toHaveTextContent('no-such-schema')
  })
})

// The status filter

describe('schema registry status filter', () => {
  it('shows only drafts when Draft is the one chosen', async () => {
    renderTab()
    await ready()

    pick('Status', 'draft')

    expect(registryNames()).toEqual(['Robot_Arm_Profile'])
  })

  it('reveals superseded versions when Archived is the one chosen', async () => {
    renderTab()
    await ready()

    pick('Status', 'archived')

    expect(registryNames()).toEqual(['CNC_Mill_Profile_v1'])
  })

  it('shows every version, history included, with every status chosen', async () => {
    renderTab()
    await ready()

    pick('Status', 'active', 'draft', 'archived')

    expect(registryNames()).toHaveLength(3)
    expect(statusSelect()).toHaveTextContent('Any status')
  })

  it('takes two statuses, and keeps them in the address', async () => {
    renderTab()
    await ready()

    pick('Status', 'draft', 'archived')

    expect(registryNames().sort()).toEqual(['CNC_Mill_Profile_v1', 'Robot_Arm_Profile'])
    expect(statusSelect()).toHaveTextContent('2 statuses')
    expect(new URLSearchParams(window.location.search).get('status')).toBe('draft,archived')
  })

  it('opens a link written with one status, or with an old Current or All', async () => {
    window.history.replaceState(null, '', '/schemas?status=archived')
    const first = renderTab()
    await ready()
    expect(registryNames()).toEqual(['CNC_Mill_Profile_v1'])
    first.unmount()

    window.history.replaceState(null, '', '/schemas?status=all')
    renderTab()
    await ready()
    expect(registryNames()).toHaveLength(3)
    expect(new URLSearchParams(window.location.search).get('status')).toBe('active,draft,archived')
  })
})

// Clearing, and the count that says a list is narrowed

describe('clearing schema filters', () => {
  it('offers Clear only while something is filtering, and counts what is on', async () => {
    renderTab()
    await ready()

    // `current` is the resting state, not a filter, so it must not count towards the badge --
    // a Clear button offered on arrival has nothing to clear.
    expect(screen.queryByRole('button', { name: /Clear filters/ })).toBeNull()

    fireEvent.change(searchBox(), { target: { value: 'profile' } })
    pick('Status', 'active', 'draft', 'archived')
    expect(screen.getByRole('button', { name: /Clear filters/ })).toHaveTextContent('Clear filters (2)')

    fireEvent.click(screen.getByRole('button', { name: /Clear filters/ }))

    expect(searchBox()).toHaveValue('')
    expect(statusSelect()).toHaveTextContent('Current')
    expect(registryNames()).not.toContain('CNC_Mill_Profile_v1')
  })

  /* No count on the card heading, resting or searching: the status values say how many versions
     each holds. */
  it('puts no count on the card heading, while the status values keep theirs', async () => {
    renderTab()
    await ready()

    const count = () => registryCard().querySelector('.card-header .section-count')
    expect(count()).toBeNull()

    fireEvent.change(searchBox(), { target: { value: 'robot' } })
    expect(count()).toBeNull()
    // Counted among what the search leaves: the draft Robot_Arm_Profile alone.
    expect(statusValue('Draft 1')).toBeInTheDocument()
    expect(statusValue('Active 0')).toBeInTheDocument()
  })
})

// Arriving from another page

describe('arriving on a schema that a filter would hide', () => {
  /* A navigation has already chosen its target, so a filter must not veto it: useArrivalSelection
     matches over every schema, and the filter is widened so the selected row is visible. */
  it('widens the status filter so the selected row is visible', async () => {
    window.history.replaceState(null, '', schemaUrl('22222222-0000-4000-8000-000000000002'))
    renderTab()
    await ready()

    await waitFor(() => expect(registryNames()).toContain('CNC_Mill_Profile_v1'))
    // Widened, NOT reset: resetting would restore Current, which is the very filter that hides
    // the archived version the operator just navigated to. Every status chosen reads Any status.
    expect(statusSelect()).toHaveTextContent('Any status')
    expect(registryCard().querySelector('.row-selected')).toBeTruthy()
  })

  it('leaves the filter alone when the target is already visible', async () => {
    window.history.replaceState(null, '', schemaUrl('33333333-0000-4000-8000-000000000003'))
    renderTab()
    await ready()

    // A draft is `current`, so nothing needs widening and history stays out of the working list.
    await waitFor(() => expect(registryCard().querySelector('.row-selected')).toBeTruthy())
    expect(statusSelect()).toHaveTextContent('Current')
    expect(registryNames()).not.toContain('CNC_Mill_Profile_v1')
  })
})
