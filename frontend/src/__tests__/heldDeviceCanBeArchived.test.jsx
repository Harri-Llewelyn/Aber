import React from 'react'
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { EntitiesTab } from '../components/tabs/EntitiesTab'
import { api } from '../api'
import { supabase } from '../lib/supabaseClient'
import { PERMISSION_UUIDS } from '../constants'
import { HELD_AGAIN_ROW } from '../utils/quarantineHold'
import { tabLink } from '../test/tabBar'
import { tooltipOf } from '../test/tooltips'

/**
 * A registered device held again in Quarantine is archived from its row, with the dialog the details
 * panel uses, and then deleted from Entities: the database refuses its delete until it is archived
 * (0337). Archived, it leaves the queue, whose births it no longer holds, and is listed with the
 * archived devices. A device nobody registered keeps Reject and is offered no archive.
 */

vi.mock('../lib/supabaseClient', () => ({
  supabase: { from: vi.fn(), functions: { invoke: vi.fn() } }
}))

const HELD = 'cccccccc-0000-4000-8000-000000001687'

const queued = (over = {}) => ({
  asset_id: HELD, quarantine_id: HELD, asset_name: 'CNC_01', reported_identity: 'cnc-1', gateway_id: 'gw-1',
  gateway_name: 'Line_A_Gateway', quarantine_reason: 'GATEWAY_MISMATCH: published by another gateway',
  reported_metrics: [], birth_payload: '[]', is_quarantined: true, requarantined_at: null, ...over
})
const REGISTERED = { requarantined_at: '2026-11-24T09:00:00Z' }

beforeEach(() => {
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/devices')
})

async function openQueue(over, hasPermission = () => true) {
  vi.spyOn(api, 'get').mockImplementation((path) => Promise.resolve(
    path.startsWith('/api/v1/quarantine') ? [queued(over)] : []))
  const showToast = vi.fn()
  render(<DevicesTab showToast={showToast} onSelectDevice={vi.fn()} hasPermission={hasPermission} />)
  fireEvent.click(tabLink('Quarantine'))
  const approve = await screen.findByRole('button', { name: /Approve & Onboard/ })
  return { row: approve.closest('tr'), showToast }
}

describe('the Quarantine row of a registered device held again', () => {
  it('offers Archive Device beside Approve & Onboard, in place of Reject', async () => {
    const { row } = await openQueue(REGISTERED)
    const actions = within(row.querySelector('td.row-actions')).getAllByRole('button').map(b => b.textContent)
    expect(actions).toEqual(['Approve & Onboard', 'Archive Device'])
    expect(within(row).getByRole('button', { name: 'Archive Device' })).toBeEnabled()
  })

  it('archives it through the details panel\'s dialog, with its subject and its auto-purge', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({})
    const { row, showToast } = await openQueue(REGISTERED)
    fireEvent.click(within(row).getByRole('button', { name: 'Archive Device' }))
    const dialog = await screen.findByRole('dialog', { name: /Archive Device/ })
    expect(dialog).toHaveTextContent('CNC_01')
    fireEvent.change(within(dialog).getByLabelText('Auto-Purge'), { target: { value: '90' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }))
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/api/v1/devices/${HELD}/archive`, { auto_delete_days: 90 }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Archive Device/ })).toBeNull())
    expect(showToast).toHaveBeenCalledWith("Device 'CNC_01' archived", 'success', expect.objectContaining({ to: expect.stringContaining(HELD) }))
  })

  it('is disabled, naming the roles, for a role that may not archive', async () => {
    const { row } = await openQueue(REGISTERED, (id) => id !== PERMISSION_UUIDS.ARCHIVE_MANAGE)
    const archive = within(row).getByRole('button', { name: 'Archive Device' })
    expect(archive).toBeDisabled()
    expect(tooltipOf(archive)).toMatch(/Administrator|Manager/)
  })

  it('says in its row that archiving is the way to delete it', () => {
    expect(HELD_AGAIN_ROW).toMatch(/archive it, then delete it from Entities/)
  })
})

describe('the Quarantine row of a device nobody registered', () => {
  it('keeps Reject and is offered no archive', async () => {
    const { row } = await openQueue()
    expect(within(row).getByRole('button', { name: 'Reject' })).toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: 'Archive Device' })).toBeNull()
  })
})

describe('an archived device held again', () => {
  const ARCHIVED_HELD = {
    asset_id: HELD, asset_name: 'CNC_01', is_quarantined: true, is_archived: true,
    requarantined_at: '2026-11-24T09:00:00Z', archived_at: '2026-11-26T09:00:00Z', status: 'OFFLINE', schema_ids: []
  }

  it('is not read into the queue', async () => {
    const rows = [
      { id: HELD, name: 'CNC_01', is_quarantined: true, is_archived: true, requarantined_at: '2026-11-24T09:00:00Z' },
      { id: 'dddddddd-0000-4000-8000-000000001687', name: 'Unknown_Robot', is_quarantined: true, is_archived: false }
    ]
    const devices = { select: () => devices, eq: () => Promise.resolve({ data: rows, error: null }) }
    const config = { select: () => config, in: () => Promise.resolve({ data: [], error: null }) }
    supabase.from.mockImplementation((table) => (table === 'devices' ? devices : config))
    const queue = await api.get('/api/v1/quarantine')
    expect(queue.map(q => q.asset_name)).toEqual(['Unknown_Robot'])
  })

  it('opens on Registered, listed with the archived, and its panel says Restore returns it to the queue', async () => {
    window.history.replaceState(null, '', `/devices?search=${HELD}`)
    vi.spyOn(api, 'get').mockImplementation((path) => Promise.resolve(
      path.startsWith('/api/v1/devices') ? [ARCHIVED_HELD] : []))
    render(<DevicesTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={() => true} />)
    const panel = await waitFor(() => {
      const open = document.querySelector('.context-panel-open')
      expect(open).not.toBeNull()
      return open
    })
    expect(within(panel).getByRole('list', { name: 'Warnings' }))
      .toHaveTextContent('Held in quarantine when it was archived. Restore returns it to the Quarantine tab.')
    expect(within(panel).getByRole('button', { name: /Restore Device/ })).toBeInTheDocument()
    expect(tabLink('Registered')).toHaveAttribute('aria-current', 'page')
    expect(document.querySelector('tr.row-selected.row-archived')).toHaveTextContent('CNC_01')
  })

  it('is on the Entities page\'s Archived tab, and Permanent Delete deletes it', async () => {
    window.history.replaceState(null, '', '/entities/archived')
    const archived = {
      entity_id: HELD, name: 'CNC_01', entity_type: 'device', archived_at: '2026-11-26T09:00:00Z', auto_delete_at: null,
      directory: { kind: 'devices', id: HELD, name: 'CNC_01', state: 'archived', variant: 'quarantined', second_ids: [] }
    }
    vi.spyOn(api, 'get').mockImplementation((path) => Promise.resolve(
      path.startsWith('/api/v1/archives') && !path.includes('/retired') && !path.includes('/exports') ? [archived] : []))
    const remove = vi.spyOn(api, 'delete').mockResolvedValue(true)
    render(<EntitiesTab showToast={vi.fn()} hasPermission={() => true} />)
    const row = await waitFor(() => {
      const found = [...document.querySelectorAll('tbody tr:not(.table-group-row)')]
        .find(tr => tr.querySelector('strong')?.textContent === 'CNC_01')
      expect(found).toBeTruthy()
      return found
    })
    fireEvent.click(row)
    const panel = await waitFor(() => {
      const open = document.querySelector('.context-panel-open')
      expect(open).not.toBeNull()
      return open
    })
    expect(within(panel).getByRole('list', { name: 'Warnings' }))
      .toHaveTextContent('Held in quarantine when it was archived. Restore returns it to the Quarantine tab on the Devices page.')
    fireEvent.click(within(panel).getByRole('button', { name: /Permanent Delete/ }))
    fireEvent.change(await screen.findByLabelText(/Type the .* to confirm/i), { target: { value: 'CNC_01' } })
    fireEvent.click(await screen.findByRole('button', { name: /^Permanently Delete Device/ }))
    await waitFor(() => expect(remove).toHaveBeenCalledWith(`/api/v1/devices/${HELD}`))
  })
})
