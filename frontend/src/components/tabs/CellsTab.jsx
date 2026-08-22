import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS, REALTIME_ENABLED, refreshInterval } from '../../constants'
import { usePolling } from '../../hooks/usePolling'
import { useRealtimeTable } from '../../hooks/useRealtimeTable'
import { gatewayLiveStatus, gatewayNeedsAttention, formatHeartbeat } from '../../utils/gatewayStatus'
import { effectiveSparkplugId, gatewaySparkplugId } from '../../utils/sparkplugId'
import { groupDevicesByCell, SOURCE_SITE_WIDE } from '../../utils/cellResolution'
import CopyableId from '../common/CopyableId'
import { StatusBadge } from '../common/StatusBadge'
import { ActionButton } from '../common/ActionButton'
import { usePendingAction, usePendingKey } from '../../hooks/usePendingAction'
import { ContextPanel, rowSelectHandler } from '../common/ContextPanel'
import { CellIcon, CELL_ICONS, DEFAULT_CELL_ICON } from '../../utils/cellIcon'
import { ArchiveModal } from '../modals/ArchiveModal'
import { EntityDocumentsModal } from '../modals/EntityDocumentsModal'
import {
  IconFactory,
  IconPlus,
  IconPencil,
  IconArchive,
  IconRefreshCw,
  IconBookOpen,
  IconHistory,
  IconExternalLink,
  IconRadio,
  IconShieldAlert,
  IconX
} from '../common/Icons'
import { deviceLifecycleStatus, deviceStatusDotColor, deviceStatusTitle, deviceDotColor } from '../../utils/deviceStatus'
import { alertIndex, alertForDevice } from '../../utils/deviceAlerts'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { useArrivalSelection } from '../../hooks/useArrivalSelection'

export function CellsTab({ showToast, onSelectDevice, onSelectGateway, onViewThread, hasPermission, initialSearchFilter, onClearFilter, activeAlerts = [] }) {
  /** Devices Grafana currently has an alert firing on -- see utils/deviceAlerts.js (issue #34). */
  const alerts = React.useMemo(() => alertIndex(activeAlerts), [activeAlerts])
  /**
   * A cell handed over from the Overview shopfloor map arrives as `?search=<cell_id>`.
   *
   * The URL wins over the prop, and both are read: the query string survives a reload and a
   * shared link, while the prop covers a navigation that did not push one. Same arrangement as
   * GatewaysTab and DevicesTab -- this page was the only drill-down target that implemented
   * neither half, so clicking a cell on Overview landed on an unfiltered list.
   *
   * No new filter control is needed: the existing predicate below already matches cell_id OR
   * cell_name, so an id drops straight into the search box.
   */
  const getInitialSearch = () => {
    const params = new URLSearchParams(window.location.search)
    return params.get('search') || initialSearchFilter || ''
  }

  const [cells, setCells]       = useState([])
  const [assets, setAssets]     = useState([])
  const [loading, setLoading]   = useState(true)
  const [showForm, setShowForm] = useState(false)
  // See GatewaysTab: an inline modal is still a modal, and Escape has to close it.
  useEscapeKey(() => setShowForm(false), showForm)
  const [editing, setEditing]   = useState(null)
  // DEFAULT_CELL_ICON rather than the literal 'Factory': the column's default, the CHECK
  // constraint and this form all have to agree, and one imported constant is one place they can.
  const blank = { cell_name: '', access_url: '', icon: DEFAULT_CELL_ICON }
  const [formVal, setFormVal]   = useState(blank)
  const [archiveTarget, setArchiveTarget] = useState(null)
  const [docsForCell, setDocsForCell] = useState(null)
  const [docRefreshKey, setDocRefreshKey] = useState(0)
  // Document link counts for the collapsed accordion badge, keyed by cell id. `c.document_count`
  // was read here before, but nothing ever produced that field -- api.js does not select it for
  // any entity type -- so the badge read 0 until the accordion was expanded and could count its
  // own fetch. One request per page answers every row.
  const [docCounts, setDocCounts] = useState({})
  const [filterMode, setFilterMode] = useState('all')
  const [searchQuery, setSearchQuery] = useState(getInitialSearch)
  const [attentionOnly, setAttentionOnly] = useState(false)
  const [emptyOnly, setEmptyOnly] = useState(false)

  // Re-reads on a later hand-over: the tab stays mounted across an Overview -> Cells -> Overview
  // -> Cells round trip, so the initial state above only fires once.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const urlSearch = params.get('search')
    if (urlSearch) setSearchQuery(urlSearch)
    else if (initialSearchFilter) setSearchQuery(initialSearchFilter)
  }, [initialSearchFilter])

  /**
   * Document-link counts for the collapsed accordion badges. Keyed on docRefreshKey rather than
   * folded into loadAll(), which runs on the poll and on every Realtime event -- this number
   * changes only when a human edits a link. Non-fatal: a failure leaves the badges at zero.
   */
  useEffect(() => {
    let cancelled = false
    api.get('/api/v1/documents?entity_type=cell')
      .then(docs => {
        if (cancelled) return
        const counts = {}
        for (const d of docs || []) counts[d.entity_id] = (counts[d.entity_id] || 0) + 1
        setDocCounts(counts)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [docRefreshKey])

  /**
   * Clearing the search also strips `?search=` from the address bar and releases the lifted
   * filter in App. Without both, a reload or a Back would silently re-apply a filter the user
   * had just cleared.
   */
  const clearSearch = useCallback(() => {
    setSearchQuery('')
    if (window.location.search) {
      window.history.replaceState({}, '', window.location.pathname)
    }
    if (onClearFilter) onClearFilter()
  }, [onClearFilter])

  const loadAll = useCallback(async (signal) => {
    try {
      // /api/v1/cells embeds each cell's gateways only. Device membership is the resolved
      // effective cell (devices.cell_id, else the gateway's), which is grouped from `assets`
      // by groupDevicesByCell -- so this list is the source for both the cell cards and the
      // unassigned counter, and is read once rather than once per view.
      const [c, a] = await Promise.all([
        api.get('/api/v1/cells', { signal }),
        api.get('/api/v1/devices', { signal }),
      ])
      setCells(c); setAssets(a)
      setLoading(false)
    } catch (err) {
      if (err.name !== 'AbortError') {
        setLoading(false)
      }
      throw err
    }
  }, [])

  // Reconciliation loop, not the primary refresh -- see useRealtimeTable for why polling stays.
  usePolling(loadAll, refreshInterval())
  // gateways and devices are watched too: a cell's rendered contents come from the embed
  // (cells -> gateways -> devices), so a device moving between gateways changes this page
  // without touching a single `cells` row.
  useRealtimeTable(['cells', 'gateways', 'devices'], loadAll, { enabled: REALTIME_ENABLED })

  // In-flight state for the form's Save and for whichever row is restoring. See
  // hooks/usePendingAction.js for why the row list needs a key rather than a second boolean.
  const [saving, runSave] = usePendingAction()
  const [restoringId, runRestore] = usePendingKey()

  const save = async () => {
    try {
      if (editing) await api.put(`/api/v1/cells/${editing.cell_id}`, formVal)
      else         await api.post('/api/v1/cells', formVal)
      setShowForm(false); loadAll(); showToast(editing ? 'Cell saved' : 'Cell created', 'success')
    } catch (e) { showToast(e.message, 'error') }
  }

  const archiveCell = async (days) => {
    try {
      await api.post(`/api/v1/cells/${archiveTarget.cell_id}/archive`, { auto_delete_days: days })
      // Already closed after the request rather than before it, which is what lets ArchiveModal
      // hold its Archiving… state for the whole round trip. Left alone deliberately -- the two
      // places that DID dismiss on the click (ArchivesTab.purge, DirectoryTab's GitOps sync) were
      // the ones that had to move.
      setArchiveTarget(null); loadAll(); showToast(`Cell '${archiveTarget.cell_name}' archived (Out of Commission)`, 'success')
    } catch (e) { showToast(e.message, 'error') }
  }

  const restoreCell = async (cellId, name) => {
    try {
      await api.post(`/api/v1/cells/${cellId}/restore`, {})
      loadAll(); showToast(`Cell '${name}' restored to active service`, 'success')
    } catch (e) { showToast(e.message, 'error') }
  }

  // An ID, not the cell object -- this page polls, so a captured object would freeze while the
  // card beside it kept updating. Resolved against `cells` every render.
  const [selectedId, setSelectedId] = useState(null)

  const canManage = hasPermission(PERMISSION_UUIDS.CELL_MANAGE)
  const canArchive = hasPermission(PERMISSION_UUIDS.ARCHIVE_MANAGE)

  // A device that resolves to no cell appears on no cell card, so surface it rather than letting
  // it silently vanish -- but ONLY when that is an unanswered question.
  //
  // A Site-Wide device also resolves to no cell, and it is excluded here: that is the operator's
  // deliberate answer, not an omission. Flagging it produced a permanent warning that no action
  // could ever clear, which is worse than no warning at all -- it trains people to ignore the
  // banner, and this is the same distinction the Devices page's "Needs attention" filter makes.
  //
  // `effective_cell_id`, not `cell_id`: the latter is the explicit override and is NULL for every
  // device that merely inherits its cell.
  const unlinkedDevices = assets.filter(a =>
    !a.is_archived && !a.effective_cell_id && a.location_source !== SOURCE_SITE_WIDE
  )

  // Cell membership, grouped from the device list this page already holds.
  //
  // /api/v1/cells deliberately does NOT return devices: a cell's devices are those that RESOLVE
  // to it, which no PostgREST embed can express, and having the endpoint fetch them meant this
  // page read the whole device table twice on every poll. Grouping here costs one pass over a
  // list already in memory.
  const devicesByCell = useMemo(() => groupDevicesByCell(assets), [assets])

  const liveGateways = (c) => (c.gateways || []).filter(g => !g.is_archived)
  const liveDevices = (c) => (devicesByCell.get(c.cell_id) || []).filter(a => !a.is_archived)

  // gatewayNeedsAttention(), NOT `gatewayLiveStatus(g) !== 'ONLINE'`.
  //
  // A physical gateway sits in PENDING_ENROLLMENT from creation until somebody carries its bundle to
  // a machine, and in AWAITING_BIRTH until that machine publishes. Both are unfinished TASKS, not
  // faults -- and under the old test, ordering four appliances on a Monday morning flagged every
  // cell they belong to, which is precisely when this signal needs to still mean something.
  const cellNeedsAttention = (c) =>
    liveGateways(c).some(g => gatewayNeedsAttention(g)) ||
    liveDevices(c).some(a => a.is_quarantined)

  // Either no gateways at all, or gateways serving nothing -- usually a provisioning mistake or a
  // decommissioned area nobody cleaned up.
  const cellIsEmpty = (c) => liveGateways(c).length === 0 || liveDevices(c).length === 0

  const filteredCells = cells.filter(c => {
    if (filterMode === 'active'   && c.is_archived) return false
    if (filterMode === 'archived' && !c.is_archived) return false
    if (attentionOnly && !cellNeedsAttention(c)) return false
    if (emptyOnly && !cellIsEmpty(c)) return false
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      if (!String(c.cell_id).toLowerCase().includes(q) && !c.cell_name.toLowerCase().includes(q)) return false
    }
    return true
  })

  const attentionCount = cells.filter(c => !c.is_archived && cellNeedsAttention(c)).length
  const emptyCount = cells.filter(c => !c.is_archived && cellIsEmpty(c)).length
  const activeFilterCount =
    (searchQuery ? 1 : 0) + (attentionOnly ? 1 : 0) + (emptyOnly ? 1 : 0) + (filterMode !== 'all' ? 1 : 0)

  // Arriving from a device's or gateway's Cell Zone chip, or the shopfloor map: the caller named ONE
  // cell, so open it rather than leaving a one-card list to be clicked. Identifier equality only --
  // this page's own search predicate also matches cell_name, and typing a name must open nothing.
  useArrivalSelection(
    searchQuery,
    cells,
    (c, term) => c.cell_id === term,
    (c) => setSelectedId(c.cell_id)
  )

  // Resolved fresh every render -- see the note on selectedId. A cell that is archived out of the
  // current filter, or deleted, resolves to null and the drawer closes itself.
  const selectedCell = cells.find(c => c.cell_id === selectedId) || null
  const selectedCellGateways = selectedCell?.gateways || []
  const selectedCellDevices = selectedCell ? (devicesByCell.get(selectedCell.cell_id) || []) : []

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
          <option value="all">All ({cells.length})</option>
          <option value="active">Active ({cells.filter(c => !c.is_archived).length})</option>
          <option value="archived">Archived ({cells.filter(c => c.is_archived).length})</option>
        </select>

        <input
          className="form-control"
          style={{ width: '220px' }}
          value={searchQuery}
          onChange={e => { const v = e.target.value; v ? setSearchQuery(v) : clearSearch() }}
          placeholder="Search by Cell ID or name…"
          title="Filter cells by ID or name"
        />

        <button
          className={`btn btn-sm ${attentionOnly ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setAttentionOnly(v => !v)}
          title="Cells containing an offline or stale gateway, or any quarantined device"
        >
          <IconShieldAlert size={13} /> Needs attention ({attentionCount})
        </button>

        <button
          className={`btn btn-sm ${emptyOnly ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setEmptyOnly(v => !v)}
          title="Cells with no gateways, or gateways serving no devices"
        >
          Empty ({emptyCount})
        </button>

        {activeFilterCount > 0 && (
          <button
            className="btn btn-ghost btn-sm filter-bar-spacer"
            onClick={() => { clearSearch(); setAttentionOnly(false); setEmptyOnly(false); setFilterMode('all') }}
            title="Clear every filter"
          >
            <IconX size={13} /> Clear filters ({activeFilterCount})
          </button>
        )}

        {/* The page's one primary action, at the far end of the row it shares with the filters.
            It had a row of its own -- a 34px band holding a single button, above a filter bar that
            was already the page's control surface. `.filter-bar-spacer` is what pushes it right. */}
        <button
          className={`btn btn-primary btn-sm filter-bar-spacer ${!canManage ? 'btn-disabled' : ''}`}
          disabled={!canManage}
          onClick={() => canManage && (setEditing(null), setFormVal(blank), setShowForm(true))}
          title={!canManage ? 'Requires Admin permissions' : 'Configure new shopfloor cell zone'}
        >
          <IconPlus size={14} /> New Cell
        </button>
      </div>

      {unlinkedDevices.length > 0 && (
        <div style={{ marginBottom: '20px', background: 'rgba(255,179,0,0.08)', border: '1px solid var(--warning)', borderRadius: 'var(--radius)', padding: '12px 16px', fontSize: '13px', color: 'var(--warning-text)', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <IconShieldAlert size={18} />
          <div>
            <strong>{unlinkedDevices.length} device{unlinkedDevices.length === 1 ? '' : 's'} not linked to any cell zone:</strong>{' '}
            {unlinkedDevices.slice(0, 5).map(a => a.asset_name).join(', ')}{unlinkedDevices.length > 5 ? ', …' : ''}.
            Set a cell on each device from the Devices page, give its gateway a cell on the Gateways page,
            or mark it Site-Wide if it belongs to no single cell.
          </div>
        </div>
      )}

      {loading ? (
        <div className="loading-wrap"><div className="spinner" /> Loading shopfloor cells…</div>
      ) : filteredCells.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-icon"><IconFactory size={36} /></div>
            <div className="empty-text">No shopfloor cells match the selected filter.</div>
          </div>
        </div>
      ) : (
        filteredCells.map(c => {
          const cellGateways = c.gateways || []
          // Devices that RESOLVE to this cell, not those merely reachable through its gateways.
          const cellAssets = devicesByCell.get(c.cell_id) || []
          // A cell with neither collapses to its header. A newly created zone has no gateway and
          // no device, so a floor in the middle of being set up was a column of full-height cards
          // each saying "nothing here" twice -- and the cells that DO have contents, which are the
          // reason to open this page, were pushed below them.
          const cellIsEmpty = cellGateways.length === 0 && cellAssets.length === 0

          return (
            <div key={c.cell_id} className={`cell-card${selectedId === c.cell_id ? ' cell-card-selected' : ''}${cellIsEmpty ? ' cell-card-empty' : ''}`} style={{ opacity: c.is_archived ? 0.9 : 1, border: c.is_archived ? '1px solid var(--warning)' : '1px solid var(--border)' }}>
              <div className="cell-card-header" style={{ background: c.is_archived ? 'rgba(255,179,0,0.06)' : 'var(--bg-glass)' }}>
                {/* The TITLE selects, not the whole card. A cell card is a container of gateway and
                    device rows that are themselves clickable, so a card-wide handler would fire on
                    every one of them -- and unlike a table row there is no single "empty" area to
                    aim at. The title is the part that names the thing the panel describes. */}
                <div
                  className="cell-card-title row-selectable"
                  onClick={() => setSelectedId(id => id === c.cell_id ? null : c.cell_id)}
                  title="Click to inspect this cell in the details panel"
                >
                  <CellIcon cell={c} size={18} />
                  <span>{c.cell_name}</span>
                  <span className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>ID: {c.cell_id}</span>
                  <span className="badge badge-neutral" title="Count of edge gateways assigned to this cell">{cellGateways.length} Gateway/s</span>
                  <span className="badge badge-neutral" title="Count of devices located in this cell — its gateways' devices, plus any device filed here explicitly">{cellAssets.length} Device/s</span>
                  {cellIsEmpty && !c.is_archived && (
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontStyle: 'italic', fontWeight: 400 }}>empty</span>
                  )}
                  {c.is_archived && (
                    <span className="badge badge-warning" style={{ background: 'rgba(255,179,0,0.15)', color: 'var(--warning-text)', border: '1px solid var(--warning)', display: 'inline-flex', alignItems: 'center', gap: '4px' }} title="Cell decommissioned and archived">
                      <IconArchive size={11} /> ARCHIVED (OUT OF COMMISSION)
                    </span>
                  )}
                </div>

              </div>

              {!(cellIsEmpty && !c.is_archived) && (
              <div className="cell-card-body">
                {c.is_archived && (
                  <div style={{ background: 'rgba(255,179,0,0.08)', border: '1px solid var(--warning)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', fontSize: '13px', color: 'var(--warning-text)', display: 'flex', alignItems: 'center', gap: '10px', width: '100%' }}>
                    <IconShieldAlert size={18} />
                    <div>
                      <strong>Cell Zone Out of Commission:</strong> This shopfloor cell is decommissioned and archived. {c.auto_delete_at ? `Retention purge timer active (auto-purges on ${new Date(c.auto_delete_at).toLocaleDateString()}).` : 'Permanent retention active (no auto-purge).'}
                    </div>
                  </div>
                )}

                {/* NO NESTED HEADER BOXES. A cell card held two titled sub-cards, each with its
                    own border and heading, each containing a table with its own header row -- four
                    levels of chrome around two short lists. The counts are already on the card
                    header above, so the headings restated them.

                    Every row is a link. A gateway or device named on a cell card is the same
                    entity as the one on its own page, and the card is where you find out it exists
                    -- so reading its name and then going to find it by hand was the missing half
                    of this page. */}
                {cellGateways.length > 0 && (
                  <div className="table-wrap">
                    {/* The two tables on a cell card share a column grid, so a reader's eye runs
                        straight down Name, Sparkplug ID and Status across both rather than
                        re-finding each column when it crosses from gateways to devices. The
                        widths only bind under `table-layout: fixed` -- see .cell-card-table. */}
                    <table className="cell-card-table">
                      <colgroup>
                        <col style={{ width: '28%' }} />
                        <col style={{ width: '26%' }} />
                        <col style={{ width: '22%' }} />
                        <col style={{ width: '16%' }} />
                        <col style={{ width: '8%' }} />
                      </colgroup>
                      <thead><tr><th title="Gateway Name">Name</th><th title="Sparkplug B edge node id">Sparkplug ID</th><th title="Connectivity status">Status</th><th title="Last Sparkplug B node heartbeat">Last Heartbeat</th><th title="Devices served by this gateway">Devices</th></tr></thead>
                      <tbody>
                        {cellGateways.map(g => (
                          <tr
                            key={g.gateway_id}
                            className="row-selectable"
                            style={{ background: g.is_archived ? 'rgba(255,179,0,0.06)' : undefined }}
                            onClick={rowSelectHandler(() => onSelectGateway?.(g.gateway_id))}
                            title={`Open '${g.gateway_name}' on the Gateways page`}
                          >
                            <td><strong>{g.gateway_name}</strong></td>
                            <td><CopyableId value={g.sparkplug_id || gatewaySparkplugId(g.gateway_id)} label="Sparkplug edge node id" onNotify={showToast} /></td>
                            <td>
                              {g.is_archived
                                ? <span className="badge badge-warning" style={{ background: 'rgba(255,179,0,0.15)', color: 'var(--warning-text)' }}>DECOMMISSIONED</span>
                                : <StatusBadge status={gatewayLiveStatus(g)} />}
                            </td>
                            <td style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{formatHeartbeat(g.last_heartbeat)}</td>
                            <td><span className="badge badge-neutral">{g.device_count}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {cellAssets.length > 0 && (
                  <div className="table-wrap">
                    {/* Same grid as the gateway table above. The first three columns match exactly;
                        the fourth spans what that table splits between Last Heartbeat and Devices,
                        so every column boundary the eye follows still lines up. */}
                    <table className="cell-card-table">
                      <colgroup>
                        <col style={{ width: '28%' }} />
                        <col style={{ width: '26%' }} />
                        <col style={{ width: '22%' }} />
                        <col style={{ width: '24%' }} />
                      </colgroup>
                      <thead><tr><th title="Device Name">Name</th><th title="Sparkplug B device id">Sparkplug ID</th><th title="Status">Status</th><th title="Connected Edge Gateway">Gateway</th></tr></thead>
                      <tbody>
                        {cellAssets.map(a => {
                          const isOff = a.status === 'OFFLINE'
                          const isArch = a.is_archived
                          return (
                            <tr
                              key={a.asset_id}
                              className="row-selectable"
                              style={{ background: isArch ? 'rgba(255,179,0,0.06)' : undefined }}
                              onClick={rowSelectHandler(() => onSelectDevice?.(a.asset_id))}
                              title={`Open '${a.asset_name}' on the Devices page`}
                            >
                              <td>
                                <strong>{a.asset_name}</strong>
                                {isArch && (
                                  <span className="badge badge-warning" style={{ background: 'rgba(255,179,0,0.15)', color: 'var(--warning-text)', border: '1px solid var(--warning)', marginLeft: '8px' }} title="Decommissioned device">
                                    <IconArchive size={11} /> ARCHIVED
                                  </span>
                                )}
                              </td>
                              <td><CopyableId value={effectiveSparkplugId(a)} label="Sparkplug device id" onNotify={showToast} /></td>
                              <td>
                                {isArch ? (
                                  <span className="badge badge-warning" style={{ background: 'rgba(255,179,0,0.15)', color: 'var(--warning-text)', border: '1px solid var(--warning)', display: 'inline-flex', alignItems: 'center', gap: '4px' }} title="Decommissioned device (Out of Commission)">
                                    <IconArchive size={11} /> ARCHIVED (OUT OF COMMISSION)
                                  </span>
                                ) : (
                                  <span className={`badge ${isOff ? 'badge-neutral' : 'badge-online'}`} title={isOff ? 'Sparkplug B DDEATH Received — Device Offline' : 'Device Active'}>
                                    <span className="badge-dot" style={{ background: isOff ? 'var(--text-muted)' : 'var(--success)' }} />
                                    {isOff ? 'OFFLINE / DDEATH' : 'ONLINE'}
                                  </span>
                                )}
                              </td>
                              <td><span className="mono" style={{ color: 'var(--warning-text)' }} title={a.active_gateway_id || 'No gateway assigned'}>{a.gateway_name || a.active_gateway_id || '—'}</span></td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
              )}
            </div>
          )
        })
      )}

      {showForm && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-title">{editing ? 'Edit Cell' : 'New Cell'}</div>
            <div className="form-group">
              <label className="form-label">Cell Name</label>
              <input className="form-control" value={formVal.cell_name} onChange={e => setFormVal(f => ({ ...f, cell_name: e.target.value }))} placeholder="e.g. Assembly Line 1" title="Enter descriptive cell zone name" />
            </div>
            <div className="form-group">
              {/* A GRID OF BUTTONS, NOT A <select>. The choice is visual -- the whole point is
                  what the card will look like on the map -- and a dropdown of eight words asks
                  the operator to imagine the result instead of showing it. */}
              <label className="form-label">Cell Icon</label>
              <div className="icon-picker" role="radiogroup" aria-label="Cell icon">
                {CELL_ICONS.map(({ key, label, Icon }) => (
                  <button
                    key={key}
                    type="button"
                    role="radio"
                    aria-checked={(formVal.icon || DEFAULT_CELL_ICON) === key}
                    className={`icon-picker-option ${(formVal.icon || DEFAULT_CELL_ICON) === key ? 'is-selected' : ''}`}
                    onClick={() => setFormVal(f => ({ ...f, icon: key }))}
                    title={label}
                  >
                    <Icon size={20} />
                    <span>{label}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Dashboard / UI URL (Optional)</label>
              <input className="form-control" value={formVal.access_url || ''} onChange={e => setFormVal(f => ({ ...f, access_url: e.target.value }))} placeholder="e.g. http://localhost:3002/d/cell-1" title="Enter Grafana dashboard or UI management URL" />
            </div>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setShowForm(false)} disabled={saving} title="Cancel">Cancel</button>
              <ActionButton
                pending={saving}
                // Named for the act, not for the button: creating a cell and editing one are
                // different waits and the operator knows which they asked for.
                pendingLabel={editing ? 'Saving…' : 'Creating…'}
                onClick={() => runSave(save)}
                title="Save cell zone"
              >
                Save
              </ActionButton>
            </div>
          </div>
        </div>
      )}

      {archiveTarget && (
        <ArchiveModal
          entityType="cells" entityId={archiveTarget.cell_id} displayName={archiveTarget.cell_name}
          onArchive={archiveCell} onCancel={() => setArchiveTarget(null)}
        />
      )}

      {docsForCell && (
        <EntityDocumentsModal entityType="cell" entityId={docsForCell.cell_id} entityName={docsForCell.cell_name} onClose={() => { setDocsForCell(null); setDocRefreshKey(k => k + 1) }} showToast={showToast} hasPermission={hasPermission} />
      )}
      </div>

      <ContextPanel
        open={!!selectedCell}
        onClose={() => setSelectedId(null)}
        type="CELL"
        onCopy={showToast}
        title={selectedCell?.cell_name || ''}
        subtitle={selectedCell && (
          <>
            <span className="badge badge-neutral" style={{ fontSize: '11px' }}>
              {selectedCellGateways.length} GW / {selectedCellDevices.length} DEV
            </span>
            {selectedCell.is_archived && <span className="badge badge-warning" style={{ fontSize: '11px' }}>ARCHIVED</span>}
          </>
        )}
        fields={selectedCell ? [
          { label: 'Cell UUID', value: selectedCell.cell_id, mono: true, copyable: true },
          {
            // A COMMA-JOINED STRING BECOMES CHIPS, and the reason is the same one that took the
            // gateway's device list: this drawer named the neighbours and then stranded you. A cell
            // is a junction -- it exists to relate gateways and devices -- so a cell panel that
            // cannot reach either of them is the one panel where dead-ending costs most.
            label: 'Assigned Gateways',
            value: selectedCellGateways.length
              ? (
                <div className="context-device-list">
                  {selectedCellGateways.map(g => (
                    <button
                      key={g.gateway_id}
                      className="chip chip-link chip-gw"
                      onClick={() => onSelectGateway?.(g.gateway_id)}
                      title={`Open ${g.gateway_name} on the Gateways page`}
                    >
                      <IconRadio size={11} />
                      <span className="chip-name">{g.gateway_name}</span>
                    </button>
                  ))}
                </div>
              )
              : null,
            full: true,
            title: 'Edge nodes serving this zone. Their devices resolve here unless a device carries a cell of its own.'
          },
          {
            // THE COUNT IS KEPT, on the label rather than in place of the list. "12 (9 online)" was
            // the whole value before, and it answers a real question -- how big is this zone, and is
            // it healthy -- that twelve chips answer much more slowly. So both: the summary reads at
            // a glance, the chips carry the navigation.
            label: selectedCellDevices.length
              ? `Located Devices (${selectedCellDevices.filter(a => a.status !== 'OFFLINE' && !a.is_archived).length}/${selectedCellDevices.length} online)`
              : 'Located Devices',
            value: selectedCellDevices.length
              ? (
                <div className="context-device-list">
                  {selectedCellDevices.map(d => {
                    const status = deviceLifecycleStatus(d)
                    return (
                      <button
                        key={d.asset_id}
                        className="chip chip-link"
                        onClick={() => onSelectDevice?.(d.asset_id)}
                        title={`Open ${d.asset_name} on the Devices page — ${alertForDevice(alerts, d) ? `ALERT: ${alertForDevice(alerts, d).alert_name}` : deviceStatusTitle(status)}`}
                      >
                        <span className="badge-dot" style={{ background: deviceDotColor(d, alertForDevice(alerts, d)) }} />
                        <span className="chip-name">{d.asset_name}</span>
                      </button>
                    )
                  })}
                </div>
              )
              : null,
            full: true,
            title: "This zone's gateways' devices, plus any device filed here explicitly."
          },
          { label: 'Dashboard URL', value: selectedCell.access_url || null, mono: true, copyable: true, full: true },
        ] : []}
        actions={selectedCell ? [
          selectedCell.access_url && {
            label: 'Open Dashboard', icon: <IconExternalLink size={13} />, href: selectedCell.access_url, primary: true,
            title: 'Open Cell Dashboard / Grafana UI'
          },
          {
            label: 'Edit Details', icon: <IconPencil size={13} />,
            onClick: () => { setEditing(selectedCell); setFormVal(selectedCell); setShowForm(true) },
            disabled: !canManage || selectedCell.is_archived,
            title: !canManage ? 'Requires Admin permissions' : selectedCell.is_archived ? 'Restore this cell before editing it' : 'Edit cell configuration'
          },
          {
            label: 'View Digital Thread', icon: <IconHistory size={13} />,
            onClick: () => onViewThread?.(selectedCell),
            title: 'Open the immutable audit trace for this cell'
          },
          {
            label: 'Manage Documents', icon: <IconBookOpen size={13} />,
            onClick: () => setDocsForCell(selectedCell),
            title: 'Attach or edit external document links for this cell'
          },
          // The last control to leave the card. Archive is not a property of the card in the way
          // the note there once claimed -- it is a thing done to one cell you have chosen, exactly
          // like the four that went before it.
          selectedCell.is_archived ? {
            label: 'Restore Cell', icon: <IconRefreshCw size={13} />,
            onClick: () => runRestore(selectedCell.cell_id, () => restoreCell(selectedCell.cell_id, selectedCell.cell_name)),
            pending: restoringId === selectedCell.cell_id,
            pendingLabel: 'Restoring…',
            disabled: !canArchive,
            title: !canArchive ? 'Requires Admin permissions' : 'Restore cell back to active service'
          } : {
            label: 'Archive Cell', icon: <IconArchive size={13} />,
            onClick: () => setArchiveTarget(selectedCell),
            disabled: !canArchive,
            danger: true,
            title: !canArchive ? 'Requires Admin permissions' : 'Decommission & Archive Cell'
          },
        ].filter(Boolean) : []}
      />

    </div>
  )
}
