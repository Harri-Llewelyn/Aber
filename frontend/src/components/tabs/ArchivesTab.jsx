import React, { useState, useEffect, useCallback } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS } from '../../constants'
import CopyableId from '../common/CopyableId'
// No ActionButton or usePendingKey here any more: both actions on this page run from inside a
// ConfirmModal, which owns its own pending state. A row-level spinner would have nothing to
// report -- the row's buttons now only open a dialog.
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
   * The manual half of the retention policy.
   *
   * `auto_delete_at` already purges on a timer; this is the same destruction on demand, for the
   * ordinary case of an asset archived by mistake or decommissioned for good before its timer
   * runs. It is a real DELETE, not another soft flag -- the row leaves the table and the digital
   * thread keeps its history, because archived migration 0006 makes the audit rows immutable and
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
          <h3 className="section-title">
            Archived Entities (Out of Commission)
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
                     {/* Restore is the ordinary move and Permanent Delete is the irreversible
                         one, so they are deliberately NOT peers: restore is a ghost button and
                         delete only takes on its danger colour when pointed at. A row of two
                         filled buttons invites the wrong one to be clicked at a glance. */}
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

      {/* Named in the prompt, not just "this entity": the archives table is a mixed list of
          cells, gateways and devices, and the wrong row is easy to hit.

          AND THE NAME HAS TO BE TYPED BACK (issue #38). This is the one irreversible action in
          the application, so it is the one dialog that asks for it. Every other ConfirmModal --
          here and elsewhere -- guards something recoverable, archiving being a soft flag with a
          Restore button beside it, and gating all of them would train people to type through the
          one dialog where reading it matters. Friction only buys attention while it is rare. */}
      {/* RESTORE ASKS FIRST NOW (issue #100), AND IT IS NOT GATED ON TYPING THE NAME.
          The rule the dialog below sets stands: friction only buys attention while it is rare, and
          restore is recoverable -- you can archive it again. What restore is NOT is consequence-free,
          which is why this asks at all rather than being left as a one-click act on a table of
          look-alike rows.

          IT NAMES THE TWO CONSEQUENCES THAT ARE NOT OBVIOUS, because "you can just archive it
          again" is the reason a confirmation here could look like ceremony, and it is not quite
          true:

            * THE RETENTION TIMER IS CLEARED, not paused. `/restore` sets `auto_delete_at` to NULL,
              and re-archiving computes a fresh window from today -- so an entity one day from
              auto-purge, restored by accident and put back, is now thirty days from it. The undo
              does not restore the clock.

            * A GATEWAY'S BROKER CREDENTIAL DOES NOT COME BACK. Archiving one rotates it to a
              password nobody records (0038, repredicated by 0063); restore flips `is_archived` and
              nothing else. So the gateway returns to the asset pages looking active and cannot
              authenticate -- the failure lands at the broker, not here. This says so, from
              `credential_revoked_at` rather than from a guess about whether it ever had one. */}
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
