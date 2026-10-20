import { vocabularySections, adoptedVocabulary } from '../../utils/mtconnect'
import { STANDARDS } from '../../utils/standards'

/**
 * The MTConnect tab of the Vocabulary page (common/VocabularyPanel): how sections are derived, what
 * an entry's tooltip says, and what counts as adopted. A reference view; it never writes anything.
 */
export function mtconnectVocabularyTab({ vocabulary, catalog, onUseType }) {
  // vocabularySections() returns plain name lists; the panel takes item objects, so each section is
  // adapted here rather than changing a shape three unit tests already assert.
  const sections = vocabularySections(vocabulary).map(s => ({
    ...s,
    items: s.names.map(name => ({ id: `${s.key}:${name}`, name, sectionKey: s.key }))
  }))

  const adopted = adoptedVocabulary(catalog)

  // Concept-level semantic ids, keyed by name. Looked up rather than re-derived, so the panel shows
  // exactly what live migration 0002 seeded and nothing if it has not run.
  const semanticIds = new Map()
  for (const entry of vocabulary || []) {
    if (entry?.semantic_id) semanticIds.set(entry.name, entry.semantic_id)
  }

  return {
    id: STANDARDS.MTCONNECT,
    label: 'MTConnect',
    hint: 'Machine tool observations — data item types, components, subtypes and units.',
    searchPlaceholder: 'Search the vocabulary…',
    sections,
    isUsed: item => adopted.has(item.name),
    tooltipFor: item => {
      const semanticId = semanticIds.get(item.name)
      return semanticId ? `${item.name} — ${semanticId}` : item.name
    },
    // Only data item types are actionable: a component or a unit is not a metric on its own, so
    // prefilling the form with one would produce nothing useful.
    isActionable: item => item.sectionKey.startsWith('type:'),
    onUse: onUseType ? (item => onUseType(item.name)) : undefined
  }
}
