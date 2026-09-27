/**
 * The ASHRAE 223P vocabulary, as served from `ashrae223_vocabulary`. A 223P concept is not
 * positional: `Fan` is a class of thing, so every concept files under one group, `Building`, and
 * the operator supplies which fan. The standard is still in public review, so these concepts may
 * change before publication.
 */

import { STANDARDS } from './standards'

/** The single metric group 223P concepts file under. Registered by archived migration 0013. */
export const ASHRAE223_GROUP = 'Building'

/** Concepts, ordered by label -- what a reader scans -- rather than by local name. */
export function concepts(vocabulary) {
  return (vocabulary || [])
    .slice()
    .sort((a, b) => (a?.label || a?.name || '')
      .localeCompare(b?.label || b?.name || '', undefined, { sensitivity: 'base' }))
}

/** Look a concept up by its local name, which is the table's key. */
export function conceptByName(vocabulary, name) {
  if (!name) return null
  return (vocabulary || []).find(c => c?.name === name) || null
}

/**
 * Whether a concept is one a metric can be attached to: everything but the relations. `hasProperty`
 * is a predicate between two things, so a metric named after it (`Building/hasProperty`) would name
 * nothing. Classes, abstract classes and the root `Concept` all denote things. One rule for the
 * form's Concept picker and the Vocabulary page's Use action, so the two cannot disagree.
 */
export function isMetricConcept(concept) {
  return !!concept && concept.concept_kind !== 'Relation'
}

/** The vocabulary narrowed to the concepts a metric can be attached to. */
export function metricConcepts(vocabulary) {
  return (vocabulary || []).filter(isMetricConcept)
}

/**
 * The vocabulary arranged into browsable sections, by immediate superclass rather than
 * `concept_kind`, which is the hierarchy an operator thinks in. Concepts at the top of the
 * hierarchy collect under `Root`.
 */
export function ashrae223Sections(vocabulary) {
  const buckets = new Map()
  for (const concept of concepts(vocabulary)) {
    const key = concept.subclass_of || 'Root'
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(concept)
  }

  return [...buckets.keys()]
    .sort((a, b) => {
      // Root last: it holds the modelling scaffolding, which is the least useful place to start.
      if (a === 'Root') return 1
      if (b === 'Root') return -1
      return a.localeCompare(b, undefined, { sensitivity: 'base' })
    })
    .map(key => ({
      key: `s223:${key}`,
      title: key,
      hint: key === 'Root' ? 'Top-level concepts and modelling constructs.' : null,
      entries: buckets.get(key)
    }))
}

/**
 * The Add Metric form state a concept implies. `datatype` is absent: a 223P concept says what a
 * thing is, not what type its reading has, and datatype is the one field that cannot be corrected
 * afterwards.
 */
export function ashrae223Prefill(concept) {
  if (!concept) return null
  return {
    group: ASHRAE223_GROUP,
    type: concept.name,
    units: '',
    datatype: undefined,
    category: undefined,
    semanticId: concept.semantic_id || '',
    standard: STANDARDS.ASHRAE223,
    description: concept.description || ''
  }
}

/** One-line summary for a concept chip's tooltip. */
export function conceptTooltip(concept) {
  if (!concept) return ''
  const bits = [
    concept.description,
    concept.subclass_of ? `Subclass of ${concept.subclass_of}` : null
  ].filter(Boolean)
  return bits.length ? `${concept.label || concept.name} — ${bits.join(' · ')}` : (concept.label || concept.name)
}
