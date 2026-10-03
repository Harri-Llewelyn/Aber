import React from 'react'
import { render, screen, waitFor, fireEvent, within, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { api } from '../api'
import { supabase } from '../lib/supabaseClient'

/**
 * The Devices tab's location UI. The distinction under test is between the resolved cell and the
 * explicit override: they render the same name in the common case, so confusing them would look
 * correct on screen while detaching every inherited device from its gateway on save.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

vi.mock('../lib/supabaseClient', () => ({
  supabase: { functions: { invoke: vi.fn() } }
}))

const CELL_1 = 'cell-1'
const CELL_2 = 'cell-2'

const device = (overrides = {}) => ({
  asset_id: 'aaaaaaaa-0000-4000-8000-000000000001',
  asset_name: 'CNC_01',
  sparkplug_id: 'devaaaaaaaa000040008000',
  status: 'ONLINE',
  is_quarantined: false,
  is_archived: false,
  active_gateway_id: 'gw-1',
  // Inherited by default: no explicit override, resolving to the gateway's cell.
  cell_id: null,
  location_scope: 'cell',
  effective_cell_id: CELL_1,
  gateway_cell_id: CELL_1,
  location_source: 'inherited',
  cell_mismatch: false,
  first_dbirth_at: '2026-07-27T12:00:00Z',
  created_at: '2026-07-20T12:00:00Z',
  ...overrides
})

const GATEWAYS = [
  { gateway_id: 'gw-1', gateway_name: 'Line_A_Gateway', sparkplug_id: 'gwy-1-sparkplug', cell_id: CELL_1, location_scope: 'cell', status: 'ONLINE', is_archived: false, devices: [] },
  { gateway_id: 'gw-host', gateway_name: 'Host_Gateway', cell_id: null, location_scope: 'cell', deployment: 'host', status: 'ONLINE', is_archived: false, devices: [] },
  // `gateways_synthetic_has_no_cell` (0001_baseline_schema.sql) forbids a cell here, so cell_id is null by constraint
  // rather than by omission -- the fixture cannot be written any other way.
  { gateway_id: 'gw-sim', gateway_name: 'Sim_Gateway', cell_id: null, location_scope: 'cell', deployment: 'host', is_simulated: true, status: 'ONLINE', is_archived: false, devices: [] }
]

const CELLS = [
  { cell_id: CELL_1, cell_name: 'Assembly', is_archived: false },
  { cell_id: CELL_2, cell_name: 'Paint Shop', is_archived: false }
]

const routeGet = (rows, { quarantine = [], cells = CELLS, areas = [] } = {}) => (path) => {
  if (path.startsWith('/api/v1/gateways')) return Promise.resolve(GATEWAYS)
  if (path.startsWith('/api/v1/areas')) return Promise.resolve(areas)
  if (path.startsWith('/api/v1/cells')) return Promise.resolve(cells)
  if (path.startsWith('/api/v1/quarantine')) return Promise.resolve(quarantine)
  if (path.startsWith('/api/v1/devices')) return Promise.resolve(rows)
  return Promise.resolve([])
}

const show = async (rows, options = {}) => {
  api.get.mockImplementation(routeGet(rows, options))
  render(<DevicesTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={() => true} />)
  if (options.tab) fireEvent.click(screen.getByRole('tab', { name: options.tab }))
  await waitFor(() => expect(screen.getByText(options.expect || 'CNC_01')).toBeTruthy())
}

/** Open the Registered tab's Filters popover, where all but search, status and attention live. */
const openFilters = () => {
  if (!screen.queryByRole('dialog', { name: 'Filters' })) fireEvent.click(screen.getByRole('button', { name: /^Filters/ }))
}

/** Open the edit form for a device: select the row, then Edit from the drawer. */
const openEdit = (name = 'CNC_01') => {
  fireEvent.click(within(document.querySelector('.page-main')).getByText(name))
  fireEvent.click(within(document.querySelector('.context-panel')).getByText('Edit Details'))
}

beforeEach(() => vi.clearAllMocks())

describe('the cell column', () => {
  // Scoped to the roster's Cell column. The only table is the roster while Registered is the tab.
  const cellColumn = () =>
    within(screen.getByRole('table')).getAllByRole('row')[1].querySelectorAll('td')[4]

  it('shows the resolved cell for an inherited device, with no "set on device" note', async () => {
    await show([device()])
    expect(within(cellColumn()).getByText('Assembly')).toBeInTheDocument()
    expect(within(cellColumn()).queryByText('Set on device')).not.toBeInTheDocument()
  })

  it('marks an explicitly filed device, since it will not move with its gateway', async () => {
    await show([device({ cell_id: CELL_2, effective_cell_id: CELL_2, location_source: 'explicit' })])
    expect(within(cellColumn()).getByText('Paint Shop')).toBeInTheDocument()
    expect(within(cellColumn()).getByText('Set on device')).toBeInTheDocument()
  })

  it('warns when a device is filed in a cell its gateway does not serve', async () => {
    await show([device({
      cell_id: CELL_2, effective_cell_id: CELL_2, location_source: 'explicit', cell_mismatch: true
    })])
    expect(within(cellColumn()).getByText(/Gateway elsewhere/)).toBeInTheDocument()
  })

  it('renders Unassigned as a warning rather than an em dash', async () => {
    // An em dash reads as "nothing to see here". This is a work queue entry.
    await show([device({
      active_gateway_id: 'gw-host', effective_cell_id: null, gateway_cell_id: null,
      location_source: 'unassigned'
    })])
    expect(within(cellColumn()).getByText(/Unassigned/)).toBeInTheDocument()
  })

  it('renders Site-Wide distinctly from Unassigned', async () => {
    await show([device({
      location_scope: 'site_wide', effective_cell_id: null, location_source: 'site_wide'
    })])
    expect(within(cellColumn()).getByText('Site-Wide')).toBeInTheDocument()
    expect(within(cellColumn()).queryByText(/Unassigned/)).not.toBeInTheDocument()
  })

  it('reports a simulated device as Simulated, not as Unassigned', async () => {
    // Unassigned and Simulated are not interchangeable: Unassigned means nobody has decided and
    // should empty; Simulated means the decision cannot be taken, because
    // gateways_synthetic_has_no_cell refuses the gateway a cell.
    await show([device({
      active_gateway_id: 'gw-sim', effective_cell_id: null, gateway_cell_id: null,
      location_source: 'simulated'
    })])
    expect(within(cellColumn()).getByText('Simulated')).toBeInTheDocument()
    expect(within(cellColumn()).queryByText(/Unassigned/)).not.toBeInTheDocument()
  })

  it('reports a replay lane as Replay lane rather than folding it into Simulated', async () => {
    // The precedence the view keeps and this column has to keep with it: a replayed reading DID
    // happen, which is the opposite answer to a generated one.
    await show([device({
      active_gateway_id: 'gw-sim', effective_cell_id: null, gateway_cell_id: null,
      location_source: 'shadow'
    })])
    expect(within(cellColumn()).getByText('Replay lane')).toBeInTheDocument()
  })

  it('does not offer unassigned advice to a simulated device', async () => {
    // unassignedHint() has no advice for a synthetic asset, because there is none to give.
    await show([device({
      active_gateway_id: 'gw-sim', effective_cell_id: null, gateway_cell_id: null,
      location_source: 'simulated'
    })])
    expect(within(cellColumn()).queryByText(/needs a cell|not assigned to a cell/i)).toBeNull()
  })
})

describe('the cell filter', () => {
  const cellSelect = () => { openFilters(); return screen.getByTitle(/Filter by the cell a device resolves to/i) }

  it('matches an inherited device when filtering by its resolved cell', async () => {
    // The regression this guards: filtering on cell_id would match only explicitly filed
    // devices and silently hide every inherited one.
    await show([device()])
    fireEvent.change(cellSelect(), { target: { value: CELL_1 } })
    expect(screen.getByText('CNC_01')).toBeInTheDocument()
  })

  it('offers Unassigned and Site-Wide as lanes beside the real cells', async () => {
    await show([device()])
    const options = within(cellSelect()).getAllByRole('option').map(o => o.textContent)
    expect(options).toEqual(expect.arrayContaining([
      'Any cell', 'Unassigned (needs a cell)', 'Site-Wide', 'Assembly', 'Paint Shop'
    ]))
  })

  it('the Unassigned lane selects only devices with no resolved cell', async () => {
    await show([
      device(),
      device({ asset_id: 'bbbbbbbb-0000-4000-8000-000000000002', asset_name: 'AGV_01',
               effective_cell_id: null, gateway_cell_id: null, location_source: 'unassigned' })
    ])
    fireEvent.change(cellSelect(), { target: { value: '__unassigned__' } })
    expect(screen.getByText('AGV_01')).toBeInTheDocument()
    expect(screen.queryByText('CNC_01')).not.toBeInTheDocument()
  })

  it('the Site-Wide lane does not pick up merely unassigned devices', async () => {
    // The two must not merge: Unassigned is a queue that should drain, Site-Wide is a home.
    await show([
      device({ asset_name: 'BMS', location_scope: 'site_wide', effective_cell_id: null, location_source: 'site_wide' }),
      device({ asset_id: 'bbbbbbbb-0000-4000-8000-000000000002', asset_name: 'AGV_01',
               effective_cell_id: null, gateway_cell_id: null, location_source: 'unassigned' })
    ], { expect: 'BMS' })
    fireEvent.change(cellSelect(), { target: { value: '__site_wide__' } })
    expect(screen.getByText('BMS')).toBeInTheDocument()
    expect(screen.queryByText('AGV_01')).not.toBeInTheDocument()
  })
})

describe('the edit form', () => {
  const cellPicker = () => screen.getByTitle(/Where this device physically sits/i)

  it('names the inherited cell in the placeholder instead of calling it "None"', async () => {
    // Empty means INHERIT, not unassigned. A "None" label would misdescribe the default.
    await show([device()])
    openEdit()
    expect(within(cellPicker()).getByText(/Inherit from gateway \(Assembly\)/)).toBeInTheDocument()
  })

  it('leaves the picker empty for an inherited device, so saving does not create an override', async () => {
    await show([device()])
    openEdit()
    expect(cellPicker().value).toBe('')
  })

  it('preselects the explicit cell for a device that has one', async () => {
    await show([device({ cell_id: CELL_2, effective_cell_id: CELL_2, location_source: 'explicit' })])
    openEdit()
    expect(cellPicker().value).toBe(CELL_2)
  })

  it('sends the empty cell as inherit rather than writing the resolved value back', async () => {
    // The subtle regression: prefilling the picker with effective_cell_id would silently
    // convert every inherited device into an explicitly filed one on the next save.
    await show([device()])
    openEdit()
    fireEvent.click(screen.getByRole('button', { name: /Save Configuration/i }))

    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(api.put.mock.calls[0][1]).toMatchObject({ cell_id: '', location_scope: 'cell' })
  })

  it('writes an explicit cell when one is chosen', async () => {
    await show([device()])
    openEdit()
    fireEvent.change(cellPicker(), { target: { value: CELL_2 } })
    fireEvent.click(screen.getByRole('button', { name: /Save Configuration/i }))

    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(api.put.mock.calls[0][1]).toMatchObject({ cell_id: CELL_2 })
  })

  it('clears the cell when Site-Wide is chosen, mirroring the CHECK constraint', async () => {
    await show([device({ cell_id: CELL_2, effective_cell_id: CELL_2, location_source: 'explicit' })])
    openEdit()
    // One radio of three rather than a checkbox beside the cell picker:
    // `devices_site_wide_has_no_cell` makes the answers exclusive, and a radio group says so.
    fireEvent.click(screen.getByRole('radio', { name: /Site-Wide/i }))
    fireEvent.click(screen.getByRole('button', { name: /Save Configuration/i }))

    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(api.put.mock.calls[0][1]).toMatchObject({ cell_id: '', location_scope: 'site_wide' })
  })

  it('says the device will show under Unassigned when nothing can supply a cell', async () => {
    await show([device({
      active_gateway_id: 'gw-host', effective_cell_id: null, gateway_cell_id: null,
      location_source: 'unassigned'
    })])
    openEdit()
    expect(screen.getByText(/will show under Unassigned in the Cell filter/i)).toBeInTheDocument()
  })

  it('keeps an archived cell selectable when the device already points at it', async () => {
    // Dropping it from the list would relocate the device on the next save.
    const cells = [...CELLS, { cell_id: 'cell-old', cell_name: 'Decommissioned Bay', is_archived: true }]
    await show([device({ cell_id: 'cell-old', effective_cell_id: 'cell-old', location_source: 'explicit' })], { cells })
    openEdit()
    expect(within(cellPicker()).getByText(/Decommissioned Bay \(archived\)/)).toBeInTheDocument()
  })

  it('offers the three scopes as one exclusive choice, with the cell list only under In a cell', async () => {
    await show([device()])
    openEdit()
    const radios = screen.getAllByRole('radio').map(r => r.value)
    expect(radios).toEqual(['cell', 'area_wide', 'site_wide'])
    expect(screen.getByRole('radio', { name: /In a cell/i })).toBeChecked()
    // Site-Wide is not a checkbox reaching over to clear the select, and not an entry in it either:
    // the cell list holds cells.
    expect(screen.queryByRole('checkbox', { name: /Site-Wide/i })).toBeNull()
    expect(within(cellPicker()).queryByRole('option', { name: /Site-Wide/i })).toBeNull()

    fireEvent.click(screen.getByRole('radio', { name: /Site-Wide/i }))
    expect(document.querySelector('#device-cell')).toBeNull()
  })

  it('withholds Area-Wide until an area exists, and names the only one without asking', async () => {
    await show([device()])
    openEdit()
    expect(screen.getByRole('radio', { name: /Area-Wide/i })).toBeDisabled()
    cleanup()

    await show([device()], { areas: [{ area_id: 'area-1', area_name: 'Area 1', cells: [], cell_count: 0 }] })
    openEdit()
    fireEvent.click(screen.getByRole('radio', { name: /Area-Wide/i }))
    // One area: no dropdown, its name is stated and the save carries it.
    expect(document.querySelector('#device-area')).toBeNull()
    expect(screen.getByText('Area 1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Save Configuration/i }))
    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(api.put.mock.calls[0][1]).toMatchObject({ cell_id: '', area_id: 'area-1', location_scope: 'area_wide' })
  })

  it('asks which area when there are several, and holds the save until one is chosen', async () => {
    await show([device()], {
      areas: [
        { area_id: 'area-1', area_name: 'Area 1', cells: [], cell_count: 0 },
        { area_id: 'area-2', area_name: 'Area 2', cells: [], cell_count: 0 }
      ]
    })
    openEdit()
    fireEvent.click(screen.getByRole('radio', { name: /Area-Wide/i }))
    const areaPicker = document.querySelector('#device-area')
    expect(areaPicker.value).toBe('')
    // `devices_area_wide_names_its_area` would refuse the row, so the button says so instead.
    expect(screen.getByRole('button', { name: /Save Configuration/i })).toBeDisabled()

    fireEvent.change(areaPicker, { target: { value: 'area-2' } })
    fireEvent.click(screen.getByRole('button', { name: /Save Configuration/i }))
    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(api.put.mock.calls[0][1]).toMatchObject({ cell_id: '', area_id: 'area-2', location_scope: 'area_wide' })
  })

  it('disables the picker when the serving gateway is simulated, and says which lane instead', async () => {
    // There is no CHECK on the device side, so a cell chosen here would be accepted and then
    // ignored, since device_locations resolves `simulated` ahead of every cell arm. The control is
    // withheld.
    await show([device({ active_gateway_id: 'gw-sim', effective_cell_id: null, location_source: 'simulated' })])
    openEdit()
    expect(document.querySelector('#device-cell').disabled).toBe(true)
    expect(screen.getByText(/belong to the Simulated lane/i)).toBeInTheDocument()
  })

  it('keeps a cell already stored on a device whose gateway went simulated', async () => {
    // Unlike the gateway form, which clears: nothing here would be refused on save, and the value
    // comes back into force if the gateway stops being synthetic.
    api.put.mockResolvedValue({})
    await show([device({
      active_gateway_id: 'gw-sim', cell_id: CELL_2, effective_cell_id: null, location_source: 'simulated'
    })])
    openEdit()
    fireEvent.click(screen.getByRole('button', { name: /Save Configuration/i }))

    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(api.put.mock.calls[0][1]).toMatchObject({ cell_id: CELL_2 })
  })
})

describe('the Sparkplug topic in the context panel', () => {
  // The topic is a copy control in the panel, not help text beneath a plain span. Its group comes
  // from the serving gateway.
  const topicButton = () =>
    within(document.querySelector('.context-panel')).getByRole('button', { name: /Copy sparkplug topic path/i })

  const openPanel = (name = 'CNC_01') => fireEvent.click(
    within(document.querySelector('.page-main')).getByText(name)
  )

  it('renders the topic as a copy button, not as prose', async () => {
    await show([device()])
    openPanel()
    expect(topicButton()).toBeInTheDocument()
    expect(screen.queryByText(/Click to copy/i)).not.toBeInTheDocument()
  })

  it('fills the edge node segment in from the serving gateway', async () => {
    // Copying a template with holes in it is barely worth the click, and both are known here.
    await show([device()])
    openPanel()
    expect(topicButton().getAttribute('aria-label'))
      .toMatch(/DDATA\/gwy-1-sparkplug\/devaaaaaaaa000040008000/)
  })

  it('falls back to a wildcard segment when no gateway is assigned', async () => {
    await show([device({ active_gateway_id: '', effective_cell_id: null, location_source: 'unassigned' })])
    openPanel()
    // `+` rather than a `<placeholder>`: it is a valid MQTT wildcard, so the topic stays paste-able.
    expect(topicButton().getAttribute('aria-label')).toMatch(/DDATA\/\+\//)
  })

  it('copies the topic when clicked', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    await show([device()])
    openPanel()
    fireEvent.click(topicButton())

    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(writeText.mock.calls[0][0]).toMatch(
      /^spBv1\.0\/.+\/DDATA\/gwy-1-sparkplug\/devaaaaaaaa000040008000$/
    )
  })

  it('no longer duplicates the identifiers inside the edit dialog', async () => {
    await show([device()])
    openEdit()
    const modal = document.querySelector('.modal')
    expect(within(modal).queryByRole('button', { name: /Copy Sparkplug topic/i })).toBeNull()
    expect(within(modal).queryByText('Internal UUID')).toBeNull()
    expect(within(modal).queryByText('Sparkplug ID')).toBeNull()
    // And the transport picker, which offered protocols ingestion cannot read.
    expect(within(modal).queryByText('Connection Method')).toBeNull()
    // What replaced them.
    expect(within(modal).getByText('Description')).toBeInTheDocument()
  })
})

describe('the Location row in the context panel', () => {
  // One row in place of three. The cells are filed into areas here, so the area resolves.
  const FILED = [
    { cell_id: CELL_1, cell_name: 'Assembly', area_id: 'area-1', is_archived: false },
    { cell_id: CELL_2, cell_name: 'Paint Shop', area_id: 'area-1', is_archived: false }
  ]
  const AREAS = [{ area_id: 'area-1', area_name: 'North Shop' }]

  const location = async (overrides) => {
    await show([device(overrides)], { cells: FILED, areas: AREAS })
    fireEvent.click(within(document.querySelector('.page-main')).getByText('CNC_01'))
    const field = [...document.querySelectorAll('.context-panel .context-field')]
      .find(f => f.querySelector('.context-field-label').textContent === 'Location')
    return field.querySelector('.context-field-value')
  }

  it('is one row: the area and the cell, marked as from the gateway when inherited', async () => {
    const value = await location()
    expect(value.textContent).toBe('North Shop›Assembly(from gateway)')
    expect(within(value).getByRole('button', { name: /North Shop/ })).toHaveAttribute('title', 'Open this area on the Areas page')
    expect(within(value).getByRole('button', { name: /Assembly/ })).toHaveAttribute('title', 'Open this cell on the Cells page')
    const labels = [...document.querySelectorAll('.context-panel .context-field-label')].map(l => l.textContent)
    expect(labels).not.toContain('Area (resolved)')
    expect(labels).not.toContain('Location Source')
  })

  it('drops "(from gateway)" for a device filed on itself', async () => {
    const value = await location({ cell_id: CELL_2, location_source: 'explicit' })
    expect(value.textContent).toBe('North Shop›Paint Shop')
    expect(value).toHaveAttribute('title', expect.stringMatching(/^Set on the device itself/))
  })

  it('says Unassigned, as a warning, when nothing supplies a cell', async () => {
    const value = await location({ active_gateway_id: 'gw-host', effective_cell_id: null, gateway_cell_id: null, location_source: 'unassigned' })
    expect(value.textContent).toBe('Unassigned')
    expect(value.querySelector('.badge-warning svg')).toBeTruthy()
  })

  it('names the area of an Area-Wide device, and Site-Wide alone', async () => {
    let value = await location({ location_scope: 'area_wide', area_id: 'area-1', effective_cell_id: null, location_source: 'area_wide' })
    expect(value.textContent).toBe('North Shop›Area-Wide')
    cleanup()
    value = await location({ location_scope: 'site_wide', effective_cell_id: null, location_source: 'site_wide' })
    expect(value.textContent).toBe('Site-Wide')
  })
})

describe('needs attention', () => {
  const attentionButton = () => screen.getByRole('button', { name: /Needs attention/i })

  it('counts an unassigned device', async () => {
    await show([device({
      active_gateway_id: 'gw-host', effective_cell_id: null, gateway_cell_id: null,
      location_source: 'unassigned'
    })])
    expect(attentionButton().textContent).toMatch(/\(1\)/)
  })

  it('counts a device filed against its gateway, and one pointing at an archived cell', async () => {
    const cells = [...CELLS, { cell_id: 'cell-old', cell_name: 'Decommissioned Bay', is_archived: true }]
    await show([
      device({ cell_id: CELL_2, effective_cell_id: CELL_2, location_source: 'explicit', cell_mismatch: true }),
      device({ asset_id: 'bbbbbbbb-0000-4000-8000-000000000002', asset_name: 'Press_01',
               cell_id: 'cell-old', effective_cell_id: 'cell-old', location_source: 'explicit' })
    ], { cells })
    expect(attentionButton().textContent).toMatch(/\(2\)/)
  })

  it('does not count a Site-Wide device: that is an answer, not an omission', async () => {
    await show([device({
      location_scope: 'site_wide', effective_cell_id: null, location_source: 'site_wide'
    })])
    expect(attentionButton().textContent).toMatch(/\(0\)/)
  })
})

describe('approving a quarantined device', () => {
  // quarantine_id is the row's identity and the React key DevicesTab renders it under.
  const quarantined = {
    quarantine_id: 'qtn-0000-4000-8000-000000000003',
    asset_id: 'cccccccc-0000-4000-8000-000000000003',
    asset_name: 'Unknown_Robot',
    reported_identity: 'devffffffffffffffffffff1',
    quarantine_reason: 'UNKNOWN_DEVICE',
    gateway_id: 'gw-host',
    entity_type: 'DEVICE'
  }

  // The row's button and the dialog's submit share a label; the dialog's is the one inside it.
  const approveButton = () =>
    within(screen.getByRole('dialog')).getByRole('button', { name: /Approve & Onboard/i })

  const openApproval = async () => {
    await show([], { quarantine: [quarantined], expect: 'Unknown_Robot', tab: /^Quarantine/ })
    fireEvent.click(screen.getAllByRole('button', { name: /Approve/i })[0])
    await waitFor(() => expect(screen.getByText(/Approve Discovered Device/i)).toBeTruthy())
  }

  it('offers a cell picker again, defaulting to inherit', async () => {
    await openApproval()
    const picker = screen.getByTitle(/Where this device sits/i)
    expect(picker.value).toBe('')
  })

  it('warns that a gateway with no cell leaves the device without one', async () => {
    await openApproval()
    expect(screen.getByText(/will show under Unassigned in the Cell filter/i)).toBeInTheDocument()
  })

  it('forwards the chosen cell to the edge function', async () => {
    supabase.functions.invoke.mockResolvedValue({ data: { success: true }, error: null })
    await openApproval()
    fireEvent.change(screen.getByTitle(/Where this device sits/i), { target: { value: CELL_2 } })
    fireEvent.click(approveButton())

    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalled())
    expect(supabase.functions.invoke.mock.calls[0][1].body).toMatchObject({
      device_id: quarantined.asset_id, cell_id: CELL_2, location_scope: 'cell'
    })
  })

  it('forwards Area-Wide with its area, and holds the button until an area is named', async () => {
    supabase.functions.invoke.mockResolvedValue({ data: { success: true }, error: null })
    api.get.mockImplementation(routeGet([], {
      quarantine: [quarantined],
      areas: [
        { area_id: 'area-1', area_name: 'Area 1', cells: [], cell_count: 0 },
        { area_id: 'area-2', area_name: 'Area 2', cells: [], cell_count: 0 }
      ]
    }))
    render(<DevicesTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={() => true} />)
    fireEvent.click(screen.getByRole('tab', { name: /^Quarantine/ }))
    await waitFor(() => expect(screen.getByText('Unknown_Robot')).toBeTruthy())
    fireEvent.click(screen.getAllByRole('button', { name: /Approve/i })[0])
    await waitFor(() => expect(screen.getByText(/Approve Discovered Device/i)).toBeTruthy())

    fireEvent.click(screen.getByRole('radio', { name: /Area-Wide/i }))
    expect(approveButton()).toBeDisabled()
    fireEvent.change(document.querySelector('#approve-area'), { target: { value: 'area-2' } })
    fireEvent.click(approveButton())

    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalled())
    expect(supabase.functions.invoke.mock.calls[0][1].body).toMatchObject({
      device_id: quarantined.asset_id, cell_id: '', area_id: 'area-2', location_scope: 'area_wide'
    })
  })

  it('forwards inherit as an empty cell rather than omitting the key', async () => {
    // The edge function distinguishes absent (do not write) from empty (write NULL); the modal
    // always answers, so it always sends the key.
    supabase.functions.invoke.mockResolvedValue({ data: { success: true }, error: null })
    await openApproval()
    fireEvent.click(approveButton())

    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalled())
    const body = supabase.functions.invoke.mock.calls[0][1].body
    expect(body.cell_id).toBe('')
    expect(body.location_scope).toBe('cell')
  })
})


/**
 * Replay lanes on the Devices page. `ensure_shadow_devices()` mints one per captured device when
 * a playback starts, so the first playback doubles the list; a replay lane's values did happen, on
 * the real device, on the day of the capture, which is worth a badge rather than a filter alone.
 */
describe('replay lanes', () => {
  const shadow = (overrides = {}) => device({
    asset_id: 'ssssssss-0000-4000-8000-000000000001',
    asset_name: 'CNC_01 (replay)',
    shadow_of: 'aaaaaaaa-0000-4000-8000-000000000001',
    active_gateway_id: 'gw-sim',
    effective_cell_id: null,
    location_source: 'shadow',
    ...overrides,
  })

  it('hides them by default, so a playback does not double the device list', async () => {
    await show([device(), shadow()])
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeInTheDocument())
    expect(screen.queryByText('CNC_01 (replay)')).toBeNull()
  })

  it('offers a toggle counting what is hidden', async () => {
    // COUNTED ACROSS EVERY DEVICE, not the filtered list -- counting the rows on screen would
    // report zero exactly when the button is worth pressing.
    await show([device(), shadow()])
    openFilters()
    await waitFor(() => expect(screen.getByText(/Show replay lanes \(1\)/)).toBeInTheDocument())
  })

  it('shows them when asked, marked as what they are', async () => {
    await show([device(), shadow()])
    openFilters()
    fireEvent.click(await screen.findByText(/Show replay lanes \(1\)/))
    await waitFor(() => expect(screen.getByText('CNC_01 (replay)')).toBeInTheDocument())
    // The badge is on the ROW, not only implied by the filter: filters are forgotten, and the row
    // may be read later from a link or a screenshot.
    expect(within(screen.getByText('CNC_01 (replay)').closest('td')).getByText('Replay lane')).toBeInTheDocument()
  })

  it('does not offer the toggle on a stack that has never replayed', async () => {
    // Most stacks. A permanent "Show replay lanes (0)" would be a control that does nothing.
    await show([device()])
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeInTheDocument())
    openFilters()
    expect(screen.queryByText(/Show replay lanes/)).toBeNull()
  })

  it('is orthogonal to the archived filter, which is why it is not a filterMode', async () => {
    // A replay lane can be archived or not. Folding it into active/archived/all would make one of
    // those combinations unreachable.
    await show([device(), shadow({ is_archived: true })])
    openFilters()
    fireEvent.click(await screen.findByText(/Show replay lanes \(1\)/))
    fireEvent.change(screen.getByTitle('Filter by lifecycle state'), { target: { value: 'all' } })
    await waitFor(() => expect(screen.getByText('CNC_01 (replay)')).toBeInTheDocument())
    expect(screen.getAllByText('ARCHIVED').length).toBeGreaterThan(0)
  })
})


/**
 * Actions withdrawn from a shadow device: no nameplate, because a serial number identifies one
 * physical object and a copy would export two shells asserting the same asset identity; no links,
 * because a copy goes stale and `shadow_of` resolves them at read time.
 */
describe('the actions a shadow device does not offer', () => {
  const shadowDevice = () => device({
    asset_id: 'ssssssss-0000-4000-8000-000000000001',
    asset_name: 'CNC_01 (replay)',
    shadow_of: 'aaaaaaaa-0000-4000-8000-000000000001',
    active_gateway_id: 'gw-sim',
    effective_cell_id: null,
    location_source: 'shadow',
  })

  const openShadowPanel = async () => {
    await show([device(), shadowDevice()])
    openFilters()
    fireEvent.click(await screen.findByText(/Show replay lanes \(1\)/))
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(await screen.findByText('CNC_01 (replay)'))
    return within(document.querySelector('.context-panel'))
  }

  it('offers no Digital Nameplate', async () => {
    const panel = await openShadowPanel()
    expect(panel.queryByText(/Digital Nameplate/)).toBeNull()
  })

  it('offers no Attached Links', async () => {
    const panel = await openShadowPanel()
    expect(panel.queryByText('Attached Links')).toBeNull()
  })

  it('still offers the export on a replay lane', async () => {
    // A replay lane exports without a Nameplate submodel: a shell with no asset identity. The
    // dialog withholds only the bundle (aasExport.test.jsx).
    const panel = await openShadowPanel()
    expect(panel.queryByText(/Export…/)).not.toBeNull()
  })

  it('leaves all three on an ordinary device', async () => {
    // The guard is about `shadow_of`, not about devices in general.
    await show([device()])
    fireEvent.click(within(document.querySelector('.page-main')).getByText('CNC_01'))
    const panel = within(document.querySelector('.context-panel'))
    expect(panel.queryByText(/Digital Nameplate/)).not.toBeNull()
    expect(panel.queryByText('Attached Links')).not.toBeNull()
    expect(panel.queryByText(/Export…/)).not.toBeNull()
  })
})
