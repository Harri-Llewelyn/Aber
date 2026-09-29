import React, { useState } from 'react'
import { AreaPlan, AreaPlanPin } from './AreaPlan'
import { cellIconComponent } from '../../utils/cellIcon'
import { planAspect, nearestConflict, isPlaced, formatPlace, DEFAULT_MIN_PIN_SPACING } from '../../utils/areaPlans'

/**
 * Where a cell sits on its area's plan, chosen by clicking the plan. The other cells in the area
 * are drawn muted so the operator can see what is already there, and a click closer to one of them
 * than the spacing setting allows is refused here with the neighbour named; the database refuses
 * the same write again.
 *
 * `value` is `{ x, y }` in fractions or null; `onChange` receives the same.
 */
export function CellPlacementPicker({ area, cells, cellId, cellIcon, value, onChange, minSpacing = DEFAULT_MIN_PIN_SPACING, disabled = false }) {
  const [refusal, setRefusal] = useState(null)
  const areaId = area?.area_id ?? area?.id
  const others = (cells || []).filter(c => c.area_id === areaId && (c.cell_id ?? c.id) !== cellId)
  const aspect = planAspect(area)

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
        title={disabled ? undefined : 'Click where the cell is on this plan'}
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
          {refusal || (value ? `Placed ${formatPlace({ plan_x: value.x, plan_y: value.y })}.` : 'Not placed — the cell is listed beside the plan until it is.')}
        </span>
        {value && !disabled && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setRefusal(null); onChange?.(null) }} title="Take the cell off the plan; it stays in the area">
            Clear place
          </button>
        )}
      </div>
    </div>
  )
}
