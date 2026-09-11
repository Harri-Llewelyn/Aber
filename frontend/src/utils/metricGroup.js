/**
 * Top-level grouping of catalog metrics by their path-style name. `metric_catalog.metric_group` is
 * a generated column deriving the first path segment; this module mirrors it so unsaved rows can be
 * grouped, and falls back to the stored column when present. Keep deriveMetricGroup() in step with
 * the SQL. '/' is the separator Sparkplug B, Factory+ and MTConnect already use. Only the first
 * segment is a group; deeper segments are display detail.
 */

export const METRIC_GROUP_SEPARATOR = '/'

/** Rendered for metrics whose name carries no separator. The column itself is NULL, not this. */
export const UNGROUPED_LABEL = 'Ungrouped'

/**
 * The group a metric name belongs to, or null without a separator. Mirror of the SQL: `CASE WHEN
 * strpos(name, '/') > 0 THEN NULLIF(split_part(name, '/', 1), '') END`.
 */
export function deriveMetricGroup(name) {
  if (typeof name !== 'string') return null
  const index = name.indexOf(METRIC_GROUP_SEPARATOR)
  if (index <= 0) return null
  return name.slice(0, index)
}

/** The group of a catalog row, preferring the stored column over local derivation. */
export function metricGroupOf(metric) {
  if (!metric) return null
  return metric.metric_group || deriveMetricGroup(metric.name)
}

/**
 * Bucket catalog rows into display groups, ordered case-insensitively with the ungrouped bucket
 * last. Returns `[{ key, label, isUngrouped, metrics }]`; `key` is null for the ungrouped bucket.
 */
export function groupCatalog(metrics) {
  const buckets = new Map()

  for (const metric of metrics || []) {
    const key = metricGroupOf(metric)
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(metric)
  }

  const named = [...buckets.keys()].filter(k => k !== null)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))

  const ordered = buckets.has(null) ? [...named, null] : named

  return ordered.map(key => ({
    key,
    label: key === null ? UNGROUPED_LABEL : key,
    isUngrouped: key === null,
    metrics: buckets.get(key)
      .slice()
      .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }))
  }))
}

/**
 * Every distinct group in the catalog, in groupCatalog() order; the ungrouped bucket is not a
 * group.
 */
export function catalogGroups(metrics) {
  return groupCatalog(metrics).filter(g => !g.isUngrouped).map(g => g.key)
}

/**
 * The group names the Add Metric form may offer: the `metric_groups` registry plus any group
 * already used in the catalog. Registry casing wins on a collision, since the database trigger
 * treats it as canonical.
 */
export function knownGroupNames(registry, metrics) {
  const seen = new Map()  // lower -> display casing
  for (const group of registry || []) {
    if (group?.name) seen.set(group.name.toLowerCase(), group.name)
  }
  for (const key of catalogGroups(metrics)) {
    if (!seen.has(key.toLowerCase())) seen.set(key.toLowerCase(), key)
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
}

/** Rendered for a group with no `standard` recorded — a local addition, not a standard one. */
export const LOCAL_STANDARD_LABEL = 'Local'

/** The group picker's options bucketed by standard, local groups last. */
export function groupOptionsByStandard(registry, metrics) {
  const standardOf = new Map(
    (registry || []).filter(g => g?.name).map(g => [g.name.toLowerCase(), g.standard || null])
  )

  const buckets = new Map()
  for (const name of knownGroupNames(registry, metrics)) {
    const label = standardOf.get(name.toLowerCase()) || LOCAL_STANDARD_LABEL
    if (!buckets.has(label)) buckets.set(label, [])
    buckets.get(label).push(name)
  }

  const named = [...buckets.keys()].filter(k => k !== LOCAL_STANDARD_LABEL).sort()
  const ordered = buckets.has(LOCAL_STANDARD_LABEL) ? [...named, LOCAL_STANDARD_LABEL] : named
  return ordered.map(label => ({ label, names: buckets.get(label) }))
}

/**
 * The group picker's options narrowed to one standard, plus local groups. A separate function
 * because groupOptionsByStandard()'s contract is every known group. Local groups are always
 * included: `metric_groups.standard` records where a group came from, not what may use it. An empty
 * `standard` is the Custom option, which leaves local groups only.
 */
export function groupOptionsForStandard(registry, metrics, standard) {
  const buckets = groupOptionsByStandard(registry, metrics)
  if (!standard) return buckets.filter(b => b.label === LOCAL_STANDARD_LABEL)
  return buckets.filter(b => b.label === standard || b.label === LOCAL_STANDARD_LABEL)
}

/**
 * Resolve a typed group name against the known vocabulary, case-insensitively, returning the
 * existing spelling. `enforce_metric_group_spelling` rejects the fork in the database; this makes
 * the form agree with it.
 */
export function canonicaliseGroup(input, knownGroups) {
  const trimmed = (input || '').trim()
  if (!trimmed) return ''
  const match = (knownGroups || []).find(g => g.toLowerCase() === trimmed.toLowerCase())
  return match || trimmed
}

/**
 * Join name parts into a metric name, dropping empty ones. Standard-agnostic: MTConnect, OPC UA and
 * ISO 22400 compose different numbers of parts through one composer.
 */
export function composeMetricName(...parts) {
  return parts
    .flat()
    .map(part => (part || '').trim())
    .filter(Boolean)
    .join(METRIC_GROUP_SEPARATOR)
}

/**
 * The Factory+ metric-name format: '/'-delimited segments of alphanumerics and underscore. Mirror
 * of `metric_catalog_name_format`, which is the authority; this tells the operator at the form
 * rather than by a 400.
 */
const METRIC_NAME_PATTERN = /^[A-Za-z0-9_]+(\/[A-Za-z0-9_]+)*$/

/**
 * Whether a composed name is usable. `name` is immutable once created, and `/ANGLE` would store a
 * NULL group while looking grouped.
 */
export function isValidMetricName(name) {
  return METRIC_NAME_PATTERN.test((name || '').trim())
}

/**
 * Why a name is unusable, or null. Separate from isValidMetricName() because the button needs a
 * boolean and the field needs a sentence.
 */
export function metricNameError(name) {
  const n = (name || '').trim()
  if (!n) return 'Enter a metric name.'
  if (isValidMetricName(n)) return null

  if (n.startsWith(METRIC_GROUP_SEPARATOR)) return 'A metric name cannot start with "/".'
  if (n.endsWith(METRIC_GROUP_SEPARATOR)) return 'A metric name cannot end with "/".'
  if (n.includes(METRIC_GROUP_SEPARATOR + METRIC_GROUP_SEPARATOR)) {
    return 'A metric name cannot contain an empty segment ("//").'
  }

  const bad = [...new Set(n.replace(/[A-Za-z0-9_/]/g, ''))]
  if (bad.length) {
    const shown = bad.map(c => (c === ' ' ? 'space' : `"${c}"`)).join(', ')
    return `Only letters, numbers and "_" are allowed inside a segment; "/" separates them. Remove: ${shown}.`
  }
  return 'Not a valid Factory+ metric name.'
}
