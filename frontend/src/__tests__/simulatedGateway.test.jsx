import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import { api } from '../api'

/**
 * `gateways.is_simulated` (migration 0052) in the Gateways tab.
 *
 * WHAT THIS FLAG IS FOR. Broker playback (`ingestion/capture.py`) publishes a recorded capture
 * back through the real broker down the real ingestion path -- deliberately, because a spoofed
 * fault is only useful if it is indistinguishable from a real one downstream. Once it lands,
 * this flag is the only thing that says the reading was replayed.
 *
 * THE TWO WAYS THE CONTROL CAN MISLEAD, which is what is asserted here rather than that it
 * renders:
 *
 *   1. BEING CONFUSED WITH `deployment`. They are different questions -- deployment is about where
 *      an edge appliance exists, simulated is about whether the readings are real -- and a
 *      physical appliance replaying a capture is virtual=false, simulated=true. If one ever
 *      implied the other, that gateway becomes unrepresentable and the marking silently stops
 *      meaning what it says.
 *
 *   2. READING AS A DATA-PATH SWITCH. Ticking it changes nothing about ingestion. An operator who
 *      believed it quarantined or diverted the replayed data would be wrong in the direction that
 *      matters, so the form says so where it is ticked.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

vi.mock('../lib/supabaseClient', () => ({
  supabase: { functions: { invoke: vi.fn() } }
}))

const gateway = (overrides = {}) => ({
  gateway_id: 'gggggggg-0000-4000-8000-000000000001',
  gateway_name: 'Playback_Lab',
  sparkplug_id: 'gwy110000000000400080000',
  status: 'ONLINE',
  deployment: 'remote',
  is_simulated: false,
  is_archived: false,
  cell_id: 'cell-1',
  location_scope: 'cell',
  access_url: '',
  devices: [],
  ...overrides
})

const CELLS = [{ cell_id: 'cell-1', cell_name: 'Assembly', is_archived: false }]

const routeGet = (rows) => (path) => {
  if (path.startsWith('/api/v1/cells')) return Promise.resolve(CELLS)
  if (path.startsWith('/api/v1/gateways')) return Promise.resolve(rows)
  return Promise.resolve([])
}

const show = async (rows) => {
  api.get.mockImplementation(routeGet(rows))
  render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} />)
  await waitFor(() => expect(screen.getByText('Playback_Lab')).toBeTruthy())
}

const openEdit = () => {
  fireEvent.click(within(document.querySelector('.page-main')).getByText('Playback_Lab'))
  fireEvent.click(within(document.querySelector('.context-panel')).getByText('Edit Details'))
}

const simulatedCheckbox = () => document.querySelector('#is_simulated')
const deploymentCheckbox = () => document.querySelector('#deployment')

beforeEach(() => vi.clearAllMocks())

describe('the SIMULATED badge', () => {

  it('is shown for a simulated gateway', async () => {
    await show([gateway({ is_simulated: true })])
    expect(screen.getAllByText('SIMULATED').length).toBeGreaterThan(0)
  })

  it('is absent for an ordinary one', async () => {
    await show([gateway()])
    expect(screen.queryByText('SIMULATED')).toBeNull()
  })

  it('appears alongside VIRTUAL rather than instead of it', async () => {
    // THE COMBINATION THAT MUST STAY SAYABLE. A cloud connector generating test data is both.
    await show([gateway({ deployment: 'host', is_simulated: true })])
    expect(screen.getAllByText('SIMULATED').length).toBeGreaterThan(0)
    expect(screen.getAllByText('VIRTUAL').length).toBeGreaterThan(0)
  })

  it('is shown for a simulated gateway that is not virtual', async () => {
    // The case that makes the two flags irreducible: a real appliance replaying a capture.
    await show([gateway({ deployment: 'remote', is_simulated: true })])
    expect(screen.getAllByText('SIMULATED').length).toBeGreaterThan(0)
    expect(screen.queryByText('VIRTUAL')).toBeNull()
  })
})

describe('the simulated checkbox', () => {

  it('reflects the gateway it is editing', async () => {
    await show([gateway({ is_simulated: true })])
    openEdit()
    expect(simulatedCheckbox().checked).toBe(true)
  })

  it('defaults to false for a gateway saved before 0052', async () => {
    // A row cached or created before the column existed has no such key. Absent must read as
    // false, which is what the column defaults to, rather than rendering indeterminate.
    const g = gateway()
    delete g.is_simulated
    await show([g])
    openEdit()
    expect(simulatedCheckbox().checked).toBe(false)
  })

  it('is independent of where the connector runs', async () => {
    // Ticking one must not move the other. They are two columns rather than one enum precisely so
    // that the combinations stay sayable -- an appliance out on the plant network replaying a
    // capture is remote AND simulated -- and wiring the checkboxes together would undo in the UI
    // what 0064 was careful to keep separate in the schema.
    //
    // The database refuses only ONE combination, simulated + remote (gateways_simulated_is_host),
    // and that is a CHECK rather than a disabled input: a rule stated where a reader finds it.
    await show([gateway()])
    openEdit()
    const before = deploymentCheckbox().checked
    fireEvent.click(simulatedCheckbox())
    expect(simulatedCheckbox().checked).toBe(true)
    // UNCHANGED, not a particular value: what is being asserted is that one control does not move
    // the other, and pinning the fixture's own default here would make this test fail the day
    // somebody changes the fixture rather than the day somebody wires the two together.
    expect(deploymentCheckbox().checked).toBe(before)
  })

  it('says that ingestion is unchanged', async () => {
    // THE MISREADING THIS PREVENTS: that ticking it diverts or quarantines the data. It does not,
    // and an operator who believed otherwise would be wrong in the direction that matters.
    await show([gateway()])
    openEdit()
    expect(screen.getByText(/Ingestion is unchanged/i)).toBeInTheDocument()
  })

  it('says that devices inherit it', async () => {
    // The design decision from 0052, surfaced where somebody would otherwise go looking for a
    // per-device setting that deliberately does not exist.
    await show([gateway()])
    openEdit()
    expect(screen.getByText(/devices inherit the mark/i)).toBeInTheDocument()
  })

  it('sends the flag on save', async () => {
    api.put.mockResolvedValue({})
    await show([gateway()])
    openEdit()
    fireEvent.click(simulatedCheckbox())
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.put).toHaveBeenCalled())
    const [, body] = api.put.mock.calls[0]
    expect(body.is_simulated).toBe(true)
  })
})
