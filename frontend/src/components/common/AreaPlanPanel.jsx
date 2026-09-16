import React, { useRef, useState } from 'react'
import { api } from '../../api'
import { FLOOR_PLAN_MAX_BYTES, isSvgFile } from '../../utils/floorPlans'
import { HelpTip } from './HelpTip'
import { ConfirmModal } from '../modals/ConfirmModal'
import { IconUpload, IconImage } from './Icons'

/**
 * The plan of one area, managed from the area's details panel: attach an SVG, replace it, or
 * remove it. The write is one call and the panel asks the page to reload rather than patching its
 * own copy.
 */
export function AreaPlanPanel({ area, cells, canManage, showToast, onChanged }) {
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const fileInput = useRef(null)

  const placed = (cells || []).filter(c => c.plan_x !== null && c.plan_x !== undefined && !c.is_archived).length

  const upload = async (file) => {
    if (!file) return
    if (!isSvgFile(file)) { showToast?.(`"${file.name}" is not an SVG. A floor plan is an SVG drawing.`, 'error'); return }
    if (file.size > FLOOR_PLAN_MAX_BYTES) { showToast?.(`"${file.name}" is over the ${Math.round(FLOOR_PLAN_MAX_BYTES / 1048576)} MiB limit.`, 'error'); return }
    setBusy(true)
    try {
      await api.uploadFloorPlan(area, file)
      showToast?.(`Plan attached to ${area.area_name}`, 'success')
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
      await api.removeFloorPlan(area)
      setConfirm(false)
      showToast?.(`Plan removed from ${area.area_name}`, 'success')
      onChanged?.()
    } catch (e) { showToast?.(e.message, 'error') }
    finally { setBusy(false) }
  }

  return (
    <div className="area-plan">
      {confirm && (
        <ConfirmModal
          message={`Remove the plan from ${area.area_name}? Cells keep their places on the default outline.`}
          confirmLabel="Remove plan"
          pendingLabel="Removing…"
          onConfirm={removePlan}
          onCancel={() => setConfirm(false)}
        />
      )}
      <div className="area-plan-header">
        <span className="context-panel-section-label">
          Floor plan
          <HelpTip
            label="About the plan"
            text="An area can carry one SVG plan, which the Site Map draws with the area's cells pinned on it; without one it shows a plain outline. The SVG needs a viewBox (or a width and height) so places on it stay put, and a file a browser cannot draw is refused. A cell is placed on the plan from the Cells page."
            size={12}
          />
        </span>
      </div>

      <div className="area-plan-row" data-plan={area.plan_path ? 'uploaded' : 'outline'}>
        <span className="area-plan-state">
          <IconImage size={12} />
          <strong>{area.plan_path ? 'Plan attached' : 'Default outline'}</strong>
          <span className="area-plan-meta">
            {placed} cell{placed === 1 ? '' : 's'} placed on it
          </span>
        </span>
        {canManage && (
          <span className="area-plan-actions">
            <input
              ref={fileInput}
              type="file"
              accept=".svg,image/svg+xml"
              style={{ display: 'none' }}
              onChange={e => upload(e.target.files?.[0])}
              aria-label={`Plan file for ${area.area_name}`}
            />
            <button
              className="btn btn-ghost btn-sm"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
              title={area.plan_path ? 'Replace the floor plan (SVG)' : 'Upload a floor plan (SVG)'}
            >
              <IconUpload size={12} /> {area.plan_path ? 'Replace plan' : 'Upload plan'}
            </button>
            {area.plan_path && (
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setConfirm(true)} title="Remove the plan; the area keeps the default outline">
                <IconImage size={12} /> Remove plan
              </button>
            )}
          </span>
        )}
      </div>
    </div>
  )
}
