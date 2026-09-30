import React from 'react'
import { ashrae223Sections, conceptTooltip, isMetricConcept } from '../../utils/ashrae223'
import { STANDARDS } from '../../utils/standards'

/**
 * The ASHRAE 223P tab of the Vocabulary page. 223P names a thing (`Fan`,
 * `Damper`, `Sensor`), not a reading, so a selected concept names what the point is attached to and
 * the operator still says what is measured and in what type. In use is decided on semantic id
 * alone: 223P's names are ordinary English words that collide with local naming. Relations are
 * listed, since they are part of the standard, but cannot be clicked: the Metrics page's Concept picker
 * does not offer them either, and the two follow the one rule in `isMetricConcept()`.
 */
export function ashrae223VocabularyTab({ vocabulary, catalog, onUseConcept }) {
  const sections = ashrae223Sections(vocabulary).map(s => ({
    ...s,
    items: s.entries.map(concept => ({
      id: `s223:${concept.name}`,
      name: concept.label || concept.name,
      concept
    }))
  }))

  const semanticIds = new Set()
  for (const metric of catalog || []) {
    if (metric?.semantic_id) semanticIds.add(metric.semantic_id)
  }

  return {
    id: STANDARDS.ASHRAE223,
    label: 'ASHRAE 223P',
    hint: 'Building systems — the things a BMS point is attached to.',
    searchPlaceholder: 'Search concepts…',
    description: (
      <>
        The semantic concepts defined by <span className="mono">ASHRAE 223P</span> for building
        systems — HVAC, electrical, and the sensing around them. Sections follow the standard's own
        class hierarchy.
      </>
    ),
    notes: [
      {
        label: 'These name things, not readings.',
        body: (
          <>
            {' '}Unlike the other tabs: <span className="mono">Fan</span> is a class of equipment,
            not a measurement, so selecting one says what a point is attached to and leaves what is
            measured to you.
          </>
        )
      },
      {
        label: 'Still in public review.',
        body: ' These concepts come from the open223 pre-publication ontology and may change before ASHRAE 223 is published.'
      }
    ],
    sections,
    isUsed: item => !!item.concept.semantic_id && semanticIds.has(item.concept.semantic_id),
    tooltipFor: item => conceptTooltip(item.concept),
    metaFor: item => (item.concept.concept_kind === 'Class' ? '' : item.concept.concept_kind),
    isActionable: item => isMetricConcept(item.concept),
    onUse: onUseConcept ? (item => onUseConcept(item.concept)) : undefined
  }
}
