import { describe, it, expect } from 'vitest'
import {
  suggestedGroup, sparkplugDatatypeFor, categoryFor,
  dataPoints, dataPointByName, opcuaSections, opcuaPrefill, dataPointTooltip
} from '../utils/opcua'
import { OPCUA_GROUPS } from '../utils/opcuaGroups.generated'
import { STANDARDS } from '../utils/standards'
import { composeMetricName, deriveMetricGroup } from '../utils/metricGroup'

// A slice of what opcua_vocabulary holds once 0002_seed_data.sql has run.
const vocabulary = [
  {
    name: 'ActualPosition', companion_spec: 'OPC 40010 Robotics',
    node_id: 'nsu=http://opcfoundation.org/UA/Robotics/;i=16662',
    datatype: 'Double', unit: 'MILLIMETER', description: 'Current position of an axis.',
    semantic_id: 'nsu=http://opcfoundation.org/UA/Robotics/;i=16662'
  },
  {
    name: 'EmergencyStop', companion_spec: 'OPC 40010 Robotics',
    node_id: 'nsu=http://opcfoundation.org/UA/Robotics/;i=15882',
    datatype: 'Boolean', unit: null, description: 'Emergency stop state.',
    semantic_id: 'nsu=http://opcfoundation.org/UA/Robotics/;i=15882'
  },
  {
    name: 'Manufacturer', companion_spec: 'OPC 40001 Machinery',
    node_id: 'nsu=http://opcfoundation.org/UA/Machinery/;i=6002',
    datatype: 'LocalizedText', unit: null, description: 'Name of the machine manufacturer.',
    semantic_id: 'nsu=http://opcfoundation.org/UA/Machinery/;i=6002'
  },
  {
    name: 'PowerOnDuration', companion_spec: 'OPC 40001 Machinery',
    node_id: 'nsu=http://opcfoundation.org/UA/Machinery/;i=6079',
    datatype: 'Double', unit: 'MILLISECOND', description: 'Accumulated time the machine has been powered on.',
    semantic_id: 'nsu=http://opcfoundation.org/UA/Machinery/;i=6079'
  }
]

describe('suggestedGroup', () => {
  it('reads the group the generator files the point under', () => {
    expect(suggestedGroup(vocabulary[0])).toBe('MotionDevice')
    expect(suggestedGroup(vocabulary[2])).toBe('Machine')
  })

  it('tells apart a name two specifications share', () => {
    expect(suggestedGroup({ name: 'Manufacturer', companion_spec: 'OPC 40540 Additive Manufacturing' }))
      .toBe('Feedstock')
    expect(suggestedGroup({ name: 'Mass', companion_spec: 'OPC 40001-4 Machinery Energy' })).toBe('Energy')
    expect(suggestedGroup({ name: 'Mass', companion_spec: 'OPC 40010 Robotics' })).toBe('MotionDevice')
  })

  it('files every generated point under a one-segment group', () => {
    for (const [spec, points] of Object.entries(OPCUA_GROUPS)) {
      for (const [name, group] of Object.entries(points)) {
        expect(group, `${spec} ${name}`).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/)
      }
    }
  })

  it('agrees with the group the composed name will actually derive', () => {
    // This is the invariant that matters: the group shown in the picker and the group the SQL
    // generated column derives from the finished name have to be the same string.
    for (const entry of vocabulary) {
      const prefill = opcuaPrefill(entry)
      const name = composeMetricName(prefill.group, 'J1', prefill.type, '')
      expect(deriveMetricGroup(name)).toBe(suggestedGroup(entry))
    }
  })

  it('suggests nothing for a point the generator does not know', () => {
    expect(suggestedGroup({ name: 'OperationalTime', companion_spec: 'OPC 40001 Machinery' })).toBe('')
    expect(suggestedGroup({ node_id: null })).toBe('')
    expect(suggestedGroup(null)).toBe('')
  })
})

describe('sparkplugDatatypeFor', () => {
  it('maps OPC UA numerics onto Double, the only numeric code the form offers', () => {
    for (const t of ['Double', 'Float', 'Int32', 'UInt16', 'Int64', 'Byte', 'SByte']) {
      expect(sparkplugDatatypeFor(t)).toBe(10)
    }
  })

  it('maps Boolean onto Boolean', () => {
    expect(sparkplugDatatypeFor('Boolean')).toBe(11)
  })

  it('falls back to String for text and for anything unrecognised', () => {
    // Lossless is the right failure: a wrong numeric datatype cannot be corrected once a device is
    // configured against the metric, because the name and datatype are immutable.
    expect(sparkplugDatatypeFor('LocalizedText')).toBe(12)
    expect(sparkplugDatatypeFor('String')).toBe(12)
    expect(sparkplugDatatypeFor('SomeStructure')).toBe(12)
    expect(sparkplugDatatypeFor(null)).toBe(12)
  })
})

describe('categoryFor', () => {
  it('calls a continuous number a SAMPLE and a discrete state an EVENT', () => {
    expect(categoryFor('Double')).toBe('SAMPLE')
    expect(categoryFor('Boolean')).toBe('EVENT')
    expect(categoryFor('LocalizedText')).toBe('EVENT')
  })
})

describe('opcuaSections', () => {
  it('groups by companion specification', () => {
    expect(opcuaSections(vocabulary).map(s => s.title))
      .toEqual(['OPC 40001 Machinery', 'OPC 40010 Robotics'])
  })

  it('gives every section a stable unique key for collapse state', () => {
    const keys = opcuaSections(vocabulary).map(s => s.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  // A section with no hint renders as a bare spec number. This is the cheapest place to notice that
  // a seventh specification was seeded without one.
  it('has a hint for every companion specification the seed carries', () => {
    // In the order opcuaSections sorts them, which is lexical on the spec number -- so PackML's
    // 30050 leads, ahead of the 40000-series.
    const seeded = [
      'OPC 30050 PackML',
      'OPC 40001 Machinery',
      'OPC 40001-4 Machinery Energy',
      'OPC 40010 Robotics',
      'OPC 40501 Machine Tools',
      'OPC 40540 Additive Manufacturing'
    ]
    const sections = opcuaSections(seeded.map((companion_spec, i) => ({
      name: `Point${i}`,
      companion_spec,
      node_id: `nsu=http://example.invalid/;i=${i}`,
      datatype: 'Double'
    })))
    expect(sections.map(s => s.title)).toEqual(seeded)
    for (const section of sections) {
      expect(section.hint, `${section.title} has no hint`).toBeTruthy()
    }
  })
})

describe('dataPointByName', () => {
  it('disambiguates a name that appears in more than one companion spec', () => {
    const shared = [
      ...vocabulary,
      { name: 'Manufacturer', companion_spec: 'OPC 40010 Robotics', node_id: 'nsu=http://opcfoundation.org/UA/Robotics/;i=16351', datatype: 'String' }
    ]
    expect(dataPointByName(shared, 'OPC 40001 Machinery', 'Manufacturer').node_id)
      .toBe('nsu=http://opcfoundation.org/UA/Machinery/;i=6002')
    expect(dataPointByName(shared, 'OPC 40010 Robotics', 'Manufacturer').node_id)
      .toBe('nsu=http://opcfoundation.org/UA/Robotics/;i=16351')
  })

  it('falls back to the first match when no spec is given', () => {
    expect(dataPointByName(vocabulary, null, 'ActualPosition').companion_spec).toBe('OPC 40010 Robotics')
  })

  it('returns null for an unknown name', () => {
    expect(dataPointByName(vocabulary, null, 'NotAThing')).toBeNull()
    expect(dataPointByName(vocabulary, null, '')).toBeNull()
  })
})

describe('opcuaPrefill', () => {
  it('carries datatype, category, unit and semantic id off the vocabulary entry', () => {
    const prefill = opcuaPrefill(vocabulary[0])
    expect(prefill).toMatchObject({
      group: 'MotionDevice',
      type: 'ActualPosition',
      units: 'MILLIMETER',
      datatype: 10,
      category: 'SAMPLE',
      semanticId: 'nsu=http://opcfoundation.org/UA/Robotics/;i=16662',
      standard: STANDARDS.OPCUA
    })
  })

  it('leaves the instance out — which axis is the part the specification cannot know', () => {
    expect(opcuaPrefill(vocabulary[0])).not.toHaveProperty('instance')
  })

  it('carries the companion specification, which a browse name two specifications share needs', () => {
    expect(opcuaPrefill(vocabulary[0]).companionSpec).toBe('OPC 40010 Robotics')
  })

  it('returns null for nothing', () => {
    expect(opcuaPrefill(null)).toBeNull()
  })
})

describe('dataPointTooltip', () => {
  it('names the node, which is what disambiguates two identical names', () => {
    expect(dataPointTooltip(vocabulary[2])).toContain('NodeId: nsu=http://opcfoundation.org/UA/Machinery/;i=6002')
  })

  it('degrades to the bare name when there is nothing else to say', () => {
    expect(dataPointTooltip({ name: 'Bare' })).toBe('Bare')
  })
})

describe('dataPoints', () => {
  it('survives an empty or missing vocabulary', () => {
    expect(dataPoints([])).toEqual([])
    expect(dataPoints(null)).toEqual([])
  })
})
