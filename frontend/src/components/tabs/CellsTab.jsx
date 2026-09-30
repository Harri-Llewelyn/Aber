import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS, REALTIME_ENABLED, refreshInterval } from '../../constants'
import { requiresRolesTitle } from '../../hooks/usePermissions'
import { usePolling } from '../../hooks/usePolling'
import { useRealtimeTable } from '../../hooks/useRealtimeTable'
import { gatewayLiveStatus, gatewayNeedsAttention } from '../../utils/gatewayStatus'
import { groupDevicesByCell, NON_CELL_SOURCES } from '../../utils/cellResolution'
import CopyableId from '../common/CopyableId'
import { TagList } from '../common/TagList'
import { ActionButton } from '../common/ActionButton'
import { usePendingAction, usePendingKey } from '../../hooks/usePendingAction'
import { ContextPanel, rowSelectHandler } from '../common/ContextPanel'
import { patchFromForm, formFromPatch, submitProposal } from '../../utils/proposeFromForm'
import { CellIcon, CELL_ICONS, DEFAULT_CELL_ICON } from '../../utils/cellIcon'
import { AreaIcon } from '../../utils/areaIcon'
import { formatPlace, isPlaced, MIN_PIN_SPACING_SETTING, DEFAULT_MIN_PIN_SPACING } from '../../utils/areaPlans'
import { useSetting } from '../../hooks/useSettings'
import { CellPlacementPicker } from '../common/CellPlacementPicker'
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
  IconShieldAlert
} from '../common/Icons'
import { CardHeading } from '../common/CardHeading'
import { Badge, ArchivedBadge } from '../common/Badge'
import { SectionCount } from '../common/SectionCount'
import { SearchInput } from '../common/SearchInput'
import { ClearFilters } from '../common/ClearFilters'
import { LoadingState } from '../common/LoadingState'
import { EmptyState } from '../common/EmptyState'
import { Modal } from '../common/Modal'
import { plural } from '../../utils/format'
import { deviceLifecycleStatus, deviceStatusTitle, deviceDotColor } from '../../utils/deviceStatus'
import { alertIndex, alertForDevice } from '../../utils/deviceAlerts'
import { useArrivalSelection } from '../../hooks/useArrivalSelection'

export function CellsTab({ showToast, onSelectDevice, onSelectGateway, onSelectArea, onViewTrail, hasPermission, initialSearchFilter, onClearFilter, activeAlerts = [] }) {
  /** Devices Grafana currently has an alert firing on -- see utils/deviceAlerts.js. */
  const alerts = React.useMemo(() => alertIndex(activeAlerts), [activeAlerts])
  /**
   * A cell handed over from the Site Map arrives as `?search=<cell_id>`. The URL wins over the
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
  const [formError, setFormError] = useState(null)
  const [editing, setEditing]   = useState(null)
  // DEFAULT_CELL_ICON rather than the literal 'Factory': the column's default, the CHECK
  // constraint and this form all have to agree, and one imported constant is one place they can.
  // `area_id` '' is unfiled and `plan_x`/`plan_y` '' is unplaced;
  // api.js turns each into NULL.
  const blank = { cell_name: '', access_url: '', description: '', icon: DEFAULT_CELL_ICON, area_id: '', plan_x: '', plan_y: '' }
  const [formVal, setFormVal]   = useState(blank)
  // The spacing the database enforces between two cells on one plan; the picker refuses earlier.
  const minSpacingSetting = useSetting(MIN_PIN_SPACING_SETTING, DEFAULT_MIN_PIN_SPACING)
  const minSpacing = Number.isFinite(Number(minSpacingSetting)) ? Number(minSpacingSetting) : DEFAULT_MIN_PIN_SPACING
  const [archiveTarget, setArchiveTarget] = useState(null)
  const [linksForCell, setLinksForCell] = useState(null)
  const [filterMode, setFilterMode] = useState('active')
  const [searchQuery, setSearchQuery] = useState(getInitialSearch)
  const [attentionOnly, setAttentionOnly] = useState(false)
  const [emptyOnly, setEmptyOnly] = useState(false)

  // Re-reads on a later hand-over: the tab stays mounted across a Site Map -> Cells -> Site Map
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
      // cell, grouped from `assets` by groupDevicesByCell.
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
  // gateways and devices are watched too: a device moving between gateways changes this page
  // without touching a `cells` row.
  useRealtimeTable(['cells', 'gateways', 'devices', 'areas'], loadAll, { enabled: REALTIME_ENABLED })

  // In-flight state for the form's Save and for the cell being restored from the drawer.
  const [saving, runSave] = usePendingAction()
  const [restoringId, runRestore] = usePendingKey()

  const save = async () => {
    try {
      /* THE FORK IS AT THE END, not at the beginning: the fields, their validation and their null
         handling are shared, and only the last step differs -- by who is asking. */
      // A place is a pair: half of one is none of it.
      const placed = formVal.plan_x !== '' && formVal.plan_y !== '' && formVal.plan_x !== null && formVal.plan_y !== null
      const form = { ...formVal, plan_x: placed ? Number(formVal.plan_x) : '', plan_y: placed ? Number(formVal.plan_y) : '' }
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
    } catch (e) { setFormError(e.message) }
  }

  const openForm = (cell, seed) => {
    setEditing(cell); setFormVal(seed); setFormError(null); setShowForm(true)
  }
  const closeForm = () => { setShowForm(false); setEditingProposal(null) }

  const archiveCell = async (days) => {
    try {
      await api.post(`/api/v1/cells/${archiveTarget.cell_id}/archive`, { auto_delete_days: days })
      // Closed after the request, so ArchiveModal holds its Archiving state for the round trip.
      setArchiveTarget(null); loadAll(); showToast(`Cell '${archiveTarget.cell_name}' archived`, 'success')
    } catch (e) { showToast(e.message, 'error') }
  }

  const restoreCell = async (cellId, name) => {
    try {
      await api.post(`/api/v1/cells/${cellId}/restore`, {})
      loadAll(); showToast(`Cell '${name}' restored to active service`, 'success')
    } catch (e) { showToast(e.message, 'error') }
  }

  // An ID, not the cell object: this page polls, so the selection is resolved against `cells` on
  // every render.
  const [selectedId, setSelectedId] = useState(null)

  const canManage = hasPermission(PERMISSION_UUIDS.CELL_MANAGE)
  const canArchive = hasPermission(PERMISSION_UUIDS.ARCHIVE_MANAGE)
  const canReadTrail = hasPermission(PERMISSION_UUIDS.AUDIT_TRAIL_READ)
  const canPropose = hasPermission(PERMISSION_UUIDS.PROPOSAL_CREATE)

  /* One form, two endings (utils/proposeFromForm.js): for somebody who may not save it, the footer
     files a proposal. Derived rather than stored, so it cannot disagree with the permission. */
  const proposeMode = !canManage && canPropose
  const [editingProposal, setEditingProposal] = useState(null)
  const [openProposals, setOpenProposals] = useState([])

  // Devices that resolve to no cell, surfaced only when that is an unanswered question. Site-Wide
  // and Area-Wide are deliberate answers, and Simulated and Shadow devices cannot be given a cell.
  // `effective_cell_id`, not `cell_id`, which is NULL for every device that inherits.
  const unlinkedDevices = assets.filter(a =>
    !a.is_archived && !a.effective_cell_id && !NON_CELL_SOURCES.has(a.location_source)
  )

  // Cell membership, grouped from the device list this page already holds: a cell's devices are
  // those that resolve to it, which no PostgREST embed can express.
  const devicesByCell = useMemo(() => groupDevicesByCell(assets), [assets])

  const areaOf = (areaId) => areas.find(a => a.area_id === areaId) || null
  const formArea = areaOf(formVal.area_id)

  /** A place belongs to one area's plan, so changing the area clears it. */
  const chooseArea = (areaId) => {
    setFormVal(f => ({ ...f, area_id: areaId, plan_x: '', plan_y: '' }))
  }

  const liveGateways = (c) => (c.gateways || []).filter(g => !g.is_archived)
  const liveDevices = (c) => (devicesByCell.get(c.cell_id) || []).filter(a => !a.is_archived)

  // gatewayNeedsAttention(), not `gatewayLiveStatus(g) !== 'ONLINE'`: PENDING_ENROLLMENT and
  // AWAITING_BIRTH are unfinished tasks, not faults.
  const cellNeedsAttention = (c) =>
    liveGateways(c).some(g => gatewayNeedsAttention(g)) ||
    liveDevices(c).some(a => a.is_quarantined)

  // Either no gateways at all, or gateways serving nothing: usually a provisioning mistake.
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
    (searchQuery ? 1 : 0) + (attentionOnly ? 1 : 0) + (emptyOnly ? 1 : 0) + (filterMode !== 'active' ? 1 : 0)
  // The lifecycle select scopes the list; the count reads scope-size, or `shown / scope` under a filter.
  const inLifecycle = cells.filter(c =>
    filterMode === 'all' || (filterMode === 'archived' ? c.is_archived : !c.is_archived))

  // Arriving from a cell chip or the Site Map with one cell named: open it, and show it whatever
  // its state. Identifier equality only, since the search predicate also matches names.
  useArrivalSelection(
    searchQuery,
    cells,
    (c, term) => c.cell_id === term,
    (c) => {
      if (c.is_archived) setFilterMode('all')
      setSelectedId(c.cell_id)
    }
  )

  // A cell that is deleted resolves to null and the drawer closes itself.
  const selectedCell = cells.find(c => c.cell_id === selectedId) || null
  const selectedCellGateways = selectedCell?.gateways || []
  const selectedCellDevices = selectedCell ? (devicesByCell.get(selectedCell.cell_id) || []) : []

  return (
    <div className="page-layout page-fill">
      <div className="page-main">
      {/* Above the card: a page-level finding, and the first thing worth knowing on arrival. */}
      {unlinkedDevices.length > 0 && (
        <div className="callout callout-warning callout-page">
          <IconShieldAlert size={18} className="callout-icon" />
          <div>
            <strong>{plural(unlinkedDevices.length, 'device')} not linked to any cell:</strong>{' '}
            {unlinkedDevices.slice(0, 5).map(a => a.asset_name).join(', ')}{unlinkedDevices.length > 5 ? ', …' : ''}.
            Set a cell on each device from the Devices page, give its gateway a cell on the Gateways page,
            or mark it Site-Wide or Area-Wide if it belongs to no single cell.
          </div>
        </div>
      )}

      {/* One card, composed as every card is: title, primary action, then the filters that narrow
          what is below. */}
      <div className="card card-fill">
        <CardHeading
          icon={<IconLayoutDashboard size={15} />}
          title="Cells"
          description="A line, bay or group of assets within an area. Gateways belong to a cell, and each cell is placed on its area’s plan."
          count={<SectionCount total={inLifecycle.length} shown={filteredCells.length} />}
          actions={(
            <>
              {/* The primary action in the header, where every card keeps its. */}
              <ActionButton
                className="btn btn-primary btn-sm"
                permitted={canManage}
                deniedTitle={requiresRolesTitle(PERMISSION_UUIDS.CELL_MANAGE)}
                title="Configure new cell"
                onClick={() => openForm(null, blank)}
              >
                <IconPlus size={14} /> New Cell
              </ActionButton>
            </>
          )}
        />

        <div className="card-body">
          <div className="filter-bar">
            {/* Lifecycle is a filter like the rest; the counts are in the option labels. */}
            <select
              className="form-control control-sm"
              value={filterMode}
              onChange={e => setFilterMode(e.target.value)}
              title="Filter by lifecycle state"
              aria-label="Lifecycle"
            >
              <option value="all">All ({cells.length})</option>
              <option value="active">Active ({cells.filter(c => !c.is_archived).length})</option>
              <option value="archived">Archived ({cells.filter(c => c.is_archived).length})</option>
            </select>

            <SearchInput
              value={searchQuery}
              onChange={v => (v ? setSearchQuery(v) : clearSearch())}
              placeholder="Search by Cell UUID or name…"
              ariaLabel="Search cells"
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

            <ClearFilters
              count={activeFilterCount}
              onClear={() => { clearSearch(); setAttentionOnly(false); setEmptyOnly(false); setFilterMode('active') }}
            />
          </div>
        </div>

        {/* One table, not a card per cell: a cell reads as one row and the drawer holds its detail,
            which is what keeps the page scannable at any fleet size. */}
        {loading ? (
          <LoadingState label="cells" />
        ) : filteredCells.length === 0 ? (
          <EmptyState
            icon={<IconLayoutDashboard size={36} />}
            filtered={cells.length > 0}
            message="No cells yet. Add one, then file it in an area."
            filteredMessage="No cells match these filters."
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {/* The cell's own glyph, chosen in the New Cell form. Its header is a
                      screen-reader label, because a 32px column cannot carry a word. */}
                  <th className="cell-icon-col"><span className="sr-only">Icon</span></th>
                  <th title="Human-readable cell name">Cell Name</th>
                  <th title="The ISA-95 area this cell is in, and whether it has a place on that area's plan">Area</th>
                  <th title="The cell's unique UUID">Cell UUID</th>
                  <th title="Edge gateways assigned to this cell">Assigned Gateways</th>
                  <th title="Devices in this cell — its gateways' devices, plus any device filed here explicitly">Devices</th>
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
                      className={`row-selectable${selectedId === c.cell_id ? ' row-selected' : ''}${c.is_archived ? ' row-archived' : ''}`}
                      onClick={rowSelectHandler(() => setSelectedId(id => id === c.cell_id ? null : c.cell_id))}
                      title="Click to inspect this cell in the details panel"
                    >
                      <td className="cell-icon-col"><CellIcon cell={c} size={16} /></td>
                      <td>
                        <strong>{c.cell_name}</strong>
                        {c.description && <div className="cell-meta">{c.description}</div>}
                        {c.is_archived && (
                          <ArchivedBadge size="sm" className="badge-follow" title="Archived: its topics are unchanged" />
                        )}
                        {/* A cell with neither a gateway nor a device is usually half-provisioned,
                            and saying so stops it reading as a failed load. */}
                        {isEmpty && !c.is_archived && (
                          <Badge size="sm" className="badge-follow" title="No gateways and no devices resolve to this cell">Empty</Badge>
                        )}
                      </td>
                      <td>
                        {/* Unfiled is a state to act on, in the queue's colour; a place is context. */}
                        {c.area_id
                          ? <span>{areas.find(a => a.area_id === c.area_id)?.area_name || <span className="mono">{c.area_id}</span>}</span>
                          : <Badge tone="warning" size="sm" title="Not filed in any area — file it on the Areas page or in Edit Details">Unfiled</Badge>}
                        {c.area_id && (
                          <div className="cell-meta">
                            {isPlaced(c)
                              ? <span title={`On the plan: ${formatPlace(c)}`}>placed</span>
                              : <Badge tone="warning" size="sm" title="In the area but not yet placed on its plan — set a place in Edit Details">not placed</Badge>}
                          </div>
                        )}
                      </td>
                      <td><CopyableId value={c.cell_id} label="cell UUID" onNotify={showToast} /></td>
                      <td>
                        {cellGateways.length === 0 ? (
                          <span className="cell-meta">No gateways assigned</span>
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
                              className: `badge badge-sm ${g.is_archived ? 'badge-warning' : 'badge-neutral'}`,
                              title: `${g.gateway_name} — ${g.is_archived ? 'ARCHIVED' : gatewayLiveStatus(g)}`,
                              content: `${g.gateway_name}${g.is_archived ? ' (archived)' : ''}`
                            }))}
                          />
                        )}
                      </td>
                      <td>
                        {cellAssets.length === 0 ? (
                          <span className="cell-meta">No devices here</span>
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
                                className: 'badge badge-sm badge-neutral',
                                title: 'Devices in this cell, by state',
                                content: `${onlineCount} Online / ${offlineCount} Offline`
                              },
                              ...cellAssets.map(a => ({
                                key: a.asset_id,
                                label: a.asset_name,
                                priority: a.is_quarantined,
                                className: `badge badge-sm ${a.is_archived || a.status === 'OFFLINE' ? 'badge-neutral' : 'badge-success'}`,
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
        <Modal
          title={editing ? 'Edit Cell' : 'New Cell'}
          onClose={closeForm}
          error={formError}
          footer={
            <>
              <button className="btn btn-ghost" onClick={closeForm} disabled={saving}>Cancel</button>
              <ActionButton
                pending={saving}
                // Named for the act, not for the button: creating a cell and editing one are
                // different waits and the operator knows which they asked for.
                pendingLabel={proposeMode ? 'Proposing…' : editing ? 'Saving…' : 'Creating…'}
                onClick={() => runSave(save)}
                title={proposeMode
                  ? 'Ask for these changes — an approver applies them, or says why not'
                  : 'Save cell'}
              >
                {proposeMode ? (editingProposal ? 'Update your proposal' : 'Propose a change') : 'Save'}
              </ActionButton>
            </>
          }
        >
          <div className="form-group">
            <label className="form-label">Cell Name</label>
            <input className="form-control" value={formVal.cell_name} onChange={e => setFormVal(f => ({ ...f, cell_name: e.target.value }))} placeholder="e.g. Assembly Line 1" title="The cell's name" />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="cell-description">Description (Optional)</label>
            <input id="cell-description" className="form-control" value={formVal.description || ''} onChange={e => setFormVal(f => ({ ...f, description: e.target.value }))} placeholder="e.g. Five-axis machining, two shifts" title="Shown in the cell's details panel on the Site Map" />
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
          {/* Where the cell is: its area, and a place on that area's plan. An area is a row on
              the Areas page; the place is this cell's own. */}
          <div className="form-group">
            <label className="form-label" htmlFor="cell-area">Area</label>
            <select
              id="cell-area"
              className="form-control"
              value={formVal.area_id || ''}
              onChange={e => chooseArea(e.target.value)}
              title="The ISA-95 area this cell is in. Unfiled cells are listed as a queue on the Areas page."
            >
              <option value="">— Unfiled —</option>
              {areas.map(a => <option key={a.area_id} value={a.area_id}>{a.area_name}</option>)}
            </select>
          </div>
          {formArea && (
            <div className="form-group">
              <label className="form-label">Place on the plan</label>
              <CellPlacementPicker
                area={formArea}
                cells={cells}
                cellId={editing?.cell_id || null}
                cellIcon={formVal.icon}
                value={formVal.plan_x !== '' && formVal.plan_y !== '' && formVal.plan_x !== null && formVal.plan_y !== null
                  ? { x: Number(formVal.plan_x), y: Number(formVal.plan_y) }
                  : null}
                onChange={p => setFormVal(f => ({ ...f, plan_x: p ? p.x : '', plan_y: p ? p.y : '' }))}
                minSpacing={minSpacing}
              />
            </div>
          )}
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
                placeholder="e.g. the cell was renamed on the area plan last month"
              />
            </div>
          )}
        </Modal>
      )}

      {archiveTarget && (
        <ArchiveModal
          entityId={archiveTarget.cell_id} displayName={archiveTarget.cell_name}
          onArchive={archiveCell} onCancel={() => setArchiveTarget(null)}
        />
      )}

      {linksForCell && (
        <EntityLinksModal entityType="cell" entityId={linksForCell.cell_id} entityName={linksForCell.cell_name} onClose={() => setLinksForCell(null)} showToast={showToast} hasPermission={hasPermission} />
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
            <Badge size="sm">{plural(selectedCellGateways.length, 'Gateway')} · {plural(selectedCellDevices.length, 'Device')}</Badge>
            {selectedCell.is_archived && <ArchivedBadge size="sm" />}
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
          {
            label: 'Place on plan',
            value: selectedCell.area_id ? (formatPlace(selectedCell) || 'Not placed — set a place in Edit Details') : null,
            title: "Where the Site Map draws this cell on its area's plan, as fractions of the plan"
          },
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
            title: 'Edge nodes serving this cell. Their devices resolve here unless a device carries a cell of its own.'
          },
          {
            // The count stays on the label: how big is this cell and is it healthy reads at a
            // glance, and the chips carry the navigation.
            label: selectedCellDevices.length
              ? `Devices (${selectedCellDevices.filter(a => a.status !== 'OFFLINE' && !a.is_archived).length}/${selectedCellDevices.length} online)`
              : 'Devices',
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
            title: "This cell's gateways' devices, plus any device filed here explicitly."
          },
          { label: 'Dashboard URL', value: selectedCell.access_url || null, mono: true, copyable: true, full: true },
          // The purge timer.
          selectedCell.is_archived && {
            label: 'Retention',
            value: selectedCell.auto_delete_at
              ? `Auto-purges on ${new Date(selectedCell.auto_delete_at).toLocaleDateString()}`
              : 'Permanent — no auto-purge scheduled',
            full: true,
            title: 'What happens to this archived cell and when'
          },
        ].filter(Boolean) : []}
        actions={selectedCell ? [
          selectedCell.access_url && {
            label: 'Open Dashboard', icon: <IconExternalLink size={13} />, href: selectedCell.access_url, primary: true,
            title: 'Open the cell dashboard or UI'
          },
          {
            label: proposeMode ? 'Propose a Change' : 'Edit Details', icon: <IconPencil size={13} />,
            onClick: () => {
              // Seeded with the open proposal's patch when there is one: one open proposal per
              // asset per person, so a second field extends the request.
              const mine = proposeMode
                ? openProposals.find(pr => pr.entity_type === 'cells' && pr.entity_id === selectedCell.cell_id)
                : null
              setEditingProposal(mine || null)
              openForm(selectedCell, {
                ...selectedCell,
                // The selects and the picker want '' for nothing, not null.
                area_id: selectedCell.area_id || '',
                plan_x: selectedCell.plan_x ?? '',
                plan_y: selectedCell.plan_y ?? '',
                ...formFromPatch('cell', mine?.patch)
              })
            },
            disabled: (!canManage && !canPropose) || selectedCell.is_archived,
            title: selectedCell.is_archived
              ? 'Restore this cell before editing it'
              : proposeMode
                ? 'Ask for a change to this cell — an approver applies it, or says why not'
                : !canManage && !canPropose
                  ? requiresRolesTitle(PERMISSION_UUIDS.CELL_MANAGE)
                  : 'Edit cell configuration'
          },
          /* Withheld from a reader who may not open the page: the nav hides Audit Trail without
             `audit_trail:read`. `.filter(Boolean)` drops it. */
          canReadTrail && {
            label: 'View Audit Trail', icon: <IconHistory size={13} />,
            onClick: () => onViewTrail?.(selectedCell),
            title: 'Open the immutable audit trace for this cell'
          },
          {
            label: 'Attached Links', icon: <IconBookOpen size={13} />,
            onClick: () => setLinksForCell(selectedCell),
            title: 'Attach or edit links for this cell — documents, an asset register, a file repository, any URL'
          },
          // Archive is a thing done to one cell you have chosen, like the actions before it.
          selectedCell.is_archived ? {
            label: 'Restore Cell', icon: <IconRefreshCw size={13} />,
            onClick: () => runRestore(selectedCell.cell_id, () => restoreCell(selectedCell.cell_id, selectedCell.cell_name)),
            pending: restoringId === selectedCell.cell_id,
            pendingLabel: 'Restoring…',
            disabled: !canArchive,
            title: !canArchive ? requiresRolesTitle(PERMISSION_UUIDS.ARCHIVE_MANAGE) : 'Restore cell back to active service'
          } : {
            label: 'Archive Cell', icon: <IconArchive size={13} />,
            onClick: () => setArchiveTarget(selectedCell),
            disabled: !canArchive,
            danger: true,
            title: !canArchive ? requiresRolesTitle(PERMISSION_UUIDS.ARCHIVE_MANAGE) : 'Archive Cell'
          },
        ].filter(Boolean) : []}
      />

    </div>
  )
}
