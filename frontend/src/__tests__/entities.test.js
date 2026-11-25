import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  ENTITY_KINDS, ID_PREFIX_MIN, PINNED_IDENTITY_ROWS, byKindThenName, entityKey, entityWarnings, findRank, isWholeId, kindLabel, mergeFound,
  personRow, secondIdFields, variantBadge,
} from '../utils/entities'
import { AUDIT_TRAIL_ENTITY_TYPES, ENTITY_FIND_LIMIT } from '../constants'
import { KNOWN_PRINCIPALS } from '../utils/serviceIdentities'
import { api } from '../api'

const { from, rpc } = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }))
vi.mock('../lib/supabaseClient', () => ({
  SUPABASE_URL: 'http://stack.test',
  SUPABASE_GATEWAY_KEY: 'sb_publishable_test',
  supabase: { from, rpc, auth: { getSession: vi.fn() } },
}))

const row = (over = {}) => ({ kind: 'devices', id: 'a0000000-0000-4000-8000-000000000004', name: 'Lathe 10', state: 'active', variant: null, second_ids: ['deva00000000000400080000', 'plc-10'], ...over })

describe('the kinds', () => {
  it('are the Audit Trail\'s words, so a row\'s trail needs no mapping', () => {
    const words = AUDIT_TRAIL_ENTITY_TYPES.map(e => e.table)
    for (const { kind } of ENTITY_KINDS) expect(words).toContain(kind)
  })

  it('name one record each, and a word this build does not know as it is', () => {
    expect(kindLabel('service_principals')).toBe('Machine Identity')
    expect(kindLabel('something_new')).toBe('something_new')
  })

  it('order the list, and a kind this build does not know is last', () => {
    const rows = [row({ kind: 'something_new', name: 'A' }), row({ kind: 'devices', name: 'Lathe 10' }), row({ kind: 'devices', name: 'Lathe 9' }), row({ kind: 'areas', name: 'Z' })]
    expect(rows.sort(byKindThenName).map(r => r.name)).toEqual(['Z', 'Lathe 9', 'Lathe 10', 'A'])
  })
})

describe('what names a row', () => {
  it('is a whole id, a whole name, the start of an id, or part of a name, in that order', () => {
    const r = row()
    expect(findRank(r, '  A0000000-0000-4000-8000-000000000004 ')).toBe(0)
    expect(findRank(r, 'PLC-10')).toBe(0)
    expect(findRank(r, 'lathe 10')).toBe(1)
    expect(findRank(r, 'deva0000')).toBe(2)
    expect(findRank(r, 'the 1')).toBe(3)
    expect(findRank(r, 'nothing')).toBeNull()
    expect(findRank(r, '   ')).toBeNull()
  })

  it('counts the start of an id from eight characters, and the middle of one never', () => {
    expect(ID_PREFIX_MIN).toBe(8)
    expect(findRank(row({ name: 'x' }), 'deva000')).toBeNull()
    expect(findRank(row({ name: 'x' }), 'deva0000')).toBe(2)
    expect(findRank(row({ name: 'x' }), '0000-4000-8000')).toBeNull()
  })

  it('treats a percent, an underscore and a hash as themselves', () => {
    const metric = row({ kind: 'metric_catalog', name: 'Axes/TEMP_1', second_ids: ['https://example.org/100%25/a', '0112/2///61987#ABA951#009'] })
    expect(findRank(metric, 'https://example.org/100%25/a')).toBe(0)
    expect(findRank(metric, 'https://example.org/%/a')).toBeNull()
    expect(findRank(metric, '0112/2///61987#aba951')).toBe(2)
    expect(findRank(metric, 'TEMP%1')).toBeNull()
  })

  it('is a whole id only when the whole of one is there', () => {
    expect(isWholeId(row(), 'plc-10')).toBe(true)
    expect(isWholeId(row(), 'plc-1')).toBe(false)
    expect(isWholeId(row(), '')).toBe(false)
  })

  it('finds a person by any part of their address, and by the whole of it as an id', () => {
    const person = personRow({ user_id: 'u-1', email: 'ada@example.test', display_name: 'Ada Lovelace' })
    expect(findRank(person, 'ada@')).toBe(3)
    expect(findRank(person, 'ada@example.test')).toBe(0)
    expect(findRank(person, 'lovelace')).toBe(3)
  })
})

describe('a search\'s rows', () => {
  it('put a whole id first, the browser\'s own rows among the database\'s, and keep the database\'s order', () => {
    const b = row({ id: 'b', name: 'B ada', second_ids: [] })
    const a = row({ id: 'a', name: 'A ada', second_ids: [] })
    const person = personRow({ user_id: 'u-1', email: null, display_name: 'ada' })
    expect(mergeFound([b, a], [person], 'ada').map(r => r.id)).toEqual(['u-1', 'b', 'a'])
    expect(mergeFound([b, a], [person], 'b ada').map(r => r.id)).toEqual(['b', 'a'])
  })

  it('keep a row the database found by a rule this build does not have, last', () => {
    expect(mergeFound([row({ id: 'x', name: 'x', second_ids: [] }), row()], [], 'plc-10').map(r => r.id)).toEqual([row().id, 'x'])
  })
})

describe('the rows no table holds', () => {
  it('are a person by their name, else their address, else their id, with removed access said', () => {
    expect(personRow({ user_id: 'u', email: 'e@x.test', display_name: 'Ada' })).toMatchObject({ kind: 'user_roles', id: 'u', name: 'Ada', second_ids: ['e@x.test'], variant: null })
    expect(personRow({ user_id: 'u', email: 'e@x.test', display_name: null }).name).toBe('e@x.test')
    expect(personRow({ user_id: 'u', email: null, display_name: null })).toMatchObject({ name: 'u', second_ids: [] })
    expect(personRow({ user_id: 'u', email: 'e@x.test', status: 'removed' }).variant).toBe('removed')
  })

  it('are the pinned identities, by the dashboard\'s own list', () => {
    expect(PINNED_IDENTITY_ROWS.map(r => [r.id, r.name, r.kind])).toEqual(
      Object.entries(KNOWN_PRINCIPALS).map(([id, known]) => [id, known.name, 'service_principals']))
  })

  it('have the view\'s columns, so a drawer reads them alike', () => {
    const columns = ['kind', 'id', 'name', 'description', 'state', 'variant', 'second_ids', 'area_id', 'cell_id', 'gateway_id', 'device_id', 'page_id']
    for (const r of [personRow({ user_id: 'u' }), PINNED_IDENTITY_ROWS[0]]) expect(Object.keys(r)).toEqual(columns)
  })
})

describe('what a row says', () => {
  it('names each further id as its kind\'s own drawer does', () => {
    expect(secondIdFields(row()).map(f => f.label)).toEqual(['Sparkplug Device ID', 'Published ID'])
    expect(secondIdFields(row({ kind: 'metric_catalog', second_ids: ['a', 'b', 'c'] })).map(f => f.label)).toEqual(['Semantic ID', 'Further Semantic ID', 'Further Semantic ID'])
    expect(secondIdFields(row({ kind: 'something_new', second_ids: ['a'] }))).toEqual([{ label: 'Further ID', value: 'a' }])
    expect(secondIdFields(row({ kind: 'areas', second_ids: [] }))).toEqual([])
  })

  it('marks what sets it apart in words, and nothing where its kind says it all', () => {
    for (const variant of ['draft', 'archived', 'derived', 'deprecated', 'quarantined', 'playback', 'disabled', 'withdrawn', 'removed']) {
      expect(variantBadge(row({ variant })).label, variant).toMatch(/^[A-Z]/)
    }
    for (const variant of [null, 'active', 'device', 'gateway', 'scheduled']) expect(variantBadge(row({ variant })), String(variant)).toBeNull()
    expect(variantBadge(null)).toBeNull()
  })

  it('warns of a quarantined device and a withdrawn identity, and of nothing else', () => {
    expect(entityWarnings(row({ variant: 'quarantined' }))).toHaveLength(1)
    expect(entityWarnings(row({ variant: 'withdrawn' }))).toHaveLength(1)
    expect(entityWarnings(row({ variant: 'deprecated' }))).toEqual([])
    expect(entityWarnings(null)).toEqual([])
  })

  it('has a key of its own among every row, a deleted one\'s id included', () => {
    expect(entityKey(row())).not.toBe(entityKey(row({ state: 'retired' })))
  })
})

describe('the reads', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('list what is in service from entity_directory', async () => {
    const eq = vi.fn().mockResolvedValue({ data: [row()], error: null })
    from.mockReturnValue({ select: () => ({ eq }) })
    expect(await api.get('/api/v1/entities')).toEqual([row()])
    expect(from).toHaveBeenCalledWith('entity_directory')
    expect(eq).toHaveBeenCalledWith('state', 'active')
  })

  it('ask find_entities for a text, with the page\'s limit, and nothing for a blank one', async () => {
    rpc.mockResolvedValue({ data: [row()], error: null })
    expect(await api.findEntities('plc-10')).toEqual([row()])
    expect(rpc).toHaveBeenCalledWith('find_entities', { p_query: 'plc-10', p_limit: ENTITY_FIND_LIMIT })
    rpc.mockClear()
    expect(await api.findEntities('   ')).toEqual([])
    expect(rpc).not.toHaveBeenCalled()
  })

  it('say why a search was refused', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'statement timeout' } })
    await expect(api.findEntities('x')).rejects.toThrow('statement timeout')
  })
})
