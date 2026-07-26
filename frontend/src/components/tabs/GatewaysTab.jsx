import React, { useState, useEffect, useCallback } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS } from '../../constants'
import { usePolling } from '../../hooks/usePolling'
import { InlineDocumentAccordion } from '../common/InlineDocumentAccordion'
import { StatusBadge } from '../common/StatusBadge'
import { ArchiveModal } from '../modals/ArchiveModal'
import { DigitalThreadModal } from '../modals/DigitalThreadModal'
import { EntityDocumentsModal } from '../modals/EntityDocumentsModal'
import {
  IconRadio,
  IconPlus,
  IconPencil,
  IconArchive,
  IconRefreshCw,
  IconHistory,
  IconExternalLink,
  IconFileText,
  IconChevronDown,
  IconChevronUp,
  IconZap,
  IconX
} from '../common/Icons'

export function GatewaysTab({ showToast, hasPermission, initialSearchFilter, onClearFilter, onBugReport }) {
  const [gateways, setGateways] = useState([])
  const [assets, setAssets]     = useState([])
  const [loading, setLoading]   = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing]   = useState(null)
  const [archiveTarget, setArchiveTarget] = useState(null)
  const blank = { gateway_id: '', gateway_name: '', ip_address: '', status: 'OFFLINE', is_virtual: false, access_url: '' }
  const [form, setForm]         = useState(blank)
  const [threadFor, setThreadFor] = useState(null)
  const [docsForGw, setDocsForGw] = useState(null)
  const [expandedGwDocs, setExpandedGwDocs] = useState({})
  const [docRefreshKey, setDocRefreshKey] = useState(0)
  const [filterMode, setFilterMode] = useState('all')

  const toggleGwDocExpand = id => setExpandedGwDocs(prev => ({ ...prev, [id]: !prev[id] }))

  const getInitialSearch = () => {
    const params = new URLSearchParams(window.location.search)
    return params.get('search') || initialSearchFilter || ''
  }

  const [searchQuery, setSearchQuery] = useState(getInitialSearch)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const urlSearch = params.get('search')
    if (urlSearch) {
      setSearchQuery(urlSearch)
    } else if (initialSearchFilter) {
      setSearchQuery(initialSearchFilter)
    }
  }, [initialSearchFilter])

  const handleClearSearch = () => {
    setSearchQuery('')
    if (window.location.search) {
      window.history.replaceState({}, '', window.location.pathname)
    }
    if (onClearFilter) onClearFilter()
  }

  const load = useCallback(async (signal) => {
    try {
      const [g, a] = await Promise.all([
        api.get('/api/v1/gateways', { signal }),
        api.get('/api/v1/devices', { signal })
      ])
      setGateways(g); setAssets(a)
      setLoading(false)
    } catch (e) {
      if (e.name !== 'AbortError') {
        setLoading(false)
      }
      throw e
    }
  }, [])

  usePolling(load, 3000)

  const save = async () => {
    try {
      if (editing) await api.put(`/api/v1/gateways/${editing.gateway_id}`, form)
      else         await api.post('/api/v1/gateways', form)
      setShowForm(false); load(); showToast('Gateway saved', 'success')
    } catch (e) { showToast(e.message, 'error') }
  }

  const archiveGateway = async (days) => {
    try {
      await api.post(`/api/v1/gateways/${archiveTarget.gateway_id}/archive`, { auto_delete_days: days })
      setArchiveTarget(null); load(); showToast(`Gateway '${archiveTarget.gateway_name}' archived (Out of Commission)`, 'success')
    } catch (e) { showToast(e.message, 'error') }
  }

  const restoreGateway = async (gatewayId, name) => {
    try {
      await api.post(`/api/v1/gateways/${gatewayId}/restore`, {})
      load(); showToast(`Gateway '${name}' restored to active service`, 'success')
    } catch (e) { showToast(e.message, 'error') }
  }

  const canManage = hasPermission(PERMISSION_UUIDS.GATEWAY_MANAGE)
  const canArchive = hasPermission(PERMISSION_UUIDS.ARCHIVE_MANAGE)

  const filteredGateways = gateways.filter(g => {
    if (filterMode === 'active'   && g.is_archived) return false
    if (filterMode === 'archived' && !g.is_archived) return false
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      if (!g.gateway_id.toLowerCase().includes(q) && !g.gateway_name.toLowerCase().includes(q)) return false
    }
    return true
  })

  return (
    <>
      <div className="section-header" style={{ marginBottom: '8px' }}>
        <h2 className="section-title">Edge Gateways <span className="section-count">{gateways.length}</span></h2>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: '4px', background: 'var(--bg-glass)', padding: '3px', borderRadius: '8px', border: '1px solid var(--border)' }}>
            <button className={`btn btn-sm ${filterMode === 'all' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setFilterMode('all')} title="Show all edge gateways">
              All ({gateways.length})
            </button>
            <button className={`btn btn-sm ${filterMode === 'active' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setFilterMode('active')} title="Show active edge gateways only">
              Active ({gateways.filter(g => !g.is_archived).length})
            </button>
            <button className={`btn btn-sm ${filterMode === 'archived' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setFilterMode('archived')} title="Show decommissioned archived gateways">
              Archived ({gateways.filter(g => g.is_archived).length})
            </button>
          </div>

          <input
            className="form-control"
            style={{ width: '200px' }}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search by Gateway ID or name…"
            title="Filter gateways by ID or name"
          />
          {searchQuery && (
            <button className="btn btn-ghost btn-sm" onClick={handleClearSearch} title="Clear search"><IconX size={13} /> Clear</button>
          )}

          <button
            className={`btn btn-primary ${!canManage ? 'btn-disabled' : ''}`}
            disabled={!canManage}
            onClick={() => canManage && (setEditing(null), setForm(blank), setShowForm(true))}
            title={!canManage ? 'Requires Admin permissions' : 'Register new edge gateway'}
          >
            <IconPlus size={14} /> New Gateway
          </button>
        </div>
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '20px' }}>
        Register and configure edge gateways, inspect network status, and manage edge node connections across the factory network.
      </p>

      <div className="card">
        {loading ? <div className="loading-wrap"><div className="spinner" /> Loading gateways…</div> :
         filteredGateways.length === 0 ? (
           <div className="empty-state">
             <div className="empty-icon"><IconRadio size={36} /></div>
             <div className="empty-text">No edge gateways match the selected filter.</div>
           </div>
         ) : (
           <div className="table-wrap">
             <table>
               <thead>
                 <tr>
                   <th title="Unique gateway ID string">Gateway ID</th>
                   <th title="Human-readable gateway name">Gateway Name</th>
                   <th title="Network IP address">IP Address</th>
                   <th title="Network connectivity status">Gateway Status</th>
                   <th title="Connected devices online/offline state">Connected Devices</th>
                   <th style={{ textAlign: 'right' }}>Actions</th>
                 </tr>
               </thead>
               <tbody>
                 {filteredGateways.map(g => {
                   const gwAssets = assets.filter(a => a.active_gateway_id === g.gateway_id)
                   const onlineCount = gwAssets.filter(a => a.status === 'ONLINE' || !a.status).length
                   const offlineCount = gwAssets.filter(a => a.status === 'OFFLINE').length

                   return (
                     <React.Fragment key={g.gateway_id}>
                       <tr style={{ background: g.is_archived ? 'rgba(255,179,0,0.06)' : undefined }}>
                         <td><span className="mono">{g.gateway_id}</span></td>
                         <td>
                           <strong>{g.gateway_name}</strong>
                           {g.is_virtual && (
                             <span className="badge badge-warning" style={{ background: 'rgba(0,212,255,0.15)', color: 'var(--accent)', border: '1px solid var(--accent)', marginLeft: '8px', display: 'inline-flex', alignItems: 'center', gap: '4px' }} title="Factory+ Cloud Virtual Gateway">
                               <IconZap size={11} /> VIRTUAL
                             </span>
                           )}
                           {g.is_archived && (
                             <span className="badge badge-warning" style={{ background: 'rgba(255,179,0,0.15)', color: 'var(--warning)', border: '1px solid var(--warning)', marginLeft: '8px' }} title="Decommissioned gateway">
                               <IconArchive size={11} /> ARCHIVED
                             </span>
                           )}
                         </td>
                         <td><span className="mono" style={{ color: 'var(--text-muted)' }}>{g.ip_address || '—'}</span></td>
                         <td>
                           {g.is_archived ? (
                             <span className="badge badge-warning" style={{ background: 'rgba(255,179,0,0.15)', color: 'var(--warning)' }}>DECOMMISSIONED</span>
                           ) : (
                             <StatusBadge status={g.status} />
                           )}
                         </td>
                         <td>
                           <span className="badge badge-neutral" title="Connected devices breakdown">
                             {g.is_archived ? 'Archived (Inaccessible)' : `${onlineCount} Online / ${offlineCount} Offline`}
                           </span>
                         </td>
                         <td>
                           <div className="btn-group" style={{ justifyContent: 'flex-end' }}>
                             {g.access_url && (
                               <a href={g.access_url} target="_blank" rel="noopener noreferrer" className="btn btn-primary btn-sm" style={{ textDecoration: 'none', gap: '4px', background: 'var(--accent)', color: '#000', padding: '4px 10px' }} title="Open Node-RED / Virtual Gateway Editor">
                                 <IconExternalLink size={12} /> Launch UI
                               </a>
                             )}
                             <button className="btn btn-ghost btn-sm" onClick={() => toggleGwDocExpand(g.gateway_id)} title="Toggle attached document links accordion">
                               <IconFileText size={13} /> Docs {expandedGwDocs[g.gateway_id] ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
                             </button>
                             <button className="btn btn-ghost btn-sm" onClick={() => setThreadFor(g)} title="View gateway Digital Thread audit trace">
                               <IconHistory size={13} /> Thread
                             </button>
                             {g.is_archived ? (
                               <button
                                 className={`btn btn-primary btn-sm ${!canArchive ? 'btn-disabled' : ''}`}
                                 disabled={!canArchive}
                                 onClick={() => canArchive && restoreGateway(g.gateway_id, g.gateway_name)}
                                 title={!canArchive ? 'Requires Admin permissions' : 'Restore gateway back to active service'}
                               >
                                 <IconRefreshCw size={12} /> Restore
                               </button>
                             ) : (
                               <button
                                 className={`btn btn-ghost btn-sm ${!canArchive ? 'btn-disabled' : ''}`}
                                 disabled={!canArchive}
                                 onClick={() => canArchive && setArchiveTarget(g)}
                                 title={!canArchive ? 'Requires Admin permissions' : 'Decommission & Archive Gateway'}
                               >
                                 <IconArchive size={13} /> Archive
                               </button>
                             )}
                             <button
                               className={`btn btn-ghost btn-sm ${!canManage || g.is_archived ? 'btn-disabled' : ''}`}
                               disabled={!canManage || g.is_archived}
                               onClick={() => canManage && !g.is_archived && (setEditing(g), setForm(g), setShowForm(true))}
                               title={!canManage ? 'Requires Admin permissions' : g.is_archived ? 'Gateway is archived' : 'Edit gateway properties'}
                             >
                               <IconPencil size={13} /> Edit
                             </button>
                           </div>
                         </td>
                       </tr>
                       {expandedGwDocs[g.gateway_id] && (
                         <tr key={`docs-${g.gateway_id}`} style={{ background: 'rgba(0,0,0,0.2)' }}>
                           <td colSpan={6} style={{ padding: '8px 16px' }}>
                             <InlineDocumentAccordion
                               entityType="gateway"
                               entityId={g.gateway_id}
                               entityName={g.gateway_name}
                               onOpenModal={() => setDocsForGw(g)}
                               hasPermission={hasPermission}
                               refreshKey={docRefreshKey}
                             />
                           </td>
                         </tr>
                       )}
                     </React.Fragment>
                   )
                 })}
               </tbody>
             </table>
           </div>
         )}
      </div>

      {showForm && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-title">{editing ? 'Edit Gateway' : 'Register Gateway'}</div>
            <div className="form-group">
              <label className="form-label">Gateway ID</label>
              <input className="form-control" value={form.gateway_id} disabled={!!editing} onChange={e => setForm(f => ({ ...f, gateway_id: e.target.value }))} title="Unique gateway ID" />
            </div>
            <div className="form-group">
              <label className="form-label">Gateway Name</label>
              <input className="form-control" value={form.gateway_name} onChange={e => setForm(f => ({ ...f, gateway_name: e.target.value }))} title="Descriptive gateway name" />
            </div>
            <div className="form-group">
              <label className="form-label">IP Address</label>
              <input className="form-control" value={form.ip_address || ''} onChange={e => setForm(f => ({ ...f, ip_address: e.target.value }))} title="Network IP address" />
            </div>
            <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px', marginBottom: '12px' }}>
              <input type="checkbox" id="is_virtual" checked={form.is_virtual || false} onChange={e => setForm(f => ({ ...f, is_virtual: e.target.checked }))} style={{ cursor: 'pointer' }} />
              <label htmlFor="is_virtual" className="form-label" style={{ marginBottom: 0, cursor: 'pointer' }}>⚡ Mark as Virtual Gateway (Cloud / Server-Simulated)</label>
            </div>
            <div className="form-group">
              <label className="form-label">Gateway Access URL (Optional UI Console)</label>
              <input className="form-control" value={form.access_url || ''} onChange={e => setForm(f => ({ ...f, access_url: e.target.value }))} placeholder="e.g. http://localhost:1880" title="Web Console / Management URL for this gateway" />
            </div>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setShowForm(false)} title="Cancel">Cancel</button>
              <button className="btn btn-primary" onClick={save} title="Save gateway configuration">Save</button>
            </div>
          </div>
        </div>
      )}

      {archiveTarget && (
        <ArchiveModal
          entityType="gateways" entityId={archiveTarget.gateway_id} displayName={archiveTarget.gateway_name}
          onArchive={archiveGateway} onCancel={() => setArchiveTarget(null)}
        />
      )}

      {threadFor && (
        <DigitalThreadModal entityType="gateways" entityId={threadFor.gateway_id} displayName={threadFor.gateway_name} onClose={() => setThreadFor(null)} />
      )}

      {docsForGw && (
        <EntityDocumentsModal entityType="gateway" entityId={docsForGw.gateway_id} entityName={docsForGw.gateway_name} onClose={() => { setDocsForGw(null); setDocRefreshKey(k => k + 1) }} showToast={showToast} hasPermission={hasPermission} />
      )}
    </>
  )
}
