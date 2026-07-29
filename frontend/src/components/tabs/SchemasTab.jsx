import React, { useState, useEffect, useCallback } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS } from '../../constants'
import { CreateSchemaModal } from '../modals/CreateSchemaModal'
import { ValidatePayloadModal } from '../modals/ValidatePayloadModal'
import { SchemaBuilderModal } from '../modals/SchemaBuilderModal'
import { DeprecateMetricModal } from '../modals/DeprecateMetricModal'
import { downloadJSON } from '../../utils/downloadJSON'
import { datatypeLabel, SPARKPLUG_DATATYPES } from '../../utils/sparkplugDatatype'
import { deviceSparkplugId, gatewaySparkplugId } from '../../utils/sparkplugId'
import CopyableId from '../common/CopyableId'
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
  const [showAddMetric, setShowAddMetric] = useState(false)
  const [newMetric, setNewMetric] = useState({ name: '', datatype: 10, description: '' })
  const [deprecateTarget, setDeprecateTarget] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [sch, cat, gw, dev] = await Promise.all([
        api.get('/api/v1/schemas'),
        api.get('/api/v1/metric-catalog'),
        api.get('/api/v1/gateways'),
        api.get('/api/v1/devices'),
      ])
      setSchemas(sch); setCatalog(cat); setGateways(gw); setDevices(dev)
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

  const handleAddMetric = async () => {
    try {
      await api.post('/api/v1/metric-catalog', newMetric)
      setNewMetric({ name: '', datatype: 10, description: '' })
      setShowAddMetric(false)
      load()
      showToast(`Metric '${newMetric.name}' added to the catalog`, 'success')
    } catch (e) {
      showToast(e.message, 'error')
    }
  }

  const usageCountFor = (metricName) =>
    schemas.filter(s => Array.isArray(s.schema_definition?.required) && s.schema_definition.required.includes(metricName)).length

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

        {showAddMetric && (
          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', margin: '16px 20px', padding: '12px', background: 'var(--bg-glass)', borderRadius: 'var(--radius)', flexWrap: 'wrap' }}>
            <div className="form-group" style={{ margin: 0, flex: '1 1 160px' }}>
              <label className="form-label">Metric Name</label>
              <input className="form-control" value={newMetric.name} onChange={e => setNewMetric(m => ({ ...m, name: e.target.value }))} placeholder="e.g. Robot.Axis.1.Angle" title="The literal Sparkplug B metric name devices will publish -- cannot be changed once created" />
            </div>
            <div className="form-group" style={{ margin: 0, flex: '0 1 140px' }}>
              <label className="form-label">Datatype</label>
              <select className="form-control" value={newMetric.datatype} onChange={e => setNewMetric(m => ({ ...m, datatype: parseInt(e.target.value, 10) }))}>
                {SPARKPLUG_DATATYPES.map(d => <option key={d.code} value={d.code}>{d.label}</option>)}
              </select>
            </div>
            <div className="form-group" style={{ margin: 0, flex: '2 1 200px' }}>
              <label className="form-label">Description</label>
              <input className="form-control" value={newMetric.description} onChange={e => setNewMetric(m => ({ ...m, description: e.target.value }))} placeholder="What this metric represents" />
            </div>
            <button className={`btn btn-primary btn-sm ${!newMetric.name.trim() ? 'btn-disabled' : ''}`} disabled={!newMetric.name.trim()} onClick={handleAddMetric} title="Add this metric to the catalog">
              Add
            </button>
          </div>
        )}

        {loading ? <div className="loading-wrap"><div className="spinner" /> Loading catalog…</div> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Datatype</th><th>Description</th><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
              <tbody>
                {activeCatalog.map(m => (
                  <tr key={m.metric_uuid}>
                    <td><span className="mono">{m.name}</span></td>
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
                {deprecatedCatalog.map(m => (
                  <tr key={m.metric_uuid} style={{ opacity: 0.5 }}>
                    <td><span className="mono" style={{ textDecoration: 'line-through' }}>{m.name}</span></td>
                    <td>{datatypeLabel(m.datatype)}</td>
                    <td style={{ color: 'var(--text-muted)' }}>
                      <span className="badge badge-warning" style={{ background: 'rgba(255,179,0,0.15)', color: 'var(--warning)', border: '1px solid var(--warning)' }}>
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
