/**
 * Schema conformance of a device's declared metrics, derived at read time.
 * `devices.last_birth_metrics` is what the device declared in its last DBIRTH; which of those its
 * schema fails to account for is computed here, so editing a schema reclassifies its devices
 * immediately rather than at their next birth.
 */

import { deriveMetricGroup } from './metricGroup'

/**
 * The metric names a schema accounts for. `schema_definition` is free-form JSONB, so the union of
 * `properties` and `required` is taken. Returns null, not an empty set, when neither key is
 * present: cannot be evaluated is a different answer from models nothing, and decides whether a
 * device is flagged. Mirrored by `modelled_metrics()` in ingestion/validate.py, held together by
 * test-harness/fixtures/modelled-metrics.json.
 */
export function modelledMetrics(schema) {
  const def = schema?.schema_definition
  if (!def) return null

  // `!Array.isArray` is load-bearing: `typeof [] === 'object'`, and `Object.keys` on an array
  // yields its indices. An array is not a valid `properties` object and contributes nothing.
  const hasProperties =
    def.properties && typeof def.properties === 'object' && !Array.isArray(def.properties)
  const properties = hasProperties ? Object.keys(def.properties) : []
  const required = Array.isArray(def.required) ? def.required : []
  if (properties.length === 0 && required.length === 0) return null

  return new Set([...properties, ...required])
}

/**
 * Metrics the device declared that its schema does not account for. Empty when it conforms, has
 * never been seen, has no schema, or the schema cannot be evaluated: publishes beyond its model and
 * has no model are different findings.
 */
export function unmodelledMetrics(device, schemaOrSchemas) {
  const declared = device?.last_birth_metrics
  if (!Array.isArray(declared) || declared.length === 0) return []

  // Across every attached submodel: a metric modelled by any one of them is modelled.
  const modelled = modelledMetricsAcross(schemaOrSchemas)
  if (!modelled) return []

  return declared.filter(name => !modelled.has(name))
}

/** True when the device declared at least one metric outside its assigned schema. */
export function hasUnmodelledMetrics(device, schemaOrSchemas) {
  return unmodelledMetrics(device, schemaOrSchemas).length > 0
}

/**
 * The ids of every schema attached to a device: `submodel_schema_ids`, read from the
 * `device_schemas` view. No repeats; [] when nothing is attached.
 */
export function schemaIdsForDevice(device) {
  const fromView = Array.isArray(device?.submodel_schema_ids) ? device.submodel_schema_ids : []
  return [...new Set(fromView.filter(Boolean))]
}

/** Every schema attached to a device, as schema rows. Ids with no row in `schemas` are dropped. */
export function schemasForDevice(device, schemas) {
  const byId = new Map((schemas || []).map(s => [s.schema_uuid, s]))
  return schemaIdsForDevice(device).map(id => byId.get(id)).filter(Boolean)
}

/** Normalise the second argument of every derived function below: one schema or an array. */
function asSchemaList(schemaOrSchemas) {
  if (Array.isArray(schemaOrSchemas)) return schemaOrSchemas.filter(Boolean)
  return schemaOrSchemas ? [schemaOrSchemas] : []
}

/**
 * The union of every metric modelled across a device's schemas, or null when none can be evaluated.
 */
export function modelledMetricsAcross(schemaOrSchemas) {
  const list = asSchemaList(schemaOrSchemas)
  const union = new Set()
  let evaluable = false

  for (const schema of list) {
    const modelled = modelledMetrics(schema)
    if (!modelled) continue
    evaluable = true
    for (const name of modelled) union.add(name)
  }

  return evaluable ? union : null
}

/** The finding on a device publishing metrics its schema does not account for. */
export const UNMODELLED_TAG = 'Unmodelled'

/**
 * A device's metric groups: the distinct groups of the metrics its schemas model, sorted. Drawn
 * from the schema rather than from what the device last published, so a provisioned device has
 * them before its first birth and an unmodelled metric confers none. The findings against a device
 * are not groups; see deviceFindings().
 */
export function deviceTagList(device, schemaOrSchemas) {
  const modelled = modelledMetricsAcross(schemaOrSchemas)
  if (!modelled) return []

  const groups = new Set()
  for (const name of modelled) {
    const group = deriveMetricGroup(name)
    if (group) groups.add(group)
  }
  return [...groups].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
}

/** The finding on a device reporting a value outside its metric's declared vocabulary. */
export const OUT_OF_VOCABULARY_TAG = 'Out of vocabulary'

/**
 * Metrics whose last reported value is not in the vocabulary their catalog entry declares. Derived,
 * never stored. A device publishing `RUNNING` where MTConnect says `ACTIVE` passes ingestion unless
 * its schema carries the set as `enum`, and a schema published before the set was entered does not:
 * this is that device's only check. `latestValues` is
 * metric_name to last value from `telemetry_latest`; absent or empty means no finding, not a clean
 * bill. A metric with no `permitted_values` never contributes.
 */
export function outOfVocabularyMetrics(latestValues, catalog) {
  if (!latestValues || !catalog) return []
  const entries = latestValues instanceof Map ? [...latestValues] : Object.entries(latestValues)
  if (entries.length === 0) return []

  const domains = new Map()
  for (const metric of catalog) {
    const permitted = metric?.permitted_values
    if (Array.isArray(permitted) && permitted.length > 0) domains.set(metric.name, permitted)
  }
  if (domains.size === 0) return []

  const findings = []
  for (const [name, value] of entries) {
    const permitted = domains.get(name)
    if (!permitted) continue
    // Nothing reported is not a violation; it is the absence of evidence either way.
    if (value === null || value === undefined || value === '') continue
    // Compared as strings: a discrete Sparkplug metric is published as one, and the vocabulary is a
    // list of strings.
    if (!permitted.includes(String(value))) {
      findings.push({ name, value: String(value), permitted })
    }
  }
  return findings.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

/** True when at least one of the device's last reported values is outside its vocabulary. */
export function hasOutOfVocabularyValues(latestValues, catalog) {
  return outOfVocabularyMetrics(latestValues, catalog).length > 0
}

/**
 * The findings against a device, each with the metrics behind it: `Unmodelled` (metrics its last
 * birth declared that none of its schemas model) and `Out of vocabulary` (last values outside the
 * metric's permitted values). Every metric is `{ name }`; an Out of vocabulary one also carries
 * `value` and `permitted`. Empty when there is none. `latestValues` and `catalog` are optional:
 * without telemetry the second finding is absent rather than clean.
 */
export function deviceFindings(device, schemaOrSchemas, latestValues, catalog) {
  const findings = []
  const unmodelled = unmodelledMetrics(device, schemaOrSchemas)
  if (unmodelled.length > 0) findings.push({ tag: UNMODELLED_TAG, metrics: unmodelled.map(name => ({ name })) })
  const outside = outOfVocabularyMetrics(latestValues, catalog)
  if (outside.length > 0) findings.push({ tag: OUT_OF_VOCABULARY_TAG, metrics: outside })
  return findings
}

/** Whether a device carries a given metric group. */
export function deviceHasTag(device, schemaOrSchemas, tag) {
  if (!tag) return true
  return deviceTagList(device, schemaOrSchemas).includes(tag)
}

/** Every metric group present across a fleet, sorted, for a filter. */
export function availableTags(devices, schemas) {
  const groups = new Set()
  for (const device of devices || []) {
    for (const tag of deviceTagList(device, schemasForDevice(device, schemas))) groups.add(tag)
  }
  return [...groups].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
}
