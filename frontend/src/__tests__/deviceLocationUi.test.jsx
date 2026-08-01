import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { api } from '../api'
import { supabase } from '../lib/supabaseClient'

/**
 * The Devices tab's location UI (migration 0036).
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
  { gateway_id: 'gw-virtual', gateway_name: 'Virtual_Gateway', cell_id: null, location_scope: 'cell', is_virtual: true, status: 'ONLINE', is_archived: false, devices: [] }
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

const openEdit = () => fireEvent.click(screen.getByRole('button', { name: /^Edit/i }))

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

  it('clears the cell when Site-Wide is ticked, mirroring the CHECK constraint', async () => {
    await show([device({ cell_id: CELL_2, effective_cell_id: CELL_2, location_source: 'explicit' })])
    openEdit()
    fireEvent.click(screen.getByLabelText(/Site-Wide/i))
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
})

describe('the Sparkplug topic in the edit form', () => {
  // The help text used to read "Click to copy" beneath a plain <span>. Nothing there was
  // clickable -- only the id above it was -- so the dialog promised an affordance it did not
  // have. A rendered string cannot be asserted to be copyable by eye, hence these.
  const topicButton = () => screen.getByRole('button', { name: /Copy Sparkplug topic/i })

  it('renders the topic as a copy button, not as prose', async () => {
    await show([device()])
    openEdit()
    expect(topicButton()).toBeInTheDocument()
    expect(screen.queryByText(/Click to copy/i)).not.toBeInTheDocument()
  })

  it('fills the edge node segment in from the assigned gateway', async () => {
    // Copying a template with two holes in it is barely worth the click; one of them is known.
    await show([device()])
    openEdit()
    expect(topicButton().getAttribute('aria-label'))
      .toMatch(/spBv1\.0\/<group>\/DDATA\/gwy-1-sparkplug\/devaaaaaaaa000040008000/)
  })

  it('falls back to a placeholder when no gateway is assigned', async () => {
    await show([device({ active_gateway_id: '', effective_cell_id: null, location_source: 'unassigned' })])
    openEdit()
    expect(topicButton().getAttribute('aria-label')).toMatch(/<edge node>/)
  })

  it('copies the topic when clicked', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    await show([device()])
    openEdit()
    fireEvent.click(topicButton())

    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(writeText.mock.calls[0][0]).toBe(
      'spBv1.0/<group>/DDATA/gwy-1-sparkplug/devaaaaaaaa000040008000'
    )
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
  const quarantined = {
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
