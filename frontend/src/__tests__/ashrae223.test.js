import { describe, it, expect } from 'vitest'
import {
  concepts, conceptByName, ashrae223Sections, ashrae223Prefill, conceptTooltip, metricConcepts,
  isMetricConcept, ASHRAE223_GROUP
} from '../utils/ashrae223'
import { STANDARDS } from '../utils/standards'
import { composeMetricName, deriveMetricGroup } from '../utils/metricGroup'

// A slice of what ashrae223_vocabulary holds once its seed has run.
const vocabulary = [
  {
    name: 'Fan', concept_kind: 'Class', label: 'Fan', subclass_of: 'Equipment',
    description: 'A piece of `Equipment` that causes a gas (e.g., air) to flow.',
    semantic_id: 'http://data.ashrae.org/standard223#Fan'
  },
  {
    name: 'Pump', concept_kind: 'Class', label: 'Pump', subclass_of: 'Equipment',
    description: 'A piece of `Equipment` that imparts energy to a fluid.',
    semantic_id: 'http://data.ashrae.org/standard223#Pump'
  },
  {
    name: 'Equipment', concept_kind: 'Class', label: 'Equipment', subclass_of: null,
    description: 'A thing designed to accomplish a specific task.',
    semantic_id: 'http://data.ashrae.org/standard223#Equipment'
  },
  {
    name: 'connectsTo', concept_kind: 'Relation', label: 'connects to', subclass_of: null,
    description: 'Relates two connectable things.',
    semantic_id: 'http://data.ashrae.org/standard223#connectsTo'
  }
]

describe('concepts', () => {
  it('orders by label, which is what a reader scans', () => {
    expect(concepts(vocabulary).map(c => c.name)).toEqual(['connectsTo', 'Equipment', 'Fan', 'Pump'])
  })

  it('tolerates an absent vocabulary', () => {
    expect(concepts(null)).toEqual([])
  })
})

describe('conceptByName', () => {
  it('finds a concept by its local name, the table key', () => {
    expect(conceptByName(vocabulary, 'Fan').semantic_id)
      .toBe('http://data.ashrae.org/standard223#Fan')
  })

  it('returns null rather than guessing', () => {
    expect(conceptByName(vocabulary, 'NotAConcept')).toBeNull()
    expect(conceptByName(vocabulary, '')).toBeNull()
  })
})

describe('isMetricConcept', () => {
  it('is the one rule the picker and the Use action share', () => {
    expect(isMetricConcept(vocabulary[0])).toBe(true)            // Fan, a Class
    expect(isMetricConcept(vocabulary[3])).toBe(false)           // connectsTo, a Relation
    expect(isMetricConcept({ name: 'Concept', concept_kind: 'Concept' })).toBe(true)
    expect(isMetricConcept({ name: 'X', concept_kind: 'AbstractClass' })).toBe(true)
    expect(isMetricConcept(null)).toBe(false)
  })
})

describe('metricConcepts', () => {
  it('keeps the things and drops the relations', () => {
    // `BMS/connectsTo` would name nothing a point can be attached to.
    expect(metricConcepts(vocabulary).map(c => c.name)).toEqual(['Fan', 'Pump', 'Equipment'])
  })

  it('sections cleanly, so the picker has no Root bucket of predicates', () => {
    const sections = ashrae223Sections(metricConcepts(vocabulary))
    expect(sections.find(s => s.title === 'Root').entries.map(e => e.name)).toEqual(['Equipment'])
  })

  it('tolerates an absent vocabulary', () => {
    expect(metricConcepts(null)).toEqual([])
  })
})

describe('ashrae223Sections', () => {
  it('sections by the standard\'s own class hierarchy', () => {
    // 640 concepts under four `concept_kind` headings would not be browsable; "a Fan is Equipment"
    // is the hierarchy an operator already thinks in.
    const sections = ashrae223Sections(vocabulary)
    const equipment = sections.find(s => s.title === 'Equipment')
    expect(equipment.entries.map(e => e.name)).toEqual(['Fan', 'Pump'])
  })

  it('collects top-level concepts under Root, and puts Root last', () => {
    const sections = ashrae223Sections(vocabulary)
    expect(sections[sections.length - 1].title).toBe('Root')
    expect(sections.find(s => s.title === 'Root').entries.map(e => e.name))
      .toEqual(['connectsTo', 'Equipment'])
  })

  it('gives every section a stable unique key for collapse state', () => {
    const keys = ashrae223Sections(vocabulary).map(s => s.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('ashrae223Prefill', () => {
  it('files every concept under the single BMS group', () => {
    // One group, not one per concept: enforce_metric_group_spelling() makes the first spelling
    // permanent, and 223P is not published yet.
    expect(ashrae223Prefill(vocabulary[0]).group).toBe(ASHRAE223_GROUP)
  })

  it('carries the standard and no semantic id, because 223P is a reference here', () => {
    // A class names the equipment, not the reading: `Fan` as the id of a speed reading would tell an
    // AAS consumer the value is a fan.
    const prefill = ashrae223Prefill(vocabulary[0])
    expect(prefill).toMatchObject({ type: 'Fan', standard: STANDARDS.ASHRAE223 })
    expect(prefill).not.toHaveProperty('semanticId')
  })

  it('leaves datatype and category unset, because a concept does not imply either', () => {
    // A `Sensor` may report a temperature, a pressure or a boolean occupancy. Guessing here would
    // put a wrong IMMUTABLE datatype on the metric -- the one field that cannot be corrected.
    const prefill = ashrae223Prefill(vocabulary[0])
    expect(prefill.datatype).toBeUndefined()
    expect(prefill.category).toBeUndefined()
    expect(prefill.units).toBe('')
  })

  it('agrees with the group the composed name will derive', () => {
    const prefill = ashrae223Prefill(vocabulary[0])
    const name = composeMetricName(prefill.group, 'AHU1', prefill.type, '')
    expect(deriveMetricGroup(name)).toBe(ASHRAE223_GROUP)
  })

  it('returns null for nothing', () => {
    expect(ashrae223Prefill(null)).toBeNull()
  })
})

describe('conceptTooltip', () => {
  it('leads with the description and names the parent', () => {
    expect(conceptTooltip(vocabulary[0]))
      .toBe('Fan — A piece of `Equipment` that causes a gas (e.g., air) to flow. · Subclass of Equipment')
  })

  it('falls back to the label alone', () => {
    expect(conceptTooltip({ name: 'X', label: 'X' })).toBe('X')
  })
})
