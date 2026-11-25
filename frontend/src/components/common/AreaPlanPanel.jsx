import React, { useMemo, useState } from 'react'
import { api } from '../../api'
import { AREA_PLAN_MAX_BYTES, areaPlanFileName, decodeSvgBytes, isSvgFile, nextRotation, planRotation, readSvgPlan } from '../../utils/areaPlans'
import { STORED_FILE_DELETED, STORED_FILE_REPLACED } from '../../utils/storedFile'
import { HelpTip } from './HelpTip'
import { plural } from '../../utils/format'
import { ConfirmModal } from '../modals/ConfirmModal'
import { ExpandablePlanPreview } from './AreaPlanPreview'
import { IconDownload, IconUpload, IconTrash, IconRotateCcw, IconRotateCw } from './Icons'
import { areaUrl, siteMapAreaUrl } from '../../routes'
import { Tooltip } from './Tooltip'
import { SaveDiscard } from './SaveDiscard'
import { DropZone, useFilePicker } from './DropZone'

/** Why Replace plan and Remove plan wait while a turn is unsaved. */
const TURN_UNSAVED = 'Save or discard the turn first.'

const PLAN_ACCEPT = '.svg,image/svg+xml'
const LIMIT = `${Math.round(AREA_PLAN_MAX_BYTES / 1048576)} MiB`

/** Why a file given as a plan is refused before it is read, or null. */
const planProblem = (file) => {
  if (!isSvgFile(file)) return `"${file.name}" is not an SVG. An area plan is an SVG drawing.`
  return file.size > AREA_PLAN_MAX_BYTES ? `"${file.name}" is over the ${LIMIT} limit.` : null
}

/**
 * The plan of one area, managed from the area's details panel: attach an SVG, turn it, replace it,
 * or remove it. A plan is drawn as a preview with every cell on it, Turn left and Turn right in a
 * row under its heading, Download, Replace and Remove under its card (each group in the drawer's grid
 * of buttons), and Expand on the card, which opens it
 * window-sized (PlanViewer). Replace sits away from the turns because a missed turn would open a
 * file dialog. Download is for every role that sees the plan. An area with no plan shows the drop zone
 * rather than a button, since the file is usually already in a folder somebody is dragging from; a reader
 * who may not upload sees the default outline instead.
 *
 * A turn is a draft held here: the preview and the expanded plan draw it, and nothing is written
 * until Save Turn, which writes the drafted turn once. Each write is one call, and the panel asks
 * the page to reload rather than patching its own copy.
 */
export function AreaPlanPanel({ area, cells, canManage, showToast, onChanged }) {
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  // Why the upload of an area's first plan was refused, `{ areaId, why }`, said at the drop zone.
  const [refused, setRefused] = useState(null)

  // The file chosen in place of the stored plan, `{ areaId, file }`, until Replace's dialog is
  // answered. It belongs to the area it was chosen for, as a turn does.
  const [replacement, setReplacement] = useState(null)
  if (replacement && replacement.areaId !== area.area_id) setReplacement(null)

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

  // Uploads a checked file and attaches it. A refusal is thrown, for whoever asked to show.
  const attach = async (file) => {
    setBusy(true)
    try {
      await api.uploadAreaPlan(area, file)
      setReplacement(null)
      // To the Site Map, where the plan is drawn with its cells.
      showToast?.(`Plan attached to ${area.area_name}`, 'success', { to: siteMapAreaUrl(area.area_id) })
      onChanged?.()
    } finally { setBusy(false) }
  }

  // The area's first plan, from the drop zone.
  const upload = async (file) => {
    setRefused(null)
    try {
      await attach(file)
    } catch (e) {
      setRefused({ areaId: area.area_id, why: e.message })
      showToast?.(e.message, 'error')
    }
  }

  // Asked once the file has passed its checks, so a person who cancels the picker is asked nothing.
  const askToReplace = async (file) => {
    try {
      const problem = planProblem(file) ?? readSvgPlan(decodeSvgBytes(await file.arrayBuffer())).problem
      if (problem) throw new Error(problem)
      setReplacement({ areaId: area.area_id, file })
    } catch (e) { showToast?.(e.message, 'error') }
  }
  const replace = useFilePicker({ accept: PLAN_ACCEPT, onFile: askToReplace, testId: 'area-plan-input' })

  // A signed URL in a new tab, as a capture's download is: the bucket is private and the link is short-lived.
  const downloadPlan = async () => {
    try {
      window.open(await api.areaPlanDownloadUrl(area), '_blank', 'noopener')
    } catch (e) { showToast?.(e.message, 'error') }
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

  return (
    <div className="area-plan-panel">
      {replacement && (
        <ConfirmModal
          title="Replace Area Plan"
          icon={<IconUpload size={18} />}
          message={`Replace the plan of ${area.area_name} with "${replacement.file.name}"? ${STORED_FILE_REPLACED}`}
          confirmLabel="Replace Plan"
          pendingLabel="Replacing…"
          onConfirm={() => attach(replacement.file)}
          onCancel={() => setReplacement(null)}
        />
      )}
      {confirm && (
        <ConfirmModal
          title="Remove Area Plan"
          icon={<IconTrash size={18} />}
          message={`Remove the plan from ${area.area_name}? Cells keep their places on the default outline. ${STORED_FILE_DELETED}`}
          confirmLabel="Remove Plan"
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

      {/* A grid of its own, the turns first: Save Turn and Discard appear after them, so the turns
          never move when a draft starts or ends. */}
      {turnable && (
        <div className="context-buttons area-plan-panel-actions">
          <Tooltip text="A quarter turn anticlockwise. The cells turn with the plan, and the file is left as it is.">
            <button className="btn btn-ghost btn-sm context-action" disabled={busy} onClick={() => turnPlan(-1)}>
              <IconRotateCcw size={12} /> Turn Left
            </button>
          </Tooltip>
          <Tooltip text="A quarter turn clockwise. The cells turn with the plan, and the file is left as it is.">
            <button className="btn btn-ghost btn-sm context-action" disabled={busy} onClick={() => turnPlan(1)}>
              <IconRotateCw size={12} /> Turn Right
            </button>
          </Tooltip>
          <SaveDiscard dirty={turnUnsaved} disabled={busy} saveLabel="Save Turn" buttonClassName="context-action"
            onSave={saveTurn}
            onDiscard={() => setDraft(null)} />
        </div>
      )}

      {/* The preview for a plan, and for anyone who may not upload one; Expand is on its card. */}
      {area.plan_path || !canManage ? (
        <>
          <ExpandablePlanPreview area={shownArea} cells={cells} />
          {area.plan_path && (
            <div className="context-buttons area-plan-panel-buttons">
              {/* For every role, as a 3D model's Download is: reading is not a write. */}
              <Tooltip text={`Save ${areaPlanFileName(area)} to this computer`}>
                <button className="btn btn-ghost btn-sm context-action" onClick={downloadPlan}>
                  <IconDownload size={13} /> Download Plan
                </button>
              </Tooltip>
              {turnable && (
                <>
                  {replace.picker}
                  {/* Held while a turn is unsaved, so a replacement is never taken with a turn nobody saved. */}
                  <Tooltip text={turnUnsaved ? TURN_UNSAVED : null}>
                    <button className={`btn btn-ghost btn-sm context-action${turnUnsaved ? ' btn-disabled' : ''}`} disabled={busy || turnUnsaved} onClick={replace.open}>
                      <IconUpload size={13} /> Replace Plan
                    </button>
                  </Tooltip>
                  <Tooltip text={turnUnsaved ? TURN_UNSAVED : 'The area keeps the default outline'}>
                    <button className={`btn btn-ghost btn-sm context-action${turnUnsaved ? ' btn-disabled' : ''}`} disabled={busy || turnUnsaved} onClick={() => setConfirm(true)}>
                      <IconTrash size={13} /> Remove Plan
                    </button>
                  </Tooltip>
                </>
              )}
            </div>
          )}
        </>
      ) : (
        <DropZone
          key={area.area_id}
          label={`Upload plan for ${area.area_name}`}
          prompt="Drop an SVG plan here, or click to choose one"
          hint={`Default outline · ${placedLine} · SVG up to ${LIMIT}`}
          accept={PLAN_ACCEPT}
          kinds="an SVG"
          refuse={planProblem}
          onRefuse={why => showToast?.(why, 'error')}
          onFile={upload}
          busy={busy && 'Uploading…'}
          error={refused?.areaId === area.area_id ? refused.why : null}
          testId="area-plan-input"
        />
      )}
    </div>
  )
}
