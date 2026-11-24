/**
 * How a typed search finds a schema: null when it does not, else `{ metrics }`, the metrics it was
 * found by, which is none when the schema's own name or description says it. `needle` is trimmed and
 * in lower case. A metric named in full comes before one the needle is only part of.
 */
export function schemaHit(schema, metrics, needle) {
  const has = (text) => String(text || '').toLowerCase().includes(needle)
  if (!needle || has(schema.schema_name) || has(schema.description)) return { metrics: [] }
  const found = metrics.filter(has)
  if (found.length === 0) return null
  const whole = (name) => name.toLowerCase() === needle
  return { metrics: [...found.filter(whole), ...found.filter(name => !whole(name))] }
}
