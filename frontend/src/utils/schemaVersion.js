/**
 * Schema version lineage: labels, lifecycle predicates and the name derivation. All derived from
 * the row; `fork_schema()` and `publish_schema_version()` are what move a schema through its
 * lifecycle, and these exist so the UI can say what will happen first. `baseSchemaName()` mirrors
 * `public.schema_version_base_name()`.
 */

export const SCHEMA_STATUS = {
  DRAFT: 'draft',
  ACTIVE: 'active',
  ARCHIVED: 'archived'
}

/** Human label per status. Kept beside the constants so a new status cannot render as raw text. */
const STATUS_LABELS = {
  [SCHEMA_STATUS.DRAFT]: 'Draft',
  [SCHEMA_STATUS.ACTIVE]: 'Active',
  [SCHEMA_STATUS.ARCHIVED]: 'Archived'
}

/**
 * The badge class each status wears: a draft is the one not in force, so it takes the warning
 * treatment; an archived version recedes.
 */
const STATUS_BADGES = {
  [SCHEMA_STATUS.DRAFT]: 'badge-warning',
  [SCHEMA_STATUS.ACTIVE]: 'badge-online',
  [SCHEMA_STATUS.ARCHIVED]: 'badge-neutral'
}

/** A schema that predates archived migration 20260101000037_schema_versioning.sql reads as v1/active -- the same default the column took. */
export const schemaVersion = (schema) => Number(schema?.version) || 1
export const schemaStatus = (schema) => schema?.status || SCHEMA_STATUS.ACTIVE

export const statusLabel = (status) => STATUS_LABELS[status] || String(status || '')
export const statusBadgeClass = (status) => STATUS_BADGES[status] || 'badge-neutral'

/** `v2 · Active`, one string: a version number is meaningless without its status. */
export const schemaVersionLabel = (schema) =>
  `v${schemaVersion(schema)} · ${statusLabel(schemaStatus(schema))}`

/** Mirrors public.schema_version_base_name(): strip a trailing `_v<n>` so suffixes never stack. */
export const baseSchemaName = (name) => String(name || '').replace(/_v\d+$/, '')

export const nextVersion = (schema) => schemaVersion(schema) + 1

/**
 * What the next version will most likely be called. `fork_schema()` disambiguates against names a
 * discarded draft left behind, so this is for the button's title and never an input to the call.
 */
export const nextVersionName = (schema) =>
  `${baseSchemaName(schema?.schema_name)}_v${nextVersion(schema)}`

/** Only a draft is editable. This is the single predicate every read-only affordance reads. */
export const isSchemaEditable = (schema) => schemaStatus(schema) === SCHEMA_STATUS.DRAFT

/** Only the head of a lineage may be forked -- see fork_schema()'s status check. */
export const canForkSchema = (schema) => schemaStatus(schema) === SCHEMA_STATUS.ACTIVE

/**
 * The whole lineage a schema belongs to, oldest first, walked through `parent_schema_id` rather
 * than matched on the derived name. Guarded against a cycle by a visited set.
 */
export const lineageOf = (schemas, schema) => {
  const list = schemas || []
  const byId = new Map(list.map(s => [s.schema_uuid || s.id, s]))
  const startId = schema?.schema_uuid || schema?.id
  if (!startId || !byId.has(startId)) return schema ? [schema] : []

  const seen = new Set()
  let root = byId.get(startId)
  while (root?.parent_schema_id && byId.has(root.parent_schema_id) && !seen.has(root.parent_schema_id)) {
    seen.add(root.schema_uuid || root.id)
    root = byId.get(root.parent_schema_id)
  }

  const chain = []
  const walked = new Set()
  let current = root
  while (current && !walked.has(current.schema_uuid || current.id)) {
    walked.add(current.schema_uuid || current.id)
    chain.push(current)
    current = list.find(s =>
      s.parent_schema_id === (current.schema_uuid || current.id)
    )
  }
  return chain
}

/**
 * Whether the registry lists this row in its default view: archived versions are excluded, drafts
 * are not, because opening a draft is the only way to finish it.
 */
export const isCurrentSchema = (schema) => schemaStatus(schema) !== SCHEMA_STATUS.ARCHIVED

/**
 * Whether a schema may be attached to a device that does not already carry it. An archived version
 * is history: `publish_schema_version()` repoints every device to the successor, and offering it
 * would put devices back one at a time. A draft is still assignable, because attaching it to one
 * device is how a new version is tried before publishing.
 */
export const isAssignableSchema = (schema) => schemaStatus(schema) !== SCHEMA_STATUS.ARCHIVED

/**
 * The schemas a picker may offer. `current` (one id or a list) is kept even when archived: a device
 * on an archived schema is an unfinished migration, and hiding it would detach it on an unrelated
 * save. Input order is preserved.
 */
export const assignableSchemas = (schemas, current) => {
  const kept = new Set([].concat(current ?? []))
  return (schemas || []).filter(s => isAssignableSchema(s) || kept.has(s.schema_uuid || s.id))
}
