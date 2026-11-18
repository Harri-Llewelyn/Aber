/**
 * Audit Trail: a metric's further semantic ids (0299). Each add and remove is filed under the
 * metric's id, so the lane is the metric's and is named by it: a lane holding only these acts, with
 * no change of the metric's own in the window, still reads as the metric and not as a short UUID.
 */
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AuditTrailTab, shortId } from '../components/tabs/AuditTrailTab'
import { api } from '../api'
import { AUDIT_TRAIL_ENTITY_TYPES, ENTITY_KIND_BY_TABLE } from '../constants'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { listUserAccounts: vi.fn(() => Promise.resolve([])), get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const METRIC = '7c1e0d3e-5f60-4a1b-8c2d-3e4f5a6b7c8d'
const OTHER = '8d2f1e4f-6071-4b2c-9d3e-4f5a6b7c8d9e'
const ECLASS = '0112/2///61987#ABA951#009'

const further = (event_id, event_type, time, entity_id = METRIC) => ({
  event_id, entity_type: 'metric_semantic_ids', entity_id, event_type, timestamp: `2026-08-21T${time}:00Z`,
  description: `Action ${event_type} on metric_semantic_ids [${entity_id}]`, changed_by: 'user-1', actor_source: 'user',
  old_data: event_type === 'DELETE' ? { semantic_id: ECLASS, semantic_id_type: 'IRDI', source: null } : null,
  new_data: event_type === 'INSERT' ? { semantic_id: ECLASS, semantic_id_type: 'IRDI', source: 'ECLASS 14.0' } : null,
  audit_domain: 'asset', class: event_type === 'INSERT' ? 'created' : 'lifecycle'
})

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState({}, '', '/audit-trail')
})

const show = async (events, catalog) => {
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/audit-trail')) return Promise.resolve(events)
    if (path.startsWith('/api/v1/metric-catalog')) return catalog()
    return Promise.resolve([])
  })
  render(<AuditTrailTab userRole="Administrator" />)
  await waitFor(() => expect(document.querySelectorAll('.trail-lane-open').length).toBeGreaterThan(0))
}

describe('the lane of a metric’s further semantic ids', () => {
  it('is named by the metric, with no change of its own in the window', async () => {
    await show(
      [further(1, 'INSERT', '09:00'), further(2, 'DELETE', '10:00')],
      () => Promise.resolve([{ metric_uuid: METRIC, name: 'Machine/SERIAL_NUMBER' }])
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open the latest change to Machine/SERIAL_NUMBER' })).toBeTruthy())
    expect(screen.queryByText(shortId(METRIC))).toBeNull()
  })

  it('keeps the shortened id where the catalogue cannot be read, as before', async () => {
    await show([further(1, 'INSERT', '09:00')], () => Promise.reject(new Error('refused')))
    expect(screen.getByRole('button', { name: `Open the latest change to ${shortId(METRIC)}` })).toBeTruthy()
  })

  it('names each metric’s lane by its own metric', async () => {
    await show(
      [further(1, 'INSERT', '09:00'), further(2, 'INSERT', '10:00', OTHER)],
      () => Promise.resolve([
        { metric_uuid: METRIC, name: 'Machine/SERIAL_NUMBER' }, { metric_uuid: OTHER, name: 'Machine/MODEL' }
      ])
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open the latest change to Machine/MODEL' })).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Open the latest change to Machine/SERIAL_NUMBER' })).toBeTruthy()
  })
})

describe('the kind the Audit Trail offers for them', () => {
  it('is Metric semantic IDs, in the asset lane beside the metric catalog, and reads back as itself', () => {
    const kind = AUDIT_TRAIL_ENTITY_TYPES.find(e => e.table === 'metric_semantic_ids')
    expect(kind).toMatchObject({ kind: 'METRIC SEMANTIC ID', label: 'Metric semantic IDs', domain: 'asset', group: 'model' })
    expect(ENTITY_KIND_BY_TABLE.metric_semantic_ids).toBe('METRIC SEMANTIC ID')
  })
})
