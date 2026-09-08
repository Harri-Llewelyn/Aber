/**
 * Digital Thread filter bar and actor attribution.
 *
 * The attribution half exists because `changed_by IS NULL` was the normal case, not an anomaly:
 * on a stack with one simulated gateway and one device the audit table was taking 175 anonymous
 * rows/hour, of which every one was either a heartbeat stamp or a write where `old_data =
 * new_data`. archived migration 0005 stops recording those and stamps `actor_source` on what remains, so
 * a blank author now means a genuine gap rather than "a machine did something routine".
 */
import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { DigitalThreadTab, classifyEvent, diffFields, tickFormatter, shortId, timeWindow } from '../components/tabs/DigitalThreadTab'
import { api } from '../api'

/*
 * NEWLINES NORMALISED ON READ, because `cssRule()` below matches multi-line SELECTORS and its
 * patterns are written with `\n`.
 *
 * .gitattributes normalises this file to LF in the repository and checks it out with the
 * platform's native ending, so on Windows it arrives as CRLF and every one of those patterns
 * silently matches nothing -- `cssRule()` returns undefined and the failure reads as
 * ".toMatch() expects to receive a string". Three guards here were failing for that reason alone,
 * on a working tree whose CSS was correct, while CI on Linux passed.
 *
 * Normalising is the right fix rather than teaching each pattern about \r?\n: the guards are about
 * what the rules SAY, and line endings are not part of that.
 */
const APP_CSS = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8').replace(/\r\n/g, '\n')

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

/**
 * These fixtures are dated 2026-08-02 and are never refreshed, which is deliberate: the page's
 * default range is All time, and a suite that only passed while its fixtures were recent would
 * be asserting the calendar rather than the component.
 */
const EVENTS = [
  {
    event_id: 1, entity_type: 'devices', entity_id: 'dev-1', event_type: 'UPDATE',
    timestamp: '2026-08-02T12:00:00Z', description: 'Action UPDATE on devices [dev-1]',
    changed_by: 'user-uuid-1', actor_source: 'user',
    old_data: { id: 'dev-1', name: 'Simulated_CNC_01', status: 'OFFLINE', last_heartbeat: '2026-08-02T11:59:00Z' },
    new_data: { id: 'dev-1', name: 'Simulated_CNC_01', status: 'ONLINE',  last_heartbeat: '2026-08-02T12:00:00Z' }
  },
  {
    event_id: 2, entity_type: 'gateways', entity_id: 'gw-1', event_type: 'INSERT',
    timestamp: '2026-08-02T11:00:00Z', description: 'Action INSERT on gateways [gw-1]',
    changed_by: null, actor_source: 'ingestion',
    old_data: null, new_data: { id: 'gw-1', name: 'Virtual_Gateway_NodeRED', status: 'ONLINE' }
  },
  // A cell that no longer exists, which is what a DELETE means: it is absent from CELLS above
  // because /api/v1/cells cannot return a row that was deleted. The join can therefore never
  // name it -- but its final snapshot can, which is the second fall of the resolver.
  {
    event_id: 3, entity_type: 'cells', entity_id: 'cell-gone', event_type: 'DELETE',
    timestamp: '2026-08-02T10:00:00Z', description: 'Action DELETE on cells [cell-gone]',
    changed_by: null, actor_source: null,
    old_data: { id: 'cell-gone', name: 'Decommissioned Line' }, new_data: null
  },
  // A schema rebinding, which is what separates the amber class from the blue one. There is no
  // SCHEMA action in the database -- it is an UPDATE that touched `schema_id` -- so this row is
  // the only thing standing between the classifier and a timeline with three colours.
  {
    event_id: 4, entity_type: 'devices', entity_id: 'dev-2', event_type: 'UPDATE',
    timestamp: '2026-08-02T09:00:00Z', description: 'Action UPDATE on devices [dev-2]',
    changed_by: 'user-uuid-1', actor_source: 'user',
    old_data: { id: 'dev-2', name: 'Press_02', schema_id: null },
    new_data: { id: 'dev-2', name: 'Press_02', schema_id: 'schema-9' }
  },
  // Archiving is likewise an UPDATE, distinguished only by a boolean that rose to true.
  {
    event_id: 5, entity_type: 'devices', entity_id: 'dev-2', event_type: 'UPDATE',
    timestamp: '2026-08-02T08:00:00Z', description: 'Action UPDATE on devices [dev-2]',
    changed_by: 'user-uuid-1', actor_source: 'user',
    old_data: { id: 'dev-2', name: 'Press_02', is_archived: false },
    new_data: { id: 'dev-2', name: 'Press_02', is_archived: true }
  },
  // Nameable from nowhere: absent from DEVICES, and carrying no snapshot to recover a name from.
  // The third fall -- a truncated id -- exists for exactly this row.
  {
    event_id: 6, entity_type: 'devices', entity_id: '99999999-8888-7777-6666-555555555555',
    event_type: 'UPDATE', timestamp: '2026-08-02T07:00:00Z', description: 'Action UPDATE',
    changed_by: null, actor_source: 'service', old_data: null, new_data: null
  }
]
const ENTITY_COUNT = new Set(EVENTS.map(e => e.entity_id)).size

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

/**
 * Ready when the lanes are drawn.
 *
 * This used to wait on a row's description text, which the swimlane no longer prints -- a lane is
 * one ASSET and a description belongs to one EVENT, so it moved into the marker's tooltip and the
 * drawer. The lane label is the equivalent signal that the page has resolved its joins.
 */
const show = async () => {
  render(<DigitalThreadTab />)
  await waitFor(() => expect(screen.getByText('Simulated_CNC_01')).toBeInTheDocument())
}

/**
 * Render with purged assets INCLUDED.
 *
 * Hiding them is the page default (issue #44). Several suites below are ABOUT the two purged
 * entities in the fixture -- `cell-gone` carries the deleted-name fallback and the only DELETE,
 * and the orphan uuid on event 6 is the only entity with no name anywhere -- so for those the
 * toggle is the subject of the test rather than incidental setup.
 *
 * Turning it on here rather than relaxing each assertion is deliberate: the alternative was to
 * expect the smaller numbers, which would have quietly converted tests about three sections and a
 * DELETE marker into tests about two sections and no DELETE.
 */
const showAll = async () => {
  await show()
  fireEvent.click(screen.getByRole('button', { name: /Show deleted assets/i }))
  await waitFor(() => expect(screen.getByTitle('Clear every filter')).toBeInTheDocument())
}

/** Every marker on the timeline, in DOM order. */
const nodes = () => [...document.querySelectorAll('.dt-node')]
const nodeFor = (pattern) => screen.getAllByRole('button', { name: pattern })[0]

/** Open the drawer on one event. */
const selectEvent = async (pattern) => {
  fireEvent.click(nodeFor(pattern))
  await waitFor(() => expect(document.querySelector('.context-panel-open')).toBeTruthy())
}

const rangeSelect = () => screen.getByTitle('Limit the timeline to a time range')

describe('Digital Thread filter bar', () => {
  it('offers entity type, entity name, event type and time range, in the shared filter bar', async () => {
    await show()

    // The same `.filter-bar` the Gateways and Devices pages use, not a row of controls wedged
    // into the section header.
    expect(document.querySelector('.filter-bar')).toBeTruthy()
    expect(screen.getByTitle(/Show only events against one kind of asset/)).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/Search by entity name or ID/)).toBeInTheDocument()
    // The wording is load-bearing, not incidental. This control filters `digital_thread.action`,
    // while the coloured markers below it show a DERIVED classification -- two taxonomies on one
    // screen, which issue #37 reported as a single one with a missing option. See
    // digitalThreadActionFilter.test.jsx.
    expect(screen.getByTitle(/Filter by the database action/)).toBeInTheDocument()
    expect(rangeSelect()).toBeInTheDocument()
  })

  it('filters by entity type', async () => {
    await show()
    fireEvent.change(screen.getByTitle(/Show only events against one kind of asset/), { target: { value: 'GATEWAY' } })

    await waitFor(() => expect(lastThreadUrl()).toContain('entity_type=GATEWAY'))
  })

  it('filters by audit event type', async () => {
    await show()
    fireEvent.change(screen.getByTitle(/Filter by the database action/), { target: { value: 'DELETE' } })

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

  it('counts the active filters and clears them together, the time range included', async () => {
    await show()
    fireEvent.change(screen.getByTitle(/Filter by the database action/), { target: { value: 'UPDATE' } })
    fireEvent.change(screen.getByPlaceholderText(/Search by entity name or ID/), { target: { value: 'Press' } })
    fireEvent.change(rangeSelect(), { target: { value: '7d' } })

    const clear = await screen.findByTitle('Clear every filter')
    expect(clear.textContent).toContain('(3)')

    fireEvent.click(clear)
    await waitFor(() => expect(lastThreadUrl()).not.toContain('action='))
    expect(lastThreadUrl()).not.toContain('since=')
    expect(rangeSelect().value).toBe('all')
  })
})

/**
 * The time range.
 *
 * PUSHED DOWN, and that is the whole point of the control rather than an implementation detail.
 * `limit=200` is applied by the database to rows ordered newest-first, so a window filtered in
 * the browser would spend its entire row budget on events outside the window and then discard
 * them -- "Last 30 Days" could legitimately render fewer events than "Last 24 Hours". These
 * assert on the URL because that is where the difference is observable.
 */
describe('Digital Thread time range', () => {
  it('defaults to All time and sends no bound at all', async () => {
    await show()

    expect(rangeSelect().value).toBe('all')
    expect(lastThreadUrl()).not.toContain('since=')
    expect(lastThreadUrl()).not.toContain('until=')
  })

  /*
    The default matters more here than a default usually does. The page's main entry path is a
    handover -- "Digital Thread" on a device row -- and under any rolling default an asset whose
    last edit was at install time answers that click with an empty timeline. These fixtures are
    two weeks old and must still render.
  */
  it('renders events far older than any rolling window, because the default is unbounded', async () => {
    await showAll()
    expect(nodes().length).toBe(EVENTS.length)
  })

  it('sends a since bound for a preset, computed at fetch time', async () => {
    await show()
    fireEvent.change(rangeSelect(), { target: { value: '24h' } })

    await waitFor(() => expect(lastThreadUrl()).toContain('since='))
    const since = new URL(lastThreadUrl(), 'http://x').searchParams.get('since')
    const ageMs = Date.now() - new Date(since).getTime()
    // 24 hours, give or take the time the test took to run.
    expect(ageMs).toBeGreaterThan(23.9 * 60 * 60 * 1000)
    expect(ageMs).toBeLessThan(24.1 * 60 * 60 * 1000)
  })

  it('sends both bounds for a custom range, and only shows the pickers in that mode', async () => {
    await show()
    expect(screen.queryByLabelText('Range start')).toBeNull()

    fireEvent.change(rangeSelect(), { target: { value: 'custom' } })
    fireEvent.change(screen.getByLabelText('Range start'), { target: { value: '2026-08-01T09:30' } })
    fireEvent.change(screen.getByLabelText('Range end'), { target: { value: '2026-08-01T09:45' } })

    await waitFor(() => expect(lastThreadUrl()).toContain('until='))
    const params = new URL(lastThreadUrl(), 'http://x').searchParams
    // LOCAL, not UTC: an operator choosing 09:30 means 09:30 where they are standing. The end
    // bound is widened to the end of that MINUTE, or everything during 09:45 would be excluded by
    // a range the operator read as including it.
    expect(new Date(params.get('since')).getTime())
      .toBe(new Date('2026-08-01T09:30:00.000').getTime())
    expect(new Date(params.get('until')).getTime())
      .toBe(new Date('2026-08-01T09:45:59.999').getTime())
  })

  it('takes a window narrower than a day, which the date pickers could not express', async () => {
    /*
     * THE WHOLE POINT OF THE SUB-DAY ZOOM WORK. `type="date"` bounded the narrowest
     * expressible window at 24 hours, so on a stack commissioned this morning "All time" and
     * "today" drew the same picture -- and a commissioning burst stayed in a few pixel columns
     * however the page was filtered.
     */
    await show()
    fireEvent.change(rangeSelect(), { target: { value: 'custom' } })
    fireEvent.change(screen.getByLabelText('Range start'), { target: { value: '2026-08-01T16:11' } })
    fireEvent.change(screen.getByLabelText('Range end'), { target: { value: '2026-08-01T16:12' } })

    await waitFor(() => expect(lastThreadUrl()).toContain('until='))
    const params = new URL(lastThreadUrl(), 'http://x').searchParams
    const spanMs = new Date(params.get('until')) - new Date(params.get('since'))
    expect(spanMs).toBeLessThan(2 * 60 * 1000)
    expect(spanMs).toBeGreaterThan(0)
  })

  it('still understands a date-only bound, tested on the function rather than the input', () => {
    /*
     * A `datetime-local` input REFUSES a date-only value -- the browser and jsdom both leave the
     * field empty rather than accept `2026-08-01` -- so this cannot be driven through the DOM, and
     * a test that tried would be asserting that the input rejected it.
     *
     * The branch is kept because `timeWindow` is an exported pure function with its own contract:
     * a bare date means the whole of that day. It is no longer reachable from this page's controls,
     * which is why it is tested here and not through them.
     */
    const { since, until } = timeWindow('custom', '2026-08-01', '2026-08-03')
    expect(new Date(since).getTime()).toBe(new Date('2026-08-01T00:00:00.000').getTime())
    expect(new Date(until).getTime()).toBe(new Date('2026-08-03T23:59:59.999').getTime())
  })

  it('offers the sub-day presets, with All time still the default', async () => {
    await show()
    const values = [...rangeSelect().querySelectorAll('option')].map(o => o.value)

    expect(values).toContain('15m')
    expect(values).toContain('1h')
    // All time stays first and stays selected: most arrivals here are a handover from a device
    // row, and a rolling default would answer that click with an empty timeline.
    expect(values[0]).toBe('all')
    expect(rangeSelect().value).toBe('all')
  })

  it('asks for a 15-minute window when that preset is chosen', async () => {
    await show()
    fireEvent.change(rangeSelect(), { target: { value: '15m' } })

    await waitFor(() => expect(lastThreadUrl()).toContain('since='))
    const since = new URL(lastThreadUrl(), 'http://x').searchParams.get('since')
    const ageMs = Date.now() - new Date(since).getTime()
    expect(ageMs).toBeGreaterThan(14.5 * 60 * 1000)
    expect(ageMs).toBeLessThan(15.5 * 60 * 1000)
  })

  it('says the range is why the timeline is empty, rather than blaming the filters', async () => {
    api.get.mockImplementation((path) => {
      if (path.startsWith('/api/v1/digital-thread')) return Promise.resolve([])
      if (path.startsWith('/api/v1/devices'))  return Promise.resolve(DEVICES)
      return Promise.resolve([])
    })
    render(<DigitalThreadTab />)
    await waitFor(() => expect(screen.getByText(/No digital thread events/)).toBeInTheDocument())

    fireEvent.change(rangeSelect(), { target: { value: '24h' } })
    await waitFor(() => expect(screen.getByText(/Widen it, or switch back to All time/)).toBeInTheDocument())
  })

  // A source guard on the pushdown itself. The component can only be observed asking for a
  // window; that the API turns the ask into a SQL predicate rather than a client-side filter is
  // the part that would be silently reverted, and the symptom would be a wrong row count rather
  // than an error.
  //
  // THE MECHANISM MOVED AND THE GUARD FOLLOWED IT. The bounds used to be `query.gte(...)` on a
  // PostgREST builder; archived migration 0039 made this page an RPC, because the deleted-asset filter is
  // an anti-join PostgREST cannot express. They are arguments now. What must stay true is
  // unchanged: the window reaches the database, and is not applied to rows the limit already cut.
  it('applies the bounds as arguments to the page RPC, not as a client-side filter', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../api.js'), 'utf8')
    expect(source).toMatch(/supabase\.rpc\('digital_thread_page'/)
    expect(source).toMatch(/p_since: since \|\| null/)
    expect(source).toMatch(/p_until: until \|\| null/)
    // And the filter this whole change exists for: it is a predicate, so the row budget is spent
    // on rows that will be shown.
    expect(source).toMatch(/p_include_purged: includePurged/)
  })
})

/**
 * The swimlanes.
 *
 * One lane per audited entity, ordered busiest first. Stable ordering is asserted because lanes
 * that reshuffle between refreshes are worse than a flat list: the marker under the cursor is
 * not the one that gets clicked.
 */
describe('Digital Thread swimlanes', () => {
  it('draws one lane per entity, not one row per event', async () => {
    await showAll()

    expect(document.querySelectorAll('.dt-lane:not(.dt-axis)').length).toBe(ENTITY_COUNT)
    expect(nodes().length).toBe(EVENTS.length)
  })

  it('orders lanes by activity within a section, busiest first', async () => {
    await show()
    // Devices is the last section; dev-2 has two events to dev-1's one.
    const deviceLanes = [...document.querySelectorAll('.dt-lane:not(.dt-axis)')]
      .map(l => l.querySelector('.dt-lane-name').textContent)
    expect(deviceLanes.indexOf('Press_02')).toBeLessThan(deviceLanes.indexOf('Simulated_CNC_01'))
  })

  it('labels a lane with the asset name rather than its UUID', async () => {
    await show()

    // The operator recognises the machine, not its UUID.
    expect(screen.getByText('Simulated_CNC_01')).toBeInTheDocument()
    // The 36-character copy button that used to sit here has gone: it left no room for the name
    // that made the lane recognisable. The id is still one click away, and still copyable.
    expect(screen.queryByRole('button', { name: /Copy entity id dev-1/ })).toBeNull()
    await selectEvent(/UPDATE on Simulated_CNC_01/)
    expect(screen.getByRole('button', { name: /Copy entity id dev-1/ })).toBeInTheDocument()
  })

  /*
    Name resolution, all three falls.

    The second one is the one that earns its keep. A deleted entity is gone from /api/v1/cells, so
    the join can NEVER resolve it -- but its final audit snapshot holds the name it had when it
    died, which is the name an operator remembers it by. Without that fall, every deleted asset on
    this page is a UUID.
  */
  it('resolves a name by joining against the live entities', async () => {
    await show()
    expect(screen.getByText('Simulated_CNC_01')).toBeInTheDocument()
  })

  it('recovers a deleted entity name from its audit snapshot, and says it is deleted', async () => {
    await showAll()
    const lane = screen.getByText('Decommissioned Line').closest('.dt-lane')
    expect(lane).toBeTruthy()
    // Flagged, or the name reads as a live asset that simply is not in the list.
    expect(within(lane).getByText('deleted')).toBeInTheDocument()
  })

  it('falls back to a truncated id only when no name exists anywhere', async () => {
    await showAll()
    // Neither joinable nor recoverable from a snapshot: event 6 carries no payload at all.
    expect(screen.getByText('99999999…5555')).toBeInTheDocument()
    // Not flagged deleted -- nothing says it was; it is merely unidentifiable.
    const lane = screen.getByText('99999999…5555').closest('.dt-lane')
    expect(within(lane).queryByText('deleted')).toBeNull()
  })

  /*
    Sections.

    The cap is applied BEFORE the cut, not per section: fifteen lanes each would be forty-five rows
    on a page whose point is that one asset's history is comparable against its neighbours' without
    scrolling.
  */
  it('groups lanes under Cells, Gateways and Devices, in containment order', async () => {
    await showAll()
    const headings = [...document.querySelectorAll('.dt-section .dt-section-name')]
      .map(h => h.textContent)
    expect(headings).toEqual(['Cells', 'Gateways', 'Devices'])
  })

  it('counts what it draws in each heading', async () => {
    await showAll()
    const counts = [...document.querySelectorAll('.dt-section')]
      .map(s => s.textContent.replace(/[^0-9]/g, ''))
    // One cell, one gateway, three devices (dev-1, dev-2, the unnamed one).
    expect(counts).toEqual(['1', '1', '3'])
  })

  it('omits a section with nothing in it rather than drawing an empty heading', async () => {
    await show()
    fireEvent.change(screen.getByTitle(/Show only events against one kind of asset/), { target: { value: 'DEVICE' } })

    // The fixture is unfiltered by the mock, so this asserts the grouping, not the query: with
    // only device lanes present, Cells and Gateways must not appear as empty headings.
    await waitFor(() => expect(lastThreadUrl()).toContain('entity_type=DEVICE'))
    const headings = [...document.querySelectorAll('.dt-section .dt-section-name')].map(h => h.textContent)
    expect(headings).not.toContain('Cells (0)')
  })

  it('positions a marker along the track rather than stacking events vertically', async () => {
    await show()
    const lefts = nodes().map(n => n.style.left)
    expect(lefts.every(l => l.startsWith('calc('))).toBe(true)
    // Not every event at the same offset -- that would be a list wearing a timeline's clothes.
    expect(new Set(lefts).size).toBeGreaterThan(1)
  })

  it('folds the long tail of lanes behind a toggle', async () => {
    /*
     * FORTY LANES, against a cap of thirty. This used to build twenty against a cap of fifteen --
     * which stopped demonstrating anything once the cap moved, because twenty no longer overflows.
     *
     * The bulk assets are also returned by the devices lookup, so none of them reads as purged.
     * Without that they would all be hidden by default and the page would draw nothing at all,
     * making this a test of the purge filter wearing a lane-fold test's clothes.
     */
    const many = Array.from({ length: 40 }, (_, i) => ({
      event_id: 100 + i, entity_type: 'devices', entity_id: `bulk-${i}`, event_type: 'UPDATE',
      timestamp: '2026-08-02T12:00:00Z', description: 'x', changed_by: null, actor_source: 'service'
    }))
    const bulkDevices = Array.from({ length: 40 }, (_, i) => ({
      asset_id: `bulk-${i}`, asset_name: `Bulk_${i}`, last_birth_metrics: []
    }))
    api.get.mockImplementation((path) => {
      if (path.startsWith('/api/v1/digital-thread')) return Promise.resolve(many)
      if (path.startsWith('/api/v1/devices')) return Promise.resolve(bulkDevices)
      return Promise.resolve([])
    })
    render(<DigitalThreadTab />)

    const toggle = await screen.findByText(/Show all lanes \(\+10\)/)
    expect(document.querySelectorAll('.dt-lane:not(.dt-axis)').length).toBe(30)

    fireEvent.click(toggle)
    await waitFor(() => expect(document.querySelectorAll('.dt-lane:not(.dt-axis)').length).toBe(40))
  })
})

/**
 * The time axis.
 *
 * ONE RULE, asserted directly rather than through the DOM: two adjacent ticks must never print the
 * same string. Every band exists because the coarser format above it collapses at that span --
 * five ticks across ten minutes all read `14:03`, and five across a 31-day span all read
 * `Aug 2026`. A label that repeats is not an axis.
 */
describe('Digital Thread time axis', () => {
  const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR

  /** The five labels the component would draw for a span ending now. */
  const labels = (spanMs) => {
    const format = tickFormatter(spanMs)
    const end = new Date('2026-08-17T14:03:07Z').getTime()
    return [0, 0.25, 0.5, 0.75, 1].map(f => format(new Date(end - spanMs + spanMs * f)))
  }
  const allDistinct = (spanMs) => new Set(labels(spanMs)).size === 5

  it('shows seconds under ten minutes, where the minute alone repeats', () => {
    expect(labels(5 * MIN)[0]).toMatch(/\d{1,2}:\d{2}:\d{2}/)
    expect(allDistinct(5 * MIN)).toBe(true)
  })

  it('drops to minutes within a day', () => {
    expect(labels(6 * HOUR)[0]).not.toMatch(/\d{1,2}:\d{2}:\d{2}/)
    expect(allDistinct(6 * HOUR)).toBe(true)
  })

  it('brings in the date past a day, keeping the clock while it still separates ticks', () => {
    expect(labels(2 * DAY)[0]).toMatch(/\d{1,2}:\d{2}/)
    expect(allDistinct(2 * DAY)).toBe(true)
  })

  it('drops the clock once the date alone is enough', () => {
    expect(labels(20 * DAY)[0]).not.toMatch(/\d{1,2}:\d{2}/)
    expect(allDistinct(20 * DAY)).toBe(true)
  })

  /*
    The band that catches people out. `MMM YYYY` is the obvious label past thirty days and it is
    the one that breaks: five ticks across a 31-day span sit about eight days apart and all read
    the same month. An ISO date never repeats at any span this rule covers.
  */
  it('never repeats a label at any span, including the ones just past a month', () => {
    for (const span of [31 * DAY, 45 * DAY, 90 * DAY, 182 * DAY, 400 * DAY, 3 * 365 * DAY]) {
      expect(allDistinct(span), `${span / DAY} days produced a repeated tick label`).toBe(true)
    }
  })

  it('builds the long-span date from local parts, not toISOString', () => {
    // toISOString() reports the previous day for anyone west of UTC, which would put a marker's
    // tick label a day off its tooltip.
    const d = new Date(2026, 0, 5, 23, 30)
    expect(tickFormatter(200 * DAY)(d)).toBe('2026-01-05')
  })

  it('shortens an id to something comparable between lanes', () => {
    expect(shortId('99999999-8888-7777-6666-555555555555')).toBe('99999999…5555')
    // Already short enough to read whole.
    expect(shortId('dev-1')).toBe('dev-1')
  })
})

/**
 * The derived marker taxonomy.
 *
 * `digital_thread.action` is written from TG_OP and holds only INSERT / UPDATE / DELETE -- there
 * is no QUARANTINE action, no ARCHIVE action and no SCHEMA action in the database. Archiving,
 * quarantining and schema rebinding are all UPDATEs, distinguished only by what the diff touched,
 * so the classifier is the only thing that tells them apart and it is worth pinning down.
 */
describe('Digital Thread event classification', () => {
  const classOf = (pattern) => nodeFor(pattern).className

  it('paints an INSERT as creation', async () => {
    await show()
    expect(classOf(/INSERT on Virtual_Gateway_NodeRED/)).toContain('dt-node-creation')
  })

  it('paints a DELETE as lifecycle-critical', async () => {
    await showAll()
    expect(classOf(/DELETE on Decommissioned Line/)).toContain('dt-node-critical')
  })

  it('paints an ordinary status change as operational', async () => {
    await show()
    expect(classOf(/UPDATE on Simulated_CNC_01/)).toContain('dt-node-operational')
  })

  it('paints a schema rebinding as governance, though its action is only UPDATE', async () => {
    await show()
    const governance = nodes().filter(n => n.className.includes('dt-node-governance'))
    expect(governance.length).toBe(1)
  })

  it('paints an archival as critical, though its action is only UPDATE', async () => {
    await showAll()
    // Two UPDATEs on Press_02; exactly one of them flipped is_archived to true.
    const critical = nodes().filter(n => n.className.includes('dt-node-critical'))
    // The DELETE, plus the archival.
    expect(critical.length).toBe(2)
  })

  /*
    Shapes taken from a reseeded stack rather than invented, because the classifier's failure mode
    is not an error -- it is a plausible-looking wrong colour. On 40 real audit rows the commonest
    event by far is a device's first DBIRTH, and it arrives as ONE update touching three columns
    at once. Classifying on any of the three in isolation gets it wrong.
  */
  it('calls a real first DBIRTH operational, not governance', () => {
    const event = {
      event_type: 'UPDATE',
      old_data: { status: 'OFFLINE', first_dbirth_at: null, identity_source: null },
      new_data: { status: 'ONLINE', first_dbirth_at: '2026-08-17T15:11:20Z', identity_source: 'sparkplug' }
    }
    // `identity_source` is provenance the ingestion daemon writes, not configuration an operator
    // declared, and it never moves on its own -- so it must not drag the whole event amber.
    expect(classifyEvent(event, diffFields(event.old_data, event.new_data))).toBe('operational')
  })

  it('calls a real cell relocation operational', () => {
    const event = {
      event_type: 'UPDATE',
      old_data: { cell_id: null }, new_data: { cell_id: 'cell-a' }
    }
    expect(classifyEvent(event, diffFields(event.old_data, event.new_data))).toBe('operational')
  })

  /*
   * THE DATABASE'S JUDGEMENT, PROMOTED INTO THE ROW (0070). `classifyEvent()` used to derive
   * "is this about who may do what" by hand, in the one place it could not enforce anything.
   * `audit_domain` is now stamped at insert time by one closed classifier, so the browser reads
   * the decision rather than re-making it -- and the two cannot disagree.
   */
  it('calls any security-domain row governance, whatever its verb', () => {
    // A service principal's INSERT is the case that used to come out green. Nothing was created
    // on the shopfloor; somebody was given a way to reach the stack.
    const event = {
      event_type: 'INSERT',
      audit_domain: 'security',
      new_data: { roles: ['Administrator'], can_sign_in: false }
    }
    expect(classifyEvent(event, diffFields(null, event.new_data))).toBe('governance')
  })

  it('still derives a marker for a row that carries no domain', () => {
    // Rows reach this function from fixtures and from older page state without the column. An
    // absent domain must fall through to the derivation rather than default to anything.
    const event = { event_type: 'INSERT', new_data: { asset_name: 'CNC-01' } }
    expect(classifyEvent(event, diffFields(null, event.new_data))).toBe('creation')
  })

  it('calls a role grant and a role revocation governance, not creation or lifecycle', () => {
    // Asserted on the ACTION alone, without a domain, because the two arms are independent: the
    // action arm is what a row reaching the page from an older cache would be classified by.
    for (const action of ['ROLE_GRANTED', 'ROLE_REVOKED']) {
      const event = { event_type: action, new_data: { role: 'Administrator' } }
      expect(classifyEvent(event, diffFields(null, event.new_data))).toBe('governance')
    }
  })

  it('carries a legend, because nothing else in the UI says what amber means', async () => {
    await show()
    const legend = document.querySelector('.dt-legend')
    expect(within(legend).getByText('Configuration')).toBeInTheDocument()
    expect(within(legend).getByText('Lifecycle')).toBeInTheDocument()
  })
})

/**
 * The drawer.
 *
 * The diff is built HERE, in the page, and handed to ContextPanel through `beforeActions`.
 * ContextPanel is presentational by contract and knows nothing about audit payloads; teaching it
 * to read `old_data` would make it a fifth thing with one caller.
 */
describe('Digital Thread event drawer', () => {
  it('stays shut until an event is clicked', async () => {
    await show()
    expect(document.querySelector('.context-panel-open')).toBeNull()
  })

  it('opens on the clicked event and names the asset it touched', async () => {
    await show()
    await selectEvent(/UPDATE on Simulated_CNC_01/)

    const panel = document.querySelector('.context-panel')
    expect(within(panel).getByText('Simulated_CNC_01')).toBeInTheDocument()
    expect(within(panel).getByText('UPDATE')).toBeInTheDocument()
  })

  it('shows only the properties that actually changed', async () => {
    await show()
    await selectEvent(/UPDATE on Simulated_CNC_01/)

    const table = document.querySelector('.dt-diff-table')
    expect(within(table).getByText('status')).toBeInTheDocument()
    expect(within(table).getByText('OFFLINE')).toBeInTheDocument()
    expect(within(table).getByText('ONLINE')).toBeInTheDocument()
    // `name` is identical on both sides of this snapshot and must not be listed. The snapshots
    // are whole rows, so without the comparison every diff would be twenty unchanged lines.
    expect(within(table).queryByText('name')).toBeNull()
  })

  it('drops the timestamp columns that change on every write', async () => {
    await show()
    await selectEvent(/UPDATE on Simulated_CNC_01/)

    // archived migration 0005 already suppresses heartbeat-ONLY updates at the source. This is the
    // residue: a real edit that also bumped the heartbeat, which would otherwise open every
    // diff with a line nobody came to read.
    expect(within(document.querySelector('.dt-diff-table')).queryByText('last_heartbeat')).toBeNull()
  })

  it('renders an INSERT as the properties it was created with', async () => {
    await show()
    await selectEvent(/INSERT on Virtual_Gateway_NodeRED/)

    expect(screen.getByText('Initial properties')).toBeInTheDocument()
    // One-sided: there is no previous value to compare against, so no Previous column.
    const headers = [...document.querySelectorAll('.dt-diff-table thead th')].map(h => h.textContent)
    expect(headers).toEqual(['Property', 'Created'])
  })

  it('renders a DELETE as the properties it was deleted with', async () => {
    await showAll()
    await selectEvent(/DELETE on Decommissioned Line/)

    expect(screen.getByText('Final properties')).toBeInTheDocument()
    const headers = [...document.querySelectorAll('.dt-diff-table thead th')].map(h => h.textContent)
    expect(headers).toEqual(['Property', 'Deleted'])
  })

  it('offers the audit row its own id, distinct from the entity it touched', async () => {
    // Two edits a second apart on the same device are one entity id and two mutation ids, so
    // quoting the entity does not identify the change being talked about.
    await show()
    await selectEvent(/UPDATE on Simulated_CNC_01/)

    expect(screen.getByRole('button', { name: /Copy mutation id 1$/ })).toBeInTheDocument()
  })

  /*
    The property names collided with the values beside them, and the cause was INHERITED.

    The global `th` rule sets `white-space: nowrap`, `text-transform: uppercase` and 0.8px of
    letter-spacing for every table header in the app. Each property name here is a
    `<th scope="row">`, so it took all three: `last_birth_metrics_at` rendered as
    LAST_BIRTH_METRICS_AT on one unbreakable line, straight across the value beside it. Wrapping
    rules cannot help while `nowrap` stands -- there is nothing for them to act on -- so the reset
    is the fix and is what these assert. jsdom does no layout; the guard is on the rule.
  */
  const cssRule = (s) =>
    APP_CSS.match(new RegExp(`\\n${s.replace(/[.:()\\-]/g, '\\$&')} \\{([\\s\\S]*?)\\n\\}`))?.[1]
  const CELL_RULE = '.dt-diff-table th,\n.dt-diff-table td'

  it('resets the inherited header styling that caused the collision', async () => {
    await show()
    await selectEvent(/UPDATE on Simulated_CNC_01/)

    // The global rule these three override. If it ever stops setting nowrap this guard is merely
    // redundant rather than wrong, but while it does, this is the line doing the work.
    expect(cssRule('th')).toMatch(/white-space:\s*nowrap/)
    expect(cssRule(CELL_RULE)).toMatch(/white-space:\s*normal/)
    expect(cssRule(CELL_RULE)).toMatch(/text-transform:\s*none/)
    expect(cssRule(CELL_RULE)).toMatch(/letter-spacing:\s*0/)
  })

  it('gives an unbreakable column name somewhere to wrap', async () => {
    await show()
    await selectEvent(/UPDATE on Simulated_CNC_01/)

    // `anywhere`, not just `break-word`: an underscore is not a break opportunity, so a
    // 21-character name has no legal wrap point and overflows however narrow the column is.
    expect(cssRule(CELL_RULE)).toMatch(/overflow-wrap:\s*anywhere/)
    expect(cssRule(CELL_RULE)).toMatch(/word-break:\s*break-word/)
    expect(cssRule(CELL_RULE)).toMatch(/padding:\s*6px 12px/)
    expect(cssRule('.dt-diff-table')).toMatch(/table-layout:\s*fixed/)
  })

  it('divides Previous from New, which hold the same property twice', async () => {
    await show()
    await selectEvent(/UPDATE on Simulated_CNC_01/)

    // Two columns holding one property's two values, often differing by a character. A reader
    // comparing them has to know which side they are on.
    const dividers = cssRule('.dt-diff-table tbody th:nth-child(1),\n.dt-diff-table tbody td:nth-child(1),\n.dt-diff-table tbody td:nth-child(2)')
    expect(dividers).toMatch(/border-right:\s*1px solid var\(--border\)/)
  })

  it('drops to two columns when there is no before/after pair', async () => {
    await show()
    await selectEvent(/INSERT on Virtual_Gateway_NodeRED/)

    // Otherwise the three-column widths leave a third of a 360px drawer empty.
    expect(document.querySelector('.dt-diff-table').className).toContain('dt-diff-onesided')

    fireEvent.click(nodeFor(/UPDATE on Simulated_CNC_01/))
    await waitFor(() =>
      expect(document.querySelector('.dt-diff-table').className).not.toContain('dt-diff-onesided'))
  })

  it('keeps the raw payload available but shut', async () => {
    await show()
    await selectEvent(/UPDATE on Simulated_CNC_01/)

    const details = document.querySelector('.dt-raw')
    expect(details).toBeTruthy()
    // Shut by default, or it is the JSON dump this page was rebuilt to stop being.
    expect(details.open).toBe(false)
    expect(within(details).getByText('Raw audit payload')).toBeInTheDocument()
  })
})

/**
 * Stepping through one asset's history.
 *
 * ASCENDING, against the descending order the list is fetched in. This is the one place on the
 * page that reads as a story rather than a feed: Previous has to go back in time and Next
 * forward, which is the only mapping that survives someone thinking about it.
 */
describe('Digital Thread drawer navigation', () => {
  const prev = () => screen.getByRole('button', { name: /Previous/ })
  const next = () => screen.getByRole('button', { name: /Next/ })
  const position = () => document.querySelector('.dt-drawer-nav-pos').textContent

  /*
    Targeted by TOOLTIP, not by lane. Press_02's two markers carry the same aria-label prefix and
    sit in DOM order newest-first, so picking "the first UPDATE on Press_02" silently selects the
    LATEST event -- and a Next test that starts at the end passes without stepping anything. The
    tooltip names the classification, which is what distinguishes these two.
  */
  const markerByTooltip = (substr) => nodes().find(n => n.getAttribute('title').includes(substr))
  const OLDEST = 'UPDATE · Lifecycle'      // the 08:00 archival
  const NEWEST = 'UPDATE · Configuration'  // the 09:00 schema rebind

  const selectOldest = async () => {
    fireEvent.click(markerByTooltip(OLDEST))
    await waitFor(() => expect(position()).toMatch(/^Event 1 of 2/))
  }

  it('counts the selected event within its own asset history', async () => {
    await show()
    await selectOldest()
    expect(position()).toMatch(/of 2/)
    expect(position()).toContain('Press_02')
  })

  it('steps forward in time and updates the drawer', async () => {
    await show()
    await selectOldest()

    fireEvent.click(next())
    await waitFor(() => expect(position()).toMatch(/^Event 2 of 2/))
    // The drawer is now describing the schema rebind, which is the amber one.
    expect(within(document.querySelector('.dt-diff-table')).getByText('schema_id')).toBeInTheDocument()
  })

  it('steps back to the older event', async () => {
    await show()
    fireEvent.click(markerByTooltip(NEWEST))
    await waitFor(() => expect(position()).toMatch(/^Event 2 of 2/))

    fireEvent.click(prev())
    await waitFor(() => expect(position()).toMatch(/^Event 1 of 2/))
    expect(within(document.querySelector('.dt-diff-table')).getByText('is_archived')).toBeInTheDocument()
  })

  it('disables Previous at the oldest event and Next at the newest', async () => {
    await show()
    await selectOldest()

    // Disabled rather than hidden: a control that vanishes at the boundary reflows the row under
    // the cursor, and the second click of a double-step lands on whatever moved into its place.
    expect(prev()).toBeDisabled()
    expect(next()).not.toBeDisabled()

    fireEvent.click(next())
    await waitFor(() => expect(next()).toBeDisabled())
    expect(prev()).not.toBeDisabled()
  })

  it('moves the highlight on the timeline as it steps', async () => {
    await show()
    await selectOldest()
    const before = document.querySelector('.dt-node-selected')

    fireEvent.click(next())
    await waitFor(() => expect(document.querySelector('.dt-node-selected')).not.toBe(before))
    // Exactly one marker is ever the selected one.
    expect(document.querySelectorAll('.dt-node-selected').length).toBe(1)
  })

  it('is a single step on an asset with only one event', async () => {
    await show()
    await selectEvent(/UPDATE on Simulated_CNC_01/)

    expect(position()).toMatch(/^Event 1 of 1/)
    expect(prev()).toBeDisabled()
    expect(next()).toBeDisabled()
  })
})

/**
 * Actor attribution.
 *
 * It moved from a badge on every row into the drawer and the marker tooltip: an actor belongs to
 * one EVENT, and a lane is one ASSET. The substance is unchanged -- `changed_by IS NULL` was the
 * normal case rather than an anomaly until archived migration 0005 stopped recording machine non-events
 * and stamped `actor_source` on what remained, so a blank author now means a genuine gap.
 */
describe('Digital Thread attribution', () => {
  it('labels a user-made change as User', async () => {
    await show()
    await selectEvent(/UPDATE on Simulated_CNC_01/)
    expect(within(document.querySelector('.context-panel')).getByText('User')).toBeInTheDocument()
  })

  it('names the machine behind an unattributed change rather than leaving it blank', async () => {
    await show()
    await selectEvent(/INSERT on Virtual_Gateway_NodeRED/)
    expect(screen.getByText('Ingestion daemon')).toBeInTheDocument()
  })

  it('flags a row with no actor_source at all, so a real gap is visible', async () => {
    await showAll()
    await selectEvent(/DELETE on Decommissioned Line/)
    // Rows written before 0005. After it, this should never appear -- which is the point of
    // making it loud rather than blank.
    expect(screen.getByText(/Unattributed/)).toBeInTheDocument()
  })

  it('names the actor on hover too, so the timeline is readable without opening anything', async () => {
    await show()
    expect(nodeFor(/INSERT on Virtual_Gateway_NodeRED/).getAttribute('title'))
      .toContain('Ingestion daemon')
  })

  it('offers a user id only when there is one', async () => {
    await show()
    await selectEvent(/INSERT on Virtual_Gateway_NodeRED/)
    // changed_by is NULL for every machine-originated write; an empty "Not set" row against the
    // ingestion daemon's own change would read as a gap rather than the ordinary case it is.
    expect(screen.queryByText('User ID')).toBeNull()

    fireEvent.click(nodeFor(/UPDATE on Simulated_CNC_01/))
    await waitFor(() => expect(screen.getByText('User ID')).toBeInTheDocument())
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

  it('leaves exactly four filter controls, six in the custom range mode', async () => {
    await show()

    // Direct children only. Export and auto-refresh fold into the right-hand end of this same
    // bar (`.filter-bar-actions`), and the refresh interval is a <select> -- so a descendant
    // selector would count a control that filters nothing and this guard would be asserting the
    // wrong thing.
    const controls = () => document.querySelectorAll('.filter-bar > select, .filter-bar > input')
    expect(controls().length).toBe(4)

    // The date pickers are not present until they mean something. Two controls sitting inert
    // beside the presets are two controls whose relationship to them has to be guessed at.
    fireEvent.change(rangeSelect(), { target: { value: 'custom' } })
    await waitFor(() => expect(controls().length).toBe(6))
  })

  it('puts export in the card header, where a card keeps its actions', async () => {
    /*
     * THIS ASSERTED THE FILTER BAR, AND THE REASONING HAS MOVED ON TWICE.
     *
     * Export began in a `.page-actions` row of its own -- a band holding one button -- and was
     * folded into the filter bar on the grounds that what it writes is decided by the filters, so
     * it belonged at the end of the row that decides it.
     *
     * That is an argument about PROXIMITY. The stronger one is about what the control IS: it does
     * not filter anything, and a card keeps its actions in the header at title height. So it sits
     * there now, and the count stays the FILTERED count -- which is the half of the proximity
     * argument worth keeping, because the button still says how many rows it will write.
     *
     * `.page-actions` must still not come back. That part of the original finding stands.
     */
    await show()

    expect(document.querySelector('.page-actions')).toBeNull()
    const header = document.querySelector('.page-main .card > .card-header')
    expect(header).toBeTruthy()
    expect(within(header).getByRole('button', { name: /Export CSV/ })).toBeInTheDocument()
    // And not in the filter bar it used to live in.
    const bar = document.querySelector('.filter-bar')
    expect(within(bar).queryByRole('button', { name: /Export CSV/ })).toBeNull()
  })

  it('no longer offers the auto-refresh control, having replaced it with a poll (issue #42)', async () => {
    /*
     * WHAT WAS REPORTED: the field was unneeded, because a default auto-update does the same job.
     *
     * It defaulted to Off, so the page was static until somebody noticed the control and picked a
     * value -- and it then offered 1s and 5s against an audit log that only changes when an
     * operator does something. Neither end of that range was useful.
     */
    await show()

    expect(screen.queryByTitle('Auto-refresh interval')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Refresh now')).not.toBeInTheDocument()
  })

  it('polls every 60 seconds without blanking the timeline (issue #42)', async () => {
    /*
     * THE HALF THAT MATTERS. Removing a control and adding nothing would leave a page that never
     * updates, and the assertion above -- that the control is gone -- would still pass.
     *
     * `load(false)`, not `load(true)`: the flag raises the loading state and swaps the timeline for
     * a spinner, which is right on first paint and a flicker every minute afterwards. This asserts
     * the refetch happens AND that the lanes are still on screen when it does.
     */
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      render(<DigitalThreadTab />)
      await vi.waitFor(() => expect(screen.getByText('Simulated_CNC_01')).toBeInTheDocument())

      const threadCalls = () =>
        api.get.mock.calls.filter(c => String(c[0]).startsWith('/api/v1/digital-thread')).length
      const before = threadCalls()

      await vi.advanceTimersByTimeAsync(60_000)

      expect(threadCalls()).toBe(before + 1)
      // Still the timeline, not a spinner.
      expect(screen.getByText('Simulated_CNC_01')).toBeInTheDocument()
      expect(document.querySelector('.loading-wrap')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  /*
   * Hiding events whose asset is gone (issue #44).
   *
   * WHAT WAS REPORTED: a Test gateway created in error, never brought online, since deleted -- and
   * still occupying the timeline. The reporter also proposed deleting the records outright; that
   * half is deliberately NOT built here. `digital_thread` is append-only and 0026 revoked DELETE
   * even from `service_role`, so removing rows is an administrative act, not a filter. Hiding is
   * the part that answers the complaint without asserting anything about what was kept.
   *
   * THE FIXTURE ALREADY CONTAINED THE CASE: `cell-gone` and the orphan UUID on event 6 appear in
   * EVENTS and in none of CELLS/GATEWAYS/DEVICES, which is exactly what a purged asset looks like.
   */
  describe('events for assets that no longer exist', () => {
    const toggle = () => screen.getByRole('button', { name: /Show deleted assets/i })

    it('counts distinct ASSETS, not the events belonging to them', async () => {
      /*
       * The reported bug: the control read "(54)" on a page whose own header said 16 assets, so the
       * number could only be parsed as a count of something else. Two purged entities in the
       * fixture -- `cell-gone` and the orphan uuid on event 6 -- so the answer is 2 however many
       * rows they own between them.
       */
      await show()
      expect(toggle()).toHaveTextContent('Show deleted assets (2)')
    })

    it('hides them by default, and that is not an active filter', async () => {
      /*
       * The resting view is the live plant. A deleted Test gateway is noise on every visit, and
       * Clear filters must not appear merely because the page is in its default state -- the
       * contract every other control in this bar has is that clearing restores the resting view.
       */
      await show()

      expect(screen.getByRole('button', { name: /Export CSV/ })).toHaveTextContent('Export CSV (4)')
      expect(screen.queryByTitle('Clear every filter')).not.toBeInTheDocument()
    })

    it('showing them is the deviation, so Clear filters appears', async () => {
      await show()
      fireEvent.click(toggle())

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /Export CSV/ })).toHaveTextContent('Export CSV (6)'))
      expect(screen.getByTitle('Clear every filter')).toHaveTextContent('Clear filters (1)')
    })

    it('Clear filters returns them to hidden', async () => {
      await show()
      fireEvent.click(toggle())
      fireEvent.click(await screen.findByTitle('Clear every filter'))

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /Export CSV/ })).toHaveTextContent('Export CSV (4)'))
    })

    it('is styled as the toggle Gateways and Cells already use', async () => {
      /*
       * Has quarantined devices (Gateways) and Empty (Cells) are both `btn btn-sm`, ghost at rest
       * and primary when engaged, with an icon and a count. This was a bare checkbox -- the only
       * control of its kind in the app. Unlit at rest is also why the label says Show rather than
       * Hide: with hiding as the default, a Hide button would load already pressed.
       */
      await show()
      expect(toggle()).toHaveClass('btn', 'btn-sm', 'btn-ghost')
      expect(toggle()).not.toHaveClass('btn-primary')

      fireEvent.click(toggle())
      await waitFor(() => expect(toggle()).toHaveClass('btn-primary'))
      expect(toggle()).not.toHaveClass('btn-ghost')
    })

    it('drops those events from the export as well as the timeline', async () => {
      // The count on the button is the count the CSV writes -- both read the same derived list,
      // which is why `events` is derived once rather than filtered at each call site.
      await show()
      expect(screen.getByRole('button', { name: /Export CSV/ })).toHaveTextContent('Export CSV (4)')

      fireEvent.click(toggle())
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /Export CSV/ })).toHaveTextContent('Export CSV (6)'))
    })

    it('hides the control when nothing would be hidden', async () => {
      /*
       * The overwhelmingly common case on a healthy stack. A permanent control reading "(0)" is one
       * whose relationship to the page has to be guessed at -- the same reasoning that keeps the
       * custom date inputs out of the bar until the custom preset is chosen.
       */
      api.get.mockImplementation((path) => {
        if (path.startsWith('/api/v1/digital-thread')) {
          return Promise.resolve(EVENTS.filter(e => ['dev-1', 'dev-2', 'gw-1'].includes(e.entity_id)))
        }
        if (path.startsWith('/api/v1/devices'))  return Promise.resolve(DEVICES)
        if (path.startsWith('/api/v1/gateways')) return Promise.resolve(GATEWAYS)
        if (path.startsWith('/api/v1/cells'))    return Promise.resolve(CELLS)
        return Promise.resolve([])
      })
      await show()

      expect(screen.queryByRole('button', { name: /Show deleted assets/i })).not.toBeInTheDocument()
    })

    it('hides nothing while the asset lookups are still outstanding', async () => {
      /*
       * THE BUG THIS PREVENTS, and it would have been silent. The purged test is absence from the
       * three lookups, and before those resolve EVERY entity_id is absent -- so filtering eagerly
       * would classify the whole page as deleted and, with hiding now the DEFAULT, blank it
       * outright with no interaction at all.
       *
       * Lookups that never resolve are the same situation as lookups still in flight, so this also
       * covers the failure path: unable to tell purged from live means hide nothing.
       */
      api.get.mockImplementation((path) => {
        if (path.startsWith('/api/v1/digital-thread')) return Promise.resolve(EVENTS)
        return new Promise(() => {})   // never resolves
      })
      render(<DigitalThreadTab />)

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /Export CSV/ })).toHaveTextContent('Export CSV (6)'))
      expect(screen.queryByRole('button', { name: /Show deleted assets/i })).not.toBeInTheDocument()
    })

    it('does not treat an ARCHIVED asset as deleted', async () => {
      /*
       * The distinction the whole filter rests on, and it matters more now that hiding is the
       * default: /api/v1/devices does not filter is_archived, so an archived device is still in the
       * lookup and is therefore still live as far as this filter is concerned. Getting it wrong
       * would silently drop a retired -- but recoverable -- asset's whole history from the resting
       * view.
       */
      api.get.mockImplementation((path) => {
        if (path.startsWith('/api/v1/digital-thread')) {
          return Promise.resolve(EVENTS.filter(e => e.entity_id === 'dev-2'))
        }
        if (path.startsWith('/api/v1/devices')) {
          return Promise.resolve([{ ...DEVICES[1], is_archived: true, archived_at: '2026-08-01T00:00:00Z' }])
        }
        if (path.startsWith('/api/v1/gateways')) return Promise.resolve([])
        if (path.startsWith('/api/v1/cells'))    return Promise.resolve([])
        return Promise.resolve([])
      })
      render(<DigitalThreadTab />)
      await waitFor(() => expect(screen.getByText('Press_02')).toBeInTheDocument())

      expect(screen.queryByRole('button', { name: /Show deleted assets/i })).not.toBeInTheDocument()
    })
  })

  /*
   * The swimlane redesign: contained track cards rather than ruled rows.
   *
   * ASSERTED THROUGH THE STYLESHEET, using the `cssRule()` helper this file already uses for the
   * other CSS guards. The rules are what make a lane read as one asset's stretch of time; jsdom
   * applies no layout, so the DOM cannot answer whether a track has edges.
   */
  /** The rule body for a selector, from the stylesheet on disk. jsdom applies no layout, so a
      question about whether a track has edges can only be asked of the CSS. Local to these two
      describes; the diff-table guards further down carry their own. */
  const ruleFor = (selector) => {
    const escaped = selector.replace(/[.:()\-*+?^${}|[\]\\]/g, '\\$&')
    return APP_CSS.match(new RegExp(`\\n${escaped} \\{([\\s\\S]*?)\\n\\}`))?.[1]
  }

  describe('swimlanes render as contained tracks', () => {
    it('gives the track a container rather than a bare line', async () => {
      const rule = ruleFor('.dt-track')
      expect(rule).toMatch(/background:/)
      expect(rule).toMatch(/border:/)
      expect(rule).toMatch(/border-radius:/)
    })

    it('leaves the axis row unboxed, because a scale is not a lane', async () => {
      // Boxing the tick labels like data would make the ruler read as another asset.
      const rule = ruleFor('.dt-track.dt-axis-track')
      expect(rule).toMatch(/background:\s*none/)
      expect(rule).toMatch(/border:\s*none/)
    })

    it('keeps a centre guideline lighter than the container edge', async () => {
      /*
       * At the old 2px in the border colour, the guideline weighed the same as the track's own
       * border and a lane read as three stacked rules. It says where the timeline runs; the
       * markers are what the eye should find.
       */
      const rule = ruleFor('.dt-track::before')
      expect(rule).toMatch(/height:\s*1px/)
      expect(rule).toMatch(/opacity:/)
    })

    it('separates lanes with space rather than a divider', async () => {
      // `border-bottom` made the page a stack of table rows: the eye followed the rules instead of
      // the tracks, and a marker near one read as belonging to the boundary.
      const rule = ruleFor('.dt-lane')
      expect(rule).not.toMatch(/border-bottom/)
      expect(rule).toMatch(/gap:/)
    })

    it('draws the label as a pill without breaking its scroll-under opacity', async () => {
      /*
       * TWO JOBS IN TENSION. The label is sticky so markers pass UNDER it, which needs an opaque
       * background in the card's colour; it should also read as a container, which wants a lighter
       * inset surface. The pill is therefore drawn by ::before, and the element itself stays
       * opaque -- if that were swapped for a translucent pill background, dots would show through
       * the asset name as they scrolled past.
       */
      expect(ruleFor('.dt-lane-label')).toMatch(/background:\s*var\(--bg-card\)/)
      expect(ruleFor('.dt-lane-label::before')).toMatch(/border-radius:/)
    })

    it('renders the section heading as one badge', async () => {
      await show()
      const badge = document.querySelector('.dt-section-badge')
      expect(badge).toBeTruthy()
      // The count lives inside the badge, so it cannot drift away from the label it counts.
      expect(badge.querySelector('.dt-section-count')).toBeTruthy()
      expect(badge.querySelector('.dt-section-name')).toBeTruthy()
    })
  })

  describe('the selected marker is findable among the ones it is stacked with', () => {
    it('rings the active node in a solid accent rather than a halo', async () => {
      /*
       * `--accent-glow` alone is translucent: it reads well against the card background and almost
       * disappears against the neighbours a dense stretch of track puts either side of it. The
       * inner gap in the card colour is what separates the selected mark from what it sits among.
       */
      const rule = ruleFor('.dt-node-selected')
      expect(rule).toMatch(/var\(--accent\)/)
      expect(rule).toMatch(/var\(--bg-card\)/)
    })

    it('is shared with the cluster badge rather than being a .dt-node compound', async () => {
      /*
       * WHAT LETS A BADGE CARRY THE RING while the drawer steps through the events inside it. If
       * this were written `.dt-node.dt-node-selected`, a selected group would show no highlight
       * at all -- and the page would look, at exactly the densest moments, as though Previous and
       * Next were doing nothing.
       */
      expect(APP_CSS).toContain('\n.dt-node-selected {')
      expect(APP_CSS).not.toContain('.dt-node.dt-node-selected {')
    })

    it('paints the cluster badge outside the four-colour classification', async () => {
      /*
       * A BADGE IS NOT A KIND OF EVENT, it is a count -- and a group routinely holds two or three
       * of the four kinds, so borrowing any one of their fills would assert a classification the
       * group does not have. Guarded because the tempting shortcut is to reach for --accent.
       */
      const rule = ruleFor('.dt-cluster')
      expect(rule).toMatch(/var\(--cluster/)
      for (const kind of ['--accent', '--success', '--warning', '--danger']) {
        expect(rule).not.toContain(`var(${kind})`)
      }
    })

    it('marks the node the drawer is showing, and moves it with Previous/Next', async () => {
      await show()
      const nodes = () => [...document.querySelectorAll('.dt-node')]
      const selected = () => document.querySelector('.dt-node-selected')

      expect(selected()).toBeNull()
      fireEvent.click(nodes()[0])
      await waitFor(() => expect(selected()).toBeTruthy())

      const first = selected()
      const prev = screen.getByRole('button', { name: /Previous/ })
      if (!prev.disabled) {
        fireEvent.click(prev)
        // The ring follows the drawer rather than staying where it was clicked.
        await waitFor(() => expect(selected()).not.toBe(first))
      }
    })
  })

  it('fetches schemas to NAME them, not to derive tags from them', async () => {
    // THE FETCH IS BACK, FOR A DIFFERENT REASON, and the distinction is the point of this test.
    // It was removed with the tag filter, which was the only thing deriving anything from a
    // schema's definition. It returned when the audit log needed to say WHICH schema an event was
    // about: 0070 put `schemas` in the audit trigger and this page's name lookup was never
    // widened, so every schema event rendered as a bare uuid -- and, because absence from that
    // lookup is how this page recognises a PURGED asset, was also being counted as an event about
    // something deleted.
    await show()

    const urls = api.get.mock.calls.map(c => c[0])
    expect(urls.some(u => u.startsWith('/api/v1/schemas'))).toBe(true)
    // The tag filter itself stays gone: nothing here reads a schema_definition.
    expect(screen.queryByLabelText(/tag/i)).toBeNull()
  })

  it('names a schema event by its schema and version, not by a uuid', async () => {
    const SCHEMA_ID = 'sch-77'
    api.get.mockImplementation((path) => {
      if (path.startsWith('/api/v1/digital-thread')) {
        return Promise.resolve([{
          id: 9001, entity_type: 'schemas', entity_id: SCHEMA_ID, action: 'UPDATE',
          recorded_at: '2026-09-06T10:00:00Z', changed_by: null,
          old_data: { status: 'draft' }, new_data: { status: 'active' }
        }])
      }
      if (path.startsWith('/api/v1/devices'))  return Promise.resolve(DEVICES)
      if (path.startsWith('/api/v1/gateways')) return Promise.resolve(GATEWAYS)
      if (path.startsWith('/api/v1/cells'))    return Promise.resolve(CELLS)
      if (path.startsWith('/api/v1/schemas')) {
        return Promise.resolve([{ schema_uuid: SCHEMA_ID, schema_name: 'Test-Schema', version: 2 }])
      }
      return Promise.resolve([])
    })
    render(<DigitalThreadTab />)

    // THE VERSION IS PART OF THE NAME. A lineage is a chain of rows sharing one `schema_name` and
    // differing only in `version`, so the name alone would label three rows identically -- and
    // which version something happened to is the whole point of a schema's audit trail.
    await waitFor(() => expect(screen.getByText('Test-Schema v2')).toBeInTheDocument())
    expect(screen.queryByText(SCHEMA_ID)).toBeNull()
  })

  it('still filters by name, which was sharing the id-restriction path with tags', async () => {
    await show()
    fireEvent.change(screen.getByPlaceholderText(/Search by entity name or ID/), { target: { value: 'Press' } })

    await waitFor(() => expect(lastThreadUrl()).toContain('entity_ids=dev-2'))
  })
})

/**
 * Timeline density and layout.
 *
 * jsdom does no layout, so the numbers are read from App.css. The point of guarding them is that
 * each encodes a decision that looks arbitrary to the next person to open the file: a lane is
 * 32px because ~200 audit rows across a dozen assets have to fit on a screen, and the label is
 * sticky because the drawer is a flex SIBLING of this list -- opening it takes 360px off the
 * width, and without the sticky label the assets scroll out of view exactly when an operator is
 * comparing one against the drawer.
 */
describe('Digital Thread timeline density', () => {
  const rule = (selector) =>
    APP_CSS.match(new RegExp(`\\n${selector.replace(/[.:()\\-]/g, '\\$&')} \\{([\\s\\S]*?)\\n\\}`))?.[1]

  it('keeps a lane to 32px', () => {
    expect(rule('.dt-track')).toMatch(/height:\s*32px/)
  })

  it('pins the lane label so it survives horizontal scrolling', () => {
    expect(rule('.dt-lane-label')).toMatch(/position:\s*sticky/)
    // Opaque, or the markers scroll over the label instead of under it.
    expect(rule('.dt-lane-label')).toMatch(/background:\s*var\(--bg-card\)/)
  })

  it('scrolls the lanes horizontally rather than the page', () => {
    expect(rule('.dt-scroll')).toMatch(/overflow-x:\s*auto/)
  })

  it('caps the raw payload height so it cannot push the accordion off the drawer', () => {
    expect(rule('.dt-raw-json')).toMatch(/max-height:\s*220px/)
  })
})

