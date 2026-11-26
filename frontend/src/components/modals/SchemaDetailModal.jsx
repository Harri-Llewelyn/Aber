import React, { useState, useMemo } from 'react'
import {
  IconGitBranch, IconLock, IconHistory, IconAlertTriangle, IconCheck, IconTrash
} from '../common/Icons'
import { ActionButton } from '../common/ActionButton'
import { useFormCheck } from '../../hooks/useFormCheck'
import { usePendingKey } from '../../hooks/usePendingAction'
import { datatypeToJsonSchemaType } from '../../utils/sparkplugDatatype'
import { modelledMetrics } from '../../utils/deviceTags'
import { storedSemanticIdPair } from '../../utils/standards'
import {
  schemaVersion, schemaStatus, statusLabel, statusBadgeClass, schemaVersionLabel,
  isSchemaEditable, canForkSchema, nextVersion, lineageOf, SCHEMA_STATUS
} from '../../utils/schemaVersion'
import { PERMISSION_UUIDS } from '../../constants'
import { requiresRolesTitle } from '../../hooks/usePermissions'
import { Modal } from '../common/Modal'
import { SchemaEditor, schemaDerived, schemaFields, useSchemaForm } from '../common/SchemaEditor'
import { boundText, catalogPropertyEntry, isNumericType, rangeText, sameJson } from '../../utils/schemaProperty'
import { Tooltip } from '../common/Tooltip'

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** A metric row's muted list of the keys its entry holds beyond `type`, after its name. Nothing when it has none. */
function StoredKeys({ entry }) {
  const keys = isPlainObject(entry) ? Object.keys(entry).filter(k => k !== 'type') : []
  return keys.length > 0 ? <span className="mono schema-stored-keys">{keys.join(' · ')}</span> : null
}

/** The version and its status, beside the title. */
function VersionBadge({ schema }) {
  const status = schemaStatus(schema)
  return (
    <Tooltip text={isSchemaEditable(schema)
      ? 'A draft is the only editable state. Publishing it activates it and archives its predecessor.'
      : `This version is ${statusLabel(status)} and immutable — create a new version to change it.`}>
      <span className={`badge ${statusBadgeClass(status)}`}>{schemaVersionLabel(schema)}</span>
    </Tooltip>
  )
}

/** Why nothing here can be changed, at the top of a read-only version. */
const readOnlyReason = (schema) => {
  if (isSchemaEditable(schema)) {
    return `You are reading this draft. ${requiresRolesTitle(PERMISSION_UUIDS.SCHEMA_MANAGE)} to change it; ask one of them to make the change.`
  }
  return schemaStatus(schema) === SCHEMA_STATUS.ARCHIVED
    ? 'Archived: superseded by a later version and kept as history. It cannot be edited or re-activated.'
    : 'Active and read-only: devices are provisioned against this exact definition, so it is frozen. Create a version to change it.'
}

/**
 * The whole line of versions, oldest first, closed until it is asked for so that it takes nothing from
 * the metric list. Drawn once there is more than one.
 */
function VersionHistory({ lineage, schema }) {
  if (lineage.length < 2) return null
  return (
    <details className="schema-history">
      <summary className="form-label schema-history-summary">
        <IconHistory size={13} /> Version History <span className="section-count">{lineage.length}</span>
      </summary>
      <ol className="schema-history-list">
        {lineage.map(v => {
          const isThis = (v.schema_uuid || v.id) === (schema?.schema_uuid || schema?.id)
          return (
            <li key={v.schema_uuid || v.id} className={isThis ? 'schema-history-this' : undefined}>
              <div className="schema-history-head">
                <span className={`badge badge-sm ${statusBadgeClass(schemaStatus(v))}`}>{schemaVersionLabel(v)}</span>
                <span className="mono schema-history-name">{v.schema_name}</span>
                {isThis && <span className="schema-history-here">This version</span>}
              </div>
              <div className="schema-history-change">{v.change_description || 'No change description recorded.'}</div>
            </li>
          )
        })}
      </ol>
    </details>
  )
}

/**
 * One version of a schema, in the editor's body (common/SchemaEditor): a draft to edit, or any other
 * version as text. Read-only is the default and is the same read-only the database enforces:
 * `prevent_active_schema_mutation()` rejects the write. `isSchemaEditable()` is the single predicate and
 * fails closed; a role that may not manage schemas reads a draft too. Create Version is the one act on
 * the version in force.
 */
export function SchemaDetailModal({
  schema, schemas = [], catalog = [], deviceCount = 0, canManage = false,
  onFork, onPublish, onDiscard, onSaveDraft, onClose, showToast
}) {
  const isDraft = isSchemaEditable(schema)
  const editing = isDraft && canManage

  // `picked` is the names the stored definition models, from `properties` and `required`. That list and
  // each entry's description, permitted values and range are all the dialog edits; a save keeps the rest
  // of the definition as stored (buildDefinition). A draft inherits its parent's semantic id through
  // fork_schema(), so this is where a wrong claim, or a template that has moved on, is corrected or
  // cleared before it is published again. A metric with no entry in `ranges` shows, and keeps, its
  // stored bounds, so only a range somebody typed is rewritten.
  const [form, change] = useSchemaForm(() => ({
    name: schema?.schema_name || '',
    description: schema?.description || '',
    changeDescription: schema?.change_description || '',
    picked: new Set(modelledMetrics(schema) || []),
    derived: new Set(schema?.derived_metrics || []),
    ...storedSemanticIdPair(schema?.semantic_id, schema?.semantic_id_type)
  }))
  const { picked, ranges } = form
  // The write that is running, 'save' or 'publish', or null.
  const [busy, runWrite] = usePendingKey()
  // A refusal of a save or a publish, as the database worded it.
  const [error, setError] = useState(null)

  // A derived metric is not offered among the metrics: nothing publishes it, so a schema does not model it.
  const activeCatalog = useMemo(() => (catalog || []).filter(m => !m.deprecated && !m.derivation), [catalog])

  const lineage = useMemo(() => lineageOf(schemas, schema), [schemas, schema])

  // Modelled metrics no longer in the active catalog. They have no row to untick, so they are named
  // here, and a save keeps them with their stored entries.
  const orphanedNames = useMemo(() => {
    const known = new Set(activeCatalog.map(m => m.name))
    return [...picked].filter(n => !known.has(n))
  }, [activeCatalog, picked])

  const storedProperties = useMemo(() => {
    const properties = schema?.schema_definition?.properties
    return isPlainObject(properties) ? properties : {}
  }, [schema])
  const storedEntry = (name) => (Object.hasOwn(storedProperties, name) ? storedProperties[name] : undefined)

  const modelledNow = modelledMetrics(schema) || new Set()
  const added = [...picked].filter(n => !modelledNow.has(n))
  const removed = [...modelledNow].filter(n => !picked.has(n))

  const activeByName = useMemo(() => new Map(activeCatalog.map(m => [m.name, m])), [activeCatalog])

  /**
   * The JSON type of a metric whose range this dialog edits, or null. Only an active catalog metric
   * with an entry in `properties` (stored as an object, or being added) and a numeric type has one.
   */
  const rangeTypeOf = (name) => {
    const metric = activeByName.get(name)
    const stored = storedEntry(name)
    const inProperties = Object.hasOwn(storedProperties, name) || !modelledNow.has(name)
    if (!metric || !inProperties || (stored !== undefined && !isPlainObject(stored))) return null
    const type = typeof stored?.type === 'string' ? stored.type : datatypeToJsonSchemaType(metric.datatype)
    return isNumericType(type) ? type : null
  }
  const takesRange = (name) => rangeTypeOf(name) !== null
  const shownRange = (name) => ranges[name] || {
    minimum: boundText(storedEntry(name)?.minimum),
    maximum: boundText(storedEntry(name)?.maximum)
  }

  /**
   * A selected metric's entry as a save writes it. An active catalog metric's entry is built by
   * catalogPropertyEntry(): its description and permitted values are the catalog's as they are now,
   * its range what is typed beside it, and every other stored key stays. A metric no longer in the
   * active catalog, or stored as something other than an object, keeps its stored entry as it is.
   */
  const entryFor = (name) => {
    const stored = storedEntry(name)
    const metric = activeByName.get(name)
    if (!metric || (stored !== undefined && !isPlainObject(stored))) return stored
    return catalogPropertyEntry(metric, { stored, range: takesRange(name) ? ranges[name] : undefined })
  }

  /**
   * The stored definition with the metric list and its entries brought up to date, and nothing else.
   * An added metric goes into `properties` only: `required` means modelled, and the editor never adds
   * to it. A removed one leaves both. Everything outside `properties` and `required` stays as stored.
   */
  const buildDefinition = () => {
    const stored = isPlainObject(schema?.schema_definition) ? schema.schema_definition : { type: 'object' }
    const next = { ...stored }
    if (isPlainObject(stored.properties) || added.length > 0) {
      next.properties = {}
      for (const name of Object.keys(storedProperties)) {
        if (picked.has(name)) next.properties[name] = entryFor(name)
      }
      for (const name of added) next.properties[name] = entryFor(name)
    }
    if (Array.isArray(stored.required)) next.required = stored.required.filter(n => picked.has(n))
    return next
  }

  // Only a draft being edited is built: any other version's definition is shown as stored.
  const built = editing ? buildDefinition() : null
  const builtEntry = (name) => (built?.properties && Object.hasOwn(built.properties, name) ? built.properties[name] : undefined)
  // Kept metrics whose entry a save would rewrite, and those of them the catalog alone changes.
  const changed = editing
    ? [...picked].filter(n => Object.hasOwn(storedProperties, n) && builtEntry(n) !== undefined &&
        !sameJson(builtEntry(n), storedProperties[n]))
    : []
  const fromCatalog = changed.filter(n =>
    !sameJson(catalogPropertyEntry(activeByName.get(n), { stored: storedProperties[n] }), storedProperties[n]))
  const metricsEdited = added.length > 0 || removed.length > 0 || changed.length > 0

  // What the version it was made from names may be named again, a deprecated one too.
  const namedNow = schema?.derived_metrics || []
  const parent = (schemas || []).find(s => s.schema_uuid === schema?.parent_schema_id)
  const derived = schemaDerived({ form, catalog, definition: built ?? schema?.schema_definition, kept: [...namedNow, ...(parent?.derived_metrics || [])] })
  const derivedAdded = [...form.derived].filter(n => !namedNow.includes(n))
  const derivedRemoved = namedNow.filter(n => !form.derived.has(n))
  const derivedEdited = derivedAdded.length > 0 || derivedRemoved.length > 0

  const semanticNow = storedSemanticIdPair(schema?.semantic_id, schema?.semantic_id_type)
  const semanticEdited = storedSemanticIdPair(form.semanticId, form.semanticIdType)
  const dirty =
    metricsEdited ||
    derivedEdited ||
    form.description !== (schema?.description || '') ||
    form.changeDescription !== (schema?.change_description || '') ||
    semanticEdited.semanticId !== semanticNow.semanticId ||
    semanticEdited.semanticIdType !== semanticNow.semanticIdType

  /**
   * Everything a draft save writes. The definition goes only when the metric list or an entry
   * changed, and the derived metrics only when they did: both in one write, so the database judges them
   * together. api.js writes only the keys it is given, and sends the type as NULL when the id is blank.
   */
  const draftPatch = () => ({
    ...(metricsEdited && { schema_definition: buildDefinition() }),
    ...(derivedEdited && { derived_metrics: [...form.derived].sort() }),
    description: form.description,
    change_description: form.changeDescription,
    semantic_id: semanticEdited.semanticId,
    semantic_id_type: semanticEdited.semanticIdType
  })

  // The act named is the one whose button reports the wait; the other waits with it. A refusal ends
  // here: a refused save throws, so the publish after it never runs.
  const write = (name, fn) => runWrite(name, async () => {
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e.message)
    }
  })

  const saveDraft = () => write('save', async () => {
    await onSaveDraft?.(draftPatch())
  })

  const publish = () => write('publish', async () => {
    // Saved first if dirty, so publishing can never activate a version missing the edits on screen.
    // The publish RPC takes no payload.
    if (dirty) await onSaveDraft?.(draftPatch())
    await onPublish?.()
  })

  // Saving asks for a change; publishing takes the draft as it is. The last one pressed speaks.
  const fields = editing ? schemaFields('schema-detail', { form, catalog: activeCatalog, takesRange, derived, named: true }) : {}
  const saving = useFormCheck(fields, { unchanged: !dirty })
  const publishing = useFormCheck(fields)
  const errors = Object.fromEntries(Object.keys(fields).map(k => [k, saving.errors[k] || publishing.errors[k]]))

  // A lineage holds one open draft, so another version waits for it.
  const openDraft = (schemas || []).find(s =>
    s.parent_schema_id === (schema?.schema_uuid || schema?.id) && schemaStatus(s) === SCHEMA_STATUS.DRAFT)
  const forking = useFormCheck({
    draft: {
      missing: openDraft && `A draft (${openDraft.schema_name}) already exists for this schema. Publish or discard it first.`
    }
  })
  const canFork = canForkSchema(schema)
  const next = nextVersion(schema)

  const deniedTitle = requiresRolesTitle(PERMISSION_UUIDS.SCHEMA_MANAGE)
  const footer = (
    <>
      {editing && (
        <ActionButton
          className="btn btn-ghost"
          disabled={busy}
          pending={busy === 'save'}
          pendingLabel="Saving…"
          onClick={() => { publishing.reset(); saving.press(saveDraft) }}
          title="Save this draft without activating it"
        >
          Save Draft
        </ActionButton>
      )}

      {canFork && (
        <ActionButton
          className="btn btn-primary"
          permitted={canManage}
          deniedTitle={deniedTitle}
          title={`Create Version v${next}: an editable Draft v${next}, carrying every metric this version models`}
          onClick={() => forking.press(() => onFork?.())}
        >
          <IconGitBranch size={13} /> {`Create Version v${next}`}
        </ActionButton>
      )}

      {isDraft && (
        <ActionButton
          className="btn btn-primary"
          permitted={canManage}
          deniedTitle={deniedTitle}
          disabled={busy}
          pending={busy === 'publish'}
          pendingLabel="Publishing…"
          onClick={() => { saving.reset(); publishing.press(publish) }}
          title={`Activate v${schemaVersion(schema)}, archive its predecessor, and move every device across`}
        >
          <IconCheck size={13} /> {`Publish Version v${schemaVersion(schema)}`}
        </ActionButton>
      )}

      {/* The other way out of a draft: without it the only exit was to publish. */}
      {isDraft && onDiscard && (
        <ActionButton
          className="btn btn-danger"
          permitted={canManage}
          deniedTitle={deniedTitle}
          disabled={busy}
          title={`Delete draft v${schemaVersion(schema)} and leave its predecessor exactly as it is`}
          onClick={onDiscard}
        >
          <IconTrash size={13} /> Discard Draft
        </ActionButton>
      )}
    </>
  )

  return (
    <Modal
      title={<>{schema?.schema_name} <VersionBadge schema={schema} /></>}
      icon={editing ? <IconGitBranch size={18} /> : <IconLock size={18} />}
      size="wide"
      className="schema-detail-modal"
      fill
      busy={busy}
      onClose={onClose}
      problem={editing ? saving.problem ?? publishing.problem : canFork ? forking.problem : undefined}
      error={error}
      dismiss={editing && dirty ? 'Cancel' : 'Close'}
      footer={footer}
    >
      {!editing && (
        <div className="readonly-notice" role="status">
          <IconLock size={13} />
          <span>{readOnlyReason(schema)}</span>
        </div>
      )}

      <SchemaEditor
        idPrefix="schema-detail"
        readOnly={!editing}
        form={form}
        onChange={change}
        errors={errors}
        catalog={activeCatalog}
        version={{ uuid: schema?.schema_uuid, onCopy: showToast }}
        rangeOf={name => (takesRange(name) ? shownRange(name) : null)}
        rangeTextOf={name => rangeText(storedEntry(name))}
        // What a save writes for a ticked metric; what is stored for the rest.
        noteOf={name => <StoredKeys entry={picked.has(name) && builtEntry(name) !== undefined ? builtEntry(name) : storedEntry(name)} />}
        counts={editing && metricsEdited && (
          <span className="form-hint-inline schema-counts">
            {added.length > 0 && <span className="schema-count-added">+{added.length} </span>}
            {removed.length > 0 && <span className="schema-count-removed">−{removed.length} </span>}
            {changed.length > 0 && <span>{changed.length} changed </span>}
            vs. the last saved draft
          </span>
        )}
        derived={{
          catalog,
          offered: derived.offered,
          counts: editing && derivedEdited && (
            <span className="form-hint-inline schema-counts">
              {derivedAdded.length > 0 && <span className="schema-count-added">+{derivedAdded.length} </span>}
              {derivedRemoved.length > 0 && <span className="schema-count-removed">−{derivedRemoved.length} </span>}
              vs. the last saved draft
            </span>
          )
        }}
        // Opening a draft can be enough to change it: a forked version takes the catalog as it is now,
        // which is how a new version comes to carry permitted values its parent lacked.
        above={fromCatalog.length > 0 && (
          <p className="form-hint schema-from-catalog">
            {fromCatalog.length === 1 ? 'One metric takes its' : `${fromCatalog.length} metrics take their`} description
            or permitted values from the Metrics page as it is now. Saving or publishing writes them into this draft.
          </p>
        )}
        below={orphanedNames.length > 0 && (
          <p className="form-hint hint-warning schema-orphans">
            <IconAlertTriangle size={12} />{' '}
            {orphanedNames.length} modelled metric{orphanedNames.length === 1 ? '' : 's'} no longer in the active
            catalog ({orphanedNames.map((n, i) => <React.Fragment key={n}>{i > 0 && ', '}<span className="mono">{n}</span></React.Fragment>)}) — kept as-is
            {editing ? ', and kept on save. This dialog cannot remove them; only the REST API can.' : '.'}
          </p>
        )}
      >
        <VersionHistory lineage={lineage} schema={schema} />
      </SchemaEditor>

      {isDraft && deviceCount === 0 && (
        <p className="form-hint schema-publish-note">
          Publishing activates this version and archives its predecessor. Devices attached to the predecessor move across automatically.
        </p>
      )}
    </Modal>
  )
}
