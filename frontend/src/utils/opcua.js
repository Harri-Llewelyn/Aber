/**
 * The OPC UA companion-specification vocabulary, as served from `opcua_vocabulary` (migration 0031).
 *
 * Like MTConnect and unlike ISO 22400, an OPC UA data point is positional: `ActualPosition` means
 * nothing until you say which axis of which motion device. The companion spec supplies that
 * position as a browse path, so the group and the type can both be derived from the vocabulary row
 * and only the instance ("which axis?") is left for the operator.
 *
 * ⚠ `node_id` holds a browse path in ExpandedNodeId string form, not a resolvable numeric NodeId.
 * See the header of archive/20260101000031_opcua_vocabulary.sql -- the numeric identifiers live in the published
 * NodeSet2 XML, which is not vendored here, and were not invented.
 */

import { STANDARDS } from './standards'

/** Namespace/identifier separator in the ExpandedNodeId string form `nsu=<ns>;s=<path>`. */
const NODE_ID_PATH = /(?:^|;)s=(.+)$/

/**
 * The browse path out of an ExpandedNodeId string, or '' when it carries none.
 *
 * `nsu=http://opcfoundation.org/UA/Robotics/;s=MotionDevice/Axes/Axis/ActualPosition`
 *   -> `MotionDevice/Axes/Axis/ActualPosition`
 */
export function browsePath(nodeId) {
  const match = NODE_ID_PATH.exec((nodeId || '').trim())
  return match ? match[1].trim() : ''
}

/** The namespace URI out of an ExpandedNodeId string, or '' when it carries none. */
export function namespaceUri(nodeId) {
  const match = /(?:^|;)nsu=([^;]+)/.exec((nodeId || '').trim())
  return match ? match[1].trim() : ''
}

/**
 * The metric group a data point implies: the first segment of its browse path.
 *
 * Derived from the data rather than mapped from `companion_spec`, so adding a row to the vocabulary
 * needs no corresponding code change. It also lands on the same separator convention the rest of
 * the platform uses -- an OPC UA browse path is already `/`-delimited, which is one of the reasons
 * `/` was chosen as the metric group separator in the first place.
 */
export function suggestedGroup(entry) {
  const path = browsePath(entry?.node_id)
  if (!path) return ''
  const first = path.split('/')[0]
  return first || ''
}

/**
 * OPC UA built-in DataType -> Sparkplug datatype code.
 *
 * The form only offers Double/Boolean/String (utils/sparkplugDatatype.js), which is what this
 * platform's devices actually publish, so integer types collapse onto Double rather than
 * introducing codes nothing downstream reads. Unknown types fall back to String: it is the
 * lossless choice, and a wrong numeric datatype is unrecoverable once a device is configured
 * against it.
 */
export function sparkplugDatatypeFor(opcuaDatatype) {
  const t = (opcuaDatatype || '').trim()
  if (t === 'Boolean') return 11
  if (/^(Double|Float|U?Int(16|32|64)?|Byte|SByte|Number|Duration)$/.test(t)) return 10
  return 12
}

/**
 * The MTConnect observation category recorded alongside an OPC UA data point.
 *
 * `metric_catalog.category` is CHECK-constrained to MTConnect's three values, so an OPC UA point
 * has to be described in those terms: a continuously-varying number is a SAMPLE, a discrete state
 * or identifier is an EVENT. Nothing here maps to CONDITION -- OPC UA models faults as alarms,
 * which this platform does not yet ingest.
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
 * The vocabulary arranged into browsable sections, one per companion specification.
 *
 * Specs rather than components, because which spec a data point comes from is the first thing that
 * decides whether it applies to an asset at all -- a CNC has Machinery points and no Robotics ones.
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
 * The Add Metric form state a data point implies.
 *
 * The instance is deliberately left empty: the browse path says `MotionDevice/Axes/Axis`, and which
 * axis is exactly the part the specification cannot know. Deeper path segments are dropped rather
 * than composed into the name -- only the first segment is load-bearing for grouping, and a name
 * like `MotionDevice/Axes/Axis/J1/ActualPosition` carries two segments that say nothing a reader
 * did not already know.
 */
export function opcuaPrefill(entry) {
  if (!entry) return null
  return {
    group: suggestedGroup(entry),
    type: entry.name,
    units: entry.unit || '',
    datatype: sparkplugDatatypeFor(entry.datatype),
    category: categoryFor(entry.datatype),
    semanticId: entry.semantic_id || '',
    standard: STANDARDS.OPCUA,
    description: entry.description || ''
  }
}

/** One-line summary for a data point chip's tooltip: what it is, then where it lives. */
export function dataPointTooltip(entry) {
  if (!entry) return ''
  const path = browsePath(entry.node_id)
  const bits = [entry.description, path ? `Browse path: ${path}` : null].filter(Boolean)
  return bits.length ? `${entry.name} — ${bits.join(' · ')}` : entry.name
}
