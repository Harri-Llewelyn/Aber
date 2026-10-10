/**
 * The OPC UA companion-specification vocabulary, from `opcua_vocabulary`. A data point is
 * positional: group and type derive from the row, and only the instance (which axis) is left to the
 * operator. `node_id` and `semantic_id` are both the ExpandedNodeId the specification's NodeSet
 * publishes, `nsu=<namespace URI>;i=<id>`.
 */

import { STANDARDS } from './standards'
import { OPCUA_GROUPS } from './opcuaGroups.generated'

/**
 * The metric group a data point implies, which scripts/generate-opcua-vocabulary.mjs records beside
 * each row it seeds. '' for a row it does not know.
 */
export function suggestedGroup(entry) {
  if (!entry?.name) return ''
  return OPCUA_GROUPS[entry.companion_spec]?.[entry.name] || ''
}

/**
 * OPC UA built-in DataType to Sparkplug datatype code. The form offers Double / Boolean / String,
 * so integer types collapse onto Double. Unknown types fall back to String, the lossless choice.
 */
export function sparkplugDatatypeFor(opcuaDatatype) {
  const t = (opcuaDatatype || '').trim()
  if (t === 'Boolean') return 11
  if (/^(Double|Float|U?Int(16|32|64)?|Byte|SByte|Number|Duration)$/.test(t)) return 10
  return 12
}

/**
 * The MTConnect observation category recorded alongside an OPC UA point: `metric_catalog.category`
 * is CHECK-constrained to MTConnect's values. A varying number is a SAMPLE, a discrete state an
 * EVENT; nothing maps to CONDITION, since OPC UA models faults as alarms, which are not ingested.
 */
export function categoryFor(opcuaDatatype) {
  return sparkplugDatatypeFor(opcuaDatatype) === 10 ? 'SAMPLE' : 'EVENT'
}

/** Every data point in the vocabulary, ordered by name. */
export function dataPoints(vocabulary) {
  return (vocabulary || [])
    .slice()
    .sort((a, b) => (a?.name || '').localeCompare(b?.name || '', undefined, { sensitivity: 'base' }))
}

/** Look a data point up by companion spec and browse name -- the vocabulary's composite key. */
export function dataPointByName(vocabulary, companionSpec, name) {
  if (!name) return null
  return (vocabulary || []).find(
    d => d?.name === name && (!companionSpec || d?.companion_spec === companionSpec)
  ) || null
}

/**
 * The vocabulary arranged into sections, one per companion specification, since which spec a point
 * comes from decides whether it applies to an asset at all.
 */
export function opcuaSections(vocabulary) {
  const buckets = new Map()
  for (const point of dataPoints(vocabulary)) {
    const key = point.companion_spec || 'Other'
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(point)
  }

  const hints = {
    'OPC 40001 Machinery': 'Identification and lifecycle state common to any machine.',
    'OPC 40010 Robotics': 'Motion device model — axes, safety states and task control.',
    'OPC 40001-4 Machinery Energy': 'Utility flow measurements — compressed air, water and gas.',
    'OPC 40501 Machine Tools': 'Channel overrides and state, spindles, production counters and tool management.',
    'OPC 40540 Additive Manufacturing': 'Feedstock condition and in-process sensor readings.',
    'OPC 30050 PackML': 'Unit status, mode, and the state and mode time accumulators.'
  }

  return [...buckets.keys()].sort().map(key => ({
    key: `opcua:${key}`,
    title: key,
    hint: hints[key] || null,
    entries: buckets.get(key)
  }))
}

/**
 * The Add Metric form state a data point implies. The instance is left empty, since which axis is
 * the part the specification cannot know. `companionSpec` travels with the name because two
 * specifications can define the same browse name.
 */
export function opcuaPrefill(entry) {
  if (!entry) return null
  return {
    group: suggestedGroup(entry),
    type: entry.name,
    companionSpec: entry.companion_spec || '',
    units: entry.unit || '',
    datatype: sparkplugDatatypeFor(entry.datatype),
    category: categoryFor(entry.datatype),
    semanticId: entry.semantic_id || '',
    standard: STANDARDS.OPCUA,
    description: entry.description || ''
  }
}

/** One-line summary for a data point chip's tooltip: what it is, then the node it names. */
export function dataPointTooltip(entry) {
  if (!entry) return ''
  const node = (entry.node_id || '').trim()
  const bits = [entry.description, node ? `NodeId: ${node}` : null].filter(Boolean)
  return bits.length ? `${entry.name} — ${bits.join(' · ')}` : entry.name
}
