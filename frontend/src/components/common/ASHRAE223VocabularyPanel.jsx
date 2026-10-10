import React from 'react'
import { ashrae223Sections, conceptTooltip, isMetricConcept } from '../../utils/ashrae223'
import { STANDARDS } from '../../utils/standards'

/**
 * The ASHRAE 223P tab of the Vocabulary page. 223P is a reference here: a class (`Fan`, `Damper`,
 * `Sensor`) names the thing a point is attached to, not a reading, so Use starts a metric in the BMS
 * group, named after the class, with no semantic id. A class is in use when an ASHRAE 223P metric is
 * named after it or a metric carries its id; a name counts only under the standard, because 223P's
 * names are ordinary English words that collide with local naming. Relations are listed, since they
 * are part of the standard, but cannot be clicked: the Metrics page's Concept picker does not offer
 * them either, and the two follow the one rule in `isMetricConcept()`.
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
  const nameTokens = new Set()
  for (const metric of catalog || []) {
    if (metric?.semantic_id) semanticIds.add(metric.semantic_id)
    // The last segment of a 223P metric's name: `BMS/AHU1/Fan` -> `Fan`.
    if (metric?.standard === STANDARDS.ASHRAE223 && metric?.name) {
      const parts = metric.name.split('/')
      nameTokens.add(parts[parts.length - 1])
    }
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
        label: 'A reference, not a source of ids.',
        body: (
          <>
            {' '}<span className="mono">Fan</span> names equipment, not a reading. Clicking a class
            starts a metric in the BMS group, named after it, with no semantic id. You choose the
            datatype, units and id, such as a QUDT quantity kind.
          </>
        )
      },
      {
        label: 'Still in public review.',
        body: ' These concepts come from the open223 pre-publication ontology and may change before ASHRAE 223 is published.'
      }
    ],
    sections,
    isUsed: item =>
      (!!item.concept.semantic_id && semanticIds.has(item.concept.semantic_id)) || nameTokens.has(item.concept.name),
    tooltipFor: item => conceptTooltip(item.concept),
    metaFor: item => (item.concept.concept_kind === 'Class' ? '' : item.concept.concept_kind),
    isActionable: item => isMetricConcept(item.concept),
    onUse: onUseConcept ? (item => onUseConcept(item.concept)) : undefined
  }
}
