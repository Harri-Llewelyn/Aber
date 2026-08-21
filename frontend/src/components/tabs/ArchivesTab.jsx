import React, { useState, useEffect, useCallback } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS } from '../../constants'
import CopyableId from '../common/CopyableId'
import { ActionButton } from '../common/ActionButton'
import { usePendingKey } from '../../hooks/usePendingAction'
import { ConfirmModal } from '../modals/ConfirmModal'
import { IconArchive, IconRefreshCw, IconTrash } from '../common/Icons'

export function ArchivesTab({ showToast, hasPermission }) {
  const [archives, setArchives] = useState([])
  const [loading, setLoading]   = useState(true)
  const [confirmPurge, setConfirmPurge] = useState(null)

  const load = useCallback(() => {
    setLoading(true)
    api.get('/api/v1/archives').then(d => { setArchives(d); setLoading(false) }).catch(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  // Which row is mid-restore. This table mixes cells, gateways and devices, so the row identity
  // is what the operator is tracking; one shared boolean would spin all of them.
  const [restoringId, runRestore] = usePendingKey()

  const restore = async (item) => {
    try {
      await api.post(`/api/v1/${item.entity_type}s/${item.entity_id}/restore`, {})
      load(); showToast(`Entity '${item.name}' restored to active service`, 'success')
    } catch (e) { showToast(e.message, 'error') }
  }

  /**
   * The manual half of the retention policy.
   *
   * `auto_delete_at` already purges on a timer; this is the same destruction on demand, for the
   * ordinary case of an asset archived by mistake or decommissioned for good before its timer
   * runs. It is a real DELETE, not another soft flag -- the row leaves the table and the digital
   * thread keeps its history, because migration 0006 makes the audit rows immutable and
   * independent of the entity they describe.
   */
  const purge = async (item) => {
    try {
      await api.delete(`/api/v1/${item.entity_type}s/${item.entity_id}`)
      // Dismissed AFTER the delete, not before. Clearing it first closed the dialog on the click
      // and ran the irreversible half unobserved -- for the one action in the app that cannot be
      // undone, the confirmation is exactly where the wait belongs.
      setConfirmPurge(null)
      load(); showToast(`Entity '${item.name}' permanently deleted`, 'success')
    } catch (e) { showToast(e.message, 'error') }
  }

  const canArchive = hasPermission(PERMISSION_UUIDS.ARCHIVE_MANAGE)

  return (
    <>
      {/* Heading, description and the action row all gone -- this page has no actions of its own,
          so it starts directly on its table. The count the h2 carried moved into the card header
          below, which costs no extra row because the card needed a top edge either way. */}
      <div className="card">
        <div className="card-header">
          <h3 className="section-title">Archived Entities (Out of Commission) <span className="section-count">{archives.length}</span></h3>
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Retention timers run to the auto-purge date; Restore returns an entity to service.
          </span>
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
                     {/* Restore is the ordinary move and Permanent Delete is the irreversible
                         one, so they are deliberately NOT peers: restore is a ghost button and
                         delete only takes on its danger colour when pointed at. A row of two
                         filled buttons invites the wrong one to be clicked at a glance. */}
                     <td className="row-actions">
                       <ActionButton
                         className={`btn btn-sm btn-ghost ${!canArchive ? 'btn-disabled' : ''}`}
                         disabled={!canArchive}
                         pending={restoringId === a.entity_id}
                         pendingLabel="Restoring…"
                         onClick={() => runRestore(a.entity_id, () => restore(a))}
                         title={!canArchive ? 'Requires Admin permissions' : 'Restore entity back to active service'}
                       >
                         <IconRefreshCw size={12} /> Restore
                       </ActionButton>
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

      {/* Named in the prompt, not just "this entity": the archives table is a mixed list of
          cells, gateways and devices, and the wrong row is easy to hit.

          AND THE NAME HAS TO BE TYPED BACK (issue #38). This is the one irreversible action in
          the application, so it is the one dialog that asks for it. Every other ConfirmModal --
          here and elsewhere -- guards something recoverable, archiving being a soft flag with a
          Restore button beside it, and gating all of them would train people to type through the
          one dialog where reading it matters. Friction only buys attention while it is rare. */}
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
