import React, { useState, useMemo } from 'react'
import {
  IconGitBranch, IconLock, IconHistory, IconAlertTriangle, IconCheck, IconDownload, IconTrash
} from '../common/Icons'
import CopyableId from '../common/CopyableId'
import { ActionButton } from '../common/ActionButton'
import { datatypeLabel, datatypeToJsonSchemaType } from '../../utils/sparkplugDatatype'
import { groupCatalog } from '../../utils/metricGroup'
import { modelledMetrics } from '../../utils/deviceTags'
import { LOCAL_EXTENSION_LABEL } from '../../utils/standards'
import {
  schemaVersion, schemaStatus, statusLabel, statusBadgeClass, schemaVersionLabel,
  isSchemaEditable, canForkSchema, nextVersion, lineageOf, SCHEMA_STATUS
} from '../../utils/schemaVersion'
import { useEscapeKey } from '../../hooks/useEscapeKey'

/**
 * One modal, two modes, decided by the schema's own status rather than by a prop.
 *
 * READ-ONLY IS THE DEFAULT, and it is the same read-only the database enforces. An active or
 * archived version renders its metric set as a list, not as a form with a disabled Save --
 * `prevent_active_schema_mutation()` (archived migration 0037) would reject the write, so offering the
 * shape of an edit and failing at the end is worse than not offering it. `isSchemaEditable()` is
 * the single predicate both the mode switch and every affordance below read, and it fails closed:
 * a schema whose status could not be read renders read-only.
 *
 * The CHANGE DESCRIPTION IS SHOWN AT THE TOP, above the definition, because it is the only part of
 * a version that says why it exists. A registry that lists five versions of a schema and makes you
 * diff their JSON to work out what happened is a worse record than no versions at all.
 *
 * There is exactly ONE primary action in read-only mode -- Create Version -- and it is the whole
 * editing story: there is no Edit button, disabled or otherwise, because editing an active schema
 * is not a thing that can be done, permissions notwithstanding.
 */
export function SchemaDetailModal({
  schema, schemas = [], catalog = [], deviceCount = 0, canManage = false,
  onFork, onPublish, onDiscard, onSaveDraft, onDownload, onClose, showToast
}) {
  // Escape closes. Via the shared stack rather than a listener of this component's own,
  // because a ConfirmModal can open on top of this one and a bare document listener on each
  // would let one keypress dismiss both.
  useEscapeKey(onClose)

  const editable = isSchemaEditable(schema)
  const status = schemaStatus(schema)

  // Seeded from the schema's current definition. A draft always starts life as an exact copy of
  // its parent (fork_schema() copies the JSONB), so this opens showing what will be published if
  // nothing is touched.
  const [selectedNames, setSelectedNames] = useState(
    () => new Set(modelledMetrics(schema) || [])
  )
  const [description, setDescription] = useState(schema?.description || '')
  const [changeDescription, setChangeDescription] = useState(schema?.change_description || '')
  const [search, setSearch] = useState('')
  // Which write is running, not merely whether one is -- see `run` below.
  const [busyAction, setBusyAction] = useState(null)
  const busy = busyAction !== null

  const activeCatalog = useMemo(() => (catalog || []).filter(m => !m.deprecated), [catalog])

  const lineage = useMemo(() => lineageOf(schemas, schema), [schemas, schema])

  // Metrics the schema models that are no longer in the catalog -- deprecated since the version was
  // cut, or seeded by a migration that predates the catalog. They are listed rather than dropped:
  // silently losing a metric on save would narrow the contract a device is judged against, which
  // is the exact failure versioning exists to make visible.
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
  const dirty =
    added.length > 0 || removed.length > 0 ||
    description !== (schema?.description || '') ||
    changeDescription !== (schema?.change_description || '')

  /**
   * @param {string} name Which action is running -- 'save' or 'publish'. Was a bare boolean, which
   *   was enough to lock both buttons but not to say which of them the operator had clicked, so
   *   neither could report its own wait. They still SHARE the lock: publishing writes the draft
   *   first, so the two cannot overlap.
   */
  const run = async (name, fn) => {
    if (busy) return
    setBusyAction(name)
    try {
      await fn()
    } catch (e) {
      // TERMINATES THE PROMISE CHAIN. `run` is invoked straight from onClick, so nothing
      // downstream can handle a rejection -- and handleSaveDraft in SchemasTab deliberately
      // RETHROWS after toasting, purely so the publish sequence below aborts rather than
      // activating a version whose edits were rejected. That control-flow rethrow had nowhere
      // to land: it surfaced as an unhandled promise rejection in the browser console (and
      // failed the test suite's unhandled-rejection check) on every rejected save.
      //
      // Swallowed rather than re-reported because the error has ALREADY been shown to the user
      // by the handler that rethrew it; toasting again here would show it twice. Logged so a
      // rejection from some future caller that does not report is still diagnosable.
      console.error('Schema action failed:', e)
    } finally {
      setBusyAction(null)
    }
  }

  const handleSaveDraft = () => run('save', async () => {
    await onSaveDraft?.({
      schema_definition: buildDefinition(),
      description,
      change_description: changeDescription
    })
  })

  const handlePublish = () => run('publish', async () => {
    // Saved first, unconditionally-if-dirty, so publishing can never activate a version that is
    // missing the edits sitting in front of the operator. Two writes rather than one because the
    // publish RPC takes no payload -- it activates what is stored, and what is stored has to be
    // what was shown.
    if (dirty) {
      await onSaveDraft?.({
        schema_definition: buildDefinition(),
        description,
        change_description: changeDescription
      })
    }
    await onPublish?.()
  })

  const canSaveDraft = editable && canManage && selectedNames.size > 0

  return (
    <div className="modal-overlay">
      <div className="modal modal-lg">
        <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          {editable ? <IconGitBranch size={18} /> : <IconLock size={18} />}
          <span>{schema?.schema_name}</span>
          <span
            className={`badge ${statusBadgeClass(status)}`}
            title={editable
              ? 'A draft is the only editable state. Publishing it activates it and archives its predecessor.'
              : `This version is ${statusLabel(status)} and immutable — create a new version to change it.`}
          >
            {schemaVersionLabel(schema)}
          </span>
        </div>

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

        <div className="form-group">
          <label className="form-label">
            Metrics <span className="section-count">{selectedNames.size}</span>
            {editable && (added.length > 0 || removed.length > 0) && (
              <span style={{ fontWeight: 400, fontSize: '11px', color: 'var(--text-muted)', marginLeft: '8px' }}>
                {added.length > 0 && <span style={{ color: 'var(--success-text)' }}>+{added.length} </span>}
                {removed.length > 0 && <span style={{ color: 'var(--danger)' }}>−{removed.length}</span>}
                {' '}vs. this draft as forked
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

        <div className="modal-actions" style={{ flexWrap: 'wrap' }}>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Close</button>

          {/* Visible here rather than behind an overflow menu, unlike in the registry row. There
              is room, and this is the screen someone is already on when they decide they want the
              file open in an editor -- putting it one click further away on the one page where it
              is obviously wanted would be the wrong trade. It downloads what is STORED, so on a
              draft with unsaved edits it is the last saved state, not what is on screen. */}
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

          {/* Both write buttons are locked by `busy` -- publishing writes the draft first, so the
              two cannot overlap -- but only the one that was CLICKED spins. That is what
              busyAction buys over the boolean it replaced. */}
          {editable && (
            <ActionButton
              className={`btn btn-ghost ${!canSaveDraft || !dirty ? 'btn-disabled' : ''}`}
              disabled={!canSaveDraft || !dirty || busy}
              pending={busyAction === 'save'}
              pendingLabel="Saving…"
              onClick={handleSaveDraft}
              title={!canManage
                ? 'Requires Admin permissions'
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
                ? 'Requires Admin permissions'
                : selectedNames.size === 0
                  ? 'A published version must model at least one metric'
                  : `Activate v${schemaVersion(schema)}, archive its predecessor, and move every device across`}
            >
              <IconCheck size={13} /> {`Publish Version v${schemaVersion(schema)}`}
            </ActionButton>
          )}

          {/* THE OTHER WAY OUT OF A DRAFT, and until 0091 there wasn't one. The tooltip on the
              disabled Fork control has been saying "publish or discard it first" the whole time --
              and discarding was the half that did not exist, so the only exit from a draft nobody
              wanted was to PUBLISH it: archive the parent, repoint every attached device. That is
              a considerable act to be pushed into by the absence of a Cancel button.

              DANGER, NOT PRIMARY, and to the left of Publish: it destroys work, and the two must
              not read as a pair of equals. */}
          {editable && onDiscard && (
            <button
              type="button"
              className="btn btn-danger"
              disabled={!canManage || busy}
              onClick={onDiscard}
              title={!canManage
                ? 'Requires Admin permissions'
                : `Delete draft v${schemaVersion(schema)} and leave its predecessor exactly as it is`}
            >
              <IconTrash size={13} /> Discard Draft
            </button>
          )}

          {/* The single primary action on a read-only version. Rendered only when the schema is
              actually forkable, and disabled — with the reason — rather than hidden when the
              operator lacks the authority or a draft is already open. */}
          {canForkSchema(schema) && (
            <ForkAction
              schema={schema}
              schemas={schemas}
              canManage={canManage}
              busy={busy}
              onFork={onFork}
            />
          )}
        </div>

        {editable && deviceCount === 0 && (
          <div style={{ marginTop: '10px', fontSize: '11px', color: 'var(--text-muted)' }}>
            Publishing activates this version and archives its predecessor. Devices attached to the predecessor move across automatically.
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Split out because the reason it is unavailable is worth stating, and the three reasons read very
 * differently: no authority, a draft already open, or nothing wrong at all. A greyed-out button
 * that says none of them is the pattern `ActionMenu` exists to replace.
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
        ? 'Requires Admin permissions'
        : existingDraft
          ? `A draft (${existingDraft.schema_name}) already exists for this schema — publish or discard it first`
          : `Fork this schema into an editable draft at v${next}`}
    >
      <IconGitBranch size={13} /> Create Version (v{next})
    </button>
  )
}
