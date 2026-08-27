/**
 * Digital Thread: the action filter, and the two vocabularies this page speaks (issue #37).
 *
 * WHAT WAS REPORTED. "The Any Event filter field shows three options: Created, Updated and Deleted.
 * The graph below shows four events: Created, Operational, Configuration and Lifecycle. Some of the
 * events show a pill stating Inserted also, is this an event?"
 *
 * That is one screen carrying TWO OVERLAPPING TAXONOMIES and labelling them as if they were one:
 *
 *   * `digital_thread.action` -- what the database did. INSERT / UPDATE / DELETE, plus
 *     SCHEMA_REJECTION since migration 0026. This is what the drawer's badge shows.
 *   * `MARKERS` -- what it MEANT, derived client-side from the diff. Created / Operational /
 *     Configuration / Lifecycle, which is what colours the timeline.
 *
 * They are not the same partition. The filter's "Created" was INSERT, and the legend's "Lifecycle"
 * spans a DELETE *and* any UPDATE that archived or quarantined a row. Reusing two of the legend's
 * words for a different axis is what made them look like one taxonomy with a missing option.
 *
 * AND A SECOND BUG, NOT REPORTED, FOUND WHILE FIXING THE FIRST. `api.js` turned the choice into a
 * SQL predicate behind a hand-written allow-list, `['INSERT', 'UPDATE', 'DELETE']`. When 0026 added
 * SCHEMA_REJECTION the filter could not select it -- and it did not fail loudly. An unlisted action
 * fell through the `if` and applied NO predicate, so asking for one kind of event returned EVERY
 * kind. The tests below pin the refusal, because "returns everything" is the failure mode a caller
 * cannot see.
 */
import React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DigitalThreadTab, MARKERS } from '../components/tabs/DigitalThreadTab'
import { DIGITAL_THREAD_ACTIONS } from '../constants'
import { api } from '../api'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const DEVICES = [{ asset_id: 'dev-1', asset_name: 'Simulated_CNC_01', last_birth_metrics: [] }]
const EVENTS = [{
  event_id: 1, entity_type: 'devices', entity_id: 'dev-1', event_type: 'UPDATE',
  timestamp: '2026-08-21T09:00:00Z', causation_id: 10,
  description: 'Action UPDATE on devices [dev-1]',
  changed_by: null, actor_source: 'ingestion',
  old_data: { name: 'Simulated_CNC_01', status: 'OFFLINE' },
  new_data: { name: 'Simulated_CNC_01', status: 'ONLINE' }
}]

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/digital-thread')) return Promise.resolve(EVENTS)
    if (path.startsWith('/api/v1/devices')) return Promise.resolve(DEVICES)
    return Promise.resolve([])
  })
})

const show = async () => {
  render(<DigitalThreadTab />)
  await waitFor(() => expect(screen.getByText('Simulated_CNC_01')).toBeInTheDocument())
}

const filter = () => screen.getByTitle(/Filter by the database action/)
const threadUrls = () => api.get.mock.calls.map(c => c[0]).filter(u => u.includes('/digital-thread'))


describe('the action filter offers every action the database can record', () => {
  /*
   * THREE OF THESE ARE NOT WRITTEN BY THE AUDIT TRIGGER, and each arrived with a feature that would
   * have been unfilterable without an entry here: SCHEMA_REJECTION with 0026, CREDENTIAL_ISSUED with
   * 0041, TOKEN_MINTED with 0043. This assertion is spelled out rather than derived so that adding
   * a fourth is a deliberate edit -- the test below already proves the list cannot drift from the
   * enum, and a check that only compared them to each other would pass while both were wrong.
   */
  it('lists every action, including the three the trigger does not write', async () => {
    await show()
    const values = [...filter().querySelectorAll('option')].map(o => o.value)

    expect(values).toEqual([
      '', 'INSERT', 'UPDATE', 'DELETE', 'SCHEMA_REJECTION', 'CREDENTIAL_ISSUED', 'TOKEN_MINTED'
    ])
  })

  it('is generated from the shared enum, so it cannot drift from the API allow-list', async () => {
    /*
     * THE POINT OF THE SHARED CONSTANT. The options and `api.js`'s allow-list were two hand-written
     * lists that no test compared, which is exactly how 0026 could add an action that the filter
     * silently could not select.
     */
    await show()
    const values = [...filter().querySelectorAll('option')].map(o => o.value).filter(Boolean)

    expect(values).toEqual(Object.keys(DIGITAL_THREAD_ACTIONS))
  })

  it('pushes the selected action down as a query parameter', async () => {
    await show()
    fireEvent.change(filter(), { target: { value: 'SCHEMA_REJECTION' } })

    await waitFor(() =>
      expect(threadUrls().some(u => u.includes('action=SCHEMA_REJECTION'))).toBe(true))
  })
})


describe('the two vocabularies are kept apart', () => {
  it('the filter labels name the database action, not the marker classes', async () => {
    /*
     * The specific confusion in #37. "Created" appeared in BOTH the filter and the legend meaning
     * different things, and "Updated"/"Deleted" had no legend counterpart at all. The filter now
     * matches the raw badge shown in the event drawer instead.
     */
    await show()
    const labels = [...filter().querySelectorAll('option')].map(o => o.textContent)
    const markerLabels = Object.values(MARKERS).map(m => m.label)

    for (const label of labels.filter(l => l !== 'Any action')) {
      expect(markerLabels).not.toContain(label)
    }
  })

  it('the placeholder says "action", not "event"', async () => {
    await show()
    expect(filter().querySelector('option[value=""]').textContent).toBe('Any action')
  })

  it('the legend still describes the derived classification', async () => {
    // Both vocabularies remain on screen; the fix is that they no longer share words.
    await show()
    for (const marker of Object.values(MARKERS)) {
      expect(screen.getAllByTitle(marker.hint).length).toBeGreaterThan(0)
    }
  })
})


describe('an unrecognised action must not widen the query', () => {
  /*
   * Exercised against the REAL api module, not the mock, because this is the branch that decides
   * whether an unknown filter returns nothing or everything -- and the mocked `api.get` above is
   * precisely the layer that would hide it.
   */
  it('returns no rows rather than every row', async () => {
    const { api: realApi } = await vi.importActual('../api')
    const rows = await realApi.get('/api/v1/digital-thread?action=NOT_AN_ACTION')

    expect(rows).toEqual([])
  })

  it('sends a recognised action to the database instead of short-circuiting', async () => {
    /*
     * THE OTHER DIRECTION, and the allow-list must not be narrower than the filter: if it were, a
     * legitimate option would return an empty list and read as "no such events ever happened" --
     * the same invisible failure in reverse.
     *
     * ASSERTED ON WHETHER A QUERY WAS BUILT, not on what came back. The first version of this test
     * ran each valid action for real and expected it to REJECT, on the reasoning that a request
     * reaching a dead backend fails fast. It does locally. In CI there is no Supabase at all, so
     * the fetch hung and the test died on a 5s timeout -- a test that passed or failed on network
     * timing rather than on the branch it was written to cover. Stubbing the client makes the
     * question deterministic and offline: did the recognised action reach `.from()`, and did the
     * unrecognised one not?
     */
    vi.resetModules()
    // THE STUB FOLLOWS THE MECHANISM. This page is served by the `digital_thread_page` RPC since
    // migration 0039 -- the deleted-asset filter is an anti-join PostgREST cannot express -- so the
    // recognised action now has to arrive as an ARGUMENT rather than as a `.eq()` on a builder.
    // The question the test asks is unchanged: did it reach the database, and did the unrecognised
    // one stop here?
    const built = []
    vi.doMock('../lib/supabaseClient', () => ({
      supabase: {
        from: () => { throw new Error('the digital thread page must go through the RPC') },
        rpc: (fn, args) => {
          built.push([fn, args])
          return Promise.resolve({
            data: { events: [], purged_assets: 0, truncated: false }, error: null
          })
        }
      },
      SUPABASE_URL: 'http://localhost:54321',
      SUPABASE_ANON_KEY: 'test'
    }))

    const { api: realApi } = await vi.importActual('../api')

    for (const action of Object.keys(DIGITAL_THREAD_ACTIONS)) {
      built.length = 0
      await realApi.get(`/api/v1/digital-thread?action=${action}`)
      expect(built.length, `${action} should have reached the RPC`).toBe(1)
      expect(built[0][0]).toBe('digital_thread_page')
      expect(built[0][1].p_action, `${action} should have become an argument`).toBe(action)
    }

    built.length = 0
    await expect(realApi.get('/api/v1/digital-thread?action=NOT_AN_ACTION')).resolves.toEqual([])
    expect(built, 'an unrecognised action must not reach the database at all').toEqual([])

    vi.doUnmock('../lib/supabaseClient')
    vi.resetModules()
  })
})
