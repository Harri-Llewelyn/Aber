import React, { useState } from 'react'
import { api } from '../../api'
import { IconCheck } from '../common/Icons'
import { Modal } from '../common/Modal'

/**
 * `initialSchemaUuid` is the schema the caller already had in hand. The select stays even then:
 * "does this payload match v1 or v2?" is the question this modal answers best, and it is the only
 * place two versions can be tested against the same payload.
 */
export function ValidatePayloadModal({ schemas, initialSchemaUuid, onClose }) {
  // Falls back to the first schema rather than to nothing: opened without a target -- which no
  // call site does today -- an empty select would submit a validation against no schema at all.
  const [selectedSchemaUuid, setSelectedSchemaUuid] = useState(
    initialSchemaUuid || schemas[0]?.schema_uuid || ''
  )
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
    <Modal
      title="Validate Payload"
      icon={<IconCheck size={18} />}
      size="md"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose} title="Close validator modal">Close</button>
          <button className="btn btn-primary" onClick={handleValidate} disabled={loading} title="Run backend validation test">
            {loading ? 'Validating…' : 'Validate Payload'}
          </button>
        </>
      }
    >
      <div className="form-group">
        <label className="form-label">Select Target Schema Definition</label>
        <select className="form-control" value={selectedSchemaUuid} onChange={e => setSelectedSchemaUuid(e.target.value)} title="Choose schema to test against">
          {schemas.map(s => <option key={s.schema_uuid} value={s.schema_uuid}>{s.schema_name}</option>)}
        </select>
      </div>

      <div className="form-group">
        <label className="form-label">Candidate Telemetry JSON Payload</label>
        <textarea
          className="form-control mono validate-payload-input"
          value={payloadText}
          onChange={e => setPayloadText(e.target.value)}
          title="Paste sample telemetry payload JSON here"
        />
      </div>

      {result && (
        <div className={`callout ${result.valid ? 'callout-success' : 'callout-danger'}`} role="status">
          <span><strong>{result.valid ? 'VALID PAYLOAD' : 'INVALID PAYLOAD'}:</strong> {result.message || result.error}</span>
        </div>
      )}
    </Modal>
  )
}
