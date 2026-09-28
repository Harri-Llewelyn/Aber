/**
 * A cell is placed on its area's plan from its own form: an area, then a click on the plan. The
 * picker refuses a place too close to a neighbour before the database does.
 */
import React from 'react'
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CellsTab } from '../components/tabs/CellsTab'
import { CellPlacementPicker } from '../components/common/CellPlacementPicker'
import { api } from '../api'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const area = { area_id: 'area-1', area_name: 'Building A', icon: 'Factory', plan_path: null, plan_aspect: null, cells: [] }
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

/** A plan 400 wide and 300 tall at the origin, so a click at (200, 150) is the middle. */
const sizePlan = () => {
  const plan = document.querySelector('.area-plan')
  plan.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300 })
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
    expect(within(row1).getByText('Building A')).toBeInTheDocument()
    expect(within(row1).getByText('placed')).toBeInTheDocument()
    const row2 = screen.getByText('Bay 2').closest('tr')
    expect(within(row2).getByText('not placed')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Bay 1'))
    const panel = document.querySelector('.context-panel')
    expect(within(panel).getByText('50% across, 50% down')).toBeInTheDocument()
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
    expect(document.querySelector('.area-plan')).toBeNull()

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
