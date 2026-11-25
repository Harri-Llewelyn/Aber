import { describe, it, expect, vi, beforeEach } from 'vitest'
import { idFoundBy, inactiveState, isIdShaped, shortlist } from '../utils/entities'
import { ENTITY_PAGES, KIND_ICONS, recordUrl } from '../utils/entityPages'
import { ENTITY_KINDS } from '../utils/entities'
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
    const list = shortlist([...many('devices', 1, 40, 'Bay lathe'), ...many('cells', 100, 3, 'Bay zone')], 'bay', { perKind: 4 })
    expect(names(list)).toEqual(['Bay lathe 1', 'Bay lathe 2', 'Bay lathe 3', 'Bay lathe 4', 'Bay zone 1', 'Bay zone 2', 'Bay zone 3'])
  })

  it('has a whole id first, then a whole name, then the start of an id, then part of a name', () => {
    const part = row('areas', 1, 'The press-10 yard')
    const start = row('gateways', 2, 'Edge', { second_ids: ['press-1000'] })
    const whole = row('automations', 3, 'Zed', { second_ids: ['press-10'] })
    const name = row('schemas', 4, 'Press-10')
    expect(names(shortlist([part, start, name, whole], 'PRESS-10', { perKind: 10 }))).toEqual(['Zed', 'Press-10', 'Edge', 'The press-10 yard'])
  })

  it('has what is in service before the archived and the deleted, among equals', () => {
    const list = shortlist([
      row('devices', 1, 'Bay a', { state: 'retired' }), row('devices', 2, 'Bay b', { state: 'archived' }), row('devices', 3, 'Bay c'),
    ], 'bay', { perKind: 10 })
    expect(names(list)).toEqual(['Bay c', 'Bay b', 'Bay a'])
    // A whole name that was deleted still beats a part of one in service.
    expect(names(shortlist([row('devices', 1, 'Bay', { state: 'retired' }), row('devices', 3, 'Bay c')], 'bay', { perKind: 10 }))).toEqual(['Bay', 'Bay c'])
  })

  it('has a device before its captures, and each of what the key says are the same once', () => {
    const captures = many('captures', 10, 5, 'x').map(c => ({ ...c, name: 'Lathe', page_id: 'p1' }))
    const list = shortlist([...captures, row('devices', 1, 'Lathe')], 'lathe', { perKind: 10, keyOf: r => r.kind + r.page_id })
    expect(list.map(r => r.kind)).toEqual(['devices', 'captures'])
  })

  it('keeps a row the database found by a rule of its own letters, last', () => {
    expect(names(shortlist([row('devices', 1, 'İstanbul'), row('devices', 2, 'bay istanbul')], 'istanbul', { perKind: 10 }))).toEqual(['bay istanbul', 'İstanbul'])
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

  it('has the shape of one from eight characters of a UUID, or as a semantic id is written', () => {
    for (const text of ['3f2504e0', '3F2504E0-4f89', '3f2504e0-4f89-41d3-9a0c-0305e82c3301', ' 3f2504e0- ', 'https://example.org/a', 'urn:a:b', '0112/2///61987#ABA951#009', 'nsu=http://a.org/;i=1']) {
      expect(isIdShaped(text), text).toBe(true)
    }
    for (const text of ['', '3f2504e', '3f2504e0x', '3f2504e04f89', '3f25-04e04f89', '3f2504e0-4f89-41d3-9a0c-0305e82c33011', 'lathe-10', 'plc-10', 'Lathe 10 bay']) {
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
  /** A read of the view: what was asked, and the answer it is given. */
  let reads
  const view = (...answers) => {
    reads = []
    from.mockImplementation((table) => {
      const read = { table, or: [] }
      reads.push(read)
      const query = {
        select: () => query,
        ilike: (column, pattern) => { read.ilike = [column, pattern]; return query },
        or: (filter) => { read.or.push(filter); return query },
        order: (column) => { read.order = column; return query },
        limit: (n) => { read.limit = n; return Promise.resolve(answers[reads.length - 1] ?? { data: [], error: null }) },
      }
      return query
    })
  }
  const full = (kind, name = 'Bay lathe', extra) => many(kind, 1, ENTITY_FIND_LIMIT, name, extra)

  beforeEach(() => { vi.clearAllMocks(); view() })

  it('is not made for the Entities page, nor where the answer is not full', async () => {
    rpc.mockResolvedValue({ data: full('devices'), error: null })
    expect(await api.findEntities('bay')).toHaveLength(ENTITY_FIND_LIMIT)
    expect(reads).toHaveLength(0)
    rpc.mockResolvedValue({ data: full('devices').slice(1), error: null })
    expect(await api.findEntities('bay', { share: 10 })).toHaveLength(ENTITY_FIND_LIMIT - 1)
    expect(reads).toHaveLength(0)
    expect(rpc).toHaveBeenCalledWith('find_entities', { p_query: 'bay', p_limit: ENTITY_FIND_LIMIT })
  })

  it('leaves out the kind and state that filled the answer, and adds what it crowded out', async () => {
    rpc.mockResolvedValue({ data: full('devices'), error: null })
    const cells = many('cells', 1000, 3, 'Bay zone')
    view({ data: cells, error: null })
    const rows = await api.findEntities(' Bay ', { share: 10 })
    expect(reads).toEqual([{ table: 'entity_directory', ilike: ['name', '%Bay%'], or: ['kind.neq.devices,state.neq.active'], order: 'name', limit: ENTITY_FIND_LIMIT }])
    expect(rows.filter(r => r.kind === 'cells')).toEqual(cells)
    expect(rows).toHaveLength(ENTITY_FIND_LIMIT + 3)
  })

  it('goes on while each answer is full, leaving out one more kind each time', async () => {
    rpc.mockResolvedValue({ data: full('devices'), error: null })
    view({ data: full('metric_catalog', 'Bay/TEMP'), error: null }, { data: many('areas', 5000, 1, 'Bay'), error: null })
    const rows = await api.findEntities('bay', { share: 10 })
    expect(reads.map(r => r.or)).toEqual([
      ['kind.neq.devices,state.neq.active'],
      ['kind.neq.devices,state.neq.active', 'kind.neq.metric_catalog,state.neq.active'],
    ])
    expect(new Set(rows.map(r => r.kind))).toEqual(new Set(['devices', 'metric_catalog', 'areas']))
  })

  it('finds the live ones where deleted ones filled the answer', async () => {
    rpc.mockResolvedValue({ data: full('devices', 'Bay lathe', { state: 'retired' }), error: null })
    view({ data: [row('devices', 9000, 'Bay press')], error: null })
    const rows = await api.findEntities('bay', { share: 10 })
    expect(reads[0].or).toEqual(['kind.neq.devices,state.neq.retired'])
    expect(rows.at(-1).name).toBe('Bay press')
  })

  it('stops where the answer holds no more of any kind than its share', async () => {
    rpc.mockResolvedValue({ data: full('devices'), error: null })
    view({ data: full('devices', 'Bay other').map(r => ({ ...r, id: r.id.replace('a', 'b') })), error: null })
    await api.findEntities('bay', { share: 10 })
    expect(reads).toHaveLength(1)
  })

  it('takes a wildcard as it was typed', async () => {
    rpc.mockResolvedValue({ data: full('devices', 'a'), error: null })
    view({ data: [row('cells', 900, '100%_\\ b'), row('cells', 901, '100 x')], error: null })
    await api.findEntities('100%_\\', { share: 10 })
    expect(reads[0].ilike).toEqual(['name', '%100\\%\\_\\\\%'])
    // PostgREST reads a star as a wildcard whatever is done to it, so what it let through is checked.
    view({ data: [row('cells', 900, 'Bay*1'), row('cells', 901, 'Bay 1')], error: null })
    const rows = await api.findEntities('bay*1', { share: 10 })
    expect(names(rows.filter(r => r.kind === 'cells'))).toEqual(['Bay*1'])
  })

  it('leaves the rows it has where the further read is refused', async () => {
    rpc.mockResolvedValue({ data: full('devices'), error: null })
    view({ data: null, error: { message: 'statement timeout' } })
    expect(await api.findEntities('bay', { share: 10 })).toHaveLength(ENTITY_FIND_LIMIT)
  })
})
