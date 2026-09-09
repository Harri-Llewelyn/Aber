/**
 * Schema version lineage: labels, lifecycle predicates and the name derivation.
 *
 * All of it is DERIVED from the row the server already returns -- nothing here is stored, and
 * nothing here decides anything the database does not also decide. `fork_schema()` and
 * `publish_schema_version()` (archived migration 0037) are the only things that can actually move a schema
 * through its lifecycle; these functions exist so the UI can *say* what will happen before the
 * operator commits to it, and so a read-only version renders as read-only rather than as a form
 * whose Save button fails.
 *
 * `baseSchemaName()` MIRRORS `public.schema_version_base_name()` in archived migration 0037 -- the same
 * keep-in-step obligation as `sparkplugId.js`, `metricGroup.js` and `gatewayStatus.js`. Drift here
 * is visible rather than dangerous (the button would predict the wrong name for a version the
 * server then names correctly), but it is still a lie in the UI.
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
 * The badge class each status wears. A draft is the only one that is *not* in force, so it gets
 * the warning treatment; an archived version is history, so it recedes rather than alarming.
 */
const STATUS_BADGES = {
  [SCHEMA_STATUS.DRAFT]: 'badge-warning',
  [SCHEMA_STATUS.ACTIVE]: 'badge-online',
  [SCHEMA_STATUS.ARCHIVED]: 'badge-neutral'
}

/** A schema that predates archived migration 0037 reads as v1/active -- the same default the column took. */
export const schemaVersion = (schema) => Number(schema?.version) || 1
export const schemaStatus = (schema) => schema?.status || SCHEMA_STATUS.ACTIVE

export const statusLabel = (status) => STATUS_LABELS[status] || String(status || '')
export const statusBadgeClass = (status) => STATUS_BADGES[status] || 'badge-neutral'

/**
 * `v2 · Active`. One string rather than two elements, because the version number is meaningless
 * without the status beside it -- "v1" alone reads as "the current one" when it may be superseded.
 */
export const schemaVersionLabel = (schema) =>
  `v${schemaVersion(schema)} · ${statusLabel(schemaStatus(schema))}`

/** Mirrors public.schema_version_base_name(): strip a trailing `_v<n>` so suffixes never stack. */
export const baseSchemaName = (name) => String(name || '').replace(/_v\d+$/, '')

export const nextVersion = (schema) => schemaVersion(schema) + 1

/**
 * What the next version will most likely be called. "Most likely" is honest: `fork_schema()`
 * disambiguates against names a discarded draft left behind, so the server can land one suffix
 * further along. Used for the button's title, never as an input to the fork call -- the name is
 * the server's to choose.
 */
export const nextVersionName = (schema) =>
  `${baseSchemaName(schema?.schema_name)}_v${nextVersion(schema)}`

/** Only a draft is editable. This is the single predicate every read-only affordance reads. */
export const isSchemaEditable = (schema) => schemaStatus(schema) === SCHEMA_STATUS.DRAFT

/** Only the head of a lineage may be forked -- see fork_schema()'s status check. */
export const canForkSchema = (schema) => schemaStatus(schema) === SCHEMA_STATUS.ACTIVE

export const canPublishSchema = (schema) => schemaStatus(schema) === SCHEMA_STATUS.DRAFT

/**
 * The open draft hanging off a schema, if any. A partial unique index guarantees at most one, so
 * this returns a row rather than a list -- and the Create Version button reads it to explain why
 * it is unavailable rather than simply going grey.
 */
export const draftFor = (schemas, schema) => {
  const parentId = schema?.schema_uuid || schema?.id
  if (!parentId) return null
  return (schemas || []).find(s =>
    s.parent_schema_id === parentId && schemaStatus(s) === SCHEMA_STATUS.DRAFT
  ) || null
}

/**
 * The whole lineage a schema belongs to, oldest first.
 *
 * Walks up to the root through `parent_schema_id` and back down again, rather than matching on the
 * derived name: the name is a convenience and a discarded draft can push a version onto a
 * disambiguated one, whereas the parent edge is what the database actually constrains. Guarded
 * against a cycle by a visited set -- a CHECK forbids self-parenting and the immutability guard
 * freezes `parent_schema_id`, so a cycle should be unreachable, but an infinite loop in a render
 * path is not a failure mode worth leaving to reasoning alone.
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
 * Whether the registry table lists this row in its default view.
 *
 * Archived versions are excluded, drafts are not. An archived v1 sitting beside its active v2 as a
 * sibling row is what makes a version history unreadable -- the table stops being a list of
 * schemas and becomes a list of every state every schema has ever been in. A draft, by contrast,
 * is work in progress that has to stay reachable, because opening it is the only way to finish it.
 */
export const isCurrentSchema = (schema) => schemaStatus(schema) !== SCHEMA_STATUS.ARCHIVED

/**
 * Whether a schema may be attached to a device that does not already carry it.
 *
 * An archived version is HISTORY, not a choice. It is the version a lineage has moved past, and
 * `publish_schema_version()` exists precisely so that every device pointing at it is repointed at
 * the successor in the same transaction -- so offering it in a picker offers the operator a way to
 * put a device BACK onto the version the platform has just migrated off, one device at a time and
 * with nothing to sweep it forward again. That is issue #167, and it was reachable from Edit
 * Details on any device.
 *
 * A DRAFT IS DELIBERATELY STILL ASSIGNABLE, which is the asymmetry worth stating rather than
 * looking like an oversight. Attaching a draft to one device is how a new version gets tried
 * against a real machine before it is published, and `publish_schema_version()` reads that as a
 * state it has to merge rather than as a mistake -- see the duplicate-submodel DELETE in its body.
 * The two statuses are not in force for opposite reasons: a draft is not in force YET.
 */
export const isAssignableSchema = (schema) => schemaStatus(schema) !== SCHEMA_STATUS.ARCHIVED

/**
 * The schemas a picker may offer, given what the device is already carrying.
 *
 * `currentId` IS KEPT EVEN WHEN IT IS ARCHIVED, and that is the half a status filter alone gets
 * wrong. An archived schema with devices still attached is a real state -- a migration that has
 * not finished, which is the same case `/v1/schema/{uuid}` refuses to hide -- so a device sitting
 * on one has to render as what it is. Filtering the option out would make the select fall back to
 * its first entry, so the dialog would SHOW a schema the device does not have, and pressing Save
 * for an unrelated reason (a rename, a cell change) would silently reassign it. A picker that
 * cannot state the current value is worse than one that offers too much.
 *
 * Order is preserved from the input, so the caller's sort survives.
 */
export const assignableSchemas = (schemas, currentId) =>
  (schemas || []).filter(s => isAssignableSchema(s) || (s.schema_uuid || s.id) === currentId)
