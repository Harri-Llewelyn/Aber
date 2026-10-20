/**
 * Audit Trail: the capture lane (0193). Recordings, captures and playbacks are kinds the timeline
 * draws and the filters offer a Shopfloor_Manager, each act gets a marker class, a lane is named
 * by the machine it recorded with its own short id beside the name, and the drawer words each act.
 */
import React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AuditTrailTab, classifyEvent, diffFields, shortId } from '../components/tabs/AuditTrailTab'
import { AUDIT_TRAIL_ACTIONS } from '../constants'
import { api } from '../api'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { listUserAccounts: vi.fn(() => Promise.resolve([])), get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const JOB = '5d1f0c2a-7b6e-4c1d-9f00-0000000000a1'
const CAPTURE = '7e2a9b14-1c3d-4e5f-8a00-0000000000b2'
const OLDER = '91c3d0e2-4b5a-4c6d-8e00-0000000000c3'
const PLAYBACK = 'a4b5c6d7-e8f9-4a0b-9c00-0000000000d4'
const PRESS = { name: 'Press_02', sparkplug_id: 'dev270000000000400080000', subject_kind: 'device' }

const event = (id, entity_type, entity_id, event_type, new_data, timestamp) => ({
  event_id: id, entity_type, entity_id, event_type, timestamp, causation_id: 100 + id,
  description: `Action ${event_type} on ${entity_type} [${entity_id}]`,
  changed_by: 'user-uuid-1', actor_source: 'user', audit_domain: 'asset',
  old_data: null, new_data
})

const EVENTS = [
  event(1, 'capture_jobs', JOB, 'CAPTURE_STARTED',
        { ...PRESS, note: 'before the retrofit', max_seconds: 60, replaces_capture_id: null },
        '2026-10-19T09:00:00Z'),
  event(2, 'captures', CAPTURE, 'CAPTURE_DOWNLOAD_ISSUED',
        { ...PRESS, storage_path: `${PRESS.sparkplug_id}/${JOB}.json`, size_bytes: 9000, message_count: 40 },
        '2026-10-19T10:00:00Z'),
  event(3, 'captures', OLDER, 'CAPTURE_DELETED',
        { ...PRESS, reason: 'replaced by a recording', capture_job_id: JOB },
        '2026-10-19T09:05:00Z'),
  event(4, 'playback_jobs', PLAYBACK, 'PLAYBACK_STARTED',
        { ...PRESS, capture_id: CAPTURE, target_sparkplug_id: 'gwy160000000000400080000', speed: 1 },
        '2026-10-19T11:00:00Z'),
]

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/audit-trail')) return Promise.resolve(EVENTS)
    return Promise.resolve([])
  })
})

const show = async (userRole = 'Shopfloor_Manager') => {
  render(<AuditTrailTab userRole={userRole} />)
  await waitFor(() => expect(screen.getAllByText('Press_02').length).toBeGreaterThan(0))
}

describe('the capture lane', () => {
  it('gives each act a marker class', () => {
    const classOf = (action) => {
      const e = { event_type: action, entity_type: 'captures', new_data: PRESS, old_data: null }
      return classifyEvent(e, diffFields(null, PRESS))
    }
    expect(['CAPTURE_STARTED', 'CAPTURE_RECORDED', 'CAPTURE_UPLOADED', 'PLAYBACK_STARTED'].map(classOf))
      .toEqual(['creation', 'creation', 'creation', 'creation'])
    expect(['CAPTURE_STOPPED', 'CAPTURE_DOWNLOAD_ISSUED', 'PLAYBACK_STOPPED'].map(classOf))
      .toEqual(['operational', 'operational', 'operational'])
    expect(classOf('CAPTURE_DELETED')).toBe('critical')
  })

  it('offers every act in the action filter with a label', () => {
    for (const action of ['CAPTURE_STARTED', 'CAPTURE_STOPPED', 'CAPTURE_RECORDED', 'CAPTURE_UPLOADED',
      'CAPTURE_DOWNLOAD_ISSUED', 'CAPTURE_DELETED', 'PLAYBACK_STARTED', 'PLAYBACK_STOPPED']) {
      expect(AUDIT_TRAIL_ACTIONS[action]).toBeTruthy()
    }
  })

  it('draws a section for recordings, captures and playbacks', async () => {
    await show()
    for (const label of ['Recordings', 'Captures', 'Playbacks']) {
      expect(screen.getByRole('separator', { name: `${label} lanes` })).toBeInTheDocument()
    }
  })

  it('names each lane by its machine, with its own short id beside the name', async () => {
    await show()
    // Two captures of one press are two lanes; the id is what tells them apart.
    for (const id of [JOB, CAPTURE, OLDER, PLAYBACK]) {
      expect(screen.getByText(shortId(id))).toBeInTheDocument()
    }
  })

  it('offers the three kinds to a Shopfloor_Manager, who reads the asset lane', async () => {
    await show('Shopfloor_Manager')
    fireEvent.click(screen.getByRole('button', { name: /^Filters/ }))
    const kinds = [...screen.getByTitle('Show only events against one kind of entity').querySelectorAll('option')]
      .map(o => o.textContent)
    expect(kinds).toEqual(expect.arrayContaining(['Recordings', 'Captures', 'Playbacks']))
  })

  it('words a download in the drawer as the act it records', async () => {
    await show()
    fireEvent.click(screen.getAllByRole('button', { name: /^CAPTURE_DOWNLOAD_ISSUED on Press_02/ })[0])
    await waitFor(() => expect(document.querySelector('.context-panel-open')).toBeTruthy())
    expect(screen.getByText('Download link issued')).toBeInTheDocument()
    const headers = [...document.querySelectorAll('.trail-diff-table thead th')].map(h => h.textContent)
    expect(headers).toEqual(['Property', 'Issued'])
  })

  it('says why a capture was deleted', async () => {
    await show()
    fireEvent.click(screen.getAllByRole('button', { name: /^CAPTURE_DELETED on Press_02/ })[0])
    await waitFor(() => expect(document.querySelector('.context-panel-open')).toBeTruthy())
    expect(screen.getByText('replaced by a recording')).toBeInTheDocument()
  })
})
