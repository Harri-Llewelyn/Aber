/**
 * Audit Trail: SERVICE_LOGS_READ, in the Service logs lane. A read of a service's logs (0225) records
 * what was asked for; there is no prior state, so the drawer shows it one-sided, as a read. A fixed
 * window's ends are stored in UTC and shown as one row in local time, so this suite runs in London's
 * zone, where 2026's clocks went back on 25 October, and puts the machine's back afterwards.
 */
import React from 'react'
import { cleanup, render, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuditTrailTab } from '../components/tabs/AuditTrailTab'
import { api } from '../api'

const MACHINE_TZ = process.env.TZ
process.env.TZ = 'Europe/London'
afterAll(() => {
  if (MACHINE_TZ === undefined) delete process.env.TZ
  else process.env.TZ = MACHINE_TZ
})

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { listUserAccounts: vi.fn(), get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const ADMIN = '5e55a0e0-0000-4000-8000-0000000008a1'

/** A read of the ingestion service's logs, asking for `asked`: a range, or a window's two ends. */
const readOf = (asked) => [{
  event_id: 1, entity_type: 'service_logs', entity_id: '0f8e5c2a-0000-4000-8000-000000000841',
  event_type: 'SERVICE_LOGS_READ', timestamp: '2026-11-04T10:00:00Z', causation_id: 841,
  description: 'Action SERVICE_LOGS_READ on service_logs', changed_by: ADMIN, actor_source: 'user',
  audit_domain: 'security', old_data: null,
  new_data: { name: 'ingestion', level: 'warn', filter: 'Dropped', ...asked },
}]

let served
beforeEach(() => {
  vi.clearAllMocks()
  // The year is 2026, so the window's ends name no year.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 5, 12, 0))
  served = readOf({ range: '1h' })
  api.get.mockImplementation((path) => Promise.resolve(path.startsWith('/api/v1/audit-trail') ? served : []))
  api.listUserAccounts.mockResolvedValue([{ user_id: ADMIN, email: 'admin@site.test', display_name: 'Ada Admin' }])
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  window.history.replaceState({}, '', '/')
})

/** The drawer's diff for the read, once it is open. */
const openDrawer = async () => {
  window.history.replaceState({}, '', '/audit-trail?event=1')
  render(<AuditTrailTab userRole="Administrator" />)
  await waitFor(() => expect(document.querySelector('.context-panel-open .trail-diff')).toBeTruthy())
  return document.querySelector('.trail-diff')
}
/** The table's rows as [property, value]. */
const rowsOf = (diff) => [...diff.querySelectorAll('tbody tr')]
  .map(tr => [tr.querySelector('th').textContent, tr.querySelector('td').textContent])

describe('SERVICE_LOGS_READ in the drawer', () => {
  it('reads as what was asked for, one-sided, with no Previous column', async () => {
    const diff = await openDrawer()
    expect(within(diff).getByText('Logs read')).toBeInTheDocument()
    expect(diff.querySelector('.trail-diff-table').className).toContain('trail-diff-onesided')
    expect([...diff.querySelectorAll('thead th')].map(th => th.textContent)).not.toContain('Previous')
  })

  it('names a rolling read\'s range as it was stored', async () => {
    const diff = await openDrawer()
    expect(rowsOf(diff)).toEqual([['filter', 'Dropped'], ['level', 'warn'], ['name', 'ingestion'], ['range', '1h']])
  })

  it('shows a fixed window as one row in local time, in place of its two ends in UTC', async () => {
    served = readOf({ from: '2026-11-03T09:00:00.000Z', to: '2026-11-04T09:00:00.000Z' })
    const diff = await openDrawer()
    expect(rowsOf(diff)).toEqual([
      ['filter', 'Dropped'], ['level', 'warn'], ['name', 'ingestion'], ['window', '3 Nov 09:00 – 4 Nov 09:00'],
    ])
  })

  it('reads a window across the clocks going back in the local time of each end', async () => {
    // 09:00 BST on the 24th, and 09:00 GMT on the 25th: 25 hours apart, each 09:00 where it was read.
    served = readOf({ from: '2026-10-24T08:00:00.000Z', to: '2026-10-25T09:00:00.000Z' })
    const diff = await openDrawer()
    expect(rowsOf(diff)).toContainEqual(['window', '24 Oct 09:00 – 25 Oct 09:00'])
  })

  it('keeps the stored UTC ends in the payload below the table', async () => {
    served = readOf({ from: '2026-10-24T08:00:00.000Z', to: '2026-10-25T09:00:00.000Z' })
    await openDrawer()
    const payload = document.querySelector('.trail-raw').textContent
    expect(payload).toContain('"from": "2026-10-24T08:00:00.000Z"')
    expect(payload).toContain('"to": "2026-10-25T09:00:00.000Z"')
  })

  it('leaves the two rows as stored when an end is not an instant', async () => {
    served = readOf({ from: '2026-11-03T09:00:00.000Z', to: 'soon' })
    const diff = await openDrawer()
    expect(rowsOf(diff).map(([field]) => field)).toEqual(['filter', 'from', 'level', 'name', 'to'])
  })
})
