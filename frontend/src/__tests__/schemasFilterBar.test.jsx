import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SchemasTab } from '../components/tabs/SchemasTab'
import { api } from '../api'

/**
 * The schema registry's filter bar and its scroll cap (issue #60).
 *
 * WHY THIS LIST AND NOT ANOTHER. The registry gains a row per PUBLISH, not per schema -- every
 * version a lineage has ever held is a row -- so it is the fastest-growing list on the page, and
 * it was the only list page with no filter bar at all. Its one narrowing control was an Archived
 * Versions toggle sitting in the card header among the primary actions, and nothing bounded its
 * height: a floor with a few versioned schemas pushed the metric catalog, the thing schemas are
 * built FROM, off the bottom of the page.
 *
 * THE TOGGLE IS NOW AN OPTION IN THE STATUS SELECT, which several assertions below are really
 * about. isCurrentSchema() is `status !== archived`, so that button was a status filter wearing a
 * different hat; keeping it beside a status dropdown would have been two controls able to
 * contradict each other, with no rule for which one wins.
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
 * The registry table, located by its card heading rather than by position.
 *
 * The same reason SchemasTab.test.jsx does it this way: the catalog and the registry have already
 * swapped places on this page once, and every positional selector silently pointed at the wrong
 * table when they did.
 */
const registryCard = () => [...document.querySelectorAll('.card-header .section-title')]
  .find(h => h.textContent.includes('Registered Schemas'))?.closest('.card')

const registryRows = () => [...(registryCard()?.querySelectorAll('tbody tr') || [])]
const registryNames = () => registryRows().map(r => r.querySelector('td')?.textContent.trim())

const searchBox = () => screen.getByLabelText('Search the schema registry')
const statusSelect = () => screen.getByLabelText('Filter schemas by lifecycle state')

const ready = async () => {
  await waitFor(() => expect(registryCard()).toBeTruthy())
  await waitFor(() => expect(registryRows().length).toBeGreaterThan(0))
}

// ---------------------------------------------------------------------------------------------
// The default view
// ---------------------------------------------------------------------------------------------

describe('schema registry default view', () => {
  /*
   * THE DEFAULT IS `current`, NOT `all`, and that is what preserves the behaviour the toggle had.
   * Superseded versions are history; interleaving them with the working set is what isCurrentSchema()
   * exists to prevent. Getting this wrong would silently double the length of every registry on
   * every floor -- the exact complaint issue #60 raised.
   */
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

    // The count survived losing the toggle's badge by moving into the option label.
    expect(within(statusSelect()).getByText('Archived (1)')).toBeInTheDocument()
    expect(within(statusSelect()).getByText('All versions (3)')).toBeInTheDocument()
  })

  it('caps the registry height and pins its header', async () => {
    renderTab()
    await ready()

    // The cap is the half of issue #60 that a filter cannot do: a registry narrowed to forty rows
    // is still forty rows, and the catalog below has to stay reachable.
    expect(registryCard().querySelector('.table-wrap')).toHaveClass('table-scroll')
  })
})

// ---------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------

describe('schema registry search', () => {
  it('narrows by schema name', async () => {
    renderTab()
    await ready()

    fireEvent.change(searchBox(), { target: { value: 'robot' } })

    expect(registryNames()).toEqual(['Robot_Arm_Profile'])
  })

  /*
   * UUID AND CHANGE DESCRIPTION ARE MATCHED TOO, which is a deliberate divergence from the metric
   * catalog's name-only search directly below on the same page. The catalog matches one field
   * because matching more would return rows whose reason for matching is invisible in the table.
   * Every field matched here IS a column of this table, so a hit can always be seen -- same rule,
   * different table. A schema also arrives from a log line as a UUID far more often than as a name.
   */
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

// ---------------------------------------------------------------------------------------------
// The status filter that replaced the toggle
// ---------------------------------------------------------------------------------------------

describe('schema registry status filter', () => {
  it('shows only drafts when Draft is selected', async () => {
    renderTab()
    await ready()

    fireEvent.change(statusSelect(), { target: { value: 'draft' } })

    expect(registryNames()).toEqual(['Robot_Arm_Profile'])
  })

  it('reveals superseded versions when Archived is selected', async () => {
    renderTab()
    await ready()

    fireEvent.change(statusSelect(), { target: { value: 'archived' } })

    expect(registryNames()).toEqual(['CNC_Mill_Profile_v1'])
  })

  it('shows every version, history included, under All versions', async () => {
    renderTab()
    await ready()

    fireEvent.change(statusSelect(), { target: { value: 'all' } })

    expect(registryNames()).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------------------------
// Clearing, and the count that says a list is narrowed
// ---------------------------------------------------------------------------------------------

describe('clearing schema filters', () => {
  it('offers Clear only while something is filtering, and counts what is on', async () => {
    renderTab()
    await ready()

    // `current` is the resting state, not a filter, so it must not count towards the badge --
    // a Clear button offered on arrival has nothing to clear.
    expect(screen.queryByTitle('Clear every filter')).toBeNull()

    fireEvent.change(searchBox(), { target: { value: 'profile' } })
    fireEvent.change(statusSelect(), { target: { value: 'all' } })
    expect(screen.getByTitle('Clear every filter')).toHaveTextContent('Clear filters (2)')

    fireEvent.click(screen.getByTitle('Clear every filter'))

    expect(searchBox()).toHaveValue('')
    expect(statusSelect()).toHaveValue('current')
    expect(registryNames()).not.toContain('CNC_Mill_Profile_v1')
  })

  /*
   * FILTERED OF TOTAL. A narrowed registry showing a bare count reads as a short registry, which
   * is the wrong thing to believe about a version history -- and the reader has no way to tell
   * that a filter is the reason.
   */
  it('reports the count as filtered-of-total only while narrowed', async () => {
    renderTab()
    await ready()

    fireEvent.change(statusSelect(), { target: { value: 'all' } })
    expect(registryCard().querySelector('.section-count')).toHaveTextContent('3')

    fireEvent.change(searchBox(), { target: { value: 'robot' } })
    expect(registryCard().querySelector('.section-count')).toHaveTextContent('1/3')
  })
})

// ---------------------------------------------------------------------------------------------
// Arriving from another page
// ---------------------------------------------------------------------------------------------

describe('arriving on a schema that a filter would hide', () => {
  /*
   * A navigation has already chosen its target, so a filter must not be able to veto it.
   * useArrivalSelection matches over every schema rather than the filtered list -- correctly --
   * which without this would open the drawer on a row the table is not showing. That was reachable
   * before this issue (arriving on a superseded version while the toggle hid archived versions);
   * a search box and a status filter multiply the ways in.
   */
  it('widens the status filter so the selected row is visible', async () => {
    renderTab({ initialSchemaId: '22222222-0000-4000-8000-000000000002' })
    await ready()

    await waitFor(() => expect(registryNames()).toContain('CNC_Mill_Profile_v1'))
    // Widened, NOT reset: resetting would restore `current`, which is the very filter that hides
    // the archived version the operator just navigated to.
    expect(statusSelect()).toHaveValue('all')
    expect(registryCard().querySelector('.row-selected')).toBeTruthy()
  })

  it('leaves the filter alone when the target is already visible', async () => {
    renderTab({ initialSchemaId: '33333333-0000-4000-8000-000000000003' })
    await ready()

    // A draft is `current`, so nothing needs widening and history stays out of the working list.
    await waitFor(() => expect(registryCard().querySelector('.row-selected')).toBeTruthy())
    expect(statusSelect()).toHaveValue('current')
    expect(registryNames()).not.toContain('CNC_Mill_Profile_v1')
  })
})
