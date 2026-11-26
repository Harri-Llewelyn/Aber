import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EntitiesTab } from '../components/tabs/EntitiesTab'
import { PERMISSION_UUIDS } from '../constants'
import { DEFAULT_ROLE_PERMISSIONS_MAP, requiresRolesTitle } from '../hooks/usePermissions'
import { entityUrl } from '../routes'
import { archivedRow, entityWarnings, purgeWarning, retiredRow } from '../utils/entities'
import { formatDateTime } from '../utils/format'
import { api } from '../api'
import { tooltipOf } from '../test/tooltips'

/**
 * The drawer an archived or a retired row of the Entities page opens: the ids and the place Active's has,
 * the state in a word, when it went and when it goes, and the acts and links of its state. What Restore,
 * Export Bundle and Permanent Delete ask is EntitiesTab.test.jsx's.
 */

const { from, rpc } = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }))
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    realGet: actual.api.get,
    api: {
      get: vi.fn(), post: vi.fn(), delete: vi.fn(), findEntities: vi.fn(), listPeople: vi.fn(), listUserAccounts: vi.fn(),
      automationsForEntity: vi.fn(), displayNamesFor: vi.fn(), assetExportDownloadUrl: vi.fn(),
    },
  }
})
vi.mock('../lib/supabaseClient', () => ({
  SUPABASE_URL: 'http://stack.test', SUPABASE_GATEWAY_KEY: 'not-a-real-key',
  supabase: { from, rpc, functions: { invoke: vi.fn() }, auth: { getSession: vi.fn() } },
}))

const uuid = (n) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const directoryRow = (kind, n, name, extra = {}) => ({
  kind, id: uuid(n), name, description: null, state: 'active', variant: null, second_ids: [],
  area_id: null, cell_id: null, gateway_id: null, device_id: null, page_id: uuid(n), ...extra,
})
const AREA = directoryRow('areas', 1, 'Machine Shop')
const inDays = (d) => new Date(Date.now() + d * 24 * 60 * 60 * 1000).toISOString()

const archived = (type, n, name, extra = {}, about = {}) => ({
  entity_id: uuid(n), name, entity_type: type, archived_at: '2026-10-01T10:00:00Z', auto_delete_at: null,
  directory: directoryRow(`${type}s`, n, name, { state: 'archived', ...about }), ...extra,
})
const OLD_GATEWAY = archived('gateway', 31, 'Old edge')
const OLD_DEVICE = archived('device', 30, 'Old lathe', {}, {
  description: 'Out for a rebuild', second_ids: ['deva00000000000400080000', 'plc-10'], area_id: AREA.id, gateway_id: OLD_GATEWAY.entity_id,
})
const OLD_CELL = archived('cell', 32, 'Old bay')
const OLD_AREA = archived('area', 33, 'Old hall')
const BUNDLE = {
  id: 'exp-1', entity_type: 'devices', entity_id: uuid(40), object_bucket: 'asset-exports', object_key: 'assets/x.aasx',
  taken_at: '2026-09-01T10:00:00Z', taken_by_email: 'ops@example.test',
}
const GONE_DEVICE = {
  entity_type: 'device', entity_id: uuid(40), name: 'Scrapped lathe', sparkplug_id: 'devc00000000000400080000',
  archived_at: '2026-09-01T10:00:00Z', retired_at: '2026-10-02T10:00:00Z', retired_by: null, retired_by_email: null,
  old_data: { description: 'It was worn out', reported_identity: 'plc-old' }, exports: [BUNDLE],
}
const GONE_GATEWAY = {
  entity_type: 'gateway', entity_id: uuid(41), name: 'Scrapped edge', sparkplug_id: 'gwyd00000000000400080000',
  archived_at: '2026-09-01T10:00:00Z', retired_at: '2026-10-03T10:00:00Z', retired_by: 'user-1', retired_by_email: 'admin@example.test',
  old_data: { forge_repository_at: '2026-08-01T00:00:00Z' }, exports: [],
}

const holds = (role) => (permission) => (DEFAULT_ROLE_PERMISSIONS_MAP[role] || []).includes(permission)
const address = () => window.location.pathname + window.location.search
const panel = () => document.querySelector('.context-panel')
const drawer = () => within(panel())
const isShut = () => expect(panel()).not.toHaveClass('context-panel-open')
const fields = () => Object.fromEntries([...panel().querySelectorAll('.context-panel-fields .context-field')]
  .map(f => [f.querySelector('dt').textContent.trim(), f.querySelector('dd').textContent.trim()]))
const labels = () => [...panel().querySelectorAll('.context-panel-fields dt')].map(dt => dt.textContent.trim())
const acts = () => [...panel().querySelectorAll('.context-panel-actions .context-action')]
const said = () => acts().map(a => a.textContent.trim())
const rowOf = (name) => [...document.querySelectorAll('tbody tr.row-selectable')].find(tr => tr.querySelector('strong').textContent === name)

const show = async (url, { role = 'Shopfloor_Manager', archives = [], retired = [], exports = [], entities = [AREA], showToast = vi.fn() } = {}) => {
  window.history.replaceState(null, '', url)
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/entities')) return Promise.resolve(entities)
    if (path.startsWith('/api/v1/archives/retired')) return Promise.resolve(retired)
    if (path.startsWith('/api/v1/archives/exports')) return Promise.resolve(exports)
    if (path.startsWith('/api/v1/archives')) return Promise.resolve(archives)
    return Promise.resolve([])
  })
  render(<main><EntitiesTab showToast={showToast} userRole={role} hasPermission={holds(role)} /></main>)
  const button = await screen.findByRole('button', { name: /^(Expand|Collapse) all$/ })
  if (button.textContent === 'Expand all') fireEvent.click(button)
  return { showToast }
}
const open = async (name) => {
  await waitFor(() => expect(rowOf(name)).toBeTruthy())
  fireEvent.click(rowOf(name))
  await waitFor(() => expect(panel()).toHaveClass('context-panel-open'))
}
const showOpen = async (url, name, options) => {
  const shown = await show(url, options)
  await open(name)
  return shown
}

beforeEach(() => {
  vi.clearAllMocks()
  api.findEntities.mockResolvedValue([])
  api.listPeople.mockResolvedValue([])
  api.listUserAccounts.mockResolvedValue([])
  api.automationsForEntity.mockResolvedValue([])
  api.displayNamesFor.mockResolvedValue(new Map())
})

describe('an archived row', () => {
  it('opens its drawer on a press and by the keyboard, and the address names it', async () => {
    await show('/entities/archived', { archives: [OLD_CELL, OLD_DEVICE] })
    const tr = rowOf('Old bay')
    expect(tr).toHaveClass('row-selectable')
    expect(tr).toHaveAttribute('tabindex', '0')
    fireEvent.keyDown(tr, { key: 'Enter' })
    await waitFor(() => expect(panel()).toHaveClass('context-panel-open'))
    expect(rowOf('Old bay')).toHaveClass('row-selected')
    expect(address()).toBe(`/entities/archived?entity=${OLD_CELL.entity_id}`)
    // A press on it again closes the drawer; one on its copy chip does not.
    fireEvent.click(within(rowOf('Old bay')).getByRole('button', { name: `Copy uuid ${OLD_CELL.entity_id}` }))
    expect(panel()).toHaveClass('context-panel-open')
    fireEvent.click(rowOf('Old bay'))
    await waitFor(isShut)
  })

  it('is opened from the address, its group with it', async () => {
    await show(`/entities/archived?entity=${OLD_DEVICE.entity_id}`, { archives: [OLD_CELL, OLD_DEVICE] })
    await waitFor(() => expect(panel()).toHaveClass('context-panel-open'))
    expect(panel()).toHaveAttribute('aria-label', 'Old lathe device details')
  })

  it('leaves an address that names no archived row', async () => {
    await show(`/entities/archived?entity=${AREA.id}`, { archives: [OLD_CELL] })
    await waitFor(() => expect(address()).toBe('/entities/archived'))
    isShut()
  })

  it('shows the order Active\'s drawer does, and then when it was archived and its auto-purge', async () => {
    await showOpen('/entities/archived', 'Old lathe', { archives: [OLD_GATEWAY, OLD_DEVICE] })
    expect(labels()).toEqual(['Device UUID', 'Description', 'Kind', 'Name', 'Sparkplug Device ID', 'Published ID', 'Serving Gateway', 'Area', 'Archived At', 'Auto-Purge'])
    expect(fields()).toMatchObject({
      'Device UUID': OLD_DEVICE.entity_id, Description: 'Out for a rebuild', 'Published ID': 'plc-10',
      // An archived gateway is named too, as the page holds its row.
      'Serving Gateway': 'Old edge', Area: 'Machine Shop', 'Archived At': formatDateTime(OLD_DEVICE.archived_at), 'Auto-Purge': 'Never auto-purged',
    })
  })

  it('has its row\'s own name and id where the directory could not be read', async () => {
    await showOpen('/entities/archived', 'Old bay', { archives: [{ ...OLD_CELL, directory: null }] })
    expect(labels()).toEqual(['Cell UUID', 'Description', 'Kind', 'Name', 'Archived At', 'Auto-Purge'])
    expect(said()[1]).toBe('View in Cells')
  })

  it('says its state in a word beside its kind, with an icon', async () => {
    await showOpen('/entities/archived', 'Old bay', { archives: [OLD_CELL] })
    const badges = [...panel().querySelectorAll('.context-panel-subtitle .badge')]
    expect(badges.map(b => b.textContent)).toEqual(['Cell', 'ARCHIVED'])
    expect(badges[1].querySelector('svg')).not.toBeNull()
  })
})

describe('an archived entity\'s auto-purge', () => {
  const warnings = () => [...panel().querySelectorAll('.context-warning')].map(li => li.textContent)

  it('is a plain row while it is more than a week away', async () => {
    await showOpen('/entities/archived', 'Old bay', { archives: [{ ...OLD_CELL, auto_delete_at: inDays(30) }] })
    expect(warnings()).toEqual([])
    expect(labels()).toContain('Auto-Purge')
  })

  it('is a warning, and no row, within a week of it', async () => {
    await showOpen('/entities/archived', 'Old bay', { archives: [{ ...OLD_CELL, auto_delete_at: inDays(3) }] })
    expect(warnings()).toEqual([expect.stringMatching(/^Problem: The auto-purge is due .+ It deletes the record for good, unless it is restored first\.$/)])
    expect(labels()).not.toContain('Auto-Purge')
  })

  it('is a warning where a playback holds the gateway, whenever it is due', async () => {
    await showOpen('/entities/archived', 'Old edge', { archives: [{ ...OLD_GATEWAY, auto_delete_at: inDays(90), playbacks: 3 }] })
    expect(warnings()).toEqual([expect.stringMatching(/^Warning: Held: 3 playbacks name this gateway, and each is kept on record\. .+ Restore it, or leave it archived\.$/)])
    expect(labels()).not.toContain('Auto-Purge')
  })

  it('says one playback in the singular, and an overdue purge as one', () => {
    const now = new Date('2026-11-25T12:00:00Z').getTime()
    const row = { state: 'archived', auto_delete_at: '2026-11-20T12:00:00Z' }
    expect(purgeWarning({ ...row, playbacks: 1 }, now).text).toMatch(/^Held: 1 playback names this gateway/)
    expect(purgeWarning(row, now).text).toMatch(/^The auto-purge was due 20 Nov 2026\./)
    expect(purgeWarning({ ...row, auto_delete_at: null }, now)).toBeNull()
    expect(purgeWarning({ ...row, state: 'active' }, now)).toBeNull()
  })

  it('comes before what else is wrong with it', () => {
    const row = { state: 'archived', auto_delete_at: inDays(1), variant: 'quarantined' }
    expect(entityWarnings(row).map(w => w.id)).toEqual(['purge-soon', 'quarantined'])
    expect(entityWarnings({ state: 'active', variant: null })).toEqual([])
  })
})

describe('an archived entity\'s actions', () => {
  it.each([
    ['Old hall', OLD_AREA, ['Restore', 'View in Areas', 'View in Audit Trail', 'Permanent Delete'], `/areas?search=${OLD_AREA.entity_id}&lifecycle=archived`],
    ['Old bay', OLD_CELL, ['Restore', 'View in Cells', 'View in Audit Trail', 'Permanent Delete'], `/cells?search=${OLD_CELL.entity_id}&lifecycle=archived`],
    ['Old edge', OLD_GATEWAY, ['Restore', 'View in Gateways', 'View in Audit Trail', 'Permanent Delete'], `/gateways?search=${OLD_GATEWAY.entity_id}&lifecycle=archived`],
    ['Old lathe', OLD_DEVICE, ['Restore', 'View in Devices', 'View in Audit Trail', 'Export Bundle…', 'Permanent Delete'], `/devices?search=${OLD_DEVICE.entity_id}&lifecycle=archived`],
  ])('of %s are Restore first, its page with the lifecycle filter set, its Audit Trail, and Permanent Delete last', async (name, entity, expected, href) => {
    await showOpen('/entities/archived', name, { archives: [entity] })
    expect(said()).toEqual(expected)
    expect(acts()[0]).toHaveClass('btn-primary')
    expect(panel().querySelectorAll('.btn-primary')).toHaveLength(1)
    expect(acts()[1]).toHaveAttribute('href', href)
    expect(drawer().getByRole('link', { name: 'View in Audit Trail' })).toHaveAttribute('href', expect.stringContaining(`/audit-trail?search=${entity.entity_id}`))
    expect(acts().at(-1)).toHaveClass('context-action-danger')
  })

  it('read no automations, which apply to what is in service', async () => {
    await showOpen('/entities/archived', 'Old lathe', { archives: [OLD_DEVICE] })
    expect(api.automationsForEntity).not.toHaveBeenCalled()
  })

  it('are greyed with who may use them for an Operator, who is offered no Audit Trail', async () => {
    await showOpen('/entities/archived', 'Old lathe', { role: 'Operator', archives: [OLD_DEVICE] })
    expect(said()).toEqual(['Restore', 'View in Devices', 'Export Bundle…', 'Permanent Delete'])
    const denied = requiresRolesTitle(PERMISSION_UUIDS.ARCHIVE_MANAGE)
    for (const name of ['Restore', 'Export Bundle…', 'Permanent Delete']) {
      const button = drawer().getByRole('button', { name })
      expect(button).toBeDisabled()
      expect(tooltipOf(button)).toBe(denied)
    }
  })

  it('are greyed for an Auditor, who may open the Audit Trail', async () => {
    await showOpen('/entities/archived', 'Old bay', { role: 'Auditor', archives: [OLD_CELL] })
    expect(said()).toEqual(['Restore', 'View in Cells', 'View in Audit Trail', 'Permanent Delete'])
    expect(drawer().getByRole('button', { name: 'Restore' })).toBeDisabled()
  })

  it('that take it away close the drawer, and the row leaves', async () => {
    api.post.mockResolvedValue(true)
    const { showToast } = await showOpen('/entities/archived', 'Old bay', { archives: [OLD_CELL, OLD_DEVICE] })
    const restore = drawer().getByRole('button', { name: 'Restore' })
    restore.focus()
    fireEvent.click(restore)
    const dialog = within(await screen.findByRole('dialog', { name: /^Restore Cell — / }))
    api.get.mockImplementation((path) => Promise.resolve(path === '/api/v1/archives' ? [OLD_DEVICE] : []))
    fireEvent.click(dialog.getByRole('button', { name: 'Restore Cell' }))
    await waitFor(isShut)
    await waitFor(() => expect(rowOf('Old bay')).toBeUndefined())
    expect(address()).toBe('/entities/archived')
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('restored'), 'success', { to: entityUrl('cell', OLD_CELL.entity_id) })
    // What opened the dialog has gone with the drawer, so focus goes to the page's main region.
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector('main')))
  })

  it('that take it away leave the drawer open while the dialog is, and after a refusal', async () => {
    api.delete.mockRejectedValue(new Error('a playback names it'))
    await showOpen('/entities/archived', 'Old bay', { archives: [OLD_CELL] })
    fireEvent.click(drawer().getByRole('button', { name: 'Permanent Delete' }))
    const dialog = within(await screen.findByRole('dialog', { name: /^Permanently Delete Cell — / }))
    fireEvent.change(dialog.getByLabelText(/Type the .* to confirm/i), { target: { value: 'Old bay' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Permanently Delete Cell' }))
    expect(await dialog.findByRole('alert')).toHaveTextContent('a playback names it')
    expect(panel()).toHaveClass('context-panel-open')
  })
})

describe('a retired row', () => {
  it('opens a drawer with its ids, when it was archived and deleted, and by whom', async () => {
    api.displayNamesFor.mockResolvedValue(new Map([['user-1', 'Ada Admin']]))
    await showOpen('/entities/retired', 'Scrapped edge', { retired: [GONE_GATEWAY, GONE_DEVICE] })
    expect(address()).toBe(`/entities/retired?entity=${GONE_GATEWAY.entity_id}`)
    expect(labels()).toEqual(['Gateway UUID', 'Description', 'Kind', 'Name', 'Sparkplug Edge Node ID', 'Archived At', 'Retired At', 'Retired By'])
    expect(fields()).toMatchObject({
      'Archived At': formatDateTime(GONE_GATEWAY.archived_at), 'Retired At': formatDateTime(GONE_GATEWAY.retired_at),
    })
    await waitFor(() => expect(fields()['Retired By']).toBe('Ada Adminadmin@example.test'))
  })

  it('says which of its ids its readings are still stored under', async () => {
    await showOpen('/entities/retired', 'Scrapped lathe', { retired: [GONE_DEVICE] })
    expect(fields()).toMatchObject({ Description: 'It was worn out', 'Sparkplug Device ID': 'devc00000000000400080000', 'Published ID': 'plc-old', 'Retired By': 'Retention timer' })
    const help = drawer().getAllByRole('button', { name: /^What .+ means$/ })
    expect(help.map(b => b.getAttribute('aria-label'))).toEqual(['What Sparkplug Device ID means'])
  })

  it('shows a machine identity that deleted it by its whole id, to copy', async () => {
    const machine = 'b0000000-0000-4000-8000-000000000001'
    await showOpen('/entities/retired', 'Scrapped lathe', { retired: [{ ...GONE_DEVICE, retired_by: machine }] })
    expect(drawer().getByRole('button', { name: `Copy retired by ${machine}` })).toBeInTheDocument()
  })

  it('says its state in a word beside its kind, with an icon', async () => {
    await showOpen('/entities/retired', 'Scrapped lathe', { retired: [GONE_DEVICE] })
    const badges = [...panel().querySelectorAll('.context-panel-subtitle .badge')]
    expect(badges.map(b => b.textContent)).toEqual(['Device', 'Retired'])
    expect(badges[1].querySelector('svg')).not.toBeNull()
  })

  it('is read-only: no actions, and no page of its own', async () => {
    await showOpen('/entities/retired', 'Scrapped lathe', { role: 'Administrator', retired: [GONE_DEVICE] })
    expect(panel().querySelector('.context-panel-actions')).toBeNull()
    expect(drawer().queryByRole('link', { name: /View in Devices/ })).toBeNull()
    expect(drawer().queryByRole('button', { name: /Restore|Permanent Delete|Export/ })).toBeNull()
  })

  it('is named by its id where the tombstone has no name', async () => {
    await show('/entities/retired', { retired: [{ ...GONE_DEVICE, name: null }] })
    fireEvent.click(rowOf('—'))
    await waitFor(() => expect(panel()).toHaveClass('context-panel-open'))
    expect(panel().querySelector('.context-panel-title')).toHaveTextContent(GONE_DEVICE.entity_id)
  })
})

describe('what survives a retired entity', () => {
  const section = () => drawer().getByText('What Survives').parentElement
  const links = () => [...section().querySelectorAll('.context-buttons > .context-action')].map(a => a.textContent.trim())

  it('is its Audit Trail, a gateway\'s repository and each bundle, in the drawer\'s grid of buttons', async () => {
    await showOpen('/entities/retired', 'Scrapped edge', { retired: [GONE_GATEWAY, GONE_DEVICE] })
    expect(links()).toEqual(['View in Audit Trail', 'Forge Repository'])
    expect(drawer().getByRole('link', { name: 'View in Audit Trail' })).toHaveAttribute('href', `/audit-trail?search=${GONE_GATEWAY.entity_id}&type=GATEWAY&deleted=1`)
    await open('Scrapped lathe')
    await waitFor(() => expect(links()).toEqual(['View in Audit Trail', 'Bundle 1 Sept 2026']))
    for (const el of section().querySelectorAll('.context-action')) expect(el).toHaveClass('btn', 'btn-ghost', 'btn-sm')
  })

  it('is left out where this reader may open none of it', async () => {
    window.history.replaceState(null, '', '/entities/retired')
    const only = (permission) => permission === PERMISSION_UUIDS.ARCHIVE_MANAGE
    api.get.mockImplementation((path) => Promise.resolve(path.startsWith('/api/v1/archives/retired') ? [{ ...GONE_DEVICE, exports: [] }] : []))
    render(<EntitiesTab showToast={vi.fn()} userRole="Operator" hasPermission={only} />)
    await open('Scrapped lathe')
    expect(drawer().queryByText('What Survives')).toBeNull()
  })

  it('says why a bundle could not be fetched', async () => {
    api.assetExportDownloadUrl.mockRejectedValue(new Error('the object is gone'))
    const { showToast } = await showOpen('/entities/retired', 'Scrapped lathe', { retired: [GONE_DEVICE] })
    fireEvent.click(drawer().getByRole('button', { name: 'Bundle 1 Sept 2026' }))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('the object is gone', 'error'))
  })
})

describe('a row\'s shape', () => {
  it('of an archived one is the directory\'s, with what archiving wrote', () => {
    const row = archivedRow(OLD_DEVICE)
    expect(row).toMatchObject({ kind: 'devices', id: OLD_DEVICE.entity_id, state: 'archived', description: 'Out for a rebuild', entity_type: 'device', archived_at: OLD_DEVICE.archived_at })
    expect(row.second_ids).toEqual(['deva00000000000400080000', 'plc-10'])
    expect(archivedRow({ ...OLD_CELL, directory: undefined })).toMatchObject({ kind: 'cells', page_id: OLD_CELL.entity_id, second_ids: [], description: null })
  })

  it('of a retired one is read from its tombstone', () => {
    expect(retiredRow(GONE_DEVICE)).toMatchObject({ kind: 'devices', state: 'retired', page_id: null, variant: null, description: 'It was worn out', second_ids: ['devc00000000000400080000', 'plc-old'] })
    // One id, said once; a replay lane as one; and nothing but the row where there is no snapshot.
    expect(retiredRow({ ...GONE_DEVICE, old_data: { reported_identity: GONE_DEVICE.sparkplug_id, shadow_of: uuid(9) } }))
      .toMatchObject({ second_ids: [GONE_DEVICE.sparkplug_id], variant: 'replay_lane' })
    expect(retiredRow({ ...GONE_DEVICE, sparkplug_id: null, old_data: null })).toMatchObject({ second_ids: [], description: null })
  })
})

describe('an archived entity\'s address', () => {
  it('sets the lifecycle filter of the four pages that have one, and of no other kind\'s', () => {
    expect(entityUrl('device', 'x', null, 'archived')).toBe('/devices?search=x&lifecycle=archived')
    expect(entityUrl('device', 'x', 'quarantined', 'active')).toBe('/devices?search=x')
    expect(entityUrl('gateway', 'x', 'playback')).toBe('/gateways?search=x')
    expect(entityUrl('metric', 'x', 'deprecated', 'archived')).toBe('/metrics/deprecated?metric=x')
  })
})

describe('the read of the archived rows', () => {
  afterEach(() => { from.mockReset() })
  const tables = (answers) => from.mockImplementation((table) => {
    const builder = {
      select: () => builder,
      eq: (column, value) => Promise.resolve(answers[table]?.(column, value) ?? { data: [], error: null }),
      in: () => Promise.resolve({ data: [], error: null }),
    }
    return builder
  })
  const CELL = { id: OLD_CELL.entity_id, name: 'Old bay', archived_at: '2026-10-01T10:00:00Z', auto_delete_at: null }

  it('has each one\'s row of the directory, by its kind and its id', async () => {
    const { realGet } = await import('../api')
    tables({
      cells: () => ({ data: [CELL], error: null }),
      entity_directory: (column, value) => ({ data: column === 'state' && value === 'archived' ? [OLD_CELL.directory, { ...OLD_CELL.directory, kind: 'areas', name: 'Another' }] : [], error: null }),
    })
    const rows = await realGet('/api/v1/archives')
    expect(rows.map(r => [r.name, r.directory])).toEqual([['Old bay', OLD_CELL.directory]])
  })

  it('stands without it', async () => {
    const { realGet } = await import('../api')
    tables({ cells: () => ({ data: [CELL], error: null }), entity_directory: () => ({ data: null, error: { message: 'timed out' } }) })
    expect((await realGet('/api/v1/archives')).map(r => [r.name, r.directory])).toEqual([['Old bay', null]])
  })
})
