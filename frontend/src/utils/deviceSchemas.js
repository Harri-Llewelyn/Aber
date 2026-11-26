import { plural } from './format'

/*
 * What the Schemas page works out for itself about a file of schemas: the name an export is saved
 * under, how big a file it reads, and the words an upload says. Pure, so each rule is
 * unit-tested. The database is the authority on what a file may hold (apply_device_schemas(), 0295);
 * docs/device-schemas.md is the format's reference.
 */

/** What an export is saved as. */
export const DEVICE_SCHEMAS_FILE_NAME = 'device-schemas.yaml'

/** The most a file the page reads may hold: 200 schemas of up to 1,000 metrics each. */
export const DEVICE_SCHEMAS_FILE_MAX_BYTES = 8 * 1024 * 1024

const list = (names) => (names || []).join(', ')

const noun = (names) => (names.length === 1 ? 'metric' : 'metrics')

/**
 * What an apply would do to one schema, in words, for the preview: a new schema is version 1 and in
 * force; a changed one makes a draft, and the note says which metrics it adds, removes and changes, which
 * derived metrics it names and no longer names, and which other keys differ. Null for a schema that is
 * refused or unchanged, which say it already.
 */
export function schemaResultNote(result) {
  if (result.status === 'new') return 'version 1, in force'
  if (result.status !== 'changed') return null
  const parts = []
  const metrics = result.metrics || {}
  if (metrics.added?.length) parts.push(`adds ${list(metrics.added)}`)
  if (metrics.removed?.length) parts.push(`removes ${list(metrics.removed)}`)
  if (metrics.changed?.length) parts.push(`changes the range of ${list(metrics.changed)}`)
  const derived = result.derived_metrics || {}
  if (derived.added?.length) parts.push(`names the derived ${noun(derived.added)} ${list(derived.added)}`)
  if (derived.removed?.length) parts.push(`no longer names the derived ${noun(derived.removed)} ${list(derived.removed)}`)
  const others = (result.changes || []).filter(key => key !== 'metrics' && key !== 'derived_metrics').map(key => key.replace(/_/g, ' '))
  if (others.length) parts.push(`changes the ${list(others)}`)
  const draft = `a new draft, v${result.version}${result.schema_name ? ` (${result.schema_name})` : ''}`
  return parts.length ? `${draft}: ${parts.join('; ')}` : draft
}

/**
 * What a file would take from schemas it changes, for the warning over the preview: `{ count, schemas }`,
 * each schema with the derived metrics it would no longer name, or null when it takes none. A file says
 * what is saved, so one written before a schema could name any, or without the key, takes them all.
 */
export function removedDerivedMetrics(results) {
  const schemas = (results || [])
    .filter(r => r.status === 'changed' && r.derived_metrics?.removed?.length)
    .map(r => ({ name: r.name, metrics: r.derived_metrics.removed }))
  return schemas.length ? { count: schemas.reduce((sum, s) => sum + s.metrics.length, 0), schemas } : null
}

/** The name a result is shown under: the schema's, or its place in the file when it has no valid name. */
export const schemaResultName = (result) =>
  result.name ?? (result.index === null || result.index === undefined ? 'The file' : `Schema ${result.index + 1}`)

/** The results an apply wrote: the new schemas and the new drafts. */
export const writtenSchemas = (results) => (results || []).filter(r => r.status === 'new' || r.status === 'changed')

/**
 * What an upload says in its toast: the one schema by its name and what became of it, or how many
 * were written and how, from `source` (a file's name) when there is one.
 */
export function appliedSchemaWords(results, source = null) {
  const written = writtenSchemas(results)
  const from = source ? ` from ${source}` : ''
  if (written.length === 1) {
    const [one] = written
    return one.status === 'new' ? `Schema '${one.name}' created${from}` : `Draft v${one.version} of '${one.name}' created${from}`
  }
  const created = written.filter(r => r.status === 'new').length
  return `Applied ${plural(written.length, 'schema')}${from} (${created} new, ${plural(written.length - created, 'new draft')})`
}
