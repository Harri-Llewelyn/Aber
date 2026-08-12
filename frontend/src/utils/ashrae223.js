/**
 * The ASHRAE 223P vocabulary, as served from `ashrae223_vocabulary` (migration 0013).
 *
 * Unlike MTConnect and OPC UA, a 223P concept is NOT positional. `Fan` is a class of thing, not a
 * reading taken somewhere -- there is no browse path to derive a group from, and no instance for
 * the operator to name. So every concept files under one group, `Building`, and what the operator
 * supplies is which fan.
 *
 * ⚠ The standard is still in public review. These concepts come from a pre-publication ontology
 * release and may change before ASHRAE 223 is published; see the header of migration 0013.
 */

import { STANDARDS } from './standards'

/** The single metric group 223P concepts file under. Registered by migration 0013. */
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
 * The vocabulary arranged into browsable sections.
 *
 * Sectioned by the immediate superclass rather than by `concept_kind`: 640 concepts under four
 * kind headings is not browsable, and "what kind of thing is this" is answered by the hierarchy an
 * operator already thinks in -- a Fan is Equipment. Concepts at the top of the hierarchy collect
 * under `Root`, which is where the abstract modelling constructs live.
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
 * The Add Metric form state a concept implies.
 *
 * `datatype` is deliberately absent. A 223P concept says what a thing IS, not what type its reading
 * has -- a `Sensor` may report a temperature, a pressure or a boolean occupancy -- so guessing one
 * here would put a wrong immutable datatype on a metric, which is the one field that cannot be
 * corrected afterwards. The operator picks it.
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
