import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS, REALTIME_ENABLED, refreshInterval } from '../../constants'
import { usePolling } from '../../hooks/usePolling'
import { useRealtimeTable } from '../../hooks/useRealtimeTable'
import { gatewayLiveStatus, gatewayNeedsAttention } from '../../utils/gatewayStatus'
import { groupDevicesByCell, SOURCE_SITE_WIDE } from '../../utils/cellResolution'
import CopyableId from '../common/CopyableId'
import { TagList } from '../common/TagList'
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
import { deviceLifecycleStatus, deviceStatusTitle, deviceDotColor } from '../../utils/deviceStatus'
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

      {/* ONE TABLE, NOT A CARD PER CELL (issue #61).
          Every cell rendered a card carrying its own header plus two full sub-tables -- gateways
          with Sparkplug ID, status and heartbeat; devices with Sparkplug ID, status and gateway --
          so three cells filled the viewport and the page could not be scanned at all. That detail
          was already duplicated: the context drawer this page has carried since the actions moved
          off the cards holds the UUID, both membership lists as linking chips, and every action.

          So the card body is GONE rather than relocated, and what is left is the shape the other
          two asset pages use. A cell now reads as one row, and the drawer is where its detail
          lives -- which is what makes Gateways and Devices scannable at any fleet size. */}
      <div className="card">
        {loading ? (
          <div className="loading-wrap"><div className="spinner" /> Loading shopfloor cells…</div>
        ) : filteredCells.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon"><IconFactory size={36} /></div>
            <div className="empty-text">No shopfloor cells match the selected filter.</div>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {/* The icon is the cell's own glyph, chosen in the New Cell form and until now
                      visible only on the shopfloor map. It is what makes a row recognisable at a
                      glance in a list where every other column is text. Its header is a screen
                      reader label rather than a word: a 32px column cannot carry one, and a blank
                      `th` announces as nothing at all. */}
                  <th className="cell-icon-col"><span className="sr-only">Icon</span></th>
                  <th title="Human-readable cell zone name">Cell Name</th>
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
                        {c.is_archived && (
                          <span className="badge badge-warning" style={{ background: 'rgba(255,179,0,0.15)', color: 'var(--warning-text)', border: '1px solid var(--warning)', marginLeft: '8px', display: 'inline-flex', alignItems: 'center', gap: '4px' }} title="Cell decommissioned and archived">
                            <IconArchive size={11} /> ARCHIVED
                          </span>
                        )}
                        {/* Kept from the card header. A zone with neither a gateway nor a device is
                            usually half-provisioned, and saying so on the row is what stops it
                            reading as a cell whose contents merely failed to load. */}
                        {isEmpty && !c.is_archived && (
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontStyle: 'italic', marginLeft: '8px' }} title="No gateways and no devices resolve to this cell">empty</span>
                        )}
                      </td>
                      <td><CopyableId value={c.cell_id} label="cell UUID" onNotify={showToast} /></td>
                      <td>
                        {cellGateways.length === 0 ? (
                          <span style={{ fontSize: '11px', color: 'var(--text-dim)', fontStyle: 'italic' }}>No gateways assigned</span>
                        ) : (
                          /* Collapsed past three, as the Gateways page's device column is: the
                             count grows with the fleet rather than with a fixed vocabulary, so an
                             uncollapsed list makes the row's height unbounded -- which is the
                             failure this issue is about.

                             AN ARCHIVED GATEWAY IS PINNED. It is the entry that explains a cell
                             whose devices have gone quiet, and it would otherwise be the first
                             thing hidden behind a "+N". */
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
                          /* THE SAME SHAPE AS Connected Devices ON THE GATEWAYS PAGE, deliberately:
                             it answers the same question about a different container, and two
                             columns that mean the same thing should not have to be learned twice.

                             The Online/Offline summary is pinned because it is what the column
                             exists to answer -- hiding it behind a "+N" would defeat it -- and a
                             quarantined device is pinned because it is the one entry that calls
                             for action. */
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
        <EntityDocumentsModal entityType="cell" entityId={docsForCell.cell_id} entityName={docsForCell.cell_name} onClose={() => setDocsForCell(null)} showToast={showToast} hasPermission={hasPermission} />
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
          // MOVED OFF THE CARD RATHER THAN DROPPED (issue #61). The card body carried a banner on
          // every archived cell saying whether a purge timer was running and when it fires; the
          // body is gone, and this is the one fact in it that lives nowhere else. A retention
          // deadline is not something to discover by its passing.
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
