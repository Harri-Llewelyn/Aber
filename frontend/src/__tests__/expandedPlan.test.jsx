import React from 'react'
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'
import { SiteMapTab } from '../components/tabs/SiteMapTab'
import { AreaPlanPanel } from '../components/common/AreaPlanPanel'
import { ExpandablePlanPreview } from '../components/common/AreaPlanPreview'
import { TOOLTIP_DELAY_MS } from '../components/common/Tooltip'
import { api } from '../api'

/**
 * The Expand button on an area's plan, in the three places a plan is drawn: the Site Map's area
 * card, the Areas panel's heading and beside the Cells panel's preview. Each opens the plan in a
 * window-sized dialog without opening what the button sits on, and the dialog hands focus back.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
    loadAreaPlanUrl: vi.fn().mockResolvedValue('blob:plan')
  }
})

const SHOP = { area_id: 'area-1', area_name: 'North Shop', icon: 'Factory', plan_path: null, plan_aspect: null, is_archived: false }
const YARD = { area_id: 'area-2', area_name: 'Yard', icon: 'Trees', plan_path: null, plan_aspect: null, is_archived: false }
const OFFICE = { area_id: 'area-3', area_name: 'Office Floor', icon: 'Building2', plan_path: 'area-3/plan.svg', plan_aspect: 2, is_archived: false }

const cell = (id, name, area, x, y, extra = {}) => ({
  cell_id: id, cell_name: name, area_id: area, plan_x: x, plan_y: y, is_archived: false, gateways: [], gateway_count: 0, ...extra
})
const CELLS = [
  cell('cell-1', 'Assembly Line 1', 'area-1', 0.3, 0.4),
  cell('cell-2', 'Paint Booth', 'area-1', 0.7, 0.6),
  // Filed in the Yard with no place: the Yard's outline has no pin, so nothing to enlarge.
  cell('cell-3', 'Gatehouse', 'area-2', null, null),
]
const DEVICE = {
  asset_id: 'dev-1', asset_name: 'CNC_01', sparkplug_id: 'spb-1', status: 'ONLINE', is_quarantined: false,
  is_archived: false, active_gateway_id: 'gw-1', cell_id: 'cell-1', location_scope: 'cell',
  effective_cell_id: 'cell-1', location_source: 'explicit'
}

const renderMap = () => {
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/cells')) return Promise.resolve(CELLS)
    if (path.startsWith('/api/v1/areas')) return Promise.resolve([SHOP, YARD])
    if (path.startsWith('/api/v1/devices')) return Promise.resolve([DEVICE])
    return Promise.resolve([])
  })
  return render(
    <SiteMapTab
      onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} onSelectCell={vi.fn()}
      showToast={vi.fn()} hasPermission={() => true} onNavigateTab={vi.fn()}
    />
  )
}

const card = (name) => screen.getByRole('button', { name }).closest('.area-card')
const dialog = () => document.querySelector('dialog[open]')
const esc = () => fireEvent.keyDown(document, { key: 'Escape' })
/** Focused first, as a real press focuses it: the dialog hands focus back to what had it. */
const press = (button) => { button.focus(); fireEvent.click(button) }

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/site-map')
})

// jsdom lays nothing out: the viewer's viewport is given a size, or the plan is never placed.
let restoreSize
beforeAll(() => {
  const saved = ['clientWidth', 'clientHeight'].map(name => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)])
  for (const [name, descriptor] of saved) {
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get() { return this.classList?.contains('plan-viewer-viewport') ? (name === 'clientWidth' ? 1000 : 500) : descriptor?.get?.call(this) ?? 0 }
    })
  }
  restoreSize = () => { for (const [name, descriptor] of saved) if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor) }
})
afterAll(() => restoreSize())

describe('the Site Map', () => {
  it('offers Expand on a card with something to enlarge, and only there', async () => {
    renderMap()
    await screen.findByRole('button', { name: 'North Shop' })
    expect(within(card('North Shop')).getByRole('button', { name: 'Expand plan: North Shop' })).toBeInTheDocument()
    expect(within(card('Yard')).queryByRole('button', { name: /Expand plan/ })).toBeNull()
  })

  it('puts Expand in the corner of the plan\'s space, beside the plan and out of the header', async () => {
    renderMap()
    await screen.findByRole('button', { name: 'North Shop' })
    const expand = within(card('North Shop')).getByRole('button', { name: 'Expand plan: North Shop' })
    expect(expand.closest('.area-card-header')).toBeNull()
    expect(expand).toHaveClass('expand-corner')
    const frame = expand.parentElement
    expect(frame).toHaveClass('expand-frame', 'expand-frame-fill')
    expect(frame.querySelector(':scope > .area-plan')).not.toBeNull()
    // The pins are the plan's, under the button, not the button's.
    expect(expand.querySelector('.area-plan-pin')).toBeNull()
  })

  it('opens the plan in a window-sized dialog titled with the area, and not the area panel', async () => {
    renderMap()
    await screen.findByRole('button', { name: 'North Shop' })
    press(within(card('North Shop')).getByRole('button', { name: 'Expand plan: North Shop' }))

    const open = dialog()
    expect(open).not.toBeNull()
    expect(open.querySelector('.modal')).toHaveClass('modal-full')
    expect(within(open).getByRole('heading', { name: 'North Shop' })).toBeInTheDocument()
    // The legend, repeated in the header.
    expect(open.querySelector('.modal-header-controls .shopfloor-legend')).not.toBeNull()
    // The pins are live, coloured from the same data as the card.
    expect(within(open).getByRole('button', { name: 'Assembly Line 1' })).toHaveAttribute('data-status', 'normal')
    expect(within(open).getByRole('button', { name: 'Paint Booth' })).toHaveAttribute('data-status', 'idle')
    expect(window.location.search).not.toMatch(/area=/)
    expect(card('North Shop')).not.toHaveClass('is-selected')
  })

  it('closes on Escape and hands focus back to the Expand button', async () => {
    renderMap()
    await screen.findByRole('button', { name: 'North Shop' })
    const expand = within(card('North Shop')).getByRole('button', { name: 'Expand plan: North Shop' })
    press(expand)
    expect(document.activeElement.closest('dialog')).toBe(dialog())
    esc()
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(expand)
  })

  it('closes and opens the cell\'s panel when a pin in it is clicked', async () => {
    renderMap()
    await screen.findByRole('button', { name: 'North Shop' })
    press(within(card('North Shop')).getByRole('button', { name: 'Expand plan: North Shop' }))
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Paint Booth' }))

    expect(dialog()).toBeNull()
    expect(window.location.search).toMatch(/cell=cell-2/)
    await waitFor(() => expect(within(card('North Shop')).getByRole('button', { name: 'Paint Booth' })).toHaveAttribute('aria-pressed', 'true'))
  })

  it('opens the cell rather than toggling it shut when its panel is already open', async () => {
    window.history.replaceState(null, '', '/site-map?cell=cell-2')
    renderMap()
    await screen.findByRole('button', { name: 'North Shop' })
    press(within(card('North Shop')).getByRole('button', { name: 'Expand plan: North Shop' }))
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Paint Booth' }))
    expect(window.location.search).toMatch(/cell=cell-2/)
  })

  it('does not count a drag that starts on a pin as a click on it', async () => {
    renderMap()
    await screen.findByRole('button', { name: 'North Shop' })
    press(within(card('North Shop')).getByRole('button', { name: 'Expand plan: North Shop' }))
    const pin = within(dialog()).getByRole('button', { name: 'Paint Booth' })
    const at = { pointerId: 7, pointerType: 'mouse', button: 0 }
    fireEvent.pointerDown(pin, { ...at, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(dialog().querySelector('.plan-viewer-viewport'), { ...at, clientX: 140, clientY: 120 })
    fireEvent.pointerUp(pin, { ...at, clientX: 140, clientY: 120 })
    fireEvent.click(pin)

    expect(dialog()).not.toBeNull()
    expect(window.location.search).not.toMatch(/cell=/)
  })

  it('says "Expand plan" in the shared tooltip, not a title', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      renderMap()
      await screen.findByRole('button', { name: 'North Shop' })
      const expand = within(card('North Shop')).getByRole('button', { name: 'Expand plan: North Shop' })
      expect(expand).not.toHaveAttribute('title')
      fireEvent.mouseEnter(expand)
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS + 10)
      await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('Expand plan'))
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the Areas panel', () => {
  const panel = (props) => render(
    <AreaPlanPanel area={SHOP} cells={CELLS.filter(c => c.area_id === 'area-1')} canManage={false} showToast={vi.fn()} onChanged={vi.fn()} onOpen={vi.fn()} {...props} />
  )

  it("puts Expand on the preview's card for a reader, and opens the plan with its pins as marks", () => {
    const onOpen = vi.fn()
    panel({ onOpen })
    const expand = screen.getByRole('button', { name: 'Expand plan: North Shop' })
    expect(expand.closest('.area-plan-panel-header')).toBeNull()
    expect(expand.closest('.plan-card')).toBe(screen.getByRole('link', { name: 'Open North Shop on the Site Map' }).closest('.plan-card'))
    press(expand)

    expect(within(dialog()).getByRole('heading', { name: 'North Shop' })).toBeInTheDocument()
    const pins = dialog().querySelectorAll('.area-plan-pin')
    expect(pins).toHaveLength(2)
    for (const pin of pins) expect(pin.tagName).toBe('SPAN')
    // Full size in the dialog, small in the preview.
    expect(dialog().querySelector('.area-plan-pin-small')).toBeNull()
    expect(onOpen).not.toHaveBeenCalled()
    esc()
    expect(document.activeElement).toBe(expand)
  })

  it('keeps Replace and Remove in the heading, and Expand on the card, for a plan a manager may change', () => {
    panel({ area: OFFICE, cells: [], canManage: true })
    const expand = screen.getByRole('button', { name: 'Expand plan: Office Floor' })
    expect(screen.getByRole('button', { name: /Replace plan/ }).closest('.area-plan-panel-header')).not.toBeNull()
    expect(screen.getByRole('button', { name: /Remove plan/ }).closest('.area-plan-panel-header')).not.toBeNull()
    expect(expand.closest('.area-plan-panel-header')).toBeNull()
    expect(expand.closest('.plan-card')).not.toBeNull()
  })

  it('offers none where the drop zone stands in for the plan, or the outline has no pin', () => {
    const { unmount } = panel({ canManage: true })
    expect(screen.queryByRole('button', { name: /Expand plan/ })).toBeNull()
    unmount()
    panel({ area: YARD, cells: CELLS.filter(c => c.area_id === 'area-2') })
    expect(screen.queryByRole('button', { name: /Expand plan/ })).toBeNull()
  })
})

describe('the Cells panel', () => {
  it("opens the plan from the preview's card, the cell ringed and the rest dimmed, without following the link", () => {
    const onOpen = vi.fn()
    render(<ExpandablePlanPreview area={SHOP} cells={CELLS} highlightCellId="cell-1" onOpen={onOpen} />)
    const expand = screen.getByRole('button', { name: 'Expand plan: North Shop' })
    // On the preview's card, beside its link rather than inside it.
    expect(expand.closest('a')).toBeNull()
    expect(expand.parentElement).toBe(screen.getByRole('link', { name: 'Open North Shop on the Site Map' }).parentElement)
    expect(expand.parentElement).toHaveClass('expand-frame', 'plan-card')
    press(expand)

    expect(onOpen).not.toHaveBeenCalled()
    const pins = [...dialog().querySelectorAll('.area-plan-pin')]
    const subject = pins.find(p => p.textContent === 'Assembly Line 1')
    const other = pins.find(p => p.textContent === 'Paint Booth')
    expect(subject).toHaveClass('area-plan-pin-selected')
    expect(other).toHaveClass('area-plan-pin-muted')
    expect(other).not.toHaveClass('area-plan-pin-selected')
    esc()
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(expand)
  })
})
