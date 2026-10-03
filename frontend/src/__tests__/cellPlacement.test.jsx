/**
 * A cell is placed on its area's plan from its own form: an area, then a click on the plan. The
 * picker refuses a place too close to a neighbour before the database does.
 */
import React from 'react'
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CellsTab } from '../components/tabs/CellsTab'
import { CellPlacementPicker } from '../components/common/CellPlacementPicker'
import { AreaPlanPreview } from '../components/common/AreaPlanPreview'
import { api } from '../api'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const area = { area_id: 'area-1', area_name: 'North Shop', icon: 'Factory', plan_path: null, plan_aspect: null, cells: [] }
const otherArea = { area_id: 'area-2', area_name: 'Annexe', icon: 'Warehouse', plan_path: null, plan_aspect: null, cells: [] }

const cells = [
  { cell_id: 'cell-1', cell_name: 'Bay 1', area_id: 'area-1', plan_x: 0.5, plan_y: 0.5, is_archived: false, gateways: [], gateway_count: 0 },
  { cell_id: 'cell-2', cell_name: 'Bay 2', area_id: 'area-1', plan_x: null, plan_y: null, is_archived: false, gateways: [], gateway_count: 0 }
]

const routeGet = (path) => {
  if (path.startsWith('/api/v1/cells')) return Promise.resolve(cells)
  if (path.startsWith('/api/v1/areas')) return Promise.resolve([area, otherArea])
  if (path.startsWith('/api/v1/settings')) return Promise.resolve([{ key: 'site_map.min_pin_spacing', value: 0.08 }])
  return Promise.resolve([])
}

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation(routeGet)
  api.put.mockResolvedValue({})
  api.post.mockResolvedValue({})
})

/** A drawing 400 wide and 300 tall at the origin, so a click at (200, 150) is the middle. */
const sizePlan = () => {
  const plan = document.querySelector('.area-plan')
  plan.querySelector('.area-plan-drawing').getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300 })
  return plan
}

const renderCells = async () => {
  render(<CellsTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={() => true} />)
  await waitFor(() => expect(screen.getByText('Bay 1')).toBeInTheDocument())
}

describe('CellsTab places a cell on its area plan', () => {
  it('names the area and whether the cell is placed, on the row and in the panel', async () => {
    await renderCells()
    const row1 = screen.getByText('Bay 1').closest('tr')
    expect(within(row1).getByText('North Shop')).toBeInTheDocument()
    expect(within(row1).getByText('placed')).toBeInTheDocument()
    const row2 = screen.getByText('Bay 2').closest('tr')
    expect(within(row2).getByText('not placed')).toBeInTheDocument()

    // The panel draws the place rather than stating fractions of it.
    fireEvent.click(screen.getByText('Bay 1'))
    const panel = document.querySelector('.context-panel')
    expect(within(panel).queryByText(/% across/)).toBeNull()
    expect(panel.querySelector('.area-plan-preview .area-plan-pin-selected')).toHaveTextContent('Bay 1')

    fireEvent.click(screen.getByText('Bay 2'))
    expect(panel.querySelector('.area-plan-preview')).toBeNull()
    expect(within(panel).getByText('Not placed — set a place in Edit Details')).toBeInTheDocument()
  })

  it('opens a row from the keyboard with Enter or Space', async () => {
    await renderCells()
    const row = screen.getByText('Bay 1').closest('tr')
    expect(row).toHaveAttribute('tabindex', '0')
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(row).toHaveClass('row-selected')
    expect(document.querySelector('.context-panel-open')).toBeTruthy()
    fireEvent.keyDown(row, { key: ' ' })
    expect(row).not.toHaveClass('row-selected')
    // A key on the copy chip inside the row is the chip's.
    fireEvent.keyDown(within(row).getByRole('button', { name: /cell UUID/i }), { key: 'Enter' })
    expect(row).not.toHaveClass('row-selected')
  })

  it('opens the Site Map on the cell\'s area from the panel\'s plan', async () => {
    const onShowOnSiteMap = vi.fn()
    render(<CellsTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={() => true} onShowOnSiteMap={onShowOnSiteMap} />)
    await waitFor(() => expect(screen.getByText('Bay 1')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Bay 1'))
    fireEvent.keyDown(screen.getByRole('link', { name: 'Open North Shop on the Site Map' }), { key: 'Enter' })
    expect(onShowOnSiteMap).toHaveBeenCalledWith('area-1')
  })

  it('titles the panel with the cell\'s icon, Edit Details its one primary without a dashboard', async () => {
    await renderCells()
    fireEvent.click(screen.getByText('Bay 1'))
    const panel = document.querySelector('.context-panel')
    expect(panel.querySelector('.context-panel-title-row .context-panel-icon svg')).toBeTruthy()
    expect(panel.querySelectorAll('.context-panel-actions .btn-primary')).toHaveLength(1)
    expect(panel.querySelector('.context-panel-actions .btn-primary')).toHaveTextContent('Edit Details')
  })

  it('shows the plan to click once an area is chosen, and not before', async () => {
    await renderCells()
    fireEvent.click(screen.getByRole('button', { name: /New Cell/ }))
    expect(document.querySelector('.area-plan')).toBeNull()

    fireEvent.change(screen.getByLabelText('Area'), { target: { value: 'area-1' } })
    expect(document.querySelector('.area-plan-interactive')).toBeTruthy()
    // The cells already in the area are drawn so the operator can see them.
    expect(screen.getByTitle('Bay 1 — already in this area')).toBeInTheDocument()
  })

  it('draws the default outline for an area with no plan uploaded', async () => {
    await renderCells()
    fireEvent.click(screen.getByRole('button', { name: /New Cell/ }))
    fireEvent.change(screen.getByLabelText('Area'), { target: { value: 'area-2' } })
    expect(document.querySelector('.area-plan').dataset.plan).toBe('outline')
  })

  it('places the cell where the plan is clicked and saves the fractions with the area', async () => {
    await renderCells()
    fireEvent.click(screen.getByRole('button', { name: /New Cell/ }))
    fireEvent.change(screen.getByPlaceholderText(/Assembly Line 1/), { target: { value: 'Bay 3' } })
    fireEvent.change(screen.getByLabelText('Area'), { target: { value: 'area-1' } })
    const plan = sizePlan()
    fireEvent.click(plan, { clientX: 100, clientY: 225 })
    expect(screen.getByText(/Placed 25% across, 75% down/)).toBeInTheDocument()

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(api.post).toHaveBeenCalledWith('/api/v1/cells', expect.objectContaining({
      cell_name: 'Bay 3', area_id: 'area-1', plan_x: 0.25, plan_y: 0.75
    }))
  })

  it('refuses a place too close to a cell already in the area, naming it', async () => {
    await renderCells()
    fireEvent.click(screen.getByRole('button', { name: /New Cell/ }))
    fireEvent.change(screen.getByLabelText('Area'), { target: { value: 'area-1' } })
    const plan = sizePlan()
    // Bay 1 sits at the middle; a click 2% away is inside the 8% spacing.
    fireEvent.click(plan, { clientX: 208, clientY: 150 })
    expect(screen.getByRole('alert')).toHaveTextContent(/Too close to 'Bay 1'/)
    expect(screen.queryByText(/^Placed/)).toBeNull()
    // Far enough away is taken.
    fireEvent.click(plan, { clientX: 40, clientY: 30 })
    expect(screen.getByText(/Placed 10% across, 10% down/)).toBeInTheDocument()
  })

  it('clears the place when the area changes, because a place belongs to one plan', async () => {
    await renderCells()
    fireEvent.click(screen.getByText('Bay 1'))
    fireEvent.click(screen.getByRole('button', { name: /Edit Details/ }))
    expect(screen.getByText(/Placed 50% across, 50% down/)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Area'), { target: { value: 'area-2' } })
    expect(screen.getByText(/Not placed/)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Area'), { target: { value: '' } })
    expect(document.querySelector('.modal .area-plan')).toBeNull()

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(api.put).toHaveBeenCalledWith('/api/v1/cells/cell-1', expect.objectContaining({
      area_id: '', plan_x: '', plan_y: ''
    }))
  })

  it('takes the cell off the plan with Clear place, keeping its area', async () => {
    await renderCells()
    fireEvent.click(screen.getByText('Bay 1'))
    fireEvent.click(screen.getByRole('button', { name: /Edit Details/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear place' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(api.put).toHaveBeenCalledWith('/api/v1/cells/cell-1', expect.objectContaining({
      area_id: 'area-1', plan_x: '', plan_y: ''
    }))
  })
})

describe('CellPlacementPicker on its own', () => {
  it('asks for an area before it will draw anything', () => {
    render(<CellPlacementPicker area={null} cells={[]} onChange={vi.fn()} />)
    expect(screen.getByText(/File the cell into an area/)).toBeInTheDocument()
  })

  it('ignores the cell being edited when measuring the spacing', () => {
    const onChange = vi.fn()
    render(<CellPlacementPicker area={area} cells={cells} cellId="cell-1" value={{ x: 0.5, y: 0.5 }} onChange={onChange} />)
    const plan = sizePlan()
    fireEvent.click(plan, { clientX: 204, clientY: 150 })
    expect(onChange).toHaveBeenCalledWith({ x: 0.51, y: 0.5 })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not place through a click on a pin', () => {
    const onChange = vi.fn()
    render(<CellPlacementPicker area={area} cells={cells} cellId="cell-9" value={null} onChange={onChange} />)
    fireEvent.click(screen.getByTitle('Bay 1 — already in this area'))
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('AreaPlanPreview on its own', () => {
  const placed = [
    { cell_id: 'c1', cell_name: 'Bay 1', area_id: 'area-1', plan_x: 0.2, plan_y: 0.2, is_archived: false },
    { cell_id: 'c2', cell_name: 'Bay 2', area_id: 'area-1', plan_x: 0.8, plan_y: 0.8, is_archived: false },
    { cell_id: 'c3', cell_name: 'Old Bay', area_id: 'area-1', plan_x: 0.5, plan_y: 0.2, is_archived: true },
    { cell_id: 'c4', cell_name: 'Elsewhere', area_id: 'area-2', plan_x: 0.5, plan_y: 0.5, is_archived: false }
  ]
  const pinFor = (name) => [...document.querySelectorAll('.area-plan-pin')].find(p => p.textContent === name)

  it('rings the highlighted cell and dims the area\'s others, by size as well as colour', () => {
    render(<AreaPlanPreview area={area} cells={placed} highlightCellId="c1" />)
    // This area's live cells only: not another area's, and not an archived one.
    expect([...document.querySelectorAll('.area-plan-pin-label')].map(l => l.textContent)).toEqual(['Bay 1', 'Bay 2'])
    expect(pinFor('Bay 1')).toHaveClass('area-plan-pin-selected')
    expect(pinFor('Bay 1')).not.toHaveClass('area-plan-pin-small')
    expect(pinFor('Bay 2')).toHaveClass('area-plan-pin-muted', 'area-plan-pin-small')
  })

  it('draws an archived cell when it is the one highlighted', () => {
    render(<AreaPlanPreview area={area} cells={placed} highlightCellId="c3" />)
    expect(pinFor('Old Bay')).toHaveClass('area-plan-pin-selected')
  })

  it('is a link to the Site Map by click or Enter, and nothing to tab to without one', () => {
    const onOpen = vi.fn()
    const { unmount } = render(<AreaPlanPreview area={area} cells={placed} onOpen={onOpen} />)
    const link = screen.getByRole('link', { name: 'Open North Shop on the Site Map' })
    fireEvent.click(link)
    fireEvent.keyDown(link, { key: ' ' })
    fireEvent.keyDown(link, { key: 'Enter' })
    expect(onOpen.mock.calls).toEqual([['area-1'], ['area-1']])
    // The pins are marks inside the link, not controls of their own.
    expect(link.querySelector('button')).toBeNull()
    unmount()

    render(<AreaPlanPreview area={area} cells={placed} />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(document.querySelector('.area-plan-preview')).not.toHaveAttribute('tabindex')
  })
})
