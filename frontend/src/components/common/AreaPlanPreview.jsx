import React from 'react'
import { AreaPlan, AreaPlanPin } from './AreaPlan'
import { cellIconComponent } from '../../utils/cellIcon'
import { isPlaced } from '../../utils/areaPlans'
import { RouteLink } from './RouteLink'
import { siteMapAreaUrl } from '../../routes'

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
  const pinned = (cells || []).filter(c =>
    c.area_id === area.area_id && isPlaced(c) && (!c.is_archived || c.cell_id === highlightCellId))
  const label = `Open ${area.area_name} on the Site Map`
  const Frame = onOpen ? RouteLink : 'div'
  const link = onOpen
    ? { to: siteMapAreaUrl(area.area_id), onNavigate: () => onOpen(area.area_id), 'aria-label': label, title: label }
    : {}

  return (
    <Frame className="area-plan-preview" {...link}>
      <AreaPlan area={area}>
        {pinned.map(c => {
          const subject = c.cell_id === highlightCellId
          const dimmed = !!highlightCellId && !subject
          return (
            <AreaPlanPin
              key={c.cell_id}
              x={c.plan_x}
              y={c.plan_y}
              status={dimmed ? 'muted' : 'idle'}
              small={!subject}
              selected={subject}
              Icon={cellIconComponent(c.icon)}
              label={c.cell_name}
            />
          )
        })}
      </AreaPlan>
    </Frame>
  )
}
