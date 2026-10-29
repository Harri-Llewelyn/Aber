import React from 'react'
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { AreaPlan, AreaPlanPin } from '../components/common/AreaPlan'
import { AreaPlanPanel } from '../components/common/AreaPlanPanel'
import { CellPlacementPicker } from '../components/common/CellPlacementPicker'
import { PlanViewer } from '../components/common/PlanViewer'
import { api } from '../api'
import { tooltipOf } from '../test/tooltips'

/**
 * A plan turned on screen (plan_rotation). The image turns about the frame's centre; the pins stay
 * upright and are placed where the turn puts their place; a click is turned back into the drawing
 * as uploaded; and the expanded viewer fits the turned frame. The panel's Turn left and Turn right
 * write one turn each and reload. jsdom lays nothing out, so the boxes are given sizes here.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    loadAreaPlanUrl: vi.fn().mockResolvedValue('blob:plan-1'),
    api: { turnAreaPlan: vi.fn(), uploadAreaPlan: vi.fn(), removeAreaPlan: vi.fn() }
  }
})

const WIDE = { area_id: 'a', area_name: 'Assembly Hall', plan_path: 'a/plan-1.svg', plan_aspect: 2 }
const turned = (plan_rotation) => ({ ...WIDE, plan_rotation })

/** Gives every `.area-plan-drawing` the box a frame `width` wide at the plan's frame aspect would have. */
const sizeDrawing = (width, height) => {
  const drawing = document.querySelector('.area-plan-drawing')
  drawing.getBoundingClientRect = () => ({ left: 0, top: 0, width, height, right: width, bottom: height })
}

beforeEach(() => vi.clearAllMocks())

describe('AreaPlan turned', () => {
  it('draws the frame on its side and turns the image about its centre', async () => {
    render(<AreaPlan area={turned(90)} />)
    const plan = document.querySelector('.area-plan')
    expect(plan.style.getPropertyValue('--plan-aspect')).toBe('0.5')
    expect(plan.dataset.rotation).toBe('90')
    expect(parseFloat(document.querySelector('.area-plan-drawing').style.aspectRatio)).toBe(0.5)
    await waitFor(() => expect(document.querySelector('.area-plan-image')).not.toBeNull())
    const image = document.querySelector('.area-plan-image')
    // Laid out at the drawing's own 2:1, the frame's height wide and its width high, then turned.
    expect(image.style.width).toBe('200%')
    expect(image.style.height).toBe('50%')
    expect(image.style.left).toBe('50%')
    expect(image.style.top).toBe('50%')
    expect(image.style.transform).toBe('translate(-50%, -50%) rotate(90deg)')
  })

  it('leaves an unturned plan as it was drawn before', async () => {
    render(<AreaPlan area={turned(0)} />)
    expect(document.querySelector('.area-plan').style.getPropertyValue('--plan-aspect')).toBe('2')
    expect(document.querySelector('.area-plan').dataset.rotation).toBeUndefined()
    await waitFor(() => expect(document.querySelector('.area-plan-image')).not.toBeNull())
    expect(document.querySelector('.area-plan-image').getAttribute('style')).toBeNull()
  })

  it('turns half way without changing the frame', async () => {
    render(<AreaPlan area={turned(180)} />)
    expect(document.querySelector('.area-plan').style.getPropertyValue('--plan-aspect')).toBe('2')
    await waitFor(() => expect(document.querySelector('.area-plan-image')).not.toBeNull())
    const image = document.querySelector('.area-plan-image')
    expect([image.style.width, image.style.height]).toEqual(['100%', '100%'])
    expect(image.style.transform).toBe('translate(-50%, -50%) rotate(180deg)')
  })

  it('puts each pin where the turn puts its place, and keeps the pin upright', () => {
    const pins = (rotation) => render(
      <AreaPlan area={turned(rotation)}>
        <AreaPlanPin x={0.25} y={0.1} label="Door" />
      </AreaPlan>
    )
    const at = () => {
      const pin = screen.getByText('Door').closest('.area-plan-pin')
      return [parseFloat(pin.style.left), parseFloat(pin.style.top), pin.style.transform]
    }
    const expected = { 0: [25, 10], 90: [90, 25], 180: [75, 90], 270: [10, 75] }
    for (const [rotation, [left, top]] of Object.entries(expected)) {
      const { unmount } = pins(Number(rotation))
      const [l, t, transform] = at()
      expect(l).toBeCloseTo(left, 9)
      expect(t).toBeCloseTo(top, 9)
      // No rotate on the pin: its label reads the right way up at every turn.
      expect(transform).toBe('')
      unmount()
    }
  })

  it('slides a pin\'s label by where it is drawn, not where it is on the file', async () => {
    render(
      <AreaPlan area={turned(90)}>
        <AreaPlanPin x={0.25} y={0.1} label="Door" />
      </AreaPlan>
    )
    expect(Number(screen.getByText('Door').closest('.area-plan-pin').style.getPropertyValue('--pin-x'))).toBeCloseTo(0.9, 9)
    await waitFor(() => expect(document.querySelector('.area-plan-image')).not.toBeNull())
  })

  it('turns a click back into the place on the drawing as uploaded', () => {
    for (const [rotation, width, height, clientX, clientY] of [
      [0, 200, 100, 50, 10], [90, 100, 200, 90, 50], [180, 200, 100, 150, 90], [270, 100, 200, 10, 150]
    ]) {
      const onPlaceClick = vi.fn()
      const { unmount } = render(<AreaPlan area={turned(rotation)} onPlaceClick={onPlaceClick} />)
      sizeDrawing(width, height)
      fireEvent.click(document.querySelector('.area-plan'), { clientX, clientY })
      expect(onPlaceClick).toHaveBeenCalledWith({ x: 0.25, y: 0.1 })
      unmount()
    }
  })
})

describe('placing a cell on a turned plan', () => {
  const others = [{ cell_id: 'press', cell_name: 'Press', area_id: 'a', plan_x: 0.25, plan_y: 0.1 }]

  it('refuses a click too close to a neighbour as it does unturned, and keeps one clear of it', () => {
    for (const rotation of [0, 90, 180, 270]) {
      const onChange = vi.fn()
      const { unmount } = render(
        <CellPlacementPicker area={turned(rotation)} cells={others} cellId="new" value={null} onChange={onChange} minSpacing={0.08} />
      )
      const [width, height] = rotation % 180 ? [100, 200] : [200, 100]
      sizeDrawing(width, height)
      // The drawing's (0.25, 0.08), just below the Press, wherever the turn draws it.
      const near = { 0: [50, 8], 90: [92, 50], 180: [150, 92], 270: [8, 150] }[rotation]
      fireEvent.click(document.querySelector('.area-plan'), { clientX: near[0], clientY: near[1] })
      expect(onChange).not.toHaveBeenCalled()
      expect(screen.getByRole('alert')).toHaveTextContent("Too close to 'Press'")

      fireEvent.click(document.querySelector('.area-plan'), { clientX: width / 2, clientY: height / 2 })
      expect(onChange).toHaveBeenCalledWith({ x: 0.5, y: 0.5 })
      unmount()
    }
  })

  it('says the place as the plan is drawn', async () => {
    render(<CellPlacementPicker area={turned(90)} cells={[]} cellId="new" value={{ x: 0.25, y: 0.1 }} onChange={vi.fn()} />)
    expect(screen.getByText(/Placed 90% across, 25% down\./)).toBeInTheDocument()
    await waitFor(() => expect(document.querySelector('.area-plan-image')).not.toBeNull())
  })
})

describe('the expanded plan, turned', () => {
  let restore
  beforeAll(() => {
    const own = (name) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
    const saved = { clientWidth: own('clientWidth'), clientHeight: own('clientHeight') }
    const sized = (name, value) => Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get() { return this.classList?.contains('plan-viewer-viewport') ? value : saved[name]?.get?.call(this) ?? 0 }
    })
    sized('clientWidth', 1000)
    sized('clientHeight', 500)
    restore = () => {
      for (const [name, descriptor] of Object.entries(saved)) {
        if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
      }
    }
  })
  afterAll(() => restore())

  it('fits the turned frame: a 2:1 plan on its side is 250 wide in a 1000 by 500 window', () => {
    const { unmount } = render(<PlanViewer area={turned(0)} />)
    expect(document.querySelector('.plan-viewer-stage').style.width).toBe('1000px')
    unmount()
    render(<PlanViewer area={turned(90)} />)
    expect(document.querySelector('.plan-viewer-stage').style.width).toBe('250px')
  })
})

describe('Turn left and Turn right', () => {
  const panel = (props = {}) => render(
    <AreaPlanPanel area={turned(90)} cells={[]} canManage showToast={vi.fn()} onChanged={vi.fn()} {...props} />
  )
  const actions = () => document.querySelector('.area-plan-panel-actions')

  it('sit beside Replace plan and Remove plan, labelled and described', () => {
    panel()
    const names = within(actions()).getAllByRole('button').map(b => b.textContent.trim())
    expect(names).toEqual(['Turn left', 'Turn right', 'Replace plan', 'Remove plan'])
    expect(tooltipOf(screen.getByRole('button', { name: 'Turn left' }))).toMatch(/anticlockwise/)
    expect(tooltipOf(screen.getByRole('button', { name: 'Turn right' }))).toMatch(/clockwise/)
    expect(screen.getByRole('button', { name: 'Turn right' }).querySelector('svg')).not.toBeNull()
  })

  it('each write one turn, then reload the page, and wait for it', async () => {
    let finish
    const onChanged = vi.fn(() => new Promise(resolve => { finish = resolve }))
    api.turnAreaPlan.mockResolvedValue({})
    panel({ onChanged })

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Turn right' })) })
    expect(api.turnAreaPlan).toHaveBeenCalledWith(expect.objectContaining({ area_id: 'a', plan_rotation: 90 }), 1)
    expect(onChanged).toHaveBeenCalledTimes(1)
    // Held until the page has the new turn, so a second press starts from it.
    expect(screen.getByRole('button', { name: 'Turn left' })).toBeDisabled()
    await act(async () => { finish() })
    expect(screen.getByRole('button', { name: 'Turn left' })).toBeEnabled()

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Turn left' })) })
    expect(api.turnAreaPlan).toHaveBeenLastCalledWith(expect.objectContaining({ area_id: 'a' }), -1)
  })

  it('says why a turn failed', async () => {
    const showToast = vi.fn()
    api.turnAreaPlan.mockRejectedValue(new Error('You do not have permission to change this area.'))
    panel({ showToast })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Turn left' })) })
    expect(showToast).toHaveBeenCalledWith('You do not have permission to change this area.', 'error')
  })

  it('are offered only on a plan, to somebody who may upload one', () => {
    const { unmount } = panel({ area: { ...WIDE, plan_path: null, plan_aspect: null, plan_rotation: 0 } })
    expect(screen.queryByRole('button', { name: /Turn left|Turn right/ })).toBeNull()
    unmount()
    panel({ canManage: false })
    expect(screen.queryByRole('button', { name: /Turn left|Turn right/ })).toBeNull()
  })
})
