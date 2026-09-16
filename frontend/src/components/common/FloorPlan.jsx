import React, { useEffect, useState } from 'react'
import { loadFloorPlanUrl } from '../../api'
import { floorAspect, planFractionsFromEvent } from '../../utils/floorPlans'

/**
 * An area's plan, at the plan's own aspect ratio, with pins placed over it by fraction. The plan
 * is an <img> fed a blob URL, never inline markup: an SVG in an image element can run nothing.
 * An area with no plan gets the default outline, drawn here in the same coordinate space, so a
 * place set before a plan is uploaded stays where it was put.
 */

/** The blob URL for an area's plan, or null while loading or when the area has none. */
export function useFloorPlanUrl(area) {
  const path = area?.plan_path || null
  const [state, setState] = useState({ path: null, url: null, error: null })

  useEffect(() => {
    let alive = true
    if (!path) { setState({ path: null, url: null, error: null }); return undefined }
    loadFloorPlanUrl(path)
      .then(url => { if (alive) setState({ path, url, error: null }) })
      .catch(err => { if (alive) setState({ path, url: null, error: err.message }) })
    return () => { alive = false }
  }, [path])

  return state.path === path ? state : { path, url: null, error: null }
}

export function FloorPlan({ area, onPlaceClick, children, className = '', title, compact = false }) {
  const aspect = floorAspect(area)
  const { url, error } = useFloorPlanUrl(area)
  const hasPlan = !!area?.plan_path
  // The blob URL the browser refused to draw, if any: a file it cannot render fires error, not load.
  const [undrawable, setUndrawable] = useState(null)
  const broken = !!url && undrawable === url
  const unavailable = error ? 'The plan could not be loaded' : broken ? 'The browser cannot draw this plan; replace it from the area\'s details' : null

  const handleClick = (e) => {
    if (!onPlaceClick) return
    // A click on a pin is the pin's, not a placement.
    if (e.target.closest('.floor-pin')) return
    const place = planFractionsFromEvent(e, e.currentTarget)
    if (place) onPlaceClick(place)
  }

  return (
    <div
      className={`floor-plan${onPlaceClick ? ' floor-plan-interactive' : ''}${compact ? ' floor-plan-compact' : ''}${className ? ' ' + className : ''}`}
      style={{ aspectRatio: String(aspect), '--plan-aspect': aspect }}
      onClick={handleClick}
      title={title}
      role={onPlaceClick ? 'button' : undefined}
      data-plan={hasPlan ? (unavailable ? 'unavailable' : 'uploaded') : 'outline'}
    >
      {hasPlan && url && !broken ? (
        <img className="floor-plan-image" src={url} alt="" draggable={false} onError={() => setUndrawable(url)} />
      ) : (
        <DefaultOutline aspect={aspect} compact={compact} unavailable={hasPlan ? unavailable : null} />
      )}
      {children}
    </div>
  )
}

/** The outline an area gets until somebody uploads a plan: a dashed frame over a light grid. */
function DefaultOutline({ aspect, compact, unavailable }) {
  const w = 400
  const h = Math.round(w / aspect)
  const step = 50
  const lines = []
  for (let x = step; x < w; x += step) lines.push(<line key={`x${x}`} className="outline-grid" x1={x} y1={0} x2={x} y2={h} />)
  for (let y = step; y < h; y += step) lines.push(<line key={`y${y}`} className="outline-grid" x1={0} y1={y} x2={w} y2={y} />)
  return (
    <>
      <svg className="floor-plan-outline" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
        {lines}
        <rect className="outline-frame" x={4} y={4} width={w - 8} height={h - 8} rx={6} />
      </svg>
      {!compact && (
        <span className="floor-plan-caption">
          {unavailable || 'No plan uploaded — the default outline'}
        </span>
      )}
    </>
  )
}

/**
 * One cell on a plan: a coloured disc with the cell's icon, its name beneath. `status` is the
 * tile rollup (normal, attention, idle), `alert` when Grafana has raised one against a device
 * here, or `muted` for a pin that is context rather than the subject.
 */
export function FloorPin({ x, y, status = 'idle', Icon, label, title, selected = false, onClick, small = false, hideLabel = false, iconSize = null }) {
  return (
    <button
      type="button"
      className={`floor-pin floor-pin-${status}${selected ? ' floor-pin-selected' : ''}${small ? ' floor-pin-small' : ''}`}
      style={{ left: `${Number(x) * 100}%`, top: `${Number(y) * 100}%` }}
      onClick={onClick ? (e) => { e.stopPropagation(); onClick(e) } : undefined}
      title={title || label}
      aria-label={label}
      aria-pressed={onClick ? selected : undefined}
      data-status={status}
    >
      <span className="floor-pin-disc">{Icon && <Icon size={iconSize ?? (small ? 9 : 18)} />}</span>
      {!hideLabel && <span className="floor-pin-label">{label}</span>}
    </button>
  )
}
