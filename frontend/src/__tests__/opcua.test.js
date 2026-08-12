import { describe, it, expect } from 'vitest'
import {
  browsePath, namespaceUri, suggestedGroup, sparkplugDatatypeFor, categoryFor,
  dataPoints, dataPointByName, opcuaSections, opcuaPrefill, dataPointTooltip
} from '../utils/opcua'
import { STANDARDS } from '../utils/standards'
import { composeMetricName, deriveMetricGroup } from '../utils/metricGroup'

// A slice of what opcua_vocabulary holds once 0002_seed_data.sql has run.
const vocabulary = [
  {
    name: 'ActualPosition', companion_spec: 'OPC 40010 Robotics',
    node_id: 'nsu=http://opcfoundation.org/UA/Robotics/;s=MotionDevice/Axes/Axis/ActualPosition',
    datatype: 'Double', unit: 'MILLIMETER', description: 'Current position of an axis.',
    semantic_id: 'http://opcfoundation.org/UA/Robotics/ActualPosition'
  },
  {
    name: 'EmergencyStop', companion_spec: 'OPC 40010 Robotics',
    node_id: 'nsu=http://opcfoundation.org/UA/Robotics/;s=MotionDevice/SafetyStates/SafetyState/EmergencyStop',
    datatype: 'Boolean', unit: null, description: 'Emergency stop state.',
    semantic_id: 'http://opcfoundation.org/UA/Robotics/EmergencyStop'
  },
  {
    name: 'Manufacturer', companion_spec: 'OPC 40001 Machinery',
    node_id: 'nsu=http://opcfoundation.org/UA/Machinery/;s=Machine/Identification/Manufacturer',
    datatype: 'LocalizedText', unit: null, description: 'Name of the machine manufacturer.',
    semantic_id: 'http://opcfoundation.org/UA/Machinery/Manufacturer'
  },
  {
    name: 'OperationalTime', companion_spec: 'OPC 40001 Machinery',
    node_id: 'nsu=http://opcfoundation.org/UA/Machinery/;s=Machine/MachineryBuildingBlocks/OperationCounters/OperationalTime',
    datatype: 'Double', unit: 'SECOND', description: 'Accumulated operational time.',
    semantic_id: 'http://opcfoundation.org/UA/Machinery/OperationalTime'
  }
]

describe('ExpandedNodeId parsing', () => {
  it('splits the namespace from the browse path', () => {
    const nodeId = vocabulary[0].node_id
    expect(namespaceUri(nodeId)).toBe('http://opcfoundation.org/UA/Robotics/')
    expect(browsePath(nodeId)).toBe('MotionDevice/Axes/Axis/ActualPosition')
  })

  it('keeps the whole path, including the slashes inside it', () => {
    // The identifier is everything after `s=` -- a greedy match, since a browse path contains the
    // same separator the metric names use.
    expect(browsePath(vocabulary[3].node_id))
      .toBe('Machine/MachineryBuildingBlocks/OperationCounters/OperationalTime')
  })

  it('returns empty rather than throwing on a malformed or absent node id', () => {
    expect(browsePath(null)).toBe('')
    expect(browsePath('')).toBe('')
    expect(browsePath('i=1234')).toBe('')
    expect(namespaceUri('nonsense')).toBe('')
  })
})

describe('suggestedGroup', () => {
  it('takes the first browse path segment, so the group comes from the data not a hardcoded map', () => {
    expect(suggestedGroup(vocabulary[0])).toBe('MotionDevice')
    expect(suggestedGroup(vocabulary[2])).toBe('Machine')
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

  it('suggests nothing when there is no browse path to read', () => {
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

  // The seed carries six companion specifications, and a section with no hint renders as a bare
  // spec number -- readable to whoever added it and to nobody else. This is the cheapest place to
  // notice that a seventh was seeded without one.
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
      node_id: `nsu=http://example.invalid/;s=Thing/Point${i}`,
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
      { name: 'Manufacturer', companion_spec: 'OPC 40010 Robotics', node_id: 'nsu=x;s=MotionDevice/Manufacturer', datatype: 'String' }
    ]
    expect(dataPointByName(shared, 'OPC 40001 Machinery', 'Manufacturer').node_id)
      .toContain('Machine/Identification/Manufacturer')
    expect(dataPointByName(shared, 'OPC 40010 Robotics', 'Manufacturer').node_id)
      .toContain('MotionDevice/Manufacturer')
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
      semanticId: 'http://opcfoundation.org/UA/Robotics/ActualPosition',
      standard: STANDARDS.OPCUA
    })
  })

  it('leaves the instance out — which axis is the part the specification cannot know', () => {
    expect(opcuaPrefill(vocabulary[0])).not.toHaveProperty('instance')
  })

  it('returns null for nothing', () => {
    expect(opcuaPrefill(null)).toBeNull()
  })
})

describe('dataPointTooltip', () => {
  it('shows where the point lives, which is what disambiguates two identical names', () => {
    expect(dataPointTooltip(vocabulary[2])).toContain('Machine/Identification/Manufacturer')
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
