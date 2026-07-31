import React, { useState, useEffect, useCallback } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS } from '../../constants'
import { CreateSchemaModal } from '../modals/CreateSchemaModal'
import { ValidatePayloadModal } from '../modals/ValidatePayloadModal'
import { SchemaBuilderModal } from '../modals/SchemaBuilderModal'
import { DeprecateMetricModal } from '../modals/DeprecateMetricModal'
import { downloadJSON } from '../../utils/downloadJSON'
import { datatypeLabel, SPARKPLUG_DATATYPES } from '../../utils/sparkplugDatatype'
import {
  groupCatalog, knownGroupNames, groupOptionsByStandard, canonicaliseGroup, isValidMetricName
} from '../../utils/metricGroup'
import { modelledMetrics } from '../../utils/deviceTags'
import {
  typesByCategory, subTypes, unitNames, categoryOfType, composeMTConnectName,
  MTCONNECT_STANDARD, CATEGORY_WITH_UNITS
} from '../../utils/mtconnect'

// Sentinel for the "not in the list yet" option in the group picker. Not a valid group name --
// the CHECK constraint on metric_groups.name rejects anything containing the separator.
const NEW_GROUP = '__new__'

// "Not in the MTConnect vocabulary". The standard itself allows extension, so this escape has to
// exist -- but it is a deliberate choice rather than the default path.
const CUSTOM_TYPE = '__custom__'
import { deviceSparkplugId, gatewaySparkplugId } from '../../utils/sparkplugId'
import CopyableId from '../common/CopyableId'
import { MTConnectVocabularyPanel } from '../common/MTConnectVocabularyPanel'
import { IconCheck, IconPlus, IconFileCode, IconAlertTriangle, IconArchive } from '../common/Icons'

export function SchemasTab({ showToast, hasPermission, onSelectSchema }) {
  const [schemas, setSchemas]         = useState([])
  const [catalog, setCatalog]         = useState([])
  const [gateways, setGateways]       = useState([])
  const [devices, setDevices]         = useState([])
  const [loading, setLoading]         = useState(true)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showValidateModal, setShowValidateModal] = useState(false)
  const [showBuilderModal, setShowBuilderModal] = useState(false)
  const [groups, setGroups]           = useState([])
  const [vocabulary, setVocabulary]   = useState([])
  const [showAddMetric, setShowAddMetric] = useState(false)
  // The metric name is composed from its MTConnect parts rather than typed whole: component
  // ("group"), an optional component instance, the data item type, and an optional subType.
  // NEW_GROUP / CUSTOM_TYPE are the sentinels for "not in the standard vocabulary" -- MTConnect
  // permits extension, so those escapes have to exist.
  const [newMetric, setNewMetric] = useState({
    group: '', newGroup: '', instance: '', type: '', customType: '',
    subType: '', units: '', datatype: 10, description: ''
  })
  const [deprecateTarget, setDeprecateTarget] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [sch, cat, grp, voc, gw, dev] = await Promise.all([
        api.get('/api/v1/schemas'),
        api.get('/api/v1/metric-catalog'),
        api.get('/api/v1/metric-groups'),
        api.get('/api/v1/mtconnect-vocabulary'),
        api.get('/api/v1/gateways'),
        api.get('/api/v1/devices'),
      ])
      setSchemas(sch); setCatalog(cat); setGroups(grp); setVocabulary(voc); setGateways(gw); setDevices(dev)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const handleCreateSchema = async (payload) => {
    try {
      await api.post('/api/v1/schemas', payload)
      setShowCreateModal(false)
      load()
      showToast(`Schema '${payload.schema_name}' registered successfully`, 'success')
    } catch (e) {
      showToast(e.message, 'error')
    }
  }

  // Clicking a data item type in the vocabulary panel starts a catalog entry from it: open the
  // Add Metric form with the type already chosen, leaving the component and instance -- the parts
  // the standard cannot know -- for the operator.
  const handleUseVocabularyType = (typeName) => {
    setNewMetric(m => ({ ...m, type: typeName, customType: '' }))
    setShowAddMetric(true)
  }

  const handleAddMetric = async () => {
    const composed = composedName
    try {
      // Register the group before the metric that will be the first to use it, so the vocabulary
      // stays complete even if the metric insert is then rejected. A group with no metrics is
      // harmless; a metric whose group nobody can find in the picker is not.
      if (effectiveGroup && !knownGroups.includes(effectiveGroup)) {
        await api.post('/api/v1/metric-groups', { name: effectiveGroup })
      }

      await api.post('/api/v1/metric-catalog', {
        name: composed,
        datatype: newMetric.datatype,
        category: effectiveCategory,
        // Stored alongside the name as well as inside it: the name is what the device publishes,
        // the column is what can be queried without parsing.
        sub_type: newMetric.subType,
        units: unitsApply ? newMetric.units : '',
        standard: usingCustomType ? '' : MTCONNECT_STANDARD,
        description: newMetric.description
      })
      setNewMetric({
        group: '', newGroup: '', instance: '', type: '', customType: '',
        subType: '', units: '', datatype: 10, description: ''
      })
      setShowAddMetric(false)
      load()
      showToast(`Metric '${composed}' added to the catalog`, 'success')
    } catch (e) {
      showToast(e.message, 'error')
    }
  }

  // Counts schemas that model the metric at all, not just those that mark it `required`. This
  // number is the impact warning on a destructive confirmation, so it must not understate: a
  // metric listed in `properties` but not `required` is still broken by deprecating it. Uses the
  // same modelledMetrics() the unmodelled-detection and device tags read, so the three cannot
  // disagree about what a schema covers.
  const usageCountFor = (metricName) =>
    schemas.filter(s => modelledMetrics(s)?.has(metricName)).length

  const deviceCountFor = (schemaUuid) =>
    devices.filter(d => d.schema_id === schemaUuid).length

  const handleDeprecate = async (supersededBy) => {
    try {
      await api.post(`/api/v1/metric-catalog/${deprecateTarget.metric_uuid}/deprecate`, { superseded_by: supersededBy })
      setDeprecateTarget(null)
      load()
      showToast(`Metric '${deprecateTarget.name}' deprecated`, 'success')
    } catch (e) {
      showToast(e.message, 'error')
    }
  }

  const handleBuilderSubmit = async (schemaPayload, deviceDetails, action) => {
    try {
      const saved = await api.post('/api/v1/schemas', schemaPayload)

      if (action === 'download') {
        // Provisioning is a prerequisite, not a separate action: the spec sheet has to quote the
        // Sparkplug identifiers the device and gateway will actually publish under, and those are
        // derived from database ids -- so the platform must issue them before it can tell an
        // engineer what to configure. The device name is just the label on the record.
        const device = await api.post('/api/v1/devices', {
          asset_name: deviceDetails.device_name,
          active_gateway_id: deviceDetails.gateway_id,
          schema_id: saved.schema_uuid
        })

        const gateway = gateways.find(g => g.gateway_id === deviceDetails.gateway_id)
        const gatewayId = gateway
          ? (gateway.sparkplug_id || gatewaySparkplugId(gateway.gateway_id))
          : 'YOUR_GATEWAY_SPARKPLUG_ID'
        const deviceId = device.sparkplug_id || deviceSparkplugId(device.id)

        const spec = {
          schema_name: schemaPayload.schema_name,
          schema_uuid: saved.schema_uuid,
          description: schemaPayload.description,
          metrics: schemaPayload.schema_definition.properties,
          required: schemaPayload.schema_definition.required,
          device_name: deviceDetails.device_name,
          device_sparkplug_id: deviceId,
          gateway_name: gateway?.gateway_name || null,
          gateway_sparkplug_id: gatewayId,
          topics: {
            dbirth: `spBv1.0/${deviceDetails.group_id}/DBIRTH/${gatewayId}/${deviceId}`,
            ddata: `spBv1.0/${deviceDetails.group_id}/DDATA/${gatewayId}/${deviceId}`
          }
        }
        downloadJSON(spec, `${deviceDetails.device_name}-spec-sheet.json`)
        showToast(`Schema saved, device '${deviceDetails.device_name}' provisioned, spec sheet downloaded`, 'success')
      } else {
        showToast(`Schema '${schemaPayload.schema_name}' saved`, 'success')
      }

      setShowBuilderModal(false)
      load()
    } catch (e) {
      showToast(e.message, 'error')
    }
  }

  const canManageSchema = hasPermission(PERMISSION_UUIDS.SCHEMA_MANAGE)
  const canDeprecateMetric = hasPermission(PERMISSION_UUIDS.ARCHIVE_MANAGE)
  const activeCatalog = catalog.filter(m => !m.deprecated)
  const deprecatedCatalog = catalog.filter(m => m.deprecated)
  // Grouped by the first dotted segment of the name; ungrouped metrics fall into a trailing
  // bucket rather than being hidden. Deprecated metrics stay a flat tail -- they are retired,
  // so filing them by category would just add noise to every group.
  const catalogGroups = groupCatalog(activeCatalog)

  // The vocabulary the picker offers: the curated registry (now MTConnect's component types)
  // plus anything already in use.
  const knownGroups = knownGroupNames(groups, catalog)
  // Bucketed by standard: 126 MTConnect component types in one flat list is not navigable.
  const groupOptions = groupOptionsByStandard(groups, catalog)
  const effectiveGroup = newMetric.group === NEW_GROUP
    ? canonicaliseGroup(newMetric.newGroup, knownGroups)
    : newMetric.group

  const usingCustomType = newMetric.type === CUSTOM_TYPE
  const effectiveType = usingCustomType ? newMetric.customType.trim() : newMetric.type
  // MTConnect assigns each data item type a category; it is not the operator's to choose, so it
  // is derived rather than offered. A custom type has none until someone says otherwise.
  const effectiveCategory = usingCustomType ? '' : categoryOfType(vocabulary, effectiveType)
  // Only SAMPLE is a continuously-varying measurement, so only SAMPLE carries units.
  const unitsApply = effectiveCategory === CATEGORY_WITH_UNITS
  const typeGroups = typesByCategory(vocabulary)
  const availableSubTypes = subTypes(vocabulary)
  const availableUnits = unitNames(vocabulary)
  // Typing a case variant of an established group resolves to the established spelling. Surfaced
  // before submitting, because the database rejects the fork outright and discovering that as an
  // error is a worse experience than being told up front.
  const groupCaseCollision =
    newMetric.group === NEW_GROUP &&
    newMetric.newGroup.trim() !== '' &&
    effectiveGroup !== newMetric.newGroup.trim()
  const composedName = composeMTConnectName({
    component: effectiveGroup,
    instance: newMetric.instance,
    type: effectiveType,
    subType: newMetric.subType
  })
  const canAddMetric =
    effectiveType !== '' &&
    isValidMetricName(composedName) &&
    (newMetric.group !== NEW_GROUP || newMetric.newGroup.trim() !== '')

  return (
    <>
      <div className="section-header" style={{ marginBottom: '8px' }}>
        <h2 className="section-title">Factory+ Schema Registry <span className="section-count">{schemas.length}</span></h2>
        <div style={{ display: 'flex', gap: '10px' }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowValidateModal(true)} disabled={schemas.length === 0} title="Test sample telemetry payload against registered schema rules">
            <IconCheck size={14} /> Validate Candidate Payload
          </button>
          <button
            className={`btn btn-ghost btn-sm ${!canManageSchema ? 'btn-disabled' : ''}`}
            disabled={!canManageSchema}
            onClick={() => canManageSchema && setShowBuilderModal(true)}
            title={!canManageSchema ? 'Requires Admin permissions' : 'Build a schema from the metric catalog, then download a spec sheet or provision a device'}
          >
            <IconFileCode size={14} /> Build Schema from Catalog
          </button>
          <button
            className={`btn btn-primary btn-sm ${!canManageSchema ? 'btn-disabled' : ''}`}
            disabled={!canManageSchema}
            onClick={() => canManageSchema && setShowCreateModal(true)}
            title={!canManageSchema ? 'Requires Admin permissions' : 'Register new JSON Schema definition'}
          >
            <IconPlus size={14} /> Register New Schema
          </button>
        </div>
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '20px' }}>
        Centralized JSON Schema Registry for defining, registering, and interactively validating telemetry payload data structures against industrial standards.
      </p>

      <div className="card" style={{ marginBottom: '24px' }}>
        {/* `.card-header`, not `.section-header`: the card has no padding of its own, so a plain
            section header would sit flush against its borders. */}
        <div className="card-header">
          <h3 className="section-title">Metric Catalog <span className="section-count">{activeCatalog.length}</span></h3>
          <button
            className={`btn btn-ghost btn-sm ${!canManageSchema ? 'btn-disabled' : ''}`}
            disabled={!canManageSchema}
            onClick={() => canManageSchema && setShowAddMetric(v => !v)}
            title={!canManageSchema ? 'Requires Admin permissions' : 'Add a new metric to the catalog'}
          >
            <IconPlus size={13} /> Add Metric
          </button>
        </div>

        <p style={{ color: 'var(--text-muted)', fontSize: '12px', margin: '12px 20px 0' }}>
          Metrics are grouped by the first segment of their name — <span className="mono">Axes/C/ANGLE</span> and{' '}
          <span className="mono">Axes/X/POSITION</span> both belong to <strong>Axes</strong>. The <span className="mono">/</span>{' '}
          separator is the one Sparkplug B uses for its own names (<span className="mono">Node Control/Rebirth</span>),
          and the one Factory+ and MTConnect use for component paths. The group is part of the name a device publishes,
          so it is visible in MQTT, TimescaleDB and Grafana, and — like the name itself — cannot be edited afterwards.
          Names without a separator are listed under <strong>Ungrouped</strong>.
        </p>

        {showAddMetric && (
          <div style={{ margin: '16px 20px', padding: '12px', background: 'var(--bg-glass)', borderRadius: 'var(--radius)' }}>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div className="form-group" style={{ margin: 0, flex: '0 1 170px' }}>
                <label className="form-label">Group</label>
                <select
                  className="form-control"
                  value={newMetric.group}
                  onChange={e => setNewMetric(m => ({ ...m, group: e.target.value }))}
                  title="The category this metric belongs to. Becomes the first segment of its name, so it is part of what the device publishes."
                >
                  <option value="">— No group —</option>
                  {groupOptions.map(bucket => (
                    <optgroup key={bucket.label} label={`${bucket.label} (${bucket.names.length})`}>
                      {bucket.names.map(g => <option key={g} value={g}>{g}</option>)}
                    </optgroup>
                  ))}
                  <option value={NEW_GROUP}>+ New group…</option>
                </select>
              </div>

              {newMetric.group === NEW_GROUP && (
                <div className="form-group" style={{ margin: 0, flex: '0 1 170px' }}>
                  <label className="form-label">New Group Name</label>
                  <input
                    className="form-control"
                    value={newMetric.newGroup}
                    onChange={e => setNewMetric(m => ({ ...m, newGroup: e.target.value.replace(/\//g, '') }))}
                    placeholder="e.g. Hydraulic"
                    title="A single name segment — it cannot contain a slash"
                  />
                </div>
              )}

              <div className="form-group" style={{ margin: 0, flex: '0 1 110px' }}>
                <label className="form-label">Instance</label>
                <input
                  className="form-control"
                  value={newMetric.instance}
                  onChange={e => setNewMetric(m => ({ ...m, instance: e.target.value.replace(/\//g, '') }))}
                  placeholder="e.g. C"
                  title="Which one, when the component occurs more than once — the axis name, the spindle number. Leave blank if there is only one."
                />
              </div>

              <div className="form-group" style={{ margin: 0, flex: '1 1 200px' }}>
                <label className="form-label">Data Item Type</label>
                <select
                  className="form-control"
                  value={newMetric.type}
                  onChange={e => setNewMetric(m => ({ ...m, type: e.target.value }))}
                  title="The MTConnect data item type. Grouped by category: SAMPLE is a continuous measurement, EVENT a discrete state change, CONDITION a fault or warning."
                >
                  <option value="">— Select a type —</option>
                  {typeGroups.map(g => (
                    <optgroup key={g.category} label={`${g.category} (${g.types.length})`}>
                      {g.types.map(t => <option key={t} value={t}>{t}</option>)}
                    </optgroup>
                  ))}
                  <option value={CUSTOM_TYPE}>+ Not in MTConnect…</option>
                </select>
              </div>

              {usingCustomType && (
                <div className="form-group" style={{ margin: 0, flex: '1 1 170px' }}>
                  <label className="form-label">Custom Type</label>
                  <input
                    className="form-control"
                    value={newMetric.customType}
                    onChange={e => setNewMetric(m => ({ ...m, customType: e.target.value.replace(/\//g, '') }))}
                    placeholder="e.g. VIBRATION_RMS"
                    title="A local extension. MTConnect permits these, but prefer a standard type where one fits."
                  />
                </div>
              )}

              <div className="form-group" style={{ margin: 0, flex: '0 1 150px' }}>
                <label className="form-label">Sub Type</label>
                <select
                  className="form-control"
                  value={newMetric.subType}
                  onChange={e => setNewMetric(m => ({ ...m, subType: e.target.value }))}
                  title="Optional MTConnect qualifier — ACTUAL vs COMMANDED vs TARGET. It becomes the last segment of the name, because Sparkplug keys only on the name and the variants would otherwise collide."
                >
                  <option value="">— None —</option>
                  {availableSubTypes.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>

              <div className="form-group" style={{ margin: 0, flex: '0 1 150px' }}>
                <label className="form-label">Units</label>
                <select
                  className="form-control"
                  value={unitsApply ? newMetric.units : ''}
                  disabled={!unitsApply}
                  onChange={e => setNewMetric(m => ({ ...m, units: e.target.value }))}
                  title={unitsApply
                    ? 'MTConnect units. The standard defines no default per type, so this is a choice, not a derivation.'
                    : 'Only SAMPLE data items carry units'}
                >
                  <option value="">— None —</option>
                  {availableUnits.map(u => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>

              <div className="form-group" style={{ margin: 0, flex: '0 1 140px' }}>
                <label className="form-label">Sparkplug Datatype</label>
                <select className="form-control" value={newMetric.datatype} onChange={e => setNewMetric(m => ({ ...m, datatype: parseInt(e.target.value, 10) }))} title="How the value is encoded on the wire. MTConnect does not specify this, so it stays a local choice.">
                  {SPARKPLUG_DATATYPES.map(d => <option key={d.code} value={d.code}>{d.label}</option>)}
                </select>
              </div>

              <div className="form-group" style={{ margin: 0, flex: '2 1 200px' }}>
                <label className="form-label">Description</label>
                <input className="form-control" value={newMetric.description} onChange={e => setNewMetric(m => ({ ...m, description: e.target.value }))} placeholder="What this metric represents" />
              </div>

              <button className={`btn btn-primary btn-sm ${!canAddMetric ? 'btn-disabled' : ''}`} disabled={!canAddMetric} onClick={handleAddMetric} title="Add this metric to the catalog">
                Add
              </button>
            </div>

            {/* The composed name is what actually goes on the wire and can never be edited
                afterwards, so it is shown rather than left to be inferred from two fields. */}
            <div style={{ marginTop: '10px', fontSize: '12px', color: 'var(--text-muted)' }}>
              Devices will publish this metric as{' '}
              <span className="mono" style={{ color: composedName ? 'var(--accent)' : 'var(--text-dim)' }}>
                {composedName || '…'}
              </span>
              {' '}— immutable once created.
              {effectiveCategory && <> Category <strong>{effectiveCategory}</strong>, from the MTConnect standard.</>}
              {usingCustomType && <> Recorded as a <strong>local extension</strong>, not an MTConnect standard type.</>}
            </div>

            {groupCaseCollision && (
              <div style={{ marginTop: '6px', fontSize: '12px', color: 'var(--warning-text)', display: 'flex', alignItems: 'center', gap: '5px' }}>
                <IconAlertTriangle size={12} />
                <span>
                  Group <span className="mono">{newMetric.newGroup.trim()}</span> already exists as{' '}
                  <span className="mono">{effectiveGroup}</span> — that spelling will be used, so the two do not fork.
                </span>
              </div>
            )}
          </div>
        )}

        {loading ? <div className="loading-wrap"><div className="spinner" /> Loading catalog…</div> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th title="MTConnect observation category">Category</th><th title="MTConnect units — SAMPLE data items only">Units</th><th>Datatype</th><th>Description</th><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
              {catalogGroups.map(group => (
                <tbody key={group.label}>
                  <tr>
                    <td colSpan={6} style={{ background: 'var(--bg-glass)', padding: '6px 12px', borderTop: '1px solid var(--border)' }}>
                      <span
                        style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: group.isUngrouped ? 'var(--text-muted)' : 'var(--accent)' }}
                        title={group.isUngrouped
                          ? 'These metric names carry no "Group.Metric" prefix, so they belong to no category'
                          : `Metrics named "${group.label}/…"`}
                      >
                        {group.label}
                      </span>
                      <span className="section-count" style={{ marginLeft: '8px' }}>{group.metrics.length}</span>
                    </td>
                  </tr>
                  {group.metrics.map(m => (
                    <tr key={m.metric_uuid}>
                      <td>
                        <span className="mono">{m.name}</span>
                        {/* MTConnect permits local extensions, so this marks provenance rather
                            than flagging a problem. */}
                        {!m.standard && m.category && (
                          <span style={{ fontSize: '10px', color: 'var(--text-dim)', marginLeft: '6px', fontStyle: 'italic' }} title="Local extension — not an MTConnect standard data item type">
                            local
                          </span>
                        )}
                      </td>
                      <td>
                        {m.category
                          ? <span className="badge badge-neutral" style={{ fontSize: '10px' }} title={`MTConnect ${m.category} observation`}>{m.category}</span>
                          : <span style={{ color: 'var(--text-dim)' }}>—</span>}
                      </td>
                      <td style={{ color: 'var(--text-muted)', fontSize: '11px' }}>{m.units || '—'}</td>
                      <td>{datatypeLabel(m.datatype)}</td>
                      <td style={{ color: 'var(--text-muted)' }}>{m.description || '—'}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button
                          className={`btn btn-ghost btn-sm ${!canDeprecateMetric ? 'btn-disabled' : ''}`}
                          disabled={!canDeprecateMetric}
                          onClick={() => canDeprecateMetric && setDeprecateTarget(m)}
                          title={!canDeprecateMetric ? 'Requires Admin permissions' : 'Retire this metric from the schema builder'}
                        >
                          <IconArchive size={12} /> Deprecate
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              ))}
              <tbody>
                {deprecatedCatalog.map(m => (
                  <tr key={m.metric_uuid} style={{ opacity: 0.5 }}>
                    <td><span className="mono" style={{ textDecoration: 'line-through' }}>{m.name}</span></td>
                    <td>{m.category || '—'}</td>
                    <td style={{ fontSize: '11px' }}>{m.units || '—'}</td>
                    <td>{datatypeLabel(m.datatype)}</td>
                    <td style={{ color: 'var(--text-muted)' }}>
                      <span className="badge badge-warning" style={{ background: 'rgba(255,179,0,0.15)', color: 'var(--warning-text)', border: '1px solid var(--warning)' }}>
                        <IconAlertTriangle size={10} /> DEPRECATED
                      </span>
                    </td>
                    <td></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Sits below the catalog: the catalog is this deployment's state and comes first, the
          vocabulary is the reference behind it. */}
      {!loading && (
        <MTConnectVocabularyPanel
          vocabulary={vocabulary}
          catalog={catalog}
          canAddMetric={canManageSchema}
          onUseType={handleUseVocabularyType}
        />
      )}

      <div className="card">
        <div className="card-header">
          <h3 className="section-title">Registered Schemas <span className="section-count">{schemas.length}</span></h3>
        </div>
        {loading ? <div className="loading-wrap"><div className="spinner" /> Loading schemas…</div> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th title="Schema descriptive name">Schema Name</th><th title="Schema unique UUID">Schema UUID</th><th title="Industrial standard description">Description</th><th title="Devices provisioned with this schema">Devices</th><th title="JSON Schema definition specs">Definition Specs</th></tr></thead>
              <tbody>
                {schemas.map(sch => {
                  const count = deviceCountFor(sch.schema_uuid)
                  return (
                    <tr key={sch.schema_uuid}>
                      <td><strong>{sch.schema_name}</strong></td>
                      <td><CopyableId value={sch.schema_uuid} label="schema UUID" onNotify={showToast} /></td>
                      <td style={{ color: 'var(--text-muted)' }}>{sch.description || '—'}</td>
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
                      <td><code style={{ fontSize: '11px', color: 'var(--accent)' }}>{JSON.stringify(sch.schema_definition)}</code></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showCreateModal && <CreateSchemaModal onSave={handleCreateSchema} onCancel={() => setShowCreateModal(false)} />}
      {showValidateModal && <ValidatePayloadModal schemas={schemas} onClose={() => setShowValidateModal(false)} />}
      {showBuilderModal && <SchemaBuilderModal catalog={catalog} gateways={gateways} onSubmit={handleBuilderSubmit} onCancel={() => setShowBuilderModal(false)} />}
      {deprecateTarget && (
        <DeprecateMetricModal
          metric={deprecateTarget}
          usageCount={usageCountFor(deprecateTarget.name)}
          catalog={catalog}
          onConfirm={handleDeprecate}
          onCancel={() => setDeprecateTarget(null)}
        />
      )}
    </>
  )
}
