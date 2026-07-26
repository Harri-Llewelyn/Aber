import React, { useState } from 'react'
import { IconBookOpen } from '../common/Icons'

export function CreateSchemaModal({ onSave, onCancel }) {
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const defaultDef = `{\n  "type": "object",\n  "properties": {\n    "vibration_rms": { "type": "number" },\n    "frequency_hz": { "type": "number" },\n    "status": { "type": "string" }\n  },\n  "required": ["vibration_rms", "status"]\n}`
  const [definition, setDefinition] = useState(defaultDef)
  const [jsonError, setJsonError] = useState(null)

  const handleSubmit = () => {
    try {
      const parsed = JSON.parse(definition)
      setJsonError(null)
      onSave({ schema_name: name, description: desc, schema_definition: parsed })
    } catch (e) {
      setJsonError(`Invalid JSON syntax: ${e.message}`)
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 540 }}>
        <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <IconBookOpen size={18} />
          <span>Register New Device JSON Schema</span>
        </div>

        <div className="form-group">
          <label className="form-label">Schema Name</label>
          <input className="form-control" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. CNC-Vibration-Standard-Schema" title="Unique descriptive name for the schema" />
        </div>

        <div className="form-group">
          <label className="form-label">Description</label>
          <input className="form-control" value={desc} onChange={e => setDesc(e.target.value)} placeholder="Brief description of specifications…" title="Purpose or industrial standard reference" />
        </div>

        <div className="form-group">
          <label className="form-label">JSON Schema Definition Specification</label>
          <textarea
            className="form-control mono"
            style={{ height: '180px', fontSize: '12px', lineHeight: '1.4' }}
            value={definition}
            onChange={e => setDefinition(e.target.value)}
            title="JSON Schema standard format specification"
          />
          {jsonError && <div style={{ color: 'var(--danger)', fontSize: '11px', marginTop: '4px' }}>{jsonError}</div>}
        </div>

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onCancel} title="Discard and cancel">Cancel</button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={!name} title="Register schema into database">Register Schema</button>
        </div>
      </div>
    </div>
  )
}
