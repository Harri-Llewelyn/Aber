import { describe, it, expect } from 'vitest'
import {
  SCHEMA_STATUS, schemaVersion, schemaStatus, statusLabel, statusBadgeClass,
  schemaVersionLabel, baseSchemaName, nextVersion, nextVersionName,
  isSchemaEditable, canForkSchema, canPublishSchema, draftFor, lineageOf, isCurrentSchema
} from '../utils/schemaVersion'

const schema = (over = {}) => ({
  schema_uuid: 's1', schema_name: 'Robot_Arm_Schema', version: 1, status: 'active',
  parent_schema_id: null, change_description: 'Initial release', ...over
})

describe('schemaVersion — defaults for a pre-0037 row', () => {
  // The API layer defaults these, but the utils fail closed independently: a row whose status
  // could not be read must render read-only, never open an editor over a schema devices use.
  it('reads a row with no version or status as v1 / active', () => {
    const legacy = { schema_uuid: 's0', schema_name: 'Old' }
    expect(schemaVersion(legacy)).toBe(1)
    expect(schemaStatus(legacy)).toBe(SCHEMA_STATUS.ACTIVE)
    expect(isSchemaEditable(legacy)).toBe(false)
  })

  it('treats an unreadable schema as not editable rather than as a draft', () => {
    expect(isSchemaEditable(null)).toBe(false)
    expect(isSchemaEditable(undefined)).toBe(false)
    expect(isSchemaEditable({})).toBe(false)
  })
})

describe('schemaVersion — labels', () => {
  it('pairs the version with its status, because "v1" alone reads as "the current one"', () => {
    expect(schemaVersionLabel(schema())).toBe('v1 · Active')
    expect(schemaVersionLabel(schema({ version: 2, status: 'archived' }))).toBe('v2 · Archived')
    expect(schemaVersionLabel(schema({ version: 3, status: 'draft' }))).toBe('v3 · Draft')
  })

  it('gives a draft the warning badge and an archived version the receding one', () => {
    expect(statusBadgeClass('draft')).toBe('badge-warning')
    expect(statusBadgeClass('active')).toBe('badge-online')
    expect(statusBadgeClass('archived')).toBe('badge-neutral')
    // An unknown status must not render as raw text or crash a row.
    expect(statusBadgeClass('something-new')).toBe('badge-neutral')
    expect(statusLabel('something-new')).toBe('something-new')
  })
})

describe('schemaVersion — name derivation (mirrors public.schema_version_base_name)', () => {
  it('strips a trailing _v<n> so version suffixes never accumulate', () => {
    expect(baseSchemaName('Foo')).toBe('Foo')
    expect(baseSchemaName('Foo_v2')).toBe('Foo')
    expect(baseSchemaName('Foo_v12')).toBe('Foo')
  })

  it('only strips the trailing suffix, never one in the middle', () => {
    // Matches the SQL regexp's `$` anchor: a schema called `Foo_v2_v3` has base `Foo_v2`, and the
    // two implementations have to agree.
    expect(baseSchemaName('Foo_v2_v3')).toBe('Foo_v2')
    expect(baseSchemaName('Simulated_CNC_01_Schema')).toBe('Simulated_CNC_01_Schema')
  })

  it('handles an absent name without producing "undefined_v2"', () => {
    expect(baseSchemaName(undefined)).toBe('')
    expect(baseSchemaName(null)).toBe('')
  })

  it('derives the next version name from the base, not from the current name', () => {
    expect(nextVersionName(schema())).toBe('Robot_Arm_Schema_v2')
    expect(nextVersionName(schema({ schema_name: 'Robot_Arm_Schema_v2', version: 2 })))
      .toBe('Robot_Arm_Schema_v3')
  })
})

describe('schemaVersion — lifecycle predicates', () => {
  it('auto-increments the version rather than offering a choice', () => {
    expect(nextVersion(schema())).toBe(2)
    expect(nextVersion(schema({ version: 7 }))).toBe(8)
  })

  it('makes only a draft editable', () => {
    expect(isSchemaEditable(schema({ status: 'draft' }))).toBe(true)
    expect(isSchemaEditable(schema({ status: 'active' }))).toBe(false)
    expect(isSchemaEditable(schema({ status: 'archived' }))).toBe(false)
  })

  it('makes only the lineage head forkable', () => {
    expect(canForkSchema(schema({ status: 'active' }))).toBe(true)
    // Forking a draft would branch something never in force; forking an archived version would
    // produce a second claimant to the same version number. fork_schema() refuses both.
    expect(canForkSchema(schema({ status: 'draft' }))).toBe(false)
    expect(canForkSchema(schema({ status: 'archived' }))).toBe(false)
  })

  it('makes only a draft publishable', () => {
    expect(canPublishSchema(schema({ status: 'draft' }))).toBe(true)
    expect(canPublishSchema(schema({ status: 'active' }))).toBe(false)
  })

  it('keeps drafts in the default list but not archived versions', () => {
    expect(isCurrentSchema(schema({ status: 'active' }))).toBe(true)
    // An unfinished draft has to stay reachable -- opening it is the only way to finish it.
    expect(isCurrentSchema(schema({ status: 'draft' }))).toBe(true)
    expect(isCurrentSchema(schema({ status: 'archived' }))).toBe(false)
  })
})

describe('schemaVersion — draftFor', () => {
  const v1 = schema({ schema_uuid: 'v1' })
  const draft = schema({ schema_uuid: 'v2', version: 2, status: 'draft', parent_schema_id: 'v1' })

  it('finds the open draft hanging off a schema', () => {
    expect(draftFor([v1, draft], v1)).toBe(draft)
  })

  it('ignores a published successor — only an OPEN draft blocks a new fork', () => {
    const published = { ...draft, status: 'active' }
    expect(draftFor([v1, published], v1)).toBeNull()
  })

  it('returns null rather than throwing when there is nothing to look at', () => {
    expect(draftFor([], v1)).toBeNull()
    expect(draftFor(null, v1)).toBeNull()
    expect(draftFor([v1], null)).toBeNull()
  })
})

describe('schemaVersion — lineageOf', () => {
  const v1 = schema({ schema_uuid: 'a', schema_name: 'S', version: 1, status: 'archived' })
  const v2 = schema({ schema_uuid: 'b', schema_name: 'S_v2', version: 2, status: 'archived', parent_schema_id: 'a' })
  const v3 = schema({ schema_uuid: 'c', schema_name: 'S_v3', version: 3, status: 'active', parent_schema_id: 'b' })
  const unrelated = schema({ schema_uuid: 'z', schema_name: 'Other' })

  it('returns the whole chain oldest first, from any member of it', () => {
    const all = [v3, unrelated, v1, v2]
    expect(lineageOf(all, v3).map(s => s.schema_uuid)).toEqual(['a', 'b', 'c'])
    expect(lineageOf(all, v1).map(s => s.schema_uuid)).toEqual(['a', 'b', 'c'])
    expect(lineageOf(all, v2).map(s => s.schema_uuid)).toEqual(['a', 'b', 'c'])
  })

  it('excludes unrelated schemas even when their names look similar', () => {
    // Walks parent_schema_id, not the name -- a discarded draft can push a version onto a
    // disambiguated name, so the name is a convenience and the edge is the constraint.
    const lookalike = schema({ schema_uuid: 'y', schema_name: 'S_v9' })
    expect(lineageOf([v1, v2, v3, lookalike], v3).map(s => s.schema_uuid)).toEqual(['a', 'b', 'c'])
  })

  it('returns just the schema itself when it has no lineage', () => {
    expect(lineageOf([unrelated], unrelated)).toEqual([unrelated])
  })

  it('terminates on a cyclic parent edge instead of hanging the render', () => {
    // Unreachable in the database (a CHECK forbids self-parenting and the guard freezes the
    // column), but an infinite loop in a render path is not left to reasoning alone.
    const p = schema({ schema_uuid: 'p', parent_schema_id: 'q' })
    const q = schema({ schema_uuid: 'q', parent_schema_id: 'p' })
    const chain = lineageOf([p, q], p)
    expect(chain.length).toBeLessThanOrEqual(2)
  })

  it('handles a schema that is not in the list at all', () => {
    expect(lineageOf([v1], unrelated)).toEqual([unrelated])
    expect(lineageOf([], null)).toEqual([])
  })
})
