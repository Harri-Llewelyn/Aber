import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DIRECTORY_KINDS, ENTITY_KINDS, idFoundBy, inactiveState, isIdShaped, shortlist } from '../utils/entities'
import { ENTITY_PAGES, KIND_ICONS, recordUrl } from '../utils/entityPages'
import { ENTITIES_TABS, TABS } from '../navigation'
import { ENTITY_FIND_LIMIT } from '../constants'
import { entityUrl, findEntityUrl } from '../routes'
import { api } from '../api'

/**
 * What the top bar's search does with find_entities()' rows before it draws them, and the read that fills
 * each kind's share. entities.test.js holds the rule a text names a row by.
 */

const { from, rpc } = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }))
vi.mock('../lib/supabaseClient', () => ({
  SUPABASE_URL: 'http://stack.test',
  SUPABASE_GATEWAY_KEY: 'sb_publishable_test',
  supabase: { from, rpc, auth: { getSession: vi.fn() } },
}))

const row = (kind, n, name, extra = {}) => ({ kind, id: `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`, name, state: 'active', variant: null, second_ids: [], page_id: `p${n}`, ...extra })
const many = (kind, start, n, name, extra) => Array.from({ length: n }, (_, i) => row(kind, start + i, `${name} ${i + 1}`, extra))
const names = (rows) => rows.map(r => r.name)

describe('the shortlist', () => {
  it('holds at most its share of each kind, in the order people read numbers', () => {
    const list = shortlist([...many('devices', 1, 40, 'Bay lathe'), ...many('cells', 100, 3, 'Bay zone')], 'bay', 4)
    expect(names(list)).toEqual(['Bay lathe 1', 'Bay lathe 2', 'Bay lathe 3', 'Bay lathe 4', 'Bay zone 1', 'Bay zone 2', 'Bay zone 3'])
  })

  it('has a whole id first, then a whole name, then the start of an id, then part of a name', () => {
    const part = row('areas', 1, 'The press-10 yard')
    const start = row('gateways', 2, 'Edge', { second_ids: ['press-1000'] })
    const whole = row('automations', 3, 'Zed', { second_ids: ['press-10'] })
    const name = row('schemas', 4, 'Press-10')
    expect(names(shortlist([part, start, name, whole], 'PRESS-10', 10))).toEqual(['Zed', 'Press-10', 'Edge', 'The press-10 yard'])
  })

  it('has what is in service before the archived and the deleted, among equals', () => {
    const list = shortlist([
      row('devices', 1, 'Bay a', { state: 'retired' }), row('devices', 2, 'Bay b', { state: 'archived' }), row('devices', 3, 'Bay c'),
    ], 'bay', 10)
    expect(names(list)).toEqual(['Bay c', 'Bay b', 'Bay a'])
    // A whole name that was deleted still beats a part of one in service.
    expect(names(shortlist([row('devices', 1, 'Bay', { state: 'retired' }), row('devices', 3, 'Bay c')], 'bay', 10))).toEqual(['Bay', 'Bay c'])
  })

  it('has a device before its capture, which goes by its name', () => {
    const list = shortlist([row('captures', 10, 'Lathe'), row('devices', 1, 'Lathe')], 'lathe', 10)
    expect(list.map(r => r.kind)).toEqual(['devices', 'captures'])
  })

  it('keeps a row the database found by a rule of its own letters, last', () => {
    expect(names(shortlist([row('devices', 1, 'İstanbul'), row('devices', 2, 'bay istanbul')], 'istanbul', 10))).toEqual(['bay istanbul', 'İstanbul'])
  })
})

describe('an id', () => {
  const device = row('devices', 4, 'Lathe 10', { second_ids: ['deva00000000000400080000', 'plc-10'] })

  it('is the one the text is, else the one it starts, and none for a name', () => {
    expect(idFoundBy(device, ' PLC-10 ')).toBe('plc-10')
    expect(idFoundBy(device, 'deva0000')).toBe('deva00000000000400080000')
    expect(idFoundBy(device, device.id.toUpperCase())).toBe(device.id)
    expect(idFoundBy(device, 'lathe 10')).toBeNull()
    expect(idFoundBy(device, 'lathe')).toBeNull()
    expect(idFoundBy(device, 'deva000')).toBeNull()
  })

  it('has the shape of one from eight characters of a UUID, or as a Sparkplug id or a semantic id is written', () => {
    for (const text of ['3f2504e0', '3F2504E0-4f89', '3f2504e0-4f89-41d3-9a0c-0305e82c3301', ' 3f2504e0- ', 'devf9966a4ee9ce4e519e6d5', 'GWYf9966a4ee9ce4e519e6d5', 'https://example.org/a', 'urn:a:b', '0112/2///61987#ABA951#009', 'nsu=http://a.org/;i=1']) {
      expect(isIdShaped(text), text).toBe(true)
    }
    for (const text of ['', '3f2504e', '3f2504e0x', '3f2504e04f89', '3f25-04e04f89', '3f2504e0-4f89-41d3-9a0c-0305e82c33011', 'devf9966a4ee9ce4e519e6d', 'devices and gateways, all', 'lathe-10', 'plc-10', 'Lathe 10 bay']) {
      expect(isIdShaped(text), text).toBe(false)
    }
  })
})

describe('a row', () => {
  it('says the state it is in where that is not in service, as the Entities page\'s tabs name it', () => {
    expect(ENTITIES_TABS.map(t => inactiveState({ state: t.id }))).toEqual([null, ...ENTITIES_TABS.slice(1).map(t => t.label)])
  })

  it('opens its own page where the reader may open that page, else its row on the Entities page', () => {
    const device = row('devices', 1, 'Lathe')
    expect(recordUrl(device, TABS)).toBe(entityUrl('device', device.page_id))
    expect(recordUrl(device, [])).toBe(findEntityUrl(device.id))
    expect(recordUrl({ ...device, page_id: null }, TABS)).toBe(findEntityUrl(device.id))
    expect(recordUrl(row('something_new', 1, 'x'), TABS)).toBe(findEntityUrl(device.id))
    expect(recordUrl(row('metric_catalog', 2, 'M', { variant: 'derived' }), TABS)).toBe(entityUrl('metric', 'p2', 'derived'))
  })

  it('has a page and an icon for every kind', () => {
    for (const { kind } of ENTITY_KINDS) {
      expect(TABS.some(t => t.label === ENTITY_PAGES[kind].page), kind).toBe(true)
      expect(KIND_ICONS[kind], kind).toBeTypeOf('function')
    }
  })
})

describe('the read that fills each kind\'s share', () => {
  /** A read of the view: what was asked, and the answer its kind is given. */
  let reads
  const view = (answers = {}) => {
    reads = []
    from.mockImplementation((table) => {
      const read = { table, order: [] }
      reads.push(read)
      const query = {
        select: () => query,
        eq: (column, value) => { read[column] = value; return query },
        ilike: (column, pattern) => { read.ilike = [column, pattern]; return query },
        order: (column) => { read.order.push(column); return query },
        limit: (n) => { read.limit = n; return Promise.resolve(answers[read.kind] ?? { data: [], error: null }) },
      }
      return query
    })
  }
  const full = (kind, name = 'Bay lathe', extra) => many(kind, 1, ENTITY_FIND_LIMIT, name, extra)
  const bar = { share: 10, kinds: DIRECTORY_KINDS }

  beforeEach(() => { vi.clearAllMocks(); view() })

  it('is not made for the Entities page, nor where the answer is not full', async () => {
    rpc.mockResolvedValue({ data: full('devices'), error: null })
    expect(await api.findEntities('bay')).toHaveLength(ENTITY_FIND_LIMIT)
    rpc.mockResolvedValue({ data: full('devices').slice(1), error: null })
    expect(await api.findEntities('bay', bar)).toHaveLength(ENTITY_FIND_LIMIT - 1)
    expect(reads).toHaveLength(0)
    expect(rpc).toHaveBeenCalledWith('find_entities', { p_query: 'bay', p_limit: ENTITY_FIND_LIMIT })
  })

  it('is of every kind but those with their share, each its best by state and name', async () => {
    rpc.mockResolvedValue({ data: [...full('devices').slice(5), ...many('cells', 1000, 5, 'Bay zone')], error: null })
    const cells = many('cells', 1003, 4, 'Bay zone')
    view({ cells: { data: cells, error: null }, areas: { data: [row('areas', 9000, 'Bay')], error: null } })
    const rows = await api.findEntities(' Bay ', bar)
    expect(reads.map(r => r.kind)).toEqual(DIRECTORY_KINDS.filter(kind => kind !== 'devices'))
    expect(reads[0]).toEqual({ table: 'entity_directory', kind: 'areas', ilike: ['name', '%Bay%'], order: ['state', 'name'], limit: 10 })
    // One row for each, whichever answers named it.
    expect(rows.filter(r => r.kind === 'cells').map(r => r.id)).toEqual([1000, 1001, 1002, 1003, 1004, 1005, 1006].map(n => row('cells', n).id))
    expect(rows).toHaveLength(ENTITY_FIND_LIMIT + 3)
  })

  it('finds the ones in service where deleted ones filled the answer', async () => {
    rpc.mockResolvedValue({ data: full('devices', 'Bay lathe', { state: 'retired' }), error: null })
    view({ devices: { data: [row('devices', 9000, 'Bay press')], error: null } })
    const rows = await api.findEntities('bay', bar)
    expect(names(shortlist(rows, 'bay', 10))[0]).toBe('Bay press')
    // The order it asks for is the one that puts them first.
    expect(['retired', 'active', 'archived'].sort()).toEqual(['active', 'archived', 'retired'])
  })

  it('takes a wildcard as it was typed', async () => {
    rpc.mockResolvedValue({ data: full('devices', 'a'), error: null })
    await api.findEntities('100%_\\', bar)
    expect(reads[0].ilike).toEqual(['name', '%100\\%\\_\\\\%'])
    // PostgREST reads a star as a wildcard whatever is done to it, so what it let through is checked.
    view({ cells: { data: [row('cells', 900, 'Bay*1'), row('cells', 901, 'Bay 1')], error: null } })
    const rows = await api.findEntities('bay*1', bar)
    expect(names(rows.filter(r => r.kind === 'cells'))).toEqual(['Bay*1'])
  })

  it('leaves the rows there are where one is refused', async () => {
    rpc.mockResolvedValue({ data: full('devices'), error: null })
    view({ cells: { data: null, error: { message: 'statement timeout' } }, areas: { data: [row('areas', 9000, 'Bay')], error: null } })
    expect(await api.findEntities('bay', bar)).toHaveLength(ENTITY_FIND_LIMIT + 1)
  })
})
