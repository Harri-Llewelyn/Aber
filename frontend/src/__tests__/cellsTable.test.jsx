import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CellsTab } from '../components/tabs/CellsTab'
import { api } from '../api'
import { expectCardHeading, expectSearchFirst, expectToolbarButton } from '../test/cardHeading'
import { tooltipOf } from '../test/tooltips'

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

// The list opens on Active; an archived cell is one filter away.
const showArchived = async () => {
  fireEvent.change(await screen.findByLabelText('Lifecycle'), { target: { value: 'archived' } })
  await ready()
}

beforeEach(() => { vi.clearAllMocks() })

// The shape of the list

describe('the cells table', () => {
  it('renders one row per cell with the six columns', async () => {
    renderCells()
    await ready()

    expect([...table().querySelectorAll('thead th')].map(h => h.textContent.trim()))
      .toEqual(['Icon', 'Cell Name', 'Area', 'Cell UUID', 'Assigned Gateways', 'Devices'])
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
    renderCells({}, { devices: [device(), device({ asset_id: 'dev-2', asset_name: 'CNC_Mill_02', status: 'OFFLINE', first_dbirth_at: '2026-10-01T08:00:00Z' })] })
    await ready()

    const row = rowFor('Assembly Line 1')
    expect(within(row).getByText('1 Online / 1 Offline')).toBeTruthy()
    expect(within(row).getByText('CNC_Mill_01')).toBeTruthy()
  })

  /* Every count on the page counts equipment in service, as the Site Map does: an archived device
     and a replay lane are left out, the lane even where its row resolved into the cell. The
     archived device is still listed, marked. */
  it('counts only the devices in service, in the summary, the drawer and the sort', async () => {
    const OTHER = { ...CELL, cell_id: 'cell-2', cell_name: 'Assembly Line 2', gateways: [{ ...GATEWAY, gateway_id: 'gw-2', gateway_name: 'Line_B_Gateway', cell_id: 'cell-2' }] }
    renderCells({}, {
      cells: [OTHER, CELL],
      devices: [
        device(),
        device({ asset_id: 'dev-old', asset_name: 'CNC_Old', is_archived: true }),
        device({ asset_id: 'dev-lane', asset_name: 'CNC_Mill_01_Replay', shadow_of: 'dev-1' }),
        device({ asset_id: 'dev-b1', asset_name: 'Press_B1', effective_cell_id: 'cell-2' }),
        device({ asset_id: 'dev-b2', asset_name: 'Press_B2', effective_cell_id: 'cell-2' })
      ]
    })
    await ready()

    const row = rowFor('Assembly Line 1')
    expect(within(row).getByText('1 Online / 0 Offline')).toBeTruthy()
    expect(within(row).getByText('CNC_Old (archived)')).toBeTruthy()

    // Line 1 holds three device rows but one device in service, so it sorts before Line 2's two.
    fireEvent.click(screen.getByRole('button', { name: 'Devices' }))
    expect([...table().querySelectorAll('tbody tr strong')].map(s => s.textContent)).toEqual(['Assembly Line 1', 'Assembly Line 2'])

    fireEvent.click(within(table()).getByText('Assembly Line 1'))
    await waitFor(() => expect(panel()).toBeTruthy())
    expect(within(panel()).getByText('1 Gateway · 1 Device')).toBeTruthy()
    expect(within(panel()).getByText('Devices (1/1 online)')).toBeTruthy()
    expect(within(panel()).getByRole('link', { name: /CNC_Old/ })).toHaveTextContent('ARCHIVED')
  })

  /* Online is counted as on the Gateways row and the Site Map's panel for the same cell. A
     quarantined device arrives stored ONLINE and a missing status is not running, so neither is
     online; the quarantined and the unborn are named apart. */
  it('counts online in the drawer by the shared rule, naming the quarantined and the unborn', async () => {
    const BORN = '2026-10-01T08:00:00Z'
    renderCells({}, {
      devices: [
        device({ first_dbirth_at: BORN }),
        device({ asset_id: 'dev-q', asset_name: 'Unknown_01', is_quarantined: true }),
        device({ asset_id: 'dev-n', asset_name: 'CNC_Mill_02', status: null, first_dbirth_at: BORN }),
        device({ asset_id: 'dev-b', asset_name: 'CNC_Mill_03', status: 'OFFLINE' })
      ]
    })
    await ready()
    expect(within(rowFor('Assembly Line 1')).getByText('1 Online / 1 Offline / 1 Awaiting first birth')).toBeTruthy()

    fireEvent.click(within(table()).getByText('Assembly Line 1'))
    await waitFor(() => expect(panel()).toBeTruthy())
    expect(within(panel()).getByText('Devices (1/4 online · 1 quarantined · 1 awaiting first birth)')).toBeTruthy()
  })

  /* One test for the filter, the badge and the help: nothing in service in the cell. A gateway
     with no devices is not empty, and archived equipment does not make a cell full. */
  it('calls a cell Empty only when nothing in service is in it, in the badge and the filter alike', async () => {
    renderCells({}, {
      cells: [
        { ...CELL, cell_id: 'cell-gw', cell_name: 'Gateway Only' },
        { ...CELL, cell_id: 'cell-old', cell_name: 'Only Archived', gateways: [{ ...GATEWAY, gateway_id: 'gw-old', is_archived: true, cell_id: 'cell-old' }] },
        { ...CELL, cell_id: 'cell-dev', cell_name: 'Device Only', gateways: [] }
      ],
      devices: [
        device({ asset_id: 'dev-old', asset_name: 'Old_Press', is_archived: true, effective_cell_id: 'cell-old' }),
        device({ asset_id: 'dev-lane', asset_name: 'Press_Replay', shadow_of: 'dev-x', effective_cell_id: 'cell-old' }),
        device({ asset_id: 'dev-own', asset_name: 'Own_Press', effective_cell_id: 'cell-dev', location_source: 'explicit' })
      ]
    })
    await ready()

    const badges = () => [...table().querySelectorAll('tbody tr')]
      .filter(r => within(r).queryByText('Empty'))
      .map(r => r.querySelector('strong').textContent)
    expect(badges()).toEqual(['Only Archived'])

    const filter = screen.getByRole('button', { name: /^Empty/ })
    expect(filter).toHaveTextContent('Empty (1)')
    expect(tooltipOf(filter)).toBe('Cells with no gateway and no device in service')
    fireEvent.click(filter)
    expect([...table().querySelectorAll('tbody tr strong')].map(s => s.textContent)).toEqual(['Only Archived'])
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

  it('says a cell is empty rather than leaving two blank cells', async () => {
    renderCells({}, {
      cells: [{ ...CELL, gateways: [], gateway_count: 0 }],
      devices: []
    })
    await ready()

    // A blank cell reads as contents that failed to load. This one is answering the question.
    const row = rowFor('Assembly Line 1')
    expect(within(row).getByText('No gateways assigned')).toBeTruthy()
    expect(within(row).getByText('No devices here')).toBeTruthy()
    expect(within(row).getByText('Empty')).toBeTruthy()
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
    for (const name of [/Archive/i, /^Edit/i, /Attached Links/i, /Audit Trail/i]) {
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
    await showArchived()

    expect(within(rowFor('Assembly Line 1')).getByText('ARCHIVED')).toBeTruthy()
    expect(rowFor('Assembly Line 1')).toHaveClass('row-archived')

    fireEvent.click(within(table()).getByText('Assembly Line 1'))
    await waitFor(() => expect(panel()).toBeTruthy())
    expect(within(panel()).getByText(/Auto-Purge: /)).toBeTruthy()
  })

  it('says permanent retention rather than falling silent when no timer is set', async () => {
    renderCells({}, { cells: [{ ...CELL, is_archived: true, auto_delete_at: null }] })
    await showArchived()

    fireEvent.click(within(table()).getByText('Assembly Line 1'))
    await waitFor(() => expect(panel()).toBeTruthy())
    expect(within(panel()).getByText(/Never auto-purged/)).toBeTruthy()
  })

  /* The database refuses to archive a cell while anything is in it, archived and quarantined
     devices and archived gateways included. The drawer says so before the click. */
  it('holds Archive Cell while the cell holds anything, and says how many', async () => {
    renderCells({}, {
      devices: [device(), device({ asset_id: 'dev-2', asset_name: 'Press_02', is_archived: true })]
    })
    await ready()
    fireEvent.click(within(table()).getByText('Assembly Line 1'))
    await waitFor(() => expect(panel()).toBeTruthy())

    const archive = within(panel()).getByRole('button', { name: /Archive Cell/ })
    expect(archive).toBeDisabled()
    expect(tooltipOf(archive)).toBe(
      'This cell holds 2 devices and 1 gateway. Move them to another cell, or delete them, then archive the cell.'
    )
  })

  it('offers Archive Cell, and no Show Its Devices, on an empty cell', async () => {
    renderCells({}, { cells: [{ ...CELL, gateways: [], gateway_count: 0 }], devices: [] })
    await ready()
    fireEvent.click(within(table()).getByText('Assembly Line 1'))
    await waitFor(() => expect(panel()).toBeTruthy())

    expect(within(panel()).getByRole('button', { name: /Archive Cell/ })).toBeEnabled()
    expect(within(panel()).queryByText('Show Its Devices')).toBeNull()
  })

  it('links Show Its Devices to the Devices page on this cell, with every lifecycle', async () => {
    renderCells({}, {
      devices: [device(), device({ asset_id: 'dev-q', asset_name: 'Unknown_01', is_quarantined: true })]
    })
    await ready()
    fireEvent.click(within(table()).getByText('Assembly Line 1'))
    await waitFor(() => expect(panel()).toBeTruthy())

    const link = within(panel()).getByRole('link', { name: /Show Its Devices/ })
    expect(link.getAttribute('href')).toBe('/devices?cell=cell-1&lifecycle=all')
    // The Devices page's list leaves quarantined devices to its Quarantine table.
    expect(tooltipOf(link)).toMatch(/1 quarantined device is in its Quarantine table\.$/)
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

    fireEvent.change(screen.getByPlaceholderText(/Search by Cell UUID or name/), {
      target: { value: 'paint' }
    })

    expect(table().querySelectorAll('tbody tr')).toHaveLength(1)
    expect(within(table()).getByText('Paint Shop')).toBeTruthy()
  })

  it('says why the table is empty when a filter matches nothing', async () => {
    renderCells()
    await ready()

    fireEvent.change(screen.getByPlaceholderText(/Search by Cell UUID or name/), {
      target: { value: 'no-such-cell' }
    })

    expect(table()).toBeNull()
    expect(document.querySelector('.empty-state')).toHaveTextContent('No cells match these filters.')
  })

  it('names the page in its card header, with no title tip, and New Cell in the toolbar', async () => {
    renderCells({}, { cells: [] })
    await waitFor(() => expect(document.querySelector('.empty-state')).toBeTruthy())
    expectCardHeading('Cells', /area/)
    expectToolbarButton(/New Cell/)
  })

  it('starts the toolbar with the search box, then the lifecycle', async () => {
    renderCells({}, { cells: [] })
    await waitFor(() => expect(document.querySelector('.empty-state')).toBeTruthy())
    expect(expectSearchFirst('Search cells').nextElementSibling).toBe(screen.getByLabelText('Lifecycle'))
  })

  it('says there are none yet on an empty stack, with no count on the heading', async () => {
    renderCells({}, { cells: [] })
    await waitFor(() => expect(document.querySelector('.empty-state')).toBeTruthy())
    expect(document.querySelector('.empty-state')).toHaveTextContent('No cells yet. Add one, then file it in an area.')
    expect(document.querySelector('.card-header .section-count')).toBeNull()
  })

  it('opens on Active, with the counts in the lifecycle options rather than on the heading', async () => {
    renderCells({}, {
      cells: [CELL, { ...CELL, cell_id: 'cell-2', cell_name: 'Paint Shop', gateways: [] }, { ...CELL, cell_id: 'cell-3', cell_name: 'Old Bay', is_archived: true }]
    })
    await ready()
    expect(screen.getByLabelText('Lifecycle')).toHaveValue('active')
    expect(within(table()).queryByText('Old Bay')).toBeNull()
    expect(within(screen.getByLabelText('Lifecycle')).getByRole('option', { name: 'Active (2)' })).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText(/Search by Cell UUID or name/), { target: { value: 'paint' } })
    expect(within(table()).getByText('Paint Shop')).toBeInTheDocument()
    expect(document.querySelector('.card-header .section-count')).toBeNull()
  })

  it('scrolls inside its card', async () => {
    renderCells()
    await ready()
    expect(document.querySelector('.page-layout')).toHaveClass('page-fill')
    expect(document.querySelector('.card')).toHaveClass('card-fill')
    expect(document.querySelector('.card-fill > .table-wrap')).toBeTruthy()
  })
})

// Sorting (#801)

describe('the cells table sorts by a column (#801)', () => {
  // By id the welding hall comes first, by name second.
  const AREAS = [
    { area_id: 'area-1', area_name: 'Welding Hall' },
    { area_id: 'area-2', area_name: 'Assembly Hall' }
  ]
  const RETIRED_AREA = 'b0000000-0000-4000-8000-000000000009'
  const gatewaysIn = (cellId, n) => Array.from({ length: n }, (_, i) => ({
    ...GATEWAY, gateway_id: `${cellId}-gw-${i}`, gateway_name: `${cellId}_Gateway_${i}`, cell_id: cellId
  }))
  const cell = (id, name, areaId, gateways) => ({
    ...CELL, cell_id: id, cell_name: name, area_id: areaId, gateways: gatewaysIn(id, gateways), gateway_count: gateways
  })
  // Line 4's area is not in the list, so its row shows the id; Line 2 is unfiled.
  const CELLS = [
    cell('cell-1', 'Line 1', 'area-1', 2),
    cell('cell-2', 'Line 2', null, 0),
    cell('cell-3', 'Line 3', 'area-2', 1),
    cell('cell-4', 'Line 4', RETIRED_AREA, 3)
  ]
  // 1, 3, 0 and 2 devices, each resolving to its cell through its gateway.
  const DEVICES = [['cell-1', 1], ['cell-2', 3], ['cell-4', 2]].flatMap(([cellId, n]) =>
    Array.from({ length: n }, (_, i) => device({ asset_id: `${cellId}-dev-${i}`, asset_name: `${cellId}_Device_${i}`, effective_cell_id: cellId })))

  const renderSorted = async (url = '/cells') => {
    window.history.replaceState(null, '', url)
    api.get.mockImplementation((path) => {
      if (path.startsWith('/api/v1/areas')) return Promise.resolve(AREAS)
      return routeGet({ cells: CELLS, devices: DEVICES })(path)
    })
    render(<CellsTab showToast={vi.fn()} hasPermission={() => true} onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} onViewTrail={vi.fn()} />)
    await waitFor(() => expect(within(table()).getByText('Welding Hall')).toBeTruthy())
  }
  const names = () => [...table().querySelectorAll('tbody tr')].map(r => r.querySelector('strong').textContent)
  const address = () => window.location.pathname + window.location.search

  it('sorts Area by the area’s name, or its id where the name is unknown, with an unfiled cell last either way', async () => {
    await renderSorted()
    expect(within(rowFor('Line 4')).getByText(RETIRED_AREA)).toBeTruthy()
    const header = screen.getByRole('columnheader', { name: 'Area' })

    fireEvent.click(screen.getByRole('button', { name: 'Area' }))
    expect(names()).toEqual(['Line 3', 'Line 4', 'Line 1', 'Line 2'])
    expect(header).toHaveAttribute('aria-sort', 'ascending')
    expect(address()).toBe('/cells?sort=area')

    fireEvent.click(screen.getByRole('button', { name: 'Area' }))
    expect(names()).toEqual(['Line 1', 'Line 4', 'Line 3', 'Line 2'])
    expect(header).toHaveAttribute('aria-sort', 'descending')
    expect(address()).toBe('/cells?sort=-area')
  })

  it('sorts Assigned Gateways and Devices by how many each row holds', async () => {
    await renderSorted()
    fireEvent.click(screen.getByRole('button', { name: 'Assigned Gateways' }))
    expect(names()).toEqual(['Line 2', 'Line 3', 'Line 1', 'Line 4'])

    // The devices resolving to the cell, from the device list rather than the cell row.
    fireEvent.click(screen.getByRole('button', { name: 'Devices' }))
    expect(names()).toEqual(['Line 3', 'Line 1', 'Line 4', 'Line 2'])
    fireEvent.click(screen.getByRole('button', { name: 'Devices' }))
    expect(names()).toEqual(['Line 2', 'Line 4', 'Line 1', 'Line 3'])
  })

  it('opens sorted when the address already holds a sort', async () => {
    await renderSorted('/cells?sort=-gateways')
    expect(names()).toEqual(['Line 4', 'Line 1', 'Line 3', 'Line 2'])
    expect(screen.getByRole('columnheader', { name: 'Assigned Gateways' })).toHaveAttribute('aria-sort', 'descending')
    expect(address()).toBe('/cells?sort=-gateways')
  })
})
