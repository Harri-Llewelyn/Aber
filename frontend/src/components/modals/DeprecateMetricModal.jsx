import React, { useState } from 'react'
import { IconAlertTriangle } from '../common/Icons'

export function DeprecateMetricModal({ metric, usageCount, catalog, onConfirm, onCancel }) {
  const [supersededBy, setSupersededBy] = useState('')

  const replacementCandidates = (catalog || []).filter(m => !m.deprecated && m.metric_uuid !== metric.metric_uuid)

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 460 }}>
        <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--warning-text)' }}>
          <IconAlertTriangle size={18} />
          <span>Deprecate Metric <span className="mono">{metric.name}</span></span>
        </div>

        <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '16px' }}>
          This retires <strong>{metric.name}</strong> from the schema builder's picker — it will no
          longer be offered for new schemas. {usageCount > 0 ? (
            <>It is currently referenced by <strong>{usageCount}</strong> existing schema{usageCount === 1 ? '' : 's'}, which will be left unchanged and keep working exactly as before.</>
          ) : (
            <>It is not currently referenced by any schema.</>
          )} The metric's name and datatype can never be edited — deprecating and adding a new
          catalog entry is the only way to change what it means.
        </p>

        <div className="form-group">
          <label className="form-label">Superseded By (optional)</label>
          <select className="form-control" value={supersededBy} onChange={e => setSupersededBy(e.target.value)} title="Point future schema authors at a replacement metric">
            <option value="">— No replacement —</option>
            {replacementCandidates.map(m => (
              <option key={m.metric_uuid} value={m.metric_uuid}>{m.name}</option>
            ))}
          </select>
        </div>

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onCancel} title="Cancel">Cancel</button>
          <button className="btn btn-primary" style={{ background: 'var(--warning)', color: '#000' }} onClick={() => onConfirm(supersededBy || null)} title="Confirm deprecation">
            Deprecate Metric
          </button>
        </div>
      </div>
    </div>
  )
}
