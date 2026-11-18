import { describe, it, expect } from 'vitest'
import { strToU8 } from 'fflate'
import { readConceptDescriptionsFile, conceptDescriptionsOf, parseEnvironment, AasFileRefusal, MAX_FILE_BYTES } from '../utils/aasReader'
import {
  jsonConcept, jsonEnvironment, xmlConcept, xmlEnvironment, aasxPackage, fileOf
} from './aasFixtures'

const OEE = 'https://example.com/kpi/OEE'
const SCRAP = 'https://example.com/kpi/ScrapRatio'
const IRDI = '0173-1#02-AAO677#002'

const jsonText = (cds) => JSON.stringify(jsonEnvironment(cds))

const refusal = async (promise) => {
  const error = await promise.then(() => null, (e) => e)
  expect(error).toBeInstanceOf(AasFileRefusal)
  return error.reason
}

describe('the AAS reader: ConceptDescriptions', () => {
  it('reads an AAS JSON environment', async () => {
    const file = fileOf(jsonText([
      jsonConcept(OEE, 'Overall equipment effectiveness', 'How much of the planned time made good parts.', { unit: '%', dataType: 'REAL_MEASURE', version: '2', revision: '1' }),
      jsonConcept(IRDI, 'Temperature', 'A temperature.', { unitId: '0173-1#05-AAA123#003' })
    ]), 'kpis.json')
    const read = await readConceptDescriptionsFile(file)
    expect(read.format).toBe('aas-json')
    expect(read.fileName).toBe('kpis.json')
    expect(read.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(read.total).toBe(2)
    expect(read.concepts).toEqual([
      {
        semantic_id: OEE, semantic_id_type: 'IRI', preferred_name: 'Overall equipment effectiveness',
        definition: 'How much of the planned time made good parts.', unit: '%', unit_id: null, data_type: 'REAL_MEASURE'
      },
      {
        semantic_id: IRDI, semantic_id_type: 'IRDI', preferred_name: 'Temperature',
        definition: 'A temperature.', unit: null, unit_id: '0173-1#05-AAA123#003', data_type: null
      }
    ])
    // One of the two states a version, so the file states one.
    expect(read.version).toBe('2.1')
  })

  it('reads an AAS XML environment and reads it as the JSON one', async () => {
    const extra = { unit: '%', dataType: 'REAL_MEASURE', version: '2', revision: '1' }
    const fromXml = await readConceptDescriptionsFile(fileOf(xmlEnvironment([
      xmlConcept(OEE, 'Overall equipment effectiveness', 'How much of the planned time made good parts & more.', extra),
      xmlConcept(IRDI, 'Temperature', 'A temperature.', { unitId: '0173-1#05-AAA123#003' })
    ]), 'kpis.xml'))
    const fromJson = await readConceptDescriptionsFile(fileOf(jsonText([
      jsonConcept(OEE, 'Overall equipment effectiveness', 'How much of the planned time made good parts & more.', extra),
      jsonConcept(IRDI, 'Temperature', 'A temperature.', { unitId: '0173-1#05-AAA123#003' })
    ]), 'kpis.json'))
    expect(fromXml.format).toBe('aas-xml')
    expect(fromXml.concepts).toEqual(fromJson.concepts)
    expect(fromXml.version).toBe('2.1')
  })

  it('reads an AASX package through its origin\'s aas-spec relationship', async () => {
    const bytes = aasxPackage({ 'aasx/aas/environment.aas.json': jsonText([jsonConcept(OEE, 'OEE', 'Definition.')]) })
    const read = await readConceptDescriptionsFile(fileOf(bytes, 'site.aasx'))
    expect(read.format).toBe('aasx')
    expect(read.concepts.map(c => c.semantic_id)).toEqual([OEE])
  })

  it('reads an AASX package whose environment is XML, and follows a relative target', async () => {
    const bytes = aasxPackage(
      { 'aasx/aas/environment.aas.xml': xmlEnvironment([xmlConcept(OEE, 'OEE', 'Definition.')]) },
      { specs: ['aas/environment.aas.xml'] }
    )
    // The target is relative to the origin's folder: /aasx/aas/environment.aas.xml.
    const read = await readConceptDescriptionsFile(fileOf(bytes, 'site.aasx'))
    expect(read.concepts.map(c => c.semantic_id)).toEqual([OEE])
  })

  it('takes the English name and definition, else the first language', () => {
    const english = jsonConcept(OEE, 'x', 'Definition.', { languages: [['de', 'Gesamtanlageneffektivität'], ['en-GB', 'Overall equipment effectiveness']] })
    const german = jsonConcept(SCRAP, 'x', 'Definition.', { languages: [['de', 'Ausschussquote'], ['fr', 'Taux de rebut']] })
    const { concepts } = conceptDescriptionsOf(jsonEnvironment([english, german]))
    expect(concepts.map(c => c.preferred_name)).toEqual(['Overall equipment effectiveness', 'Ausschussquote'])
  })

  it('counts a ConceptDescription with no IEC 61360 content, and skips it', async () => {
    const read = await readConceptDescriptionsFile(fileOf(jsonText([
      jsonConcept(OEE, 'OEE', 'Definition.'),
      jsonConcept(SCRAP, 'Scrap', 'Definition.', { withoutContent: true })
    ]), 'mixed.json'))
    expect(read.total).toBe(2)
    expect(read.concepts).toHaveLength(1)
    expect(read.noIec61360).toBe(1)
  })

  it('reports an id stated twice once, and keeps the first', () => {
    const read = conceptDescriptionsOf(jsonEnvironment([
      jsonConcept(OEE, 'First', 'One.'),
      jsonConcept(SCRAP, 'Scrap', 'Two.'),
      jsonConcept(OEE, 'Second', 'Three.')
    ]))
    expect(read.concepts.map(c => c.preferred_name)).toEqual(['First', 'Scrap'])
    expect(read.repeated).toEqual([OEE])
  })

  it('skips a concept the table would refuse, with the reason', () => {
    const read = conceptDescriptionsOf(jsonEnvironment([
      jsonConcept('just a word', 'Name', 'Definition.'),
      jsonConcept(' https://example.com/padded ', 'Name', 'Definition.'),
      jsonConcept('https://example.com/long', 'N'.repeat(256), 'Definition.'),
      jsonConcept('https://example.com/nameless', '', 'Definition.', { languages: [] }),
      jsonConcept('https://example.com/fine', 'Fine', 'Definition.')
    ]))
    expect(read.concepts.map(c => c.semantic_id)).toEqual(['https://example.com/fine'])
    expect(read.unusable.map(u => u.reason)).toEqual([
      'its id is not an IRI, an IRDI or an ExpandedNodeId',
      'its id has a space or a line break at either end',
      'its preferred name is longer than 255 characters',
      'it has no preferred name'
    ])
  })

  it('states no version when the file states two', () => {
    const read = conceptDescriptionsOf(jsonEnvironment([
      jsonConcept(OEE, 'A', 'x', { version: '1' }),
      jsonConcept(SCRAP, 'B', 'x', { version: '2' })
    ]))
    expect(read.version).toBeNull()
  })

  it('refuses a file over 25 MB before it opens it', async () => {
    const big = { name: 'big.json', size: MAX_FILE_BYTES + 1, arrayBuffer: () => { throw new Error('opened') } }
    expect(await refusal(readConceptDescriptionsFile(big))).toMatch(/at most 25 MB/)
  })

  it('refuses an XML environment with a document type, before parsing it', async () => {
    const bomb = xmlEnvironment([xmlConcept(OEE, 'OEE', 'Definition.')], {
      prolog: '<!DOCTYPE environment [<!ENTITY x "expanded">]>'
    })
    expect(await refusal(readConceptDescriptionsFile(fileOf(bomb, 'bomb.xml')))).toMatch(/`<!DOCTYPE`/)
  })

  it('refuses a V2 file and says so', async () => {
    const v2 = { assets: [], assetAdministrationShells: [], conceptDescriptions: [{ identification: { id: OEE, idType: 'IRI' } }] }
    expect(await refusal(readConceptDescriptionsFile(fileOf(JSON.stringify(v2), 'v2.json')))).toMatch(/AAS V2/)
    const xml = '<aasenv xmlns="http://www.admin-shell.io/aas/2/0"></aasenv>'
    expect(await refusal(readConceptDescriptionsFile(fileOf(xml, 'v2.xml')))).toMatch(/AAS V2/)
  })

  it('refuses what is not an AAS environment', async () => {
    expect(await refusal(readConceptDescriptionsFile(fileOf('plain text', 'a.txt')))).toMatch(/neither an AASX package/)
    expect(await refusal(readConceptDescriptionsFile(fileOf('{"a": 1}', 'a.json')))).toMatch(/not an AAS environment/)
    expect(await refusal(readConceptDescriptionsFile(fileOf('{ nope', 'a.json')))).toMatch(/not valid/)
    expect(await refusal(readConceptDescriptionsFile(fileOf('<a><b></a>', 'a.xml')))).toMatch(/not well formed/)
    expect(await refusal(readConceptDescriptionsFile(fileOf('<other/>', 'a.xml')))).toMatch(/not an AAS environment/)
    expect(await refusal(readConceptDescriptionsFile(fileOf(new Uint8Array(0), 'a.json')))).toMatch(/empty/)
  })

  it('reads a UTF-8 file with a byte-order mark', async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...strToU8(jsonText([jsonConcept(OEE, 'OEE', 'Definition.')]))])
    const read = await readConceptDescriptionsFile(fileOf(bytes, 'bom.json'))
    expect(read.concepts).toHaveLength(1)
  })

  it('parses an environment into the JSON shape for any extractor to read', () => {
    const { format, environment } = parseEnvironment(strToU8(xmlEnvironment([xmlConcept(OEE, 'OEE', 'Definition.')])))
    expect(format).toBe('aas-xml')
    const [cd] = environment.conceptDescriptions
    expect(cd.modelType).toBe('ConceptDescription')
    expect(cd.embeddedDataSpecifications[0].dataSpecificationContent.modelType).toBe('DataSpecificationIec61360')
    expect(cd.embeddedDataSpecifications[0].dataSpecification.keys[0].type).toBe('GlobalReference')
  })
})
