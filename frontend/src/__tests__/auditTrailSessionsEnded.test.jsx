/**
 * Audit Trail: SESSIONS_ENDED, in a person's lane. An Administrator's End Sessions (0207) and a
 * person's own Sign Out of All Other Sessions (0211) record how many ended; a person's own End
 * (0211) records the one session as their Sessions list returned it, and the drawer names it as
 * that list does. The User ID field says who ended them.
 */
import React from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuditTrailTab } from '../components/tabs/AuditTrailTab'
import { api } from '../api'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { listUserAccounts: vi.fn(), get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const PERSON = '5e55a0e0-0000-4000-8000-000000000211'
const ADMIN = '5e55a0e0-0000-4000-8000-0000000002a1'

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

const ended = (id, changedBy, newData, timestamp) => ({
  event_id: id, entity_type: 'user_roles', entity_id: PERSON, event_type: 'SESSIONS_ENDED', timestamp,
  causation_id: 500 + id, description: `Action SESSIONS_ENDED on user_roles [${PERSON}]`,
  changed_by: changedBy, actor_source: 'user', audit_domain: 'security', old_data: null, new_data: newData,
})

const EVENTS = [
  ended(1, ADMIN, { email: 'owain@site.test', sessions_ended: 3 }, '2026-10-24T09:00:00Z'),
  ended(2, PERSON, {
    email: 'owain@site.test', sessions_ended: 1,
    session: { service_name: null, user_agent: CHROME, created_at: '2026-10-20T08:00:00+00:00', last_active_at: '2026-10-25T07:00:00+00:00' },
  }, '2026-10-25T10:00:00Z'),
  ended(3, PERSON, {
    email: 'owain@site.test', sessions_ended: 1,
    session: { service_name: 'Aber Grafana', user_agent: 'Node-oauth', created_at: '2026-10-25T08:00:00+00:00', last_active_at: '2026-10-25T09:00:00+00:00' },
  }, '2026-10-25T11:00:00Z'),
  ended(4, PERSON, { email: 'owain@site.test', sessions_ended: 4 }, '2026-10-26T09:00:00Z'),
]

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation((path) => Promise.resolve(path.startsWith('/api/v1/audit-trail') ? EVENTS : []))
  api.listUserAccounts.mockResolvedValue([
    { user_id: PERSON, email: 'owain@site.test', display_name: 'Owain Operator' },
    { user_id: ADMIN, email: 'admin@site.test', display_name: 'Ada Admin' },
  ])
})

afterEach(() => {
  cleanup()
  window.history.replaceState({}, '', '/')
})

/** Opens the drawer on one event, by its address, and returns the diff's rows. */
const open = async (eventId) => {
  window.history.replaceState({}, '', `/audit-trail?event=${eventId}`)
  render(<AuditTrailTab userRole="Administrator" />)
  await waitFor(() => expect(document.querySelector('.context-panel-open .trail-diff')).toBeTruthy())
  const diff = document.querySelector('.trail-diff')
  const rows = Object.fromEntries([...diff.querySelectorAll('tbody tr')]
    .map(tr => [tr.querySelector('th').textContent, tr.querySelector('td').textContent]))
  return { diff, rows }
}

/** The drawer's User ID field, once the person lookups have named it. */
const userIdShows = (name) => waitFor(() => {
  const field = [...document.querySelectorAll('.context-panel-open dt')].find(dt => dt.textContent.includes('User ID'))
  expect(field?.nextElementSibling).toHaveTextContent(name)
})

describe('SESSIONS_ENDED in the drawer', () => {
  it("reads an Administrator's End Sessions as who ended how many", async () => {
    const { diff, rows } = await open(1)
    expect(within(diff).getByText('Sessions ended')).toBeInTheDocument()
    expect([...diff.querySelectorAll('thead th')].map(th => th.textContent)).toEqual(['Property', 'Ended'])
    expect(rows).toEqual({ email: 'owain@site.test', sessions_ended: '3' })
    await userIdShows('Ada Admin')
  })

  it("names the one session a person ended as their Sessions list names it", async () => {
    const { diff, rows } = await open(2)
    expect(rows).toEqual({ email: 'owain@site.test', session: 'Chrome on Windows', sessions_ended: '1' })
    // The raw facts are in the payload, not in the diff.
    expect(within(diff).queryByText(CHROME)).toBeNull()
    expect(screen.getByText(/"user_agent": "Mozilla\/5\.0/)).toBeInTheDocument()
    await userIdShows('Owain Operator')
  })

  it('names a service session by its service', async () => {
    const { rows } = await open(3)
    expect(rows.session).toBe('Grafana')
  })

  it("reads a person's Sign Out of All Other Sessions as how many, ended by themselves", async () => {
    const { rows } = await open(4)
    expect(rows).toEqual({ email: 'owain@site.test', sessions_ended: '4' })
    await userIdShows('Owain Operator')
  })
})
