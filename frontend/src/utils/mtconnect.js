/**
 * The MTConnect controlled vocabularies, as served from `mtconnect_vocabulary`: reference data
 * generated from the Apache-2.0 mtconnect/schema repository (seeded by 0002_seed_data.sql;
 * regenerate with scripts/generate-mtconnect-vocabulary.mjs). A metric name is composed from
 * component path, data item type and subType, e.g. `Axes/C/ANGULAR_VELOCITY/ACTUAL`; the subType is
 * in the name because ACTUAL and COMMANDED readings would otherwise collide on metric_catalog's
 * UNIQUE(name).
 */

import { METRIC_GROUP_SEPARATOR } from './metricGroup'
import { STANDARDS } from './standards'

const VOCABULARY_KINDS = {
  DATA_ITEM_TYPE: 'DATA_ITEM_TYPE',
  SUB_TYPE: 'SUB_TYPE',
  UNIT: 'UNIT',
  NATIVE_UNIT: 'NATIVE_UNIT',
  COMPONENT: 'COMPONENT'
}

/**
 * Provenance recorded on a catalog entry built from the standard vocabulary. Re-exported from the
 * standards registry so `metric_catalog.standard` has one definition.
 */
export const MTCONNECT_STANDARD = STANDARDS.MTCONNECT

/** Only SAMPLE observations are a continuously-varying measurement, so only they carry units. */
export const CATEGORY_WITH_UNITS = 'SAMPLE'

const byKind = (vocabulary, kind) =>
  (vocabulary || []).filter(v => v.kind === kind)

export const dataItemTypes = (vocabulary) => byKind(vocabulary, VOCABULARY_KINDS.DATA_ITEM_TYPE)
export const subTypes = (vocabulary) => byKind(vocabulary, VOCABULARY_KINDS.SUB_TYPE).map(v => v.name)

/**
 * Units offered for a data item. NATIVE_UNIT values are the ones MTConnect allows a device to
 * report in before conversion, so they follow the preferred UNIT values.
 */
export const unitNames = (vocabulary) => [
  ...byKind(vocabulary, VOCABULARY_KINDS.UNIT).map(v => v.name),
  ...byKind(vocabulary, VOCABULARY_KINDS.NATIVE_UNIT).map(v => v.name)
]

/** The category (SAMPLE / EVENT / CONDITION) MTConnect assigns to a data item type. */
export function categoryOfType(vocabulary, typeName) {
  if (!typeName) return null
  const hit = dataItemTypes(vocabulary).find(v => v.name === typeName)
  return hit?.category ?? null
}

/** Data item types grouped by category, for a picker that shows what kind of thing each is. */
export function typesByCategory(vocabulary) {
  const buckets = new Map()
  for (const type of dataItemTypes(vocabulary)) {
    const key = type.category || 'OTHER'
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(type.name)
  }
  // SAMPLE first: it is the common case for telemetry, and the only category carrying units.
  const order = ['SAMPLE', 'EVENT', 'CONDITION', 'OTHER']
  return order
    .filter(k => buckets.has(k))
    .map(k => ({ category: k, types: buckets.get(k).slice().sort() }))
}

/**
 * The path segments used by catalog metrics, for marking which parts of the vocabulary this
 * deployment has adopted. Splits on the separator so `Axes/DISPLACEMENT` marks both the component
 * and the data item type; the two vocabularies do not overlap.
 */
export function adoptedVocabulary(catalog) {
  const segments = new Set()
  for (const metric of catalog || []) {
    for (const part of (metric?.name || '').split(METRIC_GROUP_SEPARATOR)) {
      if (part) segments.add(part)
    }
  }
  return segments
}

/**
 * The vocabulary arranged into browsable sections. Data item types are split by category (SAMPLE,
 * EVENT, CONDITION); the remaining kinds are single sections.
 */
export function vocabularySections(vocabulary) {
  const sections = typesByCategory(vocabulary).map(g => ({
    key: `type:${g.category}`,
    title: `Data Item Types — ${g.category}`,
    hint: {
      SAMPLE: 'Continuously varying measurements. The only category that carries units.',
      EVENT: 'Discrete state changes, usually from a controlled value vocabulary.',
      CONDITION: 'Fault and warning states.'
    }[g.category] || null,
    names: g.types
  }))

  const single = [
    [VOCABULARY_KINDS.COMPONENT, 'Components', 'Structural parts of a machine. These become the first segment of a metric name, and the device tags derived from it.'],
    [VOCABULARY_KINDS.SUB_TYPE, 'Sub Types', 'Qualifiers such as ACTUAL, COMMANDED or TARGET. Appended as the last name segment.'],
    [VOCABULARY_KINDS.UNIT, 'Units', 'Preferred units for a SAMPLE observation.'],
    [VOCABULARY_KINDS.NATIVE_UNIT, 'Native Units', 'Units a device may report in before conversion.']
  ]

  for (const [kind, title, hint] of single) {
    const names = byKind(vocabulary, kind).map(v => v.name).sort()
    if (names.length > 0) sections.push({ key: `kind:${kind}`, title, hint, names })
  }

  return sections
}

// Name composition lives in utils/metricGroup.js as composeMetricName(). There is no
// MTConnect-specific composer; the part order (component, instance, type, subType) is spelled out
// at the call site in SchemasTab's Add Metric form.
