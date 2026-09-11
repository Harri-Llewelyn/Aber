import React, { useState } from 'react'
import { FloorPlan, FloorPin } from './FloorPlan'
import { cellIconComponent } from '../../utils/cellIcon'
import { floorAspect, nearestConflict, isPlaced, formatPlace, DEFAULT_MIN_PIN_SPACING } from '../../utils/floorPlans'

/**
 * Where a cell sits on its floor's plan, chosen by clicking the plan. The other cells on the floor
 * are drawn muted so the operator can see what is already there, and a click closer to one of them
 * than the spacing setting allows is refused here with the neighbour named; the database refuses
 * the same write again.
 *
 * `value` is `{ x, y }` in fractions or null; `onChange` receives the same.
 */
export function FloorPlacementPicker({ floor, cells, cellId, cellIcon, value, onChange, minSpacing = DEFAULT_MIN_PIN_SPACING, disabled = false }) {
  const [refusal, setRefusal] = useState(null)
  const floorId = floor?.floor_id ?? floor?.id
  const others = (cells || []).filter(c => c.floor_id === floorId && (c.cell_id ?? c.id) !== cellId)
  const aspect = floorAspect(floor)

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

  if (!floor) {
    return <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontStyle: 'italic' }}>Choose a floor to place the cell on its plan.</div>
  }

  return (
    <div className="floor-placement">
      <FloorPlan
        floor={floor}
        onPlaceClick={disabled ? undefined : place}
        title={disabled ? undefined : 'Click where the cell is on this plan'}
      >
        {others.filter(isPlaced).map(c => (
          <FloorPin
            key={c.cell_id ?? c.id}
            x={c.plan_x}
            y={c.plan_y}
            status="muted"
            small
            Icon={cellIconComponent(c.icon)}
            label={c.cell_name ?? c.name}
            title={`${c.cell_name ?? c.name} — already on this floor`}
          />
        ))}
        {value && (
          <FloorPin x={value.x} y={value.y} status="normal" selected Icon={cellIconComponent(cellIcon)} label="This cell" title="Where this cell will be shown" />
        )}
      </FloorPlan>
      <div className="floor-placement-footer">
        <span style={{ fontSize: '11px', color: refusal ? 'var(--danger)' : 'var(--text-muted)' }} role={refusal ? 'alert' : undefined}>
          {refusal || (value ? `Placed ${formatPlace({ plan_x: value.x, plan_y: value.y })}.` : 'Not placed — the cell is listed beside the plan until it is.')}
        </span>
        {value && !disabled && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setRefusal(null); onChange?.(null) }} title="Take the cell off the plan; it stays on the floor">
            Clear place
          </button>
        )}
      </div>
    </div>
  )
}
