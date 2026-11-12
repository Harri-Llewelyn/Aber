/**
 * Audit Trail: TELEMETRY_EXPORTED, in the Readings lane. An export of readings (0279) records who
 * exported which devices and metrics, over which window, at which resolution, and how many rows
 * left. There is no prior state, so the drawer shows it one-sided, as a read; its devices are named
 * and its window's two ends, stored in UTC, are one row in local time. A Shopfloor Manager reads the
 * lane, which is in the asset domain. This suite runs in London's zone, where 2026's clocks went
 * back on 25 October, and puts the machine's back afterwards.
 */
import React from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuditTrailTab } from '../components/tabs/AuditTrailTab'
import { api } from '../api'
import { AUDIT_TRAIL_ACTIONS, AUDIT_TRAIL_ENTITY_TYPES, auditTrailEntityTypesFor } from '../constants'

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

const MANAGER = '5e55a0e0-0000-4000-8000-0000000279a2'

/** An export of two devices' readings, with `extra` on its snapshot. */
const exportOf = (extra = {}) => [{
  event_id: 41, entity_type: 'telemetry', entity_id: '6f0f4d6a-0000-4000-8000-000000000279',
  event_type: 'TELEMETRY_EXPORTED', timestamp: '2026-11-04T10:00:00Z', causation_id: 279,
  description: 'Action TELEMETRY_EXPORTED on telemetry', changed_by: MANAGER, actor_source: 'user',
  audit_domain: 'asset', old_data: null,
  new_data: {
    name: 'Readings',
    devices: [{ id: 'deva0d172790000400080000', name: 'Lathe 3' }, { id: 'dev07bb1d1982994a5ca83df', name: 'Press 1' }],
    metrics: ['Spindle/LOAD', 'Spindle/SPEED'],
    from: '2026-11-03T09:00:00.000Z', to: '2026-11-04T09:00:00.000Z', resolution: 'raw',
    rows: 12034, truncated: false, read_to: '2026-11-04T09:00:00.000Z', ...extra,
  },
}]

let served
beforeEach(() => {
  vi.clearAllMocks()
  // The year is 2026, so the window's ends name no year.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 5, 12, 0))
  served = exportOf()
  api.get.mockImplementation((path) => Promise.resolve(path.startsWith('/api/v1/audit-trail') ? served : []))
  api.listUserAccounts.mockResolvedValue([])
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  window.history.replaceState({}, '', '/')
})

/** The drawer's diff for the export, once it is open. */
const openDrawer = async () => {
  window.history.replaceState({}, '', '/audit-trail?event=41')
  render(<AuditTrailTab userRole="Shopfloor_Manager" />)
  await waitFor(() => expect(document.querySelector('.context-panel-open .trail-diff')).toBeTruthy())
  return document.querySelector('.trail-diff')
}
/** The table's rows as [property, value]. */
const rowsOf = (diff) => [...diff.querySelectorAll('tbody tr')]
  .map(tr => [tr.querySelector('th').textContent, tr.querySelector('td').textContent])

describe('the Readings lane and its action', () => {
  it('is a kind and an action the filter offers, read in the asset domain', () => {
    expect(AUDIT_TRAIL_ENTITY_TYPES.find(e => e.table === 'telemetry')).toMatchObject({ kind: 'READINGS', label: 'Readings', domain: 'asset' })
    expect(AUDIT_TRAIL_ACTIONS.TELEMETRY_EXPORTED).toBe('Readings exported')
    // A Shopfloor Manager is offered it: the asset domain is theirs to read.
    expect(auditTrailEntityTypesFor('Shopfloor_Manager').some(e => e.table === 'telemetry')).toBe(true)
  })
})

describe('TELEMETRY_EXPORTED in the drawer', () => {
  it('reads as what was exported, one-sided, with no Previous column', async () => {
    const diff = await openDrawer()
    expect(within(diff).getByText('Readings exported')).toBeInTheDocument()
    expect(diff.querySelector('.trail-diff-table').className).toContain('trail-diff-onesided')
    expect([...diff.querySelectorAll('thead th')].map(th => th.textContent)).toEqual(['Property', 'Exported'])
  })

  it('names the devices, lists the metrics and shows the window as one row in local time', async () => {
    const diff = await openDrawer()
    const rows = Object.fromEntries(rowsOf(diff))
    expect(rows.devices).toBe('Lathe 3, Press 1')
    expect(rows.metrics).toBe('Spindle/LOAD, Spindle/SPEED')
    expect(rows.window).toBe('3 Nov 09:00 – 4 Nov 09:00')
    expect(rows.resolution).toBe('raw')
    expect(rows.rows).toBe('12034')
    expect(rows.truncated).toBe('false')
    expect(rowsOf(diff).map(([field]) => field)).not.toContain('from')
  })

  it('keeps the stored devices and UTC ends in the payload below the table', async () => {
    await openDrawer()
    const payload = document.querySelector('.trail-raw').textContent
    expect(payload).toContain('"from": "2026-11-03T09:00:00.000Z"')
    expect(payload).toContain('"id": "deva0d172790000400080000"')
  })

  it('names a device the platform did not know by its id', async () => {
    served = exportOf({ devices: [{ id: 'devunknown0279', name: null }] })
    const diff = await openDrawer()
    expect(Object.fromEntries(rowsOf(diff)).devices).toBe('devunknown0279')
  })

  it('is filed under Readings, with the lane named as the export wrote it', async () => {
    await openDrawer()
    expect(screen.getAllByText('Readings').length).toBeGreaterThan(0)
  })
})
