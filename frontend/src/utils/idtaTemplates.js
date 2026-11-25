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

/** What an element's tooltip says, and the search reads: its path, then what the template says of it. */
export function elementTooltip(element) {
  if (!element) return ''
  return element.definition ? `${element.path} — ${element.definition}` : element.path
}
