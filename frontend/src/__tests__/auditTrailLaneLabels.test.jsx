/**
 * Audit Trail: a lane's label. An entity with a name is labelled by its name alone, its UUID in the
 * label's tooltip and the drawer; one with no name keeps its shortened UUID. The label is a button
 * that opens the drawer on the lane's newest loaded event, named "Open the latest change to …",
 * and a name too long for the column is cut and slides on hover or focus (OverflowText).
 */
import React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AuditTrailTab, actStartedAt, shortId, startedWords } from '../components/tabs/AuditTrailTab'
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

  it('names a recording by its machine and when it began, with no short id', async () => {
    await show()
    const began = startedWords(Date.parse(at('06:00')))
    const recording = label(`Press_02 ${began}`)
    expect(recording.querySelector('.trail-lane-name')).toHaveTextContent(/^Press_02$/)
    expect(recording.querySelector('.trail-lane-qualifier')).toHaveTextContent(began)
    expect(recording).not.toHaveTextContent(shortId(RECORDING))
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

/**
 * Recordings, captures and playbacks are named by their subject, which every act on it shares, so
 * each lane also says when its act began.
 */
describe('an act\'s lane says when it began', () => {
  const started = (id, hhmmss, name = 'Press_02') => ({
    event_id: id, entity_type: 'capture_jobs', entity_id: `5d1f0c2a-7b6e-4c1d-9f00-0000000000${id}`,
    event_type: 'CAPTURE_STARTED', timestamp: `2026-08-21T${hhmmss}Z`, description: 'Recording started',
    changed_by: 'user-1', actor_source: 'user', old_data: null, new_data: { name, max_seconds: 60 },
  })
  const showActs = async (events, path = '/audit-trail') => {
    window.history.replaceState({}, '', path)
    api.get.mockImplementation((p) => Promise.resolve(p.startsWith('/api/v1/audit-trail') ? events : []))
    render(<AuditTrailTab userRole="Administrator" />)
    await waitFor(() => expect(document.querySelectorAll('.trail-lane-open').length).toBe(events.length))
    return [...document.querySelectorAll('.trail-lane-open')].map(b => b.querySelector('.trail-lane-qualifier')?.textContent)
  }

  it('tells two recordings of one machine apart by their start', async () => {
    const words = await showActs([started(41, '06:00:00'), started(42, '09:30:00')])
    expect(words).toEqual([
      startedWords(Date.parse('2026-08-21T06:00:00Z')),
      startedWords(Date.parse('2026-08-21T09:30:00Z')),
    ])
  })

  it('adds the seconds only when two of one machine began in the same minute', async () => {
    const words = await showActs([started(43, '06:00:05'), started(44, '06:00:40'), started(45, '07:00:00', 'Lathe_01')])
    expect(words).toContain(startedWords(Date.parse('2026-08-21T06:00:05Z'), { seconds: true }))
    expect(words).toContain(startedWords(Date.parse('2026-08-21T06:00:40Z'), { seconds: true }))
    expect(words).toContain(startedWords(Date.parse('2026-08-21T07:00:00Z')))
  })

  it('gives the clock alone within a window of one day', async () => {
    const words = await showActs([started(46, '06:00:00')], '/audit-trail?span=day&at=2026-08-21')
    expect(words).toEqual([startedWords(Date.parse('2026-08-21T06:00:00Z'), { withinDay: true })])
    expect(words[0]).not.toMatch(/Aug/)
  })

  it('reads a stored capture\'s recorded_at before its events', () => {
    const recorded = '2026-08-20T23:10:00Z'
    expect(actStartedAt([
      { timestamp: '2026-08-21T06:00:00Z', new_data: { name: 'Press_02', recorded_at: recorded } },
    ])).toBe(Date.parse(recorded))
    expect(actStartedAt([
      { timestamp: '2026-08-21T09:00:00Z', new_data: {} }, { timestamp: '2026-08-21T06:00:00Z', new_data: {} },
    ])).toBe(Date.parse('2026-08-21T06:00:00Z'))
  })

  it('words a start outside this year with its year', () => {
    expect(startedWords(Date.parse('2019-03-04T10:00:00Z'))).toMatch(/2019/)
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
