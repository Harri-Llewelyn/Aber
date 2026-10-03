import React, { useEffect, useState } from 'react'
import { loadAreaPlanUrl } from '../../api'
import { planAspect, planFractionsFromEvent } from '../../utils/areaPlans'

/**
 * An area's plan, at the plan's own aspect ratio, with pins placed over it by fraction. The plan
 * is an <img> fed a blob URL, never inline markup: an SVG in an image element can run nothing.
 * An area with no plan gets the default outline, drawn here in the same coordinate space, so a
 * place set before a plan is uploaded stays where it was put.
 */

/** The blob URL for an area's plan, or null while loading or when the area has none. */
function useAreaPlanUrl(area) {
  const path = area?.plan_path || null
  const [state, setState] = useState({ path: null, url: null, error: null })

  useEffect(() => {
    let alive = true
    if (!path) { setState({ path: null, url: null, error: null }); return undefined }
    loadAreaPlanUrl(path)
      .then(url => { if (alive) setState({ path, url, error: null }) })
      .catch(err => { if (alive) setState({ path, url: null, error: err.message }) })
    return () => { alive = false }
  }, [path])

  return state.path === path ? state : { path, url: null, error: null }
}

export function AreaPlan({ area, onPlaceClick, children, title }) {
  const aspect = planAspect(area)
  const { url, error } = useAreaPlanUrl(area)
  const hasPlan = !!area?.plan_path
  // The blob URL the browser refused to draw, if any: a file it cannot render fires error, not load.
  const [undrawable, setUndrawable] = useState(null)
  const broken = !!url && undrawable === url
  const unavailable = error ? 'The plan could not be loaded' : broken ? 'The browser cannot draw this plan; replace it from the area\'s details' : null

  const handleClick = (e) => {
    if (!onPlaceClick) return
    // A click on a pin is the pin's, not a placement.
    if (e.target.closest('.area-plan-pin')) return
    const place = planFractionsFromEvent(e, e.currentTarget)
    if (place) onPlaceClick(place)
  }

  return (
    <div
      className={`area-plan${onPlaceClick ? ' area-plan-interactive' : ''}`}
      style={{ aspectRatio: String(aspect), '--plan-aspect': aspect }}
      onClick={handleClick}
      title={title}
      role={onPlaceClick ? 'button' : undefined}
      data-plan={hasPlan ? (unavailable ? 'unavailable' : 'uploaded') : 'outline'}
    >
      {hasPlan && url && !broken ? (
        <img className="area-plan-image" src={url} alt="" draggable={false} onError={() => setUndrawable(url)} />
      ) : (
        <DefaultOutline aspect={aspect} unavailable={hasPlan ? unavailable : null} />
      )}
      {children}
    </div>
  )
}

/** The outline an area gets until somebody uploads a plan: a dashed frame over a light grid. */
function DefaultOutline({ aspect, unavailable }) {
  const w = 400
  const h = Math.round(w / aspect)
  const step = 50
  const lines = []
  for (let x = step; x < w; x += step) lines.push(<line key={`x${x}`} className="outline-grid" x1={x} y1={0} x2={x} y2={h} />)
  for (let y = step; y < h; y += step) lines.push(<line key={`y${y}`} className="outline-grid" x1={0} y1={y} x2={w} y2={y} />)
  return (
    <>
      <svg className="area-plan-outline" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
        {lines}
        <rect className="outline-frame" x={4} y={4} width={w - 8} height={h - 8} rx={6} />
      </svg>
      <span className="area-plan-caption">
        {unavailable || 'No plan uploaded — the default outline'}
      </span>
    </>
  )
}

/**
 * One cell on a plan: a coloured disc with the cell's icon, its name beneath. `status` is the
 * tile rollup (normal, attention, idle), `alert` when Grafana has raised one against a device
 * here, or `muted` for a pin that is context rather than the subject. Without `onClick` the pin
 * is a mark, not a control: a span, so a read-only plan puts no dead stops in the tab order.
 */
export function AreaPlanPin({ x, y, status = 'idle', Icon, label, title, selected = false, onClick, small = false, iconSize = null }) {
  const className = `area-plan-pin area-plan-pin-${status}${selected ? ' area-plan-pin-selected' : ''}${small ? ' area-plan-pin-small' : ''}`
  const style = { left: `${Number(x) * 100}%`, top: `${Number(y) * 100}%` }
  const content = (
    <>
      <span className="area-plan-pin-disc">{Icon && <Icon size={iconSize ?? (small ? 9 : 18)} />}</span>
      <span className="area-plan-pin-label">{label}</span>
    </>
  )
  if (!onClick) {
    return <span className={className} style={style} title={title || label} data-status={status}>{content}</span>
  }
  return (
    <button
      type="button"
      className={className}
      style={style}
      onClick={(e) => { e.stopPropagation(); onClick(e) }}
      title={title || label}
      aria-label={label}
      aria-pressed={selected}
      data-status={status}
    >
      {content}
    </button>
  )
}
