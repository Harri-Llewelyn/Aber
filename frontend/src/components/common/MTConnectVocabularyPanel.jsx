import React from 'react'
import { vocabularySections, adoptedVocabulary } from '../../utils/mtconnect'
import { STANDARDS } from '../../utils/standards'

/**
 * The MTConnect tab of the Standard Vocabulary Reference card (common/VocabularyPanel): how
 * sections are derived, what an entry's tooltip says, and what counts as adopted. A reference view;
 * it never writes anything.
 */
export function mtconnectVocabularyTab({ vocabulary, catalog, onUseType }) {
  // vocabularySections() returns plain name lists; the panel takes item objects, so each section is
  // adapted here rather than changing a shape three unit tests already assert.
  const sections = vocabularySections(vocabulary).map(s => ({
    ...s,
    items: s.names.map(name => ({ id: `${s.key}:${name}`, name, sectionKey: s.key }))
  }))

  const adopted = adoptedVocabulary(catalog)

  // Concept-level semantic ids, keyed by name. Looked up rather than re-derived so the panel shows
  // exactly what archived migration 0032 stored, and shows nothing if the backfill has not run.
  const semanticIds = new Map()
  for (const entry of vocabulary || []) {
    if (entry?.semantic_id) semanticIds.set(entry.name, entry.semantic_id)
  }

  return {
    id: STANDARDS.MTCONNECT,
    label: 'MTConnect',
    hint: 'Machine tool observations — data item types, components, subtypes and units.',
    searchPlaceholder: 'Search the vocabulary…',
    description: (
      <>
        The controlled vocabularies an MTConnect metric name is built from, generated from the{' '}
        <span className="mono">mtconnect/schema</span> repository.
      </>
    ),
    // The run-on paragraph this replaced buried its two load-bearing facts -- "these are words,
    // not your metrics" and "a name is composed, not picked" -- in the middle of six sentences.
    notes: [
      {
        label: 'Reference only.',
        body: " The standard's list of available words, not a list of metrics your devices publish."
      },
      {
        label: 'Names are composed.',
        body: (
          <>
            {' '}A metric is a component path plus a data item type, so{' '}
            <span className="mono">ANGLE</span> here becomes <span className="mono">Axes/C/ANGLE</span>{' '}
            in the catalog.
          </>
        )
      },
      {
        label: 'Semantic ids are local.',
        body: ' Each entry carries one, shown on hover — minted by this deployment, not issued by MTConnect, which publishes none. Entries already used by a catalog metric are ticked.'
      }
    ],
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
