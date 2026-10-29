import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Modal } from './Modal'
import { AreaPlan } from './AreaPlan'
import { TipButton } from './TipButton'
import { IconScan, IconZoomIn, IconZoomOut } from './Icons'
import { planFrameAspect } from '../../utils/areaPlans'
import { areaIconComponent } from '../../utils/areaIcon'
import { commandModifierHeld, isEditableTarget } from '../../shortcuts'

/**
 * An area's plan in a window-sized dialog, zoomed and panned. Zoom sets the width the drawing is
 * laid out at, never a CSS scale: the SVG is drawn again at every size, so it stays sharp, and the
 * pins over it keep their size on screen and spread apart. The person moves the view; the plan and
 * its pins are AreaPlan's and AreaPlanPin's, as everywhere else.
 */

/** How far past the fitted size the plan zooms, as a multiple of it. frontend/README.md says how it was measured. */
export const PLAN_ZOOM_CAP = 4
/** One press of + or −, on a key or a button. */
export const PLAN_ZOOM_STEP = 1.25
/** One press of an arrow key, in screen pixels. */
export const PLAN_PAN_STEP = 80
/** A press that moves further than this, in screen pixels, is a pan and not a click on a pin. */
export const DRAG_SLOP = 4

export const clampZoom = (zoom) => Math.min(PLAN_ZOOM_CAP, Math.max(1, zoom))

/**
 * Where the plan's box goes in a `vw` by `vh` viewport at `zoom` (1 is fitted), wanting the drawing's
 * fraction (`fx`, `fy`) at the viewport's centre. `ix` and `iy` are the box's margins round the
 * drawing. Across and down alike, a box smaller than the viewport is centred and a larger one is
 * kept covering it, so the plan can never be moved out of view. `x` and `y` are the box's top left.
 */
export function planLayout({ vw, vh, aspect, ix = 0, iy = 0, zoom = 1, fx = 0.5, fy = 0.5 }) {
  const fit = Math.max(1, Math.min(vw - 2 * ix, (vh - 2 * iy) * aspect))
  const w = fit * zoom
  const h = w / aspect
  const place = (want, size, room) => (size <= room ? (room - size) / 2 : Math.min(0, Math.max(room - size, want)))
  return { fit, w, h, x: place(vw / 2 - ix - fx * w, w + 2 * ix, vw), y: place(vh / 2 - iy - fy * h, h + 2 * iy, vh) }
}

/** The view that puts the box's top left at (`x`, `y`) at `zoom`, or as near as the viewport allows. */
function viewAt(box, aspect, zoom, x, y) {
  const w = planLayout({ ...box, aspect, zoom }).w
  const want = { zoom, fx: (box.vw / 2 - box.ix - x) / w, fy: (box.vh / 2 - box.iy - y) / (w / aspect) }
  const placed = planLayout({ ...box, aspect, ...want })
  return { zoom, fx: (box.vw / 2 - box.ix - placed.x) / w, fy: (box.vh / 2 - box.iy - placed.y) / placed.h }
}

/** The view after zooming by `factor` about the viewport point (`px`, `py`): what was under it stays under it. */
export function zoomAbout(view, box, aspect, factor, px, py) {
  const zoom = clampZoom(view.zoom * factor)
  if (zoom === view.zoom) return view
  const from = planLayout({ ...box, aspect, ...view })
  const u = (px - from.x - box.ix) / from.w
  const t = (py - from.y - box.iy) / from.h
  const w = from.fit * zoom
  return viewAt(box, aspect, zoom, px - box.ix - u * w, py - box.iy - t * (w / aspect))
}

/** The view after moving the plan by (`dx`, `dy`) screen pixels. */
export function panBy(view, box, aspect, dx, dy) {
  const from = planLayout({ ...box, aspect, ...view })
  return viewAt(box, aspect, view.zoom, from.x + dx, from.y + dy)
}

const FITTED = { zoom: 1, fx: 0.5, fy: 0.5 }

/** A viewport with a size: before its dialog is shown it has none, and nothing can be placed in it. */
const measured = (box) => !!box && box.vw > 0 && box.vh > 0

/** Keys the viewer answers while focus is in its dialog. Arrows move the view, so the plan goes the other way. */
const KEYS = {
  '+': ['zoom', PLAN_ZOOM_STEP], '=': ['zoom', PLAN_ZOOM_STEP], '-': ['zoom', 1 / PLAN_ZOOM_STEP], '0': ['fit'],
  ArrowLeft: ['pan', PLAN_PAN_STEP, 0], ArrowRight: ['pan', -PLAN_PAN_STEP, 0],
  ArrowUp: ['pan', 0, PLAN_PAN_STEP], ArrowDown: ['pan', 0, -PLAN_PAN_STEP],
}

/**
 * The zoom-and-pan view of `area`'s plan, with `children` (the pins) over it. It fills the height it
 * is given (`modal-fill`). Wheel or pinch zooms about the pointer; dragging pans; the buttons in the
 * corner zoom about the centre and fit; the keys in KEYS act while focus is anywhere in the dialog.
 */
export function PlanViewer({ area, children }) {
  const aspect = planFrameAspect(area)
  const hintId = useId()
  const viewportRef = useRef(null)
  const [box, setBox] = useState(null)
  const [view, setView] = useState(FITTED)
  const [dragging, setDragging] = useState(false)

  // The handlers bound once below read the latest box and aspect through this.
  const latest = useRef(null)
  latest.current = { box, aspect }
  const act = {
    zoom: (factor, px, py) => setView(v => {
      const { box: b, aspect: a } = latest.current
      return measured(b) ? zoomAbout(v, b, a, factor, px ?? b.vw / 2, py ?? b.vh / 2) : v
    }),
    pan: (dx, dy) => setView(v => {
      const { box: b, aspect: a } = latest.current
      return measured(b) ? panBy(v, b, a, dx, dy) : v
    }),
    fit: () => setView(FITTED),
  }
  const actRef = useRef(act)
  actRef.current = act

  // The viewport's size and the plan's margins, again whenever the dialog is resized. The view is
  // held as fractions of the drawing, so the same place stays centred.
  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const measure = () => {
      const plan = viewport.querySelector('.area-plan')
      const style = plan ? getComputedStyle(plan) : null
      setBox({
        vw: viewport.clientWidth,
        vh: viewport.clientHeight,
        ix: parseFloat(style?.paddingLeft) || 0,
        iy: parseFloat(style?.paddingTop) || 0,
      })
    }
    measure()
    if (typeof ResizeObserver !== 'function') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

  // Bound natively: React's wheel listener is passive, and the page must not scroll or zoom too.
  useEffect(() => {
    const viewport = viewportRef.current
    const onWheel = (e) => {
      e.preventDefault()
      const r = viewport.getBoundingClientRect()
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1
      // A trackpad pinch arrives as a wheel with Ctrl held, in small steps.
      const rate = e.ctrlKey ? 0.01 : 0.002
      actRef.current.zoom(Math.exp(-e.deltaY * unit * rate), e.clientX - r.left, e.clientY - r.top)
    }
    viewport.addEventListener('wheel', onWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', onWheel)
  }, [])

  // On the dialog, so the keys work wherever focus is in it and nowhere else. The page's own
  // single-key shortcuts stand down while a dialog is open (shortcuts.js).
  useEffect(() => {
    const host = viewportRef.current.closest('dialog') || viewportRef.current
    const onKey = (e) => {
      const key = KEYS[e.key]
      if (!key || e.defaultPrevented || commandModifierHeld(e) || isEditableTarget(e.target)) return
      e.preventDefault()
      const [what, ...args] = key
      actRef.current[what](...args)
    }
    host.addEventListener('keydown', onKey)
    return () => host.removeEventListener('keydown', onKey)
  }, [])

  // One pointer pans once it has moved DRAG_SLOP; two pinch. A press that panned swallows the
  // click that follows it, so a pin under the pointer is not opened by the end of a drag.
  const pointers = useRef(new Map())
  const gesture = useRef(null)
  const swallowClick = useRef(false)

  const onPointerDown = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (e.target.closest?.('.plan-viewer-controls')) return
    // A mouse is one pointer: a release outside the window left nothing to end the last press.
    if (e.pointerType === 'mouse') pointers.current.clear()
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 1) {
      swallowClick.current = false
      gesture.current = { startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false, pinch: null }
    } else if (gesture.current) {
      gesture.current.moved = true
    }
  }

  const onPointerMove = (e) => {
    const g = gesture.current
    if (!g || !pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const points = [...pointers.current.values()]
    if (points.length >= 2) {
      const [a, b] = points
      const pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      if (g.pinch && g.pinch.dist > 0) {
        const r = viewportRef.current.getBoundingClientRect()
        act.zoom(pinch.dist / g.pinch.dist, pinch.x - r.left, pinch.y - r.top)
        act.pan(pinch.x - g.pinch.x, pinch.y - g.pinch.y)
      }
      g.pinch = pinch
      return
    }
    if (!g.moved && Math.hypot(e.clientX - g.startX, e.clientY - g.startY) > DRAG_SLOP) {
      g.moved = true
      setDragging(true)
      viewportRef.current.setPointerCapture?.(e.pointerId)
    }
    if (g.moved) act.pan(e.clientX - g.lastX, e.clientY - g.lastY)
    g.lastX = e.clientX
    g.lastY = e.clientY
  }

  const onPointerEnd = (e) => {
    if (!pointers.current.delete(e.pointerId)) return
    const g = gesture.current
    if (g?.moved) swallowClick.current = true
    const [left] = [...pointers.current.values()]
    if (left && g) {
      g.pinch = null
      g.lastX = left.x
      g.lastY = left.y
    } else {
      gesture.current = null
      setDragging(false)
    }
  }

  const onClickCapture = (e) => {
    if (!swallowClick.current) return
    swallowClick.current = false
    e.stopPropagation()
    e.preventDefault()
  }

  const layout = measured(box) ? planLayout({ ...box, aspect, ...view }) : null
  const fitted = view.zoom <= 1
  const pannable = !!layout && (layout.w + 2 * box.ix > box.vw + 0.5 || layout.h + 2 * box.iy > box.vh + 0.5)

  return (
    <div className="plan-viewer modal-fill">
      <div
        ref={viewportRef}
        className={`plan-viewer-viewport${pannable ? ' is-pannable' : ''}${dragging ? ' is-dragging' : ''}`}
        role="group"
        aria-label={`Plan of ${area.area_name}`}
        aria-describedby={hintId}
        data-zoom={view.zoom.toFixed(3)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onClickCapture={onClickCapture}
      >
        <div
          className="plan-viewer-stage"
          style={layout
            ? { width: `${layout.w + 2 * box.ix}px`, left: `${layout.x}px`, top: `${layout.y}px` }
            : { visibility: 'hidden' }}
        >
          <AreaPlan area={area}>{children}</AreaPlan>
        </div>
        <div className="plan-viewer-controls" role="group" aria-label="Zoom">
          <TipButton label="Zoom in" tip="Zoom in (+)" aria-keyshortcuts="+" inactive={view.zoom >= PLAN_ZOOM_CAP} onClick={() => act.zoom(PLAN_ZOOM_STEP)}>
            <IconZoomIn size={16} />
          </TipButton>
          <TipButton label="Zoom out" tip="Zoom out (−)" aria-keyshortcuts="-" inactive={fitted} onClick={() => act.zoom(1 / PLAN_ZOOM_STEP)}>
            <IconZoomOut size={16} />
          </TipButton>
          <TipButton label="Fit" tip="Fit the whole plan in view (0)" aria-keyshortcuts="0" inactive={fitted} onClick={act.fit}>
            <IconScan size={16} />
          </TipButton>
        </div>
      </div>
      <p className="expanded-view-hint" id={hintId}>Drag to pan · scroll to zoom · + and − zoom, 0 fits, the arrow keys pan</p>
    </div>
  )
}

/**
 * The expanded plan: `area`'s name as the title, the viewer filling the window under it, and
 * `children` as its pins. `headerActions` sit beside the close button (the Site Map's legend).
 */
export function ExpandedPlanModal({ area, onClose, headerActions = null, children }) {
  const AreaGlyph = areaIconComponent(area.icon)
  return (
    <Modal
      title={area.area_name}
      icon={<AreaGlyph size={18} />}
      size="full"
      fill
      onClose={onClose}
      headerActions={headerActions}
    >
      <PlanViewer area={area}>{children}</PlanViewer>
    </Modal>
  )
}
