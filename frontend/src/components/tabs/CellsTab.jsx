import React, { useState, useCallback, useMemo } from 'react'
import { RouteLink } from '../common/RouteLink'
import { areaUrl, cellUrl, deviceUrl, devicesInCellUrl, gatewayUrl, trailUrl } from '../../routes'
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
import { patchFromForm, formFromPatch, submitProposal, proposalNotice } from '../../utils/proposeFromForm'
import { CellIcon, CELL_ICONS, DEFAULT_CELL_ICON } from '../../utils/cellIcon'
import { AreaIcon } from '../../utils/areaIcon'
import { isPlaced, MIN_PIN_SPACING_SETTING, DEFAULT_MIN_PIN_SPACING } from '../../utils/areaPlans'
import { useSetting } from '../../hooks/useSettings'
import { CellPlacementPicker } from '../common/CellPlacementPicker'
import { ExpandablePlanPreview } from '../common/AreaPlanPreview'
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
  IconCpu
} from '../common/Icons'
import { CardHeading } from '../common/CardHeading'
import { Badge, ArchivedBadge } from '../common/Badge'
import { SearchInput } from '../common/SearchInput'
import { SortHeader } from '../common/SortHeader'
import { ClearFilters } from '../common/ClearFilters'
import { LoadingState } from '../common/LoadingState'
import { EmptyState } from '../common/EmptyState'
import { Modal } from '../common/Modal'
import { plural } from '../../utils/format'
import { deviceLifecycleStatus, deviceStatusTitle, deviceDotColor, deviceColumnTags, devicesOnlineLabel } from '../../utils/deviceStatus'
import { inServiceDevices, inServiceGateways } from '../../utils/inService'
import { alertIndex, alertForDevice } from '../../utils/deviceAlerts'
import { useArrivalSelection } from '../../hooks/useArrivalSelection'
import { useUrlState } from '../../hooks/useUrlState'
import { useSortableRows } from '../../hooks/useTableSort'
import { Tooltip } from '../common/Tooltip'

export function CellsTab({ showToast, onSelectDevice, onSelectGateway, onSelectArea, onViewTrail, onShowOnSiteMap, hasPermission, activeAlerts = [] }) {
  /** Devices Grafana currently has an alert firing on -- see utils/deviceAlerts.js. */
  const alerts = React.useMemo(() => alertIndex(activeAlerts), [activeAlerts])
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
  // The filters are query parameters. A cell handed over from another page arrives as
  // `?search=<cell_id>`; the search predicate matches cell_id or cell_name.
  const [filterMode, setFilterMode] = useUrlState('lifecycle', 'active', { allowed: ['all', 'active', 'archived'] })
  const [searchQuery, setSearchQuery] = useUrlState('search')
  const [attentionOnly, setAttentionOnly] = useUrlState('attention', false)
  const [emptyOnly, setEmptyOnly] = useUrlState('empty', false)
  const clearSearch = useCallback(() => setSearchQuery(''), [setSearchQuery])

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
        const filed = await submitProposal({
          kind: 'cell', entityId: editing.cell_id, patch,
          rationale: formVal.__rationale, proposalId: editingProposal?.id
        })
        setShowForm(false); setEditingProposal(null); loadAll()
        const { msg, to } = proposalNotice(editing.cell_name, filed?.id ?? editingProposal?.id, !!editingProposal)
        showToast(msg, 'success', { to })
        return
      }

      const saved = editing
        ? await api.put(`/api/v1/cells/${editing.cell_id}`, form)
        : await api.post('/api/v1/cells', form)
      setShowForm(false); loadAll()
      showToast(`Cell '${form.cell_name}' ${editing ? 'saved' : 'created'}`, 'success', { to: cellUrl(editing?.cell_id ?? saved?.id) })
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
      setArchiveTarget(null); loadAll()
      showToast(`Cell '${archiveTarget.cell_name}' archived`, 'success', { to: cellUrl(archiveTarget.cell_id) })
    } catch (e) { showToast(e.message, 'error') }
  }

  const restoreCell = async (cellId, name) => {
    try {
      await api.post(`/api/v1/cells/${cellId}/restore`, {})
      loadAll(); showToast(`Cell '${name}' restored to active service`, 'success', { to: cellUrl(cellId) })
    } catch (e) { showToast(e.message, 'error') }
  }

  // An ID, not the cell object: this page polls, so the selection is resolved against `cells` on
  // every render. In the address as `?cell=`.
  const [selectedId, setSelectedId] = useUrlState('cell', '', { allowed: loading ? null : cells.map(c => c.cell_id) })
  const toggleCell = (cellId) => setSelectedId(id => id === cellId ? null : cellId)
  // Enter or Space on the element itself acts as its click; a key on a control inside it is that
  // control's.
  const onOwnKey = (act) => (e) => {
    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
    if (e.key === ' ') e.preventDefault()
    act()
  }

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

  // Every count on this page counts equipment in service, as the Site Map does.
  const liveGateways = (c) => inServiceGateways(c.gateways)
  const liveDevices = (c) => inServiceDevices(devicesByCell.get(c.cell_id))

  // gatewayNeedsAttention(), not `gatewayLiveStatus(g) !== 'ONLINE'`: PENDING_ENROLLMENT and
  // AWAITING_BIRTH are unfinished tasks, not faults.
  const cellNeedsAttention = (c) =>
    liveGateways(c).some(g => gatewayNeedsAttention(g)) ||
    liveDevices(c).some(a => a.is_quarantined)

  // One test for the filter, the badge and the help: nothing in service here at all. A gateway
  // serving no devices is not empty.
  const cellIsEmpty = (c) => liveGateways(c).length === 0 && liveDevices(c).length === 0

  const matchingCells = cells.filter(c => {
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

  // An unfiled cell has no area to sort by, so it goes last either way.
  const sortColumns = useMemo(() => {
    const areaNames = new Map(areas.map(a => [a.area_id, a.area_name]))
    return {
      name: { type: 'text', value: c => c.cell_name },
      area: { type: 'text', value: c => (c.area_id ? areaNames.get(c.area_id) || c.area_id : null) },
      uuid: { type: 'text', value: c => c.cell_id },
      gateways: { type: 'number', value: c => inServiceGateways(c.gateways).length },
      devices: { type: 'number', value: c => inServiceDevices(devicesByCell.get(c.cell_id)).length }
    }
  }, [areas, devicesByCell])
  const [filteredCells, sort] = useSortableRows(matchingCells, sortColumns)

  const attentionCount = cells.filter(c => !c.is_archived && cellNeedsAttention(c)).length
  const emptyCount = cells.filter(c => !c.is_archived && cellIsEmpty(c)).length
  const activeFilterCount =
    (searchQuery ? 1 : 0) + (attentionOnly ? 1 : 0) + (emptyOnly ? 1 : 0) + (filterMode !== 'active' ? 1 : 0)

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
  const selectedCellArea = selectedCell ? areaOf(selectedCell.area_id) : null
  // What the database counts before it archives a cell, and refuses while either is non-zero:
  // every device that resolves here, whatever its lifecycle, and every gateway filed here.
  const selectedCellItems = selectedCellDevices.length + selectedCellGateways.length
  const selectedCellHolds = [
    selectedCellDevices.length > 0 && plural(selectedCellDevices.length, 'device'),
    selectedCellGateways.length > 0 && plural(selectedCellGateways.length, 'gateway')
  ].filter(Boolean).join(' and ')
  const selectedCellQuarantined = selectedCellDevices.filter(d => d.is_quarantined).length
  // What the drawer counts: equipment in service, as the table does.
  const selectedCellLiveGateways = selectedCell ? liveGateways(selectedCell) : []
  const selectedCellLiveDevices = selectedCell ? liveDevices(selectedCell) : []

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

      {/* One card, composed as every card is: the title, then the toolbar that narrows what is
          below and ends in the primary action. */}
      <div className="card card-fill">
        <CardHeading
          icon={<IconLayoutDashboard size={15} />}
          title="Cells"
          description="A line, bay or group of assets within an area. Gateways and devices are filed in cells, which can be pinned on the area’s plan."
        />

          <div className="filter-bar">
            <SearchInput
              value={searchQuery}
              onChange={v => (v ? setSearchQuery(v) : clearSearch())}
              placeholder="Search by Cell UUID or name…"
              ariaLabel="Search cells"
            />

            {/* Lifecycle is a filter like the rest; the counts are in the option labels. */}
            <select
              className="form-control control-sm"
              value={filterMode}
              onChange={e => setFilterMode(e.target.value)}
              aria-label="Lifecycle"
            >
              <option value="all">All ({cells.length})</option>
              <option value="active">Active ({cells.filter(c => !c.is_archived).length})</option>
              <option value="archived">Archived ({cells.filter(c => c.is_archived).length})</option>
            </select>

            <Tooltip text="Cells containing an offline or stale gateway, or any quarantined device">
              <button
                className={`btn btn-sm ${attentionOnly ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setAttentionOnly(v => !v)}
              >
                <IconShieldAlert size={13} /> Needs attention ({attentionCount})
              </button>
            </Tooltip>

            <Tooltip text="Cells with no gateway and no device in service">
              <button
                className={`btn btn-sm ${emptyOnly ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setEmptyOnly(v => !v)}
              >
                Empty ({emptyCount})
              </button>
            </Tooltip>

            <div className="filter-bar-actions">
              <ClearFilters
                count={activeFilterCount}
                onClear={() => { clearSearch(); setAttentionOnly(false); setEmptyOnly(false); setFilterMode('active') }}
              />
              <ActionButton
                className="btn btn-primary btn-sm"
                permitted={canManage}
                deniedTitle={requiresRolesTitle(PERMISSION_UUIDS.CELL_MANAGE)}
                onClick={() => openForm(null, blank)}
              >
                <IconPlus size={14} /> New Cell
              </ActionButton>
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
                  <SortHeader sort={sort} column="name">Cell Name</SortHeader>
                  <SortHeader sort={sort} column="area" title="The ISA-95 area the cell is in, and whether it has a place on its plan. Edit Details files or places it.">Area</SortHeader>
                  <SortHeader sort={sort} column="uuid">Cell UUID</SortHeader>
                  <SortHeader sort={sort} column="gateways">Assigned Gateways</SortHeader>
                  <SortHeader sort={sort} column="devices" title="Devices in this cell — its gateways' devices, plus any device filed here explicitly. Archived ones are listed, not counted.">Devices</SortHeader>
                </tr>
              </thead>
              <tbody>
                {filteredCells.map(c => {
                  const cellGateways = c.gateways || []
                  // Devices that RESOLVE to this cell, not those merely reachable through its
                  // gateways -- see groupDevicesByCell.
                  const cellAssets = devicesByCell.get(c.cell_id) || []
                  const isEmpty = cellIsEmpty(c)

                  return (
                    <tr
                      key={c.cell_id}
                      className={`row-selectable${selectedId === c.cell_id ? ' row-selected' : ''}${c.is_archived ? ' row-archived' : ''}`}
                      tabIndex={0}
                      onClick={rowSelectHandler(() => toggleCell(c.cell_id))}
                      onKeyDown={onOwnKey(() => toggleCell(c.cell_id))}
                    >
                      <td className="cell-icon-col"><CellIcon cell={c} size={16} /></td>
                      <td>
                        <strong>{c.cell_name}</strong>
                        {c.description && <div className="cell-meta">{c.description}</div>}
                        {c.is_archived && (
                          <ArchivedBadge size="sm" className="badge-follow" title="Archived: out of service, with no devices or gateways in it" />
                        )}
                        {/* A cell with nothing in service in it is usually half-provisioned, and
                            saying so stops it reading as a failed load. */}
                        {isEmpty && !c.is_archived && (
                          <Badge size="sm" className="badge-follow" title="No gateway and no device in service is in this cell">Empty</Badge>
                        )}
                      </td>
                      <td>
                        {/* Unfiled is a state to act on, in the queue's colour; a place is context. */}
                        {c.area_id
                          ? <span>{areas.find(a => a.area_id === c.area_id)?.area_name || <span className="mono">{c.area_id}</span>}</span>
                          : <Badge tone="warning" size="sm">Unfiled</Badge>}
                        {c.area_id && (
                          <div className="cell-meta">
                            {isPlaced(c)
                              ? <span>placed</span>
                              : <Badge tone="warning" size="sm">not placed</Badge>}
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
                          /* The same column as Devices on the Gateways page. The summary is pinned
                             because it is what the column answers; a quarantined device is pinned
                             because it calls for action. */
                          <TagList limit={3} tags={deviceColumnTags(cellAssets, liveDevices(c))} />
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
                  : undefined}
              >
                {proposeMode ? (editingProposal ? 'Update your proposal' : 'Propose a change') : 'Save'}
              </ActionButton>
            </>
          }
        >
          <div className="form-group">
            <label className="form-label" htmlFor="cell-name">Cell Name</label>
            <input id="cell-name" className="form-control" value={formVal.cell_name} onChange={e => setFormVal(f => ({ ...f, cell_name: e.target.value }))} placeholder="e.g. Assembly Line 1" />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="cell-description">Description (Optional)</label>
            <Tooltip text="Shown in the cell's details panel on the Site Map">
              <input id="cell-description" className="form-control" value={formVal.description || ''} onChange={e => setFormVal(f => ({ ...f, description: e.target.value }))} placeholder="e.g. Five-axis machining, two shifts" />
            </Tooltip>
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
            <Tooltip text="The ISA-95 area this cell is in. Unfiled cells are listed as a queue on the Areas page.">
              <select
                id="cell-area"
                className="form-control"
                value={formVal.area_id || ''}
                onChange={e => chooseArea(e.target.value)}
              >
                <option value="">— Unfiled —</option>
                {areas.map(a => <option key={a.area_id} value={a.area_id}>{a.area_name}</option>)}
              </select>
            </Tooltip>
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
            <label className="form-label" htmlFor="cell-access-url">Dashboard / UI URL (Optional)</label>
            <input id="cell-access-url" className="form-control" value={formVal.access_url || ''} onChange={e => setFormVal(f => ({ ...f, access_url: e.target.value }))} placeholder="e.g. http://localhost:3002/d/cell-1" />
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
        icon={selectedCell && <CellIcon cell={selectedCell} size={16} />}
        subtitle={selectedCell && (
          <>
            <Badge size="sm">{plural(selectedCellLiveGateways.length, 'Gateway')} · {plural(selectedCellLiveDevices.length, 'Device')}</Badge>
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
                <RouteLink
                  className="chip chip-link"
                  to={areaUrl(selectedCell.area_id)}
                  onNavigate={() => onSelectArea?.(selectedCell.area_id)}
                  title="Open this area on the Areas page"
                >
                  <AreaIcon area={areas.find(a => a.area_id === selectedCell.area_id)} size={11} />
                  <span className="chip-name">{areas.find(a => a.area_id === selectedCell.area_id)?.area_name || selectedCell.area_id}</span>
                </RouteLink>
              )
              : 'Unfiled',
            help: 'The ISA-95 area this cell is in. Its devices derive their area from it.'
          },
          {
            // The plan itself, with this cell's pin ringed and the area's other cells dimmed, and
            // Expand beside it.
            label: 'Place on plan',
            value: !selectedCell.area_id
              ? null
              : !isPlaced(selectedCell)
                ? 'Not placed — set a place in Edit Details'
                : selectedCellArea
                  ? <ExpandablePlanPreview area={selectedCellArea} cells={cells} highlightCellId={selectedCell.cell_id} onOpen={onShowOnSiteMap} />
                  : "Placed on its area's plan",
            full: true
          },
          {
            // Chips rather than a comma-joined string: a cell is a junction, and its panel must
            // reach the gateways and devices it relates.
            label: 'Assigned Gateways',
            value: selectedCellGateways.length
              ? (
                <div className="context-device-list">
                  {selectedCellGateways.map(g => (
                    <RouteLink
                      key={g.gateway_id}
                      className="chip chip-link chip-gw"
                      to={gatewayUrl(g.gateway_id)}
                      onNavigate={() => onSelectGateway?.(g.gateway_id)}
                      title={`Open ${g.gateway_name} on the Gateways page`}
                    >
                      <IconRadio size={11} />
                      <span className="chip-name">{g.gateway_name}</span>
                    </RouteLink>
                  ))}
                </div>
              )
              : null,
            full: true,
            help: 'Edge nodes serving this cell. Their devices resolve here unless a device carries a cell of its own.'
          },
          {
            // The count stays on the label: how big is this cell and is it healthy reads at a
            // glance, and the chips carry the navigation. It counts what is in service, with the
            // function the Site Map's panel for the same cell uses.
            label: devicesOnlineLabel(selectedCellLiveDevices),
            value: selectedCellDevices.length
              ? (
                <div className="context-device-list">
                  {selectedCellDevices.map(d => {
                    const status = deviceLifecycleStatus(d)
                    return (
                      <RouteLink
                        key={d.asset_id}
                        className="chip chip-link"
                        to={deviceUrl(d.asset_id)}
                        onNavigate={() => onSelectDevice?.(d.asset_id)}
                        title={`Open ${d.asset_name} on the Devices page — ${alertForDevice(alerts, d) ? `ALERT: ${alertForDevice(alerts, d).alert_name}` : deviceStatusTitle(status)}`}
                      >
                        <span className="badge-dot" style={{ background: deviceDotColor(d, alertForDevice(alerts, d)) }} />
                        <span className="chip-name">{d.asset_name}</span>
                        {d.is_archived && <span className="chip-flag">ARCHIVED</span>}
                      </RouteLink>
                    )
                  })}
                </div>
              )
              : null,
            full: true,
            help: "This cell's gateways' devices, plus any device filed here explicitly."
          },
          { label: 'Dashboard URL', value: selectedCell.access_url || null, mono: true, copyable: true, full: true },
          // The purge timer.
          selectedCell.is_archived && {
            label: 'Retention',
            value: selectedCell.auto_delete_at
              ? `Auto-Purge: ${new Date(selectedCell.auto_delete_at).toLocaleDateString()}`
              : 'Never auto-purged',
            full: true
          },
        ].filter(Boolean) : []}
        actions={selectedCell ? [
          selectedCell.access_url && {
            label: 'Open Dashboard', icon: <IconExternalLink size={13} />, href: selectedCell.access_url, primary: true,
            title: 'Open the cell dashboard or UI'
          },
          {
            label: proposeMode ? 'Propose a Change' : 'Edit Details', icon: <IconPencil size={13} />,
            // The primary when there is no dashboard to open and the cell is not archived.
            primary: !selectedCell.is_archived,
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
            to: trailUrl(selectedCell.cell_id, 'CELL'),
            onClick: () => onViewTrail?.(selectedCell),
            title: 'Open the immutable audit trace for this cell'
          },
          {
            label: 'Attached Links', icon: <IconBookOpen size={13} />,
            onClick: () => setLinksForCell(selectedCell),
            title: 'Attach or edit links for this cell — documents, an asset register, a file repository, any URL'
          },
          // Beside Archive Cell, as the way to what holds it. The Devices page's roster leaves
          // quarantined devices to its Quarantine table, so the tooltip counts those.
          selectedCellDevices.length > 0 && {
            label: 'Show Its Devices', icon: <IconCpu size={13} />,
            to: devicesInCellUrl(selectedCell.cell_id),
            title: `Open the Devices page on this cell's devices, archived ones included.${selectedCellQuarantined
              ? ` ${plural(selectedCellQuarantined, 'quarantined device')} ${selectedCellQuarantined === 1 ? 'is' : 'are'} in its Quarantine table.`
              : ''}`
          },
          // Archive is a thing done to one cell you have chosen, like the actions before it.
          selectedCell.is_archived ? {
            label: 'Restore Cell', icon: <IconRefreshCw size={13} />,
            primary: true,
            onClick: () => runRestore(selectedCell.cell_id, () => restoreCell(selectedCell.cell_id, selectedCell.cell_name)),
            pending: restoringId === selectedCell.cell_id,
            pendingLabel: 'Restoring…',
            disabled: !canArchive,
            title: !canArchive ? requiresRolesTitle(PERMISSION_UUIDS.ARCHIVE_MANAGE) : 'Restore cell back to active service'
          } : {
            label: 'Archive Cell', icon: <IconArchive size={13} />,
            onClick: () => setArchiveTarget(selectedCell),
            disabled: !canArchive || selectedCellItems > 0,
            danger: true,
            title: !canArchive
              ? requiresRolesTitle(PERMISSION_UUIDS.ARCHIVE_MANAGE)
              : selectedCellItems > 0
                ? `This cell holds ${selectedCellHolds}. Move ${selectedCellItems === 1 ? 'it' : 'them'} to another cell, or delete ${selectedCellItems === 1 ? 'it' : 'them'}, then archive the cell.`
                : 'Archive Cell'
          },
        ].filter(Boolean) : []}
      />

    </div>
  )
}
