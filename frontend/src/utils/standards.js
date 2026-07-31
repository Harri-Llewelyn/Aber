/**
 * The standards a catalog metric can be built from.
 *
 * `metric_catalog.standard` is provenance, not a constraint -- it records which vocabulary a metric
 * was named after, and NULL is a legitimate value meaning "local extension". Every standard adopted
 * here explicitly permits extension, so the Custom option is part of the design rather than an
 * escape hatch bolted on.
 *
 * The three are complementary, not alternatives, which is why the form offers a choice rather than
 * a migration path between them:
 *   MTConnect  -- machine tools: the component/data-item vocabulary (migration 0018)
 *   ISO 22400  -- computed KPIs, which MTConnect deliberately excludes (migration 0030)
 *   OPC UA     -- robotics and general machinery companion specs (migration 0031)
 */

export const STANDARDS = {
  MTCONNECT: 'MTConnect',
  ISO22400: 'ISO 22400',
  OPCUA: 'OPC UA',
  /** A local extension. Stored as NULL, not as the string 'Custom'. */
  CUSTOM: ''
}

/**
 * Options for the Standard selector, in the order they are offered. MTConnect leads because it is
 * the largest vocabulary and the one most metrics come from; Custom is last because it should be a
 * deliberate choice rather than the path of least resistance.
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
    value: STANDARDS.CUSTOM,
    label: 'Custom (local extension)',
    hint: 'Not drawn from a standard vocabulary. Recorded with no provenance, which every standard here permits.'
  }
]

/**
 * The AAS (IEC 63278) Reference types `semantic_id_type` may take.
 *
 * Mirrors the CHECK constraint in migration 20260101000029 -- keep the two in step, same obligation
 * as utils/sparkplugId.js and utils/metricGroup.js carry against their own migrations. An
 * unconstrained value would produce an invalid AAS Reference at export time rather than an error
 * here, which is the expensive place to discover it.
 */
export const SEMANTIC_ID_TYPES = ['IRI', 'IRDI', 'ModelReference']

/** The type to assume for a semantic id that looks like a URL. Every seeded id is one. */
export const DEFAULT_SEMANTIC_ID_TYPE = 'IRI'

/**
 * The namespace this deployment mints semantic ids under.
 *
 * Local by design and visibly so. Neither MTConnect nor ISO publishes resolvable per-concept IRIs,
 * and no maintained ECLASS/IEC CDD crosswalk to either is known, so an id minted in *their*
 * namespace would assert an interoperability that does not exist. `factoryplus.local` says plainly
 * whose identifier it is: stable, deterministic and resolvable within this deployment, which is
 * enough for an AAS export to emit today and cheap to replace by a single UPDATE if a published
 * crosswalk appears. What it does not do is make two organisations agree.
 */
export const LOCAL_SEMANTIC_NAMESPACE = 'https://factoryplus.local/semantics'

/**
 * MTConnect concept namespace, pinned to the *major* version.
 *
 * The vocabulary is generated from MTConnect schema 2.8 (`SCHEMA_VERSION` in
 * scripts/generate-mtconnect-vocabulary.mjs), but an id that changed every time the schema was
 * regenerated would defeat the point of having a stable identifier. The major line is the
 * granularity at which the concepts themselves actually change.
 */
export const MTCONNECT_SEMANTIC_NAMESPACE = `${LOCAL_SEMANTIC_NAMESPACE}/mtconnect/v2.0`

/** ISO 22400 KPI namespace. The ids seeded by migration 0030 are built on this. */
export const ISO22400_SEMANTIC_NAMESPACE = `${LOCAL_SEMANTIC_NAMESPACE}/iso22400`

/**
 * The semantic id for an MTConnect metric, derived from its full name.
 *
 * Mirror of the SQL in migration 20260101000032:
 *   'https://factoryplus.local/semantics/mtconnect/v2.0/' || name
 * Keep the two in step -- same obligation as utils/metricGroup.js and utils/sparkplugId.js carry.
 *
 * The *whole* name, not just the data item type: a catalog entry is a specific data item on a
 * specific component path (`Axes/C/ANGLE`), which is what an AAS SubmodelElement corresponds to.
 * The type-level concept id (`.../DataItemType/ANGLE`) lives on `mtconnect_vocabulary` instead.
 */
export function mtconnectSemanticId(metricName) {
  const name = (metricName || '').trim()
  if (!name) return ''
  return `${MTCONNECT_SEMANTIC_NAMESPACE}/${name}`
}

/** The kind segment used by `mtconnect_vocabulary.semantic_id`. Mirrors the CASE in 0032. */
const VOCABULARY_KIND_SEGMENT = {
  DATA_ITEM_TYPE: 'DataItemType',
  COMPONENT: 'Component',
  SUB_TYPE: 'SubType',
  UNIT: 'Unit',
  NATIVE_UNIT: 'NativeUnit'
}

/**
 * The concept-level semantic id for an MTConnect vocabulary entry.
 *
 * Scoped by kind because the MTConnect vocabularies are separate namespaces that can collide -- a
 * component and a data item type could share a name, and `(kind, name)` is the table's own key.
 */
export function mtconnectVocabularySemanticId(kind, name) {
  const n = (name || '').trim()
  if (!n) return ''
  return `${MTCONNECT_SEMANTIC_NAMESPACE}/${VOCABULARY_KIND_SEGMENT[kind] || kind}/${n}`
}

/**
 * Best guess at which kind of AAS Reference an identifier is, for prefilling the type alongside a
 * pasted id. Deliberately conservative: it recognises the two shapes that are unambiguous and
 * leaves everything else to the operator rather than guessing wrong and being believed.
 *
 * An IRDI (ISO/IEC 11179-6) looks like `0173-1#02-AAO677#002` -- a registration authority code, a
 * `#`-delimited item code, and a version.
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
