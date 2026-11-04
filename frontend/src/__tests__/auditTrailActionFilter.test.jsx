/**
 * Audit Trail: the action filter, and the two vocabularies this page speaks.
 * `audit_trail.action` is what the database did (INSERT / UPDATE / DELETE plus the
 * trigger-written kinds), shown on the drawer's badge; `MARKERS` is what it meant, the class the
 * server names and the legend's toggles choose, colouring the timeline. The filter must use the first vocabulary. The allow-list
 * in api.js must refuse an unknown action rather than apply no predicate, because "returns
 * everything" is a failure a caller cannot see.
 */
import React from 'react'
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AuditTrailTab, MARKERS } from '../components/tabs/AuditTrailTab'
import { AUDIT_TRAIL_ACTIONS, AUDIT_TRAIL_ACTION_GROUPS } from '../constants'
import { api } from '../api'
import { tooltipOf } from '../test/tooltips'
import { filterList, offered, toggleInList } from '../test/listFilters'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { listUserAccounts: vi.fn(() => Promise.resolve([])), get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const DEVICES = [{ asset_id: 'dev-1', asset_name: 'Simulated_CNC_01', last_birth_metrics: [] }]
const EVENTS = [{
  event_id: 1, entity_type: 'devices', entity_id: 'dev-1', event_type: 'UPDATE',
  timestamp: '2026-08-21T09:00:00Z', causation_id: 10,
  description: 'Action UPDATE on devices [dev-1]',
  changed_by: 'ingestion-principal-1', actor_source: 'ingestion',
  old_data: { name: 'Simulated_CNC_01', status: 'OFFLINE' },
  new_data: { name: 'Simulated_CNC_01', status: 'ONLINE' }
}]

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/audit-trail')) return Promise.resolve(EVENTS)
    if (path.startsWith('/api/v1/devices')) return Promise.resolve(DEVICES)
    return Promise.resolve([])
  })
})

const show = async () => {
  render(<AuditTrailTab />)
  await waitFor(() => expect(screen.getByText('Simulated_CNC_01')).toBeInTheDocument())
}

/** The action filter: a list in the Filters popover, which is opened first. */
const filter = () => filterList('Action')
/** The actions it offers, by their labels, in order. */
const labels = () => offered(filter())
const LABEL_TO_ACTION = Object.fromEntries(Object.entries(AUDIT_TRAIL_ACTIONS).map(([k, v]) => [v, k]))
const trailUrls = () => api.get.mock.calls.map(c => c[0]).filter(u => u.includes('/audit-trail'))


describe('the action filter offers every action the database can record', () => {
  /* Several of these are not written by the generic audit trigger. Spelled out rather than derived,
     so adding one is a deliberate edit; the test below proves the list cannot drift from the enum. */
  it('lists every action, including the forty-three the generic trigger does not write, in groups', async () => {
    await show()
    const values = labels().map(l => LABEL_TO_ACTION[l])

    // Pinned in order as well as by membership, because this list is what a reader scans: by
    // group, then each group's order.
    expect(values).toEqual([
      'INSERT', 'UPDATE', 'DELETE',
      'SCHEMA_REJECTION', 'PROPOSAL_APPLIED', 'PROPOSAL_EXPIRED', 'FLOW_DEPLOYED',
      'CAPTURE_STARTED', 'CAPTURE_STOPPED', 'CAPTURE_RECORDED', 'CAPTURE_UPLOADED',
      'CAPTURE_DELETED', 'PLAYBACK_STARTED', 'PLAYBACK_STOPPED',
      'PERSON_ADDED', 'ROLE_GRANTED', 'ROLE_REVOKED', 'ACCESS_REMOVED', 'ACCESS_RESTORED',
      'PASSWORD_SET', 'DISPLAY_NAME_CHANGED', 'EMAIL_CHANGED', 'SESSIONS_ENDED', 'MFA_RESET',
      'APP_REGISTERED', 'APP_REMOVED', 'APP_RESTORED', 'APP_APPROVED', 'APP_APPROVAL_REVOKED',
      'PRINCIPAL_REVOKED', 'PRINCIPAL_REINSTATED', 'PRINCIPAL_DESCRIBED', 'TOKEN_MINTED',
      'TOKEN_REVOKED', 'CREDENTIAL_ISSUED',
      'BACKUP_REQUESTED', 'BACKUP_CANCELLED', 'BACKUP_RELEASED', 'BACKUP_TAKEN', 'BACKUP_FAILED',
      'BACKUP_PRUNED',
      // The reads, the legend's Read class, together.
      'SERVICE_LOGS_READ', 'CREDENTIAL_SHOWN', 'CAPTURE_DOWNLOAD_ISSUED', 'EXPORTED'
    ])
    const headings = within(filter()).getAllByRole('group')
      .map(g => document.getElementById(g.getAttribute('aria-labelledby')).textContent)
    expect(headings).toEqual(AUDIT_TRAIL_ACTION_GROUPS.map(g => g.label))
  })

  it('is generated from the shared enum, so it cannot drift from the API allow-list', async () => {
    /* The point of the shared constant: the options and `api.js`'s allow-list must not be two
       hand-written lists. Every action is in exactly one group. */
    await show()
    const values = labels().map(l => LABEL_TO_ACTION[l])

    expect([...values].sort()).toEqual(Object.keys(AUDIT_TRAIL_ACTIONS).sort())
    expect(new Set(values).size).toBe(values.length)
  })

  it('pushes the chosen actions down as one query parameter', async () => {
    await show()
    toggleInList('Action', 'Schema rejection')
    await waitFor(() =>
      expect(trailUrls().some(u => u.includes('action=SCHEMA_REJECTION'))).toBe(true))
    toggleInList('Action', 'Exported')
    await waitFor(() =>
      expect(trailUrls().some(u => u.includes(`action=${encodeURIComponent('SCHEMA_REJECTION,EXPORTED')}`))).toBe(true))
  })

  it('chooses a whole group from its heading', async () => {
    await show()
    fireEvent.click(within(filter()).getByRole('checkbox', { name: 'Backups' }))
    await waitFor(() => expect(new URL(trailUrls().at(-1), 'http://x').searchParams.get('action'))
      .toBe('BACKUP_REQUESTED,BACKUP_CANCELLED,BACKUP_RELEASED,BACKUP_TAKEN,BACKUP_FAILED,BACKUP_PRUNED'))
  })
})


describe('the two vocabularies are kept apart', () => {
  it('the filter labels name the database action, not the marker classes', async () => {
    /* The filter matches the raw badge shown in the event drawer, not the legend's derived words. */
    await show()
    const markerLabels = Object.values(MARKERS).map(m => m.label)

    for (const label of labels()) {
      expect(markerLabels).not.toContain(label)
    }
  })

  it('the filter is called "Action", not "Event"', async () => {
    await show()
    expect(filter()).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: /event/i })).toBeNull()
  })

  it('the legend still describes the classes', async () => {
    // Both vocabularies remain on screen; the fix is that they no longer share words. A toggle's
    // tooltip opens with its class's hint and goes on to say what selecting it does.
    await show()
    const tips = within(screen.getByRole('group', { name: 'Classes' })).getAllByRole('button').map(tooltipOf)
    for (const marker of Object.values(MARKERS)) {
      expect(tips.some(t => t?.startsWith(`${marker.hint}. `)), marker.label).toBe(true)
    }
  })
})


describe('an unrecognised action must not widen the query', () => {
  /* Exercised against the real api module, because this branch decides whether an unknown filter
     returns nothing or everything. */
  it('returns no rows rather than every row', async () => {
    const { api: realApi } = await vi.importActual('../api')
    const rows = await realApi.get('/api/v1/audit-trail?action=NOT_AN_ACTION')

    expect(rows).toEqual([])
  })

  it('sends a recognised action to the database instead of short-circuiting', async () => {
    /* The other direction: the allow-list must not be narrower than the filter, or a legitimate
       option reads as "no such events". Asserted on whether a query was built, not on what came
       back, so the test is deterministic offline. */
    vi.resetModules()
    // The stub follows the mechanism: this page is served by the `audit_trail_page` RPC, so the
    // recognised action arrives as an argument rather than a `.eq()` on a builder.
    const built = []
    vi.doMock('../lib/supabaseClient', () => ({
      supabase: {
        from: () => { throw new Error('the audit trail page must go through the RPC') },
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

    for (const action of Object.keys(AUDIT_TRAIL_ACTIONS)) {
      built.length = 0
      await realApi.get(`/api/v1/audit-trail?action=${action}`)
      expect(built.length, `${action} should have reached the RPC`).toBe(1)
      expect(built[0][0]).toBe('audit_trail_page')
      expect(built[0][1].p_action, `${action} should have become an argument`).toEqual([action])
    }

    built.length = 0
    await expect(realApi.get('/api/v1/audit-trail?action=NOT_AN_ACTION')).resolves.toEqual([])
    expect(built, 'an unrecognised action must not reach the database at all').toEqual([])

    vi.doUnmock('../lib/supabaseClient')
    vi.resetModules()
  })
})
