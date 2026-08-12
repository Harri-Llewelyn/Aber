/**
 * Schema conformance of a device's declared metrics, derived at read time.
 *
 * `devices.last_birth_metrics` is what the device declared in its most recent DBIRTH, written
 * by ingestion.py. Which of those metrics its assigned schema fails to account for is worked
 * out here rather than stored, so that editing a schema reclassifies its devices immediately
 * instead of at their next birth -- rebirths are rare by design and may be weeks apart. Same
 * client-side, no-backend-cron pattern as deviceProvisioning.js and gatewayStatus.js.
 */

import { deriveMetricGroup } from './metricGroup'

/**
 * The metric names a schema accounts for.
 *
 * `schema_definition` is free-form JSONB: only schemas produced by the Schema Builder are
 * guaranteed the `{ type, properties, required }` shape. Schemas seeded by a migration, or written
 * straight to PostgREST, may carry either key or neither -- the builder being the only path in the
 * UI does not make it the only path into the column. The union of both is taken so a schema listing
 * metrics in only one of them is still read correctly.
 *
 * Returns null -- not an empty set -- when neither key is present. That is "this schema cannot
 * be evaluated", which is a different answer from "this schema models nothing", and the
 * difference decides whether a device gets flagged. See unmodelledMetrics().
 *
 * MIRRORED BY `modelled_metrics()` IN `ingestion/validate.py`, and the two are held together by
 * `tests/fixtures/modelled-metrics.json` -- see `__tests__/modelledMetricsContract.test.js`.
 */
export function modelledMetrics(schema) {
  const def = schema?.schema_definition
  if (!def) return null

  // `!Array.isArray` IS LOAD-BEARING, and its absence was a live divergence from the Python
  // mirror rather than a hypothetical one. `typeof [] === 'object'`, so an array reached
  // `Object.keys`, which yields its INDICES -- a schema with `properties: ['Temp','Pressure']`
  // was read here as modelling two metrics named '0' and '1', so nearly everything the device
  // published came back Unmodelled, while validate.py read the same schema as having no model at
  // all. An array is not a valid JSON Schema `properties` object; it contributes nothing.
  const hasProperties =
    def.properties && typeof def.properties === 'object' && !Array.isArray(def.properties)
  const properties = hasProperties ? Object.keys(def.properties) : []
  const required = Array.isArray(def.required) ? def.required : []
  if (properties.length === 0 && required.length === 0) return null

  return new Set([...properties, ...required])
}

/**
 * Metrics the device declared that its schema does not account for.
 *
 * Empty when the device conforms, when it has never been seen, when it has no schema, or when
 * the schema cannot be evaluated. Those last two are deliberately *not* treated as "everything
 * is unmodelled": "publishes beyond its model" and "has no model" are different findings, and
 * conflating them would flag every unschematised device until the tag meant nothing.
 */
export function unmodelledMetrics(device, schemaOrSchemas) {
  const declared = device?.last_birth_metrics
  if (!Array.isArray(declared) || declared.length === 0) return []

  // Across every attached submodel: a metric modelled by any one of them is modelled. Judging
  // against a single schema would flag a device for publishing what another of its own submodels
  // accounts for.
  const modelled = modelledMetricsAcross(schemaOrSchemas)
  if (!modelled) return []

  return declared.filter(name => !modelled.has(name))
}

/** True when the device declared at least one metric outside its assigned schema. */
export function hasUnmodelledMetrics(device, schemaOrSchemas) {
  return unmodelledMetrics(device, schemaOrSchemas).length > 0
}

/**
 * Resolve the schema assigned to a device from a loaded schema list.
 *
 * The list comes from `/api/v1/schemas`, which keys rows as `schema_uuid`; `devices.schema_id`
 * holds the same value.
 */
export function schemaForDevice(device, schemas) {
  if (!device?.schema_id) return null
  return (schemas || []).find(s => s.schema_uuid === device.schema_id) || null
}

/**
 * Every schema attached to a device, as an array.
 *
 * Reads `submodel_schema_ids` -- the device_submodels join added in migration 0034, one AAS
 * Submodel per entry -- and falls back to the 1:1 `schema_id` for a device that has no rows there.
 * The fallback is what lets a device provisioned by any path still resolve, and is why 0034 keeps
 * `devices.schema_id` rather than dropping it.
 *
 * Returns [] rather than [null] when nothing is attached, so "has no model" stays distinguishable
 * from "has a model that could not be found".
 */
export function schemasForDevice(device, schemas) {
  const ids = Array.isArray(device?.submodel_schema_ids) && device.submodel_schema_ids.length > 0
    ? device.submodel_schema_ids
    : (device?.schema_id ? [device.schema_id] : [])

  const byId = new Map((schemas || []).map(s => [s.schema_uuid, s]))
  return ids.map(id => byId.get(id)).filter(Boolean)
}

/**
 * Normalise the second argument of every derived function below.
 *
 * They each take "the device's schema(s)" and were written when that was exactly one. Accepting
 * either shape keeps every existing call site correct while multi-submodel callers pass an array,
 * rather than forcing a simultaneous edit of six components and their tests.
 */
function asSchemaList(schemaOrSchemas) {
  if (Array.isArray(schemaOrSchemas)) return schemaOrSchemas.filter(Boolean)
  return schemaOrSchemas ? [schemaOrSchemas] : []
}

/**
 * The union of every metric modelled across a device's schemas, or null when none of them can be
 * evaluated. Null rather than an empty set for the same reason modelledMetrics() returns it: "no
 * evaluable model" and "models nothing" decide different things.
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

/** The tag applied to a device publishing metrics its schema does not account for. */
export const UNMODELLED_TAG = 'Unmodelled'

/**
 * The device-type tags implied by its schema: the distinct groups of the metrics that schema
 * models. A schema covering `Axes/C/ANGLE` and `Environmental/HUMIDITY_RELATIVE` tags its devices
 * both `Axes` and `Environmental` -- multiple tags without needing multiple schemas.
 *
 * Drawn from the *schema*, not from what the device was last seen publishing. Two consequences,
 * both wanted:
 *   - a provisioned device is tagged before its first birth, so it can be found by tag while you
 *     are still waiting for it to appear;
 *   - a metric the device publishes but its schema does not model contributes no tag. It reports
 *     as Unmodelled instead, which is the signal to fix the schema -- letting it quietly confer
 *     its group would legitimise the drift and hide it.
 */
export function deviceGroupTags(device, schemaOrSchemas) {
  const modelled = modelledMetricsAcross(schemaOrSchemas)
  if (!modelled) return []

  const groups = new Set()
  for (const name of modelled) {
    const group = deriveMetricGroup(name)
    if (group) groups.add(group)
  }
  return [...groups].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
}

/** The tag applied to a device reporting a value outside its metric's declared vocabulary. */
export const OUT_OF_VOCABULARY_TAG = 'Out of vocabulary'

/**
 * Metrics whose last reported value is not in the vocabulary their catalog entry declares.
 *
 * DERIVED, NEVER STORED -- same as Unmodelled above, gateway staleness and resolved device
 * location. Nothing writes this and no migration records it: it is a comparison between two things
 * already on screen, and the moment it were stored it could disagree with either.
 *
 * The failure it makes visible is a quiet one. A device publishing `RUNNING` where MTConnect says
 * `ACTIVE` sends a valid string in a valid DDATA against a real metric, so ingestion accepts it,
 * the historian stores it, and a dashboard renders it -- and every downstream consumer that keys
 * on the state is silently wrong. This actually happened here: the Node-RED demo flow set
 * `Controller/EXECUTION` to `RUNNING`, a value MTConnect does not define.
 *
 * `latestValues` is `metric_name -> last reported value` for this device, from `telemetry_latest`.
 * Absent or empty means no finding -- "we have not looked" and "we looked and it is fine" are
 * different, and only the second deserves a clean bill.
 *
 * A metric with no `permitted_values` is unconstrained and never contributes: most metrics are,
 * and every continuous SAMPLE is.
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
    // Compared as strings because a discrete Sparkplug metric is published as one, and the
    // vocabulary is a list of strings. A numeric enum would compare on its rendered form, which
    // is what the historian holds anyway.
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
 * Every tag a device carries: its schema's metric groups, plus `Unmodelled` when it declared
 * metrics outside that schema, plus `Out of vocabulary` when it reported a value its metric does
 * not permit. Ordered with the two findings last, since they are findings rather than
 * classifications.
 *
 * `latestValues` and `catalog` are optional: a caller that has not loaded telemetry gets the tags
 * it can actually justify rather than a silently absent finding.
 */
export function deviceTagList(device, schemaOrSchemas, latestValues, catalog) {
  const tags = deviceGroupTags(device, schemaOrSchemas)
  if (hasUnmodelledMetrics(device, schemaOrSchemas)) tags.push(UNMODELLED_TAG)
  if (hasOutOfVocabularyValues(latestValues, catalog)) tags.push(OUT_OF_VOCABULARY_TAG)
  return tags
}

/** Whether a device carries a given tag. */
export function deviceHasTag(device, schemaOrSchemas, tag, latestValues, catalog) {
  if (!tag) return true
  return deviceTagList(device, schemaOrSchemas, latestValues, catalog).includes(tag)
}

/**
 * Every tag present across a fleet, for populating a filter. Unmodelled is offered only when at
 * least one device actually has it -- an empty finding is not worth a filter option.
 */
/**
 * `latestFor` is a FUNCTION from device to its last reported values, not a map, because telemetry
 * is keyed on `sparkplug_id` while a device row is keyed on its uuid. Passing the map would put
 * that mismatch in every caller, and getting it wrong produces no finding rather than an error --
 * a filter option that silently never appears.
 */
export function availableTags(devices, schemas, latestFor, catalog) {
  const groups = new Set()
  let anyUnmodelled = false
  let anyOutOfVocabulary = false

  for (const device of devices || []) {
    const attached = schemasForDevice(device, schemas)
    for (const tag of deviceGroupTags(device, attached)) groups.add(tag)
    if (!anyUnmodelled && hasUnmodelledMetrics(device, attached)) anyUnmodelled = true
    if (!anyOutOfVocabulary && typeof latestFor === 'function') {
      anyOutOfVocabulary = hasOutOfVocabularyValues(latestFor(device), catalog)
    }
  }

  const sorted = [...groups].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  if (anyUnmodelled) sorted.push(UNMODELLED_TAG)
  if (anyOutOfVocabulary) sorted.push(OUT_OF_VOCABULARY_TAG)
  return sorted
}
