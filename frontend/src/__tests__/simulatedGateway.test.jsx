import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import { api } from '../api'
import { PERMISSION_UUIDS } from '../constants'

/**
 * The Type column and the control behind it, in the Gateways tab. What is asserted: the four values
 * are not interchangeable, and Playback earns the fourth because a replayed spindle's readings did
 * happen on a real machine on the day of the capture; Playback cannot be chosen, since the single
 * Playback gateway is seeded and a trigger refuses any other; one control writes two columns, so
 * the translation happens in one place; and it is not a data-path switch.
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
  is_shadow: false,
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

const typeSelect = () => document.querySelector('#gateway-type')
/**
 * The row's Type cell in the table, not a badge in the drawer or an option in the filter bar.
 * Scoped to the table because the type filter renders an <option> per type and a page-wide search
 * matched "Remote" there first.
 */
const typeCell = () => within(document.querySelector('table')).getAllByText(
  /^(Host|Remote|Simulated|Playback)$/
)[0]

beforeEach(() => vi.clearAllMocks())

describe('the Type column', () => {

  it('reports a simulated gateway as Simulated', async () => {
    await show([gateway({ deployment: 'host', is_simulated: true })])
    expect(typeCell().textContent).toBe('Simulated')
  })

  it('reports a host-run gateway as Host', async () => {
    await show([gateway({ deployment: 'host' })])
    expect(typeCell().textContent).toBe('Host')
  })

  it('reports an appliance as Remote', async () => {
    await show([gateway({ deployment: 'remote' })])
    expect(typeCell().textContent).toBe('Remote')
  })

  it('reports the Playback gateway as Playback, not Simulated', async () => {
    // The precedence that earns the fourth value: the Playback gateway is necessarily simulated too,
    // so without an explicit order it lands in Simulated.
    await show([gateway({ deployment: 'host', is_simulated: true, is_shadow: true })])
    expect(typeCell().textContent).toBe('Playback')
  })

  it('reports a row with no deployment as Remote rather than Host', async () => {
    // Host is the type with no appliance to set up, so Remote is the safe reading of a missing value.
    const g = gateway()
    delete g.deployment
    await show([g])
    expect(typeCell().textContent).toBe('Remote')
  })

  // The drawer says the same one word as the column, in one badge. It once showed HOST-RUN and
  // SIMULATED as two, so the Playback gateway read as both.
  it.each([
    ['Simulated', { deployment: 'host', is_simulated: true }],
    ['Host', { deployment: 'host' }],
    ['Remote', { deployment: 'remote' }],
    ['Playback', { deployment: 'host', is_simulated: true, is_shadow: true }],
  ])('shows one %s badge in the drawer', async (label, fields) => {
    await show([gateway(fields)])
    fireEvent.click(within(document.querySelector('.page-main')).getByText('Playback_Lab'))
    const panel = within(document.querySelector('.context-panel'))

    expect(panel.getAllByText(/^(Host|Remote|Simulated|Playback)$/).map(el => el.textContent)).toEqual([label])
    expect(panel.queryByText('HOST-RUN')).toBeNull()
    expect(panel.queryByText('SIMULATED')).toBeNull()
  })
})

describe('the Type control', () => {

  it('offers exactly the three types a person may set', async () => {
    await show([gateway()])
    openEdit()
    const values = [...typeSelect().options].map(o => o.value)
    expect(values).toEqual(['remote', 'host', 'simulated'])
  })

  it('does not offer Playback', async () => {
    // The one Playback gateway is seeded and the database refuses any other.
    await show([gateway()])
    openEdit()
    expect([...typeSelect().options].map(o => o.value)).not.toContain('playback')
  })

  it('reflects the gateway it is editing', async () => {
    await show([gateway({ deployment: 'host', is_simulated: true })])
    openEdit()
    expect(typeSelect().value).toBe('simulated')
  })

  it('writes both columns when Simulated is chosen', async () => {
    // One control, two columns: the translation happens in one place, and completely.
    api.put.mockResolvedValue({})
    await show([gateway()])
    openEdit()
    fireEvent.change(typeSelect(), { target: { value: 'simulated' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.put).toHaveBeenCalled())
    const [, body] = api.put.mock.calls[0]
    expect(body.is_simulated).toBe(true)
    expect(body.deployment).toBe('host')
  })

  it('clears the simulated flag when the type moves back to Remote', async () => {
    // A simulated gateway cannot be remote, so leaving is_simulated set would send a refused write.
    api.put.mockResolvedValue({})
    await show([gateway({ deployment: 'host', is_simulated: true })])
    openEdit()
    fireEvent.change(typeSelect(), { target: { value: 'remote' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.put).toHaveBeenCalled())
    const [, body] = api.put.mock.calls[0]
    expect(body.deployment).toBe('remote')
    expect(body.is_simulated).toBe(false)
  })

  it('says that ingestion is unchanged', async () => {
    // Guards the misreading that choosing Simulated diverts or quarantines the data.
    await show([gateway({ deployment: 'host', is_simulated: true })])
    openEdit()
    expect(screen.getByText(/Ingestion is unchanged/i)).toBeInTheDocument()
  })

  it('says that devices inherit the mark', async () => {
    // Said beside the control, where somebody would look for a per-device setting that does not exist.
    await show([gateway({ deployment: 'host', is_simulated: true })])
    openEdit()
    expect(screen.getByText(/devices inherit the mark/i)).toBeInTheDocument()
  })
})

/**
 * The Location control, which the Type control governs: a Simulated or Shadow gateway cannot hold
 * a cell.
 */
describe('the Location control', () => {

  const cellSelect = () => document.querySelector('#gateway-cell')

  it('reports no cell for a simulated gateway, whatever scope is stored', async () => {
    // Simulated gateways must agree with each other about their location, since the Simulated lane
    // resolves ahead of any cell. The first keeps the harness's name so show() can wait on it.
    await show([
      gateway({ gateway_id: 'gw-a', deployment: 'host', is_simulated: true,
                cell_id: null, location_scope: 'site_wide' }),
      gateway({ gateway_id: 'gw-b', gateway_name: 'Sim_Plain', deployment: 'host', is_simulated: true,
                cell_id: null, location_scope: 'cell' })
    ])

    const table = within(document.querySelector('table'))
    expect(table.queryByText('Site-Wide')).toBeNull()
    expect(table.queryByText('No cell')).toBeNull()
  })

  it('still reports Site-Wide for a gateway that can hold a cell', async () => {
    // Site-Wide is a real answer for every gateway that can hold a cell.
    await show([gateway({ deployment: 'host', cell_id: null, location_scope: 'site_wide' })])
    expect(within(document.querySelector('table')).getByText('Site-Wide')).toBeInTheDocument()
  })

  it('offers Site-Wide as one radio of three, not as a checkbox beside the cell picker', async () => {
    await show([gateway()])
    openEdit()
    expect(screen.getByRole('radio', { name: /Site-Wide/i })).toBeInTheDocument()
    expect(within(cellSelect()).queryByRole('option', { name: /Site-Wide/i })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: /Site-Wide/i })).toBeNull()
  })

  it('disables the cell picker for a simulated gateway and says why', async () => {
    await show([gateway({ deployment: 'host', is_simulated: true, cell_id: null })])
    openEdit()
    expect(cellSelect().disabled).toBe(true)
    // A disabled control has to say which lane the devices land in instead.
    expect(screen.getByText(/resolve to the Simulated lane/i)).toBeInTheDocument()
  })

  it('does not show a stored site-wide scope on a gateway that cannot hold a cell', async () => {
    // A disabled box reading "Site-Wide" above a note saying simulated gateways have no cell would
    // contradict itself.
    await show([gateway({ deployment: 'host', is_simulated: true, cell_id: null, location_scope: 'site_wide' })])
    openEdit()
    expect(cellSelect().value).toBe('')
  })

  it('clears a cell when the type changes to Simulated, rather than letting the save be refused', async () => {
    // Otherwise the save is refused and the field is disabled, so the value cannot be cleared by hand.
    api.put.mockResolvedValue({})
    await show([gateway({ deployment: 'remote', cell_id: 'cell-1' })])
    openEdit()
    fireEvent.change(typeSelect(), { target: { value: 'simulated' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.put).toHaveBeenCalled())
    const [, body] = api.put.mock.calls[0]
    expect(body.is_simulated).toBe(true)
    expect(body.cell_id).toBeFalsy()
  })

  it('asks for the type before the location it governs', async () => {
    // A control that disables the one above it makes an operator re-read a decision already taken.
    await show([gateway()])
    openEdit()
    expect(typeSelect().compareDocumentPosition(cellSelect()) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy()
  })
})

describe('the Type control in a proposal', () => {
  // deployment and is_simulated are not proposable, so the patch drops them; a control left live
  // would let an Operator change the type and file a proposal that silently omits it.
  it('is disabled, and says why, for someone who may only propose', async () => {
    api.get.mockImplementation(routeGet([gateway()]))
    render(<GatewaysTab showToast={vi.fn()} hasPermission={(p) => p === PERMISSION_UUIDS.PROPOSAL_CREATE} />)
    await waitFor(() => expect(screen.getByText('Playback_Lab')).toBeTruthy())
    fireEvent.click(within(document.querySelector('.page-main')).getByText('Playback_Lab'))
    fireEvent.click(within(document.querySelector('.context-panel')).getByText('Propose a Change'))
    expect(typeSelect().disabled).toBe(true)
    expect(screen.getByText(/connector runs — an Administrator changes it/)).toBeTruthy()
  })

  it('stays live for someone who may manage gateways', async () => {
    await show([gateway()])
    openEdit()
    expect(typeSelect().disabled).toBe(false)
    expect(screen.queryByText(/connector runs — an Administrator changes it/)).toBeNull()
  })
})
