import { describe, it, expect } from 'vitest'
import { suggestMatches } from '../utils/quarantineMatching'
import { schemaIdsForDevice, schemasForDevice } from '../utils/deviceTags'

/**
 * A quarantined device is matched to a pre-created one by its reported metrics against the
 * candidate's schemas. A candidate's schemas are every one attached to it, by either path: the
 * `device_schemas` view (`submodel_schema_ids`) and the deprecated `schema_id` column.
 */

const schema = (id, required) => ({
  schema_uuid: id,
  schema_name: id,
  schema_definition: { type: 'object', required }
})

const SCHEMAS = [
  schema('sch-spindle', ['Spindle/SPEED', 'Spindle/LOAD']),
  schema('sch-energy', ['Energy/KWH', 'Energy/KW', 'Energy/PF']),
]

// Never seen: no first birth, not quarantined, not archived.
const candidate = (overrides = {}) => ({
  asset_id: 'dev-1',
  asset_name: 'Lathe 7',
  schema_id: null,
  submodel_schema_ids: [],
  ...overrides
})

const quarantined = (reported_metrics, asset_name = 'unrelated label') => ({ asset_name, reported_metrics })

describe('schemaIdsForDevice', () => {
  it('unions the view and the column, without repeats', () => {
    expect(schemaIdsForDevice({ schema_id: 'a', submodel_schema_ids: ['b', 'a'] })).toEqual(['b', 'a'])
    expect(schemaIdsForDevice({ schema_id: 'a', submodel_schema_ids: ['b'] })).toEqual(['b', 'a'])
  })

  it('reads either path alone, and nothing as an empty list', () => {
    expect(schemaIdsForDevice({ schema_id: 'a' })).toEqual(['a'])
    expect(schemaIdsForDevice({ schema_id: null, submodel_schema_ids: ['b'] })).toEqual(['b'])
    expect(schemaIdsForDevice({ schema_id: null, submodel_schema_ids: [] })).toEqual([])
    expect(schemaIdsForDevice(null)).toEqual([])
  })

  it('resolves to schema rows, dropping an id with no row', () => {
    const device = { schema_id: 'sch-spindle', submodel_schema_ids: ['sch-energy', 'sch-gone'] }
    expect(schemasForDevice(device, SCHEMAS).map(s => s.schema_uuid)).toEqual(['sch-energy', 'sch-spindle'])
  })
})

describe('suggestMatches', () => {
  it('scores a candidate attached only through device_submodels by its schema', () => {
    // The 1.0 fault: candidate.schema_id alone was read, so this matched on its name only.
    const [match] = suggestMatches(
      quarantined(['Spindle/SPEED', 'Spindle/LOAD']),
      [candidate({ submodel_schema_ids: ['sch-spindle'] })],
      SCHEMAS
    )
    expect(match.candidateId).toBe('dev-1')
    expect(match.overlap).toMatchObject({ present: 2, total: 2 })
    expect(match.score).toBe(1)
  })

  it('still scores a candidate attached only through schema_id', () => {
    const [match] = suggestMatches(
      quarantined(['Spindle/SPEED', 'Spindle/LOAD']),
      [candidate({ schema_id: 'sch-spindle' })],
      SCHEMAS
    )
    expect(match.overlap).toMatchObject({ present: 2, total: 2 })
  })

  it('takes the best of several schemas, whichever path attached it', () => {
    // The energy schema matches fully; the spindle schema from the column does not match at all.
    const [match] = suggestMatches(
      quarantined(['Energy/KWH', 'Energy/KW', 'Energy/PF']),
      [candidate({ schema_id: 'sch-spindle', submodel_schema_ids: ['sch-spindle', 'sch-energy'] })],
      SCHEMAS
    )
    expect(match.overlap).toMatchObject({ present: 3, total: 3 })
    expect(match.evidence).toMatch(/^3\/3 required metrics present/)
  })

  it('falls back to the name when no schema overlaps', () => {
    const [match] = suggestMatches(
      quarantined(['Other/METRIC'], 'Lathe 7'),
      [candidate({ submodel_schema_ids: ['sch-spindle', 'sch-energy'] })],
      SCHEMAS
    )
    expect(match.evidence).toMatch(/name match$/)
    expect(match.score).toBeLessThanOrEqual(0.5)
  })

  it('suggests nothing for a candidate with neither overlap nor a similar name', () => {
    expect(suggestMatches(
      quarantined(['Other/METRIC'], 'zzzz'),
      [candidate({ submodel_schema_ids: ['sch-spindle'] })],
      SCHEMAS
    )).toEqual([])
  })
})
