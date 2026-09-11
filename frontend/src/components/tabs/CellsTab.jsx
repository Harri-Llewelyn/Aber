import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS, REALTIME_ENABLED, refreshInterval } from '../../constants'
import { usePolling } from '../../hooks/usePolling'
import { useRealtimeTable } from '../../hooks/useRealtimeTable'
import { gatewayLiveStatus, gatewayNeedsAttention } from '../../utils/gatewayStatus'
import { groupDevicesByCell, NON_CELL_SOURCES, floorLabel } from '../../utils/cellResolution'
import CopyableId from '../common/CopyableId'
import { TagList } from '../common/TagList'
import { ActionButton } from '../common/ActionButton'
import { usePendingAction, usePendingKey } from '../../hooks/usePendingAction'
import { ContextPanel, rowSelectHandler } from '../common/ContextPanel'
import { patchFromForm, formFromPatch, submitProposal } from '../../utils/proposeFromForm'
import { CellIcon, CELL_ICONS, DEFAULT_CELL_ICON } from '../../utils/cellIcon'
import { AreaIcon } from '../../utils/areaIcon'
import { ArchiveModal } from '../modals/ArchiveModal'
import { EntityLinksModal } from '../modals/EntityLinksModal'
import {
  IconLayoutDashboard,
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
import { HelpTip } from '../common/HelpTip'
import { deviceLifecycleStatus, deviceStatusTitle, deviceDotColor } from '../../utils/deviceStatus'
import { alertIndex, alertForDevice } from '../../utils/deviceAlerts'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { useArrivalSelection } from '../../hooks/useArrivalSelection'

export function CellsTab({ showToast, onSelectDevice, onSelectGateway, onSelectArea, onViewThread, hasPermission, initialSearchFilter, onClearFilter, activeAlerts = [] }) {
  /** Devices Grafana currently has an alert firing on -- see utils/deviceAlerts.js (issue #34). */
  const alerts = React.useMemo(() => alertIndex(activeAlerts), [activeAlerts])
  /**
   * A cell handed over from the Overview map arrives as `?search=<cell_id>`. The URL wins over the
   * prop and both are read, as on Gateways and Devices. The search predicate already matches
   * cell_id or cell_name.
   */
  const getInitialSearch = () => {
    const params = new URLSearchParams(window.location.search)
    return params.get('search') || initialSearchFilter || ''
  }

  const [cells, setCells]       = useState([])
  const [areas, setAreas]       = useState([])
  const [assets, setAssets]     = useState([])
  const [loading, setLoading]   = useState(true)
  const [showForm, setShowForm] = useState(false)
  // See GatewaysTab: an inline modal is still a modal, and Escape has to close it.
  useEscapeKey(() => setShowForm(false), showForm)
  const [editing, setEditing]   = useState(null)
  // DEFAULT_CELL_ICON rather than the literal 'Factory': the column's default, the CHECK
  // constraint and this form all have to agree, and one imported constant is one place they can.
  // `area_id` '' is unfiled and `floor` '' is unset; api.js turns both into NULL.
  const blank = { cell_name: '', access_url: '', description: '', icon: DEFAULT_CELL_ICON, area_id: '', floor: '' }
  const [formVal, setFormVal]   = useState(blank)
  const [archiveTarget, setArchiveTarget] = useState(null)
  const [docsForCell, setDocsForCell] = useState(null)
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
   * Clearing the search also strips `?search=` from the address bar and releases the lifted filter
   * in App, so a reload or Back does not reapply it.
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
      // /api/v1/cells embeds each cell's gateways only. Device membership is the resolved effective
      // cell, grouped from `assets` by groupDevicesByCell and read once for the cards and the
      // unassigned counter.
      const [c, a, ar] = await Promise.all([
        api.get('/api/v1/cells', { signal }),
        api.get('/api/v1/devices', { signal }),
        api.get('/api/v1/areas', { signal }).catch(() => [])
      ])
      setCells(c); setAssets(a); setAreas(ar)

      /* This person's open proposals, so the edit dialog can seed itself with an open patch rather
         than replace it. Tolerated rather than required. */
      try {
        const proposals = await api.get('/api/v1/proposals', { signal })
        setOpenProposals((proposals || []).filter(pr => pr.status === 'open'))
      } catch (pErr) {
        if (pErr.name !== 'AbortError') setOpenProposals([])
      }
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
  // gateways and devices are watched too: a cell's contents come from the embed, so a device moving
  // between gateways changes this page without touching a `cells` row.
  useRealtimeTable(['cells', 'gateways', 'devices'], loadAll, { enabled: REALTIME_ENABLED })

  // In-flight state for the form's Save and for whichever row is restoring. See
  // hooks/usePendingAction.js for why the row list needs a key rather than a second boolean.
  const [saving, runSave] = usePendingAction()
  const [restoringId, runRestore] = usePendingKey()

  const save = async () => {
    try {
      /* THE FORK IS AT THE END, not at the beginning: the fields, their validation and their null
         handling are shared, and only the last step differs -- by who is asking. */
      // The floor arrives from a number input as text; the column is an integer, and a proposal
      // carrying "2" against a row holding 2 would read as a change that changes nothing.
      const floor = formVal.floor === '' || formVal.floor === null || formVal.floor === undefined ? '' : Number(formVal.floor)
      const form = { ...formVal, floor }
      if (proposeMode) {
        if (!editing) throw new Error('A cell can only be created by an Administrator.')
        const patch = patchFromForm('cell', editing, form)
        await submitProposal({
          kind: 'cell', entityId: editing.cell_id, patch,
          rationale: formVal.__rationale, proposalId: editingProposal?.id
        })
        setShowForm(false); setEditingProposal(null); loadAll()
        showToast(editingProposal
          ? 'Your proposal was updated. An approver decides from here.'
          : 'Proposed. An approver applies it, or says why not.', 'success')
        return
      }

      if (editing) await api.put(`/api/v1/cells/${editing.cell_id}`, form)
      else         await api.post('/api/v1/cells', form)
      setShowForm(false); loadAll(); showToast(editing ? 'Cell saved' : 'Cell created', 'success')
    } catch (e) { showToast(e.message, 'error') }
  }

  const archiveCell = async (days) => {
    try {
      await api.post(`/api/v1/cells/${archiveTarget.cell_id}/archive`, { auto_delete_days: days })
      // Closed after the request rather than before, so ArchiveModal holds its Archiving state for
      // the whole round trip.
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
  const canReadThread = hasPermission(PERMISSION_UUIDS.DIGITAL_THREAD_READ)
  const canPropose = hasPermission(PERMISSION_UUIDS.PROPOSAL_CREATE)

  /* One form, two endings (utils/proposeFromForm.js): for somebody who may not save it, the footer
     files a proposal. Derived rather than stored, so it cannot disagree with the permission. */
  const proposeMode = !canManage && canPropose
  const [editingProposal, setEditingProposal] = useState(null)
  const [openProposals, setOpenProposals] = useState([])

  // Devices that resolve to no cell, surfaced only when that is an unanswered question. Site-Wide
  // is excluded as a deliberate answer; Simulated and Shadow are excluded because
  // `gateways_synthetic_has_no_cell` refuses the only remedy. `effective_cell_id`, not `cell_id`,
  // which is NULL for every device that inherits.
  const unlinkedDevices = assets.filter(a =>
    !a.is_archived && !a.effective_cell_id && !NON_CELL_SOURCES.has(a.location_source)
  )

  // Cell membership, grouped from the device list this page already holds: a cell's devices are
  // those that resolve to it, which no PostgREST embed can express.
  const devicesByCell = useMemo(() => groupDevicesByCell(assets), [assets])

  const liveGateways = (c) => (c.gateways || []).filter(g => !g.is_archived)
  const liveDevices = (c) => (devicesByCell.get(c.cell_id) || []).filter(a => !a.is_archived)

  // gatewayNeedsAttention(), not `gatewayLiveStatus(g) !== 'ONLINE'`: PENDING_ENROLLMENT and
  // AWAITING_BIRTH are unfinished tasks, not faults.
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

  // Arriving from a Cell Zone chip or the site map with one cell named: open it. Identifier
  // equality only, since the search predicate also matches names.
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
      {/* Above the card: a page-level finding, and the first thing worth knowing on arrival. */}
      {unlinkedDevices.length > 0 && (
        <div style={{ marginBottom: 'var(--stack)', background: 'rgba(255,179,0,0.08)', border: '1px solid var(--warning)', borderRadius: 'var(--radius)', padding: '10px var(--inset)', fontSize: '13px', color: 'var(--warning-text)', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <IconShieldAlert size={18} />
          <div>
            <strong>{unlinkedDevices.length} device{unlinkedDevices.length === 1 ? '' : 's'} not linked to any cell zone:</strong>{' '}
            {unlinkedDevices.slice(0, 5).map(a => a.asset_name).join(', ')}{unlinkedDevices.length > 5 ? ', …' : ''}.
            Set a cell on each device from the Devices page, give its gateway a cell on the Gateways page,
            or mark it Site-Wide if it belongs to no single cell.
          </div>
        </div>
      )}

      {/* One card, composed as every card is: title, primary action, then the filters that narrow
          what is below. */}
      <div className="card">
        <div className="card-header">
          <h3 className="section-title">
            Cells
            <HelpTip
              label="About cells"
              text="A cell is a zone of an Area and what groups the assets in it. A gateway belongs to one, and a device inherits its gateway's unless it names its own. The dashboard, the alerts and the Grafana folders are all organised by cell."
            />
          </h3>
          {/* The primary action in the header, where every card keeps its. */}
          <button
            className={`btn btn-primary btn-sm ${!canManage ? 'btn-disabled' : ''}`}
            style={{ marginLeft: 'auto' }}
            disabled={!canManage}
            onClick={() => canManage && (setEditing(null), setFormVal(blank), setShowForm(true))}
            title={!canManage ? 'Requires Admin permissions' : 'Configure new cell'}
          >
            <IconPlus size={14} /> New Cell
          </button>
        </div>

        <div className="card-body">
      <div className="filter-bar">
        {/* Lifecycle is a filter like the rest; the counts are in the option labels. */}
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

      </div>

        </div>{/* .card-body */}

      {/* One table, not a card per cell: a cell reads as one row and the drawer holds its detail,
          which is what keeps the page scannable at any fleet size. */}
        {loading ? (
          <div className="loading-wrap"><div className="spinner" /> Loading cells…</div>
        ) : filteredCells.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon"><IconLayoutDashboard size={36} /></div>
            <div className="empty-text">No cells match the selected filter.</div>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {/* The cell's own glyph, chosen in the New Cell form. Its header is a
                      screen-reader label, because a 32px column cannot carry a word. */}
                  <th className="cell-icon-col"><span className="sr-only">Icon</span></th>
                  <th title="Human-readable cell zone name">Cell Name</th>
                  <th title="The ISA-95 area (area) and floor this cell is on">Area / Floor</th>
                  <th title="Cell zone unique UUID">Cell UUID</th>
                  <th title="Edge gateways assigned to this cell zone">Assigned Gateways</th>
                  <th title="Devices located in this cell — its gateways' devices, plus any device filed here explicitly">Assigned Devices</th>
                </tr>
              </thead>
              <tbody>
                {filteredCells.map(c => {
                  const cellGateways = c.gateways || []
                  // Devices that RESOLVE to this cell, not those merely reachable through its
                  // gateways -- see groupDevicesByCell.
                  const cellAssets = devicesByCell.get(c.cell_id) || []
                  const onlineCount = cellAssets.filter(a => (a.status === 'ONLINE' || !a.status) && !a.is_archived).length
                  const offlineCount = cellAssets.filter(a => a.status === 'OFFLINE' && !a.is_archived).length
                  const isEmpty = cellGateways.length === 0 && cellAssets.length === 0

                  return (
                    <tr
                      key={c.cell_id}
                      className={`row-selectable${selectedId === c.cell_id ? ' row-selected' : ''}`}
                      style={{ background: c.is_archived ? 'rgba(255,179,0,0.06)' : undefined }}
                      onClick={rowSelectHandler(() => setSelectedId(id => id === c.cell_id ? null : c.cell_id))}
                      title="Click to inspect this cell in the details panel"
                    >
                      <td className="cell-icon-col"><CellIcon cell={c} size={16} /></td>
                      <td>
                        <strong>{c.cell_name}</strong>
                        {c.description && <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{c.description}</div>}
                        {c.is_archived && (
                          <span className="badge badge-warning" style={{ background: 'rgba(255,179,0,0.15)', color: 'var(--warning-text)', border: '1px solid var(--warning)', marginLeft: '8px', display: 'inline-flex', alignItems: 'center', gap: '4px' }} title="Cell decommissioned and archived">
                            <IconArchive size={11} /> ARCHIVED
                          </span>
                        )}
                        {/* A zone with neither a gateway nor a device is usually half-provisioned,
                            and saying so stops it reading as a failed load. */}
                        {isEmpty && !c.is_archived && (
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontStyle: 'italic', marginLeft: '8px' }} title="No gateways and no devices resolve to this cell">empty</span>
                        )}
                      </td>
                      <td>
                        {/* Unfiled is a state to act on, said in the queue's colour; the floor is
                            context and stays muted. */}
                        {c.area_id
                          ? <span>{areas.find(a => a.area_id === c.area_id)?.area_name || <span className="mono">{c.area_id}</span>}</span>
                          : <span style={{ fontSize: '11px', color: 'var(--warning-text)', fontStyle: 'italic' }} title="Not filed in any area — file it on the Areas page or in Edit Details">Unfiled</span>}
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{floorLabel(c.floor)}</div>
                      </td>
                      <td><CopyableId value={c.cell_id} label="cell UUID" onNotify={showToast} /></td>
                      <td>
                        {cellGateways.length === 0 ? (
                          <span style={{ fontSize: '11px', color: 'var(--text-dim)', fontStyle: 'italic' }}>No gateways assigned</span>
                        ) : (
                          /* Collapsed past three, as the Gateways page's device column is. An
                             archived gateway is pinned: it explains a cell whose devices have gone
                             quiet. */
                          <TagList
                            limit={3}
                            tags={cellGateways.map(g => ({
                              key: g.gateway_id,
                              // The overflow tooltip reads names; these are keyed by UUID.
                              label: g.gateway_name,
                              priority: g.is_archived,
                              className: `badge ${g.is_archived ? 'badge-warning' : 'badge-neutral'}`,
                              style: { fontSize: '11px' },
                              title: `${g.gateway_name} — ${g.is_archived ? 'DECOMMISSIONED' : gatewayLiveStatus(g)}`,
                              content: `${g.gateway_name}${g.is_archived ? ' (archived)' : ''}`
                            }))}
                          />
                        )}
                      </td>
                      <td>
                        {cellAssets.length === 0 ? (
                          <span style={{ fontSize: '11px', color: 'var(--text-dim)', fontStyle: 'italic' }}>No devices located here</span>
                        ) : (
                          /* The same shape as Connected Devices on the Gateways page. The Online /
                             Offline summary is pinned because it is what the column answers; a
                             quarantined device is pinned because it calls for action. */
                          <TagList
                            limit={3}
                            tags={[
                              {
                                key: '__summary__',
                                priority: true,
                                className: 'badge badge-neutral',
                                title: 'Located devices breakdown',
                                content: `${onlineCount} Online / ${offlineCount} Offline`
                              },
                              ...cellAssets.map(a => ({
                                key: a.asset_id,
                                label: a.asset_name,
                                priority: a.is_quarantined,
                                className: `badge ${a.is_archived || a.status === 'OFFLINE' ? 'badge-neutral' : 'badge-online'}`,
                                style: { fontSize: '11px' },
                                title: `${a.asset_name} — ${a.is_archived ? 'ARCHIVED' : a.is_quarantined ? 'QUARANTINED' : a.status || 'ONLINE'}`,
                                content: `${a.asset_name}${a.is_quarantined ? ' (quarantined)' : ''}${a.is_archived ? ' (archived)' : ''}`
                              }))
                            ]}
                          />
                        )}
                      </td>
                    </tr>
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
            <div className="modal-title">{editing ? 'Edit Cell' : 'New Cell'}</div>
            <div className="form-group">
              <label className="form-label">Cell Name</label>
              <input className="form-control" value={formVal.cell_name} onChange={e => setFormVal(f => ({ ...f, cell_name: e.target.value }))} placeholder="e.g. Assembly Line 1" title="Enter descriptive cell zone name" />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="cell-description">Description (Optional)</label>
              <input id="cell-description" className="form-control" value={formVal.description || ''} onChange={e => setFormVal(f => ({ ...f, description: e.target.value }))} placeholder="e.g. Five-axis machining, two shifts" title="Shown as a help tip beside the cell's name on the Overview map" />
            </div>
            <div className="form-group">
              {/* A grid of buttons, not a select: the choice is visual. */}
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
            {/* Where the cell is in the area hierarchy. The area is a row on the Areas page;
                the floor is a number on this cell and groups the Overview map. */}
            <div className="form-group">
              <label className="form-label" htmlFor="cell-area">Area</label>
              <select
                id="cell-area"
                className="form-control"
                value={formVal.area_id || ''}
                onChange={e => setFormVal(f => ({ ...f, area_id: e.target.value }))}
                title="The ISA-95 area this cell is in. Unfiled cells are listed as a queue on the Areas page."
              >
                <option value="">— Unfiled —</option>
                {areas.map(a => <option key={a.area_id} value={a.area_id}>{a.area_name}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="cell-floor">Floor</label>
              <input
                id="cell-floor"
                type="number"
                step="1"
                className="form-control"
                style={{ width: '120px' }}
                value={formVal.floor ?? ''}
                onChange={e => setFormVal(f => ({ ...f, floor: e.target.value }))}
                placeholder="0"
                title="Ground floor is 0, the first floor 1, a basement -1. Leave empty if it does not apply."
              />
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
                Ground is 0, basements are negative. {floorLabel(formVal.floor === '' || formVal.floor === null || formVal.floor === undefined ? undefined : Number(formVal.floor))}.
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Dashboard / UI URL (Optional)</label>
              <input className="form-control" value={formVal.access_url || ''} onChange={e => setFormVal(f => ({ ...f, access_url: e.target.value }))} placeholder="e.g. http://localhost:3002/d/cell-1" title="Enter Grafana dashboard or UI management URL" />
            </div>
            {/* The rationale, only when proposing: it is written to an approver who has not stood
                in the cell. */}
            {proposeMode && (
              <div className="form-group">
                <label className="form-label" htmlFor="cell-propose-rationale">Why (optional)</label>
                <textarea
                  id="cell-propose-rationale"
                  className="form-control"
                  rows={2}
                  value={formVal.__rationale || ''}
                  onChange={e => setFormVal(f => ({ ...f, __rationale: e.target.value }))}
                  placeholder="e.g. the cell was renamed on the floor plan last month"
                />
              </div>
            )}

            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => { setShowForm(false); setEditingProposal(null) }} disabled={saving} title="Cancel">Cancel</button>
              <ActionButton
                pending={saving}
                // Named for the act, not for the button: creating a cell and editing one are
                // different waits and the operator knows which they asked for.
                pendingLabel={proposeMode ? 'Proposing…' : editing ? 'Saving…' : 'Creating…'}
                onClick={() => runSave(save)}
                title={proposeMode
                  ? 'Ask for these changes — an approver applies them, or says why not'
                  : 'Save cell zone'}
              >
                {proposeMode ? (editingProposal ? 'Update your proposal' : 'Propose a change') : 'Save'}
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
        <EntityLinksModal entityType="cell" entityId={docsForCell.cell_id} entityName={docsForCell.cell_name} onClose={() => setDocsForCell(null)} showToast={showToast} hasPermission={hasPermission} />
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
          { label: 'Description', value: selectedCell.description || null, full: true },
          {
            label: 'Area',
            value: selectedCell.area_id
              ? (
                <button
                  className="chip chip-link"
                  onClick={() => onSelectArea?.(selectedCell.area_id)}
                  title="Open this area on the Areas page"
                >
                  <AreaIcon area={areas.find(a => a.area_id === selectedCell.area_id)} size={11} />
                  <span className="chip-name">{areas.find(a => a.area_id === selectedCell.area_id)?.area_name || selectedCell.area_id}</span>
                </button>
              )
              : 'Unfiled',
            title: 'The ISA-95 area this cell is in. Its devices derive their area from it.'
          },
          { label: 'Floor', value: floorLabel(selectedCell.floor), title: 'Ground floor is 0, basements negative' },
          {
            // Chips rather than a comma-joined string: a cell is a junction, and its panel must
            // reach the gateways and devices it relates.
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
            // The count stays on the label: how big is this zone and is it healthy reads at a
            // glance, and the chips carry the navigation.
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
          // The purge timer, the one fact from the old card body that lives nowhere else.
          selectedCell.is_archived && {
            label: 'Retention',
            value: selectedCell.auto_delete_at
              ? `Auto-purges on ${new Date(selectedCell.auto_delete_at).toLocaleDateString()}`
              : 'Permanent — no auto-purge scheduled',
            full: true,
            title: 'What happens to this decommissioned cell and when'
          },
        ].filter(Boolean) : []}
        actions={selectedCell ? [
          selectedCell.access_url && {
            label: 'Open Dashboard', icon: <IconExternalLink size={13} />, href: selectedCell.access_url, primary: true,
            title: 'Open Cell Dashboard / Grafana UI'
          },
          {
            label: proposeMode ? 'Propose a Change' : 'Edit Details', icon: <IconPencil size={13} />,
            onClick: () => {
              setEditing(selectedCell)
              // Seeded with the open proposal's patch when there is one: one open proposal per
              // asset per person, so a second field extends the request.
              const mine = proposeMode
                ? openProposals.find(pr => pr.entity_type === 'cells' && pr.entity_id === selectedCell.cell_id)
                : null
              setEditingProposal(mine || null)
              setFormVal({
                ...selectedCell,
                // The selects and the number input want '' for nothing, not null.
                area_id: selectedCell.area_id || '',
                floor: selectedCell.floor ?? '',
                ...formFromPatch('cell', mine?.patch)
              })
              setShowForm(true)
            },
            disabled: (!canManage && !canPropose) || selectedCell.is_archived,
            title: selectedCell.is_archived
              ? 'Restore this cell before editing it'
              : proposeMode
                ? 'Ask for a change to this cell — an approver applies it, or says why not'
                : !canManage && !canPropose
                  ? 'Requires Admin permissions'
                  : 'Edit cell configuration'
          },
          /* Withheld from a reader who may not open the page: the nav hides Digital Thread without
             `digital_thread:read`. `.filter(Boolean)` drops it. */
          canReadThread && {
            label: 'View Digital Thread', icon: <IconHistory size={13} />,
            onClick: () => onViewThread?.(selectedCell),
            title: 'Open the immutable audit trace for this cell'
          },
          {
            label: 'Manage Links', icon: <IconBookOpen size={13} />,
            onClick: () => setDocsForCell(selectedCell),
            title: 'Attach or edit links for this cell — documents, an asset register, a file repository, any URL'
          },
          // Archive is a thing done to one cell you have chosen, like the actions before it.
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
