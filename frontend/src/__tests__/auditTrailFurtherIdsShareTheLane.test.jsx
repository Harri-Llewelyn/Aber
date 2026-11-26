/**
 * Audit Trail: a metric and its further semantic ids are one lane (0299). A further id's row is filed
 * under `entity_type = 'metric_semantic_ids'` with the metric's id, so it is drawn in the metric's
 * lane, in the Metric catalog section, and says what it was in words. The kind filter still finds them.
 */
import React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AuditTrailTab, eventNews, eventWords, laneKeyOf } from '../components/tabs/AuditTrailTab'
import { api } from '../api'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { listUserAccounts: vi.fn(() => Promise.resolve([])), get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const METRIC = '7c1e0d3e-5f60-4a1b-8c2d-3e4f5a6b7c8d'
const ECLASS = '0112/2///61987#ABA951#009'
const NAME = 'Machine/SERIAL_NUMBER'

const row = (event_id, entity_type, event_type, time, data) => ({
  event_id, entity_type, entity_id: METRIC, event_type, timestamp: `2026-08-21T${time}:00Z`,
  description: `Action ${event_type} on ${entity_type} [${METRIC}]`, changed_by: 'user-1', actor_source: 'user',
  old_data: event_type === 'INSERT' ? null : data, new_data: event_type === 'DELETE' ? null : data,
  audit_domain: 'asset', class: event_type === 'INSERT' ? 'created' : event_type === 'DELETE' ? 'lifecycle' : 'configuration'
})
const OWN = row(1, 'metric_catalog', 'UPDATE', '08:00', { name: NAME, semantic_id: 'https://example.test/serial' })
const ADDED = row(2, 'metric_semantic_ids', 'INSERT', '09:00', { semantic_id: ECLASS, semantic_id_type: 'IRDI', source: 'ECLASS 14.0' })
const CHANGED = row(3, 'metric_semantic_ids', 'UPDATE', '10:00', { semantic_id: ECLASS, semantic_id_type: 'IRDI', source: 'ECLASS 15.0' })
const REMOVED = row(4, 'metric_semantic_ids', 'DELETE', '11:00', { semantic_id: ECLASS, semantic_id_type: 'IRDI', source: 'ECLASS 15.0' })

let asked = []

beforeEach(() => {
  vi.clearAllMocks()
  asked = []
  window.localStorage.clear()
  window.history.replaceState({}, '', '/audit-trail')
})

const show = async (events, search = '') => {
  window.history.replaceState({}, '', `/audit-trail${search}`)
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/audit-trail')) { asked.push(path); return Promise.resolve(events) }
    if (path.startsWith('/api/v1/metric-catalog')) return Promise.resolve([{ metric_uuid: METRIC, name: NAME }])
    return Promise.resolve([])
  })
  render(<AuditTrailTab userRole="Administrator" />)
  await waitFor(() => expect(screen.getByRole('button', { name: `Open the latest change to ${NAME}` })).toBeTruthy())
}

const lanesOf = (label) => screen.getByRole('group', { name: `${label} lanes` })
const markersOf = (lane) => [...lane.closest('.trail-lane').querySelectorAll('.trail-node')]
const drawer = () => document.querySelector('.context-panel-open')

describe('a metric and its further semantic ids', () => {
  it('are one lane, named by the metric, in the Metric catalog section', async () => {
    await show([REMOVED, CHANGED, ADDED, OWN])
    const opens = screen.getAllByRole('button', { name: `Open the latest change to ${NAME}` })
    expect(opens).toHaveLength(1)
    expect(within(lanesOf('Metric catalog')).getByRole('button', { name: `Open the latest change to ${NAME}` })).toBe(opens[0])
    expect(markersOf(opens[0])).toHaveLength(4)
    expect(screen.queryByRole('group', { name: 'Metric semantic IDs lanes' })).toBeNull()
  })

  it('say what each further id did, in words, on its marker', async () => {
    await show([REMOVED, CHANGED, ADDED, OWN])
    const labels = markersOf(screen.getByRole('button', { name: `Open the latest change to ${NAME}` }))
      .map(m => m.getAttribute('aria-label').split(' on ')[0])
    expect(labels.sort()).toEqual(['Further semantic id added', 'Further semantic id changed', 'Further semantic id removed', 'UPDATE'])
  })

  it('open in the drawer with the words, and step along the metric’s one history', async () => {
    await show([REMOVED, CHANGED, ADDED, OWN])
    fireEvent.click(screen.getByRole('button', { name: /^Further semantic id added on / }))
    await waitFor(() => expect(drawer()).not.toBeNull())
    expect(within(drawer()).getByText('Further semantic id added')).toHaveClass('badge')
    expect(drawer()).toHaveTextContent('Event 2 of 4')

    fireEvent.click(within(drawer()).getByRole('button', { name: 'Previous' }))
    await waitFor(() => expect(drawer()).toHaveTextContent('Event 1 of 4'))
    expect(within(drawer()).getByText('UPDATE')).toHaveClass('badge')
  })

  it('are found by the kind filter, and drawn in their metric’s lane', async () => {
    await show([REMOVED, ADDED], `?type=${encodeURIComponent('METRIC SEMANTIC ID')}`)
    expect(asked.some(path => path.includes('entity_type=METRIC%20SEMANTIC%20ID'))).toBe(true)
    const open = within(lanesOf('Metric catalog')).getByRole('button', { name: `Open the latest change to ${NAME}` })
    expect(markersOf(open)).toHaveLength(2)
  })
})

describe('the lane and the words', () => {
  it('key a further id’s row to its metric’s lane, and no other kind', () => {
    expect(laneKeyOf(ADDED)).toBe(laneKeyOf(OWN))
    expect(laneKeyOf({ entity_type: 'device_nameplate', entity_id: METRIC }))
      .not.toBe(laneKeyOf({ entity_type: 'devices', entity_id: METRIC }))
  })

  it('say a further id’s act, and leave every other row’s action as it was', () => {
    expect([ADDED, CHANGED, REMOVED].map(eventWords))
      .toEqual(['Further semantic id added', 'Further semantic id changed', 'Further semantic id removed'])
    expect(eventWords(OWN)).toBe('UPDATE')
    expect(eventNews(1, 4, ADDED)).toMatch(/^Event 2 of 4: Further semantic id added, /)
    expect(eventNews(0, 4, OWN)).toMatch(/^Event 1 of 4: Updated, /)
  })
})
