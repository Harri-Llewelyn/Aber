import React, { useState } from 'react'
import { IconArchive } from '../common/Icons'
import { ConfirmModal } from './ConfirmModal'

/**
 * Archive an entity: out of service and off the asset pages, restorable, with an auto-purge timer
 * that deletes the archived record for good. `onArchive` receives the timer in days, or '' for
 * none.
 */
export function ArchiveModal({ entityId, displayName, onArchive, onCancel }) {
  const [retentionDays, setRetentionDays] = useState(30)

  return (
    <ConfirmModal
      title="Archive entity"
      size="md"
      icon={<IconArchive size={18} />}
      message={<>
        Archiving <strong>{displayName}</strong> <span className="mono">[{entityId}]</span> takes
        it out of service and off the asset pages. Its record, its audit trail and its identifiers
        are kept, and Restore on the Archived Entities page brings it back. Archiving a gateway
        also revokes its broker credential and archives its forge repository. Raw readings are
        not held back: they still age out of the historian on its raw window.
      </>}
      confirmLabel="Archive"
      pendingLabel="Archiving…"
      onConfirm={() => onArchive(retentionDays)}
      onCancel={onCancel}
    >
      <div className="form-group">
        <label className="form-label" htmlFor="archive-retention">Auto-purge</label>
        <select
          id="archive-retention"
          className="form-control"
          value={retentionDays}
          onChange={e => setRetentionDays(e.target.value ? parseInt(e.target.value, 10) : '')}
          title="How long the archived record is kept before it is deleted for good"
        >
          <option value={30}>After 30 days</option>
          <option value={90}>After 90 days</option>
          <option value={365}>After 1 year</option>
          <option value="">Never (delete by hand)</option>
        </select>
        <p className="form-hint">
          The archived record is deleted for good when the timer runs out. Its audit trail is kept.
        </p>
      </div>
    </ConfirmModal>
  )
}
