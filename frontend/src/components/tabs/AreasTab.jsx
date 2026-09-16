import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS, REALTIME_ENABLED, refreshInterval } from '../../constants'
import { usePolling } from '../../hooks/usePolling'
import { useRealtimeTable } from '../../hooks/useRealtimeTable'
import { usePendingAction } from '../../hooks/usePendingAction'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { useArrivalSelection } from '../../hooks/useArrivalSelection'
import {
  SCOPE_AREA_WIDE, SOURCE_AREA_WIDE, groupCellsByArea, groupDevicesByCell
} from '../../utils/cellResolution'
import { isPlaced } from '../../utils/floorPlans'
import { CellIcon } from '../../utils/cellIcon'
import { AreaIcon, AREA_ICONS, DEFAULT_AREA_ICON } from '../../utils/areaIcon'
import CopyableId from '../common/CopyableId'
import { ActionButton } from '../common/ActionButton'
import { ContextPanel, rowSelectHandler } from '../common/ContextPanel'
import { HelpTip } from '../common/HelpTip'
import { AreaPlanPanel } from '../common/AreaPlanPanel'
import { ConfirmModal } from '../modals/ConfirmModal'
import { EntityLinksModal } from '../modals/EntityLinksModal'
import {
  IconFactory,
  IconPlus,
  IconPencil,
  IconTrash,
  IconHistory,
  IconBookOpen,
  IconShieldAlert,
  IconRadio,
  IconCpu,
  IconX
} from '../common/Icons'

/**
 * The ISA-95 areas: the parts of the one site. A cell files into at most one; the page's job
 * is to get every cell filed, so the unfiled cells sit in a banner above the card, as the Cells
 * and Gateways pages report their unfinished business, and the area rows are drop targets. The
 * banner is gone once the queue drains; a cell leaves its area from its own form on the Cells
 * page, or by being dragged onto another area. Devices are not filed here: a device's area is its
 * cell's, or its own when it is Area-Wide, which is set on the Devices page. An area's floor plan
 * is managed from its details panel.
 */
export function AreasTab({ showToast, onSelectCell, onSelectDevice, onSelectGateway, onViewThread, hasPermission, initialSearchFilter, onClearFilter }) {
  const [areas, setAreas]       = useState([])
  const [cells, setCells]       = useState([])
  const [assets, setAssets]     = useState([])
  const [gateways, setGateways] = useState([])
  const [loading, setLoading]   = useState(true)
  const [showForm, setShowForm] = useState(false)
  useEscapeKey(() => setShowForm(false), showForm)
  const [editing, setEditing]   = useState(null)
  /* The area whose links are open. `links.entity_type` is the singular noun and carries no CHECK,
     so an area's links need no migration -- the same RLS and the same `link:manage` serve them. */
  const [docsForArea, setDocsForArea] = useState(null)

  const blank = { area_name: '', description: '', icon: DEFAULT_AREA_ICON }
  const [formVal, setFormVal]   = useState(blank)
  const [deleteTarget, setDeleteTarget] = useState(null)
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
      // Cells come from their own endpoint rather than the areas embed: the embed carries no
      // gateways, and the page reads a cell's gateway count for its chip.
      const [ar, c, a, g] = await Promise.all([
        api.get('/api/v1/areas', { signal }),
        api.get('/api/v1/cells', { signal }),
        api.get('/api/v1/devices', { signal }),
        api.get('/api/v1/gateways', { signal })
      ])
      setAreas(ar); setCells(c); setAssets(a); setGateways(g)
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
  const canReadThread = hasPermission(PERMISSION_UUIDS.DIGITAL_THREAD_READ)

  const save = async () => {
    try {
      if (editing) await api.put(`/api/v1/areas/${editing.area_id}`, formVal)
      else         await api.post('/api/v1/areas', formVal)
      setShowForm(false); loadAll(); showToast(editing ? 'Area saved' : 'Area created', 'success')
    } catch (e) { showToast(e.message, 'error') }
  }

  const deleteArea = async () => {
    try {
      await api.delete(`/api/v1/areas/${deleteTarget.area_id}`)
      setDeleteTarget(null); setSelectedId(null); loadAll()
      showToast(`Area '${deleteTarget.area_name}' deleted — its cells are unfiled`, 'success')
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

  const filteredAreas = areas.filter(a => {
    if (!searchQuery) return true
    const q = searchQuery.toLowerCase()
    return String(a.area_id).toLowerCase().includes(q) || a.area_name.toLowerCase().includes(q)
  })

  useArrivalSelection(searchQuery, areas, (a, term) => a.area_id === term, (a) => setSelectedId(a.area_id))

  const selectedArea = areas.find(a => a.area_id === selectedId) || null
  const selectedCells = selectedArea ? (cellsByArea.get(selectedArea.area_id) || []) : []
  const selectedWideDevices = selectedArea ? areaWideDevices(selectedArea.area_id) : []
  const selectedWideGateways = selectedArea ? areaWideGateways(selectedArea.area_id) : []
  const selectedBlocksDelete = selectedWideDevices.length + selectedWideGateways.length > 0

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
    <div className="page-layout">
      <div className="page-main">

      {/* Above the card: the queue this page exists to drain, and the first thing worth knowing
          on arrival. Also the drop target for taking a cell out of its area. */}
      {unfiled.length > 0 && (
        <div
          style={{ marginBottom: 'var(--stack)', background: 'rgba(255,179,0,0.08)', border: '1px solid var(--warning)', borderRadius: 'var(--radius)', padding: '10px var(--inset)', fontSize: '13px', color: 'var(--warning-text)', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}
          onDragOver={handleDragOver}
          onDrop={e => handleDrop(e, null)}
          title={canManage ? 'Drop a cell here to take it out of its area' : undefined}
        >
          <IconShieldAlert size={18} style={{ flexShrink: 0 }} />
          <strong>{unfiled.length} unfiled cell{unfiled.length === 1 ? '' : 's'}:</strong>
          {unfiled.map(cellChip)}
          <span style={{ color: 'var(--text-muted)' }}>
            {canManage ? 'Drag each onto an area below.' : 'File them from the Cells page.'}
          </span>
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <h3 className="section-title">
            Areas
            <HelpTip
              label="About areas"
              text="An area is the ISA-95 level between the site and its cells: one part of the campus, such as a building. Cells are filed into areas so the Unified Namespace can name where a reading came from, and so the Site Map can show one area at a time."
            />
          </h3>
          <button
            className={`btn btn-primary btn-sm ${!canManage ? 'btn-disabled' : ''}`}
            style={{ marginLeft: 'auto' }}
            disabled={!canManage}
            onClick={() => canManage && (setEditing(null), setFormVal(blank), setShowForm(true))}
            title={!canManage ? 'Requires Admin permissions' : 'Add an area'}
          >
            <IconPlus size={14} /> New Area
          </button>
        </div>

        <div className="card-body">
          <div className="filter-bar">
            <input
              className="form-control"
              style={{ width: '220px' }}
              value={searchQuery}
              onChange={e => { const v = e.target.value; v ? setSearchQuery(v) : clearSearch() }}
              placeholder="Search by area ID or name…"
              title="Filter areas by ID or name"
            />
            {searchQuery && (
              <button className="btn btn-ghost btn-sm filter-bar-spacer" onClick={clearSearch} title="Clear the search">
                <IconX size={13} /> Clear
              </button>
            )}
          </div>
        </div>

        {loading ? (
          <div className="loading-wrap"><div className="spinner" /> Loading areas…</div>
        ) : filteredAreas.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon"><IconFactory size={36} /></div>
            <div className="empty-text">
              {areas.length === 0
                ? 'No areas yet. Add one, then file the cells into it.'
                : 'No areas match the search.'}
            </div>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="cell-icon-col"><span className="sr-only">Icon</span></th>
                  <th title="The area's name — also the <area> segment of its uns/ topics">Area</th>
                  <th title="Whether the area carries a floor plan for the Site Map to draw">Plan</th>
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
                      className={`row-selectable${selectedId === a.area_id ? ' row-selected' : ''}`}
                      onClick={rowSelectHandler(() => setSelectedId(id => id === a.area_id ? null : a.area_id))}
                      onDragOver={handleDragOver}
                      onDrop={e => handleDrop(e, a.area_id)}
                      title={canManage ? 'Drop a cell here to file it in this area; click to inspect' : 'Click to inspect this area'}
                    >
                      <td className="cell-icon-col"><AreaIcon area={a} size={16} /></td>
                      <td>
                        <strong>{a.area_name}</strong>
                        {a.description && <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{a.description}</div>}
                      </td>
                      <td>
                        <span className="badge badge-neutral" title={a.plan_path ? 'An SVG plan is uploaded for this area' : 'No plan uploaded; the Site Map draws the default outline'}>
                          {a.plan_path ? 'Plan' : 'Outline'}
                        </span>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                          {placed === 0 ? 'No cells placed' : `${placed} cell${placed === 1 ? '' : 's'} placed`}
                        </div>
                      </td>
                      <td>
                        {areaCells.length === 0 ? (
                          <span style={{ fontSize: '11px', color: 'var(--text-dim)', fontStyle: 'italic' }}>No cells filed here</span>
                        ) : (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                            {areaCells.map(cellChip)}
                          </div>
                        )}
                      </td>
                      <td>
                        <span className="badge badge-neutral" title="Devices resolving to a cell in this area">{deviceCountOf(areaCells)}</span>
                        {wide > 0 && (
                          <span className="badge badge-neutral" style={{ marginLeft: '6px' }} title="Area-Wide assets: filed in the area rather than in any one cell">+{wide} area-wide</span>
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
            <div className="modal-title">{editing ? 'Edit Area' : 'New Area'}</div>
            <div className="form-group">
              <label className="form-label" htmlFor="area-name">Area Name</label>
              <input id="area-name" className="form-control" value={formVal.area_name} onChange={e => setFormVal(f => ({ ...f, area_name: e.target.value }))} placeholder="e.g. Building 3" title="The area's name. It becomes a topic segment, so no / + or #" />
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
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
              <input id="area-description" className="form-control" value={formVal.description || ''} onChange={e => setFormVal(f => ({ ...f, description: e.target.value }))} placeholder="e.g. North campus, machining and assembly" />
            </div>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setShowForm(false)} disabled={saving} title="Cancel">Cancel</button>
              <ActionButton
                pending={saving}
                pendingLabel={editing ? 'Saving…' : 'Creating…'}
                onClick={() => runSave(save)}
                disabled={!formVal.area_name.trim() || /[/+#]/.test(formVal.area_name)}
                title={/[/+#]/.test(formVal.area_name) ? 'The name cannot contain / + or #' : 'Save area'}
              >
                Save
              </ActionButton>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <ConfirmModal
          message={`Delete area '${deleteTarget.area_name}'? Its cells are kept and become unfiled; its floor plan is deleted.`}
          requireTyped={deleteTarget.area_name}
          requireTypedLabel="area name"
          confirmLabel="Delete area"
          pendingLabel="Deleting…"
          onConfirm={deleteArea}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {docsForArea && (
        <EntityLinksModal
          entityType="area"
          entityId={docsForArea.area_id}
          entityName={docsForArea.area_name}
          onClose={() => setDocsForArea(null)}
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
          <span className="badge badge-neutral" style={{ fontSize: '11px' }}>
            {selectedCells.length} CELL{selectedCells.length === 1 ? '' : 'S'} / {deviceCountOf(selectedCells)} DEV
          </span>
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
            label: 'Edit Details', icon: <IconPencil size={13} />,
            onClick: () => { setEditing(selectedArea); setFormVal({ area_name: selectedArea.area_name, description: selectedArea.description || '', icon: selectedArea.icon || DEFAULT_AREA_ICON }); setShowForm(true) },
            disabled: !canManage,
            title: !canManage ? 'Requires Admin permissions' : 'Rename or describe this area'
          },
          canReadThread && {
            label: 'View Digital Thread', icon: <IconHistory size={13} />,
            onClick: () => onViewThread?.(selectedArea),
            title: 'Open the immutable audit trace for this area'
          },
          {
            // An area's own documents: a site plan, a fire strategy, the register for the building.
            // Attached directly, like every other asset's -- there is no proposal lane for a link.
            label: 'Attached Links', icon: <IconBookOpen size={13} />,
            onClick: () => setDocsForArea(selectedArea),
            title: 'Attach or edit links for this area — documents, a site plan, any URL'
          },
          {
            label: 'Delete Area', icon: <IconTrash size={13} />,
            onClick: () => setDeleteTarget(selectedArea),
            disabled: !canManage || selectedBlocksDelete,
            danger: true,
            title: !canManage
              ? 'Requires Admin permissions'
              : selectedBlocksDelete
                ? 'An Area-Wide asset names this area; move it first'
                : 'Delete this area. Its cells become unfiled.'
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
