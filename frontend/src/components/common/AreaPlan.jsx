import React, { createContext, useContext, useEffect, useRef, useState } from 'react'
import { loadAreaPlanUrl } from '../../api'
import {
  planFrameAspect, planRotation, planFractionsFromEvent, placeInFrame, placeOnDrawing, drawingBoxInFrame
} from '../../utils/areaPlans'
import { Tooltip } from './Tooltip'

/**
 * An area's plan, at the plan's own aspect ratio, with pins placed over it by fraction. The plan
 * is an <img> fed a blob URL, never inline markup: an SVG in an image element can run nothing.
 * An area with no plan gets the default outline, drawn here in the same coordinate space, so a
 * place set before a plan is uploaded stays where it was put.
 *
 * Places are fractions of the drawing, not of the plan's box: the box keeps a margin of half a pin
 * round the drawing (`.area-plan` in App.css), so a pin on the plan's edge is drawn whole.
 *
 * A turned plan (`plan_rotation`) is drawn in a frame of the turned shape. Only the image turns:
 * each pin turns its place into the frame and stays upright, and a click is turned back into the
 * drawing as uploaded before it is handed on.
 */

/** The turn of the plan a pin is drawn on; AreaPlan provides it to the pins among its children. */
const PlanRotation = createContext(0)

/** The image's style for a turned plan: laid out at the drawing's own shape, then turned about the frame's centre. */
function turnedImageStyle(area) {
  const { width, height, rotation } = drawingBoxInFrame(area)
  if (!rotation) return undefined
  return {
    left: '50%', top: '50%', right: 'auto', bottom: 'auto',
    width: `${width}%`, height: `${height}%`,
    transform: `translate(-50%, -50%) rotate(${rotation}deg)`
  }
}

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

export function AreaPlan({ area, onPlaceClick, children }) {
  const aspect = planFrameAspect(area)
  const rotation = planRotation(area)
  const { url, error } = useAreaPlanUrl(area)
  const hasPlan = !!area?.plan_path
  // The blob URL the browser refused to draw, if any: a file it cannot render fires error, not load.
  const [undrawable, setUndrawable] = useState(null)
  const drawingRef = useRef(null)
  const broken = !!url && undrawable === url
  const unavailable = error ? 'The plan could not be loaded' : broken ? 'The browser cannot draw this plan; replace it from the area\'s details' : null

  const handleClick = (e) => {
    if (!onPlaceClick) return
    // A click on a pin is the pin's, not a placement.
    if (e.target.closest('.area-plan-pin')) return
    // Measured against the drawing: a click on the margin round it lands on the nearest edge.
    const framed = planFractionsFromEvent(e, drawingRef.current)
    if (!framed) return
    const place = placeOnDrawing(framed, rotation)
    // The four places the fractions are read to, so 1 - x is not 0.8766000000000001.
    onPlaceClick({ x: Number(place.x.toFixed(4)), y: Number(place.y.toFixed(4)) })
  }

  return (
    <div
      className={`area-plan${onPlaceClick ? ' area-plan-interactive' : ''}`}
      style={{ '--plan-aspect': aspect }}
      onClick={handleClick}
      role={onPlaceClick ? 'button' : undefined}
      data-plan={hasPlan ? (unavailable ? 'unavailable' : 'uploaded') : 'outline'}
      data-rotation={rotation || undefined}
    >
      <div className="area-plan-drawing" ref={drawingRef} style={{ aspectRatio: String(aspect) }}>
        {hasPlan && url && !broken ? (
          <img
            className="area-plan-image"
            src={url}
            alt=""
            draggable={false}
            style={turnedImageStyle(area)}
            onError={() => setUndrawable(url)}
          />
        ) : (
          <DefaultOutline aspect={aspect} unavailable={hasPlan ? unavailable : null} />
        )}
        <PlanRotation.Provider value={rotation}>{children}</PlanRotation.Provider>
      </div>
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
 * `--pin-x` lets the label slide inward at the plan's side edges while the disc stays put. `title`
 * is its tooltip, the shared one, for what the label beneath it does not say. `x` and `y` are the
 * place on the drawing as uploaded; the pin draws it where the plan's turn puts it.
 */
export function AreaPlanPin({ x, y, status = 'idle', Icon, label, title, selected = false, onClick, small = false, iconSize = null }) {
  const className = `area-plan-pin area-plan-pin-${status}${selected ? ' area-plan-pin-selected' : ''}${small ? ' area-plan-pin-small' : ''}`
  const at = placeInFrame({ x, y }, useContext(PlanRotation))
  const style = { left: `${at.x * 100}%`, top: `${at.y * 100}%`, '--pin-x': at.x }
  const content = (
    <>
      <span className="area-plan-pin-disc">{Icon && <Icon size={iconSize ?? (small ? 9 : 18)} />}</span>
      <span className="area-plan-pin-label">{label}</span>
    </>
  )
  if (!onClick) {
    return <Tooltip text={title}><span className={className} style={style} data-status={status}>{content}</span></Tooltip>
  }
  return (
    <Tooltip text={title}>
      <button
        type="button"
        className={className}
        style={style}
        onClick={(e) => { e.stopPropagation(); onClick(e) }}
        aria-label={label}
        aria-pressed={selected}
        data-status={status}
      >
        {content}
      </button>
    </Tooltip>
  )
}
