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

  // Seeded from the schema's current definition: a draft starts as an exact copy of its parent.
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
  // Which write is running, not merely whether one is -- see `run` below.
  const [busyAction, setBusyAction] = useState(null)
  const busy = busyAction !== null

  const activeCatalog = useMemo(() => (catalog || []).filter(m => !m.deprecated), [catalog])

  const lineage = useMemo(() => lineageOf(schemas, schema), [schemas, schema])

  // Metrics the schema models that are no longer in the catalog. Listed rather than dropped:
  // silently losing one on save would narrow the contract a device is judged against.
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

  /** The JSON Schema document a draft save writes. Same shape the builder produces. */
  const buildDefinition = () => {
    const byName = new Map(activeCatalog.map(m => [m.name, m]))
    const properties = {}
    const names = [...selectedNames]
    names.forEach(name => {
      const metric = byName.get(name)
      // An orphaned metric keeps whatever type the existing definition gave it, rather than being
      // re-derived from a catalog row that no longer exists.
      properties[name] = metric
        ? { type: datatypeToJsonSchemaType(metric.datatype) }
        : (schema?.schema_definition?.properties?.[name] || { type: 'string' })
    })
    return { type: 'object', properties, required: names }
  }

  const modelledNow = modelledMetrics(schema) || new Set()
  const added = [...selectedNames].filter(n => !modelledNow.has(n))
  const removed = [...modelledNow].filter(n => !selectedNames.has(n))
  const semanticNow = storedSemanticIdPair(schema?.semantic_id, schema?.semantic_id_type)
  const semanticEdited = storedSemanticIdPair(semantic.semanticId, semantic.semanticIdType)
  const dirty =
    added.length > 0 || removed.length > 0 ||
    description !== (schema?.description || '') ||
    changeDescription !== (schema?.change_description || '') ||
    semanticEdited.semanticId !== semanticNow.semanticId ||
    semanticEdited.semanticIdType !== semanticNow.semanticIdType

  /** Everything a draft save writes. api.js sends the type as NULL when the id is blank. */
  const draftPatch = () => ({
    schema_definition: buildDefinition(),
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

  const canSaveDraft = editable && canManage && selectedNames.size > 0

  const footer = (
    <>
      <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Close</button>

      {/* Visible here rather than behind an overflow menu: this is the screen someone is on
          when they want the file in an editor. It downloads what is stored, so on a dirty draft
          that is the last saved state. */}
      <button
        className={`btn btn-ghost ${!schema?.schema_definition ? 'btn-disabled' : ''}`}
        disabled={!schema?.schema_definition || busy}
        onClick={() => onDownload?.()}
        title={!schema?.schema_definition
          ? 'This version has no definition to download'
          : editable && dirty
            ? 'Downloads the last saved draft — unsaved changes are not included'
            : `Save ${schema?.schema_name}.schema.json to open in an editor or JSON Schema tool`}
      >
        <IconDownload size={13} /> Download JSON
      </button>

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
            : !dirty ? 'No changes to save' : 'Save this draft without activating it'}
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
              : `Activate v${schemaVersion(schema)}, archive its predecessor, and move every device across`}
        >
          <IconCheck size={13} /> {`Publish Version v${schemaVersion(schema)}`}
        </ActionButton>
      )}

      {/* The other way out of a draft: without it the only exit was to publish. Danger, not
          primary, and rightmost. */}
      {editable && onDiscard && (
        <button
          type="button"
          className="btn btn-danger"
          disabled={!canManage || busy}
          onClick={onDiscard}
          title={!canManage
            ? requiresRolesTitle(PERMISSION_UUIDS.SCHEMA_MANAGE)
            : `Delete draft v${schemaVersion(schema)} and leave its predecessor exactly as it is`}
        >
          <IconTrash size={13} /> Discard Draft
        </button>
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
          <span
            className={`badge ${statusBadgeClass(status)}`}
            title={editable
              ? 'A draft is the only editable state. Publishing it activates it and archives its predecessor.'
              : `This version is ${statusLabel(status)} and immutable — create a new version to change it.`}
          >
            {schemaVersionLabel(schema)}
          </span>
        </>
      }
      icon={editable ? <IconGitBranch size={18} /> : <IconLock size={18} />}
      size="lg"
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
          <textarea
            className="form-control"
            rows={2}
            value={changeDescription}
            onChange={e => setChangeDescription(e.target.value)}
            placeholder="e.g. Added spindle temperature threshold"
            title="Why this version exists. Frozen once the version is published."
          />
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

      <div className="form-group">
        <label className="form-label">
          Metrics <span className="section-count">{selectedNames.size}</span>
          {editable && (added.length > 0 || removed.length > 0) && (
            <span style={{ fontWeight: 400, fontSize: '11px', color: 'var(--text-muted)', marginLeft: '8px' }}>
              {added.length > 0 && <span style={{ color: 'var(--success-text)' }}>+{added.length} </span>}
              {removed.length > 0 && <span style={{ color: 'var(--danger)' }}>−{removed.length}</span>}
              {' '}vs. the last saved draft
            </span>
          )}
        </label>

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
            <div style={{ maxHeight: '240px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
              {filteredCatalog.length === 0 ? (
                <div style={{ padding: '12px', fontSize: '12px', color: 'var(--text-muted)' }}>No matching catalog metrics.</div>
              ) : (
                groupCatalog(filteredCatalog).map(group => (
                  <div key={group.label}>
                    <div
                      style={{ position: 'sticky', top: 0, background: 'var(--bg-glass)', backdropFilter: 'blur(4px)', padding: '5px 12px', borderBottom: '1px solid var(--border)', fontSize: '11px', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: group.isUngrouped ? 'var(--text-muted)' : 'var(--accent)' }}
                    >
                      {group.label} <span style={{ opacity: 0.7 }}>({group.metrics.length})</span>
                    </div>
                    {group.metrics.map(m => (
                      <label key={m.metric_uuid} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={selectedNames.has(m.name)}
                          onChange={() => toggleMetric(m.name)}
                          aria-label={m.name}
                        />
                        <span className="mono" style={{ fontSize: '12px' }}>{m.name}</span>
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{datatypeLabel(m.datatype)}</span>
                        <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{m.standard || LOCAL_EXTENSION_LABEL}</span>
                      </label>
                    ))}
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
              {editable ? ', and kept on save unless you clear the schema of them deliberately.' : '.'}
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
    <button
      className={`btn btn-primary ${blocked ? 'btn-disabled' : ''}`}
      disabled={blocked || busy}
      onClick={() => !blocked && onFork?.()}
      title={!canManage
        ? requiresRolesTitle(PERMISSION_UUIDS.SCHEMA_MANAGE)
        : existingDraft
          ? `A draft (${existingDraft.schema_name}) already exists for this schema — publish or discard it first`
          : `Create Version v${next}: an editable Draft v${next}, carrying every metric this version models`}
    >
      <IconGitBranch size={13} /> Create Version v{next}
    </button>
  )
}
