import { describe, it, expect } from 'vitest'
import {
  dataItemTypes, subTypes, unitNames, categoryOfType, typesByCategory,
  vocabularySections, adoptedVocabulary, CATEGORY_WITH_UNITS
} from '../utils/mtconnect'
import { deriveMetricGroup, composeMetricName } from '../utils/metricGroup'

// A slice of what mtconnect_vocabulary actually holds once 0002_seed_data.sql has run.
const vocabulary = [
  { kind: 'DATA_ITEM_TYPE', name: 'ANGULAR_VELOCITY', category: 'SAMPLE' },
  { kind: 'DATA_ITEM_TYPE', name: 'TEMPERATURE', category: 'SAMPLE' },
  { kind: 'DATA_ITEM_TYPE', name: 'EXECUTION', category: 'EVENT' },
  { kind: 'DATA_ITEM_TYPE', name: 'AVAILABILITY', category: 'EVENT' },
  { kind: 'DATA_ITEM_TYPE', name: 'SYSTEM', category: 'CONDITION' },
  { kind: 'SUB_TYPE', name: 'ACTUAL', category: null },
  { kind: 'SUB_TYPE', name: 'COMMANDED', category: null },
  { kind: 'UNIT', name: 'CELSIUS', category: null },
  { kind: 'UNIT', name: 'DEGREE/SECOND', category: null },
  { kind: 'NATIVE_UNIT', name: 'FAHRENHEIT', category: null },
  { kind: 'COMPONENT', name: 'Axes', category: null },
  { kind: 'COMPONENT', name: 'Controller', category: null }
]

describe('vocabulary selectors', () => {
  it('separates the kinds', () => {
    expect(dataItemTypes(vocabulary)).toHaveLength(5)
    expect(subTypes(vocabulary)).toEqual(['ACTUAL', 'COMMANDED'])
  })

  it('offers native units after preferred ones, since a device may report either', () => {
    expect(unitNames(vocabulary)).toEqual(['CELSIUS', 'DEGREE/SECOND', 'FAHRENHEIT'])
  })

  it('copes with a missing vocabulary rather than throwing before it loads', () => {
    expect(dataItemTypes(null)).toEqual([])
    expect(unitNames(undefined)).toEqual([])
    expect(subTypes(null)).toEqual([])
  })
})

describe('categoryOfType', () => {
  it('derives the category from the standard rather than asking the operator', () => {
    expect(categoryOfType(vocabulary, 'ANGULAR_VELOCITY')).toBe('SAMPLE')
    expect(categoryOfType(vocabulary, 'EXECUTION')).toBe('EVENT')
    expect(categoryOfType(vocabulary, 'SYSTEM')).toBe('CONDITION')
  })

  it('is null for a local extension or no selection', () => {
    expect(categoryOfType(vocabulary, 'VIBRATION_RMS')).toBeNull()
    expect(categoryOfType(vocabulary, '')).toBeNull()
  })

  it('only SAMPLE carries units', () => {
    // MTConnect defines units on continuously-varying measurements only; an EVENT has none.
    expect(categoryOfType(vocabulary, 'TEMPERATURE')).toBe(CATEGORY_WITH_UNITS)
    expect(categoryOfType(vocabulary, 'AVAILABILITY')).not.toBe(CATEGORY_WITH_UNITS)
  })
})

describe('typesByCategory', () => {
  it('puts SAMPLE first and sorts within each category', () => {
    const groups = typesByCategory(vocabulary)
    expect(groups.map(g => g.category)).toEqual(['SAMPLE', 'EVENT', 'CONDITION'])
    expect(groups[0].types).toEqual(['ANGULAR_VELOCITY', 'TEMPERATURE'])
    expect(groups[1].types).toEqual(['AVAILABILITY', 'EXECUTION'])
  })

  it('omits categories with no types', () => {
    const groups = typesByCategory([{ kind: 'DATA_ITEM_TYPE', name: 'TEMPERATURE', category: 'SAMPLE' }])
    expect(groups.map(g => g.category)).toEqual(['SAMPLE'])
  })
})

describe('vocabularySections', () => {
  it('splits data item types by category and keeps the other kinds whole', () => {
    const sections = vocabularySections(vocabulary)
    expect(sections.map(s => s.title)).toEqual([
      'Data Item Types — SAMPLE',
      'Data Item Types — EVENT',
      'Data Item Types — CONDITION',
      'Components',
      'Sub Types',
      'Units',
      'Native Units'
    ])
  })

  it('sorts names within a section', () => {
    const components = vocabularySections(vocabulary).find(s => s.title === 'Components')
    expect(components.names).toEqual(['Axes', 'Controller'])
  })

  it('omits sections with nothing in them', () => {
    const sections = vocabularySections([{ kind: 'COMPONENT', name: 'Axes', category: null }])
    expect(sections.map(s => s.title)).toEqual(['Components'])
  })

  it('gives every section a stable unique key for collapse state', () => {
    const keys = vocabularySections(vocabulary).map(s => s.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('survives an empty vocabulary, so the panel renders before the fetch lands', () => {
    expect(vocabularySections([])).toEqual([])
    expect(vocabularySections(null)).toEqual([])
  })
})

describe('adoptedVocabulary', () => {
  const catalog = [{ name: 'Axes/DISPLACEMENT' }, { name: 'Controller/EXECUTION' }, { name: 'SERIAL_NUMBER' }]

  it('marks both the component and the data item type of a composed name', () => {
    const adopted = adoptedVocabulary(catalog)
    expect(adopted.has('Axes')).toBe(true)
    expect(adopted.has('DISPLACEMENT')).toBe(true)
    expect(adopted.has('Controller')).toBe(true)
    expect(adopted.has('EXECUTION')).toBe(true)
  })

  it('handles an ungrouped name', () => {
    expect(adoptedVocabulary(catalog).has('SERIAL_NUMBER')).toBe(true)
  })

  it('does not mark anything the catalog never mentions', () => {
    expect(adoptedVocabulary(catalog).has('TEMPERATURE')).toBe(false)
  })

  it('is empty for an empty or missing catalog', () => {
    expect(adoptedVocabulary([]).size).toBe(0)
    expect(adoptedVocabulary(null).size).toBe(0)
  })
})

describe('composing an MTConnect metric name', () => {
  // Exercised through composeMetricName, the single composer every standard shares. The part
  // order (component, instance, type, subType) is MTConnect's and is spelled out by the caller.
  const compose = ({ component, instance, type, subType } = {}) =>
    composeMetricName(component, instance, type, subType)

  it('builds a fully-qualified name from component, instance, type and subType', () => {
    expect(compose({
      component: 'Axes', instance: 'C', type: 'ANGULAR_VELOCITY', subType: 'ACTUAL'
    })).toBe('Axes/C/ANGULAR_VELOCITY/ACTUAL')
  })

  it('omits the parts that were left blank', () => {
    expect(compose({ component: 'Environmental', type: 'HUMIDITY_RELATIVE' }))
      .toBe('Environmental/HUMIDITY_RELATIVE')
    expect(compose({ type: 'TEMPERATURE' })).toBe('TEMPERATURE')
    expect(compose({ component: 'Axes', instance: 'C', type: 'ANGLE' }))
      .toBe('Axes/C/ANGLE')
  })

  it('carries the subType in the name, not only in its column', () => {
    // Sparkplug keys on the metric name alone, so ACTUAL and COMMANDED readings of the same type
    // would collide on metric_catalog's UNIQUE(name) if the subType lived only in a column.
    const actual = compose({ component: 'Axes', type: 'ANGLE', subType: 'ACTUAL' })
    const commanded = compose({ component: 'Axes', type: 'ANGLE', subType: 'COMMANDED' })
    expect(actual).not.toBe(commanded)
  })

  it('trims each part and never emits an empty segment', () => {
    const composed = compose({ component: ' Axes ', instance: '  ', type: ' ANGLE ' })
    expect(composed).toBe('Axes/ANGLE')
    expect(composed).not.toContain('//')
  })

  it('composes a name whose group derives back to the chosen component', () => {
    // The invariant tying this to the generated column: what the operator picked as the component
    // is what the database will store as metric_group.
    const composed = compose({ component: 'Controller', instance: 'Path', type: 'EXECUTION' })
    expect(deriveMetricGroup(composed)).toBe('Controller')
  })

  it('is empty when nothing has been chosen', () => {
    expect(compose({})).toBe('')
  })
})
