/**
 * Audit Trail: a lane's label. An entity with a name is labelled by its name alone, its UUID in the
 * label's tooltip and the drawer; one with no name keeps its shortened UUID. The label is a button
 * that opens the drawer on the lane's newest loaded event, named "Open the latest change to …",
 * and a name too long for the column is cut and slides on hover or focus (OverflowText).
 */
import React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AuditTrailTab, shortId } from '../components/tabs/AuditTrailTab'
import { api } from '../api'
import { tooltipOf } from '../test/tooltips'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { listUserAccounts: vi.fn(() => Promise.resolve([])), get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const LINE = '1b7c0d3e-5f60-4a1b-8c2d-3e4f5a6b7c8d'
const STRANGER = 'dddddddd-4444-4000-8000-000000000004'
const RECORDING = '5d1f0c2a-7b6e-4c1d-9f00-0000000000a1'
const LONG = 'Assembly_Line_1_Station_4_Torque_Controller_Left_Hand'

const at = (hhmm) => `2026-08-21T${hhmm}:00Z`
const row = (event_id, entity_type, entity_id, time, extra = {}) => ({
  event_id, entity_type, entity_id, event_type: 'UPDATE', timestamp: at(time),
  description: `Action UPDATE on ${entity_type} [${entity_id}]`, changed_by: 'user-1', actor_source: 'user',
  old_data: { status: 'OFFLINE' }, new_data: { status: 'ONLINE' }, ...extra,
})

const CELLS = [{ cell_id: LINE, cell_name: 'Line 1' }]
const DEVICES = [{ asset_id: 'dev-9', asset_name: LONG, last_birth_metrics: [] }]
const TX = { causation_id: 77, transaction_rows: 3 }
const EVENTS = [
  // Line 1: three changes, the newest last in time.
  row(1, 'cells', LINE, '09:00'), row(2, 'cells', LINE, '11:00'), row(3, 'cells', LINE, '10:00'),
  // One transaction of three rows at one time: the newest is the last written.
  row(12, 'devices', 'dev-9', '08:00', TX), row(10, 'devices', 'dev-9', '08:00', TX), row(11, 'devices', 'dev-9', '08:00', TX),
  // A machine identity nothing names, with no payload to name it from.
  row(20, 'service_principals', STRANGER, '07:00', { old_data: null, new_data: null }),
  // A recording, named by the machine it recorded.
  row(30, 'capture_jobs', RECORDING, '06:00', {
    event_type: 'CAPTURE_STARTED', old_data: null, new_data: { name: 'Press_02', max_seconds: 60 },
  }),
]

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState({}, '', '/audit-trail')
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/audit-trail')) return Promise.resolve(EVENTS)
    if (path.startsWith('/api/v1/cells')) return Promise.resolve(CELLS)
    if (path.startsWith('/api/v1/devices')) return Promise.resolve(DEVICES)
    return Promise.resolve([])
  })
})

const show = async () => {
  render(<AuditTrailTab userRole="Administrator" />)
  await waitFor(() => expect(screen.getByText('Line 1')).toBeInTheDocument())
}
const label = (name) => screen.getByRole('button', { name: `Open the latest change to ${name}` })
const openEvent = () => new URLSearchParams(window.location.search).get('event')

describe('a lane label', () => {
  it('is the entity\'s name alone, with its UUID in the tooltip', async () => {
    await show()
    const line = label('Line 1')
    expect(line).toHaveTextContent(/^Line 1$/)
    expect(screen.queryByText(shortId(LINE))).toBeNull()
    expect(tooltipOf(line)).toBe(`Line 1 — ${LINE}`)
  })

  it('names a recording by its machine, with no short id beside the name', async () => {
    await show()
    const recording = label('Press_02')
    expect(recording).toHaveTextContent(/^Press_02$/)
    expect(recording.querySelector('.trail-lane-qualifier')).toBeNull()
    expect(tooltipOf(recording)).toContain(RECORDING)
  })

  it('keeps the shortened UUID for an entity with no name', async () => {
    await show()
    const stranger = label(shortId(STRANGER))
    expect(stranger.querySelector('.trail-lane-unnamed')).toHaveTextContent(shortId(STRANGER))
    expect(tooltipOf(stranger)).toBe(STRANGER)
  })

  it('cuts a long name in a part that slides on hover or focus', async () => {
    await show()
    const name = label(LONG).querySelector('.trail-lane-name')
    expect(name).toHaveClass('overflow-text')
    expect(name).toHaveTextContent(LONG)
  })
})

describe('a lane label is a button', () => {
  it('opens the drawer on the lane\'s newest loaded event', async () => {
    await show()
    fireEvent.click(label('Line 1'))
    await waitFor(() => expect(document.querySelector('.context-panel-open')).toBeTruthy())
    // 11:00 is the newest, though it was not the last row served.
    expect(openEvent()).toBe('2')
    expect(document.querySelector('.trail-drawer-nav-pos')).toHaveTextContent(/^Event 3 of 3/)
  })

  it('takes the last row written when the newest are one transaction', async () => {
    await show()
    fireEvent.click(label(LONG))
    await waitFor(() => expect(openEvent()).toBe('12'))
  })

  it('is a real button, so Tab, Enter and Space reach it and a screen reader says what it does', async () => {
    await show()
    const line = label('Line 1')
    expect(line.tagName).toBe('BUTTON')
    expect(line).toHaveAttribute('type', 'button')
    expect(line).not.toHaveAttribute('tabindex', '-1')
    line.focus()
    expect(line).toHaveFocus()
  })

  it('says a deleted entity is deleted in its name', async () => {
    api.get.mockImplementation((path) => {
      if (path.startsWith('/api/v1/audit-trail')) {
        return Promise.resolve([row(5, 'cells', 'cell-gone', '09:00', {
          event_type: 'DELETE', old_data: { name: 'Old Line' }, new_data: null,
        })])
      }
      return Promise.resolve([])
    })
    window.history.replaceState({}, '', '/audit-trail?deleted=1')
    render(<AuditTrailTab />)
    expect(await screen.findByRole('button', { name: 'Open the latest change to Old Line, deleted' })).toBeInTheDocument()
  })
})
