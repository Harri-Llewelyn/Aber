import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  fillableElements, requiredTemplatePaths, templateElementFill, templateList, templateProblems
} from '../utils/idtaTemplates'

/**
 * Which element of a template each metric fills, and which the template requires: the rule the database
 * writes with schema_template_elements() and template_required_paths() (0342). The cases are
 * test-harness/fixtures/schema-template-elements.json, which the db lane gives the same answers to.
 */
const FIXTURE = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'test-harness', 'fixtures', 'schema-template-elements.json'), 'utf8'))
const { template_id: ID } = FIXTURE.template
const TITLE = `${FIXTURE.template.template_name} ${FIXTURE.template.template_version}`
const ELEMENTS = FIXTURE.elements.map(e => ({ ...FIXTURE.template, ...e }))
// As api.js reads the catalogue: each further id an object.
const CATALOG = FIXTURE.catalog.map(m => ({
  name: m.name, semantic_id: m.semantic_id, further_semantic_ids: m.further.map(id => ({ semantic_id: id, semantic_id_type: 'IRI' }))
}))
const metrics = (names) => names.map(n => CATALOG.find(m => m.name === n))

describe('the element each metric of a schema fills', () => {
  for (const c of FIXTURE.cases) {
    it(c.key, () => {
      const filled = templateElementFill(ELEMENTS, ID, metrics(c.metrics))
      expect(filled).toEqual(c.filled)
      const said = templateProblems({ templateId: ID, title: TITLE, semanticId: ID, required: requiredTemplatePaths(ELEMENTS, ID), filled })
      expect(said).toEqual(c.missing.length === 0 ? [] : [
        `No metric here fills ${c.missing.join(', ')}, which ${TITLE} requires. A metric fills an element when the element's semantic id is the metric's own or one of its further ids.`
      ])
    })
  }

  it('reads a further id given as text too', () => {
    expect(templateElementFill(ELEMENTS, ID, [{ name: 'X', semantic_id: 'urn:x', further_semantic_ids: ['urn:aber:fixture:0342:label'] }]))
      .toEqual({ X: { path: 'Label', semantic_id: 'urn:aber:fixture:0342:label' } })
  })

  it('fills nothing of another template', () => {
    expect(templateElementFill(ELEMENTS, 'https://example.com/other', metrics(['Fixture_0342/NAME']))).toEqual({})
  })
})

describe('what a template requires', () => {
  it('is the fixture\'s: one or more, inside nothing that may be left out, and a value goes in it', () => {
    expect(requiredTemplatePaths(ELEMENTS, ID)).toEqual(FIXTURE.required)
  })

  it('offers only the elements a value goes in, in the template\'s order', () => {
    expect(fillableElements([...ELEMENTS].reverse(), ID).map(e => e.path))
      .toEqual(['Name', 'Label', 'Serial', 'Address.Street', 'Markings[0].MarkingName', 'Count', 'SerialAgain'])
  })
})

describe('why a version built from a template may not be saved', () => {
  it('names a template the rows do not hold', () => {
    expect(templateProblems({ templateId: 'https://example.com/none', title: null }))
      .toEqual(["https://example.com/none is not a template Aber holds. Choose one on the Vocabulary page's Templates tab."])
  })

  it('says a semantic id that is not the template\'s first, then what is missing', () => {
    const said = templateProblems({ templateId: ID, title: TITLE, semanticId: 'urn:else', required: ['Name'], filled: {} })
    expect(said).toEqual([
      `A schema built from ${TITLE} carries the template's id as its semantic id: ${ID}.`,
      `No metric here fills Name, which ${TITLE} requires. A metric fills an element when the element's semantic id is the metric's own or one of its further ids.`
    ])
  })

  it('lists each template once, with its title', () => {
    expect(templateList(ELEMENTS)).toEqual([{ id: ID, name: 'Fixture Template', number: 'FIXTURE 0342', version: '1.0.0', title: TITLE }])
  })
})
