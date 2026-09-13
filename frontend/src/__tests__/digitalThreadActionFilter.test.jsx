/**
 * Digital Thread: the action filter, and the two vocabularies this page speaks.
 * `digital_thread.action` is what the database did (INSERT / UPDATE / DELETE plus the
 * trigger-written kinds), shown on the drawer's badge; `MARKERS` is what it meant, derived
 * client-side and colouring the timeline. The filter must use the first vocabulary. The allow-list
 * in api.js must refuse an unknown action rather than apply no predicate, because "returns
 * everything" is a failure a caller cannot see.
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
  /* Several of these are not written by the generic audit trigger. Spelled out rather than derived,
     so adding one is a deliberate edit; the test below proves the list cannot drift from the enum. */
  it('lists every action, including the sixteen the generic trigger does not write', async () => {
    await show()
    const values = [...filter().querySelectorAll('option')].map(o => o.value)

    // Pinned in order as well as by membership, because this select is what a reader scans.
    expect(values).toEqual([
      '', 'INSERT', 'UPDATE', 'DELETE', 'SCHEMA_REJECTION', 'CREDENTIAL_ISSUED', 'TOKEN_MINTED',
      'TOKEN_REVOKED', 'PROPOSAL_APPLIED', 'PROPOSAL_EXPIRED', 'ROLE_GRANTED', 'ROLE_REVOKED',
      'FLOW_DEPLOYED', 'BACKUP_REQUESTED', 'BACKUP_CANCELLED', 'BACKUP_RELEASED', 'BACKUP_TAKEN',
      'BACKUP_FAILED', 'BACKUP_PRUNED'
    ])
  })

  it('is generated from the shared enum, so it cannot drift from the API allow-list', async () => {
    /* The point of the shared constant: the options and `api.js`'s allow-list must not be two
       hand-written lists. */
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
    /* The filter matches the raw badge shown in the event drawer, not the legend's derived words. */
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
  /* Exercised against the real api module, because this branch decides whether an unknown filter
     returns nothing or everything. */
  it('returns no rows rather than every row', async () => {
    const { api: realApi } = await vi.importActual('../api')
    const rows = await realApi.get('/api/v1/digital-thread?action=NOT_AN_ACTION')

    expect(rows).toEqual([])
  })

  it('sends a recognised action to the database instead of short-circuiting', async () => {
    /* The other direction: the allow-list must not be narrower than the filter, or a legitimate
       option reads as "no such events". Asserted on whether a query was built, not on what came
       back, so the test is deterministic offline. */
    vi.resetModules()
    // The stub follows the mechanism: this page is served by the `digital_thread_page` RPC, so the
    // recognised action arrives as an argument rather than a `.eq()` on a builder.
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
      SUPABASE_GATEWAY_KEY: 'test'
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
