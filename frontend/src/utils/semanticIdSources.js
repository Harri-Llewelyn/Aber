/**
 * Where a catalog metric's semantic id can come from: the suggestion its own standard makes, which
 * Add Metric shows and Edit can put back, and every concept the platform holds an id for, which the
 * picker searches. Nothing here mints an id for a local extension: an `aber.local` id for a Custom
 * metric would only restate its name, and its blank is what marks it unmapped.
 */

import {
  STANDARDS, DEFAULT_SEMANTIC_ID_TYPE, inferSemanticIdType, mtconnectSemanticId
} from './standards'
import { kpiByName } from './iso22400'
import { suggestedGroup } from './opcua'
import { conceptByName, metricConcepts } from './ashrae223'

/**
 * An MTConnect data item type's suggestion: its concept id, shared by every metric of that type.
 * Derived rather than read, so it is the id check-mirror-drift check 7 holds to the seed. `null`
 * without a type.
 */
export function mtconnectSuggestion(dataItemType) {
  const type = (dataItemType || '').trim()
  if (!type) return null
  return {
    semanticId: mtconnectSemanticId(type),
    semanticIdType: DEFAULT_SEMANTIC_ID_TYPE,
    note: `The ${type} data item type's id in this deployment's MTConnect namespace, shared by every metric of that type.`
  }
}

/** A vocabulary row's suggestion: the id the row carries, typed by its shape. `null` without one. */
export function vocabularySuggestion(standard, entryName, semanticId) {
  const id = (semanticId || '').trim()
  if (!id) return null
  return {
    semanticId: id,
    semanticIdType: inferSemanticIdType(id),
    note: `The id the ${standard} vocabulary gives ${entryName}.`
  }
}

/**
 * The suggestion Add Metric makes for a catalog row's standard and type, so Edit can offer it back.
 * The type is the last name segment once a trailing `sub_type` is removed, as archived migration 0142 finds
 * it. OPC UA names shared by two companion specifications are told apart by the group each point
 * suggests (`suggestedGroup()`). `null` for a local extension, or an entry the vocabulary no
 * longer holds.
 */
export function suggestionForMetric(metric, { mtconnect, iso22400, opcua, ashrae223 } = {}) {
  const segments = (metric?.name || '').split('/')
  if (metric?.sub_type && segments.length > 1 && segments[segments.length - 1] === metric.sub_type) {
    segments.pop()
  }
  const type = segments[segments.length - 1] || ''
  const group = metric?.metric_group || (segments.length > 1 ? segments[0] : '')

  switch (metric?.standard) {
    case STANDARDS.MTCONNECT:
      return (mtconnect || []).some(v => v.kind === 'DATA_ITEM_TYPE' && v.name === type)
        ? mtconnectSuggestion(type)
        : null
    case STANDARDS.ISO22400:
      return vocabularySuggestion(STANDARDS.ISO22400, type, kpiByName(iso22400, type)?.semantic_id)
    case STANDARDS.OPCUA: {
      const named = (opcua || []).filter(p => p.name === type && p.semantic_id)
      const grouped = named.filter(p => suggestedGroup(p) === group)
      const ids = new Set((grouped.length > 0 ? grouped : named).map(p => p.semantic_id))
      return ids.size === 1 ? vocabularySuggestion(STANDARDS.OPCUA, type, [...ids][0]) : null
    }
    case STANDARDS.ASHRAE223:
      return vocabularySuggestion(STANDARDS.ASHRAE223, type, conceptByName(ashrae223, type)?.semantic_id)
    default:
      return null
  }
}

/** The name an IDTA template's elements are listed under, such as `IDTA Digital Nameplate 3.0`. */
export const templateSource = (row) =>
  ['IDTA', row?.template_name, row?.template_version].filter(Boolean).join(' ')

/**
 * Every concept the picker offers, as `{ standard, label, semanticId, semanticIdType, detail }`:
 * MTConnect data item types, ISO 22400 KPIs, OPC UA data points, the ASHRAE 223P concepts a metric
 * can attach to, and the IDTA template elements. A template records its element's reference type;
 * a vocabulary id is typed by its shape. MTConnect ids are derived, so choosing a metric's own type
 * here gives exactly its suggestion.
 */
export function semanticIdCandidates({ mtconnect, iso22400, opcua, ashrae223, templates } = {}) {
  const candidates = []
  const add = (standard, label, semanticId, semanticIdType, detail) => {
    const id = (semanticId || '').trim()
    if (!id) return
    candidates.push({
      standard, label, semanticId: id, semanticIdType: semanticIdType || inferSemanticIdType(id), detail: detail || ''
    })
  }
  for (const v of mtconnect || []) {
    if (v.kind !== 'DATA_ITEM_TYPE') continue
    add(STANDARDS.MTCONNECT, v.name, mtconnectSemanticId(v.name), DEFAULT_SEMANTIC_ID_TYPE,
      v.category ? `${v.category} data item type` : 'Data item type')
  }
  for (const k of iso22400 || []) add(STANDARDS.ISO22400, k.name, k.semantic_id, '', k.description)
  for (const p of opcua || []) add(STANDARDS.OPCUA, p.name, p.semantic_id, '', p.companion_spec)
  for (const c of metricConcepts(ashrae223)) {
    add(STANDARDS.ASHRAE223, c.label || c.name, c.semantic_id, '', c.subclass_of ? `Subclass of ${c.subclass_of}` : '')
  }
  for (const t of templates || []) add(templateSource(t), t.id_short, t.semantic_id, t.semantic_id_type, t.description)
  return candidates
}

/**
 * The candidates matching every word of `query` in their label, standard, id or detail, best first:
 * a label equal to the query, then one starting with it, then a match outside the detail, then the
 * rest; the subject's own `standard` first within each. Returns at most `limit` and the total.
 */
export function searchSemanticIdCandidates(candidates, query, { standard = '', limit = 50 } = {}) {
  const words = (query || '').toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { matches: [], total: 0 }
  const phrase = words.join(' ')
  const found = []
  ;(candidates || []).forEach((c, index) => {
    const primary = `${c.label} ${c.standard} ${c.semanticId}`.toLowerCase()
    const all = `${primary} ${c.detail}`.toLowerCase()
    if (!words.every(w => all.includes(w))) return
    const label = c.label.toLowerCase()
    const rank = label === phrase ? 0
      : label.startsWith(phrase) ? 1
        : words.every(w => primary.includes(w)) ? 2 : 3
    found.push({ c, rank, own: standard && c.standard === standard ? 0 : 1, index })
  })
  found.sort((a, b) => a.rank - b.rank || a.own - b.own || a.index - b.index)
  return { matches: found.slice(0, limit).map(f => f.c), total: found.length }
}

/**
 * The concept `semanticId` names when it belongs to another standard than the subject's own, for
 * the note that says what the choice costs. `null` when the own standard holds it, when no source
 * knows it, or when the subject has no standard.
 */
export function foreignConcept(candidates, semanticId, standard) {
  const id = (semanticId || '').trim()
  if (!id || !standard) return null
  const named = (candidates || []).filter(c => c.semanticId === id)
  if (named.length === 0 || named.some(c => c.standard === standard)) return null
  return named[0]
}
