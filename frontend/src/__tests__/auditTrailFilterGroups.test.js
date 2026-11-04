/**
 * The groups the Audit Trail's filters draw their values under (constants.js). Every action is in
 * exactly one group, so the Action list offers each once; every kind names a group the Entity list
 * draws, and the security group is the security domain, which only some roles may read. The map of
 * which kinds each action is written for (0229) names only actions, kinds and classes the page has.
 */
import { describe, it, expect } from 'vitest'
import {
  AUDIT_TRAIL_ACTIONS, AUDIT_TRAIL_ACTION_GROUPS, AUDIT_TRAIL_ACTION_KINDS, AUDIT_TRAIL_CLASSES,
  AUDIT_TRAIL_ENTITY_GROUPS, AUDIT_TRAIL_ENTITY_TYPES
} from '../constants'

describe('the action groups', () => {
  it('hold every action exactly once', () => {
    const grouped = AUDIT_TRAIL_ACTION_GROUPS.flatMap(g => g.actions)
    expect([...grouped].sort()).toEqual(Object.keys(AUDIT_TRAIL_ACTIONS).sort())
    expect(new Set(grouped).size).toBe(grouped.length)
  })

  it('are named, and none is empty', () => {
    for (const g of AUDIT_TRAIL_ACTION_GROUPS) {
      expect(g.label).toMatch(/^[A-Z]/)
      expect(g.actions.length).toBeGreaterThan(0)
    }
    expect(new Set(AUDIT_TRAIL_ACTION_GROUPS.map(g => g.label)).size).toBe(AUDIT_TRAIL_ACTION_GROUPS.length)
  })
})

describe('the entity groups', () => {
  const ids = AUDIT_TRAIL_ENTITY_GROUPS.map(g => g.id)

  it('name every kind\'s group, and every group holds a kind', () => {
    for (const e of AUDIT_TRAIL_ENTITY_TYPES) expect(ids, e.kind).toContain(e.group)
    for (const id of ids) expect(AUDIT_TRAIL_ENTITY_TYPES.some(e => e.group === id), id).toBe(true)
  })

  it('file a kind under security exactly when its domain is security', () => {
    for (const e of AUDIT_TRAIL_ENTITY_TYPES) {
      expect(e.group === 'security', e.kind).toBe(e.domain === 'security')
    }
  })

  it('are the plant, the model, capture and security, in that order', () => {
    expect(AUDIT_TRAIL_ENTITY_GROUPS.map(g => g.label)).toEqual(['The plant', 'The model', 'Capture', 'Security'])
  })
})

describe('the map of which kinds each action is written for', () => {
  const tables = new Set(AUDIT_TRAIL_ENTITY_TYPES.map(e => e.table))

  it('gives every action a kind, and names no action the filter lacks', () => {
    const mapped = new Set(AUDIT_TRAIL_ACTION_KINDS.map(([action]) => action))
    expect([...mapped].sort()).toEqual(Object.keys(AUDIT_TRAIL_ACTIONS).sort())
  })

  it('names only kinds the page draws and classes the legend holds', () => {
    for (const [action, kinds, classes] of AUDIT_TRAIL_ACTION_KINDS) {
      for (const k of kinds) expect(tables.has(k), `${action} on ${k}`).toBe(true)
      for (const c of classes) expect(AUDIT_TRAIL_CLASSES, action).toContain(c)
    }
  })

  it('lists each pair once', () => {
    const pairs = AUDIT_TRAIL_ACTION_KINDS.flatMap(([action, kinds]) => kinds.map(k => `${action} ${k}`))
    expect(new Set(pairs).size).toBe(pairs.length)
  })
})
