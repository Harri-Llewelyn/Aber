/**
 * The three lists that describe one fact, and the invariant that keeps them one (#141).
 *
 * A Digital Thread entity type has to be three things at once, and each was written separately:
 *
 *   DRAWABLE    -- `SECTIONS` in DigitalThreadTab decides which kinds get a lane.
 *   ASKABLE     -- the filter dropdown decides which kinds a reader can request.
 *   RESOLVABLE  -- the map in api.js turns the dropdown's spelling into the stored entity_type.
 *
 * MISSING FROM ANY ONE OF THEM FAILS SILENTLY, AND IN THE THREE DIFFERENT WAYS THAT MADE THIS
 * HARD TO SEE. Not drawable: counted by the header and never rendered -- 27 of 28 lanes on the
 * stack that found it. Not askable: reachable only by clearing the filter entirely. Not
 * resolvable: the query runs, matches no stored row, and the page answers "no events" to a filter
 * that is simply broken -- which is the worst of the three, because it looks like an answer.
 *
 * The first was fixed on its own and the other two survived it, so these assert the RELATIONSHIP
 * rather than the seven kinds that exist today. A kind added to the shared table must arrive in
 * all three places or fail here.
 */
import { describe, it, expect } from 'vitest'
import {
  DIGITAL_THREAD_ENTITY_TYPES,
  ENTITY_KIND_BY_TABLE,
  ENTITY_TABLE_BY_KIND,
} from '../constants'

describe('Digital Thread entity types', () => {
  it('every kind offered by the filter resolves to a stored entity_type', () => {
    // The defect this file exists for. A dropdown entry with no mapping is a query for a value
    // the database has never stored, and it returns cleanly.
    for (const { kind, table } of DIGITAL_THREAD_ENTITY_TYPES) {
      expect(ENTITY_TABLE_BY_KIND[kind]).toBe(table)
    }
  })

  it('every stored entity_type reads back as the kind it was offered under', () => {
    // The other direction: a row arriving from the database has to land in the section the filter
    // would have asked for, or filtering by a kind hides rows of that same kind.
    for (const { kind, table } of DIGITAL_THREAD_ENTITY_TYPES) {
      expect(ENTITY_KIND_BY_TABLE[table]).toBe(kind)
    }
  })

  it('round-trips kind -> table -> kind for every entry', () => {
    for (const { kind } of DIGITAL_THREAD_ENTITY_TYPES) {
      expect(ENTITY_KIND_BY_TABLE[ENTITY_TABLE_BY_KIND[kind]]).toBe(kind)
    }
  })

  it('has no duplicate kind or table', () => {
    // Two entries sharing a table would make one of them unreachable through the filter, and
    // sharing a kind would make one unreachable in the timeline -- both silently.
    const kinds = DIGITAL_THREAD_ENTITY_TYPES.map(e => e.kind)
    const tables = DIGITAL_THREAD_ENTITY_TYPES.map(e => e.table)
    expect(new Set(kinds).size).toBe(kinds.length)
    expect(new Set(tables).size).toBe(tables.length)
  })

  it('gives every entry a label a person can read', () => {
    // The bar from 0031: "a half-legible audit entry is worse than an absent one, because it looks
    // like the feature works." A label that is just the raw table name clears nothing.
    for (const { kind, table, label } of DIGITAL_THREAD_ENTITY_TYPES) {
      expect(label).toBeTruthy()
      expect(label).not.toBe(table)
      expect(label).not.toBe(kind)
    }
  })

  it('covers the audit domains 0070 added, which is what drifted', () => {
    // Named rather than counted. These three reached the audit trigger in 0070 and none of the
    // three lists was extended, which is the whole of #141; a count would pass against any seven.
    const tables = DIGITAL_THREAD_ENTITY_TYPES.map(e => e.table)
    expect(tables).toEqual(expect.arrayContaining([
      'user_roles', 'schemas', 'system_settings', 'service_principals',
    ]))
  })
})
