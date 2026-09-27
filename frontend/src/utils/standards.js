/**
 * The standards a catalog metric can be built from. `metric_catalog.standard` is provenance; NULL
 * means a local extension, which every adopted standard permits. The three are complementary:
 * MTConnect for machine tools, ISO 22400 for computed KPIs, OPC UA for robotics and machinery
 * companion specs.
 */

export const STANDARDS = {
  MTCONNECT: 'MTConnect',
  ISO22400: 'ISO 22400',
  OPCUA: 'OPC UA',
  ASHRAE223: 'ASHRAE 223P',
  /** A local extension. Stored as NULL, not as the string 'Custom'. */
  CUSTOM: ''
}

/**
 * Options for the Standard selector, in the order offered: MTConnect leads as the largest
 * vocabulary, and Custom is last so it is a deliberate choice.
 */
export const STANDARD_OPTIONS = [
  {
    value: STANDARDS.MTCONNECT,
    label: 'MTConnect',
    hint: 'Machine tool observations. A component path plus a data item type — Axes/C/ANGLE.'
  },
  {
    value: STANDARDS.ISO22400,
    label: 'ISO 22400',
    hint: 'Computed manufacturing KPIs — availability, performance, quality, MTBF. MTConnect deliberately excludes these.'
  },
  {
    value: STANDARDS.OPCUA,
    label: 'OPC UA',
    hint: 'Companion specification data points — OPC 40001 Machinery and OPC 40010 Robotics.'
  },
  {
    value: STANDARDS.ASHRAE223,
    label: 'ASHRAE 223P',
    hint: 'Building systems — HVAC, electrical and the sensing around them. The standard is still in public review, so its concepts may change.'
  },
  {
    value: STANDARDS.CUSTOM,
    label: 'Custom (local extension)',
    hint: 'Not drawn from a standard vocabulary. Recorded with no provenance, which every standard here permits.'
  }
]

/**
 * The AAS (IEC 63278) Reference types `semantic_id_type` may take. Mirrors the CHECK constraint in
 * 0001_baseline_schema.sql; keep the two in step.
 */
export const SEMANTIC_ID_TYPES = ['IRI', 'IRDI', 'ModelReference']

/** The type to assume for a semantic id that looks like a URL. Every seeded id is one. */
export const DEFAULT_SEMANTIC_ID_TYPE = 'IRI'

/**
 * The namespace this deployment mints semantic ids under. Local and visibly so: neither MTConnect
 * nor ISO publishes resolvable per-concept IRIs, and an id in their namespace would assert an
 * interoperability that does not exist.
 */
export const LOCAL_SEMANTIC_NAMESPACE = 'https://aber.local/semantics'

/**
 * MTConnect concept namespace, pinned to the major version: the vocabulary is generated from schema
 * 2.8, and an id that changed on every regeneration would not be an identifier.
 */
export const MTCONNECT_SEMANTIC_NAMESPACE = `${LOCAL_SEMANTIC_NAMESPACE}/mtconnect/v2.0`

/** ISO 22400 KPI namespace. The ids seeded by archived migration 0030 are built on this. */
export const ISO22400_SEMANTIC_NAMESPACE = `${LOCAL_SEMANTIC_NAMESPACE}/iso22400`

/**
 * The semantic id for an MTConnect metric: its data item type's vocabulary id, so `Axes/X/POSITION`
 * and `Axes/Y/POSITION` name one concept (#457). The component path, instance and subType stay in
 * the name and `sub_type`. Callers pass nothing for a custom type, which has no vocabulary id.
 */
export function mtconnectSemanticId(dataItemType) {
  return mtconnectVocabularySemanticId('DATA_ITEM_TYPE', dataItemType)
}

/**
 * The kind segment used by `mtconnect_vocabulary.semantic_id`. Mirrors KIND_SEGMENT in
 * scripts/generate-mtconnect-vocabulary.mjs; check-mirror-drift.mjs check 8 compares the result.
 */
const VOCABULARY_KIND_SEGMENT = {
  DATA_ITEM_TYPE: 'DataItemType',
  COMPONENT: 'Component',
  SUB_TYPE: 'SubType',
  UNIT: 'Unit',
  NATIVE_UNIT: 'NativeUnit'
}

/**
 * The concept-level semantic id for an MTConnect vocabulary entry, scoped by kind because `(kind,
 * name)` is the table's key.
 */
export function mtconnectVocabularySemanticId(kind, name) {
  const n = (name || '').trim()
  if (!n) return ''
  return `${MTCONNECT_SEMANTIC_NAMESPACE}/${VOCABULARY_KIND_SEGMENT[kind] || kind}/${n}`
}

/**
 * Best guess at which kind of AAS Reference an identifier is. Conservative: it recognises the two
 * unambiguous shapes and leaves the rest to the operator. An IRDI looks like
 * `0173-1#02-AAO677#002`.
 */
export function inferSemanticIdType(value) {
  const v = (value || '').trim()
  if (!v) return ''
  if (/^https?:\/\//i.test(v) || /^urn:/i.test(v)) return 'IRI'
  if (/^\d{4}-[^#]*#[^#]+#\d+$/.test(v)) return 'IRDI'
  return ''
}

/** Display label for a `standard` value as stored (NULL/'' meaning a local extension). */
export const LOCAL_EXTENSION_LABEL = 'Local extension'

export function standardLabel(standard) {
  return standard || LOCAL_EXTENSION_LABEL
}
