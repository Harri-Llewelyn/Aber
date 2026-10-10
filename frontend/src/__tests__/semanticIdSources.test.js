import { describe, it, expect } from 'vitest'
import {
  mtconnectSuggestion, vocabularySuggestion, suggestionForMetric, semanticIdCandidates,
  searchSemanticIdCandidates, foreignConcept, templateSource
} from '../utils/semanticIdSources'

const MTCONNECT = [
  { kind: 'DATA_ITEM_TYPE', name: 'POSITION', category: 'SAMPLE' },
  { kind: 'COMPONENT', name: 'Axes', category: null }
]
const ISO22400 = [
  { name: 'AVAILABILITY', category: 'OEE', semantic_id: 'https://aber.local/semantics/iso22400/AVAILABILITY' }
]
// Two companion specifications define `Manufacturer`; the group each is filed under tells them apart.
const OPCUA = [
  {
    name: 'Manufacturer', companion_spec: 'OPC 40001 Machinery',
    node_id: 'nsu=http://opcfoundation.org/UA/Machinery/;i=6002',
    semantic_id: 'nsu=http://opcfoundation.org/UA/Machinery/;i=6002'
  },
  {
    name: 'Manufacturer', companion_spec: 'OPC 40540 Additive Manufacturing',
    node_id: 'nsu=http://opcfoundation.org/UA/AdditiveManufacturing/;i=6011',
    semantic_id: 'nsu=http://opcfoundation.org/UA/AdditiveManufacturing/;i=6011'
  }
]
const ASHRAE223 = [
  { name: 'Fan', concept_kind: 'Class', label: 'Fan', subclass_of: 'Equipment', semantic_id: 'http://data.ashrae.org/standard223#Fan' },
  { name: 'hasProperty', concept_kind: 'Relation', label: 'has property', semantic_id: 'http://data.ashrae.org/standard223#hasProperty' }
]
const TEMPLATES = [
  {
    template_id: 'https://admin-shell.io/idta/nameplate/3/0/Nameplate', template_name: 'Digital Nameplate',
    template_version: '3.0', id_short: 'ManufacturerName', semantic_id: '0112/2///61987#ABA565#009',
    semantic_id_type: 'IRDI', description: 'Legal name of the manufacturer.'
  }
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

  it('takes the row id for ISO 22400', () => {
    expect(suggested({ name: 'OEE/Line1/AVAILABILITY', standard: 'ISO 22400' }))
      .toBe('https://aber.local/semantics/iso22400/AVAILABILITY')
  })

  it('suggests no 223P class: 223P is a reference, and a class names equipment, not a reading', () => {
    expect(suggested({ name: 'BMS/Fan', standard: 'ASHRAE 223P' })).toBeNull()
    expect(suggested({ name: 'BMS/AHU1/Fan', metric_group: 'BMS', standard: 'ASHRAE 223P' })).toBeNull()
  })

  it('tells OPC UA points with one browse name apart by the group', () => {
    expect(suggested({ name: 'Machine/Manufacturer', standard: 'OPC UA' }))
      .toBe('nsu=http://opcfoundation.org/UA/Machinery/;i=6002')
    expect(suggested({ name: 'Feedstock/Manufacturer', metric_group: 'Feedstock', standard: 'OPC UA' }))
      .toBe('nsu=http://opcfoundation.org/UA/AdditiveManufacturing/;i=6011')
    // No group to choose by, and two ids: no suggestion rather than a guess.
    expect(suggested({ name: 'Manufacturer', standard: 'OPC UA' })).toBeNull()
  })

  it('mints nothing for a local extension', () => {
    expect(suggested({ name: 'Hydraulic/VIBRATION_RMS', standard: null })).toBeNull()
    expect(suggested({ name: 'POSITION', standard: '' })).toBeNull()
  })
})

describe('semanticIdCandidates', () => {
  const candidates = semanticIdCandidates({ ...VOCABULARIES, templates: TEMPLATES })
  const byLabel = (label) => candidates.filter(c => c.label === label)

  it('offers data item types but not the other MTConnect kinds', () => {
    expect(byLabel('POSITION')).toEqual([expect.objectContaining({
      standard: 'MTConnect', semanticIdType: 'IRI',
      semanticId: 'https://aber.local/semantics/mtconnect/v2.0/DataItemType/POSITION'
    })])
    expect(byLabel('Axes')).toEqual([])
  })

  it('keeps both OPC UA points that share a browse name, told apart by their spec', () => {
    expect(byLabel('Manufacturer').map(c => c.detail).sort()).toEqual(['OPC 40001 Machinery', 'OPC 40540 Additive Manufacturing'])
  })

  it('takes a template element\'s recorded reference type and lists it under its template', () => {
    expect(byLabel('ManufacturerName')).toEqual([expect.objectContaining({
      standard: 'IDTA Digital Nameplate 3.0', semanticId: '0112/2///61987#ABA565#009', semanticIdType: 'IRDI'
    })])
    expect(templateSource(TEMPLATES[0])).toBe('IDTA Digital Nameplate 3.0')
  })

  it('offers no 223P concept, class or relation, though given the vocabulary', () => {
    expect(byLabel('Fan')).toEqual([])
    expect(byLabel('has property')).toEqual([])
    expect(candidates.filter(c => c.standard === 'ASHRAE 223P')).toEqual([])
  })
})

describe('searchSemanticIdCandidates', () => {
  const candidates = semanticIdCandidates({ ...VOCABULARIES, templates: TEMPLATES })

  it('finds nothing without a query', () => {
    expect(searchSemanticIdCandidates(candidates, '  ')).toEqual({ matches: [], total: 0 })
  })

  it('ranks an exact label first, then a prefix, then a match in the id or detail', () => {
    const { matches } = searchSemanticIdCandidates(candidates, 'manufacturer')
    expect(matches.map(c => c.label)).toEqual(['Manufacturer', 'Manufacturer', 'ManufacturerName'])
    // "legal" is only in the nameplate element's description.
    expect(searchSemanticIdCandidates(candidates, 'legal').matches.map(c => c.label)).toEqual(['ManufacturerName'])
  })

  it('puts the subject\'s own standard first among equals', () => {
    const { matches } = searchSemanticIdCandidates(candidates, 'manufacturer', { standard: 'OPC UA' })
    expect(matches[0].standard).toBe('OPC UA')
  })

  it('needs every word, and caps the list while counting the rest', () => {
    expect(searchSemanticIdCandidates(candidates, 'manufacturer additive').matches.map(c => c.detail))
      .toEqual(['OPC 40540 Additive Manufacturing'])
    const capped = searchSemanticIdCandidates(candidates, 'http', { limit: 2 })
    expect(capped.matches).toHaveLength(2)
    expect(capped.total).toBeGreaterThan(2)
  })
})

describe('foreignConcept', () => {
  const candidates = semanticIdCandidates({ ...VOCABULARIES, templates: TEMPLATES })

  it('names the source of an id another standard holds', () => {
    expect(foreignConcept(candidates, '0112/2///61987#ABA565#009', 'MTConnect').label).toBe('ManufacturerName')
  })

  it('is silent for the own standard\'s id, an unknown id, and a subject with no standard', () => {
    const position = 'https://aber.local/semantics/mtconnect/v2.0/DataItemType/POSITION'
    expect(foreignConcept(candidates, position, 'MTConnect')).toBeNull()
    expect(foreignConcept(candidates, 'urn:example:x', 'MTConnect')).toBeNull()
    expect(foreignConcept(candidates, position, '')).toBeNull()
  })
})
