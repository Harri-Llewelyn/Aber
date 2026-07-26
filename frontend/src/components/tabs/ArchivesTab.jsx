import React, { useState, useEffect, useCallback } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS } from '../../constants'
import { IconArchive, IconRefreshCw } from '../common/Icons'

export function ArchivesTab({ showToast, hasPermission }) {
  const [archives, setArchives] = useState([])
  const [loading, setLoading]   = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    api.get('/api/v1/archives').then(d => { setArchives(d); setLoading(false) }).catch(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  const restore = async (item) => {
    try {
      await api.post(`/api/v1/${item.entity_type}s/${item.entity_id}/restore`, {})
      load(); showToast(`Entity '${item.name}' restored to active service`, 'success')
    } catch (e) { showToast(e.message, 'error') }
  }

  const canArchive = hasPermission(PERMISSION_UUIDS.ARCHIVE_MANAGE)

  return (
    <>
      <div className="section-header" style={{ marginBottom: '8px' }}>
        <h2 className="section-title">Archived Entities (Out of Commission) <span className="section-count">{archives.length}</span></h2>
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '20px' }}>
        Decommissioned entities (Out of Commission) with active retention timers, auto-purge expiration dates, and 1-click restoration to service.
      </p>

      <div className="card">
        {loading ? <div className="loading-wrap"><div className="spinner" /> Loading archives…</div> :
         archives.length === 0 ? (
           <div className="empty-state">
             <div className="empty-icon"><IconArchive size={36} /></div>
             <div className="empty-text">No decommissioned entities currently in archives.</div>
           </div>
         ) : (
           <div className="table-wrap">
             <table>
               <thead><tr><th title="Entity ID">Entity ID</th><th title="Entity Name">Name</th><th title="Entity classification">Type</th><th title="Decommissioned timestamp">Archived At</th><th title="Retention compliance auto-purge timer">Auto-Purge Expiration</th><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
               <tbody>
                 {archives.map((a, i) => (
                   <tr key={i}>
                     <td><span className="mono">{a.entity_id}</span></td>
                     <td><strong>{a.name}</strong></td>
                     <td><span className="badge badge-warning">{a.entity_type.toUpperCase()}</span></td>
                     <td style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{a.archived_at ? new Date(a.archived_at).toLocaleString() : '—'}</td>
                     <td>
                       {a.auto_delete_at ? (
                         <span className="mono" style={{ color: 'var(--danger)', fontSize: '11px' }}>Purges: {new Date(a.auto_delete_at).toLocaleDateString()}</span>
                       ) : (
                         <span className="badge badge-neutral">Permanent (No Auto-Purge)</span>
                       )}
                     </td>
                     <td style={{ textAlign: 'right' }}>
                       <button
                         className={`btn btn-primary btn-sm ${!canArchive ? 'btn-disabled' : ''}`}
                         disabled={!canArchive}
                         onClick={() => restore(a)}
                         title={!canArchive ? 'Requires Admin permissions' : 'Restore entity back to active service'}
                       >
                         <IconRefreshCw size={12} /> Restore to Service
                       </button>
                     </td>
                   </tr>
                 ))}
               </tbody>
             </table>
           </div>
         )}
      </div>
    </>
  )
}
