import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CellsTab } from '../components/tabs/CellsTab'
import { api } from '../api'

/**
 * The Cells page as a table. The context drawer holds the UUID, both membership lists as linking
 * chips, and every action; these tests pin that the row carries enough to scan by, and that what
 * the row does not carry is reachable in one click.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const GATEWAY = {
  gateway_id: 'gw-1', gateway_name: 'Line_A_Gateway', cell_id: 'cell-1',
  location_scope: 'cell', status: 'ONLINE', is_archived: false,
  last_heartbeat: new Date().toISOString(), device_count: 2
}

const device = (overrides = {}) => ({
  asset_id: 'dev-1', asset_name: 'CNC_Mill_01', status: 'ONLINE',
  is_quarantined: false, is_archived: false,
  active_gateway_id: 'gw-1', gateway_name: 'Line_A_Gateway',
  cell_id: null, location_scope: 'cell', effective_cell_id: 'cell-1',
  location_source: 'inherited',
  ...overrides
})

const CELL = {
  cell_id: 'cell-1', cell_name: 'Assembly Line 1', icon: 'Factory',
  is_archived: false, gateways: [GATEWAY], gateway_count: 1,
  access_url: 'http://localhost:3002/d/cell-1'
}

const routeGet = ({ cells = [CELL], devices = [device()] } = {}) => (path) => {
  if (path.startsWith('/api/v1/cells')) return Promise.resolve(cells)
  if (path.startsWith('/api/v1/devices')) return Promise.resolve(devices)
  return Promise.resolve([])
}

const renderCells = (props = {}, routes = {}) => {
  api.get.mockImplementation(routeGet(routes))
  return render(
    <CellsTab
      showToast={vi.fn()} hasPermission={() => true}
      onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} onViewTrail={vi.fn()}
      {...props}
    />
  )
}

const table = () => document.querySelector('.page-main .card table')
const rowFor = (name) => within(table()).getByText(name).closest('tr')
const panel = () => document.querySelector('.context-panel')

const ready = async () => waitFor(() => expect(table()).toBeTruthy())

beforeEach(() => { vi.clearAllMocks() })

// The shape of the list

describe('the cells table', () => {
  it('renders one row per cell with the six columns', async () => {
    renderCells()
    await ready()

    expect([...table().querySelectorAll('thead th')].map(h => h.textContent.trim()))
      .toEqual(['Icon', 'Cell Name', 'Area', 'Cell UUID', 'Assigned Gateways', 'Assigned Devices'])
    expect(table().querySelectorAll('tbody tr')).toHaveLength(1)
  })

  /* The icon earns its column: in a list where every other column is text it makes a row
     recognisable without reading. Its header is a screen-reader label because a blank `th`
     announces as nothing. */
  it('draws the cell icon, and names the column for assistive technology only', async () => {
    renderCells()
    await ready()

    const iconCell = rowFor('Assembly Line 1').querySelector('.cell-icon-col')
    expect(iconCell.querySelector('svg')).toBeTruthy()

    const iconHeader = table().querySelector('thead .cell-icon-col')
    expect(iconHeader).toHaveTextContent('Icon')
    expect(iconHeader.querySelector('.sr-only')).toBeTruthy()
  })

  it('renders the UUID as a copy control rather than as plain text', async () => {
    renderCells()
    await ready()

    // This is where somebody gets a cell id out of the app and into a query.
    const uuidCell = rowFor('Assembly Line 1').querySelectorAll('td')[3]
    expect(within(uuidCell).getByRole('button')).toHaveTextContent('cell-1')
  })
})

// The two membership columns

describe('assigned gateways and devices', () => {
  it('names the gateways assigned to the cell', async () => {
    renderCells()
    await ready()

    expect(within(rowFor('Assembly Line 1')).getByText('Line_A_Gateway')).toBeTruthy()
  })

  /* The same column as the Gateways page's Connected Devices: a summary hidden behind a "+N" would
     defeat the column it summarises. */
  it('pins an Online/Offline summary ahead of the devices themselves', async () => {
    renderCells({}, { devices: [device(), device({ asset_id: 'dev-2', asset_name: 'CNC_Mill_02', status: 'OFFLINE' })] })
    await ready()

    const row = rowFor('Assembly Line 1')
    expect(within(row).getByText('1 Online / 1 Offline')).toBeTruthy()
    expect(within(row).getByText('CNC_Mill_01')).toBeTruthy()
  })

  it('collapses past three devices so a busy cell cannot grow the row without bound', async () => {
    renderCells({}, {
      devices: [1, 2, 3, 4, 5].map(n => device({ asset_id: `dev-${n}`, asset_name: `CNC_Mill_0${n}` }))
    })
    await ready()

    // Five devices plus the pinned summary, shown three at a time.
    const row = rowFor('Assembly Line 1')
    expect(within(row).getByRole('button', { name: /^\+/ })).toBeTruthy()
  })

  /* A quarantined device is pinned, as Unmodelled is on the Devices page: it is the entry that
     calls for action. */
  it('keeps a quarantined device visible however many healthy ones surround it', async () => {
    renderCells({}, {
      devices: [
        ...[1, 2, 3, 4].map(n => device({ asset_id: `dev-${n}`, asset_name: `CNC_Mill_0${n}` })),
        device({ asset_id: 'dev-q', asset_name: 'Unknown_Node', is_quarantined: true })
      ]
    })
    await ready()

    expect(within(rowFor('Assembly Line 1')).getByText(/Unknown_Node \(quarantined\)/)).toBeTruthy()
  })

  it('says a zone is empty rather than leaving two blank cells', async () => {
    renderCells({}, {
      cells: [{ ...CELL, gateways: [], gateway_count: 0 }],
      devices: []
    })
    await ready()

    // A blank cell reads as contents that failed to load. This one is answering the question.
    const row = rowFor('Assembly Line 1')
    expect(within(row).getByText('No gateways assigned')).toBeTruthy()
    expect(within(row).getByText('No devices located here')).toBeTruthy()
    expect(within(row).getByText('empty')).toBeTruthy()
  })
})

// The drawer

describe('the row and its drawer', () => {
  it('opens the drawer on a row click and marks the row', async () => {
    renderCells()
    await ready()

    fireEvent.click(within(table()).getByText('Assembly Line 1'))

    await waitFor(() => expect(panel()).toBeTruthy())
    expect(within(panel()).getByText('cell-1')).toBeTruthy()
    expect(rowFor('Assembly Line 1').className).toMatch(/row-selected/)
  })

  it('carries no per-row action buttons — every action is on the drawer', async () => {
    renderCells()
    await ready()

    const row = rowFor('Assembly Line 1')
    for (const name of [/Archive/i, /^Edit/i, /Docs/i, /Audit Trail/i]) {
      expect(within(row).queryByRole('button', { name })).toBeNull()
    }

    fireEvent.click(within(table()).getByText('Assembly Line 1'))
    await waitFor(() => expect(panel()).toBeTruthy())
    expect(within(panel()).getByText('Edit Details')).toBeTruthy()
    expect(within(panel()).getByText('Archive Cell')).toBeTruthy()
  })

  /* A retention deadline is not something to find out about by its passing, so the drawer reports
     it for an archived cell. */
  it('reports an archived cell’s retention deadline in the drawer', async () => {
    renderCells({}, {
      cells: [{ ...CELL, is_archived: true, auto_delete_at: '2026-12-01T00:00:00Z' }]
    })
    await ready()

    expect(within(rowFor('Assembly Line 1')).getByText('ARCHIVED')).toBeTruthy()

    fireEvent.click(within(table()).getByText('Assembly Line 1'))
    await waitFor(() => expect(panel()).toBeTruthy())
    expect(within(panel()).getByText(/Auto-purges on/)).toBeTruthy()
  })

  it('says permanent retention rather than falling silent when no timer is set', async () => {
    renderCells({}, { cells: [{ ...CELL, is_archived: true, auto_delete_at: null }] })
    await ready()

    fireEvent.click(within(table()).getByText('Assembly Line 1'))
    await waitFor(() => expect(panel()).toBeTruthy())
    expect(within(panel()).getByText(/Permanent/)).toBeTruthy()
  })

  it('shows no Retention field on a cell still in service', async () => {
    renderCells()
    await ready()

    fireEvent.click(within(table()).getByText('Assembly Line 1'))
    await waitFor(() => expect(panel()).toBeTruthy())
    expect(within(panel()).queryByText('Retention')).toBeNull()
  })
})

// The filters

describe('filters still narrow the table', () => {
  it('filters rows by name', async () => {
    renderCells({}, {
      cells: [CELL, { ...CELL, cell_id: 'cell-2', cell_name: 'Paint Shop', gateways: [] }]
    })
    await ready()
    await waitFor(() => expect(table().querySelectorAll('tbody tr')).toHaveLength(2))

    fireEvent.change(screen.getByPlaceholderText(/Search by Cell ID or name/), {
      target: { value: 'paint' }
    })

    expect(table().querySelectorAll('tbody tr')).toHaveLength(1)
    expect(within(table()).getByText('Paint Shop')).toBeTruthy()
  })

  it('says why the table is empty when a filter matches nothing', async () => {
    renderCells()
    await ready()

    fireEvent.change(screen.getByPlaceholderText(/Search by Cell ID or name/), {
      target: { value: 'no-such-cell' }
    })

    expect(table()).toBeNull()
    expect(document.querySelector('.empty-state')).toHaveTextContent('No cells match the selected filter')
  })
})
