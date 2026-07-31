import React, { useState } from 'react'
import { IconArchive } from '../common/Icons'

export function ArchiveModal({ entityType, entityId, displayName, onArchive, onCancel }) {
  const [retentionDays, setRetentionDays] = useState(30)

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 460 }}>
        <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--warning-text)' }}>
          <IconArchive size={18} />
          <span>Archive Entity (Decommission)</span>
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '16px' }}>
          Decommissioning <strong>{displayName}</strong> <span className="mono">[{entityId}]</span> will mark it as archived. Historical telemetry and Digital Thread data remain 100% retained.
        </p>

        <div className="form-group">
          <label className="form-label">Auto-Delete Retention Purge Timer</label>
          <select className="form-control" value={retentionDays} onChange={e => setRetentionDays(e.target.value ? parseInt(e.target.value, 10) : '')} title="Set compliance retention auto-purge window">
            <option value={30}>30 Days Retention (Standard Audit)</option>
            <option value={90}>90 Days Retention (Quarterly Audit)</option>
            <option value={365}>365 Days Retention (1 Year Legal Compliance)</option>
            <option value="">Permanent Retention (Never Auto-Purge)</option>
          </select>
        </div>

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onCancel} title="Cancel archival action">Cancel</button>
          <button className="btn btn-primary" style={{ background: 'var(--warning)', color: '#000' }} onClick={() => onArchive(retentionDays)} title="Archive entity and activate retention timer">
            Archive & Set Timer
          </button>
        </div>
      </div>
    </div>
  )
}
