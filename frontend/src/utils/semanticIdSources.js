/**
 * Where a catalog metric's semantic id can come from: the suggestion its own standard makes, which
 * Add Metric shows and Edit can put back. Nothing here mints an id for a local extension: an
 * `aber.local` id for a Custom metric would only restate its name, and its blank is what marks it
 * unmapped.
 */

import {
  STANDARDS, DEFAULT_SEMANTIC_ID_TYPE, inferSemanticIdType, mtconnectSemanticId
} from './standards'
import { kpiByName } from './iso22400'
import { suggestedGroup } from './opcua'
import { conceptByName } from './ashrae223'

/**
 * An MTConnect data item type's suggestion: its concept id, shared by every metric of that type.
 * Derived rather than read, so it is the id check-mirror-drift check 8 holds to the seed. `null`
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
 * The type is the last name segment once a trailing `sub_type` is removed, as migration 0009 finds
 * it. OPC UA names shared by two companion specifications are told apart by the group, which is the
 * first segment of the point's browse path. `null` for a local extension, or an entry the
 * vocabulary no longer holds.
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
