import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import {
  PlanViewer, ExpandedPlanModal, planLayout, zoomAbout, panBy, clampZoom,
  PLAN_ZOOM_CAP, PLAN_ZOOM_STEP, PLAN_PAN_STEP, DRAG_SLOP
} from '../components/common/PlanViewer'
import { AreaPlanPin } from '../components/common/AreaPlan'
import { dialogIsOpen, singleKeyShortcutAllowed } from '../shortcuts'

/**
 * The expanded plan's viewer: the geometry that keeps the plan between fitted and the cap and in
 * view, and the component's wheel, keys, buttons and drags. jsdom lays nothing out, so the viewport
 * is given a size here and the plan's margins read as 0.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, loadAreaPlanUrl: vi.fn().mockResolvedValue('blob:plan') }
})

const VW = 1000
const VH = 500
const BOX = { vw: VW, vh: VH, ix: 24, iy: 34 }
const ASPECT = 2

let restore
beforeAll(() => {
  const own = (name) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
  const saved = { clientWidth: own('clientWidth'), clientHeight: own('clientHeight') }
  const sized = (name, value) => Object.defineProperty(HTMLElement.prototype, name, {
    configurable: true,
    get() { return this.classList?.contains('plan-viewer-viewport') ? value : saved[name]?.get?.call(this) ?? 0 }
  })
  sized('clientWidth', VW)
  sized('clientHeight', VH)
  restore = () => {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
    }
  }
})
afterAll(() => restore())

describe('planLayout', () => {
  it('fits the drawing in the viewport less its margins, and centres it', () => {
    const fitted = planLayout({ ...BOX, aspect: ASPECT })
    // Width-bound: 1000 - 48 = 952 across, against (500 - 68) * 2 = 864 by height.
    expect(fitted.w).toBe(864)
    expect(fitted.h).toBe(432)
    expect(fitted.x).toBeCloseTo((VW - (864 + 48)) / 2)
    expect(fitted.y).toBeCloseTo(0)
  })

  it('keeps a plan larger than the viewport covering it, whatever is asked', () => {
    for (const [fx, fy] of [[-5, -5], [0, 0], [0.5, 0.5], [1, 1], [9, 9]]) {
      const l = planLayout({ ...BOX, aspect: ASPECT, zoom: 3, fx, fy })
      expect(l.x).toBeLessThanOrEqual(0)
      expect(l.x + l.w + 2 * BOX.ix).toBeGreaterThanOrEqual(VW - 1e-9)
      expect(l.y).toBeLessThanOrEqual(0)
      expect(l.y + l.h + 2 * BOX.iy).toBeGreaterThanOrEqual(VH - 1e-9)
    }
  })
})

describe('zoom and pan', () => {
  const fitted = { zoom: 1, fx: 0.5, fy: 0.5 }

  it('stays between fitted and the cap', () => {
    let view = fitted
    for (let i = 0; i < 40; i++) view = zoomAbout(view, BOX, ASPECT, PLAN_ZOOM_STEP, 300, 200)
    expect(view.zoom).toBe(PLAN_ZOOM_CAP)
    for (let i = 0; i < 40; i++) view = zoomAbout(view, BOX, ASPECT, 1 / PLAN_ZOOM_STEP, 300, 200)
    expect(view.zoom).toBe(1)
    expect(clampZoom(0.2)).toBe(1)
    expect(clampZoom(99)).toBe(PLAN_ZOOM_CAP)
  })

  it('keeps the point under the pointer where it was', () => {
    const before = planLayout({ ...BOX, aspect: ASPECT, ...fitted })
    const px = 600
    const py = 300
    const u = (px - before.x - BOX.ix) / before.w
    const view = zoomAbout(fitted, BOX, ASPECT, 2, px, py)
    const after = planLayout({ ...BOX, aspect: ASPECT, ...view })
    expect(after.x + BOX.ix + u * after.w).toBeCloseTo(px)
  })

  it('cannot move a fitted plan, nor a zoomed one out of view', () => {
    expect(panBy(fitted, BOX, ASPECT, 500, 500)).toEqual(fitted)
    let view = zoomAbout(fitted, BOX, ASPECT, 4, VW / 2, VH / 2)
    for (let i = 0; i < 100; i++) view = panBy(view, BOX, ASPECT, 400, -400)
    const l = planLayout({ ...BOX, aspect: ASPECT, ...view })
    expect(l.x).toBeCloseTo(0)
    expect(l.y + l.h + 2 * BOX.iy).toBeCloseTo(VH)
  })
})

const AREA = { area_id: 'a1', area_name: 'North Shop', plan_path: null, plan_aspect: 2, icon: 'Factory' }

const viewport = () => document.querySelector('.plan-viewer-viewport')
const zoom = () => Number(viewport().dataset.zoom)
const stage = () => document.querySelector('.plan-viewer-stage')

describe('PlanViewer', () => {
  it('zooms with the buttons between fitted and the cap, and Fit goes back', () => {
    render(<ExpandedPlanModal area={AREA} onClose={vi.fn()} />)
    expect(zoom()).toBe(1)
    const zoomIn = screen.getByRole('button', { name: 'Zoom in' })
    for (let i = 0; i < 20; i++) fireEvent.click(zoomIn)
    expect(zoom()).toBe(PLAN_ZOOM_CAP)
    expect(zoomIn).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Fit' }))
    expect(zoom()).toBe(1)
    expect(screen.getByRole('button', { name: 'Zoom out' })).toHaveAttribute('aria-disabled', 'true')
    for (let i = 0; i < 5; i++) fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    expect(zoom()).toBe(1)
  })

  it('answers + − 0 and the arrows anywhere in its dialog, and leaves Ctrl + to the browser', () => {
    render(<ExpandedPlanModal area={AREA} onClose={vi.fn()} />)
    const dialog = document.querySelector('dialog')
    fireEvent.keyDown(dialog, { key: '+' })
    expect(zoom()).toBeCloseTo(PLAN_ZOOM_STEP)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Fit' }), { key: '=' })
    expect(zoom()).toBeCloseTo(PLAN_ZOOM_STEP ** 2)
    fireEvent.keyDown(dialog, { key: '-' })
    expect(zoom()).toBeCloseTo(PLAN_ZOOM_STEP)

    const left = parseFloat(stage().style.left)
    const right = fireEvent.keyDown(dialog, { key: 'ArrowRight' })
    expect(right).toBe(false) // handled: the body does not scroll as well
    expect(parseFloat(stage().style.left)).toBeCloseTo(left - PLAN_PAN_STEP)

    fireEvent.keyDown(dialog, { key: '+', ctrlKey: true })
    expect(zoom()).toBeCloseTo(PLAN_ZOOM_STEP)
    fireEvent.keyDown(document.body, { key: '+' })
    expect(zoom()).toBeCloseTo(PLAN_ZOOM_STEP)

    fireEvent.keyDown(dialog, { key: '0' })
    expect(zoom()).toBe(1)
  })

  it('zooms on the wheel about the pointer, and keeps the page from scrolling', () => {
    render(<ExpandedPlanModal area={AREA} onClose={vi.fn()} />)
    const wheel = new WheelEvent('wheel', { deltaY: -500, clientX: 200, clientY: 100, bubbles: true, cancelable: true })
    act(() => { viewport().dispatchEvent(wheel) })
    expect(wheel.defaultPrevented).toBe(true)
    expect(zoom()).toBeGreaterThan(1)
    for (let i = 0; i < 20; i++) act(() => { viewport().dispatchEvent(new WheelEvent('wheel', { deltaY: -500, bubbles: true, cancelable: true })) })
    expect(zoom()).toBe(PLAN_ZOOM_CAP)
  })

  it('leaves the single-key shortcuts standing down while it is open', () => {
    render(<ExpandedPlanModal area={AREA} onClose={vi.fn()} />)
    expect(dialogIsOpen()).toBe(true)
    const question = new KeyboardEvent('keydown', { key: '?' })
    Object.defineProperty(question, 'target', { value: document.querySelector('dialog') })
    expect(singleKeyShortcutAllowed(question, true)).toBe(false)
  })
})

describe('a drag is a pan, not a click', () => {
  const pinned = (onClick) => (
    <PlanViewer area={AREA}>
      <AreaPlanPin x={0.5} y={0.5} label="Paint Booth" status="normal" onClick={onClick} />
    </PlanViewer>
  )
  const press = (el, x, y) => fireEvent.pointerDown(el, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: x, clientY: y })
  const move = (x, y) => fireEvent.pointerMove(viewport(), { pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y })
  const lift = (el, x, y) => fireEvent.pointerUp(el, { pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y })

  it('swallows the click that ends a drag started on a pin', () => {
    const onClick = vi.fn()
    render(pinned(onClick))
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    const pin = screen.getByRole('button', { name: 'Paint Booth' })
    press(pin, 100, 100)
    move(100 + DRAG_SLOP + 20, 100)
    lift(pin, 100 + DRAG_SLOP + 20, 100)
    fireEvent.click(pin)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('lets a press that moved no more than the slop through as a click', () => {
    const onClick = vi.fn()
    render(pinned(onClick))
    const pin = screen.getByRole('button', { name: 'Paint Booth' })
    press(pin, 100, 100)
    move(100 + DRAG_SLOP, 100)
    lift(pin, 100 + DRAG_SLOP, 100)
    fireEvent.click(pin)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('moves a zoomed plan by the drag', () => {
    render(pinned(vi.fn()))
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    const left = parseFloat(stage().style.left)
    press(viewport(), 400, 200)
    move(380, 200)
    move(350, 200)
    lift(viewport(), 350, 200)
    expect(parseFloat(stage().style.left)).toBeCloseTo(left - 50)
  })
})
