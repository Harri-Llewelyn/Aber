import { iso22400Sections, kpiTooltip, kpiNote, kpiDeprecation, deprecatedKpis } from '../../utils/iso22400'
import { STANDARDS } from '../../utils/standards'

/**
 * The ISO 22400 tab of the Vocabulary page. A distinct tab because ISO 22400
 * gives whole computed KPIs with formulas, not words to build an observation name from; MTConnect's
 * `AVAILABILITY` is an EVENT meaning connected, not the ISO ratio. In use is decided by semantic id
 * where the catalog has one, falling back to the name token. A KPI whose definition was read from a
 * source anyone can check, OPC 40501-1 Annex C for the four OEE KPIs, says so after its tooltip. A KPI
 * no free source publishes is deprecated (0305): its chip says so in words, its tooltip says why, and
 * the tab says what a site that owns ISO 22400-2 can do.
 */
export function iso22400VocabularyTab({ vocabulary, catalog, onUseKpi }) {
  const sections = iso22400Sections(vocabulary).map(s => ({
    ...s,
    items: s.entries.map(kpi => ({ id: `iso:${kpi.name}`, name: kpi.name, kpi }))
  }))

  const deprecated = deprecatedKpis(vocabulary)
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
    sections,
    isUsed: item =>
      (item.kpi.semantic_id && semanticIds.has(item.kpi.semantic_id)) || nameTokens.has(item.name),
    tooltipFor: item => kpiTooltip(item.kpi),
    noteFor: item => kpiNote(item.kpi),
    notice: deprecated.length > 0
      ? `${deprecated.join(', ')} ${deprecated.length === 1 ? 'is' : 'are'} deprecated. A site that owns ISO 22400-2 can import it on the Vocabulary page.`
      : undefined,
    metaFor: item => [item.kpi.unit, kpiDeprecation(item.kpi) ? 'deprecated' : ''].filter(Boolean).join(' · '),
    onUse: onUseKpi ? (item => onUseKpi(item.kpi)) : undefined
  }
}
