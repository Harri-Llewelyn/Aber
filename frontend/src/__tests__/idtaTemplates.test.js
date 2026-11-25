import { describe, it, expect } from 'vitest'
import {
  CARDINALITY_LABELS, cardinalityLabel, elementDepth, elementKey, elementName, elementTooltip, elementType, templateSections
} from '../utils/idtaTemplates'

/** A slice of idta_template_elements: two templates, out of order, with an idShort that repeats. */
const template = (id, name, number, version) => ({ template_id: id, template_name: name, template_number: number, template_version: version })
const NAMEPLATE = template('https://example.test/nameplate', 'Digital Nameplate', 'IDTA 02006', '3.0.3')
const AID = template('https://example.test/aid', 'Asset Interfaces Description', 'IDTA 02017', '1.0.1')
const ELEMENTS = [
  { ...AID, path: 'InterfaceTemplateForMQTT', parent_path: null, ordinal: 1, id_short: 'InterfaceTemplateForMQTT', model_type: 'SubmodelElementCollection' },
  { ...AID, path: 'InterfaceTemplateForMQTT.title', parent_path: 'InterfaceTemplateForMQTT', ordinal: 2, id_short: 'title', model_type: 'Property', value_type: 'xs:string' },
  { ...NAMEPLATE, path: 'Markings[0].MarkingName', parent_path: 'Markings[0]', ordinal: 3, id_short: 'MarkingName', model_type: 'Property', value_type: 'xs:string', cardinality: 'One' },
  { ...NAMEPLATE, path: 'Markings', parent_path: null, ordinal: 1, id_short: 'Markings', model_type: 'SubmodelElementList', value_type: 'SubmodelElementCollection', cardinality: 'ZeroToOne' },
  { ...NAMEPLATE, path: 'Markings[0]', parent_path: 'Markings', ordinal: 2, id_short: null, model_type: 'SubmodelElementCollection', cardinality: 'OneToMany', definition: 'Note: CE marking is mandatory' }
]

describe('a template\'s elements, as the dashboard reads them', () => {
  it('makes one section for each template, by IDTA number, with its elements in the template\'s order', () => {
    const sections = templateSections(ELEMENTS)
    expect(sections.map(s => s.title)).toEqual(['Digital Nameplate 3.0.3', 'Asset Interfaces Description 1.0.1'])
    expect(sections[0].entries.map(e => e.path)).toEqual(['Markings', 'Markings[0]', 'Markings[0].MarkingName'])
    expect(sections[0].hint).toBe('IDTA 02006. 3 elements: 1 at the top, and the rest inside them.')
    expect(sections[1].hint).toMatch(/^IDTA 02017\. 2 elements/)
    expect(new Set(sections.map(s => s.key)).size).toBe(2)
    expect(templateSections(null)).toEqual([])
  })

  it('names an element by the last step of its path, and an item of a list by the list', () => {
    expect(ELEMENTS.map(elementName)).toEqual(['InterfaceTemplateForMQTT', 'title', 'MarkingName', 'Markings', 'Markings[0]'])
  })

  it('counts how many elements an element is inside', () => {
    expect(ELEMENTS.map(elementDepth)).toEqual([0, 1, 2, 0, 1])
    expect(elementDepth({ path: 'A.B[0].C' })).toBe(3)
  })

  it('says a cardinality in words, and that a template gives none', () => {
    expect(Object.keys(CARDINALITY_LABELS)).toEqual(['One', 'ZeroToOne', 'ZeroToMany', 'OneToMany'])
    expect(cardinalityLabel({ cardinality: 'OneToMany' })).toBe('One or more')
    expect(cardinalityLabel({ cardinality: null })).toBe('Not stated')
  })

  it('says a type with the type of its value, where it has one', () => {
    expect(elementType(ELEMENTS[1])).toBe('Property · xs:string')
    expect(elementType(ELEMENTS[0])).toBe('SubmodelElementCollection')
  })

  it('says an element\'s path, and what the template says of it', () => {
    expect(elementTooltip(ELEMENTS[4])).toBe('Markings[0] — Note: CE marking is mandatory')
    expect(elementTooltip(ELEMENTS[3])).toBe('Markings')
    expect(elementTooltip(null)).toBe('')
  })

  it('keys an element by its template and its path, since an idShort repeats', () => {
    const keys = ELEMENTS.map(e => elementKey(e.template_id, e.path))
    expect(new Set(keys).size).toBe(ELEMENTS.length)
  })
})
