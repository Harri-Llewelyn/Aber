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
 * The AAS (IEC 63278) Reference types `semantic_id_type` may take. Mirrors the CHECK constraints
 * 0012_a_semantic_id_is_an_iri_or_an_irdi.sql leaves on `schemas` and `metric_catalog`; keep them in
 * step. Both export as an ExternalReference, which is all the exporter can emit.
 */
export const SEMANTIC_ID_TYPES = ['IRI', 'IRDI']

/** The type to assume for a semantic id that looks like a URL. Every seeded catalog id is one. */
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

/** ISO 22400 KPI namespace. The ids seeded by archived migration 20260101000030_iso22400_vocabulary.sql are built on this. */
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
 * scripts/generate-mtconnect-vocabulary.mjs; check-mirror-drift.mjs check 7 compares the result.
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
 * One ISO/IEC 11179-6 IRDI: a registration authority (a four-digit ICD, then organisation parts
 * separated by `-` or `/`, some of them empty), a `#`, the data identifier, a `#`, the version.
 * ECLASS writes `0173-1#02-AAO677#002`, IEC CDD `0112/2///61987#ABA565#009`.
 */
const IRDI = String.raw`\d{4}(?:[-/][A-Za-z0-9_]*)*#[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*#\d+`

/** An IRDI, or several joined by `/` as an ECLASS property-value pair is. Anchored at both ends. */
const IRDI_PATH = new RegExp(`^${IRDI}(?:/${IRDI})*$`)

/**
 * Best guess at which kind of AAS Reference an identifier is. Conservative: it recognises the two
 * unambiguous shapes and leaves the rest to the operator.
 */
export function inferSemanticIdType(value) {
  const v = (value || '').trim()
  if (!v) return ''
  if (/^https?:\/\//i.test(v) || /^urn:/i.test(v)) return 'IRI'
  if (IRDI_PATH.test(v)) return 'IRDI'
  return ''
}

/**
 * A semantic id and its reference type as they are stored: the id trimmed, and no type without an
 * id. Forms compare this form of the pair to decide whether anything changed.
 */
export function storedSemanticIdPair(semanticId, semanticIdType) {
  const id = (semanticId || '').trim()
  return { semanticId: id, semanticIdType: id ? (semanticIdType || '') : '' }
}

/** Whether two `{ semanticId, semanticIdType }` pairs would be stored as the same pair. */
export function sameSemanticIdPair(a, b) {
  const x = storedSemanticIdPair(a?.semanticId, a?.semanticIdType)
  const y = storedSemanticIdPair(b?.semanticId, b?.semanticIdType)
  return x.semanticId === y.semanticId && x.semanticIdType === y.semanticIdType
}

/**
 * The reference type to show once the semantic id changes from `previousId` to `nextId`. A blank id
 * has no type. A type that agreed with the guess for the previous id follows the new guess, so
 * replacing an IRI with an IRDI retypes it; a type the operator chose against the guess is kept.
 */
export function followSemanticIdType(previousId, previousType, nextId) {
  if (!(nextId || '').trim()) return ''
  const guessed = !previousType || previousType === inferSemanticIdType(previousId)
  return guessed ? inferSemanticIdType(nextId) : previousType
}

/** Display label for a `standard` value as stored (NULL/'' meaning a local extension). */
export const LOCAL_EXTENSION_LABEL = 'Local extension'
