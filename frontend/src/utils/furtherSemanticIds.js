import { SEMANTIC_ID_TYPES, sameSemanticIdPair, storedSemanticIdPair } from './standards'

/**
 * The further semantic ids of a metric: other published ids of the concept it measures, kept beside
 * the one `metric_catalog.semantic_id` holds (`metric_semantic_ids`, 0299) and exported as the
 * Property's supplementalSemanticIds. The limits mirror enforce_metric_semantic_id() and the table's
 * CHECKs, which hold them for every writer; mirror check 115 compares them.
 */
export const MAX_FURTHER_SEMANTIC_IDS = 10
export const FURTHER_ID_MAX_LENGTH = 2000
export const FURTHER_SOURCE_MAX_LENGTH = 500

/** A metric's further ids as the dialog edits them: `{ semanticId, semanticIdType, source }`, by id. */
export function furtherIdsOf(metric) {
  return (metric?.further_semantic_ids || [])
    .map(row => ({
      semanticId: row.semantic_id,
      semanticIdType: row.semantic_id_type || '',
      source: row.source || ''
    }))
    .sort((a, b) => a.semanticId.localeCompare(b.semanticId))
}

/**
 * Why the id typed under Further Semantic ID cannot be added yet, said as a sentence, or null.
 * Nothing typed is no problem: the Add button is greyed and the field says what it is for.
 * `listed` is the ids already in the list and `ownId` the metric's own id as the dialog now holds it.
 */
export function furtherIdProblem({ draft, source = '', ownId = '', listed = [] }) {
  const { semanticId, semanticIdType } = storedSemanticIdPair(draft?.semanticId, draft?.semanticIdType)
  if (!semanticId) return null
  if (!ownId.trim()) return 'Give the metric a semantic id of its own first: a further id names the same concept another way.'
  if (semanticId === ownId.trim()) return 'That is the metric’s own semantic id. A further id names the same concept another way.'
  if (listed.includes(semanticId)) return 'That id is already in the list.'
  if (listed.length >= MAX_FURTHER_SEMANTIC_IDS) {
    return `A metric carries at most ${MAX_FURTHER_SEMANTIC_IDS} further semantic ids. Remove one first.`
  }
  if (semanticId.length > FURTHER_ID_MAX_LENGTH) {
    return `A semantic id is at most ${FURTHER_ID_MAX_LENGTH} characters.`
  }
  if (!SEMANTIC_ID_TYPES.includes(semanticIdType)) return 'Choose the reference type of the id.'
  if (source.trim().length > FURTHER_SOURCE_MAX_LENGTH) {
    return `The source is at most ${FURTHER_SOURCE_MAX_LENGTH} characters.`
  }
  return null
}

/**
 * What saving the dialog's list writes: the ids to remove and the rows to add, or null when it is the
 * list the metric has. An id taken out and put back is no change, and a row in the list is added by
 * its id alone, as the table holds one row for each.
 */
export function furtherIdsChange(saved, edited) {
  const was = new Map(saved.map(row => [row.semanticId, row]))
  const now = new Map(edited.map(row => [row.semanticId, row]))
  const remove = [...was.keys()].filter(id => !now.has(id)).sort()
  const add = [...now.values()]
    .filter(row => {
      const before = was.get(row.semanticId)
      return !before || !sameSemanticIdPair(before, row) || (before.source || '') !== (row.source || '')
    })
    .map(row => ({
      semantic_id: row.semanticId,
      semantic_id_type: row.semanticIdType,
      source: row.source.trim() || null
    }))
  // A row whose type or source changed is its id removed and added again: a saved row's id is fixed.
  const replaced = add.map(row => row.semantic_id).filter(id => was.has(id))
  const removed = [...new Set([...remove, ...replaced])].sort()
  return removed.length === 0 && add.length === 0 ? null : { add, remove: removed }
}
