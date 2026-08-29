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
  await waitFor(() => expect(screen.getByText('Playback_Lab')).toBeTruthy())
}

const openEdit = () => {
  fireEvent.click(within(document.querySelector('.page-main')).getByText('Playback_Lab'))
  fireEvent.click(within(document.querySelector('.context-panel')).getByText('Edit Details'))
}

const typeSelect = () => document.querySelector('#gateway-type')
/** The row's Type cell, which is the one in the table rather than any badge in the drawer. */
const typeCell = () => within(document.querySelector('.page-main')).getAllByText(
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
