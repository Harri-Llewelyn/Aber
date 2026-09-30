import React from 'react'
import { iso22400Sections, kpiTooltip } from '../../utils/iso22400'
import { STANDARDS } from '../../utils/standards'

/**
 * The ISO 22400 tab of the Vocabulary page. A distinct tab because ISO 22400
 * gives whole computed KPIs with formulas, not words to build an observation name from; MTConnect's
 * `AVAILABILITY` is an EVENT meaning connected, not the ISO ratio. In use is decided by semantic id
 * where the catalog has one, falling back to the name token.
 */
export function iso22400VocabularyTab({ vocabulary, catalog, onUseKpi }) {
  const sections = iso22400Sections(vocabulary).map(s => ({
    ...s,
    items: s.entries.map(kpi => ({ id: `iso:${kpi.name}`, name: kpi.name, kpi }))
  }))

  const semanticIds = new Set()
  const nameTokens = new Set()
  for (const metric of catalog || []) {
    if (metric?.semantic_id) semanticIds.add(metric.semantic_id)
    // The last segment of an ISO-provenance metric name: `OEE/AVAILABILITY` -> `AVAILABILITY`.
    if (metric?.standard === STANDARDS.ISO22400 && metric?.name) {
      const parts = metric.name.split('/')
      nameTokens.add(parts[parts.length - 1])
    }
  }

  return {
    id: STANDARDS.ISO22400,
    label: 'ISO 22400',
    hint: 'Computed manufacturing KPIs — the measures MTConnect deliberately excludes.',
    searchPlaceholder: 'Search KPIs and formulas…',
    description: (
      <>
        The manufacturing KPIs defined by ISO 22400-2 — the computed measures MTConnect
        deliberately leaves out, since it reports raw machine state and stops there.
      </>
    ),
    notes: [
      {
        label: 'KPIs are picked whole.',
        body: (
          <>
            {' '}Not composed like an MTConnect name: <span className="mono">AVAILABILITY</span>{' '}
            becomes <span className="mono">OEE/AVAILABILITY</span> in the catalog, carrying the
            KPI's unit and semantic id with it. Formulas are on hover, in the standard's symbols.
          </>
        )
      },
      {
        label: 'Beware the name clash.',
        body: (
          <>
            {' '}MTConnect's own <span className="mono">AVAILABILITY</span> is a different thing
            entirely — an EVENT meaning the device is connected, not this ratio.
          </>
        )
      }
    ],
    sections,
    isUsed: item =>
      (item.kpi.semantic_id && semanticIds.has(item.kpi.semantic_id)) || nameTokens.has(item.name),
    tooltipFor: item => kpiTooltip(item.kpi),
    metaFor: item => item.kpi.unit || '',
    onUse: onUseKpi ? (item => onUseKpi(item.kpi)) : undefined
  }
}
