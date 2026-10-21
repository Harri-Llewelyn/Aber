import React, { useState } from 'react'
import { AreaPlan, AreaPlanPin } from './AreaPlan'
import { cellIconComponent } from '../../utils/cellIcon'
import { isPlaced } from '../../utils/areaPlans'
import { RouteLink } from './RouteLink'
import { siteMapAreaUrl } from '../../routes'
import { ExpandButton } from './ExpandButton'
import { ExpandedPlanModal } from './PlanViewer'

/**
 * An area's plan drawn read-only, with the area's placed cells pinned on it, for the Areas and
 * Cells panels. It is capped in height as a Site Map card's plan is (`.area-plan-preview` in
 * App.css). Archived cells are left off, as the Site Map leaves them off, except the highlighted
 * one: it is the subject.
 *
 * @param {object} area The area whose plan is drawn.
 *
 * @param {Array} cells Cells to choose from: only this area's placed cells are pinned, so a page
 * can pass its whole list.
 *
 * @param {string} [highlightCellId] The cell the panel is about. Its pin is ringed and full size;
 * every other pin is small and dimmed. Without it every pin is drawn alike.
 *
 * @param {Function} [onOpen] Called with the area id on a plain click, to open the Site Map on that
 * area. With it the preview is a link to that address; without it the preview is not a control.
 */
export function AreaPlanPreview({ area, cells, highlightCellId = null, onOpen }) {
  const label = `Open ${area.area_name} on the Site Map`
  const Frame = onOpen ? RouteLink : 'div'
  const link = onOpen
    ? { to: siteMapAreaUrl(area.area_id), onNavigate: () => onOpen(area.area_id), 'aria-label': label, title: label }
    : {}

  return (
    <Frame className="area-plan-preview" {...link}>
      <AreaPlan area={area}>
        {previewPins(area, cells, highlightCellId)}
      </AreaPlan>
    </Frame>
  )
}

/** The cells a preview pins: this area's placed cells, less the archived ones but the subject. */
export function previewCells(area, cells, highlightCellId = null) {
  return (cells || []).filter(c =>
    c.area_id === area.area_id && isPlaced(c) && (!c.is_archived || c.cell_id === highlightCellId))
}

/**
 * A preview's pins, as marks: small, except the subject, which is ringed while the rest are dimmed.
 * `expanded` draws every pin at full size with the Site Map's one-column icon, for the dialog.
 */
export function previewPins(area, cells, highlightCellId = null, expanded = false) {
  return previewCells(area, cells, highlightCellId).map(c => {
    const subject = c.cell_id === highlightCellId
    const dimmed = !!highlightCellId && !subject
    return (
      <AreaPlanPin
        key={c.cell_id}
        x={c.plan_x}
        y={c.plan_y}
        status={dimmed ? 'muted' : 'idle'}
        small={!subject && !expanded}
        selected={subject}
        Icon={cellIconComponent(c.icon)}
        label={c.cell_name}
        iconSize={expanded ? 20 : null}
      />
    )
  })
}

/** Whether an area's plan has anything to enlarge: an uploaded plan, or the outline with a pin on it. */
export const planIsExpandable = (area, cells, highlightCellId = null) =>
  !!area?.plan_path || previewCells(area, cells, highlightCellId).length > 0

/**
 * The preview with an Expand button beside it, for the Cells panel. The button is outside the
 * preview because the preview is a link, and a button cannot sit inside one.
 */
export function ExpandablePlanPreview({ area, cells, highlightCellId = null, onOpen }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="plan-preview-row">
      <AreaPlanPreview area={area} cells={cells} highlightCellId={highlightCellId} onOpen={onOpen} />
      {planIsExpandable(area, cells, highlightCellId) && (
        <ExpandButton name={area.area_name} onClick={() => setExpanded(true)} />
      )}
      {expanded && (
        <ExpandedPlanModal area={area} onClose={() => setExpanded(false)}>
          {previewPins(area, cells, highlightCellId, true)}
        </ExpandedPlanModal>
      )}
    </div>
  )
}
