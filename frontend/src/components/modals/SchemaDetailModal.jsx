import React, { useState, useMemo } from 'react'
import {
  IconGitBranch, IconLock, IconHistory, IconAlertTriangle, IconCheck, IconDownload, IconTrash
} from '../common/Icons'
import CopyableId from '../common/CopyableId'
import { ActionButton } from '../common/ActionButton'
import { datatypeLabel, datatypeToJsonSchemaType } from '../../utils/sparkplugDatatype'
import { groupCatalog } from '../../utils/metricGroup'
import { modelledMetrics } from '../../utils/deviceTags'
import { LOCAL_EXTENSION_LABEL, storedSemanticIdPair } from '../../utils/standards'
import {
  schemaVersion, schemaStatus, statusLabel, statusBadgeClass, schemaVersionLabel,
  isSchemaEditable, canForkSchema, nextVersion, lineageOf, SCHEMA_STATUS
} from '../../utils/schemaVersion'
import { PERMISSION_UUIDS } from '../../constants'
import { requiresRolesTitle } from '../../hooks/usePermissions'
import { Modal } from '../common/Modal'
import { SemanticIdField } from '../common/SemanticIdField'
import {
  MetricGroupHeading, PropertyRange, rangeProblems, PICKER_ROW, PICKER_ROW_LABEL
} from './SchemaBuilderModal'
import { boundText, catalogPropertyEntry, isNumericType, sameJson } from '../../utils/schemaProperty'
import { Tooltip } from '../common/Tooltip'

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** The keys of a property entry beyond `type`, which a metric's row names after it. */
const keysBeyondType = (entry) =>
  isPlainObject(entry) ? Object.keys(entry).filter(k => k !== 'type') : []

/** A metric row's muted list of those keys, after its name. Nothing when the entry has none. */
function StoredKeys({ entry }) {
  const keys = keysBeyondType(entry)
  if (keys.length === 0) return null
  return <span className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{keys.join(' · ')}</span>
}

/**
 * One modal, two modes, decided by the schema's status. Read-only is the default and is the same
 * read-only the database enforces: `prevent_active_schema_mutation()` rejects the write, so an
 * active or archived version renders its metrics as a list and its semantic id as text.
 * `isSchemaEditable()` is the single predicate and fails closed. The change description is shown at
 * the top because it is the only part of a version that says why it exists. Create Version is the
 * one primary action in read-only mode.
 */
export function SchemaDetailModal({
  schema, schemas = [], catalog = [], deviceCount = 0, canManage = false,
  onFork, onPublish, onDiscard, onSaveDraft, onDownload, onClose, showToast
}) {
  const editable = isSchemaEditable(schema)
  const status = schemaStatus(schema)

  // The names the stored definition models, from `properties` and `required`. This list and each
  // entry's description, permitted values and range are all the dialog edits; a save keeps the rest
  // of the definition as stored (buildDefinition).
  const [selectedNames, setSelectedNames] = useState(
    () => new Set(modelledMetrics(schema) || [])
  )
  const [description, setDescription] = useState(schema?.description || '')
  const [changeDescription, setChangeDescription] = useState(schema?.change_description || '')
  // A draft inherits its parent's id through fork_schema(), so this is where a wrong claim, or a
  // template that has moved on, is corrected or cleared before it is published again.
  const [semantic, setSemantic] = useState(
    () => storedSemanticIdPair(schema?.semantic_id, schema?.semantic_id_type)
  )
  const [search, setSearch] = useState('')
  // Metric name -> the range typed beside it. A metric with no entry shows, and keeps, its stored
  // bounds, so only a range somebody touched is rewritten.
  const [ranges, setRanges] = useState({})
  // Which write is running, not merely whether one is -- see `run` below.
  const [busyAction, setBusyAction] = useState(null)
  const busy = busyAction !== null

  const activeCatalog = useMemo(() => (catalog || []).filter(m => !m.deprecated), [catalog])

  const lineage = useMemo(() => lineageOf(schemas, schema), [schemas, schema])

  // Modelled metrics no longer in the active catalog. They have no row to untick, so they are named
  // here, and a save keeps them with their stored entries.
  const orphanedNames = useMemo(() => {
    const known = new Set(activeCatalog.map(m => m.name))
    return [...selectedNames].filter(n => !known.has(n))
  }, [activeCatalog, selectedNames])

  const filteredCatalog = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return activeCatalog
    return activeCatalog.filter(m =>
      m.name.toLowerCase().includes(q) || (m.description || '').toLowerCase().includes(q)
    )
  }, [activeCatalog, search])

  const toggleMetric = (name) => {
    setSelectedNames(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name); else next.add(name)
      return next
    })
  }

  const storedProperties = useMemo(() => {
    const properties = schema?.schema_definition?.properties
    return isPlainObject(properties) ? properties : {}
  }, [schema])
  const storedEntry = (name) => (Object.hasOwn(storedProperties, name) ? storedProperties[name] : undefined)

  const modelledNow = modelledMetrics(schema) || new Set()
  const added = [...selectedNames].filter(n => !modelledNow.has(n))
  const removed = [...modelledNow].filter(n => !selectedNames.has(n))

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
    return catalogPropertyEntry(metric, { stored, range: rangeTypeOf(name) ? ranges[name] : undefined })
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
        if (selectedNames.has(name)) next.properties[name] = entryFor(name)
      }
      for (const name of added) next.properties[name] = entryFor(name)
    }
    if (Array.isArray(stored.required)) next.required = stored.required.filter(n => selectedNames.has(n))
    return next
  }

  // Only a draft is built: a published version's definition is shown as stored.
  const built = editable ? buildDefinition() : null
  const builtEntry = (name) => (built?.properties && Object.hasOwn(built.properties, name) ? built.properties[name] : undefined)
  // Kept metrics whose entry a save would rewrite, and those of them the catalog alone changes.
  const changed = editable
    ? [...selectedNames].filter(n => Object.hasOwn(storedProperties, n) && builtEntry(n) !== undefined &&
        !sameJson(builtEntry(n), storedProperties[n]))
    : []
  const fromCatalog = changed.filter(n =>
    !sameJson(catalogPropertyEntry(activeByName.get(n), { stored: storedProperties[n] }), storedProperties[n]))
  const metricsEdited = added.length > 0 || removed.length > 0 || changed.length > 0
  const badRanges = editable
    ? rangeProblems([...selectedNames].filter(n => rangeTypeOf(n) && ranges[n]).map(n => [n, ranges[n]]))
    : []

  const semanticNow = storedSemanticIdPair(schema?.semantic_id, schema?.semantic_id_type)
  const semanticEdited = storedSemanticIdPair(semantic.semanticId, semantic.semanticIdType)
  const dirty =
    metricsEdited ||
    description !== (schema?.description || '') ||
    changeDescription !== (schema?.change_description || '') ||
    semanticEdited.semanticId !== semanticNow.semanticId ||
    semanticEdited.semanticIdType !== semanticNow.semanticIdType

  /**
   * Everything a draft save writes. The definition goes only when the metric list or an entry
   * changed; api.js writes only the keys it is given, and sends the type as NULL when the id is blank.
   */
  const draftPatch = () => ({
    ...(metricsEdited && { schema_definition: buildDefinition() }),
    description,
    change_description: changeDescription,
    semantic_id: semanticEdited.semanticId,
    semantic_id_type: semanticEdited.semanticIdType
  })

  /**
   * @param {string} name Which action is running, 'save' or 'publish', so the clicked button can
   * report its own wait. They still share the lock: publishing writes the draft first.
   */
  const run = async (name, fn) => {
    if (busy) return
    setBusyAction(name)
    try {
      await fn()
    } catch (e) {
      // Terminates the promise chain: `run` is invoked from onClick, and handleSaveDraft in
      // SchemasTab rethrows after toasting so the publish sequence aborts. Swallowed because the
      // error was already shown; logged so a future caller that does not report is still
      // diagnosable.
      console.error('Schema action failed:', e)
    } finally {
      setBusyAction(null)
    }
  }

  const handleSaveDraft = () => run('save', async () => {
    await onSaveDraft?.(draftPatch())
  })

  const handlePublish = () => run('publish', async () => {
    // Saved first if dirty, so publishing can never activate a version missing the edits on screen.
    // The publish RPC takes no payload.
    if (dirty) await onSaveDraft?.(draftPatch())
    await onPublish?.()
  })

  const canSaveDraft = editable && canManage && selectedNames.size > 0 && badRanges.length === 0
  const rangeTitle = badRanges.length > 0 ? `Fix the range of ${badRanges.join(' ')}` : null

  const footer = (
    <>
      <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Close</button>

      {/* Visible here rather than behind an overflow menu: this is the screen someone is on
          when they want the file in an editor. It downloads what is stored, so on a dirty draft
          that is the last saved state. */}
      <Tooltip text={!schema?.schema_definition
        ? 'This version has no definition to download'
        : editable && dirty
          ? 'Downloads the last saved draft — unsaved changes are not included'
          : `Save ${schema?.schema_name}.schema.json to open in an editor or JSON Schema tool`}>
        <button
          className={`btn btn-ghost ${!schema?.schema_definition ? 'btn-disabled' : ''}`}
          disabled={!schema?.schema_definition || busy}
          onClick={() => onDownload?.()}
        >
          <IconDownload size={13} /> Download JSON
        </button>
      </Tooltip>

      {/* Both write buttons are locked by `busy`, but only the one clicked spins. */}
      {editable && (
        <ActionButton
          className={`btn btn-ghost ${!canSaveDraft || !dirty ? 'btn-disabled' : ''}`}
          disabled={!canSaveDraft || !dirty || busy}
          pending={busyAction === 'save'}
          pendingLabel="Saving…"
          onClick={handleSaveDraft}
          title={!canManage
            ? requiresRolesTitle(PERMISSION_UUIDS.SCHEMA_MANAGE)
            : rangeTitle || (!dirty ? 'No changes to save' : 'Save this draft without activating it')}
        >
          Save Draft
        </ActionButton>
      )}

      {editable && (
        <ActionButton
          className={`btn btn-primary ${!canSaveDraft ? 'btn-disabled' : ''}`}
          disabled={!canSaveDraft || busy}
          pending={busyAction === 'publish'}
          pendingLabel="Publishing…"
          onClick={handlePublish}
          title={!canManage
            ? requiresRolesTitle(PERMISSION_UUIDS.SCHEMA_MANAGE)
            : selectedNames.size === 0
              ? 'A published version must model at least one metric'
              : rangeTitle || `Activate v${schemaVersion(schema)}, archive its predecessor, and move every device across`}
        >
          <IconCheck size={13} /> {`Publish Version v${schemaVersion(schema)}`}
        </ActionButton>
      )}

      {/* The other way out of a draft: without it the only exit was to publish. Danger, not
          primary, and rightmost. */}
      {editable && onDiscard && (
        <Tooltip text={!canManage
          ? requiresRolesTitle(PERMISSION_UUIDS.SCHEMA_MANAGE)
          : `Delete draft v${schemaVersion(schema)} and leave its predecessor exactly as it is`}>
          <button
            type="button"
            className="btn btn-danger"
            disabled={!canManage || busy}
            onClick={onDiscard}
          >
            <IconTrash size={13} /> Discard Draft
          </button>
        </Tooltip>
      )}

      {/* The single primary action on a read-only version; disabled with the reason rather than
          hidden. */}
      {canForkSchema(schema) && (
        <ForkAction
          schema={schema}
          schemas={schemas}
          canManage={canManage}
          busy={busy}
          onFork={onFork}
        />
      )}
    </>
  )

  return (
    <Modal
      title={
        <>
          {schema?.schema_name}{' '}
          <Tooltip text={editable
            ? 'A draft is the only editable state. Publishing it activates it and archives its predecessor.'
            : `This version is ${statusLabel(status)} and immutable — create a new version to change it.`}>
            <span className={`badge ${statusBadgeClass(status)}`}>
              {schemaVersionLabel(schema)}
            </span>
          </Tooltip>
        </>
      }
      icon={editable ? <IconGitBranch size={18} /> : <IconLock size={18} />}
      size="lg"
      fill={editable}
      onClose={onClose}
      footer={footer}
    >
      {/* Why this version exists, before what it contains. */}
      <div
        style={{
          background: 'var(--bg-glass)', borderRadius: 'var(--radius)', padding: '12px 14px',
          marginBottom: '16px', borderLeft: '3px solid var(--accent)'
        }}
      >
        <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '5px' }}>
          Change Description
        </div>
        {editable ? (
          <Tooltip text="Why this version exists. Frozen once the version is published.">
            <textarea
              className="form-control"
              aria-label="Change Description"
              rows={2}
              value={changeDescription}
              onChange={e => setChangeDescription(e.target.value)}
              placeholder="e.g. Added spindle temperature threshold"
            />
          </Tooltip>
        ) : (
          <div style={{ fontSize: '13px', color: schema?.change_description ? 'var(--text-primary)' : 'var(--text-dim)' }}>
            {schema?.change_description || 'No change description was recorded for this version.'}
          </div>
        )}
      </div>

      {!editable && (
        <div
          style={{ display: 'flex', alignItems: 'flex-start', gap: '7px', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '16px' }}
        >
          <IconLock size={13} />
          <span>
            {status === SCHEMA_STATUS.ARCHIVED
              ? 'Archived: superseded by a later version and kept as history. It cannot be edited or re-activated.'
              : 'Active and read-only: devices are provisioned against this exact definition, so it is frozen. Create a version to change it.'}
          </span>
        </div>
      )}

      <div className="form-group">
        <label className="form-label">Schema UUID</label>
        <CopyableId value={schema?.schema_uuid} label="schema UUID" onNotify={showToast} />
      </div>

      <div className="form-group">
        <label className="form-label">Description</label>
        {editable ? (
          <input
            className="form-control"
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="What this schema is for"
          />
        ) : (
          <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>{schema?.description || '—'}</div>
        )}
      </div>

      <SemanticIdField
        idPrefix="schema-detail"
        subject="schema"
        readOnly={!editable}
        semanticId={semantic.semanticId}
        semanticIdType={semantic.semanticIdType}
        onChange={setSemantic}
      />

      {/* While editing, the catalog picker is the dialog's working list: it takes the height the
          window leaves (Modal `fill`) rather than a fixed cap. */}
      <div
        className={`form-group${editable ? ' modal-fill' : ''}`}
        style={editable ? { display: 'flex', flexDirection: 'column', minHeight: '240px' } : undefined}
      >
        <label className="form-label">
          Metrics <span className="section-count">{selectedNames.size}</span>
          {editable && metricsEdited && (
            <span style={{ fontWeight: 400, fontSize: '11px', color: 'var(--text-muted)', marginLeft: '8px' }}>
              {added.length > 0 && <span style={{ color: 'var(--success-text)' }}>+{added.length} </span>}
              {removed.length > 0 && <span style={{ color: 'var(--danger)' }}>−{removed.length} </span>}
              {changed.length > 0 && <span>{changed.length} changed </span>}
              vs. the last saved draft
            </span>
          )}
        </label>
        {/* Opening a draft can be enough to change it: a forked version takes the catalog as it is
            now, which is how a new version comes to carry permitted values its parent lacked. */}
        {editable && fromCatalog.length > 0 && (
          <p className="form-hint" style={{ marginTop: 0 }}>
            {fromCatalog.length === 1 ? 'One metric takes its' : `${fromCatalog.length} metrics take their`} description
            or permitted values from the Metrics page as it is now. Saving or publishing writes them into this draft.
          </p>
        )}
        {editable && badRanges.length > 0 && (
          <div role="alert" style={{ fontSize: '11px', color: 'var(--danger)', marginBottom: '4px' }}>
            Fix the range of {badRanges.join(' ')}
          </div>
        )}

        {editable ? (
          <>
            <input
              className="form-control"
              style={{ marginBottom: '8px' }}
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search catalog metrics…"
              aria-label="Search catalog metrics"
            />
            <div style={{ flex: '1 1 auto', minHeight: '160px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
              {filteredCatalog.length === 0 ? (
                <div style={{ padding: '12px', fontSize: '12px', color: 'var(--text-muted)' }}>No matching catalog metrics.</div>
              ) : (
                groupCatalog(filteredCatalog).map(group => (
                  <div key={group.label}>
                    <MetricGroupHeading
                      group={group}
                      picked={group.metrics.filter(m => selectedNames.has(m.name)).length}
                    />
                    {group.metrics.map(m => {
                      const ticked = selectedNames.has(m.name)
                      const ranged = ticked && rangeTypeOf(m.name) !== null
                      return (
                        // The range sits outside the label, so typing in it never toggles the tick.
                        <div key={m.metric_uuid} style={{ ...PICKER_ROW, paddingRight: ranged ? '12px' : 0 }}>
                          <label style={PICKER_ROW_LABEL}>
                            <input
                              type="checkbox"
                              checked={ticked}
                              onChange={() => toggleMetric(m.name)}
                              aria-label={m.name}
                            />
                            <span className="mono" style={{ fontSize: '12px' }}>{m.name}</span>
                            {/* What a save writes for a ticked metric; what is stored for the rest. */}
                            <StoredKeys entry={ticked && builtEntry(m.name) !== undefined ? builtEntry(m.name) : storedEntry(m.name)} />
                            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{datatypeLabel(m.datatype)}</span>
                            <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{m.standard || LOCAL_EXTENSION_LABEL}</span>
                          </label>
                          {ranged && (
                            <PropertyRange
                              name={m.name}
                              range={shownRange(m.name)}
                              onChange={range => setRanges(prev => ({ ...prev, [m.name]: range }))}
                            />
                          )}
                        </div>
                      )
                    })}
                  </div>
                ))
              )}
            </div>
          </>
        ) : (
          <div style={{ maxHeight: '220px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
            {selectedNames.size === 0 ? (
              <div style={{ padding: '12px', fontSize: '12px', color: 'var(--text-muted)' }}>This schema models no metrics.</div>
            ) : (
              [...selectedNames].map(name => (
                <div key={name} style={{ padding: '7px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <IconCheck size={12} />
                  <span className="mono" style={{ fontSize: '12px' }}>{name}</span>
                  <StoredKeys entry={storedEntry(name)} />
                </div>
              ))
            )}
          </div>
        )}

        {orphanedNames.length > 0 && (
          <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--warning-text)', display: 'flex', alignItems: 'flex-start', gap: '5px' }}>
            <IconAlertTriangle size={12} />
            <span>
              {orphanedNames.length} modelled metric{orphanedNames.length === 1 ? '' : 's'} no longer in the active
              catalog ({orphanedNames.map(n => <span key={n} className="mono">{n} </span>)}) — kept as-is
              {editable ? ', and kept on save. This dialog cannot remove them; only the REST API can.' : '.'}
            </span>
          </div>
        )}
      </div>

      {/* The lineage, oldest first. Only rendered once there is more than one version, so a
          schema nobody has ever forked does not carry a "History" heading listing itself. */}
      {lineage.length > 1 && (
        <div className="form-group">
          <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <IconHistory size={13} /> Version History <span className="section-count">{lineage.length}</span>
          </label>
          <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
            {lineage.map(v => {
              const isThis = (v.schema_uuid || v.id) === (schema?.schema_uuid || schema?.id)
              return (
                <div
                  key={v.schema_uuid || v.id}
                  style={{
                    padding: '8px 12px', borderBottom: '1px solid var(--border)',
                    background: isThis ? 'var(--bg-glass)' : 'transparent'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span className={`badge ${statusBadgeClass(schemaStatus(v))}`} style={{ fontSize: '11px' }}>
                      {schemaVersionLabel(v)}
                    </span>
                    <span className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{v.schema_name}</span>
                  </div>
                  <div style={{ fontSize: '11px', color: v.change_description ? 'var(--text-muted)' : 'var(--text-dim)', marginTop: '3px' }}>
                    {v.change_description || 'No change description recorded.'}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {editable && deviceCount === 0 && (
        <p className="form-hint">
          Publishing activates this version and archives its predecessor. Devices attached to the predecessor move across automatically.
        </p>
      )}
    </Modal>
  )
}

/**
 * Split out because the reason it is unavailable is worth stating: no authority, a draft already
 * open, or nothing wrong.
 */
function ForkAction({ schema, schemas, canManage, busy, onFork }) {
  const existingDraft = (schemas || []).find(s =>
    s.parent_schema_id === (schema?.schema_uuid || schema?.id) && schemaStatus(s) === SCHEMA_STATUS.DRAFT
  )
  const blocked = !canManage || !!existingDraft
  const next = nextVersion(schema)

  return (
    <Tooltip text={!canManage
      ? requiresRolesTitle(PERMISSION_UUIDS.SCHEMA_MANAGE)
      : existingDraft
        ? `A draft (${existingDraft.schema_name}) already exists for this schema — publish or discard it first`
        : `Create Version v${next}: an editable Draft v${next}, carrying every metric this version models`}>
      <button
        className={`btn btn-primary ${blocked ? 'btn-disabled' : ''}`}
        disabled={blocked || busy}
        onClick={() => !blocked && onFork?.()}
      >
        <IconGitBranch size={13} /> Create Version v{next}
      </button>
    </Tooltip>
  )
}
