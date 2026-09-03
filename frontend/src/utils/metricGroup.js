/**
 * Top-level grouping of catalog metrics by their path-style name.
 *
 * `metric_catalog.metric_group` is a generated column deriving the first path segment of the
 * metric name (0001_baseline_schema.sql). This module mirrors that expression locally so the UI
 * can group rows that have not been round-tripped through the database yet, and falls back to the
 * stored column whenever it is present -- the same arrangement as utils/sparkplugId.js. Keep
 * deriveMetricGroup() in step with the SQL.
 *
 * The separator is '/' because that is what this platform's neighbours already use for hierarchy:
 * Sparkplug B's own reserved names ("Node Control/Rebirth", "Properties/Hardware Make"), Factory+
 * folders (which forbid '.' in a metric name segment outright), and MTConnect's component paths
 * ("Axes/C/ANGULAR_VELOCITY").
 *
 * Only the *first* segment is load-bearing. `Axes/C/ANGLE` and `Axes/X/POSITION` both group under
 * `Axes`; the rest of the path is display detail. Treating deeper segments as separate groups
 * would make the vocabulary unbounded, which is the thing grouping exists to fix.
 */

export const METRIC_GROUP_SEPARATOR = '/'

/** Rendered for metrics whose name carries no separator. The column itself is NULL, not this. */
export const UNGROUPED_LABEL = 'Ungrouped'

/**
 * The group a metric name belongs to, or null when it carries no separator.
 *
 * Mirror of the SQL: `CASE WHEN strpos(name, '/') > 0 THEN NULLIF(split_part(name, '/', 1), '') END`.
 * A name that merely starts with the separator has an empty first segment and so is ungrouped.
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
 * Bucket catalog rows into display groups.
 *
 * Groups are ordered case-insensitively with the ungrouped bucket last, so a catalog mid-migration
 * reads as "here are the categorised metrics, and here is what still needs categorising" rather
 * than burying `Ungrouped` under U. Metrics within a group keep name order.
 *
 * Returns `[{ key, label, isUngrouped, metrics }]`. `key` is null for the ungrouped bucket, which
 * is why it is returned alongside a separate label rather than relying on the label as an id.
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
 * Every distinct group present in the catalog, ordered as groupCatalog() orders them.
 * The ungrouped bucket contributes nothing -- it is not a group.
 */
export function catalogGroups(metrics) {
  return groupCatalog(metrics).filter(g => !g.isUngrouped).map(g => g.key)
}

/**
 * The group names the Add Metric form may offer: the curated `metric_groups` registry plus any
 * group already in use in the catalog.
 *
 * Both sources are needed. The registry alone would omit a group that entered the catalog through
 * the API without being registered; the catalog alone would offer nothing until a group is first
 * used, which is the bootstrapping problem the registry exists to solve. Registry casing wins on
 * a collision, since that is the spelling the database trigger treats as canonical.
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

/**
 * The group picker's options, bucketed by which standard each group comes from.
 *
 * Adopting MTConnect's component types took the vocabulary from seven entries to 127, at which
 * point a flat `<select>` stopped being navigable. Standards are ordered with local groups last,
 * so the curated ones lead and anything this deployment invented is visibly its own.
 */
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
 * The group picker's options NARROWED to one standard, plus local groups.
 *
 * WHY A SEPARATE FUNCTION rather than a parameter on groupOptionsByStandard(). That function's
 * contract is "every known group, bucketed" -- a property its tests assert directly ("returns
 * exactly the names knownGroupNames does"). Filtering is a different question, and folding it in
 * would mean one function whose result set depends on an argument, which is the shape that makes
 * a caller passing the wrong thing hard to notice.
 *
 * LOCAL GROUPS ARE ALWAYS INCLUDED, and that is deliberate. Nothing in the schema ties a group to
 * a standard: `metric_groups.standard` records where a group CAME FROM, not what may use it, and
 * the metric name derives its group by string prefix with no knowledge of provenance at all. A
 * deployment that invented `Hydraulic` for its own equipment must still be able to file an
 * MTConnect data item under it -- excluding local groups would make the picker narrower than the
 * database, and the operator's only recourse would be to re-create a group that already exists
 * under a second spelling, which the spelling trigger then rejects.
 *
 * An empty `standard` is the Custom option (STANDARDS.CUSTOM is ''), which leaves local groups
 * only -- exactly right, since a custom metric is by definition not drawn from a vocabulary.
 */
export function groupOptionsForStandard(registry, metrics, standard) {
  const buckets = groupOptionsByStandard(registry, metrics)
  if (!standard) return buckets.filter(b => b.label === LOCAL_STANDARD_LABEL)
  return buckets.filter(b => b.label === standard || b.label === LOCAL_STANDARD_LABEL)
}

/**
 * Resolve a typed group name against the known vocabulary, case-insensitively.
 *
 * Returns the *existing* spelling when one matches, so typing `robot` where `Robot` is already
 * established silently reuses `Robot` rather than forking the taxonomy. `enforce_metric_group_spelling`
 * rejects the fork at the database level regardless; this makes the UI agree with it instead of
 * letting the user discover the rule by hitting an error.
 */
export function canonicaliseGroup(input, knownGroups) {
  const trimmed = (input || '').trim()
  if (!trimmed) return ''
  const match = (knownGroups || []).find(g => g.toLowerCase() === trimmed.toLowerCase())
  return match || trimmed
}

/**
 * Join name parts into a metric name, dropping the empty ones.
 *
 * Standard-agnostic on purpose: MTConnect composes component/instance/type/subType, an OPC UA
 * browse name composes component/instance/name, and an ISO 22400 KPI composes family/KPI. They are
 * the same operation over a different number of parts, and having one composer is what guarantees
 * all three produce names the same group derivation can read.
 */
export function composeMetricName(...parts) {
  return parts
    .flat()
    .map(part => (part || '').trim())
    .filter(Boolean)
    .join(METRIC_GROUP_SEPARATOR)
}

/**
 * The Factory+ metric-name format: '/'-delimited folders whose segments use only alphanumerics
 * and the underscore.
 *
 * MIRROR OF THE SQL. `metric_catalog_name_format` (archived migration 0007) is the same expression, and it
 * is the authority -- this exists so the operator is told at the form rather than by a 400. Keep
 * the two in step, the same obligation deriveMetricGroup() and utils/sparkplugId.js carry.
 *
 * It subsumes the empty-segment checks this used to make by hand: a leading, trailing or doubled
 * separator all leave a segment with nothing in it, which `[A-Za-z0-9_]+` rejects.
 */
export const METRIC_NAME_PATTERN = /^[A-Za-z0-9_]+(\/[A-Za-z0-9_]+)*$/

/**
 * Whether a composed name is a usable metric name.
 *
 * The stakes are why this is enforced at all: `name` is IMMUTABLE once created, so a
 * non-conforming name is permanent -- the row can only be deprecated and superseded, never
 * corrected. An empty segment is also not merely untidy, since the SQL derives the group with
 * `NULLIF(split_part(name, '/', 1), '')`: `/ANGLE` would store a NULL group while plainly looking
 * grouped.
 */
export function isValidMetricName(name) {
  return METRIC_NAME_PATTERN.test((name || '').trim())
}

/**
 * Why a name is unusable, or null when it is fine. Phrased for an operator filling in the form.
 *
 * Separate from isValidMetricName() because the button needs a boolean and the field needs a
 * sentence -- and a disabled control with no stated reason is the thing this replaces.
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
