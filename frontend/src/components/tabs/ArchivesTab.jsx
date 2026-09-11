import React, { useState, useEffect, useCallback } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS } from '../../constants'
import CopyableId from '../common/CopyableId'
// No ActionButton or usePendingKey here: both actions run from inside a ConfirmModal, which owns
// its own pending state.
import { ConfirmModal } from '../modals/ConfirmModal'
import { IconArchive, IconRefreshCw, IconTrash } from '../common/Icons'
import { HelpTip } from '../common/HelpTip'

export function ArchivesTab({ showToast, hasPermission }) {
  const [archives, setArchives] = useState([])
  const [loading, setLoading]   = useState(true)
  const [confirmPurge, setConfirmPurge] = useState(null)
  const [confirmRestore, setConfirmRestore] = useState(null)

  const load = useCallback(() => {
    setLoading(true)
    api.get('/api/v1/archives').then(d => { setArchives(d); setLoading(false) }).catch(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  const restore = async (item) => {
    try {
      await api.post(`/api/v1/${item.entity_type}s/${item.entity_id}/restore`, {})
      // Dismissed after the write, for the same reason as purge() below.
      setConfirmRestore(null)
      load(); showToast(`Entity '${item.name}' restored to active service`, 'success')
    } catch (e) { showToast(e.message, 'error') }
  }

  /**
   * The manual half of the retention policy. `auto_delete_at` purges on a timer; this is the same
   * destruction on demand. A real DELETE, not another soft flag: the row leaves the table and the
   * digital thread keeps its history, because audit rows are immutable and independent of the
   * entity.
   */
  const purge = async (item) => {
    try {
      await api.delete(`/api/v1/${item.entity_type}s/${item.entity_id}`)
      // Dismissed after the delete, not before, so the one irreversible action in the app runs
      // while the confirmation is still on screen.
      setConfirmPurge(null)
      load(); showToast(`Entity '${item.name}' permanently deleted`, 'success')
    } catch (e) { showToast(e.message, 'error') }
  }

  const canArchive = hasPermission(PERMISSION_UUIDS.ARCHIVE_MANAGE)

  return (
    <>
      {/* This page has no actions of its own, so it starts directly on its table; the count is in
          the card header. */}
      <div className="card">
        <div className="card-header">
          <h3 className="section-title">
            Archives
            <HelpTip
              label="About archived entities"
              text="An archived entity is out of commission but not gone: it keeps its identity and history, leaves the asset pages, and runs a retention timer to an auto-purge date. Restore returns it to service with everything intact."
            />
          </h3>
        </div>
        {loading ? <div className="loading-wrap"><div className="spinner" /> Loading archives…</div> :
         archives.length === 0 ? (
           <div className="empty-state">
             <div className="empty-icon"><IconArchive size={36} /></div>
             <div className="empty-text">No decommissioned entities currently in archives.</div>
           </div>
         ) : (
           <div className="table-wrap">
             <table>
               <thead><tr><th title="Entity Name">Name</th><th title="Entity ID">Entity ID</th><th title="Entity classification">Type</th><th title="Decommissioned timestamp">Archived At</th><th title="Retention compliance auto-purge timer">Auto-Purge Expiration</th><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
               <tbody>
                 {archives.map((a, i) => (
                   <tr key={i}>
                     <td><strong>{a.name}</strong></td>
                     <td><CopyableId value={a.entity_id} label="entity id" onNotify={showToast} /></td>
                     <td><span className="badge badge-warning">{a.entity_type.toUpperCase()}</span></td>
                     <td className="cell-meta">{a.archived_at ? new Date(a.archived_at).toLocaleString() : '—'}</td>
                     <td>
                       {a.auto_delete_at ? (
                         <span className="mono cell-purge-date">Purges: {new Date(a.auto_delete_at).toLocaleDateString()}</span>
                       ) : (
                         <span className="badge badge-neutral">Permanent (No Auto-Purge)</span>
                       )}
                     </td>
                     {/* Restore is the ordinary move and Permanent Delete the irreversible one, so
                         they are not peers: restore is a ghost button and delete only takes its
                         danger colour when pointed at. */}
                     <td className="row-actions">
                       <button
                         className={`btn btn-sm btn-ghost ${!canArchive ? 'btn-disabled' : ''}`}
                         disabled={!canArchive}
                         onClick={() => canArchive && setConfirmRestore(a)}
                         title={!canArchive ? 'Requires Admin permissions' : 'Restore entity back to active service'}
                       >
                         <IconRefreshCw size={12} /> Restore
                       </button>
                       <button
                         className={`btn btn-sm btn-danger btn-danger-reveal ${!canArchive ? 'btn-disabled' : ''}`}
                         disabled={!canArchive}
                         onClick={() => canArchive && setConfirmPurge(a)}
                         title={!canArchive ? 'Requires Admin permissions' : 'Delete this entity permanently — it cannot be restored'}
                       >
                         <IconTrash size={12} /> Permanent Delete
                       </button>
                     </td>
                   </tr>
                 ))}
               </tbody>
             </table>
           </div>
         )}
      </div>

      {/* Named in the prompt, because the archives table is a mixed list of cells, gateways and
          devices. The name has to be typed back: this is the one irreversible action in the
          application, and the only dialog that asks for it. */}
      {/* Restore asks first but is not gated on typing the name, since it is recoverable. It names
          the two consequences that are not obvious: the retention timer is cleared, not paused
          (`/restore` sets `auto_delete_at` to NULL and re-archiving computes a fresh window), and a
          gateway's broker credential does not come back (archiving rotated it; restore flips
          `is_archived` only), reported from `credential_revoked_at`. */}
      {confirmRestore && (
        <ConfirmModal
          message={
            `Restore the ${confirmRestore.entity_type} '${confirmRestore.name}' to active service? ` +
            'It reappears on the asset pages with its history intact, and its auto-purge timer is ' +
            'cleared — archiving it again starts a fresh retention window rather than resuming the ' +
            'one it had.' +
            (confirmRestore.entity_type === 'gateway' && confirmRestore.credential_revoked_at
              ? ' Its broker credential was revoked when it was archived and is not restored with it:' +
                ' mint a new one on the Access Control page before it can publish again.'
              : '')
          }
          confirmLabel="Restore"
          pendingLabel="Restoring…"
          confirmClassName="btn btn-primary"
          onConfirm={() => restore(confirmRestore)}
          onCancel={() => setConfirmRestore(null)}
        />
      )}

      {confirmPurge && (
        <ConfirmModal
          message={
            `Permanently delete the ${confirmPurge.entity_type} '${confirmPurge.name}'? ` +
            'This removes the record from the database immediately. It cannot be restored, and ' +
            'it does not wait for the retention timer. Its digital thread history is kept.'
          }
          pendingLabel="Deleting…"
          requireTyped={confirmPurge.name}
          requireTypedLabel={`${confirmPurge.entity_type} name`}
          onConfirm={() => purge(confirmPurge)}
          onCancel={() => setConfirmPurge(null)}
        />
      )}
    </>
  )
}
