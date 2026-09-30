/**
 * Audit Trail: ← and → step the drawer through the selected asset's history, the same pair of
 * moves as the ◀ Previous and Next ▶ buttons. The binding lives in the tab and is active only while
 * an event is selected; it stands down for editable targets and modified keystrokes, because the
 * filter bar's selects and date inputs consume arrow keys natively.
 */
import React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AuditTrailTab } from '../components/tabs/AuditTrailTab'
import { api } from '../api'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { listUserAccounts: vi.fn(() => Promise.resolve([])), get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const CELLS = [{ cell_id: 'cell-1', cell_name: 'Assembly Line 1' }]
const GATEWAYS = [{ gateway_id: 'gw-1', gateway_name: 'Host_Gateway_NodeRED', devices: [] }]
const DEVICES = [
  { asset_id: 'dev-1', asset_name: 'Simulated_CNC_01', last_birth_metrics: [] },
  { asset_id: 'dev-2', asset_name: 'Press_02', last_birth_metrics: [] }
]

/** Three changes to one device an hour apart, and one to another so the lane is not the page. */
const change = (event_id, entity_id, timestamp, status) => ({
  event_id, entity_type: 'devices', entity_id, event_type: 'UPDATE', timestamp,
  description: `Action UPDATE on devices [${entity_id}]`, changed_by: 'ingestion-principal-1', actor_source: 'ingestion',
  old_data: { status: 'OFFLINE' }, new_data: { status }
})
const EVENTS = [
  change(1, 'dev-1', '2026-08-21T09:00:00Z', 'ONLINE'),
  change(2, 'dev-1', '2026-08-21T10:00:00Z', 'STALE'),
  change(3, 'dev-1', '2026-08-21T11:00:00Z', 'ONLINE'),
  change(4, 'dev-2', '2026-08-21T10:30:00Z', 'ONLINE')
]

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/audit-trail')) return Promise.resolve(EVENTS)
    if (path.startsWith('/api/v1/devices'))  return Promise.resolve(DEVICES)
    if (path.startsWith('/api/v1/gateways')) return Promise.resolve(GATEWAYS)
    if (path.startsWith('/api/v1/cells'))    return Promise.resolve(CELLS)
    return Promise.resolve([])
  })
})

const show = async () => {
  render(<AuditTrailTab />)
  await waitFor(() => expect(screen.getByText('Simulated_CNC_01')).toBeInTheDocument())
}

/** Opens the drawer on the OLDEST change to dev-1, so there is somewhere to step forward to. */
const selectOldest = async () => {
  fireEvent.click(screen.getAllByRole('button', { name: /UPDATE on Simulated_CNC_01/ })[0])
  await waitFor(() => expect(document.querySelector('.context-panel-open')).toBeTruthy())
  await waitFor(() => expect(position()).toMatch(/^Event 1 of 3/))
}

const position = () => document.querySelector('.dt-drawer-nav-pos')?.textContent ?? ''
const press = (key, target = document, init = {}) => fireEvent.keyDown(target, { key, ...init })


describe('the arrow keys step the drawer', () => {
  it('→ steps to the next change and ← back to the previous one', async () => {
    await show()
    await selectOldest()

    press('ArrowRight')
    await waitFor(() => expect(position()).toMatch(/^Event 2 of 3/))
    press('ArrowRight')
    await waitFor(() => expect(position()).toMatch(/^Event 3 of 3/))

    press('ArrowLeft')
    await waitFor(() => expect(position()).toMatch(/^Event 2 of 3/))
  })

  it('does not wrap at either end', async () => {
    /* The buttons are disabled there; a key that wrapped would make the two controls disagree
       about where the history ends. */
    await show()
    await selectOldest()

    press('ArrowLeft')
    await new Promise(r => setTimeout(r, 20))
    expect(position()).toMatch(/^Event 1 of 3/)

    press('ArrowRight'); press('ArrowRight'); press('ArrowRight')
    await waitFor(() => expect(position()).toMatch(/^Event 3 of 3/))
    press('ArrowRight')
    await new Promise(r => setTimeout(r, 20))
    expect(position()).toMatch(/^Event 3 of 3/)
  })

  it('stands down inside an input, where the key moves the caret', async () => {
    await show()
    await selectOldest()

    const search = screen.getByPlaceholderText(/Search by name, entity, mutation or transaction ID/)
    search.focus()
    press('ArrowRight', search)
    await new Promise(r => setTimeout(r, 20))
    expect(position()).toMatch(/^Event 1 of 3/)
  })

  it('stands down inside a select, where the key changes the value', async () => {
    /* A focused select would otherwise both change its value and step the drawer on one press. */
    await show()
    await selectOldest()

    const kind = screen.getByTitle(/Show only events against one kind of asset/)
    kind.focus()
    press('ArrowRight', kind)
    await new Promise(r => setTimeout(r, 20))
    expect(position()).toMatch(/^Event 1 of 3/)
  })

  it('stands down for a modified keystroke', async () => {
    await show()
    await selectOldest()

    press('ArrowRight', document, { ctrlKey: true })
    press('ArrowRight', document, { altKey: true })
    press('ArrowRight', document, { metaKey: true })
    await new Promise(r => setTimeout(r, 20))
    expect(position()).toMatch(/^Event 1 of 3/)
  })

  it('does nothing while no event is selected', async () => {
    await show()

    press('ArrowRight')
    await new Promise(r => setTimeout(r, 20))
    expect(document.querySelector('.context-panel-open')).toBeNull()
  })

  it('names the key on each button, so a mouse user learns it without opening the list', async () => {
    await show()
    await selectOldest()
    press('ArrowRight')
    await waitFor(() => expect(position()).toMatch(/^Event 2 of 3/))

    const nav = document.querySelector('.dt-drawer-nav-btns')
    expect(nav.querySelector('button[title$="(←)"]')).toHaveTextContent('Previous')
    expect(nav.querySelector('button[title$="(→)"]')).toHaveTextContent('Next')
  })
})
