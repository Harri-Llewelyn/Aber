import React, { useMemo, useRef, useState } from 'react'
import { api } from '../../api'
import { AREA_PLAN_MAX_BYTES, isSvgFile, nextRotation, planRotation } from '../../utils/areaPlans'
import { HelpTip } from './HelpTip'
import { plural } from '../../utils/format'
import { ConfirmModal } from '../modals/ConfirmModal'
import { ExpandablePlanPreview } from './AreaPlanPreview'
import { IconUpload, IconTrash, IconRotateCcw, IconRotateCw } from './Icons'
import { areaUrl, siteMapAreaUrl } from '../../routes'
import { Tooltip } from './Tooltip'
import { SaveDiscard } from './SaveDiscard'

/** Why Replace plan and Remove plan wait while a turn is unsaved. */
const TURN_UNSAVED = 'Save or discard the turn first.'

/**
 * The plan of one area, managed from the area's details panel: attach an SVG, turn it, replace it,
 * or remove it. A plan is drawn as a preview with every cell on it, Turn left and Turn right in a
 * row under its heading, Replace and Remove under its card, and Expand on the card, which opens it
 * window-sized (PlanViewer). Replace sits away from the turns because a missed turn would open a
 * file dialog. An area with no plan shows the drop zone rather than a button, the same gesture a
 * device's 3D model takes; a reader who may not upload sees the default outline instead.
 *
 * A turn is a draft held here: the preview and the expanded plan draw it, and nothing is written
 * until Save Turn, which writes the drafted turn once. Each write is one call, and the panel asks
 * the page to reload rather than patching its own copy.
 */
export function AreaPlanPanel({ area, cells, canManage, showToast, onChanged }) {
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const fileInput = useRef(null)

  // The unsaved turn, `{ areaId, rotation }`. It belongs to the area it was made on: turning to
  // another area drops it, as closing the panel does by unmounting it.
  const [draft, setDraft] = useState(null)
  if (draft && draft.areaId !== area.area_id) setDraft(null)
  const turnable = !!area.plan_path && canManage
  const savedRotation = planRotation(area)
  const rotation = turnable && draft?.areaId === area.area_id ? draft.rotation : savedRotation
  const turnUnsaved = rotation !== savedRotation
  // What the preview draws. The rest of the page reads the area as saved.
  const shownArea = useMemo(
    () => (turnUnsaved ? { ...area, plan_rotation: rotation } : area),
    [area, rotation, turnUnsaved]
  )

  const placed = (cells || []).filter(c => c.plan_x !== null && c.plan_x !== undefined && !c.is_archived).length
  const placedLine = `${plural(placed, 'cell')} placed on it`
  const limitMiB = Math.round(AREA_PLAN_MAX_BYTES / 1048576)

  const upload = async (file) => {
    if (!file) return
    if (!isSvgFile(file)) { showToast?.(`"${file.name}" is not an SVG. An area plan is an SVG drawing.`, 'error'); return }
    if (file.size > AREA_PLAN_MAX_BYTES) { showToast?.(`"${file.name}" is over the ${limitMiB} MiB limit.`, 'error'); return }
    setBusy(true)
    try {
      await api.uploadAreaPlan(area, file)
      // To the Site Map, where the plan is drawn with its cells.
      showToast?.(`Plan attached to ${area.area_name}`, 'success', { to: siteMapAreaUrl(area.area_id) })
      onChanged?.()
    } catch (e) { showToast?.(e.message, 'error') }
    finally {
      setBusy(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  // Run from Remove area plan's dialog, which shows a refusal and stays open.
  const removePlan = async () => {
    setBusy(true)
    try {
      await api.removeAreaPlan(area)
      setConfirm(false)
      showToast?.(`Plan removed from ${area.area_name}`, 'success', { to: areaUrl(area.area_id) })
      onChanged?.()
    } finally { setBusy(false) }
  }

  // `direction` is 1 for a quarter turn right (clockwise), -1 for left. No request.
  const turnPlan = (direction) => setDraft({ areaId: area.area_id, rotation: nextRotation(rotation, direction) })

  // One write of the drafted turn. Kept if the write fails, so it can be saved again or discarded;
  // dropped once the reload has the saved turn, or the preview would jump back to the old one.
  const saveTurn = async () => {
    setBusy(true)
    try {
      await api.setAreaPlanRotation(area, rotation)
      showToast?.(rotation ? `Plan of ${area.area_name} turned ${rotation}° clockwise` : `Plan of ${area.area_name} turned back to how it was drawn`,
        'success', { to: areaUrl(area.area_id) })
      try { await onChanged?.() } finally { setDraft(null) }
    } catch (e) { showToast?.(e.message, 'error') }
    finally { setBusy(false) }
  }

  const openPicker = () => { if (canManage && !busy && !turnUnsaved) fileInput.current?.click() }

  const onDrop = (event) => {
    // preventDefault on BOTH dragover and drop, or the browser navigates to the dropped file and
    // the page is simply gone.
    event.preventDefault()
    setDragging(false)
    if (!canManage || busy) return
    upload(event.dataTransfer?.files?.[0])
  }

  const onDragOver = (event) => {
    event.preventDefault()
    if (canManage && !busy) setDragging(true)
  }

  const picker = (
    <input
      ref={fileInput}
      type="file"
      accept=".svg,image/svg+xml"
      style={{ display: 'none' }}
      onChange={e => upload(e.target.files?.[0])}
      /* The picker sits inside the zone so its label stays with it, which means its own click
         would bubble back to the zone and open it a second time. */
      onClick={e => e.stopPropagation()}
      aria-label={`Plan file for ${area.area_name}`}
    />
  )

  return (
    <div className="area-plan-panel">
      {confirm && (
        <ConfirmModal
          title="Remove area plan"
          icon={<IconTrash size={18} />}
          message={`Remove the plan from ${area.area_name}? Cells keep their places on the default outline.`}
          confirmLabel="Remove plan"
          pendingLabel="Removing…"
          onConfirm={removePlan}
          onCancel={() => setConfirm(false)}
        />
      )}
      <div className="area-plan-panel-header">
        <span className="context-panel-section-label">
          Area plan
          <HelpTip
            label="About the plan"
            text="One SVG plan per area, drawn on the Site Map with its cells pinned. The SVG needs a viewBox or a width and height so pins stay put. Cells are placed on it from the Cells page."
            size={12}
          />
        </span>
      </div>

      {/* A row of its own, the turns first: Save Turn and Discard appear after them, so the turns
          never move when a draft starts or ends. */}
      {turnable && (
        <div className="area-plan-panel-actions">
          <Tooltip text="A quarter turn anticlockwise. The cells turn with the plan, and the file is left as it is.">
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => turnPlan(-1)}>
              <IconRotateCcw size={12} /> Turn left
            </button>
          </Tooltip>
          <Tooltip text="A quarter turn clockwise. The cells turn with the plan, and the file is left as it is.">
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => turnPlan(1)}>
              <IconRotateCw size={12} /> Turn right
            </button>
          </Tooltip>
          <SaveDiscard dirty={turnUnsaved} disabled={busy} saveLabel="Save Turn"
            onSave={saveTurn}
            onDiscard={() => setDraft(null)} />
        </div>
      )}

      {/* The preview for a plan, and for anyone who may not upload one; Expand is on its card. */}
      {area.plan_path || !canManage ? (
        <>
          <ExpandablePlanPreview area={shownArea} cells={cells} />
          {turnable && (
            <div className="area-plan-panel-buttons">
              {picker}
              {/* Held while a turn is unsaved, so a replacement is never taken with a turn nobody saved. */}
              <Tooltip text={turnUnsaved ? TURN_UNSAVED : null}>
                <button className={`btn btn-ghost btn-sm context-action${turnUnsaved ? ' btn-disabled' : ''}`} disabled={busy || turnUnsaved} onClick={openPicker}>
                  <IconUpload size={13} /> Replace plan
                </button>
              </Tooltip>
              <Tooltip text={turnUnsaved ? TURN_UNSAVED : 'The area keeps the default outline'}>
                <button className={`btn btn-ghost btn-sm context-action${turnUnsaved ? ' btn-disabled' : ''}`} disabled={busy || turnUnsaved} onClick={() => setConfirm(true)}>
                  <IconTrash size={13} /> Remove plan
                </button>
              </Tooltip>
            </div>
          )}
        </>
      ) : (
        <div
          className="area-plan-panel-row area-plan-panel-drop"
          data-plan="outline"
          data-dragging={dragging ? 'yes' : undefined}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={() => setDragging(false)}
          onClick={openPicker}
          role="button"
          tabIndex={0}
          aria-label={`Upload plan for ${area.area_name}`}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPicker() }
          }}
        >
          {picker}
          <IconUpload size={20} />
          <span className="area-plan-panel-drop-line">
            {busy ? 'Uploading…' : 'Drop an SVG plan here, or click to browse'}
          </span>
          <span className="area-plan-panel-meta">
            Default outline · {placedLine} · SVG up to {limitMiB} MiB
          </span>
        </div>
      )}
    </div>
  )
}
