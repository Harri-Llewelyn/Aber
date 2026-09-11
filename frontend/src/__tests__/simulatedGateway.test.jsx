import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import { api } from '../api'

/**
 * The Type column and the control behind it, in the Gateways tab. What is asserted: the four values
 * are not interchangeable, and Shadow earns the fourth because a shadow spindle's readings did
 * happen on a real machine on the day of the capture; Shadow cannot be chosen, since the single
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
  // A shadow gateway is filtered out of the fleet list by default, so a fixture that is one has to
  // be revealed before the Type column can be read. The filter has its own test elsewhere.
  if (rows.some(r => r.is_shadow)) {
    fireEvent.click(await screen.findByText(/Show playback gateway/))
  }
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
  /^(Host|Remote|Simulated|Shadow)$/
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

  it('reports a shadow gateway as Shadow, not Simulated', async () => {
    // The precedence that earns the fourth value: a shadow gateway is necessarily simulated too, so
    // without an explicit order it lands in Simulated.
    await show([gateway({ deployment: 'host', is_simulated: true, is_shadow: true })])
    expect(typeCell().textContent).toBe('Shadow')
  })

  it('reports a row with no deployment as Remote rather than Host', async () => {
    // A row with no deployment set: Host is the type with no appliance and no enrolment, so the
    // safe direction is the one that says there may be hardware to install.
    const g = gateway()
    delete g.deployment
    await show([g])
    expect(typeCell().textContent).toBe('Remote')
  })

  it('no longer shows the badges it replaced', async () => {
    await show([gateway({ deployment: 'host', is_simulated: true })])
    expect(screen.queryByText('VIRTUAL')).toBeNull()
    expect(screen.queryByText('SIMULATED')).toBeNull()
  })
})

describe('the Type control', () => {

  it('offers exactly the three types a person may set', async () => {
    await show([gateway()])
    openEdit()
    const values = [...typeSelect().options].map(o => o.value)
    expect(values).toEqual(['remote', 'host', 'simulated'])
  })

  it('does not offer Shadow', async () => {
    // The one shadow gateway is seeded and a BEFORE INSERT trigger refuses any other, so offering
    // it here would be offering to fabricate the row that exists to be unique.
    await show([gateway()])
    openEdit()
    expect([...typeSelect().options].map(o => o.value)).not.toContain('shadow')
  })

  it('reflects the gateway it is editing', async () => {
    await show([gateway({ deployment: 'host', is_simulated: true })])
    openEdit()
    expect(typeSelect().value).toBe('simulated')
  })

  it('writes both columns when Simulated is chosen', async () => {
    // ONE CONTROL, TWO COLUMNS. The schema keeps them separate deliberately; this is the single
    // place the translation happens, and the assertion is that it happens completely.
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
    // The combination the database refuses: leaving is_simulated set while deployment became
    // 'remote' would send a write gateways_simulated_is_host rejects.
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
    // THE MISREADING THIS PREVENTS: that choosing Simulated diverts or quarantines the data. It
    // does not, and the sentence lives beside the control rather than in a migration header.
    await show([gateway({ deployment: 'host', is_simulated: true })])
    openEdit()
    expect(screen.getByText(/Ingestion is unchanged/i)).toBeInTheDocument()
  })

  it('says that devices inherit the mark', async () => {
    // 0052's design decision, surfaced where somebody would otherwise go looking for a per-device
    // setting that deliberately does not exist.
    await show([gateway({ deployment: 'host', is_simulated: true })])
    openEdit()
    expect(screen.getByText(/devices inherit the mark/i)).toBeInTheDocument()
  })
})

/**
 * The Cell Zone control, which the Type control governs. `gateways_synthetic_has_no_cell` is CHECK
 * (((NOT is_simulated) AND (NOT is_shadow)) OR cell_id IS NULL), so everything here renders that
 * constraint.
 */
describe('the Cell Zone control', () => {

  const cellSelect = () => document.querySelector('#gateway-cell-zone')

  it('reports no cell zone for a simulated gateway, whatever scope is stored', async () => {
    // The reported inconsistency in one assertion: simulated gateways must agree with each other
    // about their cell zone, since device_locations resolves `simulated` ahead of any cell. The
    // first keeps the harness's name so show() can wait on it.
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
    // The guard against over-correcting: Site-Wide is a real answer for every non-synthetic
    // gateway, and must not read as the unanswered case or nobody stops trying to "fix" it.
    await show([gateway({ deployment: 'host', cell_id: null, location_scope: 'site_wide' })])
    expect(within(document.querySelector('table')).getByText('Site-Wide')).toBeInTheDocument()
  })

  it('offers Site-Wide inside the cell picker rather than as a checkbox beside it', async () => {
    await show([gateway()])
    openEdit()
    expect(within(cellSelect()).getByRole('option', { name: /Site-Wide/i })).toBeInTheDocument()
    // One question, one control: the tick box that had to reach over and clear the select is gone.
    expect(screen.queryByRole('checkbox', { name: /Site-Wide/i })).toBeNull()
  })

  it('disables the cell picker for a simulated gateway and says why', async () => {
    await show([gateway({ deployment: 'host', is_simulated: true, cell_id: null })])
    openEdit()
    expect(cellSelect().disabled).toBe(true)
    // A disabled control with no explanation is the version of this that generates support
    // questions -- it has to say which lane the assets land in instead.
    expect(screen.getByText(/resolve to the Simulated lane/i)).toBeInTheDocument()
  })

  it('does not show a stored site-wide scope on a gateway that cannot hold a cell', async () => {
    // The same inconsistency one layer in: a disabled box reading "Site-Wide" above a note saying
    // simulated gateways have no cell contradicts itself.
    await show([gateway({ deployment: 'host', is_simulated: true, cell_id: null, location_scope: 'site_wide' })])
    openEdit()
    expect(cellSelect().value).toBe('')
  })

  it('clears a cell when the type changes to Simulated, rather than letting the save be refused', async () => {
    // Without this the save is a constraint violation, and the offending field is disabled by the
    // same change, so the operator cannot see or clear the value being rejected.
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

  it('asks for the type before the cell zone it governs', async () => {
    // A control that disables the one above it makes an operator re-read a decision already taken.
    await show([gateway()])
    openEdit()
    expect(typeSelect().compareDocumentPosition(cellSelect()) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy()
  })
})
