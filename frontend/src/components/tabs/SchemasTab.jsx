import React, { useState, useEffect, useCallback } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS } from '../../constants'
import { ValidatePayloadModal } from '../modals/ValidatePayloadModal'
import { SchemaBuilderModal } from '../modals/SchemaBuilderModal'
import { SchemaDetailModal } from '../modals/SchemaDetailModal'
import { SchemaForkModal } from '../modals/SchemaForkModal'
import { ConfirmModal } from '../modals/ConfirmModal'
import { downloadJSON } from '../../utils/downloadJSON'
import {
  schemaVersionLabel, schemaStatus, statusBadgeClass, statusLabel, isSchemaEditable,
  canForkSchema, nextVersion, isCurrentSchema, SCHEMA_STATUS
} from '../../utils/schemaVersion'
import CopyableId from '../common/CopyableId'
import { ContextPanel, rowSelectHandler } from '../common/ContextPanel'
import {
  IconCheck, IconClipboardList, IconCpu, IconX, IconLock, IconGitBranch, IconPencil, IconDownload, IconTrash
} from '../common/Icons'
import { HelpTip } from '../common/HelpTip'
import { useArrivalSelection } from '../../hooks/useArrivalSelection'

/**
 * @param {Function} onSelectSchema Opens the Devices page filtered to a schema.
 *
 * @param {Function} onSelectDevice Opens one device on the Devices page.
 *
 * @param {string} initialSchemaId A schema to open on arrival, handed over by a device drawer's
 * Schema chip.
 */
export function SchemasTab({ showToast, hasPermission, onSelectSchema, onSelectDevice, initialSchemaId }) {
  const [schemas, setSchemas]         = useState([])
  const [catalog, setCatalog]         = useState([])
  const [devices, setDevices]         = useState([])
  const [loading, setLoading]         = useState(true)
  const [showValidateModal, setShowValidateModal] = useState(false)
  const [showBuilderModal, setShowBuilderModal] = useState(false)
  // Version lifecycle. `detailSchema` is the version being read or edited; `forkTarget` the one a
  // new version is cut from. Two states, because forking is reachable from the table and from the
  // detail modal. An id rather than the object: the list reloads after every fork, publish and
  // deprecate.
  const [selectedId, setSelectedId] = useState(null)
  const [detailSchema, setDetailSchema] = useState(null)
  const [forkTarget, setForkTarget] = useState(null)
  // The draft awaiting a discard confirmation. Held as the OBJECT so the dialog can name the
  // version it is about -- "discard the draft" is not a sentence somebody should have to trust.
  const [discardTarget, setDiscardTarget] = useState(null)
  /**
   * The registry's two filters. Status replaces the old Archived Versions toggle, which was a
   * status filter wearing a button. `current` is the default, so superseded versions stay out of
   * the working list until asked for.
   */
  const [statusFilter, setStatusFilter] = useState('current')
  const [schemaSearch, setSchemaSearch] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      // The catalog is still read here, for the schema builder and the detail modal's metric
      // picker: a schema is built from catalog rows, so the page that builds one needs them even
      // though it no longer lists them. Devices are for the per-schema counts. Gateways are not
      // read at all -- a schema is bound to a device, and which gateway serves that device is the
      // Devices page's question.
      const [sch, cat, dev] = await Promise.all([
        api.get('/api/v1/schemas'),
        api.get('/api/v1/metric-catalog'),
        api.get('/api/v1/devices'),
      ])
      setSchemas(sch); setCatalog(cat); setDevices(dev)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  /**
   * The devices provisioned against one exact schema version: submodels if any, else the 1:1
   * `schema_id`, the rule `schemasForDevice` applies from the other direction. The list, with the
   * count derived from it.
   */
  const devicesForSchema = (schemaUuid) =>
    devices.filter(d =>
      (d.submodel_schema_ids?.length ? d.submodel_schema_ids : [d.schema_id]).includes(schemaUuid)
    )

  const deviceCountFor = (schemaUuid) => devicesForSchema(schemaUuid).length

  /**
   * Save a schema the builder composed, and nothing else. The dialog used to register a device and
   * download a spec sheet as well; a device is given its schema on the Devices page, where its
   * gateway, cell and conformance policy are decided too, and the definition is downloaded from
   * this page's context panel.
   */
  const handleBuilderSubmit = async (schemaPayload) => {
    try {
      await api.post('/api/v1/schemas', schemaPayload)
      showToast(`Schema '${schemaPayload.schema_name}' saved`, 'success')
      setShowBuilderModal(false)
      load()
    } catch (e) {
      showToast(e.message, 'error')
    }
  }

  /**
   * Fork an active schema into the next draft version. The version number is derived by
   * `fork_schema()`, and `enforce_schema_version_provenance()` refuses an insert that names one.
   * The draft opens immediately.
   */
  const handleFork = async (changeDescription) => {
    const parent = forkTarget
    try {
      const draft = await api.post(`/api/v1/schemas/${parent.schema_uuid}/versions`, {
        change_description: changeDescription
      })
      setForkTarget(null)
      const refreshed = await api.get('/api/v1/schemas')
      setSchemas(refreshed)
      setDetailSchema(refreshed.find(s => s.schema_uuid === draft.schema_uuid) || null)
      showToast(`Draft v${draft.version} created as '${draft.schema_name}'`, 'success')
    } catch (e) {
      showToast(e.message, 'error')
    }
  }

  const handleSaveDraft = async (patch) => {
    if (!detailSchema) return
    try {
      await api.put(`/api/v1/schemas/${detailSchema.schema_uuid}`, patch)
      const refreshed = await api.get('/api/v1/schemas')
      setSchemas(refreshed)
      setDetailSchema(refreshed.find(s => s.schema_uuid === detailSchema.schema_uuid) || null)
      showToast(`Draft '${detailSchema.schema_name}' saved`, 'success')
    } catch (e) {
      showToast(e.message, 'error')
      // Rethrown so the modal's publish path does not activate a version whose edits were rejected.
      throw e
    }
  }

  const handlePublish = async () => {
    if (!detailSchema) return
    try {
      const result = await api.post(`/api/v1/schemas/${detailSchema.schema_uuid}/publish`, {})
      setDetailSchema(null)
      // Devices carry the schema binding, so both lists are stale after a publish.
      load()
      const moved = result.devices_rebound || 0
      showToast(
        `v${result.version} published${result.archived_schema_name ? `, v${result.version - 1} archived` : ''}` +
        (moved > 0 ? ` — ${moved} device binding${moved === 1 ? '' : 's'} moved across` : ''),
        'success'
      )
    } catch (e) {
      showToast(e.message, 'error')
    }
  }

  /**
   * Discard the open draft. One draft may exist per lineage, so without this the only way out of an
   * unwanted draft was to publish it.
   */
  const handleDiscardDraft = async () => {
    if (!discardTarget) return
    try {
      const result = await api.post(`/api/v1/schemas/${discardTarget.schema_uuid}/discard`, {})
      setDiscardTarget(null)
      setDetailSchema(null)
      // The lineage moved and so may device bindings, so both lists are stale.
      load()
      const detached = result.devices_detached || 0
      showToast(
        `Draft v${result.version} discarded` +
        (detached > 0
          // Said out loud rather than left to be discovered: a draft can be attached to a machine
          // to try it out, and those attachments go with it.
          ? ` — ${detached} device attachment${detached === 1 ? '' : 's'} removed with it`
          : ''),
        'success'
      )
    } catch (e) {
      showToast(e.message, 'error')
    }
  }

  /**
   * Download a version's definition as a standalone `.schema.json`. The stored document verbatim,
   * so it diffs cleanly against the database and the previous version; the identity rides on the
   * filename, which carries the version. `.schema.json` so editors and tooling recognise it.
   */
  const handleDownloadSchema = (sch) => {
    if (!sch?.schema_definition) {
      // downloadJSON() returns silently on falsy data, so an empty definition would look like a
      // button that does nothing. Say what happened instead.
      showToast(`Schema '${sch?.schema_name || 'unknown'}' has no definition to download`, 'error')
      return
    }
    const filename = `${sch.schema_name}.schema.json`
    downloadJSON(sch.schema_definition, filename)
    showToast(`Downloaded ${filename}`, 'success')
  }

  const canManageSchema = hasPermission(PERMISSION_UUIDS.SCHEMA_MANAGE)
  // Superseded versions stay out of the working list until asked for. Drafts do not: opening one is
  // the only way to finish it. See isCurrentSchema().
  const archivedCount = schemas.filter(s => !isCurrentSchema(s)).length
  const currentCount = schemas.length - archivedCount
  const draftCount = schemas.filter(s => schemaStatus(s) === SCHEMA_STATUS.DRAFT).length
  const activeCount = schemas.filter(s => schemaStatus(s) === SCHEMA_STATUS.ACTIVE).length

  const matchesStatusFilter = (s) => {
    if (statusFilter === 'all') return true
    if (statusFilter === 'current') return isCurrentSchema(s)
    return schemaStatus(s) === statusFilter
  }

  /**
   * Narrows the registry by name, UUID and change description, all columns of this table, so a hit
   * can always be seen. The catalog on the Metrics page matches name alone for the same reason.
   */
  const schemaSearchTerm = schemaSearch.trim().toLowerCase()
  const matchesSchemaSearch = (s) =>
    !schemaSearchTerm || [s.schema_name, s.schema_uuid, s.change_description]
      .some(field => String(field || '').toLowerCase().includes(schemaSearchTerm))

  const visibleSchemas = schemas.filter(s => matchesStatusFilter(s) && matchesSchemaSearch(s))
  // Drives the Clear button and its count. `current` is the resting state, not a filter.
  const schemaFilterCount = (statusFilter !== 'current' ? 1 : 0) + (schemaSearchTerm ? 1 : 0)
  const clearSchemaFilters = () => { setStatusFilter('current'); setSchemaSearch('') }

  // Arriving from a device drawer's Schema chip. Read from the prop and the URL: the query string
  // survives a reload and a shared link, the prop covers a navigation that pushed none.
  const arrivingSchemaId =
    new URLSearchParams(window.location.search).get('search') || initialSchemaId || ''
  /**
   * Arriving opens the drawer and reveals the row. The hook matches over every schema, so the
   * drawer could open on a row the filters hide; the arrival widens whatever would hide it. Widen
   * rather than clear: `current` is itself the filter that hides a superseded version.
   */
  useArrivalSelection(
    arrivingSchemaId,
    schemas,
    (s, term) => s.schema_uuid === term,
    (s) => {
      setSelectedId(s.schema_uuid)
      setSchemaSearch('')
      setStatusFilter(prev => {
        const shown = prev === 'all'
          || (prev === 'current' ? isCurrentSchema(s) : schemaStatus(s) === prev)
        return shown ? prev : 'all'
      })
    }
  )

  // Resolved fresh every render -- see the note on selectedId.
  const selectedSchema = schemas.find(s => s.schema_uuid === selectedId) || null
  const selectedStatus = selectedSchema ? schemaStatus(selectedSchema) : null
  // A lineage may hold at most one open draft (a partial unique index), so forking again before it
  // is published or discarded is refused.
  const selectedDraft = selectedSchema
    ? schemas.find(s => s.parent_schema_id === selectedSchema.schema_uuid && schemaStatus(s) === SCHEMA_STATUS.DRAFT)
    : null
  const selectedForkBlocked = !canManageSchema || !!selectedDraft

  return (
    <div className="page-layout">
      <div className="page-main">

      {/* No PageHeading: one card, whose header is already the page's title, as on every other
          single-card page. It carried one while the metric catalogue shared the page and neither
          card could speak for both. */}
      <div className="card" style={{ marginBottom: 'var(--stack)' }}>
        <div className="card-header">
          {/* FILTERED OF TOTAL, not a bare count. A narrowed registry would otherwise read as a
              short one, which is the wrong thing to believe about a version history. */}
          <h3 className="section-title">
            Schemas
            <HelpTip
              label="About schemas"
              text="What a device is modelled to publish, built from the Metrics page. A published schema is read-only: create the next version to get an editable draft. Publishing it moves every device across at once."
            />
            {visibleSchemas.length !== schemas.length && (
              <span
                className="section-count"
                title={`${visibleSchemas.length} of ${schemas.length} versions match the current filters`}
              >
                {`${visibleSchemas.length}/${schemas.length}`}
              </span>
            )}
          </h3>
          {/* The page's primary action, in the header of the card it acts on. Validate Candidate
              Payload is a schema's own action in the drawer, where the target is already chosen. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            {/* The only way to create a schema. Building from the catalog is what guarantees every
                metric has a standard and a semantic id, which device tags, unmodelled detection and
                the tag filters all read. */}
            <button
              className={`btn btn-primary btn-sm ${!canManageSchema ? 'btn-disabled' : ''}`}
              disabled={!canManageSchema}
              onClick={() => canManageSchema && setShowBuilderModal(true)}
              title={!canManageSchema ? 'Requires Admin permissions' : 'Compose a schema from catalog metrics. Attach it to a device on the Devices page'}
            >
              <IconClipboardList size={14} /> Build Schema from Catalog
            </button>
          {/* The Archived Versions toggle is an option in the status select above. */}
          </div>
        </div>

        <div className="card-body">
      {/* The registry gains a row per publish rather than per schema, so it outgrows a plain list
          faster than anything else here. */}
      <div className="filter-bar">
        <select
          className="form-control"
          style={{ width: '190px' }}
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          aria-label="Filter schemas by lifecycle state"
          title="Filter by lifecycle state. Current hides superseded versions."
        >
          {/* Counts in the labels, as on Cells and Gateways: it is how the archived count survived
              losing its badge, and it answers "is there any history at all?" without selecting. */}
          <option value="current">Current ({currentCount})</option>
          <option value={SCHEMA_STATUS.ACTIVE}>Active ({activeCount})</option>
          <option value={SCHEMA_STATUS.DRAFT}>Draft ({draftCount})</option>
          <option value={SCHEMA_STATUS.ARCHIVED}>Archived ({archivedCount})</option>
          <option value="all">All versions ({schemas.length})</option>
        </select>

        <input
          className="form-control"
          style={{ width: '260px' }}
          value={schemaSearch}
          onChange={e => setSchemaSearch(e.target.value)}
          placeholder="Search name, UUID or description…"
          aria-label="Search the schema registry"
          title="Filter schemas by name, UUID or change description"
        />

        {schemaFilterCount > 0 && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={clearSchemaFilters}
            title="Clear every filter"
          >
            <IconX size={13} /> Clear filters ({schemaFilterCount})
          </button>
        )}
      </div>
        </div>{/* .card-body */}
        {loading ? <div className="loading-wrap"><div className="spinner" /> Loading schemas…</div> : visibleSchemas.length === 0 ? (
          /* Says why it is empty, as the catalog's empty state does: a blank table reads as a
             failed load rather than a filter doing its job. */
          <div className="empty-state" style={{ padding: '20px var(--inset)' }}>
            <div className="empty-icon"><IconClipboardList size={36} /></div>
            <div className="empty-text">
              {schemas.length === 0
                ? 'No schemas registered yet — build one from the metric catalog.'
                : schemaSearchTerm
                  ? <>No schema matches <strong>{schemaSearch.trim()}</strong>.</>
                  : 'No schema versions in this lifecycle state.'}
            </div>
          </div>
        ) : (
          /* `.table-scroll` still caps the height and pins the header row. It is no longer holding
             a second card open below -- the catalog has its own page -- but the registry gains a
             row per publish rather than per schema, so it is the list here that runs away. */
          <div className="table-wrap table-scroll">
            <table>
              <thead><tr><th title="Schema descriptive name">Schema Name</th><th title="Lineage position and lifecycle state. Only a draft is editable.">Version</th><th title="Why this version exists, recorded when it was created">Change Description</th><th title="Schema unique UUID">Schema UUID</th><th title="Devices provisioned with this schema">Devices</th></tr></thead>
              <tbody>
                {visibleSchemas.map(sch => {
                  const count = deviceCountFor(sch.schema_uuid)
                  const status = schemaStatus(sch)
                  return (
                    <tr
                      key={sch.schema_uuid}
                      className={`row-selectable${selectedId === sch.schema_uuid ? ' row-selected' : ''}`}
                      style={status === SCHEMA_STATUS.ARCHIVED ? { opacity: 0.6 } : undefined}
                      onClick={rowSelectHandler(() => setSelectedId(id => id === sch.schema_uuid ? null : sch.schema_uuid))}
                      title="Click to inspect this schema in the details panel"
                    >
                      <td>
                        <strong>{sch.schema_name}</strong>
                        {/* A published version is read-only, and the lock says so on the row
                            rather than only once the modal is open. */}
                        {!isSchemaEditable(sch) && (
                          <span
                            style={{ marginLeft: '6px', color: 'var(--text-dim)', verticalAlign: 'middle' }}
                            title={`Read-only — this version is ${statusLabel(status)}`}
                          >
                            <IconLock size={11} />
                          </span>
                        )}
                      </td>
                      <td>
                        <span
                          className={`badge ${statusBadgeClass(status)}`}
                          title={isSchemaEditable(sch)
                            ? 'Draft — editable until published'
                            : `${statusLabel(status)} and immutable`}
                        >
                          {schemaVersionLabel(sch)}
                        </span>
                      </td>
                      {/* Constrained: a change description is free text and `.table-wrap` scrolls
                          horizontally, so an unbounded cell pushes the action buttons off-screen. */}
                      <td style={{ maxWidth: '280px', color: sch.change_description ? 'var(--text-muted)' : 'var(--text-dim)', fontSize: '12px' }}>
                        {sch.change_description || '—'}
                      </td>
                      <td><CopyableId value={sch.schema_uuid} label="schema UUID" onNotify={showToast} /></td>
                      <td>
                        {/* The count is the natural entry point to "which devices are these?",
                            so it navigates to the Devices page filtered to this schema. */}
                        <button
                          type="button"
                          className="count-link"
                          disabled={count === 0}
                          onClick={() => count > 0 && onSelectSchema?.(sch.schema_uuid)}
                          title={count === 0
                            ? 'No devices are provisioned with this schema'
                            : `Show the ${count} device${count === 1 ? '' : 's'} using this schema`}
                        >
                          <span className="section-count">{count}</span>
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Keyed on the schema UUID so switching versions remounts the modal; otherwise the editor's
          seeded metric selection would survive the switch. */}
      {detailSchema && (
        <SchemaDetailModal
          key={detailSchema.schema_uuid}
          schema={detailSchema}
          schemas={schemas}
          catalog={catalog}
          deviceCount={deviceCountFor(detailSchema.schema_uuid)}
          canManage={canManageSchema}
          showToast={showToast}
          onFork={() => { setForkTarget(detailSchema); setDetailSchema(null) }}
          onDownload={() => handleDownloadSchema(detailSchema)}
          onSaveDraft={handleSaveDraft}
          onPublish={handlePublish}
          onDiscard={() => setDiscardTarget(detailSchema)}
          onClose={() => setDetailSchema(null)}
        />
      )}

      {/* Typed confirmation, because this destroys work: a draft is somebody's editing session, and
          the delete cascades to device attachments made to try it out. Same guard the archive flows
          use. */}
      {discardTarget && (
        <ConfirmModal
          title="Discard draft"
          icon={<IconTrash size={18} />}
          message={
            <>
              Discard draft <strong>{discardTarget.schema_name}</strong> (v{discardTarget.version})?
              {' '}Its predecessor stays exactly as it is — active, attached, unarchived — so the
              lineage returns to the state it was in before the fork. Any device attachments made
              to try this draft out are removed with it. This cannot be undone.
            </>
          }
          requireTyped={discardTarget.schema_name}
          requireTypedLabel="schema name"
          confirmLabel="Discard Draft"
          pendingLabel="Discarding…"
          onConfirm={handleDiscardDraft}
          onCancel={() => setDiscardTarget(null)}
        />
      )}

      {forkTarget && (
        <SchemaForkModal
          schema={forkTarget}
          deviceCount={deviceCountFor(forkTarget.schema_uuid)}
          onConfirm={handleFork}
          onCancel={() => setForkTarget(null)}
        />
      )}

      {/* The drawer's selection is the starting target; the modal's own select still lets it be
          changed, so one payload can be tested against two versions without retyping it. */}
      {showValidateModal && (
        <ValidatePayloadModal
          schemas={schemas}
          initialSchemaUuid={selectedSchema?.schema_uuid}
          onClose={() => setShowValidateModal(false)}
        />
      )}
      {showBuilderModal && <SchemaBuilderModal catalog={catalog} onSubmit={handleBuilderSubmit} onCancel={() => setShowBuilderModal(false)} />}
      </div>

      <ContextPanel
        open={!!selectedSchema}
        onClose={() => setSelectedId(null)}
        type="SCHEMA"
        onCopy={showToast}
        title={selectedSchema?.schema_name || ''}
        subtitle={selectedSchema && (
          <>
            <span className={`badge ${statusBadgeClass(selectedStatus)}`} style={{ fontSize: '11px' }}>
              {statusLabel(selectedStatus)}
            </span>
            <span className="badge badge-neutral" style={{ fontSize: '11px' }}>{schemaVersionLabel(selectedSchema)}</span>
          </>
        )}
        fields={selectedSchema ? [
          { label: 'Schema UUID', value: selectedSchema.schema_uuid, mono: true, copyable: true },
          { label: 'Version', value: schemaVersionLabel(selectedSchema) },
          {
            label: 'Lifecycle',
            value: statusLabel(selectedStatus),
            title: isSchemaEditable(selectedSchema)
              ? 'A draft. This is the only state in which a schema can be edited.'
              : 'Published or archived, and therefore immutable. Fork it to make changes.'
          },
          { label: 'Change Description', value: selectedSchema.change_description || null, full: true },
          {
            label: 'Parent Schema',
            value: selectedSchema.parent_schema_id
              ? (schemas.find(s => s.schema_uuid === selectedSchema.parent_schema_id)?.schema_name || selectedSchema.parent_schema_id)
              : null,
            full: true,
            title: 'The version this one was forked from. Absent on the first version of a lineage.'
          },
          {
            // The chips answer which devices; the action below opens the Devices page filtered to
            // this schema, for when the answer is forty of them.
            label: 'Provisioned Devices',
            value: (() => {
              const attached = devicesForSchema(selectedSchema.schema_uuid)
              if (attached.length === 0) return null
              return (
                <div className="context-device-list">
                  {attached.map(d => (
                    <button
                      key={d.asset_id}
                      className="chip chip-link"
                      onClick={() => onSelectDevice?.(d.asset_id)}
                      title={`Open ${d.asset_name} on the Devices page`}
                    >
                      <IconCpu size={11} />
                      <span className="chip-name">{d.asset_name}</span>
                    </button>
                  ))}
                </div>
              )
            })(),
            full: true,
            title: 'Devices registered against this exact version. Each opens on the Devices page.'
          },
        ] : []}
        actions={selectedSchema ? [
          {
            label: isSchemaEditable(selectedSchema) ? 'Edit Draft' : 'View Schema Detail',
            icon: isSchemaEditable(selectedSchema) ? <IconPencil size={13} /> : <IconClipboardList size={13} />,
            onClick: () => setDetailSchema(selectedSchema),
            primary: true,
            title: isSchemaEditable(selectedSchema)
              ? 'Edit this draft version and publish it'
              : 'View this version — its definition, change description and lineage'
          },
          // Offered only on a version that can be forked: a draft is not a lineage head and an
          // archived version is history. Shown disabled where meaningful but blocked, never where
          // meaningless.
          canForkSchema(selectedSchema) && {
            label: `Create Version (v${nextVersion(selectedSchema)})`,
            icon: <IconGitBranch size={13} />,
            onClick: () => setForkTarget(selectedSchema),
            disabled: selectedForkBlocked,
            title: !canManageSchema
              ? 'Requires Admin permissions'
              : selectedDraft
                ? `A draft (${selectedDraft.schema_name}) already exists — publish or discard it first`
                : `Fork this schema into an editable draft at v${nextVersion(selectedSchema)}`
          },
          {
            label: `View ${deviceCountFor(selectedSchema.schema_uuid)} Provisioned Device(s)`,
            icon: <IconCpu size={13} />,
            onClick: () => onSelectSchema?.(selectedSchema.schema_uuid),
            disabled: deviceCountFor(selectedSchema.schema_uuid) === 0,
            title: deviceCountFor(selectedSchema.schema_uuid) === 0
              ? 'No device is provisioned with this schema version'
              : 'Open the Devices page filtered to this schema'
          },
          {
            label: 'Validate Payload', icon: <IconCheck size={13} />,
            onClick: () => setShowValidateModal(true),
            disabled: !selectedSchema.schema_definition,
            title: selectedSchema.schema_definition
              ? `Test a sample telemetry payload against ${schemaVersionLabel(selectedSchema)} of ${selectedSchema.schema_name}`
              : 'This version has no definition to validate against'
          },
          {
            // Was the sole item behind the row's "More" menu. With the Actions column gone this is
            // its only home, and here it costs a line rather than a click to reveal a click.
            label: 'Download Definition (JSON)', icon: <IconDownload size={13} />,
            onClick: () => handleDownloadSchema(selectedSchema),
            disabled: !selectedSchema.schema_definition,
            title: selectedSchema.schema_definition
              ? `Save ${selectedSchema.schema_name}.schema.json to open in an editor or JSON Schema tool`
              : 'This version has no definition to download'
          },
        ].filter(Boolean) : []}
      />
    </div>
  )
}
