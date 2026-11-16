import { describe, it, expect } from 'vitest'
import {
  modelledMetrics, unmodelledMetrics, hasUnmodelledMetrics,
  deviceTagList, deviceFindings, deviceHasTag, availableTags, UNMODELLED_TAG, OUT_OF_VOCABULARY_TAG
} from '../utils/deviceTags'

const builderSchema = {
  schema_uuid: 'schema-1',
  schema_name: 'Six-Axis-Robot-Arm-Standard',
  schema_definition: {
    type: 'object',
    properties: { 'Axes/C/ANGLE': { type: 'number' }, 'Axes/X/POSITION': { type: 'boolean' } },
    required: ['Axes/C/ANGLE', 'Axes/X/POSITION']
  }
}

const device = (overrides = {}) => ({
  asset_id: 'dev-uuid',
  submodel_schema_ids: ['schema-1'],
  last_birth_metrics: ['Axes/C/ANGLE', 'Axes/X/POSITION'],
  ...overrides
})

describe('modelledMetrics', () => {
  it('reads the builder-produced { properties, required } shape', () => {
    expect([...modelledMetrics(builderSchema)].sort())
      .toEqual(['Axes/C/ANGLE', 'Axes/X/POSITION'])
  })

  it('unions properties and required, so a hand-written schema using only one is read correctly', () => {
    const schema = {
      schema_definition: { properties: { a: { type: 'number' } }, required: ['b'] }
    }
    expect([...modelledMetrics(schema)].sort()).toEqual(['a', 'b'])
  })

  it('returns null when the definition carries neither key', () => {
    // "Cannot be evaluated", which is not the same answer as "models nothing".
    expect(modelledMetrics({ schema_definition: { type: 'object', $ref: '#/defs/x' } })).toBeNull()
    expect(modelledMetrics({ schema_definition: {} })).toBeNull()
    expect(modelledMetrics(null)).toBeNull()
  })
})

describe('unmodelledMetrics', () => {
  it('is empty for a conforming device', () => {
    expect(unmodelledMetrics(device(), builderSchema)).toEqual([])
  })

  it('returns only the metrics the schema does not account for', () => {
    const d = device({
      last_birth_metrics: ['Axes/C/ANGLE', 'Environmental/HUMIDITY_RELATIVE', 'Axes/X/POSITION']
    })
    expect(unmodelledMetrics(d, builderSchema)).toEqual(['Environmental/HUMIDITY_RELATIVE'])
  })

  it('does not care that the device is missing a modelled metric', () => {
    // Under-reporting is the Config modal's "Missing" state, not an unmodelled metric.
    const d = device({ last_birth_metrics: ['Axes/C/ANGLE'] })
    expect(unmodelledMetrics(d, builderSchema)).toEqual([])
  })

  it('is empty when the device has never been seen', () => {
    expect(unmodelledMetrics(device({ last_birth_metrics: null }), builderSchema)).toEqual([])
    expect(unmodelledMetrics(device({ last_birth_metrics: [] }), builderSchema)).toEqual([])
  })

  it('is empty when the device has no schema assigned', () => {
    // "Publishes beyond its model" and "has no model" are different findings; flagging the
    // latter would light up every unschematised device until the tag meant nothing.
    const d = device({ submodel_schema_ids: [], last_birth_metrics: ['anything'] })
    expect(unmodelledMetrics(d, null)).toEqual([])
  })

  it('is empty when the schema cannot be evaluated', () => {
    const opaque = { schema_uuid: 'schema-1', schema_definition: { type: 'object' } }
    expect(unmodelledMetrics(device({ last_birth_metrics: ['anything'] }), opaque)).toEqual([])
  })

  it('clears as soon as the schema is edited to cover the metric, with no new birth', () => {
    // The acceptance test for deriving rather than storing the verdict.
    const d = device({ last_birth_metrics: ['Axes/C/ANGLE', 'Environmental/HUMIDITY_RELATIVE'] })
    expect(hasUnmodelledMetrics(d, builderSchema)).toBe(true)

    const widened = {
      ...builderSchema,
      schema_definition: {
        ...builderSchema.schema_definition,
        properties: {
          ...builderSchema.schema_definition.properties,
          'Environmental/HUMIDITY_RELATIVE': { type: 'number' }
        }
      }
    }
    expect(hasUnmodelledMetrics(d, widened)).toBe(false)
  })
})

describe('deviceTagList', () => {
  it('is the distinct groups of the metrics the schema models', () => {
    expect(deviceTagList(device(), builderSchema)).toEqual(['Axes'])
  })

  it('gives a device several groups from a single schema', () => {
    // One schema is enough for a device to have several groups.
    const mixed = {
      schema_definition: {
        properties: { 'Axes/C/ANGLE': {}, 'Environmental/HUMIDITY_RELATIVE': {}, 'Axes/X/POSITION': {} }
      }
    }
    expect(deviceTagList(device(), mixed)).toEqual(['Axes', 'Environmental'])
  })

  it('ignores ungrouped metrics — a flat name confers no group', () => {
    const flat = { schema_definition: { properties: { temperature: {}, 'Axes/C/ANGLE': {} } } }
    expect(deviceTagList(device(), flat)).toEqual(['Axes'])
  })

  it('gives a provisioned device its groups before its first birth', () => {
    // Drawn from the schema, not from observation, so a device can be found by its metric groups while
    // you are still waiting for it to appear.
    expect(deviceTagList(device({ last_birth_metrics: null }), builderSchema)).toEqual(['Axes'])
  })

  it('is empty without a schema, or with one that cannot be evaluated', () => {
    expect(deviceTagList(device(), null)).toEqual([])
    expect(deviceTagList(device(), { schema_definition: { type: 'object' } })).toEqual([])
  })
})

describe('deviceTagList: the groups only', () => {
  it('leaves a device publishing beyond its schema with its groups alone', () => {
    // Unmodelled is a finding, not a metric group: it is deviceFindings()'s, so the Metric groups
    // filter and column never offer it.
    const d = device({ last_birth_metrics: ['Axes/C/ANGLE', 'Environmental/HUMIDITY_RELATIVE'] })
    expect(deviceTagList(d, builderSchema)).toEqual(['Axes'])
  })

  it('does not let an unmodelled metric confer its own group', () => {
    // Otherwise publishing Environmental/HUMIDITY_RELATIVE outside the schema would quietly
    // make it an Environmental device, legitimising the drift instead of surfacing it.
    const d = device({ last_birth_metrics: ['Axes/C/ANGLE', 'Environmental/HUMIDITY_RELATIVE'] })
    expect(deviceTagList(d, builderSchema)).not.toContain('Environmental')
  })
})

describe('deviceFindings', () => {
  const CATALOG = [{ name: 'Axes/C/ANGLE', permitted_values: ['0', '90'] }]

  it('is empty for a device that conforms and reports legal values', () => {
    expect(deviceFindings(device(), builderSchema, { 'Axes/C/ANGLE': '90' }, CATALOG)).toEqual([])
  })

  it('names Unmodelled with the metrics the last birth declared outside the schemas', () => {
    const d = device({ last_birth_metrics: ['Axes/C/ANGLE', 'Environmental/HUMIDITY_RELATIVE', 'Zed'] })
    expect(deviceFindings(d, builderSchema)).toEqual([
      { tag: UNMODELLED_TAG, metrics: [{ name: 'Environmental/HUMIDITY_RELATIVE' }, { name: 'Zed' }] }
    ])
  })

  it('names Out of vocabulary with each metric, its value and what is permitted', () => {
    const found = deviceFindings(device(), builderSchema, { 'Axes/C/ANGLE': '45' }, CATALOG)
    expect(found).toEqual([
      { tag: OUT_OF_VOCABULARY_TAG, metrics: [{ name: 'Axes/C/ANGLE', value: '45', permitted: ['0', '90'] }] }
    ])
  })

  it('lists both, Unmodelled first, when a device has both', () => {
    const d = device({ last_birth_metrics: ['Axes/C/ANGLE', 'Zed'] })
    expect(deviceFindings(d, builderSchema, { 'Axes/C/ANGLE': '45' }, CATALOG).map(f => f.tag))
      .toEqual([UNMODELLED_TAG, OUT_OF_VOCABULARY_TAG])
  })

  it('leaves Out of vocabulary out, rather than clean, when no telemetry was loaded', () => {
    expect(deviceFindings(device(), builderSchema)).toEqual([])
    expect(deviceFindings(device(), builderSchema, null, CATALOG)).toEqual([])
  })

  it('clears Unmodelled the moment the schema models the metric, with no new birth', () => {
    const d = device({ last_birth_metrics: ['Axes/C/ANGLE', 'Zed'] })
    const widened = {
      ...builderSchema,
      schema_definition: { properties: { ...builderSchema.schema_definition.properties, Zed: {} } }
    }
    expect(deviceFindings(d, builderSchema)).toHaveLength(1)
    expect(deviceFindings(d, widened)).toEqual([])
  })
})

describe('deviceHasTag', () => {
  it('matches a metric group, and never a finding', () => {
    const d = device({ last_birth_metrics: ['Axes/C/ANGLE', 'Environmental/HUMIDITY_RELATIVE'] })
    expect(deviceHasTag(d, builderSchema, 'Axes')).toBe(true)
    expect(deviceHasTag(d, builderSchema, UNMODELLED_TAG)).toBe(false)
    expect(deviceHasTag(d, builderSchema, 'Environmental')).toBe(false)
  })

  it('treats an empty tag as "no filter", so every device passes', () => {
    expect(deviceHasTag(device(), builderSchema, '')).toBe(true)
    expect(deviceHasTag(device(), null, null)).toBe(true)
  })
})

describe('availableTags', () => {
  const schemas = [builderSchema]

  it('collects every metric group across the fleet, deduplicated', () => {
    const fleet = [device({ asset_id: 'a' }), device({ asset_id: 'b' })]
    expect(availableTags(fleet, schemas)).toEqual(['Axes'])
  })

  it('offers groups only: a device with a finding adds no entry', () => {
    const drifting = device({ last_birth_metrics: ['Axes/C/ANGLE', 'Environmental/HUMIDITY_RELATIVE'] })
    expect(availableTags([device(), drifting], schemas)).toEqual(['Axes'])
  })

  it('sorts the groups regardless of case', () => {
    const mixed = {
      schema_uuid: 'schema-2',
      schema_definition: { properties: { 'oee/A': {}, 'Controller/B': {}, 'Axes/C': {} } }
    }
    expect(availableTags([device({ submodel_schema_ids: ['schema-2'] })], [mixed])).toEqual(['Axes', 'Controller', 'oee'])
  })

  it('is empty for an unschematised fleet, so the filter can be disabled', () => {
    expect(availableTags([device({ submodel_schema_ids: [] })], schemas)).toEqual([])
    expect(availableTags([], schemas)).toEqual([])
    expect(availableTags(null, null)).toEqual([])
  })
})
