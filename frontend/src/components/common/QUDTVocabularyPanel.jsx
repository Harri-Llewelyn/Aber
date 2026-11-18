import React from 'react'
import {
  QUDT_LABEL, QUDT_ATTRIBUTION, QUDT_LICENCE_URL, qudtSections, kindTooltip
} from '../../utils/qudt'

/**
 * The QUDT tab of the Vocabulary page: the quantity kinds QUDT defines, one section per initial
 * letter. A kind names what a reading measures, not the reading, so Use starts a Custom metric
 * whose semantic id is the kind, and the name, datatype and unit are the operator's. A kind is in
 * use when a catalog metric carries its id as its own or as a further one. The tab credits QUDT.org
 * under CC BY 4.0, as the licence asks. Nothing here is edited.
 */
export function qudtVocabularyTab({ vocabulary, catalog, onUseKind }) {
  const sections = qudtSections(vocabulary).map(s => ({
    ...s,
    items: s.entries.map(kind => ({ id: kind.semantic_id, name: kind.name, kind }))
  }))

  // Every id a metric carries, its own and its further ones, since a kind is usually the further one.
  const semanticIds = new Set()
  for (const metric of catalog || []) {
    if (metric?.semantic_id) semanticIds.add(metric.semantic_id)
    for (const further of metric?.further_semantic_ids || []) {
      if (further?.semantic_id) semanticIds.add(further.semantic_id)
    }
  }

  return {
    id: QUDT_LABEL,
    label: QUDT_LABEL,
    hint: 'Quantity kinds, what a reading measures, such as Temperature or Volume Flow Rate. A kind is the semantic id of a Custom metric, or a further id of any metric.',
    searchPlaceholder: 'Search quantity kinds…',
    sections,
    isUsed: item => semanticIds.has(item.kind.semantic_id),
    tooltipFor: item => kindTooltip(item.kind),
    idFor: item => ({ label: 'Semantic ID', value: item.kind.semantic_id }),
    onUse: onUseKind ? (item => onUseKind(item.kind)) : undefined,
    notice: (
      <>
        {QUDT_ATTRIBUTION}{' '}
        <a href={QUDT_LICENCE_URL} target="_blank" rel="noopener noreferrer">CC BY 4.0</a>.
      </>
    )
  }
}
