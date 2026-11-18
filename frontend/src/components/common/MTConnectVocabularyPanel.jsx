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

  // What MTConnect says a data item type is (migration 0301): NULL for every other kind of entry
  // and for a type the XSD does not document, which then shows its name alone.
  const definitions = new Map()
  for (const entry of vocabulary || []) {
    if (entry?.kind === 'DATA_ITEM_TYPE' && entry?.description) definitions.set(entry.name, entry.description)
  }

  return {
    id: STANDARDS.MTCONNECT,
    label: 'MTConnect',
    hint: 'Machine tool observations — data item types, components, subtypes and units.',
    searchPlaceholder: 'Search the vocabulary…',
    sections,
    isUsed: item => adopted.has(item.name),
    tooltipFor: item => {
      const definition = item.sectionKey.startsWith('type:') ? definitions.get(item.name) : null
      return definition ? `${item.name} — ${definition}` : ''
    },
    idFor: item => {
      const semanticId = semanticIds.get(item.name)
      return semanticId ? { label: 'Semantic ID', value: semanticId } : null
    },
    // Only data item types are actionable: a component or a unit is not a metric on its own, so
    // prefilling the form with one would produce nothing useful.
    isActionable: item => item.sectionKey.startsWith('type:'),
    onUse: onUseType ? (item => onUseType(item.name)) : undefined
  }
}
