/**
 * Sparkplug B datatype code -> AAS `DataTypeDefXsd`, for a Submodel `Property.valueType`.
 *
 * Deliberate duplicate of SPARKPLUG_XSD_TYPES in frontend/src/utils/sparkplugDatatype.js. An edge
 * function runs in its own Deno isolate with only this directory mounted, so it cannot import from
 * the frontend bundle -- the same reason ingestion/validate.py carries a Python mirror of
 * utils/deviceTags.js. `test_aas_export.py` parses both files and fails if they drift.
 *
 * NOTE: there is no `xs:int32`. AAS V3's DataTypeDefXsd enumerates the XML Schema built-ins, where
 * a 32-bit signed integer is `xs:int`. A Property carrying an invented type name is an invalid AAS
 * document, and it fails at the consumer rather than here.
 */
export const SPARKPLUG_XSD_TYPES: Record<number, string> = {
  1: "xs:byte",           // Int8
  2: "xs:short",          // Int16
  3: "xs:int",            // Int32  -- not `xs:int32`, which is not an XSD type
  4: "xs:long",           // Int64
  5: "xs:unsignedByte",   // UInt8
  6: "xs:unsignedShort",  // UInt16
  7: "xs:unsignedInt",    // UInt32
  8: "xs:unsignedLong",   // UInt64
  9: "xs:float",          // Float
  10: "xs:double",        // Double
  11: "xs:boolean",       // Boolean
  12: "xs:string",        // String
  13: "xs:dateTime",      // DateTime
  14: "xs:string",        // Text -- XSD has no separate long-text type
  15: "xs:string",        // UUID
  17: "xs:base64Binary",  // Bytes
  18: "xs:base64Binary",  // File
};

/** The type an unmappable code degrades to. Lossless: any value has a string form. */
export const DEFAULT_XSD_TYPE = "xs:string";

/**
 * The AAS `valueType` for a Sparkplug datatype code.
 *
 * Unknown and structured codes (16 DataSet, 19 Template) fall back to `xs:string` rather than
 * throwing: an export that drops one metric is far less useful than one that carries it in a
 * lossless form, and a Property is a scalar so a DataSet has no faithful representation anyway.
 */
export function sparkplugToXsd(code: number | null | undefined): string {
  if (code === null || code === undefined) return DEFAULT_XSD_TYPE;
  return SPARKPLUG_XSD_TYPES[code] ?? DEFAULT_XSD_TYPE;
}
