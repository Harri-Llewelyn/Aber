import { opcuaSections, dataPointTooltip } from '../../utils/opcua'
import { STANDARDS } from '../../utils/standards'

/**
 * The OPC UA tab of the Vocabulary page: the vocabulary for the assets MTConnect
 * does not cover (articulated arms, AGVs, general machinery identification). Sections are companion
 * specifications, because which spec a point comes from decides whether it applies to an asset.
 */
export function opcuaVocabularyTab({ vocabulary, catalog, onUsePoint }) {
  const sections = opcuaSections(vocabulary).map(s => ({
    ...s,
    items: s.entries.map(point => ({
      id: `${point.companion_spec}:${point.name}`,
      name: point.name,
      point
    }))
  }))

  // Matched on semantic id first, since Machinery and Robotics both define names like Manufacturer.
  // The name-segment fallback covers metrics created before semantic ids were recorded.
  const semanticIds = new Set()
  const nameSegments = new Set()
  for (const metric of catalog || []) {
    if (metric?.semantic_id) semanticIds.add(metric.semantic_id)
    for (const part of (metric?.name || '').split('/')) {
      if (part) nameSegments.add(part)
    }
  }

  return {
    id: STANDARDS.OPCUA,
    label: 'OPC UA',
    hint: 'Companion specification data points — machinery, robotics, machine tools, additive, PackML and energy.',
    searchPlaceholder: 'Search data points…',
    sections,
    isUsed: item =>
      (item.point.semantic_id && semanticIds.has(item.point.semantic_id)) || nameSegments.has(item.name),
    tooltipFor: item => dataPointTooltip(item.point),
    metaFor: item => item.point.datatype || '',
    // Every point is a metric in its own right, unlike MTConnect where components and units are
    // name fragments rather than observations.
    isActionable: item => !!item.point.name,
    onUse: onUsePoint ? (item => onUsePoint(item.point)) : undefined
  }
}
