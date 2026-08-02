import React, { useState } from 'react'
import { api } from '../../api'
import { IconCheck } from '../common/Icons'

export function ValidatePayloadModal({ schemas, onClose }) {
  const [selectedSchemaUuid, setSelectedSchemaUuid] = useState(schemas[0]?.schema_uuid || '')
  // MTConnect names and value vocabularies: EXECUTION is READY/ACTIVE/INTERRUPTED/…,
  // EMERGENCY_STOP is ARMED/TRIGGERED. See archive/20260101000019_mtconnect_catalog_migration.sql.
  const defaultPayload = `{\n  "Systems/TEMPERATURE": 42.5,\n  "Controller/EXECUTION": "ACTIVE",\n  "Controller/EMERGENCY_STOP": "ARMED"\n}`
  const [payloadText, setPayloadText] = useState(defaultPayload)
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)

  const handleValidate = async () => {
    setLoading(true)
    setResult(null)
    try {
      const parsed = JSON.parse(payloadText)
      const res = await api.post('/api/v1/schemas/validate', {
        schema_uuid: selectedSchemaUuid,
        payload: parsed
      })
      setResult(res)
    } catch (e) {
      setResult({ valid: false, error: `JSON Parse / Network Error: ${e.message}` })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 560 }}>
        <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <IconCheck size={18} />
          <span>Interactive Payload Schema Validator</span>
        </div>

        <div className="form-group">
          <label className="form-label">Select Target Schema Definition</label>
          <select className="form-control" value={selectedSchemaUuid} onChange={e => setSelectedSchemaUuid(e.target.value)} title="Choose schema to test against">
            {schemas.map(s => <option key={s.schema_uuid} value={s.schema_uuid}>{s.schema_name}</option>)}
          </select>
        </div>

        <div className="form-group">
          <label className="form-label">Candidate Telemetry JSON Payload</label>
          <textarea
            className="form-control mono"
            style={{ height: '150px', fontSize: '12px' }}
            value={payloadText}
            onChange={e => setPayloadText(e.target.value)}
            title="Paste sample telemetry payload JSON here"
          />
        </div>

        {result && (
          <div style={{
            padding: '12px 16px', borderRadius: '8px', marginBottom: '16px', fontSize: '13px',
            background: result.valid ? 'rgba(0,232,150,0.12)' : 'rgba(255,77,109,0.12)',
            border: `1px solid ${result.valid ? 'var(--success)' : 'var(--danger)'}`,
            color: result.valid ? 'var(--success)' : 'var(--danger)'
          }}>
            <strong>{result.valid ? 'VALID PAYLOAD' : 'INVALID PAYLOAD'}:</strong> {result.message || result.error}
          </div>
        )}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose} title="Close validator modal">Close</button>
          <button className="btn btn-primary" onClick={handleValidate} disabled={loading} title="Run backend validation test">
            {loading ? 'Validating…' : 'Validate Payload'}
          </button>
        </div>
      </div>
    </div>
  )
}
