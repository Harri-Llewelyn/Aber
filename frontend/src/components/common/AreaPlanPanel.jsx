import React, { useRef, useState } from 'react'
import { api } from '../../api'
import { AREA_PLAN_MAX_BYTES, isSvgFile } from '../../utils/areaPlans'
import { HelpTip } from './HelpTip'
import { plural } from '../../utils/format'
import { ConfirmModal } from '../modals/ConfirmModal'
import { ExpandablePlanPreview } from './AreaPlanPreview'
import { IconUpload, IconTrash, IconRotateCcw, IconRotateCw } from './Icons'
import { areaUrl, siteMapAreaUrl } from '../../routes'
import { Tooltip } from './Tooltip'

/**
 * The plan of one area, managed from the area's details panel: attach an SVG, turn it, replace it,
 * or remove it. A plan is drawn as a preview with every cell on it, Turn left, Turn right, Replace
 * and Remove beside its heading, and Expand on the preview's card, which opens it window-sized
 * (PlanViewer). An area with no plan shows the drop zone rather than a button, the same gesture a
 * device's 3D model takes; a reader who may not upload sees the default outline instead. Each write
 * is one call and the panel asks the page to reload rather than patching its own copy; a turn
 * waits for that reload, so the next turn starts from the one just made. `onOpen` is handed to the
 * preview: it opens the Site Map on the area.
 */
export function AreaPlanPanel({ area, cells, canManage, showToast, onChanged, onOpen }) {
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const fileInput = useRef(null)

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

  const removePlan = async () => {
    setBusy(true)
    try {
      await api.removeAreaPlan(area)
      setConfirm(false)
      showToast?.(`Plan removed from ${area.area_name}`, 'success', { to: areaUrl(area.area_id) })
      onChanged?.()
    } catch (e) { showToast?.(e.message, 'error') }
    finally { setBusy(false) }
  }

  // `direction` is 1 for a quarter turn right (clockwise), -1 for left.
  const turnPlan = async (direction) => {
    setBusy(true)
    try {
      await api.turnAreaPlan(area, direction)
      await onChanged?.()
    } catch (e) { showToast?.(e.message, 'error') }
    finally { setBusy(false) }
  }

  const openPicker = () => { if (canManage && !busy) fileInput.current?.click() }

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
        {area.plan_path && canManage && (
          <span className="area-plan-panel-actions">
            {picker}
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
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={openPicker}>
              <IconUpload size={12} /> Replace plan
            </button>
            <Tooltip text="The area keeps the default outline">
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setConfirm(true)}>
                <IconTrash size={12} /> Remove plan
              </button>
            </Tooltip>
          </span>
        )}
      </div>

      {/* The preview for a plan, and for anyone who may not upload one; Expand is on its card. */}
      {area.plan_path || !canManage ? (
        <ExpandablePlanPreview area={area} cells={cells} onOpen={onOpen} />
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
