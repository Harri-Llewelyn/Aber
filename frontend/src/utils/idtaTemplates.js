/**
 * The IDTA submodel templates, as served from `idta_template_elements` (migration 0320): one row for each
 * element a template defines, nested ones included, generated from the templates' own JSON. A template
 * says which elements a submodel holds; it is not a standard a metric is named from, so it is not one of
 * `STANDARDS` and starts no metric. The rows are IDTA's, under CC BY 4.0, which asks that IDTA is credited.
 */

// With the extension: scripts/mirror-checks imports this file in Node.
import { plural } from './format.js'

/** The tab's name; its address is the slug of it. */
export const TEMPLATES_LABEL = 'Templates'

export const IDTA_LICENCE_URL = 'https://creativecommons.org/licenses/by/4.0/'

/** What the tab says to credit IDTA; the licence is linked after it. */
export const IDTA_ATTRIBUTION = 'Elements of submodel templates by IDTA, abridged, under'

/** How many of an element its parent holds, in words. check-mirror-drift.mjs holds the keys to the table's CHECK. */
export const CARDINALITY_LABELS = Object.freeze({
  One: 'One',
  ZeroToOne: 'Zero or one',
  ZeroToMany: 'Zero or more',
  OneToMany: 'One or more'
})

/** The words for an element's cardinality. A template need not give one. */
export const cardinalityLabel = (element) => CARDINALITY_LABELS[element?.cardinality] || 'Not stated'

/** The last step of an element's path: its idShort, or the list's with `[0]` for what each item is. */
export const elementName = (element) => {
  const path = element?.path || ''
  return path.slice(path.lastIndexOf('.') + 1)
}

/** How many elements an element is inside, counted from its path: a dot and a `[n]` are a step each. */
export const elementDepth = (element) => (element?.path || '').split('').filter(ch => ch === '.' || ch === '[').length

/** An element's AAS model type, and the type of its value where it has one. */
export const elementType = (element) => [element?.model_type, element?.value_type].filter(Boolean).join(' · ')

/** The key of an element: a path names one element of one template. */
export const elementKey = (templateId, path) => `${templateId} ${path}`

/**
 * One section for each template, by its IDTA number, with its elements in the template's own order, so
 * each element follows the one it is inside.
 */
export function templateSections(elements) {
  const buckets = new Map()
  for (const element of elements || []) {
    if (!buckets.has(element.template_id)) buckets.set(element.template_id, [])
    buckets.get(element.template_id).push(element)
  }
  return [...buckets.values()]
    .map(entries => {
      const { template_id: id, template_name: name, template_number: number, template_version: version } = entries[0]
      const top = entries.filter(e => !e.parent_path).length
      return {
        key: `idta:${id}`,
        title: `${name} ${version}`,
        hint: `${number}. ${plural(entries.length, 'element')}: ${top} at the top, and the rest inside them.`,
        template: { id, name, number, version },
        entries: entries.slice().sort((a, b) => a.ordinal - b.ordinal)
      }
    })
    .sort((a, b) => a.template.number.localeCompare(b.template.number) || a.title.localeCompare(b.title))
}

/** The templates the rows hold, one each, by IDTA number: `{ id, name, number, version, title }`. */
export function templateList(elements) {
  return templateSections(elements).map(s => ({ ...s.template, title: s.title }))
}

/** The elements a metric can fill: a value goes in them. schema_template_elements() in 0342 names the same. */
export const FILLABLE_MODEL_TYPES = Object.freeze(['Property', 'MultiLanguageProperty'])

/** The cardinalities that make an element one a submodel must hold. template_required_paths() names the same. */
export const REQUIRED_CARDINALITIES = Object.freeze(['One', 'OneToMany'])

/** An element a metric can fill: a Property or a MultiLanguageProperty with a semantic id. */
export const isFillable = (element) => FILLABLE_MODEL_TYPES.includes(element?.model_type) && !!element?.semantic_id

/** A template's elements a metric can fill, in the template's order. */
export function fillableElements(elements, templateId) {
  return (elements || []).filter(e => e.template_id === templateId && isFillable(e)).sort((a, b) => a.ordinal - b.ordinal)
}

/**
 * The element of the template each metric fills: `{ [metric name]: { path, semantic_id } }`. A metric fills
 * the first element a metric can fill whose semantic id is its own id, or else one of its further ids
 * (`further_semantic_ids`, as api.js reads the catalogue). The database writes the same with
 * schema_template_elements() (0342), and test-harness/fixtures/schema-template-elements.json holds the two.
 */
export function templateElementFill(elements, templateId, metrics) {
  const fillable = fillableElements(elements, templateId)
  const filled = {}
  for (const metric of metrics || []) {
    const further = (metric.further_semantic_ids || []).map(f => (typeof f === 'string' ? f : f.semantic_id))
    const element = (metric.semantic_id && fillable.find(e => e.semantic_id === metric.semantic_id))
      || fillable.find(e => further.includes(e.semantic_id))
    if (element) filled[metric.name] = { path: element.path, semantic_id: element.semantic_id }
  }
  return filled
}

/**
 * The paths a submodel of the template must hold that a metric can fill, in the template's order: one whose
 * cardinality is One or OneToMany, inside no element whose cardinality is anything else. An element inside one
 * that may be left out is asked for only where that one is there, which a schema of metrics does not say.
 */
export function requiredTemplatePaths(elements, templateId) {
  const rows = (elements || []).filter(e => e.template_id === templateId)
  const optional = rows.filter(a => !REQUIRED_CARDINALITIES.includes(a.cardinality))
  const inside = (e, a) => e.path.startsWith(`${a.path}.`) || e.path.startsWith(`${a.path}[`)
  return fillableElements(rows, templateId)
    .filter(e => REQUIRED_CARDINALITIES.includes(e.cardinality) && !optional.some(a => inside(e, a)))
    .map(e => e.path)
}

/**
 * Every reason a version built from a template may not be saved, in the words schema_template_problems()
 * (0342) refuses it with, in the same order: mirror check 182 holds the sentences. `title` is the template's
 * name and version, or null for an id the rows do not hold.
 */
export function templateProblems({ templateId, title, semanticId, required, filled }) {
  if (!title) return [`${templateId} is not a template Aber holds. Choose one on the Vocabulary page's Templates tab.`]
  const problems = []
  if (semanticId !== templateId) {
    problems.push(`A schema built from ${title} carries the template's id as its semantic id: ${templateId}.`)
  }
  const paths = new Set(Object.values(filled || {}).map(f => f.path))
  const missing = (required || []).filter(p => !paths.has(p))
  if (missing.length > 0) {
    problems.push(`No metric here fills ${missing.join(', ')}, which ${title} requires. A metric fills an element when the element's semantic id is the metric's own or one of its further ids.`)
  }
  return problems
}

/** What an element's tooltip says, and the search reads: its path, then what the template says of it. */
export function elementTooltip(element) {
  if (!element) return ''
  return element.definition ? `${element.path} — ${element.definition}` : element.path
}
