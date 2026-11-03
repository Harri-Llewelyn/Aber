/**
 * Audit Trail: SERVICE_LOGS_READ, in the Service logs lane. A read of a service's logs (0225) records
 * what was asked for; there is no prior state, so the drawer shows it one-sided, as a read.
 */
import React from 'react'
import { cleanup, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuditTrailTab } from '../components/tabs/AuditTrailTab'
import { api } from '../api'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { listUserAccounts: vi.fn(), get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const ADMIN = '5e55a0e0-0000-4000-8000-0000000008a1'

const EVENTS = [{
  event_id: 1, entity_type: 'service_logs', entity_id: '0f8e5c2a-0000-4000-8000-000000000841',
  event_type: 'SERVICE_LOGS_READ', timestamp: '2026-11-03T10:00:00Z', causation_id: 841,
  description: 'Action SERVICE_LOGS_READ on service_logs', changed_by: ADMIN, actor_source: 'user',
  audit_domain: 'security', old_data: null,
  new_data: { name: 'ingestion', level: 'warn', filter: 'Dropped', range: '1h' },
}]

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation((path) => Promise.resolve(path.startsWith('/api/v1/audit-trail') ? EVENTS : []))
  api.listUserAccounts.mockResolvedValue([{ user_id: ADMIN, email: 'admin@site.test', display_name: 'Ada Admin' }])
})

afterEach(() => {
  cleanup()
  window.history.replaceState({}, '', '/')
})

describe('SERVICE_LOGS_READ in the drawer', () => {
  it('reads as what was asked for, one-sided, with no Previous column', async () => {
    window.history.replaceState({}, '', '/audit-trail?event=1')
    render(<AuditTrailTab userRole="Administrator" />)
    await waitFor(() => expect(document.querySelector('.context-panel-open .trail-diff')).toBeTruthy())
    const diff = document.querySelector('.trail-diff')
    expect(within(diff).getByText('Logs read')).toBeInTheDocument()
    expect(diff.querySelector('.trail-diff-table').className).toContain('trail-diff-onesided')
    expect([...diff.querySelectorAll('thead th')].map(th => th.textContent)).not.toContain('Previous')
  })
})
