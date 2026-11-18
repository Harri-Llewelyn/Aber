import { describe, it, expect } from 'vitest'
import {
  VDA5050_GROUP, fieldByName, fieldByType, fieldTooltip, fieldType, fields, vda5050Prefill, vda5050Sections
} from '../utils/vda5050'
import { STANDARDS, STANDARD_OPTIONS, VDA5050_SEMANTIC_NAMESPACE } from '../utils/standards'
import { semanticIdCandidates, suggestionForMetric } from '../utils/semanticIdSources'

/** A slice of vda5050_vocabulary: one field of each shape, under different parts of the message. */
const ID = (path) => `https://aber.local/semantics/vda5050/v3.0/State/${path}`
const VOCABULARY = [
  { name: 'powerSupply.stateOfCharge', datatype: 'Double', unit: null, description: 'State of Charge in %.', permitted_values: null, semantic_id: ID('powerSupply.stateOfCharge') },
  { name: 'driving', datatype: 'Boolean', unit: null, description: 'True: the mobile robot is driving.', permitted_values: null, semantic_id: ID('driving') },
  { name: 'operatingMode', datatype: 'String', unit: null, description: 'Current operating mode of the mobile robot.', permitted_values: ['STARTUP', 'AUTOMATIC', 'MANUAL'], semantic_id: ID('operatingMode') },
  { name: 'velocity.vx', datatype: 'Double', unit: 'm/s', description: 'The velocity in its x direction', permitted_values: null, semantic_id: ID('velocity.vx') },
  { name: 'mobileRobotPosition.x', datatype: 'Double', unit: 'm', description: null, permitted_values: null, semantic_id: ID('mobileRobotPosition.x') },
  { name: 'safetyState.fieldViolation', datatype: 'Boolean', unit: null, description: 'Protective field violation.', permitted_values: null, semantic_id: ID('safetyState.fieldViolation') }
]

describe('a VDA 5050 field, as the dashboard reads it', () => {
  it('is named by the group AGV and its path with slashes, the one thing a name cannot hold being a dot', () => {
    expect(VDA5050_GROUP).toBe('AGV')
    expect(fieldType(VOCABULARY[0])).toBe('powerSupply/stateOfCharge')
    expect(fieldType(VOCABULARY[1])).toBe('driving')
    for (const field of VOCABULARY) expect(fieldType(field)).toMatch(/^[A-Za-z0-9_]+(\/[A-Za-z0-9_]+)*$/)
  })

  it('is found by its path, and by the part of a name it stands for', () => {
    expect(fieldByName(VOCABULARY, 'velocity.vx').datatype).toBe('Double')
    expect(fieldByType(VOCABULARY, 'velocity/vx').name).toBe('velocity.vx')
    expect(fieldByType(VOCABULARY, 'velocity.vx')).toBeNull()
    expect(fieldByName(VOCABULARY, 'nope')).toBeNull()
    expect(fieldByName(VOCABULARY, '')).toBeNull()
  })

  it('is ordered by path', () => {
    expect(fields(VOCABULARY).map(f => f.name)).toEqual([
      'driving', 'mobileRobotPosition.x', 'operatingMode', 'powerSupply.stateOfCharge', 'safetyState.fieldViolation', 'velocity.vx'
    ])
  })

  it('sorts into the sections of the vehicle state, the readings under no object first', () => {
    const sections = vda5050Sections(VOCABULARY)
    expect(sections.map(s => [s.title, s.entries.map(e => e.name)])).toEqual([
      ['Vehicle state', ['driving', 'operatingMode']],
      ['Power supply', ['powerSupply.stateOfCharge']],
      ['Velocity', ['velocity.vx']],
      ['Position', ['mobileRobotPosition.x']],
      ['Safety', ['safetyState.fieldViolation']]
    ])
    expect(new Set(sections.map(s => s.key)).size).toBe(sections.length)
    expect(sections[0].hint).toMatch(/calls the vehicle a mobile robot/)
  })

  it('gives a part of the message nobody has named a section of its own', () => {
    const sections = vda5050Sections([...VOCABULARY, { name: 'future.thing', datatype: 'String', semantic_id: ID('future.thing') }])
    expect(sections.at(-1)).toMatchObject({ title: 'future', entries: [{ name: 'future.thing' }] })
  })

  it('says its path, the schema\'s description and then its unit in a tooltip', () => {
    expect(fieldTooltip(VOCABULARY[3])).toBe('velocity.vx — The velocity in its x direction (m/s)')
    expect(fieldTooltip(VOCABULARY[4])).toBe('mobileRobotPosition.x (m)')
    expect(fieldTooltip(VOCABULARY[1])).toBe('driving — True: the mobile robot is driving.')
    expect(fieldTooltip(null)).toBe('')
  })
})

describe('what a field fills into Add Metric', () => {
  it('is the group, the name, the datatype, the category, the id, the description and an enum\'s values', () => {
    expect(vda5050Prefill(VOCABULARY[2])).toEqual({
      group: 'AGV',
      type: 'operatingMode',
      units: '',
      datatype: 12,
      category: 'EVENT',
      semanticId: ID('operatingMode'),
      standard: 'VDA 5050',
      description: 'Current operating mode of the mobile robot.',
      permittedValues: 'STARTUP, AUTOMATIC, MANUAL'
    })
  })

  it('types a number as a Double and a measured one as a SAMPLE, a flag as a Boolean EVENT', () => {
    expect(vda5050Prefill(VOCABULARY[0])).toMatchObject({ type: 'powerSupply/stateOfCharge', datatype: 10, category: 'SAMPLE', permittedValues: '' })
    expect(vda5050Prefill(VOCABULARY[1])).toMatchObject({ datatype: 11, category: 'EVENT' })
  })

  it('leaves the unit to the operator: the schema writes m/s, a unit here is an MTConnect name', () => {
    expect(vda5050Prefill(VOCABULARY[3]).units).toBe('')
  })

  it('reads an integer as a Double, which is what the form offers', () => {
    expect(vda5050Prefill({ name: 'count', datatype: 'Int64', semantic_id: ID('count') }).datatype).toBe(10)
  })

  it('fills nothing for no field', () => {
    expect(vda5050Prefill(null)).toBeNull()
  })
})

describe('VDA 5050 among the standards', () => {
  it('is a standard the form offers, before Custom, and says what the VDA calls the vehicle', () => {
    expect(STANDARDS.VDA5050).toBe('VDA 5050')
    const values = STANDARD_OPTIONS.map(o => o.value)
    expect(values.indexOf(STANDARDS.VDA5050)).toBe(values.indexOf(STANDARDS.CUSTOM) - 1)
    expect(STANDARD_OPTIONS.find(o => o.value === STANDARDS.VDA5050).hint).toMatch(/calls the vehicle a mobile robot/)
  })

  it('mints its ids under aber.local, pinned to the major line', () => {
    expect(VDA5050_SEMANTIC_NAMESPACE).toBe('https://aber.local/semantics/vda5050/v3.0')
    expect(ID('driving').startsWith(VDA5050_SEMANTIC_NAMESPACE + '/State/')).toBe(true)
  })

  it('is offered by the semantic id picker, each field by its id', () => {
    const candidates = semanticIdCandidates({ vda5050: VOCABULARY })
    expect(candidates).toHaveLength(VOCABULARY.length)
    expect(candidates.find(c => c.label === 'driving')).toMatchObject({
      standard: 'VDA 5050', semanticId: ID('driving'), semanticIdType: 'IRI'
    })
  })

  it('suggests a metric its field\'s id, found by the end of its name', () => {
    const suggested = (name) => suggestionForMetric({ name, standard: 'VDA 5050' }, { vda5050: VOCABULARY })
    expect(suggested('AGV/driving').semanticId).toBe(ID('driving'))
    expect(suggested('AGV/powerSupply/stateOfCharge').semanticId).toBe(ID('powerSupply.stateOfCharge'))
    // A name that carries an instance between the group and the path.
    expect(suggested('AGV/Truck1/velocity/vx').semanticId).toBe(ID('velocity.vx'))
    expect(suggested('AGV/Truck1/somethingElse')).toBeNull()
    expect(suggestionForMetric({ name: 'AGV/driving', standard: null }, { vda5050: VOCABULARY })).toBeNull()
  })
})
