import React, { useState } from 'react'
import { IconArchive } from '../common/Icons'
import { ConfirmModal } from './ConfirmModal'

export function ArchiveModal({ entityId, displayName, onArchive, onCancel }) {
  const [retentionDays, setRetentionDays] = useState(30)

  return (
    <ConfirmModal
      title="Archive entity (decommission)"
      size="md"
      icon={<IconArchive size={18} />}
      message={<>
        Decommissioning <strong>{displayName}</strong> <span className="mono">[{entityId}]</span> will mark it as archived. Historical telemetry and Audit Trail data remain 100% retained.
      </>}
      confirmLabel="Archive & Set Timer"
      pendingLabel="Archiving…"
      onConfirm={() => onArchive(retentionDays)}
      onCancel={onCancel}
    >
      <div className="form-group">
        <label className="form-label" htmlFor="archive-retention">Auto-Delete Retention Purge Timer</label>
        <select
          id="archive-retention"
          className="form-control"
          value={retentionDays}
          onChange={e => setRetentionDays(e.target.value ? parseInt(e.target.value, 10) : '')}
          title="Set compliance retention auto-purge window"
        >
          <option value={30}>30 Days Retention (Standard Audit)</option>
          <option value={90}>90 Days Retention (Quarterly Audit)</option>
          <option value={365}>365 Days Retention (1 Year Legal Compliance)</option>
          <option value="">Permanent Retention (Never Auto-Purge)</option>
        </select>
      </div>
    </ConfirmModal>
  )
}
