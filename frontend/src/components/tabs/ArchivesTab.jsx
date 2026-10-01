import React, { useState, useEffect, useCallback } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS } from '../../constants'
import { requiresRolesTitle } from '../../hooks/usePermissions'
import CopyableId from '../common/CopyableId'
// Restore and delete run from inside a ConfirmModal, which owns its own pending state; the export
// is the one action that runs from the row.
import { ConfirmModal } from '../modals/ConfirmModal'
import { gatewayRepositoryUrl } from '../common/GatewayRepositoryPanel'
import { downloadBlob } from '../../utils/downloadBlob'
import { PageHeading } from '../common/PageHeading'
import { IconArchive, IconRefreshCw, IconTrash, IconDownload, IconHistory, IconExternalLink } from '../common/Icons'
import { HelpTip } from '../common/HelpTip'
import { Badge } from '../common/Badge'
import { SectionCount } from '../common/SectionCount'
import { EmptyState } from '../common/EmptyState'
import { LoadingState } from '../common/LoadingState'
import { formatDate, formatDateTime } from '../../utils/format'

/** The page's singular row type -> the Audit Trail page's handover type. */
const TRAIL_TYPE = { area: 'AREA', cell: 'CELL', gateway: 'GATEWAY', device: 'DEVICE' }

/**
 * Two cards, two stages of one lifecycle. The first is what archiving leaves: the row still in its
 * table, restorable, its retention timer running. It takes the page's spare height and scrolls.
 * The second is what deleting leaves: the row gone, a tombstone written by the database on the
 * DELETE, with links to what survives it -- the audit trail, a gateway's repository in the forge,
 * any bundle exported while it was alive, and the historian id its readings are still keyed by. It
 * keeps its natural height.
 */
export function ArchivesTab({ showToast, hasPermission, onViewTrail }) {
  const [archives, setArchives] = useState([])
  const [retired, setRetired]   = useState([])
  const [exports, setExports]   = useState([])
  const [loading, setLoading]   = useState(true)
  const [confirmPurge, setConfirmPurge] = useState(null)
  const [confirmRestore, setConfirmRestore] = useState(null)
  // The device whose bundle is being taken, so its own button reports progress.
  const [exporting, setExporting] = useState(null)

  const load = useCallback(() => {
    Promise.all([
      api.get('/api/v1/archives'),
      // Both tolerated: a reader admitted here by `archive:manage` may lack the roles the exports
      // table admits, and the archived card is still the page.
      api.get('/api/v1/archives/retired').catch(() => []),
      api.get('/api/v1/archives/exports').catch(() => [])
    ]).then(([a, r, x]) => {
      setArchives(Array.isArray(a) ? a : [])
      setRetired((Array.isArray(r) ? r : []).filter(row => row && row.retired_at))
      setExports((Array.isArray(x) ? x : []).filter(row => row && row.object_key))
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  const restore = async (item) => {
    try {
      await api.post(`/api/v1/${item.entity_type}s/${item.entity_id}/restore`, {})
      setConfirmRestore(null)
      load(); showToast(`Entity '${item.name}' restored to active service`, 'success')
    } catch (e) { showToast(e.message, 'error') }
  }

  /**
   * The manual half of the retention policy: the same destruction the auto-purge timer does, on
   * demand. A real DELETE: the row leaves the table, the audit trail keeps its history, and the
   * database writes the tombstone the second card lists.
   */
  const purge = async (item) => {
    try {
      await api.delete(`/api/v1/${item.entity_type}s/${item.entity_id}`)
      // Dismissed after the delete, so the action runs while the confirmation is on screen.
      setConfirmPurge(null)
      load(); showToast(`Entity '${item.name}' permanently deleted`, 'success')
    } catch (e) { showToast(e.message, 'error') }
  }

  /**
   * Take the device away: the AASX with its trail, its live telemetry and the manifest, downloaded
   * now and stored beside the cold tier so the tombstone can offer it after the row is gone.
   */
  const exportBundle = async (item) => {
    setExporting(item.entity_id)
    try {
      const result = await api.post('/api/v1/devices/asset-export', { device_id: item.entity_id })
      downloadBlob(result.blob, result.filename || `${item.name}-bundle.aasx`)
      const b = result.stats?.bundle || {}
      const summary = `${b.raw_rows ?? 0} raw and ${b.hourly_rows ?? 0} hourly readings, ${b.trail_rows ?? 0} audit trail rows, ${b.cold_objects ?? 0} cold object${b.cold_objects === 1 ? '' : 's'} named`
      if (b.stored === false) {
        showToast(`Bundle downloaded for '${item.name}' (${summary}) — it was NOT stored on the platform: ${b.reason || 'unknown reason'}. Keep the file.`, 'warning')
      } else if (b.truncated) {
        showToast(`Bundle exported for '${item.name}' (${summary}) — a cap was reached; the manifest says what is not included`, 'warning')
      } else {
        showToast(`Bundle exported for '${item.name}' (${summary})`, 'success')
      }
      load()
    } catch (e) {
      showToast(e.message, 'error')
    } finally {
      setExporting(null)
    }
  }

  const downloadExport = async (row) => {
    try {
      const url = await api.assetExportDownloadUrl(row)
      window.open(url, '_blank', 'noopener')
    } catch (e) { showToast(e.message, 'error') }
  }

  const canArchive = hasPermission(PERMISSION_UUIDS.ARCHIVE_MANAGE)
  const deniedTitle = requiresRolesTitle(PERMISSION_UUIDS.ARCHIVE_MANAGE)
  const latestExportOf = (entityId) => exports.find(x => x.entity_id === entityId) || null

  /** What survives a retired entity, as links; derived from the tombstone's row and its exports. */
  const survivors = (r) => {
    const items = []
    if (onViewTrail) {
      items.push(
        <button
          key="trail"
          className="btn btn-sm btn-ghost"
          onClick={() => onViewTrail({ id: r.entity_id, type: TRAIL_TYPE[r.entity_type], purged: true })}
          title="Open this entity's audit trace on the Audit Trail page, deleted entities shown"
        >
          <IconHistory size={12} /> Audit Trail
        </button>
      )
    }
    if (r.entity_type === 'gateway' && r.old_data?.forge_repository_at && r.sparkplug_id) {
      // Derived from the id as it is everywhere else.
      items.push(
        <a
          key="forge"
          className="btn btn-sm btn-ghost"
          href={gatewayRepositoryUrl({ sparkplug_id: r.sparkplug_id })}
          target="_blank"
          rel="noopener noreferrer"
          title="Its repository in the forge: archived, read-only, every branch and wiki page kept"
        >
          <IconExternalLink size={12} /> Forge repository
        </a>
      )
    }
    for (const x of r.exports || []) {
      items.push(
        <button
          key={x.id}
          className="btn btn-sm btn-ghost"
          onClick={() => downloadExport(x)}
          title={`The bundle taken ${formatDateTime(x.taken_at)}${x.taken_by_email ? ` by ${x.taken_by_email}` : ''}: shell, audit trail, live telemetry and the cold-object manifest`}
        >
          <IconDownload size={12} /> Bundle {formatDate(x.taken_at)}
        </button>
      )
    }
    return items
  }

  return (
    <div className="page-layout page-fill">
      <div className="page-main">
      <PageHeading icon={<IconArchive size={15} />} title="Archived Entities">
        Areas, cells, gateways and devices taken out of commission without being deleted; Restore
        returns one to service intact.
      </PageHeading>

      <div className="card card-fill">
        <div className="card-header">
          <h3 className="section-title">
            Archived Entities
            <HelpTip
              label="About archived entities"
              text="Out of commission but not gone: identity and history kept, hidden from the asset pages, a timer running to auto-purge. Restore returns it intact. Export a device as a bundle before it is purged."
            />
            <SectionCount total={archives.length} />
          </h3>
        </div>
        {loading ? <LoadingState label="archived entities" /> :
         archives.length === 0 ? (
           <EmptyState icon={<IconArchive size={36} />} message="Nothing is archived." />
         ) : (
           <div className="table-wrap">
             <table>
               <thead><tr><th title="Entity Name">Name</th><th title="Entity ID">Entity ID</th><th title="Entity classification">Type</th><th title="When it was archived">Archived At</th><th title="When the auto-purge timer deletes the archived record for good">Auto-Purge</th><th className="row-actions">Actions</th></tr></thead>
               <tbody>
                 {archives.map(a => {
                   const latestExport = a.entity_type === 'device' ? latestExportOf(a.entity_id) : null
                   return (
                   <tr key={`${a.entity_type}-${a.entity_id}`}>
                     <td>
                       <strong>{a.name}</strong>
                       {latestExport && (
                         <div className="cell-meta" title={`A bundle of this device was taken ${formatDateTime(latestExport.taken_at)} and is kept beside the cold tier`}>
                           Exported {formatDate(latestExport.taken_at)}
                         </div>
                       )}
                     </td>
                     <td><CopyableId value={a.entity_id} label="entity id" onNotify={showToast} /></td>
                     <td><Badge tone="warning" size="sm">{a.entity_type.toUpperCase()}</Badge></td>
                     <td className="cell-meta">{formatDateTime(a.archived_at)}</td>
                     <td>
                       {a.auto_delete_at ? (
                         <span className="mono cell-purge-date">Purges: {formatDate(a.auto_delete_at)}</span>
                       ) : (
                         <Badge size="sm" title="No auto-purge timer is running; it stays archived until someone deletes it">Never auto-purged</Badge>
                       )}
                     </td>
                     {/* Restore is the ordinary move and Permanent Delete the irreversible one, so
                         they are not peers: delete only takes its danger colour when pointed at.
                         Export Bundle, for a device, is what to do before the delete. */}
                     <td className="row-actions">
                       <button
                         className={`btn btn-sm btn-ghost ${!canArchive ? 'btn-disabled' : ''}`}
                         disabled={!canArchive}
                         onClick={() => canArchive && setConfirmRestore(a)}
                         title={!canArchive ? deniedTitle : 'Restore entity back to active service'}
                       >
                         <IconRefreshCw size={12} /> Restore
                       </button>
                       {a.entity_type === 'device' && (
                         <button
                           className={`btn btn-sm btn-ghost ${!canArchive ? 'btn-disabled' : ''}`}
                           disabled={!canArchive || exporting === a.entity_id}
                           onClick={() => canArchive && exportBundle(a)}
                           title={!canArchive ? deniedTitle : 'Download an AASX bundle of this device — its shell, audit trail, live telemetry and a manifest naming the cold objects — and keep a copy beside the cold tier'}
                         >
                           <IconDownload size={12} /> {exporting === a.entity_id ? 'Exporting…' : 'Export Bundle'}
                         </button>
                       )}
                       <button
                         className={`btn btn-sm btn-danger btn-danger-reveal ${!canArchive ? 'btn-disabled' : ''}`}
                         disabled={!canArchive}
                         onClick={() => canArchive && setConfirmPurge(a)}
                         title={!canArchive ? deniedTitle : 'Delete this entity permanently — it cannot be restored'}
                       >
                         <IconTrash size={12} /> Permanent Delete
                       </button>
                     </td>
                   </tr>
                   )
                 })}
               </tbody>
             </table>
           </div>
         )}
      </div>

      {/* The second stage: the row is gone and this is what is left of it. It keeps its natural
          height while the card above gives way. */}
      <div className="card">
        <div className="card-header">
          <h3 className="section-title">
            Retired Entities
            <HelpTip
              label="About retired entities"
              text="Archived and then deleted, by timer or by hand. Only this tombstone remains, linking to what survives: the audit trail, a forge repository, any exported bundle. Readings stay in the historian under its id."
            />
            <SectionCount total={retired.length} />
          </h3>
        </div>
        {loading ? <LoadingState label="retired entities" /> :
         retired.length === 0 ? (
           <EmptyState icon={<IconTrash size={36} />} message="Nothing has been retired: no archived entity has been deleted yet." />
         ) : (
           <div className="table-wrap">
             <table>
               <thead><tr><th title="The name the entity had">Name</th><th title="Entity classification">Type</th><th title="Entity ID, as it was">Entity ID</th><th title="When the row was deleted">Retired At</th><th title="Who deleted it, or the retention job">By</th><th title="The historian keys this entity's readings by this id">Historian ID</th><th className="row-actions" title="What survives the row">What Survives</th></tr></thead>
               <tbody>
                 {retired.map(r => (
                   <tr key={`${r.entity_type}-${r.entity_id}`}>
                     <td><strong>{r.name || '—'}</strong></td>
                     <td><Badge size="sm">{String(r.entity_type).toUpperCase()}</Badge></td>
                     <td><CopyableId value={r.entity_id} label="entity id" onNotify={showToast} /></td>
                     <td className="cell-meta" title={r.archived_at ? `Archived ${formatDateTime(r.archived_at)}` : undefined}>
                       {formatDateTime(r.retired_at)}
                     </td>
                     <td className="cell-meta">{r.retired_by_email || (r.retired_by ? <span className="mono">{String(r.retired_by).slice(0, 8)}…</span> : 'retention timer')}</td>
                     <td>{r.sparkplug_id ? <CopyableId value={r.sparkplug_id} label="historian id" onNotify={showToast} /> : <span className="cell-meta">—</span>}</td>
                     <td className="row-actions">{survivors(r)}</td>
                   </tr>
                 ))}
               </tbody>
             </table>
           </div>
         )}
      </div>
      </div>

      {/* Restore is not gated on typing the name, since it is recoverable. It names what does not
          come back: the timer is cleared, not paused, and a gateway's broker credential and deploy
          key stay withdrawn. Restore returns the row, not the credentials archiving withdrew. */}
      {confirmRestore && (
        <ConfirmModal
          title={`Restore ${confirmRestore.entity_type}`}
          icon={<IconRefreshCw size={18} />}
          message={
            `Restore the ${confirmRestore.entity_type} '${confirmRestore.name}' to active service? ` +
            'It reappears on the asset pages with its history intact, and its auto-purge timer is ' +
            'cleared — archiving it again starts a fresh retention window rather than resuming the ' +
            'one it had.' +
            (confirmRestore.entity_type === 'gateway' && confirmRestore.credential_revoked_at
              ? ' Its broker credential was revoked when it was archived and is not restored with it:' +
                ' issue it again from its drawer on the Gateways page (Generate Broker Credential) for a Host or' +
                ' Simulated gateway, or set a Remote gateway up again from its drawer (Set Up Gateway)' +
                ' with a fresh command or bundle, before it can publish again.'
              : '') +
            (confirmRestore.entity_type === 'gateway' && confirmRestore.forge_archived_at
              ? ' Its repository comes back out of the forge’s archive within a few seconds. The' +
                ' appliance’s deploy key does not come back with it — re-enrol the appliance before' +
                ' it can pull its flow again.'
              : '') +
            (confirmRestore.entity_type === 'device'
              ? ' Any replay lane recorded from it comes back with it.'
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
          title={`Permanently delete ${confirmPurge.entity_type}`}
          icon={<IconTrash size={18} />}
          message={
            `Permanently delete the ${confirmPurge.entity_type} '${confirmPurge.name}'? ` +
            'This removes the record from the database immediately. It cannot be restored, and ' +
            'it does not wait for the retention timer. Its audit trail history is kept, and a ' +
            'tombstone is left on this page.' +
            // What happens to what was inside it, for the two types that hold other assets.
            (confirmPurge.entity_type === 'cell'
              ? ' Anything still filed into it — gateways and devices alike — is un-filed rather' +
                ' than deleted, and appears as Unassigned.'
              : '') +
            (confirmPurge.entity_type === 'area'
              ? ' Its cells are kept and become unfiled' +
                (confirmPurge.plan_path ? '; its area plan is deleted' : '') +
                '. It is refused while an Area-Wide asset still names it — move that asset first.'
              : '') +
            (confirmPurge.entity_type === 'device'
              ? ' Any replay lane recorded from it is deleted with it. Export a bundle first if' +
                ' its record and readings are to leave with it.'
              : '')
          }
          pendingLabel="Deleting…"
          requireTyped={confirmPurge.name}
          requireTypedLabel={`${confirmPurge.entity_type} name`}
          onConfirm={() => purge(confirmPurge)}
          onCancel={() => setConfirmPurge(null)}
        />
      )}
    </div>
  )
}
