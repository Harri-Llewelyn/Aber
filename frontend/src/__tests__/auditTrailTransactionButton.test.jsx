/**
 * The Audit Trail drawer's Same transaction section draws Show whole transaction as every drawer
 * section draws its buttons: a `.context-action` alone in a `.context-buttons` grid, so it spans the
 * drawer, as a section's only button does.
 */
import React from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AuditTrailTab } from '../components/tabs/AuditTrailTab'
import { api } from '../api'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { listUserAccounts: vi.fn(() => Promise.resolve([])), get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const APP_CSS = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8')

const DEVICES = [
  { asset_id: 'dev-1', asset_name: 'Simulated_CNC_01', last_birth_metrics: [] },
  { asset_id: 'dev-2', asset_name: 'Press_02', last_birth_metrics: [] },
]
/** One act that wrote three rows, two of them on the page: the section offers the whole of it. */
const rebind = (event_id, entity_id, name) => ({
  event_id, entity_type: 'devices', entity_id, event_type: 'UPDATE',
  timestamp: '2026-08-21T09:00:00Z', causation_id: 4471, transaction_rows: 3,
  description: `Action UPDATE on devices [${entity_id}]`,
  changed_by: 'user-1', actor_source: 'user',
  old_data: { name, schema_id: 'schema-old' },
  new_data: { name, schema_id: 'schema-new' },
})
const EVENTS = [rebind(1, 'dev-1', 'Simulated_CNC_01'), rebind(2, 'dev-2', 'Press_02')]

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation((p) => {
    if (p.startsWith('/api/v1/audit-trail')) return Promise.resolve(EVENTS)
    if (p.startsWith('/api/v1/devices')) return Promise.resolve(DEVICES)
    return Promise.resolve([])
  })
})

describe('Show whole transaction', () => {
  it('is a drawer button alone in its grid, under the hint and above the list', async () => {
    render(<AuditTrailTab />)
    await waitFor(() => expect(screen.getByText('Simulated_CNC_01')).toBeInTheDocument())
    fireEvent.click(screen.getAllByRole('button', { name: /UPDATE on Simulated_CNC_01/ })[0])
    const group = await waitFor(() => {
      const g = document.querySelector('.trail-causation')
      expect(g).toBeTruthy()
      return g
    })
    const control = within(group).getByRole('button', { name: /Show whole transaction/ })
    expect(control).toHaveClass('btn', 'btn-ghost', 'btn-sm', 'context-action')
    const grid = control.parentElement
    expect(grid).toHaveClass('context-buttons', 'trail-causation-all')
    expect([...grid.children]).toEqual([control])
    expect(group.querySelector('.trail-causation-hint').compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(grid.compareDocumentPosition(group.querySelector('.trail-causation-list')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('keeps only its spacing from the list in a rule of its own', () => {
    const start = APP_CSS.indexOf('\n.trail-causation-all {')
    expect(start).toBeGreaterThan(-1)
    const rule = APP_CSS.slice(APP_CSS.indexOf('{', start) + 1, APP_CSS.indexOf('}', start))
    expect(rule.trim()).toBe('margin-bottom: 8px;')
    expect(APP_CSS).not.toContain('would read as the section\'s heading')
  })
})
