import { describe, it, expect } from 'vitest'
import { mtconnectSuggestion, vocabularySuggestion, suggestionForMetric } from '../utils/semanticIdSources'

const MTCONNECT = [
  { kind: 'DATA_ITEM_TYPE', name: 'POSITION', category: 'SAMPLE' },
  { kind: 'COMPONENT', name: 'Axes', category: null }
]
const ISO22400 = [
  { name: 'AVAILABILITY', category: 'OEE', semantic_id: 'https://aber.local/semantics/iso22400/AVAILABILITY' }
]
// Two companion specifications define `Manufacturer`; the first browse-path segment tells them apart.
const OPCUA = [
  {
    name: 'Manufacturer', companion_spec: 'OPC 40001 Machinery',
    node_id: 'nsu=http://opcfoundation.org/UA/Machinery/;s=Machine/Identification/Manufacturer',
    semantic_id: 'http://opcfoundation.org/UA/Machinery/Manufacturer'
  },
  {
    name: 'Manufacturer', companion_spec: 'OPC 40010 Robotics',
    node_id: 'nsu=http://opcfoundation.org/UA/Robotics/;s=MotionDevice/Identification/Manufacturer',
    semantic_id: 'http://opcfoundation.org/UA/Robotics/Manufacturer'
  }
]
const ASHRAE223 = [
  { name: 'Fan', concept_kind: 'Class', semantic_id: 'http://data.ashrae.org/standard223#Fan' }
]
const VOCABULARIES = { mtconnect: MTCONNECT, iso22400: ISO22400, opcua: OPCUA, ashrae223: ASHRAE223 }

const suggested = (metric) => suggestionForMetric(metric, VOCABULARIES)?.semanticId ?? null

describe('mtconnectSuggestion', () => {
  it('is the data item type id, typed IRI, and nothing without a type', () => {
    expect(mtconnectSuggestion('POSITION')).toMatchObject({
      semanticId: 'https://aber.local/semantics/mtconnect/v2.0/DataItemType/POSITION',
      semanticIdType: 'IRI'
    })
    expect(mtconnectSuggestion('')).toBeNull()
  })
})

describe('vocabularySuggestion', () => {
  it('takes the row id and types it by its shape', () => {
    expect(vocabularySuggestion('ISO 22400', 'AVAILABILITY', 'https://x.test/A').semanticIdType).toBe('IRI')
    expect(vocabularySuggestion('ISO 22400', 'AVAILABILITY', '')).toBeNull()
  })
})

describe('suggestionForMetric', () => {
  it('finds an MTConnect type behind the instance, and behind a trailing sub_type', () => {
    const id = 'https://aber.local/semantics/mtconnect/v2.0/DataItemType/POSITION'
    expect(suggested({ name: 'Axes/X/POSITION', standard: 'MTConnect' })).toBe(id)
    expect(suggested({ name: 'Axes/X/POSITION/ACTUAL', sub_type: 'ACTUAL', standard: 'MTConnect' })).toBe(id)
  })

  it('suggests nothing for an MTConnect type the vocabulary does not hold', () => {
    expect(suggested({ name: 'Axes/X/WOBBLE', standard: 'MTConnect' })).toBeNull()
  })

  it('takes the row id for ISO 22400 and ASHRAE 223P', () => {
    expect(suggested({ name: 'OEE/Line1/AVAILABILITY', standard: 'ISO 22400' }))
      .toBe('https://aber.local/semantics/iso22400/AVAILABILITY')
    expect(suggested({ name: 'BMS/Fan', standard: 'ASHRAE 223P' })).toBe('http://data.ashrae.org/standard223#Fan')
  })

  it('tells OPC UA points with one browse name apart by the group', () => {
    expect(suggested({ name: 'Machine/Manufacturer', standard: 'OPC UA' }))
      .toBe('http://opcfoundation.org/UA/Machinery/Manufacturer')
    expect(suggested({ name: 'MotionDevice/Manufacturer', metric_group: 'MotionDevice', standard: 'OPC UA' }))
      .toBe('http://opcfoundation.org/UA/Robotics/Manufacturer')
    // No group to choose by, and two ids: no suggestion rather than a guess.
    expect(suggested({ name: 'Manufacturer', standard: 'OPC UA' })).toBeNull()
  })

  it('mints nothing for a local extension', () => {
    expect(suggested({ name: 'Hydraulic/VIBRATION_RMS', standard: null })).toBeNull()
    expect(suggested({ name: 'POSITION', standard: '' })).toBeNull()
  })
})
