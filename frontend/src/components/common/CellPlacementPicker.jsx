import React, { useState } from 'react'
import { AreaPlan, AreaPlanPin } from './AreaPlan'
import { cellIconComponent } from '../../utils/cellIcon'
import { planAspect, planRotation, placeInFrame, nearestConflict, isPlaced, formatPlace, DEFAULT_MIN_PIN_SPACING } from '../../utils/areaPlans'
import { Tooltip } from './Tooltip'

/**
 * Where a cell sits on its area's plan, chosen by clicking the plan. The other cells in the area
 * are drawn muted so the operator can see what is already there, and a click closer to one of them
 * than the spacing setting allows is refused here with the neighbour named; the database refuses
 * the same write again.
 *
 * `value` is `{ x, y }` in fractions of the drawing as uploaded, or null; `onChange` receives the
 * same. The footer says the place as the plan is drawn, turned or not.
 */
export function CellPlacementPicker({ area, cells, cellId, cellIcon, value, onChange, minSpacing = DEFAULT_MIN_PIN_SPACING, disabled = false }) {
  const [refusal, setRefusal] = useState(null)
  const areaId = area?.area_id ?? area?.id
  const others = (cells || []).filter(c => c.area_id === areaId && (c.cell_id ?? c.id) !== cellId)
  // The drawing's own aspect, whatever the turn: AreaPlan hands back places on the drawing as uploaded.
  const aspect = planAspect(area)
  const shown = value ? placeInFrame(value, planRotation(area)) : null

  const place = (p) => {
    if (disabled) return
    const near = nearestConflict(p, others, aspect, minSpacing, cellId)
    if (near) {
      setRefusal(`Too close to '${near.cell_name ?? near.name}'. Cells keep at least ${Math.round(minSpacing * 100)}% of the plan's shorter side between them.`)
      return
    }
    setRefusal(null)
    onChange?.(p)
  }

  if (!area) {
    return <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontStyle: 'italic' }}>File the cell into an area to place it on a plan.</div>
  }

  return (
    <div className="area-plan-placement">
      <AreaPlan
        area={area}
        onPlaceClick={disabled ? undefined : place}
      >
        {others.filter(isPlaced).map(c => (
          <AreaPlanPin
            key={c.cell_id ?? c.id}
            x={c.plan_x}
            y={c.plan_y}
            status="muted"
            small
            Icon={cellIconComponent(c.icon)}
            label={c.cell_name ?? c.name}
            title={`${c.cell_name ?? c.name} — already in this area`}
          />
        ))}
        {value && (
          <AreaPlanPin x={value.x} y={value.y} status="normal" selected Icon={cellIconComponent(cellIcon)} label="This cell" title="Where this cell will be shown" />
        )}
      </AreaPlan>
      <div className="area-plan-placement-footer">
        <span style={{ fontSize: '11px', color: refusal ? 'var(--danger)' : 'var(--text-muted)' }} role={refusal ? 'alert' : undefined}>
          {refusal || (shown ? `Placed ${formatPlace({ plan_x: shown.x, plan_y: shown.y })}.` : 'Not placed — the Site Map does not draw the cell until it is.')}
          {!refusal && !disabled && ' Click the plan where the cell is.'}
        </span>
        {value && !disabled && (
          <Tooltip text="Take the cell off the plan; it stays in the area">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setRefusal(null); onChange?.(null) }}>
              Clear place
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  )
}
