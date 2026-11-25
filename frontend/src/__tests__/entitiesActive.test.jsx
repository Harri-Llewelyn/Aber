import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EntitiesTab } from '../components/tabs/EntitiesTab'
import { PERMISSION_UUIDS, ENTITY_FIND_LIMIT } from '../constants'
import { DEFAULT_ROLE_PERMISSIONS_MAP } from '../hooks/usePermissions'
import { KNOWN_PRINCIPALS } from '../utils/serviceIdentities'
import { api } from '../api'
import { tabLink } from '../test/tabBar'

/**
 * The Entities page's Active tab, the search the three tabs share, and an entity's drawer. The rows
 * are entity_directory's (0321), which the database narrows to each reader; what is held here is what the
 * page does with them, and that it asks for people only where the reader has a read of them. The groups
 * the rows are in are entitiesGroups.test.jsx's, so every group is opened here.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal()),
  api: {
    get: vi.fn(),
    post: vi.fn(),
    findEntities: vi.fn(),
    listPeople: vi.fn(),
    listUserAccounts: vi.fn(),
    automationsForEntity: vi.fn(),
    displayNamesFor: vi.fn(),
  },
}))
vi.mock('../lib/supabaseClient', () => ({ supabase: { functions: { invoke: vi.fn() } } }))

const row = (kind, id, name, extra = {}) => ({
  kind, id, name, description: null, state: 'active', variant: null, second_ids: [],
  area_id: null, cell_id: null, gateway_id: null, device_id: null, page_id: id, ...extra,
})
const uuid = (n) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const AREA = row('areas', uuid(1), 'Machine Shop', { description: 'The hall by the yard' })
const CELL = row('cells', uuid(2), 'Bay 1', { area_id: AREA.id })
const GATEWAY = row('gateways', uuid(3), 'Edge 1', { second_ids: ['gwya00000000000400080000'], area_id: AREA.id, cell_id: CELL.id })
const DEVICE = row('devices', uuid(4), 'Lathe 10', {
  second_ids: ['deva00000000000400080000', 'plc-10'], area_id: AREA.id, cell_id: CELL.id, gateway_id: GATEWAY.id,
})
const HELD = row('devices', uuid(5), 'Lathe 9', { second_ids: ['devb00000000000400080000'], variant: 'quarantined' })
const SCHEMA = row('schemas', uuid(6), 'Lathe_Schema', { variant: 'archived', second_ids: ['https://example.org/lathe'] })
const METRIC = row('metric_catalog', uuid(7), 'Axes/TEMP', { second_ids: ['0112/2///61987#ABA951#009', 'https://example.org/temp'] })
const DERIVED = row('metric_catalog', uuid(8), 'Parts/RATE', { variant: 'derived' })
const AUTOMATION = row('automations', uuid(9), 'Coolant is low', { second_ids: ['coolant-low'], page_id: 'coolant-low', variant: 'disabled' })
const CAPTURE = row('captures', uuid(10), 'Lathe 10', {
  variant: 'device', device_id: DEVICE.id, gateway_id: GATEWAY.id, page_id: DEVICE.id,
  second_ids: ['deva00000000000400080000/0f.json'], description: 'Before the overhaul',
})
const BACKUP = row('backups', uuid(11), '20261124T031500Z', { second_ids: ['20261124T031500Z'], page_id: uuid(99), variant: 'scheduled' })
const IDENTITY = row('service_principals', uuid(12), 'Line 4 report', { description: 'Reads the plant' })
const EVERY = [AREA, CELL, GATEWAY, DEVICE, HELD, SCHEMA, METRIC, DERIVED, AUTOMATION, CAPTURE, BACKUP, IDENTITY]

const PERSON = { user_id: uuid(20), email: 'ada@example.test', display_name: 'Ada Lovelace', status: 'active' }
const REMOVED = { user_id: uuid(21), email: 'bob@example.test', display_name: null, status: 'removed' }

const ARCHIVED_CELL = { entity_id: uuid(30), name: 'Old bay', entity_type: 'cell', archived_at: '2026-10-01T10:00:00Z', auto_delete_at: null }
const ARCHIVED_DEVICE = { entity_id: uuid(31), name: 'Old lathe', entity_type: 'device', archived_at: '2026-10-01T10:00:00Z', auto_delete_at: null }
const RETIRED_DEVICE = {
  entity_type: 'device', entity_id: uuid(32), name: 'Scrapped lathe', sparkplug_id: 'devc', archived_at: '2026-09-01T10:00:00Z',
  retired_at: '2026-10-02T10:00:00Z', retired_by: null, retired_by_email: null, old_data: {}, exports: [],
}
const ofArchived = (r) => row(`${r.entity_type}s`, r.entity_id, r.name, { state: r.retired_at ? 'retired' : 'archived', page_id: null })

const holds = (role) => (permission) => (DEFAULT_ROLE_PERMISSIONS_MAP[role] || []).includes(permission)
const at = (url) => window.history.replaceState(null, '', url)
const address = () => window.location.pathname + window.location.search
const names = () => [...document.querySelectorAll('tbody tr:not(.table-group-row)')].map(tr => tr.querySelector('strong').textContent)
const search = () => screen.getByRole('searchbox', { name: 'Search entities by any ID or name' })
const panel = () => document.querySelector('.context-panel')
const drawer = () => within(panel())
const fieldsOf = () => [...panel().querySelectorAll('.context-panel-fields .context-field')]
  .map(f => [f.querySelector('dt').textContent.trim(), f.querySelector('dd').textContent.trim()])
const actions = () => [...panel().querySelectorAll('.context-panel-actions a, .context-panel-actions button')]

/** Opens every group: a tab that has one starts with it open. */
const expandAll = async () => {
  const button = await screen.findByRole('button', { name: /^(Expand|Collapse) all$/ })
  if (button.textContent === 'Expand all') fireEvent.click(button)
}

const show = async ({ role = 'Administrator', entities = EVERY, archives = [], retired = [], url = '/entities' } = {}) => {
  at(url)
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/entities')) return Promise.resolve(entities)
    if (path.startsWith('/api/v1/archives/retired')) return Promise.resolve(retired)
    if (path.startsWith('/api/v1/archives/exports')) return Promise.resolve([])
    if (path.startsWith('/api/v1/archives')) return Promise.resolve(archives)
    return Promise.resolve([])
  })
  const showToast = vi.fn()
  render(<EntitiesTab showToast={showToast} userRole={role} hasPermission={holds(role)} onViewTrail={vi.fn()} />)
  // A search and an address that names a kind or a row open the groups themselves.
  if (url === '/entities') await expandAll()
  return { showToast }
}
const openRow = async (name) => {
  fireEvent.click((await screen.findAllByText(name)).find(el => el.closest('tbody')).closest('tr'))
  await waitFor(() => expect(panel()).toHaveClass('context-panel-open'))
}

beforeEach(() => {
  vi.clearAllMocks()
  api.findEntities.mockResolvedValue([])
  api.listPeople.mockResolvedValue([PERSON, REMOVED])
  api.listUserAccounts.mockResolvedValue([{ user_id: PERSON.user_id, email: PERSON.email, display_name: PERSON.display_name }])
  api.automationsForEntity.mockResolvedValue([])
  api.displayNamesFor.mockResolvedValue(new Map())
})

describe('the Active tab', () => {
  it('is the page\'s first tab, and lists what the database answered, by kind and then by name', async () => {
    await show({ role: 'Operator', entities: [...EVERY].reverse() })
    await screen.findByText('Machine Shop')
    expect(tabLink('Active')).toHaveAttribute('aria-current', 'page')
    // Natural order within a kind: Lathe 9 before Lathe 10.
    expect(names()).toEqual(['Machine Shop', 'Bay 1', 'Edge 1', 'Lathe 9', 'Lathe 10', 'Lathe_Schema', 'Axes/TEMP', 'Parts/RATE',
      'Coolant is low', 'Lathe 10', '20261124T031500Z', 'Line 4 report'])
  })

  it('shows each one\'s uuid, its second ids, and what sets it apart within its kind', async () => {
    await show({ role: 'Operator' })
    await screen.findByText('Machine Shop')
    expect([...document.querySelectorAll('thead th')].map(th => th.textContent)).toEqual(['Name', 'UUID', 'Second IDs'])
    const cells = (name) => [...(screen.getAllByText(name).find(el => el.closest('tbody')).closest('tr')).cells]
    expect(within(cells('Axes/TEMP')[1]).getByRole('button', { name: `Copy uuid ${METRIC.id}` })).toBeInTheDocument()
    expect(cells('Axes/TEMP')[2]).toHaveTextContent('0112/2///61987#ABA951#009 · https://example.org/temp')
    expect(cells('Axes/TEMP')[2].querySelector('.overflow-text')).not.toBeNull()
    expect(cells('Machine Shop')[2]).toHaveTextContent('—')
    for (const [name, badge] of [['Lathe 9', 'Quarantined'], ['Lathe_Schema', 'Archived version'], ['Parts/RATE', 'Derived'], ['Coolant is low', 'Disabled']]) {
      expect(cells(name)[0]).toHaveTextContent(badge)
    }
  })

  it('sorts by a column, held in the address', async () => {
    await show({ role: 'Operator', entities: [AREA, DEVICE, HELD] })
    await screen.findByText('Machine Shop')
    fireEvent.click(screen.getByRole('button', { name: 'Name' }))
    expect(names()).toEqual(['Machine Shop', 'Lathe 9', 'Lathe 10'])
    expect(address()).toBe('/entities?sort=name')
    fireEvent.click(screen.getByRole('button', { name: 'Name' }))
    expect(names()).toEqual(['Machine Shop', 'Lathe 10', 'Lathe 9'])
    expect(address()).toBe('/entities?sort=-name')
  })

  it('says when the entities could not be read, rather than that there are none', async () => {
    at('/entities')
    api.get.mockImplementation((path) => (path.startsWith('/api/v1/entities') ? Promise.reject(new Error('timed out')) : Promise.resolve([])))
    render(<EntitiesTab showToast={vi.fn()} userRole="Operator" hasPermission={holds('Operator')} />)
    expect(await screen.findByText(/The entities could not be read: timed out/)).toBeInTheDocument()
    expect(screen.queryByText('Nothing is in service yet.')).toBeNull()
  })
})

describe('people and the platform\'s own identities', () => {
  it('are beside the rows for an Administrator, with whose access was removed', async () => {
    await show({ entities: [AREA] })
    const ada = (await screen.findByText('Ada Lovelace')).closest('tr')
    expect(ada.cells[2]).toHaveTextContent('ada@example.test')
    expect(screen.getByText('bob@example.test', { selector: 'strong' }).closest('tr')).toHaveTextContent('Access removed')
    for (const known of Object.values(KNOWN_PRINCIPALS)) expect(screen.getByText(known.name)).toBeInTheDocument()
    expect(api.listUserAccounts).not.toHaveBeenCalled()
  })

  it('are beside the rows for an Auditor, through the read an Auditor has', async () => {
    await show({ role: 'Auditor', entities: [AREA] })
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument()
    expect(screen.getByText('Service_Ingestor')).toBeInTheDocument()
    expect(api.listPeople).not.toHaveBeenCalled()
  })

  it.each(['Operator', 'Shopfloor_Manager'])('are never asked for by a %s', async (role) => {
    await show({ role, entities: [AREA] })
    await screen.findByText('Machine Shop')
    expect(names()).toEqual(['Machine Shop'])
    expect(api.listPeople).not.toHaveBeenCalled()
    expect(api.listUserAccounts).not.toHaveBeenCalled()
  })

  it('leave the rows standing when the read of people fails', async () => {
    api.listPeople.mockRejectedValue(new Error('refused'))
    await show({ entities: [AREA] })
    expect(await screen.findByText('Machine Shop')).toBeInTheDocument()
  })
})

describe('the search', () => {
  const type = (text) => fireEvent.change(search(), { target: { value: text } })

  it('asks the database, and lists what it answered, each kind in the order it answered', async () => {
    api.findEntities.mockResolvedValue([CAPTURE, DEVICE, HELD])
    await show({ role: 'Operator' })
    await screen.findByText('Machine Shop')
    type('Lathe')
    // The devices' group comes before the captures', and the devices are in the answer's order.
    await waitFor(() => expect(names()).toEqual(['Lathe 10', 'Lathe 9', 'Lathe 10']))
    expect(api.findEntities).toHaveBeenCalledWith('lathe')
    expect(address()).toBe('/entities?find=Lathe')
    // Several rows, and no whole id: nothing opens.
    expect(panel()).not.toHaveClass('context-panel-open')
  })

  it('finds a person by any part of a name or an address, whom the database does not hold', async () => {
    await show({ entities: [AREA] })
    await screen.findByText('Ada Lovelace')
    type('ada@')
    await waitFor(() => expect(names()).toEqual(['Ada Lovelace']))
  })

  it('finds a pinned identity by the start of its id', async () => {
    await show({ entities: [AREA] })
    await screen.findByText('Ada Lovelace')
    type('b0000000')
    await waitFor(() => expect(names()).toEqual(Object.values(KNOWN_PRINCIPALS).map(k => k.name).sort()))
  })

  it.each([
    ['a uuid', DEVICE.id.toUpperCase(), DEVICE],
    ['a Sparkplug id', 'gwya00000000000400080000', GATEWAY],
    ['a reported identity', 'plc-10', DEVICE],
    ['a semantic id', '0112/2///61987#ABA951#009', METRIC],
    ['an automation\'s key', 'coolant-low', AUTOMATION],
  ])('opens the row %s names', async (_, id, expected) => {
    api.findEntities.mockResolvedValue([expected])
    await show({ role: 'Operator', url: `/entities?find=${encodeURIComponent(id)}` })
    await waitFor(() => expect(panel()).toHaveClass('context-panel-open'))
    expect(panel()).toHaveAttribute('aria-label', expect.stringContaining(expected.name))
    expect(new URLSearchParams(window.location.search).get('entity')).toBe(expected.id)
  })

  it('opens a person by their whole id, and stays closed once closed', async () => {
    await show({ entities: [AREA], url: `/entities?find=${PERSON.user_id}` })
    await waitFor(() => expect(panel()).toHaveClass('context-panel-open'))
    fireEvent.click(drawer().getByRole('button', { name: 'Close details' }))
    await waitFor(() => expect(panel()).not.toHaveClass('context-panel-open'))
    expect(address()).toBe(`/entities?find=${PERSON.user_id}`)
  })

  it('opens nothing when the whole id names more than one row, or starts with what was typed', async () => {
    api.findEntities.mockResolvedValue([SCHEMA, { ...METRIC, second_ids: ['https://example.org/lathe'] }])
    await show({ role: 'Operator', url: '/entities?find=https://example.org/lathe' })
    await waitFor(() => expect(names()).toEqual(['Lathe_Schema', 'Axes/TEMP']))
    expect(panel()).not.toHaveClass('context-panel-open')
  })

  it('says what else it found on the other tabs, and goes there with the search', async () => {
    api.findEntities.mockResolvedValue([DEVICE, ofArchived(ARCHIVED_DEVICE), ofArchived(RETIRED_DEVICE)])
    await show({ archives: [ARCHIVED_CELL, ARCHIVED_DEVICE], retired: [RETIRED_DEVICE], url: '/entities?find=lathe' })
    await waitFor(() => expect(names()).toEqual(['Lathe 10']))
    expect(screen.getByText(/Also found:/)).toHaveTextContent('Also found: 1 archived, 1 retired.')
    fireEvent.click(screen.getByRole('link', { name: '1 archived' }))
    await waitFor(() => expect(names()).toEqual(['Old lathe']))
    expect(address()).toBe('/entities/archived?find=lathe')
    fireEvent.click(tabLink('Retired'))
    expect(names()).toEqual(['Scrapped lathe'])
    expect(search()).toHaveValue('lathe')
  })

  it('opens the tab that lists an archived or a retired row, for a whole id of one', async () => {
    api.findEntities.mockResolvedValue([ofArchived(ARCHIVED_CELL)])
    await show({ archives: [ARCHIVED_CELL, ARCHIVED_DEVICE], url: `/entities?find=${ARCHIVED_CELL.entity_id}` })
    await waitFor(() => expect(address()).toBe(`/entities/archived?find=${ARCHIVED_CELL.entity_id}`))
    await waitFor(() => expect(names()).toEqual(['Old bay']))
    expect(panel()).not.toHaveClass('context-panel-open')
    // Restore is there as it always was.
    expect(screen.getByRole('button', { name: /Restore/ })).toBeEnabled()
  })

  it('is asked again after Restore, since the entity is on another tab now', async () => {
    api.findEntities.mockResolvedValue([ofArchived(ARCHIVED_CELL), ofArchived(ARCHIVED_DEVICE)])
    api.post.mockResolvedValue(true)
    await show({ archives: [ARCHIVED_CELL, ARCHIVED_DEVICE], url: '/entities/archived?find=old' })
    await waitFor(() => expect(names()).toEqual(['Old bay', 'Old lathe']))
    api.findEntities.mockResolvedValue([row('cells', ARCHIVED_CELL.entity_id, 'Old bay'), ofArchived(ARCHIVED_DEVICE)])
    fireEvent.click(screen.getAllByRole('button', { name: /Restore/ })[0])
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Restore Cell' })).getByRole('button', { name: 'Restore Cell' }))
    await waitFor(() => expect(api.findEntities).toHaveBeenCalledTimes(2))
    expect(await screen.findByText(/Also found:/)).toHaveTextContent('Also found: 1 active.')
  })

  it('says nothing matches, by what was typed', async () => {
    await show({ role: 'Operator', url: '/entities?find=nothing-like-it' })
    expect(await screen.findByText((_, el) => el.className === 'empty-text' && el.textContent === 'No active entity matches nothing-like-it.')).toBeInTheDocument()
  })

  it('says when only the first matches are listed', async () => {
    api.findEntities.mockResolvedValue(Array.from({ length: ENTITY_FIND_LIMIT }, (_, i) => row('devices', uuid(2000 + i), `Press ${i}`)))
    await show({ role: 'Operator', url: '/entities?find=press' })
    expect(await screen.findByText(/Only the first 200 matches are listed/)).toBeInTheDocument()
  })

  it('says why a search failed, and lists nothing as found', async () => {
    api.findEntities.mockRejectedValue(new Error('statement timeout'))
    await show({ role: 'Operator', url: '/entities?find=press' })
    expect(await screen.findByText(/The search could not be made: statement timeout/)).toBeInTheDocument()
  })
})

describe('an entity\'s drawer', () => {
  it('starts with the uuid and the description, then the kind, the name and the second ids', async () => {
    await show({ role: 'Operator' })
    await openRow('Axes/TEMP')
    expect(fieldsOf()).toEqual([
      ['Metric UUID', METRIC.id],
      ['Description', 'Not set'],
      ['Kind', 'Metric'],
      ['Name', 'Axes/TEMP'],
      ['Semantic ID', '0112/2///61987#ABA951#009'],
      ['Further Semantic ID', 'https://example.org/temp'],
    ])
    // Every id is copied on a click.
    expect(drawer().getByRole('button', { name: 'Copy semantic id 0112/2///61987#ABA951#009' })).toBeInTheDocument()
  })

  it('says where a device is, as links, and that it is quarantined at the top', async () => {
    await show({ role: 'Operator', entities: [AREA, CELL, GATEWAY, { ...HELD, area_id: AREA.id, cell_id: CELL.id, gateway_id: GATEWAY.id }] })
    await openRow('Lathe 9')
    expect(within(drawer().getByRole('list', { name: 'Warnings' })).getByRole('listitem')).toHaveTextContent(/Quarantined: nobody has admitted/)
    expect(fieldsOf().slice(4)).toEqual([
      ['Sparkplug Device ID', 'devb00000000000400080000'], ['Serving Gateway', 'Edge 1'], ['Cell', 'Bay 1'], ['Area', 'Machine Shop'],
    ])
    expect(drawer().getByRole('link', { name: 'Edge 1' })).toHaveAttribute('href', `/gateways?search=${GATEWAY.id}`)
    expect(drawer().getByRole('link', { name: 'Machine Shop' })).toHaveAttribute('href', `/areas?search=${AREA.id}`)
  })

  it.each([
    ['Machine Shop', 'View in Areas', `/areas?search=${AREA.id}`],
    ['Bay 1', 'View in Cells', `/cells?search=${CELL.id}`],
    ['Edge 1', 'View in Gateways', `/gateways?search=${GATEWAY.id}`],
    ['Lathe 9', 'View in Devices', `/devices?search=${HELD.id}`],
    ['Lathe_Schema', 'View in Schemas', `/schemas?search=${SCHEMA.id}`],
    ['Axes/TEMP', 'View in Metrics', `/metrics?metric=${METRIC.id}`],
    ['Parts/RATE', 'View in Metrics', `/metrics/derived?metric=${DERIVED.id}`],
    ['Coolant is low', 'View in Automations', '/automations/coolant-low'],
    ['20261124T031500Z', 'View in Backups', `/backups?run=${uuid(99)}`],
    ['Line 4 report', 'View in Access Control', `/access-control/identities?search=${IDENTITY.id}`],
    ['Ada Lovelace', 'View in Access Control', `/access-control/people?person=${PERSON.user_id}`],
    ['bob@example.test', 'View in Access Control', `/access-control/people?removed=1&person=${REMOVED.user_id}`],
  ])('takes %s to its own page first, by %s', async (name, label, href) => {
    await show()
    await openRow(name)
    const [first] = actions()
    expect(first).toHaveTextContent(label)
    expect(first).toHaveClass('btn-primary')
    expect(first).toHaveAttribute('href', href)
  })

  it('takes a capture to its subject on the Capture page', async () => {
    await show({ entities: [GATEWAY, DEVICE, CAPTURE], url: '/entities?kind=captures' })
    await openRow('Lathe 10')
    expect(actions()[0]).toHaveTextContent('View in Capture')
    expect(actions()[0]).toHaveAttribute('href', `/capture/device?subject=${DEVICE.id}`)
    expect(fieldsOf().map(([label]) => label)).toEqual(
      ['Capture UUID', 'Description', 'Kind', 'Name', 'Stored File', 'Recorded Device', 'Recorded Gateway'])
  })

  it('offers no page for a backup whose job is gone, and the Audit Trail still', async () => {
    await show({ entities: [{ ...BACKUP, page_id: null }], url: '/entities?kind=backups' })
    await openRow('20261124T031500Z')
    expect(actions().map(a => a.textContent.trim())).toEqual(['View in Audit Trail'])
  })

  it('opens the Audit Trail on the entity, for who may read it', async () => {
    await show({ entities: [METRIC, DEVICE], url: '/entities' })
    await openRow('Axes/TEMP')
    expect(drawer().getByRole('link', { name: 'View in Audit Trail' })).toHaveAttribute('href', `/audit-trail?search=${METRIC.id}&type=METRIC`)
    // A device's trail includes its nameplate and schema rows, so it names no kind.
    await openRow('Lathe 10')
    expect(drawer().getByRole('link', { name: 'View in Audit Trail' })).toHaveAttribute('href', `/audit-trail?search=${DEVICE.id}`)
  })

  it('offers an Operator no Audit Trail, and an Auditor no Access Control', async () => {
    await show({ role: 'Operator', entities: [AREA] })
    await openRow('Machine Shop')
    expect(actions().map(a => a.textContent.trim())).toEqual(['View in Areas'])
  })

  it('offers an Auditor an identity\'s Audit Trail and not the page only an Administrator has', async () => {
    await show({ role: 'Auditor', entities: [IDENTITY] })
    await openRow('Line 4 report')
    expect(actions().map(a => a.textContent.trim())).toEqual(['View in Audit Trail'])
  })

  it('counts the automations that apply to a device, and offers them for no other kind', async () => {
    api.automationsForEntity.mockResolvedValue([{ key: 'a' }, { key: 'a' }, { key: 'b' }])
    await show({ role: 'Operator', entities: [AREA, DEVICE] })
    await openRow('Lathe 10')
    expect(await drawer().findByRole('link', { name: 'View in Automations (2)' })).toHaveAttribute('href', `/automations?entity=${DEVICE.id}`)
    expect(actions().map(a => a.textContent.trim())).toEqual(['View in Devices', 'View in Automations (2)'])
    await openRow('Machine Shop')
    await waitFor(() => expect(actions().map(a => a.textContent.trim())).toEqual(['View in Areas']))
    expect(api.automationsForEntity).toHaveBeenCalledTimes(1)
  })

  it('opens from the address, and a row that is gone closes it and leaves the address', async () => {
    await show({ role: 'Operator', entities: [AREA], url: `/entities?entity=${AREA.id}` })
    await waitFor(() => expect(panel()).toHaveClass('context-panel-open'))
  })

  it('tidies an address that names no row', async () => {
    await show({ role: 'Operator', entities: [AREA], url: `/entities?entity=${uuid(404)}` })
    await screen.findByText('Machine Shop')
    await waitFor(() => expect(address()).toBe('/entities'))
    expect(panel()).not.toHaveClass('context-panel-open')
  })

  it('selects a row by the keyboard, and a second press closes it', async () => {
    await show({ role: 'Operator', entities: [AREA] })
    const tr = (await screen.findByText('Machine Shop')).closest('tr')
    fireEvent.keyDown(tr, { key: 'Enter' })
    await waitFor(() => expect(tr).toHaveClass('row-selected'))
    fireEvent.keyDown(tr, { key: ' ' })
    await waitFor(() => expect(tr).not.toHaveClass('row-selected'))
  })
})

describe('what each role may do', () => {
  it('opens the Archived tab to every role, with Restore and Permanent Delete for archive:manage alone', async () => {
    await show({ role: 'Operator', archives: [ARCHIVED_CELL], url: '/entities/archived' })
    expect(await screen.findByText('Old bay')).toBeInTheDocument()
    expect(holds('Operator')(PERMISSION_UUIDS.ARCHIVE_MANAGE)).toBe(false)
    expect(screen.getByRole('button', { name: /Restore/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Permanent Delete/ })).toBeDisabled()
  })

  it('tells a role the tombstones are not for who they are for, rather than that there are none', async () => {
    await show({ role: 'Operator', url: '/entities/retired' })
    expect(await screen.findByText('Your role cannot see retired entities. They are for Administrator, Shopfloor Manager and Auditor.')).toBeInTheDocument()
    expect(screen.queryByText(/Nothing has been retired/)).toBeNull()
  })

  it('says nothing has been retired to a role that may read them', async () => {
    await show({ role: 'Auditor', url: '/entities/retired' })
    expect(await screen.findByText(/Nothing has been retired/)).toBeInTheDocument()
  })
})
