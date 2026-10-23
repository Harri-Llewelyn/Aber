import { describe, it, expect } from 'vitest'
import { suggestMatches } from '../utils/quarantineMatching'
import { schemaIdsForDevice, schemasForDevice } from '../utils/deviceTags'

/**
 * A quarantined device is matched to a pre-created one by its reported metrics against the
 * modelled metrics of the candidate's schemas. A candidate's schemas are every one attached to it,
 * by either path: the `device_schemas` view (`submodel_schema_ids`) and the deprecated `schema_id`
 * column.
 */

// As the builder writes a schema: `properties` only, no `required`.
const schema = (id, names) => ({
  schema_uuid: id,
  schema_name: id,
  schema_definition: {
    type: 'object',
    properties: Object.fromEntries(names.map(name => [name, { type: 'number' }]))
  }
})

const SCHEMAS = [
  schema('sch-spindle', ['Spindle/SPEED', 'Spindle/LOAD']),
  schema('sch-energy', ['Energy/KWH', 'Energy/KW', 'Energy/PF']),
  // Hand-written: a metric named only under `required` is still modelled.
  {
    schema_uuid: 'sch-coolant',
    schema_name: 'sch-coolant',
    schema_definition: { properties: { 'Coolant/LEVEL': {} }, required: ['Coolant/LEVEL', 'Coolant/TEMP'] }
  }
]

// Never seen: no first birth, not quarantined, not archived.
const candidate = (overrides = {}) => ({
  asset_id: 'dev-1',
  asset_name: 'Lathe 7',
  submodel_schema_ids: [],
  ...overrides
})

const quarantined = (reported_metrics, asset_name = 'unrelated label') => ({ asset_name, reported_metrics })

describe('schemaIdsForDevice', () => {
  it('reads the view, without repeats, and nothing as an empty list', () => {
    expect(schemaIdsForDevice({ submodel_schema_ids: ['b', 'a', 'b'] })).toEqual(['b', 'a'])
    expect(schemaIdsForDevice({ submodel_schema_ids: [] })).toEqual([])
    expect(schemaIdsForDevice({})).toEqual([])
    expect(schemaIdsForDevice(null)).toEqual([])
  })

  it('ignores a schema_id on the row, which no longer names an attachment', () => {
    expect(schemaIdsForDevice({ schema_id: 'a', submodel_schema_ids: ['b'] })).toEqual(['b'])
  })

  it('resolves to schema rows, dropping an id with no row', () => {
    const device = { submodel_schema_ids: ['sch-energy', 'sch-gone', 'sch-spindle'] }
    expect(schemasForDevice(device, SCHEMAS).map(s => s.schema_uuid)).toEqual(['sch-energy', 'sch-spindle'])
  })
})

describe('suggestMatches', () => {
  it('scores a candidate attached only through device_submodels by its schema', () => {
    const [match] = suggestMatches(
      quarantined(['Spindle/SPEED', 'Spindle/LOAD']),
      [candidate({ submodel_schema_ids: ['sch-spindle'] })],
      SCHEMAS
    )
    expect(match.candidateId).toBe('dev-1')
    expect(match.overlap).toMatchObject({ present: 2, total: 2 })
    expect(match.score).toBe(1)
  })

  it('takes the best of several schemas', () => {
    // The energy schema matches fully; the spindle schema does not match at all.
    const [match] = suggestMatches(
      quarantined(['Energy/KWH', 'Energy/KW', 'Energy/PF']),
      [candidate({ submodel_schema_ids: ['sch-spindle', 'sch-energy'] })],
      SCHEMAS
    )
    expect(match.overlap).toMatchObject({ present: 3, total: 3 })
    expect(match.evidence).toMatch(/^3\/3 modelled metrics present/)
  })

  it('scores a schema with no required list by the metrics it models', () => {
    const [match] = suggestMatches(
      quarantined(['Spindle/SPEED']),
      [candidate({ submodel_schema_ids: ['sch-spindle'] })],
      SCHEMAS
    )
    expect(match.overlap).toMatchObject({ present: 1, total: 2 })
    expect(match.score).toBe(0.75)
  })

  it('counts a metric named only under required, and does not count it twice', () => {
    const [match] = suggestMatches(
      quarantined(['Coolant/LEVEL', 'Coolant/TEMP']),
      [candidate({ submodel_schema_ids: ['sch-coolant'] })],
      SCHEMAS
    )
    expect(match.overlap).toMatchObject({ present: 2, total: 2 })
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
