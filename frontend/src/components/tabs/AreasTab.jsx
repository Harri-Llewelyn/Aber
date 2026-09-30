import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS, REALTIME_ENABLED, refreshInterval } from '../../constants'
import { requiresRolesTitle } from '../../hooks/usePermissions'
import { usePolling } from '../../hooks/usePolling'
import { useRealtimeTable } from '../../hooks/useRealtimeTable'
import { usePendingAction } from '../../hooks/usePendingAction'
import { useArrivalSelection } from '../../hooks/useArrivalSelection'
import {
  SCOPE_AREA_WIDE, SOURCE_AREA_WIDE, groupCellsByArea, groupDevicesByCell
} from '../../utils/cellResolution'
import { isPlaced } from '../../utils/areaPlans'
import { CellIcon } from '../../utils/cellIcon'
import { AreaIcon, AREA_ICONS, DEFAULT_AREA_ICON } from '../../utils/areaIcon'
import { patchFromForm, formFromPatch, submitProposal } from '../../utils/proposeFromForm'
import { ActionButton } from '../common/ActionButton'
import { ContextPanel, rowSelectHandler } from '../common/ContextPanel'
import { HelpTip } from '../common/HelpTip'
import { Badge, ArchivedBadge } from '../common/Badge'
import { SectionCount } from '../common/SectionCount'
import { SearchInput } from '../common/SearchInput'
import { ClearFilters } from '../common/ClearFilters'
import { LoadingState } from '../common/LoadingState'
import { EmptyState } from '../common/EmptyState'
import { Modal } from '../common/Modal'
import { plural } from '../../utils/format'
import { AreaPlanPanel } from '../common/AreaPlanPanel'
import { ArchiveModal } from '../modals/ArchiveModal'
import { EntityLinksModal } from '../modals/EntityLinksModal'
import {
  IconFactory,
  IconPlus,
  IconPencil,
  IconArchive,
  IconRefreshCw,
  IconHistory,
  IconBookOpen,
  IconShieldAlert,
  IconRadio,
  IconCpu
} from '../common/Icons'

/**
 * The ISA-95 areas: the parts of the one site. A cell files into at most one; the page's job
 * is to get every cell filed, so the unfiled cells sit in a banner above the card, and the area
 * rows are drop targets. The banner is gone once the queue drains, and is itself the drop target
 * that takes a cell out of its area; a cell also leaves its area from its own form on the Cells
 * page. Devices are not filed here: a device's area is its cell's, or its own when it is
 * Area-Wide, which is set on the Devices page. An area's plan is managed from its details panel.
 */
export function AreasTab({ showToast, onSelectCell, onSelectDevice, onSelectGateway, onViewTrail, hasPermission, initialSearchFilter, onClearFilter }) {
  const [areas, setAreas]       = useState([])
  const [cells, setCells]       = useState([])
  const [assets, setAssets]     = useState([])
  const [gateways, setGateways] = useState([])
  const [loading, setLoading]   = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [formError, setFormError] = useState(null)
  const [editing, setEditing]   = useState(null)
  // The area whose links are open.
  const [linksForArea, setLinksForArea] = useState(null)

  const blank = { area_name: '', description: '', icon: DEFAULT_AREA_ICON }
  const [formVal, setFormVal]   = useState(blank)
  // Archive, never delete, from this page: the delete is the Archived Entities page's. The table
  // opens on Active; archived areas are shown, tinted, under the lifecycle filter.
  const [archiveTarget, setArchiveTarget] = useState(null)
  const [filterMode, setFilterMode] = useState('active')
  const [searchQuery, setSearchQuery] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    return params.get('search') || initialSearchFilter || ''
  })

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const urlSearch = params.get('search')
    if (urlSearch) setSearchQuery(urlSearch)
    else if (initialSearchFilter) setSearchQuery(initialSearchFilter)
  }, [initialSearchFilter])

  const clearSearch = useCallback(() => {
    setSearchQuery('')
    if (window.location.search) window.history.replaceState({}, '', window.location.pathname)
    if (onClearFilter) onClearFilter()
  }, [onClearFilter])

  const loadAll = useCallback(async (signal) => {
    try {
      // Cells come from their own endpoint, as the Cells page reads them.
      const [ar, c, a, g] = await Promise.all([
        api.get('/api/v1/areas', { signal }),
        api.get('/api/v1/cells', { signal }),
        api.get('/api/v1/devices', { signal }),
        api.get('/api/v1/gateways', { signal })
      ])
      setAreas(ar); setCells(c); setAssets(a); setGateways(g)

      /* The reader's own open proposals, so Propose a Change can add to one rather than replace
         it. Tolerated rather than required: the page works without them, and somebody who holds no
         `proposal:create` is refused this read. */
      try {
        const proposals = await api.get('/api/v1/proposals', { signal })
        setOpenProposals((proposals || []).filter(pr => pr.status === 'open'))
      } catch (pErr) {
        if (pErr.name !== 'AbortError') setOpenProposals([])
      }
      setLoading(false)
    } catch (err) {
      if (err.name !== 'AbortError') setLoading(false)
      throw err
    }
  }, [])

  usePolling(loadAll, refreshInterval())
  useRealtimeTable(['cells', 'gateways', 'devices', 'areas'], loadAll, { enabled: REALTIME_ENABLED })

  const [saving, runSave] = usePendingAction()

  const canManage = hasPermission(PERMISSION_UUIDS.CELL_MANAGE)
  const canArchive = hasPermission(PERMISSION_UUIDS.ARCHIVE_MANAGE)
  const canReadTrail = hasPermission(PERMISSION_UUIDS.AUDIT_TRAIL_READ)
  const canPropose = hasPermission(PERMISSION_UUIDS.PROPOSAL_CREATE)

  /* One form, two endings (utils/proposeFromForm.js): for somebody who may not save it, the footer
     files a proposal. Derived rather than stored, so it cannot disagree with the permission. */
  const proposeMode = !canManage && canPropose
  const [editingProposal, setEditingProposal] = useState(null)
  const [openProposals, setOpenProposals] = useState([])

  // Every control that is off its default: the lifecycle select opens on Active.
  const activeFilterCount = (searchQuery ? 1 : 0) + (filterMode !== 'active' ? 1 : 0)

  const openForm = (area, seed) => {
    setEditing(area); setFormVal(seed); setFormError(null); setShowForm(true)
  }

  const save = async () => {
    try {
      /* THE FORK IS AT THE END, not at the beginning: the fields and their validation are shared,
         and only the last step differs -- by who is asking. */
      if (proposeMode) {
        if (!editing) throw new Error('An area can only be created by an Administrator.')
        const patch = patchFromForm('area', editing, formVal)
        await submitProposal({
          kind: 'area', entityId: editing.area_id, patch,
          rationale: formVal.__rationale, proposalId: editingProposal?.id
        })
        setShowForm(false); setEditingProposal(null); loadAll()
        showToast(editingProposal
          ? 'Your proposal was updated. An approver decides from here.'
          : 'Proposed. An approver applies it, or says why not.', 'success')
        return
      }

      if (editing) await api.put(`/api/v1/areas/${editing.area_id}`, formVal)
      else         await api.post('/api/v1/areas', formVal)
      setShowForm(false); loadAll(); showToast(editing ? 'Area saved' : 'Area created', 'success')
    } catch (e) { setFormError(e.message) }
  }

  /**
   * Archiving an area moves nothing: its cells stay filed in it and every uns/ topic beneath it
   * keeps its name. It leaves this table, is drawn muted on the Site Map, and runs its timer on the
   * Archived Entities page, which is where deleting it lives.
   */
  const archiveArea = async (days) => {
    try {
      await api.post(`/api/v1/areas/${archiveTarget.area_id}/archive`, { auto_delete_days: days })
      // Closed after the request, so ArchiveModal holds its Archiving state for the round trip.
      setArchiveTarget(null); setSelectedId(null); loadAll()
      showToast(`Area '${archiveTarget.area_name}' archived (Out of Commission)`, 'success')
    } catch (e) { showToast(e.message, 'error') }
  }

  const restoreArea = async (area) => {
    try {
      await api.post(`/api/v1/areas/${area.area_id}/restore`, {})
      loadAll(); showToast(`Area '${area.area_name}' restored to active service`, 'success')
    } catch (e) { showToast(e.message, 'error') }
  }

  /** File one cell into an area, or into none. One PATCH, written at the drop. */
  const fileCell = async (cell, areaId) => {
    if ((cell.area_id || null) === (areaId || null)) return
    try {
      await api.put(`/api/v1/cells/${cell.cell_id}`, { cell_name: cell.cell_name, access_url: cell.access_url, area_id: areaId || '' })
      loadAll()
      const areaName = areas.find(a => a.area_id === areaId)?.area_name
      showToast(areaName ? `'${cell.cell_name}' → ${areaName}` : `'${cell.cell_name}' unfiled`, 'success')
    } catch (e) { showToast(e.message, 'error') }
  }

  const handleDragStart = (e, cell) => {
    if (!canManage) return
    e.dataTransfer.setData('application/json', JSON.stringify({ cell_id: cell.cell_id }))
  }
  const handleDragOver = (e) => { if (canManage) e.preventDefault() }
  const handleDrop = (e, areaId) => {
    e.preventDefault()
    if (!canManage) return
    let payload
    try { payload = JSON.parse(e.dataTransfer.getData('application/json')) } catch { return }
    const cell = cells.find(c => c.cell_id === payload?.cell_id)
    if (cell) fileCell(cell, areaId)
  }

  const [selectedId, setSelectedId] = useState(null)

  // Membership, derived: cells by area from the cell list, devices by cell from the device list.
  const cellsByArea = useMemo(() => groupCellsByArea(cells), [cells])
  const devicesByCell = useMemo(() => groupDevicesByCell(assets), [assets])
  const unfiled = (cellsByArea.get(null) || []).filter(c => !c.is_archived)

  const deviceCountOf = (areaCells) => areaCells.reduce((n, c) => n + (devicesByCell.get(c.cell_id) || []).length, 0)
  const areaWideDevices = (areaId) => assets.filter(a => a.location_source === SOURCE_AREA_WIDE && a.effective_area_id === areaId)
  const areaWideGateways = (areaId) => gateways.filter(g => g.location_scope === SCOPE_AREA_WIDE && g.area_id === areaId)

  // The lifecycle select scopes the list; the count reads scope-size, or `shown / scope` under a search.
  const inLifecycle = areas.filter(a =>
    filterMode === 'all' || (filterMode === 'archived' ? a.is_archived : !a.is_archived))
  const filteredAreas = areas.filter(a => {
    if (filterMode === 'active'   && a.is_archived) return false
    if (filterMode === 'archived' && !a.is_archived) return false
    if (!searchQuery) return true
    const q = searchQuery.toLowerCase()
    return String(a.area_id).toLowerCase().includes(q) || a.area_name.toLowerCase().includes(q)
  })

  // An arrival by id opens the area whatever its state, so a link to an archived one still lands.
  useArrivalSelection(searchQuery, areas, (a, term) => a.area_id === term, (a) => {
    if (a.is_archived) setFilterMode('all')
    setSelectedId(a.area_id)
  })

  const selectedArea = areas.find(a => a.area_id === selectedId) || null
  const selectedCells = selectedArea ? (cellsByArea.get(selectedArea.area_id) || []) : []
  const selectedWideDevices = selectedArea ? areaWideDevices(selectedArea.area_id) : []
  const selectedWideGateways = selectedArea ? areaWideGateways(selectedArea.area_id) : []

  const cellChip = (c) => (
    <span
      key={c.cell_id}
      className={`chip chip-link${canManage ? ' chip-draggable' : ''}`}
      draggable={canManage}
      onDragStart={e => handleDragStart(e, c)}
      onClick={e => { e.stopPropagation(); onSelectCell?.(c.cell_id) }}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter') onSelectCell?.(c.cell_id) }}
      title={`${c.cell_name} — ${(devicesByCell.get(c.cell_id) || []).length} device(s). ${canManage ? 'Drag onto an area to file it; click' : 'Click'} to open on the Cells page`}
    >
      <CellIcon cell={c} size={11} />
      <span className="chip-name">{c.cell_name}</span>
    </span>
  )

  return (
    <div className="page-layout page-fill">
      <div className="page-main">

      {/* Above the card: the queue this page exists to drain, and the first thing worth knowing
          on arrival. Also the drop target for taking a cell out of its area. */}
      {unfiled.length > 0 && (
        <div
          className="callout callout-warning callout-page"
          onDragOver={handleDragOver}
          onDrop={e => handleDrop(e, null)}
          title={canManage ? 'Drop a cell here to take it out of its area' : undefined}
        >
          <IconShieldAlert size={18} className="callout-icon" />
          <div>
            <strong>{plural(unfiled.length, 'unfiled cell')}:</strong>{' '}
            {unfiled.map(cellChip)}{' '}
            <span className="cell-meta">
              {canManage ? 'Drag each onto an area below.' : 'File them from the Cells page.'}
            </span>
          </div>
        </div>
      )}

      <div className="card card-fill">
        <div className="card-header">
          <h3 className="section-title">
            Areas
            <HelpTip
              label="About areas"
              text="The ISA-95 level between the site and its cells: one part of the campus, such as a hall or a yard. Cells are filed into areas so the Unified Namespace can say where a reading came from."
            />
            <SectionCount total={inLifecycle.length} shown={filteredAreas.length} />
          </h3>
          <ActionButton
            className="btn btn-primary btn-sm"
            permitted={canManage}
            deniedTitle={requiresRolesTitle(PERMISSION_UUIDS.CELL_MANAGE)}
            title="Add an area"
            onClick={() => openForm(null, blank)}
          >
            <IconPlus size={14} /> New Area
          </ActionButton>
        </div>

        <div className="card-body">
          <div className="filter-bar">
            {/* Lifecycle is a filter like the rest, as it is on the Cells page; the counts are in
                the option labels. */}
            <select
              className="form-control control-sm"
              value={filterMode}
              onChange={e => setFilterMode(e.target.value)}
              title="Filter by lifecycle state"
              aria-label="Lifecycle"
            >
              <option value="all">All ({areas.length})</option>
              <option value="active">Active ({areas.filter(a => !a.is_archived).length})</option>
              <option value="archived">Archived ({areas.filter(a => a.is_archived).length})</option>
            </select>
            <SearchInput
              value={searchQuery}
              onChange={v => (v ? setSearchQuery(v) : clearSearch())}
              placeholder="Search by area ID or name…"
              ariaLabel="Search areas"
            />
            <ClearFilters count={activeFilterCount} onClear={() => { clearSearch(); setFilterMode('active') }} />
          </div>
        </div>

        {loading ? (
          <LoadingState label="areas" />
        ) : filteredAreas.length === 0 ? (
          <EmptyState
            icon={<IconFactory size={36} />}
            filtered={areas.length > 0}
            message="No areas yet. Add one, then file the cells into it."
            filteredMessage="No areas match these filters."
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="cell-icon-col"><span className="sr-only">Icon</span></th>
                  <th title="The area's name — also the <area> segment of its uns/ topics">Area</th>
                  <th title="Whether the area carries an area plan for the Site Map to draw">Plan</th>
                  <th title="Cells filed in this area">Cells</th>
                  <th title="Devices resolving to a cell in this area, plus its Area-Wide assets">Devices</th>
                </tr>
              </thead>
              <tbody>
                {filteredAreas.map(a => {
                  const areaCells = (cellsByArea.get(a.area_id) || []).filter(c => !c.is_archived)
                  const placed = areaCells.filter(isPlaced).length
                  const wide = areaWideDevices(a.area_id).length + areaWideGateways(a.area_id).length
                  return (
                    <tr
                      key={a.area_id}
                      className={`row-selectable${selectedId === a.area_id ? ' row-selected' : ''}${a.is_archived ? ' row-archived' : ''}`}
                      onClick={rowSelectHandler(() => setSelectedId(id => id === a.area_id ? null : a.area_id))}
                      onDragOver={handleDragOver}
                      onDrop={e => handleDrop(e, a.area_id)}
                      title={canManage ? 'Drop a cell here to file it in this area; click to inspect' : 'Click to inspect this area'}
                    >
                      <td className="cell-icon-col"><AreaIcon area={a} size={16} /></td>
                      <td>
                        <strong>{a.area_name}</strong>
                        {a.is_archived && (
                          <ArchivedBadge size="sm" className="badge-follow" title="Archived: out of commission, its cells still filed here, its topics unchanged" />
                        )}
                        {a.description && <div className="cell-meta">{a.description}</div>}
                      </td>
                      <td>
                        <Badge size="sm" title={a.plan_path ? 'An SVG plan is uploaded for this area' : 'No plan uploaded; the Site Map draws the default outline'}>
                          {a.plan_path ? 'Plan' : 'Default outline'}
                        </Badge>
                        <div className="cell-meta">
                          {placed === 0 ? 'No cells placed' : `${plural(placed, 'cell')} placed`}
                        </div>
                      </td>
                      <td>
                        {areaCells.length === 0 ? (
                          <span className="cell-meta">No cells filed here</span>
                        ) : (
                          <div className="context-device-list">
                            {areaCells.map(cellChip)}
                          </div>
                        )}
                      </td>
                      <td>
                        <Badge size="sm" title="Devices resolving to a cell in this area">{deviceCountOf(areaCells)}</Badge>
                        {wide > 0 && (
                          <Badge size="sm" className="badge-follow" title="Area-Wide assets: filed in the area rather than in any one cell">+{wide} Area-Wide</Badge>
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
          title={editing ? 'Edit Area' : 'New Area'}
          onClose={() => { setShowForm(false); setEditingProposal(null) }}
          error={formError}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => { setShowForm(false); setEditingProposal(null) }} disabled={saving}>Cancel</button>
              <ActionButton
                pending={saving}
                pendingLabel={proposeMode ? 'Proposing…' : editing ? 'Saving…' : 'Creating…'}
                onClick={() => runSave(save)}
                disabled={!formVal.area_name.trim() || /[/+#]/.test(formVal.area_name)}
                title={/[/+#]/.test(formVal.area_name)
                  ? 'The name cannot contain / + or #'
                  : proposeMode
                    ? 'File this as a proposal for an approver to decide'
                    : 'Save area'}
              >
                {proposeMode ? (editingProposal ? 'Update your proposal' : 'Propose a change') : 'Save'}
              </ActionButton>
            </>
          }
        >
          <div className="form-group">
            <label className="form-label" htmlFor="area-name">Area Name</label>
            <input id="area-name" className="form-control" value={formVal.area_name} onChange={e => setFormVal(f => ({ ...f, area_name: e.target.value }))} placeholder="e.g. Machine Shop" title="The area's name. It becomes a topic segment, so no / + or #" />
            <div className="form-hint">
              Becomes the <span className="mono">&lt;area&gt;</span> segment of every <span className="mono">uns/</span> topic beneath it, so it cannot contain <span className="mono">/</span>, <span className="mono">+</span> or <span className="mono">#</span>.
            </div>
          </div>
          <div className="form-group">
            {/* A grid of buttons, as the cell form has: the choice is visual. */}
            <label className="form-label">Area Icon</label>
            <div className="icon-picker" role="radiogroup" aria-label="Area icon">
              {AREA_ICONS.map(({ key, label, Icon }) => (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={(formVal.icon || DEFAULT_AREA_ICON) === key}
                  className={`icon-picker-option ${(formVal.icon || DEFAULT_AREA_ICON) === key ? 'is-selected' : ''}`}
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
            <label className="form-label" htmlFor="area-description">Description (Optional)</label>
            <input id="area-description" className="form-control" value={formVal.description || ''} onChange={e => setFormVal(f => ({ ...f, description: e.target.value }))} placeholder="e.g. Machining and assembly, north side" />
          </div>
          {/* The rationale, only when proposing: it is written to an approver who has not stood
              in front of the area and does not know why this was asked for. */}
          {proposeMode && (
            <div className="form-group">
              <label className="form-label" htmlFor="area-propose-rationale">Why (optional)</label>
              <textarea
                id="area-propose-rationale"
                className="form-control"
                rows={2}
                value={formVal.__rationale || ''}
                onChange={e => setFormVal(f => ({ ...f, __rationale: e.target.value }))}
                placeholder="What prompted this — an approver sees it beside the change"
              />
            </div>
          )}
        </Modal>
      )}

      {archiveTarget && (
        <ArchiveModal
          entityId={archiveTarget.area_id} displayName={archiveTarget.area_name}
          onArchive={archiveArea} onCancel={() => setArchiveTarget(null)}
        />
      )}

      {linksForArea && (
        <EntityLinksModal
          entityType="area"
          entityId={linksForArea.area_id}
          entityName={linksForArea.area_name}
          onClose={() => setLinksForArea(null)}
          showToast={showToast}
          hasPermission={hasPermission}
        />
      )}
      </div>

      <ContextPanel
        open={!!selectedArea}
        onClose={() => setSelectedId(null)}
        type="AREA"
        onCopy={showToast}
        title={selectedArea?.area_name || ''}
        subtitle={selectedArea && (
          <Badge size="sm">{plural(selectedCells.length, 'Cell')} · {plural(deviceCountOf(selectedCells), 'Device')}</Badge>
        )}
        fields={selectedArea ? [
          { label: 'Area UUID', value: selectedArea.area_id, mono: true, copyable: true },
          { label: 'Description', value: selectedArea.description || null, full: true },
          {
            label: 'Cells',
            value: selectedCells.length
              ? <div className="context-device-list">{selectedCells.map(cellChip)}</div>
              : null,
            full: true,
            title: 'Cells filed in this area. File one from the Cells page or by dragging it onto this area.'
          },
          {
            label: 'Area-Wide Assets',
            value: selectedWideDevices.length + selectedWideGateways.length
              ? (
                <div className="context-device-list">
                  {selectedWideGateways.map(g => (
                    <button key={g.gateway_id} className="chip chip-link chip-gw" onClick={() => onSelectGateway?.(g.gateway_id)} title={`Open ${g.gateway_name} on the Gateways page`}>
                      <IconRadio size={11} /><span className="chip-name">{g.gateway_name}</span>
                    </button>
                  ))}
                  {selectedWideDevices.map(d => (
                    <button key={d.asset_id} className="chip chip-link" onClick={() => onSelectDevice?.(d.asset_id)} title={`Open ${d.asset_name} on the Devices page`}>
                      <IconCpu size={11} /><span className="chip-name">{d.asset_name}</span>
                    </button>
                  ))}
                </div>
              )
              : null,
            full: true,
            title: 'Assets marked Area-Wide here: they belong to the area rather than to any one cell in it. Set on the Devices and Gateways pages.'
          }
        ] : []}
        actions={selectedArea ? [
          {
            label: proposeMode ? 'Propose a Change' : 'Edit Details', icon: <IconPencil size={13} />,
            onClick: () => {
              // Seeded with the open proposal's patch when there is one: one open proposal per
              // asset per person, so a second field extends the request.
              const mine = proposeMode
                ? openProposals.find(pr => pr.entity_type === 'areas' && pr.entity_id === selectedArea.area_id)
                : null
              setEditingProposal(mine || null)
              openForm(selectedArea, {
                area_name: selectedArea.area_name,
                description: selectedArea.description || '',
                icon: selectedArea.icon || DEFAULT_AREA_ICON,
                ...formFromPatch('area', mine?.patch)
              })
            },
            disabled: !canManage && !canPropose,
            title: proposeMode
              ? 'Ask for a change to this area — an approver applies it, or says why not'
              : !canManage
                ? requiresRolesTitle(PERMISSION_UUIDS.CELL_MANAGE)
                : 'Rename or describe this area'
          },
          canReadTrail && {
            label: 'View Audit Trail', icon: <IconHistory size={13} />,
            onClick: () => onViewTrail?.(selectedArea),
            title: 'Open the immutable audit trace for this area'
          },
          {
            // Attached directly: there is no proposal lane for a link.
            label: 'Attached Links', icon: <IconBookOpen size={13} />,
            onClick: () => setLinksForArea(selectedArea),
            title: 'Attach or edit links for this area — documents, a site plan, any URL'
          },
          // Archive or Restore, never both: the two are mutually exclusive states of the same row.
          // The delete is the Archived Entities page's, where it is typed back and irreversible.
          selectedArea.is_archived
            ? {
              label: 'Restore Area', icon: <IconRefreshCw size={13} />,
              onClick: () => restoreArea(selectedArea),
              disabled: !canArchive,
              title: !canArchive ? requiresRolesTitle(PERMISSION_UUIDS.ARCHIVE_MANAGE) : 'Return this area to service; its retention timer is cleared'
            }
            : {
              label: 'Archive Area', icon: <IconArchive size={13} />,
              onClick: () => setArchiveTarget(selectedArea),
              disabled: !canArchive,
              danger: true,
              title: !canArchive
                ? requiresRolesTitle(PERMISSION_UUIDS.ARCHIVE_MANAGE)
                : 'Take this area out of commission. Its cells stay filed in it and its topics keep their name; deleting it is done from Archived Entities.'
            }
        ].filter(Boolean) : []}
      >
        {selectedArea && (
          <AreaPlanPanel
            area={selectedArea}
            cells={selectedCells}
            canManage={canManage}
            showToast={showToast}
            onChanged={loadAll}
          />
        )}
      </ContextPanel>
    </div>
  )
}
