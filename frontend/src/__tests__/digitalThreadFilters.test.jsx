/**
 * Digital Thread filter bar and actor attribution. The audit trigger stops recording heartbeat
 * stamps and no-op writes and stamps `actor_source` on what remains, so a blank author means a
 * genuine gap.
 */
import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { DigitalThreadTab, classifyEvent, diffFields, tickFormatter, shortId, timeWindow } from '../components/tabs/DigitalThreadTab'
import { api } from '../api'

/* Newlines normalised on read, because `cssRule()` matches multi-line selectors with `\n` and
   .gitattributes checks this file out with the platform's native ending, CRLF on Windows. */
const APP_CSS = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8').replace(/\r\n/g, '\n')

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { listUserAccounts: vi.fn(() => Promise.resolve([])), get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const CELLS = [{ cell_id: 'cell-1', cell_name: 'Assembly Line 1' }]
const GATEWAYS = [{ gateway_id: 'gw-1', gateway_name: 'Virtual_Gateway_NodeRED', devices: [] }]
const DEVICES = [
  { asset_id: 'dev-1', asset_name: 'Simulated_CNC_01', last_birth_metrics: [] },
  { asset_id: 'dev-2', asset_name: 'Press_02', last_birth_metrics: [] }
]

/**
 * These fixtures are dated 2026-08-02 and never refreshed: the page's default range is All time,
 * and a suite that only passed while its fixtures were recent would be asserting the calendar.
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
  // A cell that no longer exists, which is what a DELETE means: absent from CELLS because
  // /api/v1/cells cannot return a deleted row, so only its final snapshot can name it.
  {
    event_id: 3, entity_type: 'cells', entity_id: 'cell-gone', event_type: 'DELETE',
    timestamp: '2026-08-02T10:00:00Z', description: 'Action DELETE on cells [cell-gone]',
    changed_by: null, actor_source: null,
    old_data: { id: 'cell-gone', name: 'Decommissioned Line' }, new_data: null
  },
  // A schema rebinding, which separates the amber class from the blue one. There is no SCHEMA
  // action in the database; it is an UPDATE that touched `schema_id`.
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
 * Ready when the lanes are drawn: the lane label is the signal that the page has resolved its
 * joins.
 */
const show = async () => {
  render(<DigitalThreadTab />)
  await waitFor(() => expect(screen.getByText('Simulated_CNC_01')).toBeInTheDocument())
}

/**
 * Render with purged assets included. Hiding them is the page default, and several suites below are
 * about the two purged entities in the fixture, so the toggle is the subject rather than incidental
 * setup.
 */
const showAll = async () => {
  await show()
  fireEvent.click(screen.getByRole('button', { name: /Show deleted entities/i }))
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
    expect(screen.getByPlaceholderText(/Search by name, entity, mutation or transaction ID/)).toBeInTheDocument()
    // The wording is load-bearing: this control filters `digital_thread.action`, while the coloured
    // markers show a derived classification. See digitalThreadActionFilter.test.jsx.
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

  /* SENT AS THE TYPED TEXT, not resolved to ids here. It is still a database predicate rather than
     a filter over the page -- the row limit is applied by the database, so post-filtering a 200-row
     page would show whichever fraction happened to match -- but the matching happens where the
     audit snapshots are, which is the only place a deleted entity still has a name. */
  it('sends an entity NAME to the database to match', async () => {
    await show()
    fireEvent.change(screen.getByPlaceholderText(/Search by name, entity, mutation or transaction ID/), { target: { value: 'Simulated' } })

    await waitFor(() => expect(lastThreadUrl()).toContain('search=Simulated'))
    // And no longer resolves it against the live lists first, which is what made a deleted entity
    // unsearchable: no match there meant an empty id list, which drew an empty thread.
    expect(lastThreadUrl()).not.toContain('entity_ids=')
  })

  it('still matches on a raw id, so an id pasted from elsewhere works', async () => {
    await show()
    fireEvent.change(screen.getByPlaceholderText(/Search by name, entity, mutation or transaction ID/), { target: { value: 'gw-1' } })

    await waitFor(() => expect(lastThreadUrl()).toContain('search=gw-1'))
  })

  it('searches for a name no live asset has, instead of drawing an empty thread', async () => {
    /* THE BUG THIS REPLACES. `Decommissioned Line` is in the fixture's audit payload and in no
       live list, so resolving the name against the live lists produced no ids -- and an empty id
       list is not "no filter", it is "these, of which there are none". The page asked for nothing
       and drew nothing, on the one question it exists to answer. */
    await show()
    fireEvent.change(screen.getByPlaceholderText(/Search by name, entity, mutation or transaction ID/),
      { target: { value: 'Decommissioned' } })

    await waitFor(() => expect(lastThreadUrl()).toContain('search=Decommissioned'))
    expect(lastThreadUrl()).not.toContain('entity_ids=')
  })

  it('counts the active filters and clears them together, the time range included', async () => {
    await show()
    fireEvent.change(screen.getByTitle(/Filter by the database action/), { target: { value: 'UPDATE' } })
    fireEvent.change(screen.getByPlaceholderText(/Search by name, entity, mutation or transaction ID/), { target: { value: 'Press' } })
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
 * The time range is pushed down: `limit=200` is applied by the database to rows ordered
 * newest-first, so a window filtered in the browser would spend its row budget on events outside
 * the window. These assert on the URL because that is where the difference is observable.
 */
describe('Digital Thread time range', () => {
  it('defaults to All time and sends no bound at all', async () => {
    await show()

    expect(rangeSelect().value).toBe('all')
    expect(lastThreadUrl()).not.toContain('since=')
    expect(lastThreadUrl()).not.toContain('until=')
  })

  /* The default is unbounded: the page's main entry path is a handover from a device row, and under
     a rolling default an asset last edited at install time would answer with an empty timeline. */
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
    // Local, not UTC: an operator choosing 09:30 means 09:30 where they stand. The end bound is
    // widened to the end of that minute.
    expect(new Date(params.get('since')).getTime())
      .toBe(new Date('2026-08-01T09:30:00.000').getTime())
    expect(new Date(params.get('until')).getTime())
      .toBe(new Date('2026-08-01T09:45:59.999').getTime())
  })

  it('takes a window narrower than a day, which the date pickers could not express', async () => {
    /* The point of the sub-day zoom: `type="date"` bounded the narrowest window at 24 hours, so on
       a stack commissioned this morning "All time" and "today" drew the same picture. */
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
    /* A `datetime-local` input refuses a date-only value, so this cannot be driven through the DOM.
       `timeWindow` is an exported pure function whose contract says a bare date means the whole of
       that day, so it is tested directly. */
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

  // A source guard on the pushdown: the window must reach the database as RPC arguments and not be
  // applied to rows the limit already cut, and a silent reversion would show as a wrong row count
  // rather than an error.
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
 * The swimlanes: one lane per audited entity, ordered busiest first. Stable ordering is asserted
 * because lanes that reshuffle between refreshes put a different marker under the cursor.
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

  /* Name resolution, all three falls. The second earns its keep: a deleted entity is gone from
     /api/v1/cells, but its final audit snapshot holds the name it had when it died. */
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

    /* AND IT IS STILL FLAGGED DELETED. This used to assert the opposite, on the reasoning that
       nothing said it was gone -- but the evidence is the same evidence that flags the lane above:
       it is a device, the devices lookup has landed, and its id is not in it. The snapshot is only
       where a LABEL comes from. The reader is also seeing this row because they turned Show
       deleted entities on, so the page saying "deleted" is the page agreeing with the control that
       revealed it. */
    const lane = screen.getByText('99999999…5555').closest('.dt-lane')
    const flag = within(lane).getByText('deleted')
    expect(flag).toBeInTheDocument()
    expect(flag.getAttribute('title')).toMatch(/carry no name to recover/)
  })

  it('does not flag a lane whose kind nothing looks up', async () => {
    /* A settings, backup or service-identity lane is absent from `entityNames` because nothing
       fetches those tables -- not because the row is gone. Widening snapshotIdentity() is what
       made this reachable: before it, none of those kinds could be named at all, so none of them
       ever reached the flag. */
    api.get.mockImplementation((path) => {
      if (path.startsWith('/api/v1/digital-thread')) return Promise.resolve([{
        event_id: 90, entity_type: 'system_settings', entity_id: 'set-1', event_type: 'UPDATE',
        timestamp: '2026-08-02T12:00:00Z', description: 'x', changed_by: null,
        actor_source: 'user', old_data: { key: 'ui.x', label: 'Lanes drawn before folding' },
        new_data: { key: 'ui.x', label: 'Lanes drawn before folding' },
      }])
      if (path.startsWith('/api/v1/devices'))  return Promise.resolve(DEVICES)
      if (path.startsWith('/api/v1/gateways')) return Promise.resolve(GATEWAYS)
      if (path.startsWith('/api/v1/cells'))    return Promise.resolve(CELLS)
      return Promise.resolve([])
    })
    render(<DigitalThreadTab />)

    const label = await screen.findByText('Lanes drawn before folding')
    expect(within(label.closest('.dt-lane')).queryByText('deleted')).toBeNull()
  })

  /* Sections. The cap is applied before the cut, not per section, so one asset's history is
     comparable against its neighbours' without scrolling. */
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

  it('draws every lane, with no cap to fold the rest behind', async () => {
    /* Forty lanes, more than the thirty the old cap drew. The cap folded the long tail behind a
       "Show all lanes" button at the foot, and since lanes are ordered busiest-first across the
       whole page the hidden ones belonged to every section: pressing a button at the bottom
       expanded rows at the top. The timeline scrolls inside the card now and a page holds at
       most 200 events, so there is nothing for a cap to guard. The bulk assets are also returned
       by the devices lookup, so none reads as purged and hidden by default. */
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

    await waitFor(() => expect(document.querySelectorAll('.dt-lane:not(.dt-axis)').length).toBe(40))
    // The header names the whole set, as a plain count: nothing is held back to make a fraction.
    expect(screen.getByText(/40 entities/)).toBeInTheDocument()
    expect(screen.queryByText(/\d+\/40/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Show all lanes|Show fewer lanes/)).not.toBeInTheDocument()
  })
})

/**
 * The time axis. One rule, asserted directly: two adjacent ticks must never print the same string.
 * Every band exists because the coarser format above it collapses at that span.
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

  /* The band that catches people out: `MMM YYYY` past thirty days repeats across five ticks over a
     31-day span. An ISO date never repeats at any span this rule covers. */
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
 * The derived marker taxonomy. `digital_thread.action` holds only INSERT / UPDATE / DELETE;
 * archiving, quarantining and schema rebinding are all UPDATEs distinguished by what the diff
 * touched, so the classifier is the only thing that tells them apart.
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

  /* Shapes taken from a reseeded stack: the commonest event is a device's first DBIRTH, which
     arrives as one update touching three columns at once, and classifying on any one in isolation
     gets it wrong. */
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

  /* The database's judgement, read from the row: `audit_domain` is stamped at insert time by one
     closed classifier, so the browser does not re-derive "is this about who may do what". */
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
 * The drawer. The diff is built here and handed to ContextPanel through `beforeActions`;
 * ContextPanel is presentational and knows nothing about audit payloads.
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

    // The trigger already suppresses heartbeat-only updates. This is the residue: a real edit that
    // also bumped the heartbeat, which would otherwise open every diff with a line nobody came to
    // read.
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

  /* The global `th` rule sets `white-space: nowrap`, `text-transform: uppercase` and letter-spacing
     for every table header, and each property name here is a `<th scope="row">`. The reset is the
     fix and is what these assert; jsdom does no layout, so the guard is on the rule. */
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
 * Stepping through one asset's history: ascending, against the descending fetch order, because
 * Previous has to go back in time and Next forward.
 */
describe('Digital Thread drawer navigation', () => {
  const prev = () => screen.getByRole('button', { name: /Previous/ })
  const next = () => screen.getByRole('button', { name: /Next/ })
  const position = () => document.querySelector('.dt-drawer-nav-pos').textContent

  /* Targeted by tooltip, not by lane: Press_02's two markers carry the same aria-label prefix and
     sit newest-first, so "the first UPDATE on Press_02" would select the latest event. The tooltip
     names the classification. */
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
 * Actor attribution, in the drawer and the marker tooltip: an actor belongs to one event, and a
 * lane is one asset. A blank author means a genuine gap, since the trigger no longer records
 * machine non-events.
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

// There is no tag filter on this page. Asserted negatively so it cannot drift back: it also pulled
// a /api/v1/schemas fetch and the deviceTags derivation into a page with no other use for them.
describe('Digital Thread — removed tag filter', () => {
  it('offers no device-type filter', async () => {
    await show()

    expect(screen.queryByText('Any device type')).not.toBeInTheDocument()
    expect(screen.queryByTitle(/carry this tag/i)).not.toBeInTheDocument()
  })

  it('leaves exactly four filter controls, six in the custom range mode', async () => {
    await show()

    // Direct children only: Export and auto-refresh fold into `.filter-bar-actions`, and the
    // refresh interval is a <select>, so a descendant selector would count a control that filters
    // nothing.
    const controls = () => document.querySelectorAll('.filter-bar > select, .filter-bar > input')
    expect(controls().length).toBe(4)

    // The date pickers are not present until they mean something. Two controls sitting inert
    // beside the presets are two controls whose relationship to them has to be guessed at.
    fireEvent.change(rangeSelect(), { target: { value: 'custom' } })
    await waitFor(() => expect(controls().length).toBe(6))
  })

  it('puts export in the card header, where a card keeps its actions', async () => {
    /* Export sits in the card header at title height, because it does not filter anything, and the
       count stays the filtered count so the button says how many rows it will write.
       `.page-actions` must not come back. */
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
    /* The refresh-interval field is gone: a default auto-update does the job, and 1s and 5s options
       were never useful against an audit log that only changes when an operator acts. */
    await show()

    expect(screen.queryByTitle('Auto-refresh interval')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Refresh now')).not.toBeInTheDocument()
  })

  it('polls every 60 seconds without blanking the timeline (issue #42)', async () => {
    /* The half that matters: removing the control and adding nothing would leave a page that never
       updates. `load(false)`, not `load(true)`, so the lanes stay on screen during the refetch
       rather than swapping for a spinner every minute. */
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

  /* Hiding events whose asset is gone. `digital_thread` is append-only and DELETE is revoked even
     from `service_role`, so hiding is a filter and removal is an administrative act. The fixture
     already contains the case: `cell-gone` and the orphan UUID on event 6. */
  describe('events for assets that no longer exist', () => {
    const toggle = () => screen.getByRole('button', { name: /Show deleted entities/i })

    it('counts distinct ASSETS, not the events belonging to them', async () => {
      /* The control counts purged entities, not their rows: two in the fixture, however many rows
         they own. */
      await show()
      expect(toggle()).toHaveTextContent('Show deleted entities (2)')
    })

    it('hides them by default, and that is not an active filter', async () => {
      /* The resting view is the live plant, and Clear filters must not appear merely because the
         page is in its default state. */
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
      /* The same control shape as Has quarantined devices and Empty: `btn btn-sm`, ghost at rest
         and primary when engaged, with an icon and a count. The label says Show because hiding is
         the default. */
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
      /* The common case on a healthy stack: a permanent control reading "(0)" is one whose
         relationship to the page has to be guessed at. */
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

      expect(screen.queryByRole('button', { name: /Show deleted entities/i })).not.toBeInTheDocument()
    })

    it('hides nothing while the asset lookups are still outstanding', async () => {
      /* The purged test is absence from the three lookups, and before those resolve every entity_id
         is absent, so filtering eagerly would blank the page. Lookups that never resolve are the
         same situation: unable to tell purged from live means hide nothing. */
      api.get.mockImplementation((path) => {
        if (path.startsWith('/api/v1/digital-thread')) return Promise.resolve(EVENTS)
        return new Promise(() => {})   // never resolves
      })
      render(<DigitalThreadTab />)

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /Export CSV/ })).toHaveTextContent('Export CSV (6)'))
      expect(screen.queryByRole('button', { name: /Show deleted entities/i })).not.toBeInTheDocument()
    })

    it('does not treat an ARCHIVED asset as deleted', async () => {
      /* An archived device is still in the /api/v1/devices lookup and is therefore live as far as
         this filter is concerned; getting it wrong would drop a recoverable asset's whole history. */
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

      expect(screen.queryByRole('button', { name: /Show deleted entities/i })).not.toBeInTheDocument()
    })
  })

  /* 0117: the rule reaches every kind the page can tell a deletion of, which is every kind whose
     lookup it fetches AND whose table `digital_thread_page()` can probe. Schemas qualify and were
     missing, so a deleted one wore the "deleted" flag, could not be hidden, and -- the count being
     what draws the reveal control -- was offered no way to be. */
  describe('deleted entities beyond the shopfloor tables', () => {
    const SCHEMA_EVENTS = [
      {
        event_id: 11, entity_type: 'devices', entity_id: 'dev-1', event_type: 'UPDATE',
        timestamp: '2026-08-02T12:00:00Z', description: 'Action UPDATE on devices [dev-1]',
        changed_by: null, actor_source: 'user',
        old_data: { id: 'dev-1', name: 'Simulated_CNC_01' },
        new_data: { id: 'dev-1', name: 'Simulated_CNC_01' },
      },
      {
        event_id: 12, entity_type: 'schemas', entity_id: 'schema-gone', event_type: 'DELETE',
        timestamp: '2026-08-02T11:00:00Z', description: 'Action DELETE on schemas [schema-gone]',
        changed_by: null, actor_source: 'user',
        old_data: { id: 'schema-gone', schema_name: 'VALIDATE_Schema_Robot', version: 1 },
        new_data: null,
      },
    ]

    /** @param make what /api/v1/schemas resolves to, called per request so a rejection is attached. */
    const withSchemas = (make) => {
      api.get.mockImplementation((path) => {
        if (path.startsWith('/api/v1/digital-thread')) return Promise.resolve(SCHEMA_EVENTS)
        if (path.startsWith('/api/v1/devices')) return Promise.resolve(DEVICES)
        if (path.startsWith('/api/v1/schemas')) return make()
        return Promise.resolve([])
      })
    }

    it('hides a schema its lookup cannot name, and counts it on the control', async () => {
      withSchemas(() => Promise.resolve([]))
      await show()

      expect(screen.queryByText('VALIDATE_Schema_Robot')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Show deleted entities/i }))
        .toHaveTextContent('Show deleted entities (1)')
    })

    it('reveals it, named from its snapshot, when asked', async () => {
      withSchemas(() => Promise.resolve([]))
      await show()
      fireEvent.click(screen.getByRole('button', { name: /Show deleted entities/i }))

      expect(await screen.findByText('VALIDATE_Schema_Robot')).toBeInTheDocument()
    })

    it('leaves a schema the lookup still holds alone', async () => {
      withSchemas(() => Promise.resolve([{ id: 'schema-gone', schema_name: 'Robot pose', version: 2 }]))
      await show()

      expect(screen.getByText('Robot pose')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Show deleted entities/i })).not.toBeInTheDocument()
    })

    it('hides nothing when the schemas lookup was refused, rather than hiding all of them', async () => {
      /* WHY THE LOOKUP REPORTS null RATHER THAN []: a refused request and an empty table are the
         same value and opposite facts. Reading the first as the second would call every live schema
         deleted and then hide it, so one 403 would silently empty a lane. */
      withSchemas(() => Promise.reject(new Error('403')))
      await show()

      expect(await screen.findByText('VALIDATE_Schema_Robot')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Show deleted entities/i })).not.toBeInTheDocument()
      expect(document.querySelector('.dt-lane-gone')).toBeNull()
    })

    it('never calls a role assignment deleted, because nothing here can probe auth.users', async () => {
      /* The complement of the rule. `list_user_accounts()` names that lane (0116), but its subject
         is an auth.users row the RPC cannot read, so the server can never hide one -- and a flag the
         control cannot act on is the defect this describe exists for, in the other direction. */
      api.get.mockImplementation((path) => {
        if (path.startsWith('/api/v1/digital-thread')) {
          return Promise.resolve([{
            event_id: 13, entity_type: 'user_roles',
            entity_id: '11111111-2222-4333-8444-555555555555', event_type: 'INSERT',
            timestamp: '2026-08-02T10:00:00Z', description: 'Action INSERT on user_roles',
            changed_by: null, actor_source: 'user',
            old_data: null, new_data: { role: 'Auditor' },
          }])
        }
        if (path.startsWith('/api/v1/devices')) return Promise.resolve(DEVICES)
        return Promise.resolve([])
      })
      render(<DigitalThreadTab />)
      await waitFor(() => expect(document.querySelector('.dt-lane-label')).toBeTruthy())

      expect(document.querySelector('.dt-lane-gone')).toBeNull()
      expect(screen.queryByRole('button', { name: /Show deleted entities/i })).not.toBeInTheDocument()
    })
  })

  /* 0118: the last two lanes that drew a bare uuid. A backup job has no name column and a service
     principal has no table at all, so each needed a different answer -- a category from the payload
     for one, the dashboard's own registry of pinned ids for the other. */
  describe('lanes that have no name to be named by', () => {
    const JOB_A = 'aaaaaaaa-1111-4000-8000-000000000001'
    const JOB_B = 'bbbbbbbb-2222-4000-8000-000000000002'
    const MCP    = 'b0000000-0000-4000-8000-000000000001'

    /** Two jobs requested in the SAME minute, which is the case origin alone cannot tell apart. */
    const JOB_EVENTS = [
      {
        event_id: 21, entity_type: 'backup_jobs', entity_id: JOB_A,
        event_type: 'BACKUP_REQUESTED', timestamp: '2026-08-02T13:41:00Z',
        description: 'Action BACKUP_REQUESTED on backup_jobs', changed_by: null,
        actor_source: 'user', old_data: null,
        new_data: { origin: 'requested', note: 'nightly check' },
      },
      {
        event_id: 22, entity_type: 'backup_jobs', entity_id: JOB_B,
        event_type: 'BACKUP_REQUESTED', timestamp: '2026-08-02T13:41:00Z',
        description: 'Action BACKUP_REQUESTED on backup_jobs', changed_by: null,
        actor_source: 'user', old_data: null,
        new_data: { origin: 'scheduled', note: 'nightly check' },
      },
    ]

    const respondWith = (events) => {
      api.get.mockImplementation((path) => {
        if (path.startsWith('/api/v1/digital-thread')) return Promise.resolve(events)
        if (path.startsWith('/api/v1/devices')) return Promise.resolve(DEVICES)
        return Promise.resolve([])
      })
    }

    /** The lane label containing `text`, as one element. */
    const laneLabelled = (text) =>
      [...document.querySelectorAll('.dt-lane-label')]
        .find(el => el.querySelector('.dt-lane-name')?.textContent === text)

    it('names a backup job for the act it was, not its uuid', async () => {
      respondWith(JOB_EVENTS)
      render(<DigitalThreadTab />)

      await waitFor(() => expect(laneLabelled('On request')).toBeTruthy())
      expect(laneLabelled('Scheduled')).toBeTruthy()
      // The uuid is gone from the label; it is still in the title and the drawer.
      expect(laneLabelled('On request').querySelector('.dt-lane-unnamed')).toBeNull()
    })

    it('keeps two jobs of the same kind apart with the short id', async () => {
      /* THE REASON THE QUALIFIER EXISTS. `origin` is a category: every job requested by hand shares
         it, and these two share a minute as well, so without the id they are one label drawn
         twice -- which is worse than the uuid it replaced, because it cannot be told apart at all. */
      respondWith([
        JOB_EVENTS[0],
        { ...JOB_EVENTS[1], entity_id: JOB_B, new_data: { origin: 'requested', note: 'x' } },
      ])
      render(<DigitalThreadTab />)

      await waitFor(() => expect(document.querySelectorAll('.dt-lane-qualifier').length).toBe(2))
      const chips = [...document.querySelectorAll('.dt-lane-qualifier')].map(c => c.textContent)
      expect(new Set(chips).size).toBe(2)
      expect(chips.every(c => c.startsWith('aaaaaaaa') || c.startsWith('bbbbbbbb'))).toBe(true)
    })

    it('does not call a backup job deleted, having no table it could probe', async () => {
      /* `backup_jobs` is outside DELETABLE_KINDS (0117), so naming it must not start flagging it. */
      respondWith(JOB_EVENTS)
      render(<DigitalThreadTab />)

      await waitFor(() => expect(laneLabelled('On request')).toBeTruthy())
      expect(document.querySelector('.dt-lane-gone')).toBeNull()
    })

    it('leaves a backup reading its stamp, which it shares the origin field with', async () => {
      /* ORDER IN THE FIELD LIST IS THE ASSERTION. A `backups` row carries both `stamp` and
         `origin`; the stamp is what the Backups page calls one, so `origin` sits last. */
      respondWith([{
        event_id: 23, entity_type: 'backups', entity_id: 'cccccccc-3333-4000-8000-000000000003',
        event_type: 'BACKUP_TAKEN', timestamp: '2026-08-02T13:41:00Z',
        description: 'Action BACKUP_TAKEN on backups', changed_by: null, actor_source: 'service',
        old_data: null, new_data: { stamp: '20260802T134100Z', origin: 'scheduled' },
      }])
      render(<DigitalThreadTab />)

      await waitFor(() => expect(laneLabelled('20260802T134100Z')).toBeTruthy())
      expect(laneLabelled('Scheduled')).toBeFalsy()
    })

    it('names a pinned service principal from the registry the Access Control page uses', async () => {
      respondWith([{
        event_id: 24, entity_type: 'service_principals', entity_id: MCP,
        event_type: 'TOKEN_MINTED', timestamp: '2026-08-02T13:41:00Z',
        description: 'Action TOKEN_MINTED on service_principals', changed_by: null,
        actor_source: 'user', old_data: null,
        new_data: { jti: '49d996ed-7420-476e-a710-0b46c37c7213', ttl_days: 1 },
      }])
      render(<DigitalThreadTab />)

      await waitFor(() => expect(laneLabelled('MCP read-only client')).toBeTruthy())
    })

    it('leaves an unregistered principal as its id rather than calling it Undocumented', async () => {
      /* describePrincipal() answers "Undocumented principal" for an unknown id, which is the right
         thing on a page listing one identity and the wrong thing here: every principal created at
         runtime would draw the same lane, and the reader could not tell them apart. */
      respondWith([{
        event_id: 25, entity_type: 'service_principals',
        entity_id: 'dddddddd-4444-4000-8000-000000000004',
        event_type: 'TOKEN_MINTED', timestamp: '2026-08-02T13:41:00Z',
        description: 'Action TOKEN_MINTED on service_principals', changed_by: null,
        actor_source: 'user', old_data: null, new_data: { jti: 'x', ttl_days: 1 },
      }])
      render(<DigitalThreadTab />)

      await waitFor(() => expect(document.querySelector('.dt-lane-unnamed')).toBeTruthy())
      expect(screen.queryByText(/Undocumented principal/)).not.toBeInTheDocument()
    })
  })

  /* The timeline is a flat grid -- ruled rows, not a stack of track cards -- asserted through the
     stylesheet because jsdom applies no layout. */
  /**
   * The rule body for a selector, from the stylesheet on disk. Local to these two describes; the
   * diff-table guards further down carry their own.
   */
  const ruleFor = (selector) => {
    const escaped = selector.replace(/[.:()\-*+?^${}|[\]\\]/g, '\\$&')
    return APP_CSS.match(new RegExp(`\\n${escaped} \\{([\\s\\S]*?)\\n\\}`))?.[1]
  }

  describe('swimlanes render as a flat grid', () => {
    it('draws the track bare, with no box of its own', async () => {
      // The row's dividers are the lane's edges; a box inside them was a second set.
      const rule = ruleFor('.dt-track')
      expect(rule).not.toMatch(/background:/)
      expect(rule).not.toMatch(/border:/)
      expect(rule).not.toMatch(/border-radius:/)
    })

    it('draws no guideline along the middle of a track', async () => {
      /* With a rule under every row, a second line through each one made the page a stack of
         rules for the eye to follow instead of markers. */
      expect(ruleFor('.dt-track::before')).toBeUndefined()
    })

    it('separates lanes with a hairline divider and no padding', async () => {
      const rule = ruleFor('.dt-lane')
      expect(rule).toMatch(/border-bottom:\s*1px solid var\(--border\)/)
      expect(rule).not.toMatch(/padding:/)
      expect(rule).toMatch(/gap:/)
    })

    it('keeps the label opaque, and draws no pill inside it', async () => {
      /* The label is sticky so markers pass under it, which needs an opaque background in the
         card's colour. The pill that used to be drawn inside it by ::before is gone with the boxes. */
      expect(ruleFor('.dt-lane-label')).toMatch(/background:\s*var\(--bg-card\)/)
      expect(ruleFor('.dt-lane-label::before')).toBeUndefined()
    })

    it('lights the row under the pointer, label column included', async () => {
      /* The row tint is translucent and the label is opaque, so the label takes the tint as an
         image over its own colour: the two match, and the label stays opaque. The axis row is not
         a lane and is left out. */
      expect(ruleFor('.dt-lane:not(.dt-axis):hover')).toMatch(/background:\s*var\(--bg-glass\)/)
      expect(ruleFor('.dt-lane:not(.dt-axis):hover .dt-lane-label'))
        .toMatch(/background-image:\s*linear-gradient\(var\(--bg-glass\)/)
    })

    it('renders the section heading as a row of the grid', async () => {
      await show()
      const heading = document.querySelector('.dt-section')
      expect(heading).toBeTruthy()
      // The same two columns as a lane: a sticky label holding the name and its count, and an
      // empty track, so the heading takes the row's rule and the row's rhythm, and the first lane
      // under it has an edge above it.
      const label = heading.querySelector('.dt-lane-label')
      expect(label).toBeTruthy()
      expect(label.querySelector('.dt-section-name')).toBeTruthy()
      expect(label.querySelector('.dt-section-count')).toBeTruthy()
      expect(heading.querySelector('.dt-track')).toBeTruthy()
      // Not a pill: nothing draws a badge any more.
      expect(ruleFor('.dt-section-badge')).toBeUndefined()
      expect(ruleFor('.dt-section')).not.toMatch(/border-radius/)
      expect(ruleFor('.dt-section')).toMatch(/border-bottom:\s*1px solid var\(--border\)/)
    })

    it('rules the edge of the label column on every row', async () => {
      // The axis corner and the headings are .dt-lane-label too, so one rule draws the whole
      // column edge; a rule on lanes alone would break at every heading.
      expect(ruleFor('.dt-lane-label')).toMatch(/border-right:\s*1px solid var\(--border\)/)
    })

    it('carries the kind on the heading, not on every row under it', async () => {
      /* The heading is pinned in view since the axis was, so an icon on each lane repeated what
         was always on screen and cost the name its width. */
      await show()
      expect(document.querySelector('.dt-section .dt-lane-label svg')).toBeTruthy()
      const laneLabels = [...document.querySelectorAll('.dt-lane:not(.dt-axis) .dt-lane-label')]
      expect(laneLabels.length).toBeGreaterThan(0)
      expect(laneLabels.some(l => l.querySelector('svg'))).toBe(false)
    })
  })

  describe('the selected marker is findable among the ones it is stacked with', () => {
    it('rings the active node in a solid accent rather than a halo', async () => {
      /* `--accent-glow` alone is translucent and almost disappears in a dense stretch of track; the
         inner gap in the card colour separates the selected mark. */
      const rule = ruleFor('.dt-node-selected')
      expect(rule).toMatch(/var\(--accent\)/)
      expect(rule).toMatch(/var\(--bg-card\)/)
    })

    it('is shared with the cluster badge rather than being a .dt-node compound', async () => {
      /* What lets a badge carry the ring while the drawer steps through the events inside it.
         Written `.dt-node.dt-node-selected`, a selected group would show no highlight. */
      expect(APP_CSS).toContain('\n.dt-node-selected {')
      expect(APP_CSS).not.toContain('.dt-node.dt-node-selected {')
    })

    it('paints the cluster badge outside the four-colour classification', async () => {
      /* A badge is a count, not a kind of event, so it borrows none of the four fills. */
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
    // The schema fetch exists so the audit log can say which schema an event was about: schemas are
    // audited, and absence from the name lookup is how this page recognises a purged asset.
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

    /* The version is part of the identity: a lineage is a chain of rows sharing one `schema_name`,
       and which version something happened to is the point of a schema's audit trail. It is drawn
       as its OWN element rather than appended, because appended it is the end of the string and the
       end of the string is what a fixed-width label ellipsises first -- sixteen versions of one
       schema drew sixteen lanes reading `VALIDATE_Schema_Robot_St…`. */
    await waitFor(() => expect(screen.getByText('Test-Schema')).toBeInTheDocument())
    const label = screen.getByText('Test-Schema').closest('.dt-lane-label')
    expect(within(label).getByText('v2')).toHaveClass('dt-lane-qualifier')
    // And still one string wherever one is wanted -- the hover, the export, the drawer.
    expect(label.getAttribute('title')).toContain('Test-Schema v2')
    expect(screen.queryByText(SCHEMA_ID)).toBeNull()
  })

  it('keeps the version out of the part that can be ellipsised away', async () => {
    // The property, stated against the stylesheet: `.dt-lane-name` is the one element allowed to
    // lose characters, so the qualifier must not be inside it and must not shrink.
    const rule = APP_CSS.match(/\n\.dt-lane-qualifier \{([\s\S]*?)\n\}/)?.[1]
    expect(rule, '.dt-lane-qualifier has no rule in App.css').toBeTruthy()
    expect(rule).toMatch(/flex-shrink:\s*0/)
    expect(APP_CSS.match(/\n\.dt-lane-name \{([\s\S]*?)\n\}/)?.[1])
      .toMatch(/text-overflow:\s*ellipsis/)
  })

  it('still filters by name, which was sharing the id-restriction path with tags', async () => {
    await show()
    fireEvent.change(screen.getByPlaceholderText(/Search by name, entity, mutation or transaction ID/), { target: { value: 'Press' } })

    await waitFor(() => expect(lastThreadUrl()).toContain('search=Press'))
  })
})

/**
 * Timeline density and layout, read from App.css since jsdom does no layout: a lane is 28px so
 * about thirty fit a 1080p card, and the label is sticky because opening the drawer takes width
 * off this list.
 */
describe('Digital Thread timeline density', () => {
  const rule = (selector) =>
    APP_CSS.match(new RegExp(`\\n${selector.replace(/[.:()\\-]/g, '\\$&')} \\{([\\s\\S]*?)\\n\\}`))?.[1]

  it('keeps a lane to 28px', () => {
    expect(rule('.dt-track')).toMatch(/height:\s*28px/)
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

