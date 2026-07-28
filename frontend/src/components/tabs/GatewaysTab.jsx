import React, { useState, useEffect, useCallback } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS } from '../../constants'
import { usePolling } from '../../hooks/usePolling'
import { gatewayLiveStatus, formatHeartbeat } from '../../utils/gatewayStatus'
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
  const [cells, setCells]       = useState([])
  const [loading, setLoading]   = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing]   = useState(null)
  const [archiveTarget, setArchiveTarget] = useState(null)
  const blank = { gateway_id: '', gateway_name: '', ip_address: '', status: 'OFFLINE', is_virtual: false, access_url: '', cell_id: '' }
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
      // Each gateway arrives with its devices embedded (gateways?select=*,devices(...)),
      // so an assignment made anywhere shows up on the next poll. The flat device list
      // is still needed to surface devices that belong to no gateway at all.
      const [g, a, c] = await Promise.all([
        api.get('/api/v1/gateways', { signal }),
        api.get('/api/v1/devices', { signal }),
        api.get('/api/v1/cells', { signal })
      ])
      setGateways(g); setAssets(a); setCells(c)
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

  const unassignedDevices = assets.filter(a => !a.is_archived && !a.active_gateway_id)

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
        Register and configure edge gateways, inspect heartbeat status, and manage edge node connections across the factory network.
        A gateway's status follows the Sparkplug B node heartbeat: it is shown as <strong>STALE</strong> once no NBIRTH/NDATA has arrived for 90 seconds.
      </p>

      {unassignedDevices.length > 0 && (
        <div style={{ marginBottom: '20px', background: 'rgba(255,179,0,0.08)', border: '1px solid var(--warning)', borderRadius: 'var(--radius)', padding: '12px 16px', fontSize: '13px', color: 'var(--warning)' }}>
          <strong>{unassignedDevices.length} device{unassignedDevices.length === 1 ? '' : 's'} not assigned to any gateway:</strong>{' '}
          {unassignedDevices.slice(0, 5).map(a => a.asset_name).join(', ')}{unassignedDevices.length > 5 ? ', …' : ''}.
          Assign them from the Devices page.
        </div>
      )}

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
                   <th title="Shopfloor cell zone this gateway serves">Cell Zone</th>
                   <th title="Network connectivity status">Gateway Status</th>
                   <th title="Age of the last Sparkplug B node heartbeat (NBIRTH/NDATA/NDEATH)">Last Heartbeat</th>
                   <th title="Devices assigned to this gateway">Connected Devices</th>
                   <th style={{ textAlign: 'right' }}>Actions</th>
                 </tr>
               </thead>
               <tbody>
                 {filteredGateways.map(g => {
                   const gwAssets = g.devices || []
                   const onlineCount = gwAssets.filter(a => a.status === 'ONLINE' || !a.status).length
                   const offlineCount = gwAssets.filter(a => a.status === 'OFFLINE').length
                   const liveStatus = gatewayLiveStatus(g)

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
                           {g.cell_id
                             ? (cells.find(c => c.cell_id === g.cell_id)?.cell_name || <span className="mono">{g.cell_id}</span>)
                             : <span style={{ fontSize: '11px', color: 'var(--warning)', fontStyle: 'italic' }} title="Devices on this gateway will not appear under any cell">Unassigned</span>}
                         </td>
                         <td>
                           {g.is_archived ? (
                             <span className="badge badge-warning" style={{ background: 'rgba(255,179,0,0.15)', color: 'var(--warning)' }}>DECOMMISSIONED</span>
                           ) : (
                             <StatusBadge status={liveStatus} />
                           )}
                         </td>
                         <td
                           style={{ fontSize: '11px', color: liveStatus === 'STALE' ? 'var(--warning)' : 'var(--text-muted)' }}
                           title={g.last_heartbeat ? new Date(g.last_heartbeat).toLocaleString() : 'No Sparkplug B node message has ever been received from this edge node'}
                         >
                           {formatHeartbeat(g.last_heartbeat)}
                         </td>
                         <td>
                           {g.is_archived ? (
                             <span className="badge badge-neutral">Archived (Inaccessible)</span>
                           ) : gwAssets.length === 0 ? (
                             <span style={{ fontSize: '11px', color: 'var(--text-dim)', fontStyle: 'italic' }}>No devices assigned</span>
                           ) : (
                             <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center' }}>
                               <span className="badge badge-neutral" title="Connected devices breakdown">
                                 {onlineCount} Online / {offlineCount} Offline
                               </span>
                               {gwAssets.map(a => (
                                 <span
                                   key={a.asset_id}
                                   className={`badge ${a.status === 'OFFLINE' ? 'badge-neutral' : 'badge-online'}`}
                                   style={{ fontSize: '10px' }}
                                   title={`${a.asset_name} — ${a.is_quarantined ? 'QUARANTINED' : a.status || 'ONLINE'}`}
                                 >
                                   {a.asset_name}{a.is_quarantined ? ' (quarantined)' : ''}
                                 </span>
                               ))}
                             </div>
                           )}
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
                           <td colSpan={8} style={{ padding: '8px 16px' }}>
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
              <input className="form-control" value={form.gateway_id || '— assigned on save —'} disabled readOnly title="Database-generated UUID; not editable" />
            </div>
            <div className="form-group">
              <label className="form-label">Gateway Name</label>
              <input className="form-control" value={form.gateway_name} onChange={e => setForm(f => ({ ...f, gateway_name: e.target.value }))} title="Must match the Sparkplug B edge node id in the MQTT topic for heartbeats to be matched" placeholder="e.g. Virtual_Gateway_NodeRED" />
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                Must match the Sparkplug B edge node id (<span className="mono">spBv1.0/&lt;group&gt;/NDATA/&lt;edge node&gt;</span>) for heartbeats to update this gateway.
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Shopfloor Cell Zone</label>
              <select className="form-control" value={form.cell_id || ''} onChange={e => setForm(f => ({ ...f, cell_id: e.target.value }))} title="Cell this gateway serves — devices inherit their cell from their gateway">
                <option value="">— Unassigned Zone —</option>
                {cells.filter(c => !c.is_archived).map(c => (
                  <option key={c.cell_id} value={c.cell_id}>{c.cell_name}</option>
                ))}
              </select>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                Devices served by this gateway appear under this cell on the Cells and Overview pages.
              </div>
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
