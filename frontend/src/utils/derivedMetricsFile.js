import { plural } from './format'
import { SHARE_UNIT, derivationText, isShare } from './derivedMetric'

/*
 * What the Derived tab works out for itself about a file of derived metrics: the name an export is
 * saved under, how big a file it reads, and the words an upload says. Pure, so each rule is
 * unit-tested. The database is the authority on what a file may hold (apply_derived_metrics(), 0297);
 * docs/derived-metrics.md is the format's reference.
 */

/** What an export is saved as. */
export const DERIVED_METRICS_FILE_NAME = 'derived-metrics.yaml'

/** The most a file the page reads may hold. */
export const DERIVED_METRICS_FILE_MAX_BYTES = 8 * 1024 * 1024

/** The path the dashboard serves the JSON Schema at, and the line that points VS Code's YAML extension at it. */
export const DERIVED_METRICS_SCHEMA_PATH = '/json-schema/derived-metrics.schema.json'
export const derivedSchemaComment = (origin) => `# yaml-language-server: $schema=${origin}${DERIVED_METRICS_SCHEMA_PATH}`

/**
 * What an apply would do to one derived metric, in words, for the preview: a new one says how it is
 * computed and in what unit; an unchanged one says it is already there. Null for a refusal, which
 * lists its reasons.
 */
export function derivedResultNote(result) {
  if (result.status === 'new' || result.status === 'unchanged') {
    const unit = isShare(result.derivation) ? SHARE_UNIT : result.units
    const how = `${derivationText(result.derivation)}${unit ? `, in ${unit}` : ''}`
    return result.status === 'new' ? how : `already here: ${how}`
  }
  return null
}

/** The name a result is shown under: the metric's, or its place in the file when it has no valid name. */
export const derivedResultName = (result) =>
  result.name ?? (result.index === null || result.index === undefined ? 'The file' : `Derived metric ${result.index + 1}`)

/** The results an apply wrote: the new derived metrics. */
export const writtenDerived = (results) => (results || []).filter(r => r.status === 'new')

/** What an upload says in its toast: the one metric by its name, or how many were added, from `source` (a file's name) when there is one. */
export function appliedDerivedWords(results, source = null) {
  const written = writtenDerived(results)
  const from = source ? ` from ${source}` : ''
  if (written.length === 1) return `Derived metric '${written[0].name}' added to the catalog${from}`
  return `Added ${plural(written.length, 'derived metric')} to the catalog${from}`
}
