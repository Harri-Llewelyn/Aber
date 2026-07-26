import React, { useState, useEffect, useCallback } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS } from '../../constants'
import { CreateSchemaModal } from '../modals/CreateSchemaModal'
import { ValidatePayloadModal } from '../modals/ValidatePayloadModal'
import { IconCheck, IconPlus } from '../common/Icons'

export function SchemasTab({ showToast, hasPermission }) {
  const [schemas, setSchemas]         = useState([])
  const [loading, setLoading]         = useState(true)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showValidateModal, setShowValidateModal] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const sch = await api.get('/api/v1/schemas')
      setSchemas(sch)
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

  const canManageGateway = hasPermission(PERMISSION_UUIDS.GATEWAY_MANAGE)

  return (
    <>
      <div className="section-header" style={{ marginBottom: '8px' }}>
        <h2 className="section-title">Factory+ Schema Registry <span className="section-count">{schemas.length}</span></h2>
        <div style={{ display: 'flex', gap: '10px' }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowValidateModal(true)} disabled={schemas.length === 0} title="Test sample telemetry payload against registered schema rules">
            <IconCheck size={14} /> Validate Candidate Payload
          </button>
          <button
            className={`btn btn-primary btn-sm ${!canManageGateway ? 'btn-disabled' : ''}`}
            disabled={!canManageGateway}
            onClick={() => canManageGateway && setShowCreateModal(true)}
            title={!canManageGateway ? 'Requires Admin permissions' : 'Register new JSON Schema definition'}
          >
            <IconPlus size={14} /> Register New Schema
          </button>
        </div>
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '20px' }}>
        Centralized JSON Schema Registry for defining, registering, and interactively validating telemetry payload data structures against industrial standards.
      </p>

      <div className="card">
        {loading ? <div className="loading-wrap"><div className="spinner" /> Loading schemas…</div> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th title="Schema descriptive name">Schema Name</th><th title="Schema unique UUID">Schema UUID</th><th title="Industrial standard description">Description</th><th title="JSON Schema definition specs">Definition Specs</th></tr></thead>
              <tbody>
                {schemas.map(sch => (
                  <tr key={sch.schema_uuid}>
                    <td><strong>{sch.schema_name}</strong></td>
                    <td><span className="mono">{sch.schema_uuid}</span></td>
                    <td style={{ color: 'var(--text-muted)' }}>{sch.description || '—'}</td>
                    <td><code style={{ fontSize: '11px', color: 'var(--accent)' }}>{JSON.stringify(sch.schema_definition)}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showCreateModal && <CreateSchemaModal onSave={handleCreateSchema} onCancel={() => setShowCreateModal(false)} />}
      {showValidateModal && <ValidatePayloadModal schemas={schemas} onClose={() => setShowValidateModal(false)} />}
    </>
  )
}
