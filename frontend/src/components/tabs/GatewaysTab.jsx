import React, { useState, useEffect, useCallback } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS, REALTIME_ENABLED, STALENESS_TICK_MS, refreshInterval } from '../../constants'
import { usePolling } from '../../hooks/usePolling'
import { useRealtimeTable } from '../../hooks/useRealtimeTable'
import { useClockTick } from '../../hooks/useClockTick'
import { gatewayLiveStatus, formatHeartbeat } from '../../utils/gatewayStatus'
import { gatewaySparkplugId } from '../../utils/sparkplugId'
import CopyableId from '../common/CopyableId'
import { ActionMenu } from '../common/ActionMenu'
import { TagList } from '../common/TagList'
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
  IconZap,
  IconShieldAlert,
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
  const [liveStatusFilter, setLiveStatusFilter] = useState('')
  const [kindFilter, setKindFilter] = useState('')
  const [quarantineOnly, setQuarantineOnly] = useState(false)

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

  const resetFilters = () => {
    setSearchQuery('')
    setLiveStatusFilter('')
    setKindFilter('')
    setQuarantineOnly(false)
    setFilterMode('all')
    handleClearSearch()
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

  // Reconciliation loop, not the primary refresh -- see useRealtimeTable for why polling stays.
  //
  // Worth knowing: ingestion stamps gateways.last_heartbeat on every NBIRTH/NDATA/NDEATH, so
  // this page receives a change event roughly every 30s per gateway from the simulator alone.
  // That is the highest-traffic subscription in the app and the reason the hook debounces.
  //
  usePolling(load, refreshInterval())
  useRealtimeTable(['gateways', 'devices', 'cells'], load, { enabled: REALTIME_ENABLED })
  // Heartbeat staleness is derived from the wall clock by gatewayLiveStatus(), and a gateway
  // going quiet produces no database change and therefore no Realtime event. Without this
  // tick, a silent gateway would keep its last-rendered status until the 60s reconciliation
  // poll. Re-renders only; issues no requests.
  useClockTick(STALENESS_TICK_MS)

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

  // Built from the flat device list rather than the embedded one: ingestion records the arriving
  // edge node on a quarantined device, so a device held on a gateway is attributable even though
  // it has not been approved onto it yet.
  const gatewaysWithQuarantine = new Set(
    assets.filter(a => a.is_quarantined && a.active_gateway_id).map(a => a.active_gateway_id)
  )

  const filteredGateways = gateways.filter(g => {
    if (filterMode === 'active'   && g.is_archived) return false
    if (filterMode === 'archived' && !g.is_archived) return false
    if (searchQuery) {
      // Matches the friendly name, the internal UUID and the Sparkplug edge node id.
      const q = searchQuery.toLowerCase()
      const haystack = [g.gateway_name, g.gateway_id, g.sparkplug_id || gatewaySparkplugId(g.gateway_id)]
        .filter(Boolean).join(' ').toLowerCase()
      if (!haystack.includes(q)) return false
    }
    if (liveStatusFilter && gatewayLiveStatus(g) !== liveStatusFilter) return false
    if (kindFilter === 'virtual'  && !g.is_virtual) return false
    if (kindFilter === 'physical' && g.is_virtual) return false
    if (quarantineOnly && !gatewaysWithQuarantine.has(g.gateway_id)) return false
    return true
  })

  const activeFilterCount =
    [searchQuery, liveStatusFilter, kindFilter].filter(Boolean).length +
    (quarantineOnly ? 1 : 0) + (filterMode !== 'all' ? 1 : 0)

  return (
    <>
      <div className="section-header" style={{ marginBottom: '8px' }}>
        <h2 className="section-title">Edge Gateways <span className="section-count">{gateways.length}</span></h2>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
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
      <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '16px' }}>
        Register and configure edge gateways, inspect heartbeat status, and manage edge node connections across the factory network.
        A gateway's status follows the Sparkplug B node heartbeat: it is shown as <strong>STALE</strong> once no NBIRTH/NDATA has arrived for 90 seconds.
      </p>

      <div className="filter-bar">
        {/* Lifecycle lives here rather than as a separate segmented control in the header: it is
            a filter like the rest, and having two filter surfaces on one page meant the header
            row also crowded out the primary action. Counts are kept in the option labels. */}
        <select
          className="form-control"
          style={{ width: '150px' }}
          value={filterMode}
          onChange={e => setFilterMode(e.target.value)}
          title="Filter by lifecycle state"
        >
          <option value="all">All ({gateways.length})</option>
          <option value="active">Active ({gateways.filter(g => !g.is_archived).length})</option>
          <option value="archived">Archived ({gateways.filter(g => g.is_archived).length})</option>
        </select>

        <input
          className="form-control"
          style={{ width: '220px' }}
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Search name, UUID or Sparkplug ID…"
          title="Filter gateways by friendly name, internal UUID, or Sparkplug ID"
        />

        {/* Live status is derived from heartbeat age, not the stored `status` column -- a gateway
            that died without sending NDEATH still reads ONLINE in the database. */}
        <select className="form-control" style={{ width: '160px' }} value={liveStatusFilter} onChange={e => setLiveStatusFilter(e.target.value)} title="Filter by live heartbeat status (90s staleness threshold)">
          <option value="">Any status</option>
          <option value="ONLINE">Online</option>
          <option value="STALE">Stale</option>
          <option value="OFFLINE">Offline</option>
        </select>

        <select className="form-control" style={{ width: '160px' }} value={kindFilter} onChange={e => setKindFilter(e.target.value)} title="Separate simulated/virtual edge nodes from physical hardware">
          <option value="">Any kind</option>
          <option value="physical">Physical</option>
          <option value="virtual">Virtual</option>
        </select>

        <button
          className={`btn btn-sm ${quarantineOnly ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setQuarantineOnly(v => !v)}
          title="Show only gateways currently reporting devices held in quarantine — points at the misconfigured edge node when several devices fail at once"
        >
          <IconShieldAlert size={13} /> Has quarantined devices ({gatewaysWithQuarantine.size})
        </button>

        {activeFilterCount > 0 && (
          <button className="btn btn-ghost btn-sm filter-bar-spacer" onClick={resetFilters} title="Clear every filter">
            <IconX size={13} /> Clear filters ({activeFilterCount})
          </button>
        )}
      </div>

      {unassignedDevices.length > 0 && (
        <div style={{ marginBottom: '20px', background: 'rgba(255,179,0,0.08)', border: '1px solid var(--warning)', borderRadius: 'var(--radius)', padding: '12px 16px', fontSize: '13px', color: 'var(--warning-text)' }}>
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
                   <th title="Human-readable gateway name">Gateway Name</th>
                   <th title="Sparkplug B edge node id this gateway publishes under">Sparkplug ID</th>
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
                         <td>
                           <strong>{g.gateway_name}</strong>
                           {g.is_virtual && (
                             <span className="badge badge-warning" style={{ background: 'rgba(0,212,255,0.15)', color: 'var(--accent)', border: '1px solid var(--accent)', marginLeft: '8px', display: 'inline-flex', alignItems: 'center', gap: '4px' }} title="Factory+ Cloud Virtual Gateway">
                               <IconZap size={11} /> VIRTUAL
                             </span>
                           )}
                           {g.is_archived && (
                             <span className="badge badge-warning" style={{ background: 'rgba(255,179,0,0.15)', color: 'var(--warning-text)', border: '1px solid var(--warning)', marginLeft: '8px' }} title="Decommissioned gateway">
                               <IconArchive size={11} /> ARCHIVED
                             </span>
                           )}
                         </td>
                         <td><CopyableId value={g.sparkplug_id || gatewaySparkplugId(g.gateway_id)} label="Sparkplug edge node id" onNotify={showToast} /></td>
                         <td><span className="mono" style={{ color: 'var(--text-muted)' }}>{g.ip_address || '—'}</span></td>
                         <td>
                           {g.cell_id
                             ? (cells.find(c => c.cell_id === g.cell_id)?.cell_name || <span className="mono">{g.cell_id}</span>)
                             : <span style={{ fontSize: '11px', color: 'var(--warning-text)', fontStyle: 'italic' }} title="Devices on this gateway will not appear under any cell">Unassigned</span>}
                         </td>
                         <td>
                           {g.is_archived ? (
                             <span className="badge badge-warning" style={{ background: 'rgba(255,179,0,0.15)', color: 'var(--warning-text)' }}>DECOMMISSIONED</span>
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
                             /* Collapsed past three, as the Devices Type column is. A gateway
                                serving twenty devices rendered twenty-one chips and a row several
                                lines tall -- and the count is unbounded, since it grows with the
                                fleet rather than with a fixed vocabulary.

                                TWO KINDS OF ENTRY ARE PINNED. The Online/Offline summary is the
                                answer to "is this gateway healthy", which is the question the
                                column exists to answer, so hiding it behind a "+18" would defeat
                                the column. A QUARANTINED device is pinned for the same reason
                                Unmodelled is on Devices: it is the one entry that calls for
                                action, and it would otherwise be lost among the healthy ones. */
                             <TagList
                               limit={3}
                               tags={[
                                 {
                                   key: '__summary__',
                                   priority: true,
                                   className: 'badge badge-neutral',
                                   title: 'Connected devices breakdown',
                                   content: `${onlineCount} Online / ${offlineCount} Offline`
                                 },
                                 ...gwAssets.map(a => ({
                                   key: a.asset_id,
                                   // The tooltip on "+N" lists names, not the UUIDs these are keyed by.
                                   label: a.asset_name,
                                   priority: a.is_quarantined,
                                   className: `badge ${a.status === 'OFFLINE' ? 'badge-neutral' : 'badge-online'}`,
                                   style: { fontSize: '10px' },
                                   title: `${a.asset_name} — ${a.is_quarantined ? 'QUARANTINED' : a.status || 'ONLINE'}`,
                                   content: `${a.asset_name}${a.is_quarantined ? ' (quarantined)' : ''}`
                                 }))
                               ]}
                             />
                           )}
                         </td>
                         <td>
                           {/* Same shape as the Devices row: the primary actions stay visible and
                               the rest go in the overflow menu. Launch UI keeps its prominence --
                               it is the one action here that leaves the dashboard entirely, and on
                               a virtual gateway it is the whole point of the row.

                               RESTORE REPLACES EDIT on an archived gateway, as on Devices: Edit
                               was already disabled there, so nothing is lost, and Restore is the
                               only action that means anything on an archived row. */}
                           <div className="btn-group" style={{ justifyContent: 'flex-end' }}>
                             {g.access_url && (
                               <a href={g.access_url} target="_blank" rel="noopener noreferrer" className="btn btn-primary btn-sm" style={{ textDecoration: 'none', gap: '4px', padding: '4px 10px' }} title="Open Node-RED / Virtual Gateway Editor">
                                 <IconExternalLink size={12} /> Launch UI
                               </a>
                             )}

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
                                 className={`btn btn-ghost btn-sm ${!canManage ? 'btn-disabled' : ''}`}
                                 disabled={!canManage}
                                 onClick={() => canManage && (setEditing(g), setForm(g), setShowForm(true))}
                                 title={!canManage ? 'Requires Admin permissions' : 'Edit gateway properties'}
                               >
                                 <IconPencil size={13} /> Edit
                               </button>
                             )}

                             <ActionMenu
                               testId={`gateway-actions-${g.gateway_id}`}
                               items={[
                                 {
                                   key: 'docs',
                                   icon: <IconFileText size={13} />,
                                   label: expandedGwDocs[g.gateway_id] ? 'Hide documents' : 'Show documents',
                                   title: 'Toggle attached document links accordion',
                                   onClick: () => toggleGwDocExpand(g.gateway_id)
                                 },
                                 {
                                   key: 'thread',
                                   icon: <IconHistory size={13} />,
                                   label: 'Digital Thread',
                                   title: 'View gateway Digital Thread audit trace',
                                   onClick: () => setThreadFor(g)
                                 },
                                 { separator: true },
                                 // Archive only: Restore is promoted into the row above, so the
                                 // menu never carries both.
                                 !g.is_archived && {
                                   key: 'archive',
                                   icon: <IconArchive size={13} />,
                                   label: 'Archive gateway',
                                   danger: true,
                                   disabled: !canArchive,
                                   title: !canArchive ? 'Requires Admin permissions' : 'Decommission & Archive Gateway',
                                   onClick: () => setArchiveTarget(g)
                                 }
                               ]}
                             />
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
            {/* Name first: it is the human handle. The identifiers below are machine-issued
                and read-only, and only matter when configuring the physical edge node. */}
            <div className="form-group">
              <label className="form-label">Gateway Name</label>
              <input className="form-control" value={form.gateway_name} onChange={e => setForm(f => ({ ...f, gateway_name: e.target.value }))} title="Friendly label for this gateway" placeholder="e.g. Virtual_Gateway_NodeRED" />
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                A display label only — rename it freely. Heartbeats are matched on the Sparkplug ID below.
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Sparkplug ID</label>
              {editing ? (
                <>
                  <CopyableId value={editing.sparkplug_id || gatewaySparkplugId(editing.gateway_id)} label="Sparkplug edge node id" onNotify={showToast} />
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                    Configure this edge node to publish on <span className="mono">spBv1.0/&lt;group&gt;/NDATA/{editing.sparkplug_id || gatewaySparkplugId(editing.gateway_id)}</span>. Click to copy.
                  </div>
                </>
              ) : (
                <input className="form-control" value="— issued on save —" disabled readOnly title="Derived from the gateway's database id once the record exists" />
              )}
            </div>
            <div className="form-group">
              <label className="form-label">Internal UUID</label>
              {editing
                ? <CopyableId value={form.gateway_id} label="gateway UUID" onNotify={showToast} />
                : <input className="form-control" value="— assigned on save —" disabled readOnly title="Database-generated UUID; not editable" />}
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
