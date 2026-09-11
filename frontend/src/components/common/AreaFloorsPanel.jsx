import React, { useRef, useState } from 'react'
import { api } from '../../api'
import { floorLabel } from '../../utils/cellResolution'
import { sortFloors, nextLevel, FLOOR_PLAN_MAX_BYTES, isSvgFile } from '../../utils/floorPlans'
import { ActionButton } from './ActionButton'
import { HelpTip } from './HelpTip'
import { ConfirmModal } from '../modals/ConfirmModal'
import { IconPlus, IconPencil, IconTrash, IconUpload, IconImage, IconCheck, IconX } from './Icons'

/**
 * The floors of one area, managed from the area's details panel: add and remove floors, rename
 * them, move them up or down by level, and attach the plan the Site Map draws for each. Every
 * write is one call and the panel asks the page to reload rather than patching its own copy.
 */
export function AreaFloorsPanel({ area, floors, cells, canManage, showToast, onChanged }) {
  const ordered = sortFloors(floors)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState({ level: '0', name: '' })
  const [editingId, setEditingId] = useState(null)
  const [edit, setEdit] = useState({ level: '', name: '' })
  const [busyId, setBusyId] = useState(null)
  /** The dialog that is open: `{ kind: 'floor' | 'plan', floor }`, or null. */
  const [confirm, setConfirm] = useState(null)
  const fileInputs = useRef(new Map())

  const cellsOn = (floor) => (cells || []).filter(c => c.floor_id === floor.floor_id && !c.is_archived).length

  const startAdd = (direction) => {
    const level = nextLevel(ordered, direction)
    setDraft({ level: String(level), name: floorLabel(level) })
    setAdding(true)
  }

  const submitAdd = async () => {
    try {
      await api.post('/api/v1/floors', { area_id: area.area_id, level: draft.level, name: draft.name })
      setAdding(false)
      showToast?.(`Floor '${draft.name}' added to ${area.area_name}`, 'success')
      onChanged?.()
    } catch (e) { showToast?.(e.message, 'error') }
  }

  const startEdit = (floor) => {
    setEditingId(floor.floor_id)
    setEdit({ level: String(floor.level), name: floor.name })
  }

  const submitEdit = async (floor) => {
    try {
      await api.put(`/api/v1/floors/${floor.floor_id}`, { level: edit.level, name: edit.name })
      setEditingId(null)
      showToast?.('Floor saved', 'success')
      onChanged?.()
    } catch (e) { showToast?.(e.message, 'error') }
  }

  /** Why a floor cannot be deleted right now, or null when it can. Said on click, not only on hover. */
  const deleteBlocker = (floor) => {
    const n = cellsOn(floor)
    if (n > 0) return `'${floor.name}' still holds ${n} cell${n === 1 ? '' : 's'}. Move them to another floor on the Cells page first.`
    if (ordered.length === 1) return `'${floor.name}' is the only floor of ${area.area_name}; an area keeps at least one.`
    return null
  }

  const askRemove = (floor) => {
    const why = deleteBlocker(floor)
    if (why) { showToast?.(why, 'error'); return }
    setConfirm({ kind: 'floor', floor })
  }

  const remove = async (floor) => {
    setBusyId(floor.floor_id)
    try {
      await api.delete(`/api/v1/floors/${floor.floor_id}`)
      setConfirm(null)
      showToast?.(`Floor '${floor.name}' deleted`, 'success')
      onChanged?.()
    } catch (e) { showToast?.(e.message, 'error') }
    finally { setBusyId(null) }
  }

  const upload = async (floor, file) => {
    if (!file) return
    if (!isSvgFile(file)) { showToast?.(`"${file.name}" is not an SVG. A floor plan is an SVG drawing.`, 'error'); return }
    if (file.size > FLOOR_PLAN_MAX_BYTES) { showToast?.(`"${file.name}" is over the ${Math.round(FLOOR_PLAN_MAX_BYTES / 1048576)} MiB limit.`, 'error'); return }
    setBusyId(floor.floor_id)
    try {
      await api.uploadFloorPlan(floor, file)
      showToast?.(`Plan attached to '${floor.name}'`, 'success')
      onChanged?.()
    } catch (e) { showToast?.(e.message, 'error') }
    finally {
      setBusyId(null)
      const input = fileInputs.current.get(floor.floor_id)
      if (input) input.value = ''
    }
  }

  const removePlan = async (floor) => {
    setBusyId(floor.floor_id)
    try {
      await api.removeFloorPlan(floor)
      setConfirm(null)
      showToast?.(`Plan removed from '${floor.name}'`, 'success')
      onChanged?.()
    } catch (e) { showToast?.(e.message, 'error') }
    finally { setBusyId(null) }
  }

  return (
    <div className="area-floors">
      {confirm?.kind === 'floor' && (
        <ConfirmModal
          message={`Delete floor '${confirm.floor.name}' from ${area.area_name}?${confirm.floor.plan_path ? ' Its plan is deleted with it.' : ''}`}
          requireTyped={confirm.floor.name}
          requireTypedLabel="floor name"
          confirmLabel="Delete floor"
          pendingLabel="Deleting…"
          onConfirm={() => remove(confirm.floor)}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm?.kind === 'plan' && (
        <ConfirmModal
          message={`Remove the plan from '${confirm.floor.name}'? Cells keep their places on the default outline.`}
          confirmLabel="Remove plan"
          pendingLabel="Removing…"
          onConfirm={() => removePlan(confirm.floor)}
          onCancel={() => setConfirm(null)}
        />
      )}
      <div className="area-floors-header">
        <span className="context-panel-section-label">
          Floors
          <HelpTip
            label="About floors"
            text="Every area has a ground floor (level 0); add floors above it and basements below. Each floor can carry an SVG plan, which the Site Map draws with the floor's cells pinned on it; without one it shows a plain outline. A floor holding cells cannot be deleted."
            size={12}
          />
        </span>
        {canManage && !adding && (
          <span style={{ display: 'flex', gap: '4px' }}>
            <button className="btn btn-ghost btn-sm" onClick={() => startAdd(1)} title="Add a floor above the top one"><IconPlus size={12} /> Floor above</button>
            <button className="btn btn-ghost btn-sm" onClick={() => startAdd(-1)} title="Add a basement below the lowest one"><IconPlus size={12} /> Basement</button>
          </span>
        )}
      </div>

      {adding && (
        <div className="area-floor-row area-floor-row-form" role="group" aria-label="New floor">
          <input
            className="form-control mono"
            type="number"
            step="1"
            style={{ width: '64px' }}
            value={draft.level}
            onChange={e => setDraft(d => ({ ...d, level: e.target.value }))}
            aria-label="Level"
            title="0 is the ground floor, 1 the floor above it, -1 a basement"
          />
          <input
            className="form-control"
            value={draft.name}
            onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
            aria-label="Floor name"
            placeholder="e.g. Mezzanine"
          />
          <ActionButton onClick={submitAdd} disabled={!draft.name.trim() || draft.level === ''} title="Add this floor">
            <IconCheck size={12} /> Add
          </ActionButton>
          <button className="btn btn-ghost btn-sm" onClick={() => setAdding(false)} title="Cancel"><IconX size={12} /></button>
        </div>
      )}

      {ordered.length === 0 && (
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontStyle: 'italic' }}>No floors yet.</div>
      )}

      {ordered.map(floor => {
        const editing = editingId === floor.floor_id
        const busy = busyId === floor.floor_id
        const n = cellsOn(floor)
        return (
          <div key={floor.floor_id} className={`area-floor-row${busy ? ' is-busy' : ''}`} data-level={floor.level}>
            {editing ? (
              <>
                <input className="form-control mono" type="number" step="1" style={{ width: '64px' }} value={edit.level} onChange={e => setEdit(v => ({ ...v, level: e.target.value }))} aria-label="Level" />
                <input className="form-control" value={edit.name} onChange={e => setEdit(v => ({ ...v, name: e.target.value }))} aria-label="Floor name" />
                <ActionButton onClick={() => submitEdit(floor)} disabled={!edit.name.trim()} title="Save the floor"><IconCheck size={12} /> Save</ActionButton>
                <button className="btn btn-ghost btn-sm" onClick={() => setEditingId(null)} title="Cancel"><IconX size={12} /></button>
              </>
            ) : (
              <>
                <span className="area-floor-level mono" title={`Level ${floor.level}`}>{floor.level}</span>
                <span className="area-floor-name">
                  <strong>{floor.name}</strong>
                  <span className="area-floor-meta">
                    {n} cell{n === 1 ? '' : 's'} · {floor.plan_path ? 'plan attached' : 'default outline'}
                  </span>
                </span>
                {canManage && (
                  <span className="area-floor-actions">
                    <input
                      ref={el => { if (el) fileInputs.current.set(floor.floor_id, el) }}
                      type="file"
                      accept=".svg,image/svg+xml"
                      style={{ display: 'none' }}
                      onChange={e => upload(floor, e.target.files?.[0])}
                      aria-label={`Plan file for ${floor.name}`}
                    />
                    <button
                      className="btn btn-ghost btn-sm"
                      disabled={busy}
                      onClick={() => fileInputs.current.get(floor.floor_id)?.click()}
                      title={floor.plan_path ? 'Replace the floor plan (SVG)' : 'Upload a floor plan (SVG)'}
                    >
                      <IconUpload size={12} /> {floor.plan_path ? 'Replace plan' : 'Upload plan'}
                    </button>
                    {floor.plan_path && (
                      <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setConfirm({ kind: 'plan', floor })} title="Remove the plan; the floor keeps the default outline">
                        <IconImage size={12} /> Remove plan
                      </button>
                    )}
                    <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => startEdit(floor)} title="Rename this floor or change its level"><IconPencil size={12} /></button>
                    {/* Enabled even when the delete is refused: the click then says why, where a
                        disabled button would say nothing. */}
                    <button
                      className="btn btn-ghost btn-sm"
                      disabled={busy}
                      onClick={() => askRemove(floor)}
                      title={n > 0 ? 'Move its cells to another floor first' : ordered.length === 1 ? 'An area keeps at least one floor' : 'Delete this floor'}
                    >
                      <IconTrash size={12} />
                    </button>
                  </span>
                )}
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
