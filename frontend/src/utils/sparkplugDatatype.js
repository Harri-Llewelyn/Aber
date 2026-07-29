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
