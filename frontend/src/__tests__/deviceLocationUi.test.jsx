import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { api } from '../api'
import { supabase } from '../lib/supabaseClient'

/**
 * The Devices tab's location UI (archived migration 0036).
 *
 * The distinction under test throughout is between the RESOLVED cell and the EXPLICIT override.
 * They render the same cell name in the common case, so a regression that confused the two --
 * displaying `cell_id` instead of `effective_cell_id`, or writing the resolved value back as an
 * override on save -- would look entirely correct on screen while quietly detaching every
 * inherited device from its gateway.
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
  { gateway_id: 'gw-virtual', gateway_name: 'Virtual_Gateway', cell_id: null, location_scope: 'cell', deployment: 'host', status: 'ONLINE', is_archived: false, devices: [] },
  // `gateways_synthetic_has_no_cell` (0059) forbids a cell here, so cell_id is null by constraint
  // rather than by omission -- the fixture cannot be written any other way.
  { gateway_id: 'gw-sim', gateway_name: 'Sim_Gateway', cell_id: null, location_scope: 'cell', deployment: 'host', is_simulated: true, status: 'ONLINE', is_archived: false, devices: [] }
]

const CELLS = [
  { cell_id: CELL_1, cell_name: 'Assembly', is_archived: false },
  { cell_id: CELL_2, cell_name: 'Paint Shop', is_archived: false }
]

const routeGet = (rows, { quarantine = [], cells = CELLS } = {}) => (path) => {
  if (path.startsWith('/api/v1/gateways')) return Promise.resolve(GATEWAYS)
  if (path.startsWith('/api/v1/cells')) return Promise.resolve(cells)
  if (path.startsWith('/api/v1/quarantine')) return Promise.resolve(quarantine)
  if (path.startsWith('/api/v1/devices')) return Promise.resolve(rows)
  return Promise.resolve([])
}

const show = async (rows, options = {}) => {
  api.get.mockImplementation(routeGet(rows, options))
  render(<DevicesTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={() => true} />)
  await waitFor(() => expect(screen.getByText(options.expect || 'CNC_01')).toBeTruthy())
}

/**
 * Open the edit form for a device.
 *
 * Two clicks now, not one: the row's Edit button moved into the context panel with the rest of the
 * ACTIONS column, so a device is selected first and edited from the drawer. The form itself, and
 * everything these tests assert about it, is unchanged.
 */
const openEdit = (name = 'CNC_01') => {
  fireEvent.click(within(document.querySelector('.page-main')).getByText(name))
  fireEvent.click(within(document.querySelector('.context-panel')).getByText('Edit Details'))
}

beforeEach(() => vi.clearAllMocks())

describe('the cell column', () => {
  // Scoped to the row's Cell cell specifically. Cell names also appear in the filter dropdown,
  // and "Unassigned" is additionally the empty option of the row's own gateway picker.
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
      active_gateway_id: 'gw-virtual', effective_cell_id: null, gateway_cell_id: null,
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
    // THE BUG THIS COLUMN HAD. It tested `site_wide` by hand and let every other cell-less lane
    // fall through to "no cell name, therefore Unassigned" -- so a whole simulated fleet was
    // reported as a queue to drain while device_locations had answered `simulated` for all of it.
    //
    // The two are not interchangeable in either direction: Unassigned means nobody has decided,
    // and it is the lane that should empty; Simulated means the decision cannot be taken, because
    // gateways_synthetic_has_no_cell (0059) refuses the gateway a cell to inherit.
    await show([device({
      active_gateway_id: 'gw-sim', effective_cell_id: null, gateway_cell_id: null,
      location_source: 'simulated'
    })])
    expect(within(cellColumn()).getByText('Simulated')).toBeInTheDocument()
    expect(within(cellColumn()).queryByText(/Unassigned/)).not.toBeInTheDocument()
  })

  it('reports a shadow device as Shadow rather than folding it into Simulated', async () => {
    // The precedence the view keeps and this column has to keep with it: a replayed reading DID
    // happen, which is the opposite answer to a generated one.
    await show([device({
      active_gateway_id: 'gw-sim', effective_cell_id: null, gateway_cell_id: null,
      location_source: 'shadow'
    })])
    expect(within(cellColumn()).getByText('Shadow')).toBeInTheDocument()
  })

  it('does not offer unassigned advice to a simulated device', async () => {
    // unassignedHint() has no advice for a synthetic asset, because there is none to give: you
    // cannot file it in a cell, and you cannot give its gateway one either. The warning triangle
    // was promising a fix that does not exist.
    await show([device({
      active_gateway_id: 'gw-sim', effective_cell_id: null, gateway_cell_id: null,
      location_source: 'simulated'
    })])
    expect(within(cellColumn()).queryByText(/needs a cell|not assigned to a cell/i)).toBeNull()
  })
})

describe('the cell filter', () => {
  const cellSelect = () => screen.getByTitle(/Filter by the cell a device resolves to/i)

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
    // An option in the cell picker rather than a checkbox below it: `devices_site_wide_has_no_cell`
    // makes the two answers exclusive, and one control cannot hold both.
    fireEvent.change(document.querySelector('#device-cell-zone'), { target: { value: 'site_wide' } })
    fireEvent.click(screen.getByRole('button', { name: /Save Configuration/i }))

    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(api.put.mock.calls[0][1]).toMatchObject({ cell_id: '', location_scope: 'site_wide' })
  })

  it('says the device will land in the Unassigned queue when nothing can supply a cell', async () => {
    await show([device({
      active_gateway_id: 'gw-virtual', effective_cell_id: null, gateway_cell_id: null,
      location_source: 'unassigned'
    })])
    openEdit()
    expect(screen.getByText(/will appear in the Unassigned queue/i)).toBeInTheDocument()
  })

  it('keeps an archived cell selectable when the device already points at it', async () => {
    // Dropping it from the list would relocate the device on the next save.
    const cells = [...CELLS, { cell_id: 'cell-old', cell_name: 'Decommissioned Bay', is_archived: true }]
    await show([device({ cell_id: 'cell-old', effective_cell_id: 'cell-old', location_source: 'explicit' })], { cells })
    openEdit()
    expect(within(cellPicker()).getByText(/Decommissioned Bay \(archived\)/)).toBeInTheDocument()
  })

  it('offers Site-Wide inside the picker rather than as a checkbox beside it', async () => {
    await show([device()])
    openEdit()
    expect(within(cellPicker()).getByRole('option', { name: /Site-Wide/i })).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /Site-Wide/i })).toBeNull()
  })

  it('disables the picker when the serving gateway is simulated, and says which lane instead', async () => {
    // There is no CHECK on the device side, so a cell chosen here would be ACCEPTED and then
    // ignored -- device_locations resolves `simulated` ahead of every cell arm. Offering the
    // control would let somebody file an asset and watch it not move, which is worse than a
    // refusal: nothing reports an error.
    await show([device({ active_gateway_id: 'gw-sim', effective_cell_id: null, location_source: 'simulated' })])
    openEdit()
    expect(document.querySelector('#device-cell-zone').disabled).toBe(true)
    expect(screen.getByText(/belong to the Simulated lane/i)).toBeInTheDocument()
  })

  it('keeps a cell already stored on a device whose gateway went simulated', async () => {
    // DELIBERATELY UNLIKE THE GATEWAY FORM, which clears. Nothing here would be refused on save,
    // so clearing would destroy an operator's filing to enforce a rule the database does not have
    // -- and the value comes back into force by itself if the gateway stops being synthetic.
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
  // The help text used to read "Click to copy" beneath a plain <span>. Nothing there was
  // clickable -- only the id above it was -- so the dialog promised an affordance it did not have.
  // A rendered string cannot be asserted to be copyable by eye, hence these.
  //
  // THESE MOVED FROM THE EDIT DIALOG TO THE PANEL, and the coverage is unchanged in substance.
  // The dialog carried a duplicate of this topic alongside read-only Sparkplug ID and UUID blocks;
  // all three were removed, because an edit form whose majority cannot be edited teaches the reader
  // that its controls are decorative. The panel's copy is the one that was always the better answer
  // to "what does this device publish on" -- it needs no dialog opened, and its group comes from the
  // serving gateway rather than being left as a `<group>` hole to fill in by hand.
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
    // The removal itself, asserted -- otherwise the three blocks could drift back in and only the
    // absence of a test would notice.
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

describe('needs attention', () => {
  const attentionButton = () => screen.getByRole('button', { name: /Needs attention/i })

  it('counts an unassigned device', async () => {
    await show([device({
      active_gateway_id: 'gw-virtual', effective_cell_id: null, gateway_cell_id: null,
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
  // quarantine_id is the row's identity and the React key DevicesTab renders it under. Without
  // it the key was undefined on every quarantine row -- the console warning this fixture was
  // producing, and a real divergence from the API, which keys the table on it.
  const quarantined = {
    quarantine_id: 'qtn-0000-4000-8000-000000000003',
    asset_id: 'cccccccc-0000-4000-8000-000000000003',
    asset_name: 'Unknown_Robot',
    reported_identity: 'devffffffffffffffffffff1',
    quarantine_reason: 'UNKNOWN_DEVICE',
    gateway_id: 'gw-virtual',
    entity_type: 'DEVICE'
  }

  const openApproval = async () => {
    await show([], { quarantine: [quarantined], expect: 'Unknown_Robot' })
    fireEvent.click(screen.getAllByRole('button', { name: /Approve/i })[0])
    await waitFor(() => expect(screen.getByText(/Approve Discovered Device/i)).toBeTruthy())
  }

  it('offers a cell picker again, defaulting to inherit', async () => {
    await openApproval()
    const picker = screen.getByTitle(/Where this device sits/i)
    expect(picker.value).toBe('')
  })

  it('warns that a host-run gateway cannot supply a cell', async () => {
    await openApproval()
    expect(screen.getByText(/land in the Unassigned queue/i)).toBeInTheDocument()
  })

  it('forwards the chosen cell to the edge function', async () => {
    supabase.functions.invoke.mockResolvedValue({ data: { success: true }, error: null })
    await openApproval()
    fireEvent.change(screen.getByTitle(/Where this device sits/i), { target: { value: CELL_2 } })
    fireEvent.click(screen.getByRole('button', { name: /Approve & Onboard/i }))

    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalled())
    expect(supabase.functions.invoke.mock.calls[0][1].body).toMatchObject({
      device_id: quarantined.asset_id, cell_id: CELL_2, location_scope: 'cell'
    })
  })

  it('forwards inherit as an empty cell rather than omitting the key', async () => {
    // The edge function distinguishes absent (do not write) from empty (write NULL); the modal
    // always answers, so it always sends the key.
    supabase.functions.invoke.mockResolvedValue({ data: { success: true }, error: null })
    await openApproval()
    fireEvent.click(screen.getByRole('button', { name: /Approve & Onboard/i }))

    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalled())
    const body = supabase.functions.invoke.mock.calls[0][1].body
    expect(body.cell_id).toBe('')
    expect(body.location_scope).toBe('cell')
  })
})


/**
 * Shadow devices on the Devices page (roadmap item 17, migration 0060).
 *
 * `ensure_shadow_devices()` mints one per device a capture recorded, at the moment a playback
 * starts -- so a stack that has never replayed has none, and the first playback would otherwise
 * double the device list. Six machines become twelve rows, the new ones carrying the same schema
 * and similar readings as the machines they sit beside, with nothing saying which is which.
 *
 * The question a reader has about a number on this page is whether it HAPPENED, and a replay lane
 * answers that differently from a machine: its values did happen, on the real device, on the day
 * the capture was taken. That is worth a badge rather than a filter alone.
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
    await waitFor(() => expect(screen.getByText(/Show shadow devices \(1\)/)).toBeInTheDocument())
  })

  it('shows them when asked, marked as what they are', async () => {
    await show([device(), shadow()])
    fireEvent.click(await screen.findByText(/Show shadow devices \(1\)/))
    await waitFor(() => expect(screen.getByText('CNC_01 (replay)')).toBeInTheDocument())
    // The badge is on the ROW, not only implied by the filter: filters are forgotten, and the row
    // may be read later from a link or a screenshot.
    expect(screen.getByText('SHADOW')).toBeInTheDocument()
  })

  it('does not offer the toggle on a stack that has never replayed', async () => {
    // Most stacks. A permanent "Show shadow devices (0)" would take width from filters that do something.
    await show([device()])
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeInTheDocument())
    expect(screen.queryByText(/Show shadow devices/)).toBeNull()
  })

  it('is orthogonal to the archived filter, which is why it is not a filterMode', async () => {
    // A replay lane can be archived or not. Folding it into active/archived/all would make one of
    // those combinations unreachable.
    await show([device(), shadow({ is_archived: true })])
    fireEvent.click(await screen.findByText(/Show shadow devices \(1\)/))
    await waitFor(() => expect(screen.getByText('CNC_01 (replay)')).toBeInTheDocument())
    expect(screen.getByText('ARCHIVED')).toBeInTheDocument()
  })
})


/**
 * Actions withdrawn from a shadow device (migration 0060).
 *
 * 0060 states both rules and gives the reason for each, so these are not taste:
 *
 *   "NO NAMEPLATE. device_nameplate (0011) is IDTA Nameplate -- manufacturer, SERIAL NUMBER, year
 *    of construction. A serial number identifies one physical object. Copying it would leave the
 *    platform holding two rows claiming to be serial XYZ-4471, and the AAS Part 5 export would emit
 *    two Asset Administration Shells asserting the same asset identity."
 *
 *   "NO LINKS. `links` are documents ABOUT the machine, and a copy goes stale the moment someone
 *    edits the original. `shadow_of` resolves them at read time instead."
 *
 * Offering either control would let an operator create by hand exactly what the migration exists to
 * prevent -- one field at a time, with nothing to stop them.
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
    fireEvent.click(await screen.findByText(/Show shadow devices \(1\)/))
    fireEvent.click(await screen.findByText('CNC_01 (replay)'))
    return within(document.querySelector('.context-panel'))
  }

  it('offers no Digital Nameplate', async () => {
    const panel = await openShadowPanel()
    expect(panel.queryByText(/Digital Nameplate/)).toBeNull()
  })

  it('offers no Manage Links', async () => {
    const panel = await openShadowPanel()
    expect(panel.queryByText('Manage Links')).toBeNull()
  })

  it('still offers the AAS exports, which 0060 designed for', async () => {
    /*
     * DELIBERATELY KEPT, and this is the one of the three that the migration argues FOR rather than
     * against: "A shadow exports without a Nameplate submodel, which is honest -- it is not a
     * product and has no manufacturer." 0011's rule is that a device with no nameplate data has no
     * row rather than a row of nulls, and the exporter omits an empty submodel entirely.
     *
     * So the export is defined, produces a shell with no asset identity to collide with, and is
     * the thing the nameplate withdrawal above makes safe. Removing it would remove a capability
     * the migration explicitly reasoned about.
     */
    const panel = await openShadowPanel()
    expect(panel.queryByText(/Export AAS JSON/)).not.toBeNull()
  })

  it('leaves all three on an ordinary device', async () => {
    // The guard is about `shadow_of`, not about devices in general.
    await show([device()])
    fireEvent.click(within(document.querySelector('.page-main')).getByText('CNC_01'))
    const panel = within(document.querySelector('.context-panel'))
    expect(panel.queryByText(/Digital Nameplate/)).not.toBeNull()
    expect(panel.queryByText('Manage Links')).not.toBeNull()
    expect(panel.queryByText(/Export AAS JSON/)).not.toBeNull()
  })
})
