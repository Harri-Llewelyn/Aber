import { SPARKPLUG_TYPES } from '../constants'

/**
 * Datatype choices offered when adding a metric catalog entry: the types the app produces and
 * consumes, not the full Sparkplug list. Label lookups for an arbitrary code use SPARKPLUG_TYPES
 * from constants.js.
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
 * Sparkplug B datatype code to AAS `DataTypeDefXsd`, for a Submodel `Property.valueType`. There is
 * no `xs:int32`: a 32-bit signed integer is `xs:int`, and `xs:integer` is the unbounded type. Codes
 * above 12 are mapped because `metric_catalog.datatype` is an unconstrained INT. Must stay in step
 * with supabase/functions/_shared/aas/sparkplugToXsd.ts; `test_aas_export.py` parses both and fails
 * on drift.
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
 * The AAS `valueType` for a Sparkplug datatype code. Unknown and structured codes (16 DataSet, 19
 * Template) fall back to `xs:string` rather than throwing, so an export carries the metric
 * losslessly.
 */
export function sparkplugToXsd(code) {
  // `??`, not `||`, matched to sparkplugToXsd.ts so the two cannot answer differently.
  return SPARKPLUG_XSD_TYPES[code] ?? DEFAULT_XSD_TYPE
}
