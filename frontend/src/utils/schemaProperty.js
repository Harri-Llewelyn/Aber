import { datatypeToJsonSchemaType } from './sparkplugDatatype'

/**
 * A metric's entry in a schema's `properties`, as both schema builders write it from its catalog
 * row: the JSON type, the catalog's description, the catalog's permitted values as `enum`, and the
 * valid range typed in the builder as `minimum` and `maximum`. ingestion/conformance.py reads these
 * keys; test-harness/fixtures/schema-builder-output.json holds the builders' output and ingestion's
 * reading of it to one answer. The catalog's permitted-values field is parsed here too, because
 * what a value may be follows from the same datatype.
 */

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// A decimal number as a person types it. Number() alone also takes '', '0x10' and 'Infinity'.
const NUMBER_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

/** The number a text spells, or undefined when it spells none. */
function numberFrom(text) {
  const t = String(text ?? '').trim()
  if (!NUMBER_TEXT.test(t)) return undefined
  const n = Number(t)
  return Number.isFinite(n) ? n : undefined
}

/** The JSON Schema types that take a range. */
export const isNumericType = (type) => type === 'number' || type === 'integer'

/**
 * Whether a metric of this Sparkplug datatype takes a permitted-values list: the integer and float
 * codes, Boolean and String (1-12). A float's values are whole numbers (parsePermittedValues).
 */
export function permittedValuesApply(datatype) {
  return Number.isInteger(datatype) && datatype >= 1 && datatype <= 12
}

/** The column's value as the field shows it: the values separated by commas. */
export const permittedValuesText = (values) => (Array.isArray(values) ? values.join(', ') : '')

/**
 * The field's text as `metric_catalog.permitted_values`: strings, repeats removed, or null for an
 * empty field (the column holds NULL, never an empty list). A numeric metric's values are whole
 * numbers in one spelling ('2', never '2.0'), so the Out of vocabulary tag's string comparison and
 * ingestion's numeric one agree; a Boolean's are true and false. `error` names the first value the
 * datatype cannot carry.
 *
 * @returns {{ values: string[]|null, error: string|null }}
 */
export function parsePermittedValues(text, datatype) {
  const parts = String(text ?? '').split(',').map(s => s.trim()).filter(Boolean)
  if (parts.length === 0) return { values: null, error: null }

  const type = datatypeToJsonSchemaType(datatype)
  const values = []
  for (const part of parts) {
    let value = part
    if (type === 'boolean') {
      value = part.toLowerCase()
      if (value !== 'true' && value !== 'false') {
        return { values: null, error: `A Boolean metric's values are true and false. "${part}" is neither.` }
      }
    } else if (type === 'number') {
      const n = numberFrom(part)
      if (n === undefined || !Number.isSafeInteger(n)) {
        return { values: null, error: `A numeric metric's values are whole numbers. "${part}" is not one.` }
      }
      value = String(n)
    }
    if (!values.includes(value)) values.push(value)
  }
  return { values, error: null }
}

/** Whether two `permitted_values` hold the same list, in the same order. NULL and [] are one. */
export function samePermittedValues(a, b) {
  const x = Array.isArray(a) ? a : []
  const y = Array.isArray(b) ? b : []
  return x.length === y.length && x.every((v, i) => v === y[i])
}

/** One catalog value as the JSON type a property declares, or undefined when it cannot be one. */
function typedValue(raw, type) {
  const text = String(raw)
  if (type === 'string') return text
  if (type === 'boolean') {
    const lower = text.trim().toLowerCase()
    return lower === 'true' ? true : lower === 'false' ? false : undefined
  }
  if (isNumericType(type)) {
    const n = numberFrom(text)
    return n === undefined || (type === 'integer' && !Number.isInteger(n)) ? undefined : n
  }
  return undefined
}

/**
 * The catalog's permitted values as an `enum` of the property's type, or null when there is no
 * closed set to write. A value the type cannot carry is left out: no reading of that type equals it.
 */
export function enumFor(values, type) {
  if (!Array.isArray(values)) return null
  const out = []
  for (const raw of values) {
    const v = typedValue(raw, type)
    if (v !== undefined && !out.includes(v)) out.push(v)
  }
  return out.length > 0 ? out : null
}

/** A bound as typed: a number, null when blank, undefined when it is not a number. */
export function boundFrom(text) {
  if (String(text ?? '').trim() === '') return null
  return numberFrom(text)
}

/** A stored bound as the builder's field shows it; blank when there is none. */
export const boundText = (value) =>
  (typeof value === 'number' && Number.isFinite(value) ? String(value) : '')

/** What is wrong with a range as typed, or null. */
export function rangeError(range) {
  if (!range) return null
  const minimum = boundFrom(range.minimum)
  const maximum = boundFrom(range.maximum)
  if (minimum === undefined) return 'The minimum is not a number.'
  if (maximum === undefined) return 'The maximum is not a number.'
  if (minimum !== null && maximum !== null && minimum > maximum) return 'The minimum is above the maximum.'
  return null
}

/**
 * A metric's `properties` entry. `stored` is the entry a saved definition holds, or undefined for a
 * metric being added. `description` and `enum` are always the catalog row's, and absent when it has
 * none: a stale list would go on dropping readings the catalog now allows on a device set to
 * Enforce. Every other stored key stays, `type` included. `range` is `{ minimum, maximum }` as typed,
 * or undefined when untouched, which leaves stored bounds as they are; a blank bound removes it.
 * Only a numeric property takes a range. Check a range with rangeError() before calling this.
 */
export function catalogPropertyEntry(metric, { stored, range } = {}) {
  const catalogType = datatypeToJsonSchemaType(metric?.datatype)
  const entry = isPlainObject(stored) ? { ...stored } : { type: catalogType }
  const type = typeof entry.type === 'string' ? entry.type : catalogType

  const description = typeof metric?.description === 'string' ? metric.description.trim() : ''
  if (description) entry.description = description
  else delete entry.description

  const values = enumFor(metric?.permitted_values, type)
  if (values) entry.enum = values
  else delete entry.enum

  if (range && isNumericType(type)) {
    for (const key of ['minimum', 'maximum']) {
      const bound = boundFrom(range[key])
      if (bound === null) delete entry[key]
      else if (bound !== undefined) entry[key] = bound
    }
  }
  return entry
}

/** Whether two JSON values are equal, objects compared by key whatever their order. */
export function sameJson(a, b) {
  if (a === b) return true
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((v, i) => sameJson(v, b[i]))
  }
  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length &&
      keys.every(k => Object.hasOwn(b, k) && sameJson(a[k], b[k]))
  }
  return false
}
