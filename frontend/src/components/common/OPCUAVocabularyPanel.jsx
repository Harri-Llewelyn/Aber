import React from 'react'
import { opcuaSections, dataPointTooltip, browsePath } from '../../utils/opcua'
import { STANDARDS } from '../../utils/standards'

/**
 * The OPC UA tab of the unified Standard Vocabulary Reference card.
 *
 * This is the vocabulary for the assets MTConnect does not cover. MTConnect is a machine-tool
 * standard; articulated arms, AGVs and general machinery identification are modelled in OPC UA
 * companion specs, and a mixed research fleet needs both.
 *
 * Sections are companion specifications rather than components, because which spec a point comes
 * from is the first thing that decides whether it applies to an asset at all -- a CNC has
 * Machinery points and no Robotics ones.
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

  // Matched on semantic id first -- the browse name alone is ambiguous, since Machinery and
  // Robotics both define names like Manufacturer, and a catalog metric may be named anything. The
  // name-segment fallback covers metrics created before Phase 1 recorded semantic ids.
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
    hint: 'Companion specification data points — OPC 40001 Machinery and OPC 40010 Robotics.',
    searchPlaceholder: 'Search data points…',
    description: (
      <>
        Data points defined by the OPC UA companion specifications — <span className="mono">OPC 40001</span>{' '}
        (Machinery) and <span className="mono">OPC 40010</span> (Robotics). Like MTConnect these are
        positional: <span className="mono">ActualPosition</span> becomes{' '}
        <span className="mono">MotionDevice/J1/ActualPosition</span> once you say which axis.
        The group is taken from the browse path, which is already <span className="mono">/</span>-delimited.{' '}
        <strong>The node ids here are browse paths, not resolvable numeric NodeIds</strong> — the numeric
        identifiers live in each spec's NodeSet2 file and must be looked up there before wiring a
        real OPC UA client.
      </>
    ),
    sections,
    isUsed: item =>
      (item.point.semantic_id && semanticIds.has(item.point.semantic_id)) || nameSegments.has(item.name),
    tooltipFor: item => dataPointTooltip(item.point),
    metaFor: item => item.point.datatype || '',
    // Every point is a metric in its own right, unlike MTConnect where components and units are
    // name fragments rather than observations.
    isActionable: item => !!browsePath(item.point.node_id) || !!item.point.name,
    onUse: onUsePoint ? (item => onUsePoint(item.point)) : undefined
  }
}
