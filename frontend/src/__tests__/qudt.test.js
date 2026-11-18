import { describe, it, expect } from 'vitest'
import {
  QUDT_LABEL, QUDT_VERSION, QUDT_KIND_NAMESPACE, QUDT_PRIMARY_FOR, QUDT_ATTRIBUTION,
  quantityKinds, kindByIri, kindLocalName, qudtSections, kindTooltip, qudtHandover
} from '../utils/qudt'
import {
  semanticIdCandidates, candidatesFor, searchSemanticIdCandidates, foreignConcept
} from '../utils/semanticIdSources'
import { STANDARDS } from '../utils/standards'

const id = (name) => QUDT_KIND_NAMESPACE + name
const KINDS = [
  { semantic_id: id('Temperature'), name: 'Temperature', description: 'Temperature is a physical property of matter that quantitatively expresses hot and cold.' },
  { semantic_id: id('VolumeFlowRate'), name: 'Volume Flow Rate', description: 'Volume flow rate is the volume of fluid that passes per unit time.' },
  { semantic_id: id('Volume'), name: 'Volume', description: null },
  { semantic_id: id('CartesianVolume'), name: 'Volume', description: 'A second kind with the same label.' },
  { semantic_id: id('2DPosition'), name: '2D Position', description: null },
  { semantic_id: id('Pressure'), name: 'pressure', description: 'Pressure, in lower case.' }
]

describe('QUDT quantity kinds', () => {
  it('says which QUDT it is, and credits QUDT.org', () => {
    expect(QUDT_LABEL).toBe('QUDT')
    expect(QUDT_VERSION).toBe('3.5.2')
    expect(QUDT_ATTRIBUTION).toBe('Quantity kinds from QUDT 3.5.2, by QUDT.org, under')
  })

  it('is not one of the standards a metric is filed under', () => {
    expect(Object.values(STANDARDS)).not.toContain(QUDT_LABEL)
  })

  it('orders kinds by label and then by id, so two kinds with one label keep a place', () => {
    expect(quantityKinds(KINDS).map(k => kindLocalName(k))).toEqual(
      ['2DPosition', 'Pressure', 'Temperature', 'CartesianVolume', 'Volume', 'VolumeFlowRate']
    )
    expect(quantityKinds(null)).toEqual([])
  })

  it('finds a kind by its id, and a local name by what follows the namespace', () => {
    expect(kindByIri(KINDS, id('Temperature')).name).toBe('Temperature')
    expect(kindByIri(KINDS, id('Nothing'))).toBeNull()
    expect(kindByIri(KINDS, '')).toBeNull()
    expect(kindLocalName(KINDS[1])).toBe('VolumeFlowRate')
  })

  it('files kinds under their first letter, upper-cased, and a label that begins otherwise under #', () => {
    const sections = qudtSections(KINDS)
    expect(sections.map(s => [s.title, s.entries.length])).toEqual([['P', 1], ['T', 1], ['V', 3], ['#', 1]])
    expect(sections.map(s => s.key)).toEqual(['qudt:P', 'qudt:T', 'qudt:V', 'qudt:#'])
  })

  it('tells a kind by its label and the start of QUDT\'s description, and a kind with none by its label alone', () => {
    expect(kindTooltip(KINDS[0])).toBe(`Temperature — ${KINDS[0].description}`)
    expect(kindTooltip(KINDS[2])).toBe('Volume')
    expect(kindTooltip(null)).toBe('')
  })

  it('cuts a long description after 35 words', () => {
    const words = Array.from({ length: 60 }, (_, i) => `w${i + 1}`)
    const tip = kindTooltip({ name: 'Long', description: words.join(' ') })
    expect(tip).toBe(`Long — ${words.slice(0, 35).join(' ')}…`)
  })

  it('hands a click on to Add Metric as a Custom metric with the kind as its own IRI', () => {
    expect(qudtHandover(KINDS[1])).toEqual({ standard: '', semanticId: id('VolumeFlowRate'), semanticIdType: 'IRI' })
    expect(qudtHandover(null)).toBeNull()
    expect(qudtHandover({ name: 'No id' })).toBeNull()
  })
})

describe('QUDT quantity kinds in the semantic id picker', () => {
  const OTHERS = {
    mtconnect: [{ kind: 'DATA_ITEM_TYPE', name: 'TEMPERATURE', category: 'SAMPLE' }],
    opcua: [{ name: 'Temperature', companion_spec: 'OPC 40001', semantic_id: 'nsu=http://opcfoundation.org/UA/Machinery/;i=1' }]
  }
  const candidates = semanticIdCandidates({ ...OTHERS, quantityKinds: KINDS })
  const qudt = candidates.filter(c => c.standard === QUDT_LABEL)

  it('offers every kind as a candidate typed IRI, carrying the standards it may be a metric\'s own id under', () => {
    expect(qudt).toHaveLength(KINDS.length)
    expect(qudt.every(c => c.semanticIdType === 'IRI')).toBe(true)
    expect(qudt.every(c => c.primaryFor === QUDT_PRIMARY_FOR)).toBe(true)
    expect(qudt.find(c => c.semanticId === id('Temperature')).detail).toMatch(/^Temperature — Temperature is a physical property/)
  })

  it('offers none unless some are given', () => {
    expect(semanticIdCandidates(OTHERS).some(c => c.standard === QUDT_LABEL)).toBe(false)
  })

  it('is a metric\'s own id only under ASHRAE 223P and Custom', () => {
    expect([...QUDT_PRIMARY_FOR].sort()).toEqual([STANDARDS.CUSTOM, STANDARDS.ASHRAE223].sort())
    const offered = (standard) => candidatesFor(candidates, { subject: 'metric', standard }).filter(c => c.standard === QUDT_LABEL).length
    expect(offered(STANDARDS.ASHRAE223)).toBe(KINDS.length)
    expect(offered(STANDARDS.CUSTOM)).toBe(KINDS.length)
    expect(offered('')).toBe(KINDS.length)
    expect(offered(STANDARDS.MTCONNECT)).toBe(0)
    expect(offered(STANDARDS.OPCUA)).toBe(0)
    expect(offered(STANDARDS.ISO22400)).toBe(0)
    expect(offered(STANDARDS.VDA5050)).toBe(0)
  })

  it('is a further id for any metric', () => {
    for (const standard of [STANDARDS.MTCONNECT, STANDARDS.OPCUA, STANDARDS.ASHRAE223, STANDARDS.CUSTOM]) {
      const offered = candidatesFor(candidates, { subject: 'further', standard })
      expect(offered).toBe(candidates)
    }
  })

  it('leaves every other candidate alone, whatever the standard', () => {
    const others = candidates.filter(c => c.standard !== QUDT_LABEL)
    for (const standard of [STANDARDS.MTCONNECT, STANDARDS.CUSTOM, STANDARDS.ASHRAE223]) {
      expect(candidatesFor(candidates, { subject: 'metric', standard }).filter(c => c.standard !== QUDT_LABEL)).toEqual(others)
    }
  })

  it('is no id for a schema, which names a Submodel', () => {
    expect(candidatesFor(candidates, { subject: 'schema', standard: '' }).some(c => c.standard === QUDT_LABEL)).toBe(false)
  })

  it('finds a kind by a word of its label or of its description', () => {
    const own = candidatesFor(candidates, { subject: 'metric', standard: STANDARDS.CUSTOM })
    expect(searchSemanticIdCandidates(own, 'flow rate').matches.map(c => c.label)).toEqual(['Volume Flow Rate'])
    expect(searchSemanticIdCandidates(own, 'hot and cold').matches.map(c => c.label)).toEqual(['Temperature'])
  })

  it('does not call a kind foreign to the standards it may be an id under, and does to the others', () => {
    expect(foreignConcept(candidates, id('Temperature'), STANDARDS.MTCONNECT)?.standard).toBe(QUDT_LABEL)
    expect(foreignConcept(candidates, id('Temperature'), STANDARDS.OPCUA)?.standard).toBe(QUDT_LABEL)
    expect(foreignConcept(candidates, id('Temperature'), STANDARDS.ASHRAE223)).toBeNull()
    expect(foreignConcept(candidates, id('Temperature'), STANDARDS.CUSTOM)).toBeNull()
  })

  it('stays responsive with every kind QUDT 3.5.2 does not deprecate beside the other vocabularies', () => {
    const kinds = Array.from({ length: 1126 }, (_, i) => ({
      semantic_id: id(`Kind${i}`),
      name: `Quantity kind number ${i} of temperature and flow`,
      description: `Description ${i}: how a reading of kind ${i} is defined by QUDT, in a sentence or two of plain text.`
    }))
    const many = semanticIdCandidates({
      mtconnect: Array.from({ length: 249 }, (_, i) => ({ kind: 'DATA_ITEM_TYPE', name: `TYPE_${i}`, category: 'SAMPLE' })),
      opcua: Array.from({ length: 1500 }, (_, i) => ({ name: `Point${i}`, companion_spec: 'OPC 40001', semantic_id: `nsu=x;i=${i}` })),
      quantityKinds: kinds
    })
    const started = performance.now()
    for (const query of ['t', 'temperature', 'flow rate', 'kind 9', 'zzz', 'description of kind 1']) {
      searchSemanticIdCandidates(candidatesFor(many, { subject: 'metric', standard: '' }), query)
    }
    const perSearch = (performance.now() - started) / 6
    // A keystroke, with nearly three thousand candidates; a generous bound that a slow runner meets.
    expect(perSearch).toBeLessThan(100)
  })
})
