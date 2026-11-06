import React from 'react'
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { AreaPlan, AreaPlanPin } from '../components/common/AreaPlan'
import { AreaPlanPanel } from '../components/common/AreaPlanPanel'
import { CellPlacementPicker } from '../components/common/CellPlacementPicker'
import { PlanViewer } from '../components/common/PlanViewer'
import { api } from '../api'
import { tooltipOf } from '../test/tooltips'
import { areaUrl } from '../routes'

/**
 * A plan turned on screen (plan_rotation). The image turns about the frame's centre; the pins stay
 * upright and are placed where the turn puts their place; a click is turned back into the drawing
 * as uploaded; and the expanded viewer fits the turned frame. The panel's Turn left and Turn right
 * turn a draft the preview draws, and Save Turn writes it once, says so and reloads. jsdom lays
 * nothing out, so the boxes are given sizes here.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    loadAreaPlanUrl: vi.fn().mockResolvedValue('blob:plan-1'),
    api: { setAreaPlanRotation: vi.fn(), uploadAreaPlan: vi.fn(), removeAreaPlan: vi.fn() }
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
  const props = (extra = {}) => ({ area: turned(90), cells: [], canManage: true, showToast: vi.fn(), onChanged: vi.fn(), ...extra })
  const panel = (extra = {}) => render(<AreaPlanPanel {...props(extra)} />)
  const actions = () => document.querySelector('.area-plan-panel-actions')
  const press = (name) => fireEvent.click(screen.getByRole('button', { name }))
  /** The turn the panel's preview is drawn at. */
  const drawn = () => Number(document.querySelector('.area-plan').dataset.rotation ?? 0)

  it('sit in a row of their own under the heading, with Replace plan and Remove plan apart under the card, labelled and described', () => {
    panel()
    const names = within(actions()).getAllByRole('button').map(b => b.textContent.trim())
    expect(names).toEqual(['Turn left', 'Turn right'])
    // Not in the heading's row, and above the plan's card.
    expect(actions().closest('.area-plan-panel-header')).toBeNull()
    expect(document.querySelector('.area-plan-panel-header').compareDocumentPosition(actions()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(actions().compareDocumentPosition(document.querySelector('.plan-card')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Away from the turns, so a missed Turn right cannot open a file dialog.
    const fileButtons = document.querySelector('.area-plan-panel-buttons')
    expect(within(fileButtons).getAllByRole('button').map(b => b.textContent.trim())).toEqual(['Replace plan', 'Remove plan'])
    expect(document.querySelector('.plan-card').compareDocumentPosition(fileButtons) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(tooltipOf(screen.getByRole('button', { name: 'Turn left' }))).toMatch(/anticlockwise/)
    expect(tooltipOf(screen.getByRole('button', { name: 'Turn right' }))).toMatch(/clockwise/)
    expect(screen.getByRole('button', { name: 'Turn right' }).querySelector('svg')).not.toBeNull()
  })

  it('turn the preview at once, and write nothing until Save Turn', () => {
    const onChanged = vi.fn()
    const area = turned(90)
    panel({ area, onChanged })

    press('Turn right')
    expect(drawn()).toBe(180)
    press('Turn left')
    press('Turn left')
    expect(drawn()).toBe(0)
    expect(api.setAreaPlanRotation).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
    // The page's copy is the saved turn, which the Site Map, the Cells page and the table read.
    expect(area.plan_rotation).toBe(90)
  })

  it('offer Save Turn and Discard beside them while the turn is unsaved, as the Settings page offers Save and Discard', () => {
    panel()
    expect(screen.queryByRole('button', { name: 'Save Turn' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Discard/ })).toBeNull()
    const [left, right] = within(actions()).getAllByRole('button')

    press('Turn right')
    const names = within(actions()).getAllByRole('button').map(b => b.textContent.trim())
    expect(names).toEqual(['Turn left', 'Turn right', 'Save Turn', 'Discard'])
    // The pair is added after the turns, which stay the row's first two, so they do not move.
    expect(within(actions()).getAllByRole('button').slice(0, 2)).toEqual([left, right])
    expect(screen.getByRole('button', { name: 'Save Turn' })).toHaveClass('btn', 'btn-primary', 'btn-sm')
    expect(screen.getByRole('button', { name: 'Save Turn' }).closest('.setting-actions')).not.toBeNull()
  })

  it('save several turns as one write of the last, then reload the page, and wait for it', async () => {
    let finish
    const onChanged = vi.fn(() => new Promise(resolve => { finish = resolve }))
    api.setAreaPlanRotation.mockResolvedValue({})
    const { rerender } = panel({ onChanged })

    press('Turn right')
    press('Turn right')
    press('Turn left')
    press('Turn left')
    press('Turn left')
    await act(async () => { press('Save Turn') })
    expect(api.setAreaPlanRotation).toHaveBeenCalledTimes(1)
    expect(api.setAreaPlanRotation).toHaveBeenCalledWith(expect.objectContaining({ area_id: 'a', plan_rotation: 90 }), 0)
    expect(onChanged).toHaveBeenCalledTimes(1)
    // Held until the page has the saved turn.
    for (const name of ['Turn left', 'Turn right', 'Save Turn', 'Discard']) {
      expect(screen.getByRole('button', { name })).toBeDisabled()
    }
    expect(drawn()).toBe(0)

    rerender(<AreaPlanPanel {...props({ area: turned(0), onChanged })} />)
    await act(async () => { finish() })
    expect(screen.queryByRole('button', { name: 'Save Turn' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Turn left' })).toBeEnabled()
    expect(drawn()).toBe(0)
  })

  it('say what Save Turn saved, once, naming the area and linking to it', async () => {
    api.setAreaPlanRotation.mockResolvedValue({})
    const showToast = vi.fn()
    const { unmount } = panel({ showToast })
    press('Turn right')
    await act(async () => { press('Save Turn') })
    expect(showToast).toHaveBeenCalledTimes(1)
    expect(showToast).toHaveBeenCalledWith('Plan of Assembly Hall turned 180° clockwise', 'success', { to: areaUrl('a') })
    unmount()

    // Back to the drawing as uploaded, which is no turn at all.
    showToast.mockClear()
    panel({ showToast })
    press('Turn left')
    await act(async () => { press('Save Turn') })
    expect(showToast).toHaveBeenCalledWith('Plan of Assembly Hall turned back to how it was drawn', 'success', { to: areaUrl('a') })
  })

  it('offer nothing to save once the turns come back to the saved one', () => {
    panel()
    press('Turn left')
    press('Turn right')
    expect(screen.queryByRole('button', { name: 'Save Turn' })).toBeNull()
    for (let i = 0; i < 4; i++) press('Turn right')
    expect(screen.queryByRole('button', { name: 'Save Turn' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Discard/ })).toBeNull()
    expect(drawn()).toBe(90)
    expect(screen.getByRole('button', { name: /Replace plan/ })).toBeEnabled()
  })

  it('put the preview back to the saved turn on Discard, with no request', () => {
    panel()
    press('Turn left')
    expect(drawn()).toBe(0)
    press('Discard')
    expect(drawn()).toBe(90)
    expect(screen.queryByRole('button', { name: 'Save Turn' })).toBeNull()
    expect(api.setAreaPlanRotation).not.toHaveBeenCalled()
  })

  it('grey out Replace plan and Remove plan while a turn is unsaved, and say why', () => {
    panel()
    const replace = () => screen.getByRole('button', { name: /Replace plan/ })
    const remove = () => screen.getByRole('button', { name: /Remove plan/ })
    expect(tooltipOf(remove())).toBe('The area keeps the default outline')

    press('Turn right')
    for (const button of [replace(), remove()]) {
      expect(button).toBeDisabled()
      expect(button).toHaveClass('btn-disabled')
      expect(tooltipOf(button)).toBe('Save or discard the turn first.')
    }

    press('Discard')
    for (const button of [replace(), remove()]) {
      expect(button).toBeEnabled()
      expect(button).not.toHaveClass('btn-disabled')
    }
    expect(tooltipOf(replace())).toBeNull()
    expect(tooltipOf(remove())).toBe('The area keeps the default outline')
  })

  it('drop an unsaved turn when the panel turns to another area', () => {
    const other = { ...turned(90), area_id: 'b', area_name: 'Paint Shop' }
    const { rerender } = panel()
    press('Turn right')
    expect(screen.getByRole('button', { name: 'Save Turn' })).toBeInTheDocument()

    rerender(<AreaPlanPanel {...props({ area: other })} />)
    expect(screen.queryByRole('button', { name: 'Save Turn' })).toBeNull()
    expect(drawn()).toBe(90)
    // Gone, not set aside: coming back to the first area shows its saved turn.
    rerender(<AreaPlanPanel {...props()} />)
    expect(screen.queryByRole('button', { name: 'Save Turn' })).toBeNull()
    expect(drawn()).toBe(90)
  })

  it('say why a save failed, and keep the turn to save again or discard', async () => {
    const showToast = vi.fn()
    api.setAreaPlanRotation.mockRejectedValue(new Error('You do not have permission to change this area.'))
    const onChanged = vi.fn()
    panel({ showToast, onChanged })
    press('Turn left')
    await act(async () => { press('Save Turn') })
    expect(showToast).toHaveBeenCalledWith('You do not have permission to change this area.', 'error')
    expect(showToast).toHaveBeenCalledTimes(1)
    expect(onChanged).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Save Turn' })).toBeEnabled()
    expect(drawn()).toBe(0)
  })

  it('are offered only on a plan, to somebody who may upload one', () => {
    const { unmount } = panel({ area: { ...WIDE, plan_path: null, plan_aspect: null, plan_rotation: 0 } })
    expect(screen.queryByRole('button', { name: /Turn left|Turn right/ })).toBeNull()
    unmount()
    panel({ canManage: false })
    expect(screen.queryByRole('button', { name: /Turn left|Turn right/ })).toBeNull()
  })
})
