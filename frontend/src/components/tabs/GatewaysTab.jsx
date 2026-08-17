import React, { useState, useEffect, useCallback } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS, REALTIME_ENABLED, STALENESS_TICK_MS, refreshInterval } from '../../constants'
import { usePolling } from '../../hooks/usePolling'
import { useRealtimeTable } from '../../hooks/useRealtimeTable'
import { useClockTick } from '../../hooks/useClockTick'
import { gatewayLiveStatus, formatHeartbeat } from '../../utils/gatewayStatus'
import { gatewaySparkplugId } from '../../utils/sparkplugId'
import { deviceLifecycleStatus, deviceStatusDotColor, deviceStatusTitle } from '../../utils/deviceStatus'
import { SCOPE_CELL, SCOPE_SITE_WIDE } from '../../utils/cellResolution'
import CopyableId from '../common/CopyableId'
import { TagList } from '../common/TagList'
import { StatusBadge } from '../common/StatusBadge'
import { ActionButton } from '../common/ActionButton'
import { usePendingAction, usePendingKey } from '../../hooks/usePendingAction'
import { ContextPanel, rowSelectHandler } from '../common/ContextPanel'
import { ArchiveModal } from '../modals/ArchiveModal'
import { EntityDocumentsModal } from '../modals/EntityDocumentsModal'
import {
  IconRadio,
  IconPlus,
  IconPencil,
  IconArchive,
  IconRefreshCw,
  IconHistory,
  IconBookOpen,
  IconExternalLink,
  IconZap,
  IconShieldAlert,
  IconMap,
  IconX
} from '../common/Icons'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { useArrivalSelection } from '../../hooks/useArrivalSelection'

export function GatewaysTab({ showToast, onViewThread, onSelectCell, onSelectDevice, hasPermission, initialSearchFilter, onClearFilter, onBugReport }) {
  const [gateways, setGateways] = useState([])
  const [assets, setAssets]     = useState([])
  const [cells, setCells]       = useState([])
  const [loading, setLoading]   = useState(true)
  const [showForm, setShowForm] = useState(false)
  // The create/edit form is a modal like any other, even though it is written inline here rather
  // than extracted into components/modals. Escape closes it, through the shared stack so the
  // ArchiveModal that can open over it is the one that answers first.
  useEscapeKey(() => setShowForm(false), showForm)
  const [editing, setEditing]   = useState(null)
  const [archiveTarget, setArchiveTarget] = useState(null)
  // The context panel holds an ID, not the gateway object.
  //
  // This page polls, so a captured object would freeze at the moment it was clicked -- the panel
  // would show a heartbeat that stopped ageing and a status that never changed, beside a table row
  // updating normally. Resolving the id against the current list every render means the drawer is
  // as live as the row it came from, and it closes itself if the entity disappears.
  const [selectedId, setSelectedId] = useState(null)
  // location_scope defaults to 'cell' -- an edge node belongs in some cell until someone says
  // otherwise. is_virtual is deliberately NOT the same question: virtual is a deployment fact
  // (this connector runs on the app host), site-wide is a claim about location. A virtual
  // gateway is usually site-wide, but conflating them would relocate assets on a checkbox.
  const blank = { gateway_id: '', gateway_name: '', status: 'OFFLINE', is_virtual: false, access_url: '', cell_id: '', location_scope: SCOPE_CELL }
  const [form, setForm]         = useState(blank)
  const [docsForGw, setDocsForGw] = useState(null)
  const [docRefreshKey, setDocRefreshKey] = useState(0)
  const [filterMode, setFilterMode] = useState('all')
  // Document link counts for the collapsed accordion badge, keyed by gateway id. Fetched once
  // for the whole page rather than per row: /api/v1/documents accepts entity_type on its own,
  // so one request answers every row instead of one request each.
  const [docCounts, setDocCounts] = useState({})

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

  /**
   * Document-link counts for the collapsed accordion badges.
   *
   * Deliberately NOT part of load() above. That runs on the poll and on every Realtime event,
   * and ingestion stamps last_heartbeat roughly every 30s per gateway -- so folding this in
   * would issue a documents query on the busiest subscription in the app to refresh a number
   * that changes when a human edits a link. Keyed on docRefreshKey instead: once on mount, and
   * again when EntityDocumentsModal closes.
   *
   * Non-fatal: a failure leaves the badges at zero, which is what they read before this
   * existed. A page of gateways must not fail to render because a count could not be had.
   */
  useEffect(() => {
    let cancelled = false
    api.get('/api/v1/documents?entity_type=gateway')
      .then(docs => {
        if (cancelled) return
        const counts = {}
        for (const d of docs || []) counts[d.entity_id] = (counts[d.entity_id] || 0) + 1
        setDocCounts(counts)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [docRefreshKey])

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

  // In-flight state for the form's Save and for whichever gateway is restoring.
  const [saving, runSave] = usePendingAction()
  const [restoringId, runRestore] = usePendingKey()

  const save = async () => {
    try {
      if (editing) await api.put(`/api/v1/gateways/${editing.gateway_id}`, form)
      else         await api.post('/api/v1/gateways', form)
      setShowForm(false); load(); showToast(editing ? 'Gateway saved' : 'Gateway created', 'success')
    } catch (e) { showToast(e.message, 'error') }
  }

  const archiveGateway = async (days) => {
    try {
      await api.post(`/api/v1/gateways/${archiveTarget.gateway_id}/archive`, { auto_delete_days: days })
      // Closes after the request, which is what lets ArchiveModal hold its pending state for the
      // whole round trip -- see the note on CellsTab.archiveCell.
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

  // Arriving from a cell's gateway chip, a device's Serving Gateway chip or the shopfloor map: the
  // caller named ONE gateway, so open it. Identifier equality only -- see the hook.
  useArrivalSelection(
    searchQuery,
    gateways,
    (g, term) => g.gateway_id === term || gatewaySparkplugId(g) === term,
    (g) => setSelectedId(g.gateway_id)
  )

  // Resolved fresh every render -- see the note on selectedId. A gateway that has been archived
  // out of the current filter, or deleted, resolves to null and the drawer simply closes.
  const selected = gateways.find(g => g.gateway_id === selectedId) || null
  const selectedDevices = selected?.devices || []
  const selectedCell = selected ? cells.find(c => c.cell_id === selected.cell_id) : null

  return (
    <div className="page-layout">
      <div className="page-main">

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

        {/* The page's one primary action, at the far end of the row it shares with the filters.
            It had a row of its own -- a 34px band holding a single button, above a filter bar that
            was already the page's control surface. `.filter-bar-spacer` pushes it right. */}
        <button
          className={`btn btn-primary btn-sm filter-bar-spacer ${!canManage ? 'btn-disabled' : ''}`}
          disabled={!canManage}
          onClick={() => canManage && (setEditing(null), setForm(blank), setShowForm(true))}
          title={!canManage ? 'Requires Admin permissions' : 'Register new edge gateway'}
        >
          <IconPlus size={14} /> New Gateway
        </button>
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
                   <th title="Shopfloor cell zone this gateway serves">Cell Zone</th>
                   <th title="Network connectivity status">Gateway Status</th>
                   <th title="Age of the last Sparkplug B node heartbeat (NBIRTH/NDATA/NDEATH)">Last Heartbeat</th>
                   <th title="Devices assigned to this gateway">Connected Devices</th>
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
                       {/* The row is both a selector and a container of buttons, so the click is
                           filtered -- see rowSelectHandler. Clicking Edit must not also select. */}
                       <tr
                         className={`row-selectable${selectedId === g.gateway_id ? ' row-selected' : ''}`}
                         style={{ background: g.is_archived ? 'rgba(255,179,0,0.06)' : undefined }}
                         onClick={rowSelectHandler(() => setSelectedId(id => id === g.gateway_id ? null : g.gateway_id))}
                         title="Click to inspect this gateway in the details panel"
                       >
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
                         <td>
                           {/* Three states, not two. Site-Wide is an answer -- a host-run
                               connector serving the facility -- and must not read as the
                               unanswered case, or nobody ever stops trying to "fix" it. */}
                           {g.location_scope === SCOPE_SITE_WIDE
                             ? <span className="badge badge-neutral" style={{ fontSize: '11px' }} title="Serves the whole facility rather than one cell. Its devices need their own cell.">Site-Wide</span>
                             : g.cell_id
                               ? (cells.find(c => c.cell_id === g.cell_id)?.cell_name || <span className="mono">{g.cell_id}</span>)
                               : <span style={{ fontSize: '11px', color: 'var(--warning-text)', fontStyle: 'italic' }} title="Devices on this gateway inherit no cell, so they land in the Unassigned queue">No cell</span>}
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
                                   style: { fontSize: '11px' },
                                   title: `${a.asset_name} — ${a.is_quarantined ? 'QUARANTINED' : a.status || 'ONLINE'}`,
                                   content: `${a.asset_name}${a.is_quarantined ? ' (quarantined)' : ''}`
                                 }))
                               ]}
                             />
                           )}
                         </td>
                       </tr>
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
            {/* THE READ-ONLY IDENTIFIER BLOCKS ARE GONE, same as in the device form. Sparkplug ID,
                the publish-topic helper and the internal UUID were three of this dialog's rows and
                none of them could be edited; all three are on the context drawer, copyable, where
                somebody hunting an identifier actually looks. A form whose majority is read-only
                teaches the reader that its controls are decorative. */}
            <div className="form-group">
              <label className="form-label">Gateway Name</label>
              <input className="form-control" value={form.gateway_name} onChange={e => setForm(f => ({ ...f, gateway_name: e.target.value }))} title="Friendly label for this gateway" placeholder="e.g. Sim_Gateway_Cell1_Machining" />
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                A display label only — rename it freely. Heartbeats are matched on the Sparkplug ID, which is generated from the database key and never moves.
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Description</label>
              <textarea
                className="form-control"
                rows={2}
                value={form.description || ''}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                title="Optional free-text note about this gateway"
                placeholder="e.g. Panel-mounted IPC in the machining cell, north wall"
              />
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                Optional, and read by nothing — a note for whoever comes to this next.
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Shopfloor Cell Zone</label>
              <select
                className="form-control"
                value={form.location_scope === SCOPE_SITE_WIDE ? '' : (form.cell_id || '')}
                disabled={form.location_scope === SCOPE_SITE_WIDE}
                onChange={e => setForm(f => ({ ...f, cell_id: e.target.value }))}
                title="Cell this gateway serves — its devices inherit this cell unless they carry one of their own"
              >
                <option value="">— No cell assigned —</option>
                {cells.filter(c => !c.is_archived).map(c => (
                  <option key={c.cell_id} value={c.cell_id}>{c.cell_name}</option>
                ))}
              </select>

              {/* Site-Wide is what a host-run or central connector actually is: it serves the
                  facility, not a bay. Ticking it clears the cell, mirroring
                  gateways_site_wide_has_no_cell -- "it is in no particular cell" and "it is in
                  Bay 4" cannot both be true. */}
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '8px', fontSize: '12px', cursor: 'pointer' }}
                     title="For a host-run or central gateway that serves the whole facility rather than one cell">
                <input
                  type="checkbox"
                  checked={form.location_scope === SCOPE_SITE_WIDE}
                  onChange={e => setForm(f => ({
                    ...f,
                    location_scope: e.target.checked ? SCOPE_SITE_WIDE : SCOPE_CELL,
                    cell_id: e.target.checked ? '' : f.cell_id
                  }))}
                />
                <span>Site-Wide — this gateway serves no single cell</span>
              </label>

              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
                {form.location_scope === SCOPE_SITE_WIDE
                  ? 'Its devices inherit nothing from it, so each one needs its own cell — or its own Site-Wide mark. Scope is not inherited: a machine reached through a host-run connector is still in a cell.'
                  : form.cell_id
                    ? 'Devices served by this gateway appear under this cell, unless a device carries a cell of its own.'
                    : 'With no cell here, devices served by this gateway land in the Unassigned queue unless each is given one. If this connector serves the whole facility, mark it Site-Wide instead.'}
              </div>
            </div>
            {/* .form-group-check rather than an inline 12px/12px pair: this was the one field in
                the app on its own vertical rhythm, which read as a gap where a field had been
                deleted rather than as a deliberately tighter row. */}
            <div className="form-group form-group-check">
              <input type="checkbox" id="is_virtual" checked={form.is_virtual || false} onChange={e => setForm(f => ({ ...f, is_virtual: e.target.checked }))} />
              <label htmlFor="is_virtual" className="form-label">⚡ Mark as Virtual Gateway (Cloud / Server-Simulated)</label>
            </div>
            <div className="form-group">
              <label className="form-label">Gateway Access URL (Optional UI Console)</label>
              <input className="form-control" value={form.access_url || ''} onChange={e => setForm(f => ({ ...f, access_url: e.target.value }))} placeholder="e.g. http://localhost:1880" title="Web Console / Management URL for this gateway" />
            </div>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setShowForm(false)} disabled={saving} title="Cancel">Cancel</button>
              <ActionButton
                pending={saving}
                pendingLabel={editing ? 'Saving…' : 'Creating…'}
                onClick={() => runSave(save)}
                title="Save gateway configuration"
              >
                Save
              </ActionButton>
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

      {docsForGw && (
        <EntityDocumentsModal entityType="gateway" entityId={docsForGw.gateway_id} entityName={docsForGw.gateway_name} onClose={() => { setDocsForGw(null); setDocRefreshKey(k => k + 1) }} showToast={showToast} hasPermission={hasPermission} />
      )}
      </div>

      <ContextPanel
        open={!!selected}
        onClose={() => setSelectedId(null)}
        type="GATEWAY"
        onCopy={showToast}
        title={selected?.gateway_name || ''}
        subtitle={selected && (
          <>
            <StatusBadge status={gatewayLiveStatus(selected)} />
            {selected.is_virtual && <span className="badge badge-neutral" style={{ fontSize: '11px' }}>VIRTUAL</span>}
            {selected.is_archived && <span className="badge badge-warning" style={{ fontSize: '11px' }}>ARCHIVED</span>}
          </>
        )}
        fields={selected ? [
          { label: 'Gateway UUID', value: selected.gateway_id, mono: true, copyable: true },
          // The id it publishes under, which is what a Sparkplug trace or an MQTT subscription is
          // keyed on -- and the one identifier here that is not the UUID above it.
          { label: 'Sparkplug Edge Node ID', value: selected.sparkplug_id || gatewaySparkplugId(selected.gateway_id), mono: true, copyable: true },
          {
            // The REAL group id where the gateway carries one. Migration 0008 made the edge node
            // address (group, node) rather than node alone, so a wildcard here was throwing away
            // half of an address the row already knows -- and a topic you cannot paste into an MQTT
            // client without editing it first is not much of an answer. Falls back to `+` only
            // where the group is genuinely unrecorded.
            label: 'Sparkplug Topic Path',
            value: `spBv1.0/${selected.sparkplug_group || '+'}/NDATA/${selected.sparkplug_id || gatewaySparkplugId(selected.gateway_id)}`,
            mono: true,
            copyable: true,
            title: selected.sparkplug_group
              ? 'The NDATA topic this edge node publishes on.'
              : 'The NDATA topic this edge node publishes on. No Sparkplug group is recorded for it, so that segment is a wildcard.'
          },
          {
            label: 'Cell Zone',
            // A LINK when there is a cell to open. Site-Wide is deliberately left as plain text --
            // it is the assertion that this gateway belongs to no cell, so a chip styled like the
            // others but leading nowhere would promise an affordance that cannot exist.
            value: selected.location_scope === SCOPE_SITE_WIDE
              ? 'Site-Wide'
              : selectedCell
                ? (
                    <button
                      className="chip chip-link"
                      onClick={() => onSelectCell?.(selectedCell.cell_id)}
                      title="Open this cell on the Cells page"
                    >
                      <IconMap size={11} />
                      <span className="chip-name">{selectedCell.cell_name}</span>
                    </button>
                  )
                : (selected.cell_id || null),
            title: selected.location_scope === SCOPE_SITE_WIDE
              ? 'A host-run or central connector serving the whole facility. Its devices inherit no cell from it.'
              : 'Devices served by this gateway resolve to this cell unless they carry one of their own.'
          },
          { label: 'Last Heartbeat', value: formatHeartbeat(selected.last_heartbeat), title: 'Age of the last NBIRTH/NDATA/NDEATH. STALE after 90 seconds of silence.' },
          {
            label: 'Description',
            value: selected.description || null,
            full: true,
            title: 'Operator note. Free text, read by nothing.'
          },
        ] : []}
        actions={selected ? [
          selected.access_url && {
            label: 'Launch UI', icon: <IconExternalLink size={13} />, href: selected.access_url, primary: true,
            title: 'Open Node-RED / Virtual Gateway Editor'
          },
          // Restore REPLACES Edit on an archived gateway: editing one is refused anyway, and
          // Restore is the only action that means anything there.
          selected.is_archived ? {
            label: 'Restore Gateway', icon: <IconRefreshCw size={13} />,
            onClick: () => runRestore(selected.gateway_id, () => restoreGateway(selected.gateway_id, selected.gateway_name)),
            pending: restoringId === selected.gateway_id,
            pendingLabel: 'Restoring…',
            disabled: !canArchive,
            primary: !selected.access_url,
            title: !canArchive ? 'Requires Admin permissions' : 'Restore gateway back to active service'
          } : {
            label: 'Edit Details', icon: <IconPencil size={13} />,
            onClick: () => { setEditing(selected); setForm(selected); setShowForm(true) },
            disabled: !canManage,
            title: !canManage ? 'Requires Admin permissions' : 'Edit gateway configuration'
          },
          {
            label: 'View Digital Thread', icon: <IconHistory size={13} />,
            onClick: () => onViewThread?.(selected),
            title: 'Open the immutable audit trace for this gateway'
          },
          {
            label: 'Manage Documents', icon: <IconBookOpen size={13} />,
            onClick: () => setDocsForGw(selected),
            title: 'Attach or edit external document links for this gateway'
          },
          !selected.is_archived && {
            label: 'Archive Gateway', icon: <IconArchive size={13} />,
            onClick: () => setArchiveTarget(selected),
            disabled: !canArchive,
            danger: true,
            title: !canArchive ? 'Requires Admin permissions' : 'Decommission & Archive Gateway'
          },
        ].filter(Boolean) : []}
        /* WITH THE METADATA, ABOVE THE ACTIONS. "Which devices" is a fact about this gateway
           rather than an action on it -- it is the question the row's Connected Devices count
           raises and cannot answer, so it belongs with Last Heartbeat and the topic path, not
           below a list of buttons where it read as an afterthought. */
        beforeActions={selected && (
          <div>
            <div className="context-panel-section-label">Connected Devices ({selectedDevices.length})</div>
            {selectedDevices.length === 0
              ? <div className="context-field-empty" style={{ fontSize: '11px' }}>No devices assigned</div>
              : (
                /* CHIPS THAT GO SOMEWHERE, not status badges. This list answers "which devices" and
                   then stranded you: the next question is always "what is wrong with that one", and
                   the only way through was to read a name off here, switch tab and search for it.
                   Now it is a click, matching the Cell Zone and Schema chips elsewhere in this
                   drawer -- one navigation idiom across all four pages rather than three.

                   THE LIFECYCLE STATE SURVIVES THE CHANGE, as a dot rather than as the chip's own
                   colour. A chip coloured by status would collide with `chip-link`'s hover, and the
                   two facts are independent: where this goes, and how the device is doing. */
                <div className="context-device-list">
                  {selectedDevices.map(d => {
                    const status = deviceLifecycleStatus(d)
                    return (
                      <button
                        key={d.asset_id}
                        className="chip chip-link"
                        onClick={() => onSelectDevice?.(d.asset_id)}
                        title={`Open ${d.asset_name} on the Devices page — ${deviceStatusTitle(status)}`}
                      >
                        <span className="badge-dot" style={{ background: deviceStatusDotColor(status) }} />
                        <span className="chip-name">{d.asset_name}</span>
                      </button>
                    )
                  })}
                </div>
              )}
          </div>
        )}
      />
    </div>
  )
}
