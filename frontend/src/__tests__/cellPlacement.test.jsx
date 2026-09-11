/**
 * A cell is placed on its floor's plan from its own form: area, then a floor of that area, then a
 * click on the plan. The picker refuses a place too close to a neighbour before the database does.
 */
import React from 'react'
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CellsTab } from '../components/tabs/CellsTab'
import { FloorPlacementPicker } from '../components/common/FloorPlacementPicker'
import { api } from '../api'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const ground = { floor_id: 'floor-g', area_id: 'area-1', level: 0, name: 'Ground floor', plan_path: null, plan_aspect: null }
const first = { floor_id: 'floor-1', area_id: 'area-1', level: 1, name: 'Floor 1', plan_path: null, plan_aspect: null }
const area = { area_id: 'area-1', area_name: 'Building A', icon: 'Factory', floors: [first, ground], floor_count: 2, cells: [] }
const emptyArea = { area_id: 'area-2', area_name: 'Annexe', icon: 'Warehouse', floors: [], floor_count: 0, cells: [] }

const cells = [
  { cell_id: 'cell-1', cell_name: 'Bay 1', area_id: 'area-1', floor_id: 'floor-g', plan_x: 0.5, plan_y: 0.5, is_archived: false, gateways: [], gateway_count: 0 },
  { cell_id: 'cell-2', cell_name: 'Bay 2', area_id: 'area-1', floor_id: 'floor-g', plan_x: null, plan_y: null, is_archived: false, gateways: [], gateway_count: 0 }
]

const routeGet = (path) => {
  if (path.startsWith('/api/v1/cells')) return Promise.resolve(cells)
  if (path.startsWith('/api/v1/areas')) return Promise.resolve([area, emptyArea])
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
  const plan = document.querySelector('.floor-plan')
  plan.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300 })
  return plan
}

const renderCells = async () => {
  render(<CellsTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={() => true} />)
  await waitFor(() => expect(screen.getByText('Bay 1')).toBeInTheDocument())
}

describe('CellsTab places a cell on a floor', () => {
  it('names the floor and whether the cell is placed, on the row and in the panel', async () => {
    await renderCells()
    const row1 = screen.getByText('Bay 1').closest('tr')
    expect(within(row1).getByText(/Ground floor/)).toBeInTheDocument()
    expect(within(row1).getByText(/· placed/)).toBeInTheDocument()
    const row2 = screen.getByText('Bay 2').closest('tr')
    expect(within(row2).getByText(/· not placed/)).toBeInTheDocument()

    fireEvent.click(screen.getByText('Bay 1'))
    const panel = document.querySelector('.context-panel')
    expect(within(panel).getByText('Ground floor')).toBeInTheDocument()
    expect(within(panel).getByText('50% across, 50% down')).toBeInTheDocument()
  })

  it('offers the floors of the chosen area, lands on its ground floor, and shows the plan to click', async () => {
    await renderCells()
    fireEvent.click(screen.getByRole('button', { name: /New Cell/ }))
    expect(screen.queryByLabelText('Floor')).toBeNull()

    fireEvent.change(screen.getByLabelText('Area'), { target: { value: 'area-1' } })
    const floorSelect = screen.getByLabelText('Floor')
    expect(floorSelect).toHaveValue('floor-g')
    expect([...floorSelect.options].map(o => o.textContent)).toEqual(['— No floor —', '1: Floor 1', '0: Ground floor'])
    expect(document.querySelector('.floor-plan-interactive')).toBeTruthy()
    // The cells already on the floor are drawn so the operator can see them.
    expect(screen.getByTitle('Bay 1 — already on this floor')).toBeInTheDocument()
  })

  it('says when the area has no floors yet', async () => {
    await renderCells()
    fireEvent.click(screen.getByRole('button', { name: /New Cell/ }))
    fireEvent.change(screen.getByLabelText('Area'), { target: { value: 'area-2' } })
    expect(screen.getByLabelText('Floor')).toHaveValue('')
    expect(screen.getByText(/This area has no floors yet/)).toBeInTheDocument()
    expect(document.querySelector('.floor-plan')).toBeNull()
  })

  it('places the cell where the plan is clicked and saves the fractions with the floor', async () => {
    await renderCells()
    fireEvent.click(screen.getByRole('button', { name: /New Cell/ }))
    fireEvent.change(screen.getByPlaceholderText(/Assembly Line 1/), { target: { value: 'Bay 3' } })
    fireEvent.change(screen.getByLabelText('Area'), { target: { value: 'area-1' } })
    const plan = sizePlan()
    fireEvent.click(plan, { clientX: 100, clientY: 225 })
    expect(screen.getByText(/Placed 25% across, 75% down/)).toBeInTheDocument()

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(api.post).toHaveBeenCalledWith('/api/v1/cells', expect.objectContaining({
      cell_name: 'Bay 3', area_id: 'area-1', floor_id: 'floor-g', plan_x: 0.25, plan_y: 0.75
    }))
  })

  it('refuses a place too close to a cell already on the floor, naming it', async () => {
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

  it('clears the place when the floor changes, and the floor when the area changes', async () => {
    await renderCells()
    fireEvent.click(screen.getByText('Bay 1'))
    fireEvent.click(screen.getByRole('button', { name: /Edit Details/ }))
    expect(screen.getByLabelText('Floor')).toHaveValue('floor-g')
    expect(screen.getByText(/Placed 50% across, 50% down/)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Floor'), { target: { value: 'floor-1' } })
    expect(screen.getByText(/Not placed/)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Area'), { target: { value: '' } })
    expect(screen.queryByLabelText('Floor')).toBeNull()

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(api.put).toHaveBeenCalledWith('/api/v1/cells/cell-1', expect.objectContaining({
      area_id: '', floor_id: '', plan_x: '', plan_y: ''
    }))
  })

  it('takes the cell off the plan with Clear place, keeping its floor', async () => {
    await renderCells()
    fireEvent.click(screen.getByText('Bay 1'))
    fireEvent.click(screen.getByRole('button', { name: /Edit Details/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear place' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(api.put).toHaveBeenCalledWith('/api/v1/cells/cell-1', expect.objectContaining({
      floor_id: 'floor-g', plan_x: '', plan_y: ''
    }))
  })
})

describe('FloorPlacementPicker on its own', () => {
  it('asks for a floor before it will draw anything', () => {
    render(<FloorPlacementPicker floor={null} cells={[]} onChange={vi.fn()} />)
    expect(screen.getByText(/Choose a floor/)).toBeInTheDocument()
  })

  it('ignores the cell being edited when measuring the spacing', () => {
    const onChange = vi.fn()
    render(<FloorPlacementPicker floor={ground} cells={cells} cellId="cell-1" value={{ x: 0.5, y: 0.5 }} onChange={onChange} />)
    const plan = sizePlan()
    fireEvent.click(plan, { clientX: 204, clientY: 150 })
    expect(onChange).toHaveBeenCalledWith({ x: 0.51, y: 0.5 })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not place through a click on a pin', () => {
    const onChange = vi.fn()
    render(<FloorPlacementPicker floor={ground} cells={cells} cellId="cell-9" value={null} onChange={onChange} />)
    fireEvent.click(screen.getByTitle('Bay 1 — already on this floor'))
    expect(onChange).not.toHaveBeenCalled()
  })
})
