import { describe, it, expect } from 'vitest'
import {
  modelledMetrics, unmodelledMetrics, hasUnmodelledMetrics,
  deviceGroupTags, deviceTagList, deviceHasTag, availableTags, UNMODELLED_TAG
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
  schema_id: 'schema-1',
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
    const d = device({ schema_id: null, last_birth_metrics: ['anything'] })
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

describe('deviceGroupTags', () => {
  it('is the distinct groups of the metrics the schema models', () => {
    expect(deviceGroupTags(device(), builderSchema)).toEqual(['Axes'])
  })

  it('gives a device several tags from a single schema', () => {
    // The reason multiple schemas per device were not needed to support multiple tags.
    const mixed = {
      schema_definition: {
        properties: { 'Axes/C/ANGLE': {}, 'Environmental/HUMIDITY_RELATIVE': {}, 'Axes/X/POSITION': {} }
      }
    }
    expect(deviceGroupTags(device(), mixed)).toEqual(['Axes', 'Environmental'])
  })

  it('ignores ungrouped metrics — a flat name confers no tag', () => {
    const flat = { schema_definition: { properties: { temperature: {}, 'Axes/C/ANGLE': {} } } }
    expect(deviceGroupTags(device(), flat)).toEqual(['Axes'])
  })

  it('tags a provisioned device before its first birth', () => {
    // Drawn from the schema, not from observation, so a device can be found by type while you
    // are still waiting for it to appear.
    expect(deviceGroupTags(device({ last_birth_metrics: null }), builderSchema)).toEqual(['Axes'])
  })

  it('is empty without a schema, or with one that cannot be evaluated', () => {
    expect(deviceGroupTags(device(), null)).toEqual([])
    expect(deviceGroupTags(device(), { schema_definition: { type: 'object' } })).toEqual([])
  })
})

describe('deviceTagList', () => {
  it('appends Unmodelled, last, when the device publishes beyond its schema', () => {
    const d = device({ last_birth_metrics: ['Axes/C/ANGLE', 'Environmental/HUMIDITY_RELATIVE'] })
    expect(deviceTagList(d, builderSchema)).toEqual(['Axes', UNMODELLED_TAG])
  })

  it('omits Unmodelled for a conforming device', () => {
    expect(deviceTagList(device(), builderSchema)).toEqual(['Axes'])
  })

  it('does not let an unmodelled metric confer its own group as a tag', () => {
    // Otherwise publishing Environmental/HUMIDITY_RELATIVE outside the schema would quietly
    // make it an Environmental device, legitimising the drift instead of surfacing it.
    const d = device({ last_birth_metrics: ['Axes/C/ANGLE', 'Environmental/HUMIDITY_RELATIVE'] })
    expect(deviceTagList(d, builderSchema)).not.toContain('Environmental')
  })
})

describe('deviceHasTag', () => {
  it('matches group and Unmodelled tags alike', () => {
    const d = device({ last_birth_metrics: ['Axes/C/ANGLE', 'Environmental/HUMIDITY_RELATIVE'] })
    expect(deviceHasTag(d, builderSchema, 'Axes')).toBe(true)
    expect(deviceHasTag(d, builderSchema, UNMODELLED_TAG)).toBe(true)
    expect(deviceHasTag(d, builderSchema, 'Environmental')).toBe(false)
  })

  it('treats an empty tag as "no filter", so every device passes', () => {
    expect(deviceHasTag(device(), builderSchema, '')).toBe(true)
    expect(deviceHasTag(device(), null, null)).toBe(true)
  })
})

describe('availableTags', () => {
  const schemas = [builderSchema]

  it('collects every tag across the fleet, deduplicated', () => {
    const fleet = [device({ asset_id: 'a' }), device({ asset_id: 'b' })]
    expect(availableTags(fleet, schemas)).toEqual(['Axes'])
  })

  it('offers Unmodelled only when some device actually has it', () => {
    expect(availableTags([device()], schemas)).toEqual(['Axes'])
    const drifting = device({ last_birth_metrics: ['Axes/C/ANGLE', 'Environmental/HUMIDITY_RELATIVE'] })
    expect(availableTags([device(), drifting], schemas)).toEqual(['Axes', UNMODELLED_TAG])
  })

  it('is empty for an unschematised fleet, so the filter can be disabled', () => {
    expect(availableTags([device({ schema_id: null })], schemas)).toEqual([])
    expect(availableTags([], schemas)).toEqual([])
    expect(availableTags(null, null)).toEqual([])
  })
})
