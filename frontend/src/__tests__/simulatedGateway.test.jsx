import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import { api } from '../api'

/**
 * The Type column and the control behind it, in the Gateways tab.
 *
 * WHAT THIS REPLACED. Two badges beside the gateway name (VIRTUAL, SIMULATED) and two checkboxes in
 * the form. Between them they said three things -- where it runs, whether the numbers are real, and
 * in a tooltip "Cloud", which contradicted the first -- and the two checkboxes offered FOUR
 * combinations where the database permits three: `gateways_simulated_is_host` (0064) forbids a
 * remote simulator, so one of the four was a write that would be refused after it was ticked.
 *
 * WHAT IS ASSERTED HERE is the part that can mislead rather than the markup:
 *
 *   1. THE FOUR VALUES ARE NOT INTERCHANGEABLE, and Shadow is the one that earns the column its
 *      fourth. A SIMULATED spindle reporting 4000 RPM never turned; a SHADOW spindle reporting
 *      4000 RPM did turn, on a real machine, on the day the capture was recorded. Both are "not a
 *      machine running now" and they give opposite answers to *is this number true*.
 *   2. SHADOW CANNOT BE CHOSEN. 0060 seeds the single Playback gateway and a trigger refuses any
 *      other; offering it would be offering to fabricate one.
 *   3. ONE CONTROL STILL WRITES TWO COLUMNS. The schema keeps them separate on purpose, so the
 *      translation happens in one place and the form does not quietly become the model.
 *   4. IT IS NOT A DATA-PATH SWITCH. Choosing Simulated changes nothing about ingestion, and an
 *      operator who believed it quarantined or diverted the replayed data would be wrong in the
 *      direction that matters.
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
 * The row's Type cell -- the one in the TABLE, not a badge in the drawer and not an option in the
 * filter bar.
 *
 * SCOPED TO THE TABLE, which it has to be: the type filter beside the search box renders an
 * <option> per selectable type, so a search across the whole page matched "Remote" in the filter
 * before reaching any row, and every one of these read Remote whatever the fixture said. The
 * previous scope only worked while nothing above the table happened to use these four words.
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
    // THE PRECEDENCE THAT EARNS THE FOURTH VALUE. A shadow gateway is necessarily simulated too, so
    // without an explicit order it lands in Simulated and the more informative answer -- these
    // readings actually happened -- becomes unreachable.
    await show([gateway({ deployment: 'host', is_simulated: true, is_shadow: true })])
    expect(typeCell().textContent).toBe('Shadow')
  })

  it('reports a row with no deployment as Remote rather than Host', async () => {
    // A row read through an older select list, or a fixture written before 0064. Host is the type
    // with no appliance and no enrolment, so claiming it wrongly hides the kind that needs setting
    // up -- the safe direction is the one that says "there may be hardware to install".
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
    // 0060 seeds the one shadow gateway and a BEFORE INSERT trigger on playback_jobs refuses any
    // other target. Offering it here would be offering to fabricate the row that exists to be
    // unique.
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
    // The combination the database refuses. Leaving is_simulated set while deployment became
    // 'remote' would send a write that gateways_simulated_is_host rejects -- an error an operator
    // caused by choosing something the form offered.
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
 * THE CELL ZONE CONTROL, which the Type control governs.
 *
 * `gateways_synthetic_has_no_cell` (0059) makes the two mutually exclusive in the database:
 *
 *     CHECK (((NOT is_simulated) AND (NOT is_shadow)) OR cell_id IS NULL)
 *
 * so everything here is a rendering of that constraint, in the same relationship the Type control
 * has to `gateways_simulated_is_host`. The failure it prevents is the one the two checkboxes had:
 * a combination the form offers and the database then refuses.
 */
describe('the Cell Zone control', () => {

  const cellSelect = () => document.querySelector('#gateway-cell-zone')

  it('reports no cell zone for a simulated gateway, whatever scope is stored', async () => {
    // THE REPORTED INCONSISTENCY, in one assertion. Four simulated gateways showed three different
    // cell zones between them: the one seeded `site_wide` read "Site-Wide" and the rest read "No
    // cell" -- a difference with no behaviour behind it, since device_locations resolves
    // `simulated` ahead of both. "No cell" is also rendered as a warning promising devices in the
    // Unassigned queue, and theirs are in the Simulated lane.
    // The first keeps the harness's name so show() can wait on it; the pair is what matters here,
    // since the bug was the two of them disagreeing.
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
    // The same inconsistency one layer in: the seeded BMS simulator carries `site_wide` from before
    // 0059 made the flag win, and a disabled box reading "Site-Wide" directly above a note saying
    // simulated gateways have no cell contradicts itself.
    await show([gateway({ deployment: 'host', is_simulated: true, cell_id: null, location_scope: 'site_wide' })])
    openEdit()
    expect(cellSelect().value).toBe('')
  })

  it('clears a cell when the type changes to Simulated, rather than letting the save be refused', async () => {
    // WITHOUT THIS THE SAVE IS A CONSTRAINT VIOLATION, and an unusually cruel one: the offending
    // field is disabled by the same change, so the operator cannot see or clear the value being
    // rejected.
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
