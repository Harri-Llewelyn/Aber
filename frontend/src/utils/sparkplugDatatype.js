import { SPARKPLUG_TYPES } from '../constants'

/**
 * Datatype choices offered when adding a metric catalog entry -- scoped to what the app actually
 * produces/consumes today (Double, Boolean, String), not the full Sparkplug type list. Label
 * lookups for an arbitrary code use the full SPARKPLUG_TYPES map from constants.js instead of
 * duplicating it here.
 */
export const SPARKPLUG_DATATYPES = [
  { code: 10, label: 'Double' },
  { code: 11, label: 'Boolean' },
  { code: 12, label: 'String' }
]

export function datatypeLabel(code) {
  return SPARKPLUG_TYPES[code] || `Unknown (${code})`
}

/** Sparkplug datatype code -> JSON Schema `type`, for building a schema_definition.properties entry. */
export function datatypeToJsonSchemaType(code) {
  if (code === 11) return 'boolean'
  if (code === 12) return 'string'
  return 'number'
}

/**
 * Sparkplug B datatype code -> AAS `DataTypeDefXsd`, for a Submodel `Property.valueType`.
 *
 * This is the fourth type system a metric passes through (Sparkplug code -> JSON Schema type ->
 * MTConnect units -> XSD), which is why every mapping lives in this one file rather than being
 * inlined wherever it happens to be needed.
 *
 * NOTE: there is no `xs:int32`. AAS V3's DataTypeDefXsd enumerates the XML Schema built-ins, where
 * a 32-bit signed integer is `xs:int` (`xs:integer` is the *unbounded* one, a different type). A
 * Property carrying an invented type name is an invalid AAS document, and unlike a wrong unit it
 * fails at the consumer rather than here -- the same reason `semantic_id_type` is CHECK-constrained
 * in the baseline (the constraint arrived in the pre-beta chain as
 * `supabase/migrations/archive/20260101000029_semantic_identifiers.sql` and is squashed into
 * `0001_baseline_schema.sql`).
 *
 * Codes above 12 are mapped even though `SPARKPLUG_TYPES` stops at 14: `metric_catalog.datatype`
 * is a plain INT with no constraint, so an unrecognised code is reachable and must degrade rather
 * than emit `undefined`.
 *
 * MUST stay in step with supabase/functions/aas-export/sparkplugToXsd.ts -- the edge function
 * cannot import from this bundle. `test_aas_export.py` parses both files and fails if they drift,
 * the same keep-in-step discipline utils/metricGroup.js has against its SQL.
 */
export const SPARKPLUG_XSD_TYPES = {
  1: 'xs:byte',           // Int8
  2: 'xs:short',          // Int16
  3: 'xs:int',            // Int32  -- not `xs:int32`, which is not an XSD type
  4: 'xs:long',           // Int64
  5: 'xs:unsignedByte',   // UInt8
  6: 'xs:unsignedShort',  // UInt16
  7: 'xs:unsignedInt',    // UInt32
  8: 'xs:unsignedLong',   // UInt64
  9: 'xs:float',          // Float
  10: 'xs:double',        // Double
  11: 'xs:boolean',       // Boolean
  12: 'xs:string',        // String
  13: 'xs:dateTime',      // DateTime
  14: 'xs:string',        // Text -- XSD has no separate long-text type
  15: 'xs:string',        // UUID
  17: 'xs:base64Binary',  // Bytes
  18: 'xs:base64Binary'   // File
}

/** The type an unmappable code degrades to. Lossless: any value has a string form. */
export const DEFAULT_XSD_TYPE = 'xs:string'

/**
 * The AAS `valueType` for a Sparkplug datatype code.
 *
 * Unknown and structured codes (16 DataSet, 19 Template) fall back to `xs:string` rather than
 * throwing: an export that drops one metric is far less useful than one that carries it in a
 * lossless form, and a Property is a scalar so a DataSet has no faithful representation anyway.
 */
export function sparkplugToXsd(code) {
  // `??`, NOT `||`, and matched to sparkplugToXsd.ts so the two cannot answer differently.
  // No value in the table is falsy today, which is exactly why the difference was invisible --
  // and why it is worth removing rather than reasoning about again the first time one is.
  return SPARKPLUG_XSD_TYPES[code] ?? DEFAULT_XSD_TYPE
}
