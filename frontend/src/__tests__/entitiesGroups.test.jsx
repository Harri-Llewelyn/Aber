import React from 'react'
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EntitiesTab, GROUP_PAGE } from '../components/tabs/EntitiesTab'
import { DEFAULT_ROLE_PERMISSIONS_MAP } from '../hooks/usePermissions'
import { ENTITY_KINDS, groupByKind, kindCount, kindPlural, lastDeleted, nextPurge } from '../utils/entities'
import { formatDay } from '../utils/format'
import { api } from '../api'
import { tabLink } from '../test/tabBar'

/**
 * The groups the Entities page's rows are in, on its three tabs: one for each kind, in the page's order,
 * closed to begin with, as the Metric Catalog's are. What opens one, what its heading says, and how much
 * of it is drawn.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal()),
  api: {
    get: vi.fn(), post: vi.fn(), findEntities: vi.fn(), listPeople: vi.fn(), listUserAccounts: vi.fn(),
    automationsForEntity: vi.fn(), displayNamesFor: vi.fn(),
  },
}))
vi.mock('../lib/supabaseClient', () => ({ supabase: { functions: { invoke: vi.fn() } } }))
// Every row draws one, so its renders are the rows'.
const { drawn } = vi.hoisted(() => ({ drawn: vi.fn() }))
vi.mock('../components/common/CopyableId', () => ({ default: ({ value }) => { drawn(value); return <span>{value}</span> } }))

const uuid = (n) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const row = (kind, n, name, extra = {}) => ({
  kind, id: uuid(n), name, description: null, state: 'active', variant: null, second_ids: [],
  area_id: null, cell_id: null, gateway_id: null, device_id: null, page_id: uuid(n), ...extra,
})
const AREA = row('areas', 1, 'Machine Shop')
const GATEWAY = row('gateways', 3, 'Edge 1')
const DEVICE = row('devices', 4, 'Lathe 10')
const OTHER = row('devices', 5, 'Lathe 9')
const SCHEMA = row('schemas', 6, 'Lathe_Schema')
const FEW = [SCHEMA, DEVICE, OTHER, AREA, GATEWAY]
const many = (kind, from, count, name) => Array.from({ length: count }, (_, i) => row(kind, from + i, `${name} ${i}`))

const archived = (type, n, name, extra = {}) => ({
  entity_id: uuid(n), name, entity_type: type, archived_at: '2026-10-01T10:00:00Z', auto_delete_at: null, ...extra,
})
const retired = (type, n, name, retired_at) => ({
  entity_type: type, entity_id: uuid(n), name, sparkplug_id: null, archived_at: '2026-09-01T10:00:00Z', retired_at,
  retired_by: null, retired_by_email: null, old_data: {}, exports: [],
})

const holds = (role) => (permission) => (DEFAULT_ROLE_PERMISSIONS_MAP[role] || []).includes(permission)
const address = () => window.location.pathname + window.location.search
const headings = () => [...document.querySelectorAll('.group-heading')]
const said = () => headings().map(b => b.textContent.replace(/·\s*/g, '· '))
const heading = (name) => screen.getByRole('button', { name })
const isOpen = (name) => heading(name).getAttribute('aria-expanded') === 'true'
const opened = () => headings().filter(b => b.getAttribute('aria-expanded') === 'true').map(b => b.querySelector('.group-heading-label').textContent)
const names = () => [...document.querySelectorAll('tbody tr:not(.table-group-row):not(.table-group-foot)')].map(tr => tr.querySelector('strong').textContent)
const search = () => screen.getByRole('searchbox', { name: 'Search entities by any ID or name' })
const type = (text) => fireEvent.change(search(), { target: { value: text } })
const panel = () => document.querySelector('.context-panel')
const all = (words) => fireEvent.click(screen.getByRole('button', { name: words }))

const show = async ({ role = 'Operator', entities = FEW, archives = [], tombstones = [], url = '/entities' } = {}) => {
  window.history.replaceState(null, '', url)
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/entities')) return Promise.resolve(entities)
    if (path.startsWith('/api/v1/archives/retired')) return Promise.resolve(tombstones)
    if (path.startsWith('/api/v1/archives/exports')) return Promise.resolve([])
    if (path.startsWith('/api/v1/archives')) return Promise.resolve(archives)
    return Promise.resolve([])
  })
  render(<EntitiesTab showToast={vi.fn()} userRole={role} hasPermission={holds(role)} onViewTrail={vi.fn()} />)
  await waitFor(() => expect(headings().length).toBeGreaterThan(0))
}

beforeEach(() => {
  vi.clearAllMocks()
  api.findEntities.mockResolvedValue([])
  api.listPeople.mockResolvedValue([])
  api.listUserAccounts.mockResolvedValue([])
  api.automationsForEntity.mockResolvedValue([])
  api.displayNamesFor.mockResolvedValue(new Map())
})

describe('the groups', () => {
  it('are one for each kind there is, in the page\'s order, closed to begin with', async () => {
    await show()
    expect(opened()).toEqual([])
    expect(names()).toEqual([])
    expect(headings().map(b => b.querySelector('.group-heading-label').textContent)).toEqual(['Areas', 'Gateways', 'Devices', 'Schemas'])
  })

  it('say how many rows they hold, drawn after the name and heard as words', async () => {
    await show()
    expect(heading('Devices, 2 devices')).toBeInTheDocument()
    expect(heading('Areas, 1 area')).toBeInTheDocument()
    expect(heading('Devices, 2 devices').querySelector('.group-heading-count [aria-hidden]')).toHaveTextContent('· 2')
  })

  it('carry the kind\'s glyph, which a screen reader is not told of', async () => {
    await show()
    for (const b of headings()) expect(b.querySelector('.group-heading-icon')).toHaveAttribute('aria-hidden', 'true')
  })

  it('replace the Kind filter and the Kind column on every tab', async () => {
    await show({ archives: [archived('cell', 30, 'Old bay')], tombstones: [retired('device', 40, 'Scrapped', '2026-10-02T10:00:00Z')] })
    for (const tab of ['Active', 'Archived', 'Retired']) {
      fireEvent.click(tabLink(tab))
      expect(screen.queryByRole('button', { name: /^Kind/ })).toBeNull()
      expect(screen.queryByRole('columnheader', { name: 'Kind' })).toBeNull()
    }
  })

  it('open on a press, with the whole row of the heading the control, and close on the next', async () => {
    await show()
    const button = heading('Devices, 2 devices')
    // Nothing else is in the row, and the cell adds no padding of its own around the button.
    expect(button.closest('tr')).toHaveClass('table-group-row')
    expect([...button.closest('td').children]).toEqual([button])
    expect(button.closest('td')).toHaveAttribute('colspan', '3')
    fireEvent.click(button)
    expect(names()).toEqual(['Lathe 9', 'Lathe 10'])
    const rows = document.getElementById(button.getAttribute('aria-controls'))
    expect(within(rows).getAllByRole('row')).toHaveLength(2)
    expect(opened()).toEqual(['Devices'])
    fireEvent.click(button)
    expect(names()).toEqual([])
    expect(rows).not.toBeVisible()
  })

  it('start open where the tab shows one', async () => {
    await show({ entities: [DEVICE, OTHER], archives: [archived('cell', 30, 'Old bay'), archived('area', 31, 'Old hall')], tombstones: [retired('gateway', 40, 'Scrapped', '2026-10-02T10:00:00Z')] })
    expect(opened()).toEqual(['Devices'])
    fireEvent.click(tabLink('Archived'))
    expect(opened()).toEqual([])
    fireEvent.click(tabLink('Retired'))
    expect(opened()).toEqual(['Gateways'])
    // And close, as any does.
    fireEvent.click(heading(/^Gateways/))
    expect(opened()).toEqual([])
  })

  it('are each tab\'s own, and are kept while the page is open', async () => {
    const archives = [archived('device', 30, 'Old lathe'), archived('cell', 31, 'Old bay')]
    await show({ archives })
    fireEvent.click(heading(/^Devices/))
    fireEvent.click(tabLink('Archived'))
    expect(opened()).toEqual([])
    fireEvent.click(heading(/^Cells/))
    fireEvent.click(tabLink('Active'))
    expect(opened()).toEqual(['Devices'])
    fireEvent.click(tabLink('Archived'))
    expect(opened()).toEqual(['Cells'])
    // Which are open is not in the address.
    expect(address()).toBe('/entities/archived')
  })

  it('sort their own rows, and keep their own order', async () => {
    await show({ url: '/entities?sort=-name' })
    all('Expand all')
    expect(names()).toEqual(['Machine Shop', 'Edge 1', 'Lathe 10', 'Lathe 9', 'Lathe_Schema'])
  })

  it('end in a kind this build does not know', async () => {
    await show({ entities: [row('something_new', 90, 'New'), AREA] })
    expect(said()).toEqual(['Areas· 1, 1 area', 'something_new· 1, 1 something_new'])
  })
})

describe('Expand all', () => {
  it('starts the row over the groups, and opens every one; Collapse all closes them', async () => {
    await show()
    const button = screen.getByRole('button', { name: 'Expand all' })
    expect(button.closest('.groups-header').firstElementChild).toContainElement(button)
    expect(button.closest('.groups-header').nextElementSibling).toHaveClass('table-wrap')
    fireEvent.click(button)
    expect(opened()).toEqual(['Areas', 'Gateways', 'Devices', 'Schemas'])
    all('Collapse all')
    expect(opened()).toEqual([])
  })

  it('draws the first rows of each', async () => {
    await show({ entities: [...many('devices', 1000, GROUP_PAGE + 5, 'Press'), ...many('metric_catalog', 3000, GROUP_PAGE + 1, 'Axes/TEMP')] })
    all('Expand all')
    expect(names()).toHaveLength(2 * GROUP_PAGE)
  })

  it('is not drawn over an empty list', async () => {
    await show()
    type('nothing-like-it')
    expect(await screen.findByText((_, el) => el.className === 'empty-text' && /No active entity matches/.test(el.textContent))).toBeInTheDocument()
    expect(document.querySelector('.groups-header')).toBeNull()
  })
})

describe('an open group', () => {
  it(`draws ${GROUP_PAGE} rows at a time, with a Show more of its own`, async () => {
    await show({ entities: [...many('devices', 1000, GROUP_PAGE + 5, 'Press'), ...many('metric_catalog', 3000, GROUP_PAGE + 1, 'Axes/TEMP'), AREA] })
    fireEvent.click(heading(/^Devices/))
    expect(names()).toHaveLength(GROUP_PAGE)
    expect(screen.getByText(`${GROUP_PAGE} of ${GROUP_PAGE + 5}`)).toBeInTheDocument()
    fireEvent.click(heading(/^Metrics/))
    fireEvent.click(screen.getByRole('button', { name: 'Show 5 more' }))
    // The devices' alone: the metrics have one still to show.
    expect(names()).toHaveLength(GROUP_PAGE + 5 + GROUP_PAGE)
    expect(screen.getByText(`All ${GROUP_PAGE + 5} shown.`)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show 1 more' })).toBeInTheDocument()
  })

  it('has no foot where it holds no more than the first rows', async () => {
    await show({ entities: many('devices', 1000, GROUP_PAGE, 'Press') })
    expect(names()).toHaveLength(GROUP_PAGE)
    expect(document.querySelector('.list-foot')).toBeNull()
  })

  it('starts at the first rows again when it is opened again', async () => {
    await show({ entities: [...many('devices', 1000, GROUP_PAGE + 5, 'Press'), AREA] })
    fireEvent.click(heading(/^Devices/))
    fireEvent.click(screen.getByRole('button', { name: 'Show 5 more' }))
    fireEvent.click(heading(/^Devices/))
    fireEvent.click(heading(/^Devices/))
    expect(names()).toHaveLength(GROUP_PAGE)
  })

  it('draws none of its rows again as a search is typed', async () => {
    api.findEntities.mockResolvedValue([DEVICE, OTHER, AREA])
    await show({ url: '/entities?find=a' })
    await waitFor(() => expect(names()).toHaveLength(3))
    api.findEntities.mockReturnValue(new Promise(() => {}))
    drawn.mockClear()
    for (const text of ['at', 'ath', 'athe']) type(text)
    expect(search()).toHaveValue('athe')
    expect(drawn).not.toHaveBeenCalled()
  })

  it('draws the row that is selected again, and no other', async () => {
    await show()
    all('Expand all')
    drawn.mockClear()
    fireEvent.click(screen.getByText('Edge 1').closest('tr'))
    await waitFor(() => expect(panel()).toHaveClass('context-panel-open'))
    // The row's own, and the drawer's of it.
    expect(new Set(drawn.mock.calls.map(([value]) => value))).toEqual(new Set([GATEWAY.id]))
  })
})

describe('a search', () => {
  it('opens the groups it matched, and says how many it matched in each', async () => {
    api.findEntities.mockResolvedValue([DEVICE, SCHEMA])
    await show({ url: '/entities?find=lathe' })
    await waitFor(() => expect(names()).toEqual(['Lathe 10', 'Lathe_Schema']))
    expect(said()).toEqual(['Devices· 1, 1 device', 'Schemas· 1, 1 schema'])
  })

  it('opens one a person had closed, and leaves them as they were once it is cleared', async () => {
    await show()
    fireEvent.click(heading(/^Areas/))
    fireEvent.click(heading(/^Devices/))
    fireEvent.click(heading(/^Devices/))
    api.findEntities.mockResolvedValue([DEVICE])
    type('lathe')
    await waitFor(() => expect(names()).toEqual(['Lathe 10']))
    type('')
    await waitFor(() => expect(headings()).toHaveLength(4))
    expect(opened()).toEqual(['Areas'])
  })

  it('lets a person close one it opened, and Collapse all close them all, and is kept', async () => {
    api.findEntities.mockResolvedValue([DEVICE, SCHEMA])
    await show({ url: '/entities?find=lathe' })
    await waitFor(() => expect(names()).toHaveLength(2))
    fireEvent.click(heading(/^Devices/))
    expect(names()).toEqual(['Lathe_Schema'])
    all('Collapse all')
    expect(names()).toEqual([])
    expect(search()).toHaveValue('lathe')
  })

  it('keeps a group closed as it is typed on, and opens it for the next search', async () => {
    api.findEntities.mockResolvedValue([DEVICE, SCHEMA])
    await show({ url: '/entities?find=lath' })
    await waitFor(() => expect(names()).toHaveLength(2))
    fireEvent.click(heading(/^Devices/))
    type('lathe')
    await waitFor(() => expect(api.findEntities).toHaveBeenCalledWith('lathe'))
    expect(names()).toEqual(['Lathe_Schema'])
    type('')
    await waitFor(() => expect(headings()).toHaveLength(4))
    type('lathe')
    await waitFor(() => expect(names()).toEqual(['Lathe 10', 'Lathe_Schema']))
  })

  it('by a whole id opens the row\'s group, though a person has closed it', async () => {
    api.findEntities.mockResolvedValue([DEVICE, OTHER])
    await show({ url: '/entities?find=lathe' })
    await waitFor(() => expect(names()).toHaveLength(2))
    fireEvent.click(heading(/^Devices/))
    api.findEntities.mockResolvedValue([DEVICE])
    type(DEVICE.id)
    await waitFor(() => expect(panel()).toHaveClass('context-panel-open'))
    expect(names()).toEqual(['Lathe 10'])
  })

  it('opens the groups of an archived row\'s own tab', async () => {
    const archives = [archived('cell', 30, 'Old bay'), archived('device', 31, 'Old lathe')]
    api.findEntities.mockResolvedValue([row('cells', 30, 'Old bay', { state: 'archived' })])
    await show({ archives, url: `/entities?find=${uuid(30)}` })
    await waitFor(() => expect(address()).toContain('/entities/archived'))
    await waitFor(() => expect(names()).toEqual(['Old bay']))
  })
})

describe('an address that names a kind', () => {
  it('opens its group and no other', async () => {
    await show({ url: '/entities?kind=devices' })
    expect(opened()).toEqual(['Devices'])
    expect(address()).toBe('/entities?kind=devices')
  })

  it('opens each it names, which a link from the old filter could', async () => {
    await show({ url: '/entities?kind=devices,areas' })
    expect(opened()).toEqual(['Areas', 'Devices'])
  })

  it('lets go of the groups when a person opens another, or closes the one it named', async () => {
    await show({ url: '/entities?kind=devices&sort=name' })
    fireEvent.click(heading(/^Areas/))
    expect(opened()).toEqual(['Areas', 'Devices'])
    expect(address()).toBe('/entities?sort=name')
    fireEvent.click(heading(/^Devices/))
    expect(opened()).toEqual(['Areas'])
  })

  it('lets go at Expand all too', async () => {
    await show({ url: '/entities?kind=devices' })
    all('Collapse all')
    expect(opened()).toEqual([])
    expect(address()).toBe('/entities')
  })

  it('opens its group of what a link\'s search matched, and every one for a search a person types', async () => {
    api.findEntities.mockResolvedValue([DEVICE, SCHEMA])
    await show({ url: '/entities?find=lathe&kind=devices' })
    await waitFor(() => expect(names()).toEqual(['Lathe 10']))
    type('lathe ')
    await waitFor(() => expect(opened()).toEqual(['Devices', 'Schemas']))
    expect(address()).not.toContain('kind=')
  })

  it('keeps the group open that it named, once a search is typed and cleared', async () => {
    await show({ url: '/entities?kind=devices' })
    api.findEntities.mockResolvedValue([SCHEMA])
    type('lathe')
    await waitFor(() => expect(names()).toEqual(['Lathe_Schema']))
    type('')
    await waitFor(() => expect(headings()).toHaveLength(4))
    expect(opened()).toEqual(['Devices'])
  })

  it('names nothing on a tab with no rows of that kind, or by a word that is no kind', async () => {
    await show({ tombstones: [retired('gateway', 40, 'Scrapped', '2026-10-02T10:00:00Z')], url: '/entities/retired?kind=metric_catalog' })
    expect(opened()).toEqual(['Gateways'])
  })

  it('leaves the address with the tab', async () => {
    await show({ archives: [archived('cell', 30, 'Old bay')], url: '/entities?kind=devices' })
    fireEvent.click(tabLink('Archived'))
    expect(address()).toBe('/entities/archived')
  })
})

describe('the row whose drawer is open', () => {
  it('opens its group when the address names it', async () => {
    await show({ url: `/entities?entity=${DEVICE.id}` })
    await waitFor(() => expect(panel()).toHaveClass('context-panel-open'))
    await waitFor(() => expect(opened()).toEqual(['Devices']))
    expect(screen.getByText('Lathe 10', { selector: 'strong' }).closest('tr')).toHaveClass('row-selected')
  })

  it('keeps its drawer when its group is closed', async () => {
    await show()
    fireEvent.click(heading(/^Devices/))
    fireEvent.click(screen.getByText('Lathe 9').closest('tr'))
    await waitFor(() => expect(panel()).toHaveClass('context-panel-open'))
    fireEvent.click(heading(/^Devices/))
    expect(names()).toEqual([])
    expect(panel()).toHaveClass('context-panel-open')
    expect(address()).toBe(`/entities?entity=${OTHER.id}`)
    // And the group stays closed.
    await act(async () => {})
    expect(isOpen(/^Devices/)).toBe(false)
  })
})

describe('a heading\'s date', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-25T12:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('on Retired is the last deletion\'s, after the count', async () => {
    await show({
      role: 'Administrator',
      tombstones: [
        retired('gateway', 40, 'Scrapped 1', '2026-10-02T10:00:00Z'), retired('gateway', 41, 'Scrapped 2', '2026-11-20T10:00:00Z'),
        retired('device', 42, 'Scrapped 3', '2025-03-01T10:00:00Z'),
      ],
      url: '/entities/retired',
    })
    expect(heading('Gateways, 2 gateways, last deleted 20 Nov')).toBeInTheDocument()
    // The year where it is not this one.
    expect(heading('Devices, 1 device, last deleted 1 Mar 2025')).toBeInTheDocument()
  })

  it('on Archived is the next purge\'s, and nothing where no timer runs', async () => {
    await show({
      archives: [
        archived('device', 30, 'Lathe', { auto_delete_at: '2027-01-10T10:00:00Z' }), archived('device', 31, 'Press', { auto_delete_at: '2026-12-03T10:00:00Z' }),
        archived('device', 32, 'Kept'), archived('cell', 33, 'Old bay'),
      ],
      url: '/entities/archived',
    })
    expect(heading('Devices, 3 devices, next purge 3 Dec')).toBeInTheDocument()
    expect(heading('Cells, 1 cell')).toBeInTheDocument()
  })

  it('on Archived counts the gateways a playback holds, whose dates are not kept', async () => {
    await show({
      archives: [
        archived('gateway', 30, 'Held', { auto_delete_at: '2026-11-28T10:00:00Z', playbacks: 3 }),
        archived('gateway', 31, 'Due', { auto_delete_at: '2026-12-03T10:00:00Z', playbacks: 0 }),
      ],
      url: '/entities/archived',
    })
    expect(heading('Gateways, 2 gateways, next purge 3 Dec, 1 held by a playback')).toBeInTheDocument()
    expect(document.querySelector('.cell-purge-held')).toHaveTextContent('Held: 3 playbacks name this gateway')
  })

  it('is over the rows a search left', () => {
    const rows = [{ auto_delete_at: null }, { auto_delete_at: '2026-12-03T10:00:00Z', playbacks: 2 }]
    expect(nextPurge(rows)).toBe('1 held by a playback')
    expect(nextPurge([{ auto_delete_at: null, playbacks: 2 }])).toBeNull()
    expect(nextPurge([])).toBeNull()
    expect(lastDeleted([])).toBeNull()
    expect(lastDeleted([{ retired_at: 'not a date' }])).toBeNull()
  })

  it('is cut before the name is, as a heading\'s words are', async () => {
    await show({ role: 'Administrator', tombstones: [retired('gateway', 40, 'Scrapped', '2026-11-20T10:00:00Z')], url: '/entities/retired' })
    expect(heading(/^Gateways/).querySelector('.group-heading-detail [aria-hidden] .overflow-text')).toHaveTextContent('· last deleted 20 Nov')
  })
})

describe('what a group is called', () => {
  it('is the kind\'s plural, and its count in words is singular for one', () => {
    expect(ENTITY_KINDS.map(k => kindCount(k.kind, 1))).toEqual(['1 area', '1 cell', '1 gateway', '1 device', '1 schema', '1 metric',
      '1 automation', '1 capture', '1 backup', '1 machine identity', '1 person'])
    expect(kindCount('user_roles', 0)).toBe('0 people')
    expect(kindPlural('service_principals')).toBe('Machine Identities')
    expect(kindPlural('something_new')).toBe('something_new')
  })

  it('and its rows keep the order they came in', () => {
    expect(groupByKind([DEVICE, AREA, OTHER])).toEqual([{ kind: 'areas', rows: [AREA] }, { kind: 'devices', rows: [DEVICE, OTHER] }])
    expect(groupByKind([])).toEqual([])
  })

  it('a day says its year where it is not this one', () => {
    const now = new Date('2026-11-25T12:00:00Z').getTime()
    expect(formatDay('2026-12-03T10:00:00Z', now)).toBe('3 Dec')
    expect(formatDay('2027-01-03T10:00:00Z', now)).toBe('3 Jan 2027')
    expect(formatDay(null, now)).toBe('—')
    expect(formatDay('nonsense', now)).toBe('—')
  })
})
