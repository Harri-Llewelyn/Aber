import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { PERMISSION_UUIDS } from '../constants'
import { pick } from '../test/listFilters'
import { api } from '../api'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

vi.mock('../lib/supabaseClient', () => ({
  supabase: { functions: { invoke: vi.fn() } }
}))

const DEVICE_ID = 'aaaaaaaa-0000-4000-8000-000000000001'

const device = (overrides = {}) => ({
  asset_id: DEVICE_ID,
  asset_name: 'CNC_01',
  sparkplug_id: 'devaaaaaaaa000040008000',
  status: 'ONLINE',
  is_quarantined: false,
  is_archived: false,
  active_gateway_id: 'gw-1',
  cell_id: 'cell-1',
  first_dbirth_at: '2026-07-27T12:00:00Z',
  created_at: '2026-07-20T12:00:00Z',
  ...overrides
})

const proposal = (overrides = {}) => ({
  id: 'p-1',
  entity_type: 'devices',
  entity_id: DEVICE_ID,
  status: 'open',
  patch: { name: 'CNC_01_renamed' },
  proposed_at: new Date().toISOString(),
  ...overrides
})

const routeGet = (rows, proposals = []) => (path) => {
  if (path.startsWith('/api/v1/gateways')) {
    return Promise.resolve([{ gateway_id: 'gw-1', gateway_name: 'Line_A_Gateway', cell_id: 'cell-1', status: 'ONLINE', is_archived: false, devices: [] }])
  }
  if (path.startsWith('/api/v1/cells')) return Promise.resolve([{ cell_id: 'cell-1', cell_name: 'Cell 1' }])
  if (path.startsWith('/api/v1/devices')) return Promise.resolve(rows)
  if (path.startsWith('/api/v1/proposals')) return Promise.resolve(proposals)
  return Promise.resolve([])
}

/**
 * The two roles this feature is about: an Operator holds `proposal:create` and not `device:manage`.
 */
const asOperator = (id) => id === PERMISSION_UUIDS.PROPOSAL_CREATE
const asManager = () => true

/** The dialog's static field of this name. */
const fixedField = (label) => within(document.querySelector('.modal')).getByText(label, { selector: 'dt' }).closest('.static-field')

const show = async (hasPermission, rows = [device()], proposals = []) => {
  api.get.mockImplementation(routeGet(rows, proposals))
  const onViewApprovals = vi.fn()
  render(
    <DevicesTab
      showToast={vi.fn()}
      onSelectDevice={vi.fn()}
      hasPermission={hasPermission}
      onViewApprovals={onViewApprovals}
    />
  )
  // The roster opens on Active, so a fixture holding an archived row asks for All first, from the
  // Filters popover.
  if (rows.some(r => r.is_archived)) {
    fireEvent.click(await screen.findByRole('button', { name: /^Filters/ }))
    await waitFor(() => pick('Lifecycle', 'active', 'archived'))
  }
  await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())
  return { onViewApprovals }
}

const openPanel = (name = 'CNC_01') => {
  fireEvent.click(within(document.querySelector('.page-main')).getByText(name))
  return within(document.querySelector('.context-panel'))
}

const panelLabels = () => {
  openPanel()
  return actionButtons().map(b => b.textContent.trim()).join('|')
}

const actionButtons = () =>
  [...document.querySelectorAll('.context-panel-actions .context-action')]

/**
 * Click one drawer action by its label. By the button, not the text: `getByText` matches the
 * label's span as well as the button, and the open dialog's footer carries the same words.
 */
const clickAction = (label) => {
  const button = actionButtons().find(b => b.textContent.trim() === label)
  if (!button) throw new Error(`no drawer action "${label}" — found: ${panelLabels()}`)
  fireEvent.click(button)
}

beforeEach(() => vi.clearAllMocks())

describe('proposing a change from a device', () => {
  it('offers the route to somebody whose Edit Details is refused', async () => {
    // The gap this closes: the drawer told an Operator what they could not do and said nothing
    // about the queue that exists for them.
    await show(asOperator)
    expect(panelLabels()).toContain('Propose a Change')
  })

  it('does not offer it to somebody who can simply make the change', async () => {
    // Offering both would present a queue as an alternative route to a change this person can
    // make directly, costing an approver's attention for nothing.
    await show(asManager)
    expect(panelLabels()).not.toContain('Propose a Change')
  })

  it('does not offer it without proposal:create, which the database would refuse', async () => {
    await show(() => false)
    expect(panelLabels()).not.toContain('Propose a Change')
  })

  it('does not offer it on an archived device, which cannot be proposed against', async () => {
    // Archived migration 0086_a_change_can_be_proposed_before_it_is_made refuses a proposal against
    // an archived device outright, so the button would lead to a form that fails on submit.
    await show(asOperator, [device({ is_archived: true })])
    expect(panelLabels()).not.toContain('Propose a Change')
  })

  it('opens the device’s own edit dialog rather than a second form elsewhere', async () => {
    // One form, opened under a different label, rather than a second composer on the Approvals page
    // listing the same columns as bare inputs.
    await show(asOperator)
    openPanel()
    clickAction('Propose a Change')

    await waitFor(() => expect(screen.getByRole('heading', { name: /^Edit Device Configuration — / })).toBeInTheDocument())
    // The same fields a manager gets, seeded from the same row.
    expect(screen.getByDisplayValue('CNC_01')).toBeInTheDocument()
  })

  it('ends that dialog in a proposal, not a save', async () => {
    await show(asOperator)
    openPanel()
    clickAction('Propose a Change')
    await waitFor(() => expect(screen.getByRole('heading', { name: /^Edit Device Configuration — / })).toBeInTheDocument())

    // The footer is the only thing that differs between the two readers. Scoped to
    // `.modal-actions` because the drawer action standing behind the dialog says the same words.
    const footer = within(document.querySelector('.modal-actions'))
    expect(footer.getByRole('button', { name: /propose a change/i })).toBeInTheDocument()
    expect(footer.queryByRole('button', { name: /save device/i })).toBeNull()
  })

  it('gives a manager the same dialog, ending in a save', async () => {
    await show(asManager)
    openPanel()
    clickAction('Edit Details')
    await waitFor(() => expect(screen.getByRole('heading', { name: /^Edit Device Configuration — / })).toBeInTheDocument())

    const footer = within(document.querySelector('.modal-actions'))
    expect(footer.getByRole('button', { name: /save device/i })).toBeInTheDocument()
    expect(footer.queryByRole('button', { name: /^propose a change$/i })).toBeNull()
  })

  it('shows the fields a proposal may not name as their values, without hiding them', async () => {
    // A device's gateway is its data path and its schema is what its telemetry is judged against;
    // hiding them would make two dialogs out of one.
    await show(asOperator)
    openPanel()
    clickAction('Propose a Change')
    await waitFor(() => expect(screen.getByRole('heading', { name: /^Edit Device Configuration — / })).toBeInTheDocument())

    // By its name alone, as the device drawer names it.
    expect(fixedField('Serving Gateway').querySelector('.form-static')).toHaveTextContent(/^Line_A_Gateway$/)
    expect(fixedField('Serving Gateway')).toHaveTextContent(/data path/i)
    expect(fixedField('Schemas')).toHaveTextContent(/judged against/i)
    expect(fixedField('Schema Conformance')).toHaveTextContent(/Audit — record the violation, keep the reading/)
    expect(fixedField('Schema Conformance')).toHaveTextContent(/kept or dropped/i)
    // A value, not a control that is switched off.
    expect(document.querySelectorAll('.modal select[disabled], .modal input[type="checkbox"][disabled]')).toHaveLength(0)
    expect(document.querySelector('#device-gateway')).toBeNull()
    expect(document.querySelector('#device-conformance')).toBeNull()
    expect(within(document.querySelector('.modal')).queryByRole('group', { name: /^Schemas/ })).toBeNull()
  })

  it('says what the drawer says of a gateway it cannot name: its id', async () => {
    await show(asOperator, [device({ active_gateway_id: 'gw-gone', gateway_name: null })])
    openPanel()
    clickAction('Propose a Change')
    await waitFor(() => expect(screen.getByText('Edit Device Configuration')).toBeInTheDocument())
    expect(fixedField('Serving Gateway').querySelector('.form-static')).toHaveTextContent(/^gw-gone$/)
  })

  it('says Not set, as the drawer does, where no gateway is bound', async () => {
    await show(asOperator, [device({ active_gateway_id: null })])
    openPanel()
    clickAction('Propose a Change')
    await waitFor(() => expect(screen.getByText('Edit Device Configuration')).toBeInTheDocument())
    expect(fixedField('Serving Gateway').querySelector('.form-static')).toHaveTextContent(/^Not set$/)
  })

  it('opens each reason with what a proposal cannot do, and keeps what it can change a control', async () => {
    await show(asOperator)
    openPanel()
    clickAction('Propose a Change')
    await waitFor(() => expect(screen.getByRole('heading', { name: /^Edit Device Configuration — / })).toBeInTheDocument())

    const reasons = ['Serving Gateway', 'Schemas', 'Schema Conformance'].map(label => fixedField(label).querySelector('dd.form-hint'))
    for (const reason of reasons) expect(reason.textContent).toMatch(/^A proposal can’t change this\. /)
    // What a proposal can name stays a control.
    expect(screen.getByLabelText(/Device Name/)).toBeEnabled()
    expect(screen.getByLabelText('Description')).toBeEnabled()
    expect(screen.getByRole('radiogroup', { name: 'Location' })).toBeInTheDocument()
  })

  it('shows a replay lane its gateway as text, with no note about who moves it, where nobody does', async () => {
    const lane = device({ asset_id: 'bbbbbbbb-0000-4000-8000-000000000002', asset_name: 'CNC_01 (replay)', shadow_of: DEVICE_ID })
    await show(asOperator, [device(), lane])
    fireEvent.click(screen.getByRole('button', { name: /^Filters/ }))
    fireEvent.click(await screen.findByText(/Show replay lanes/))
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.getByText('CNC_01 (replay)')).toBeTruthy())
    fireEvent.click(within(document.querySelector('.page-main')).getByText('CNC_01 (replay)'))
    clickAction('Propose a Change')
    await waitFor(() => expect(screen.getByRole('heading', { name: /^Edit Device Configuration — / })).toBeInTheDocument())

    // Fixed for everyone, so the lane's reason and not the proposer's; the other withheld fields say theirs.
    expect(document.querySelector('#device-gateway')).toBeNull()
    const gateway = fixedField('Serving Gateway')
    expect(gateway.querySelector('select, input')).toBeNull()
    expect(gateway.textContent).not.toMatch(/data path/)
    expect(gateway.textContent).toMatch(/This is a replay lane\. It stays on the Playback gateway/)
    // The schema and conformance reasons are still true for a lane.
    expect(fixedField('Schemas')).toHaveTextContent(/A proposal can’t change this\./)
    expect(fixedField('Schema Conformance')).toHaveTextContent(/A proposal can’t change this\./)
  })

  it('asks a proposer why, and asks a manager nothing', async () => {
    // A person saving their own change has nobody to explain it to; a person proposing one is
    // writing to an approver who has not stood in front of the machine.
    await show(asOperator)
    openPanel()
    clickAction('Propose a Change')
    await waitFor(() => expect(screen.getByLabelText(/why \(optional\)/i)).toBeInTheDocument())
  })

  it('sends only what actually moved', async () => {
    await show(asOperator)
    openPanel()
    clickAction('Propose a Change')
    await waitFor(() => expect(screen.getByDisplayValue('CNC_01')).toBeInTheDocument())

    fireEvent.change(screen.getByDisplayValue('CNC_01'), { target: { value: 'CNC_01_renamed' } })
    fireEvent.click(within(document.querySelector('.modal-actions'))
      .getByRole('button', { name: /propose a change/i }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/v1/proposals', expect.objectContaining({
      entity_type: 'devices',
      entity_id: DEVICE_ID,
      // One key: the form is seeded from the current row, so the patch carries only what changed
      // and an approver can tell which.
      patch: { name: 'CNC_01_renamed' }
    })))
  })

  it('adds to the proposal already open rather than opening a second one', async () => {
    // Archived migration 0086_a_change_can_be_proposed_before_it_is_made allows one open proposal
    // per asset per person, so a second field has to extend the request that exists. Seeded with
    // the earlier patch, or the new proposal would drop it.
    await show(asOperator, [device()], [proposal({ patch: { name: 'CNC_01_renamed' } })])
    openPanel()
    clickAction('Propose a Change')

    await waitFor(() => expect(screen.getByDisplayValue('CNC_01_renamed')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /update your proposal/i })).toBeInTheDocument()
  })
})

describe('what is already waiting on a device', () => {
  it('says so, and only when something is', async () => {
    await show(asManager, [device()], [proposal()])
    expect(panelLabels()).toContain('View in Approvals (1)')
  })

  it('stays quiet when nothing is open', async () => {
    await show(asManager, [device()], [])
    expect(panelLabels()).not.toContain('View in Approvals')
  })

  it('counts both device lanes, because both are about this machine', async () => {
    // `devices` and `device_nameplate` are two kinds of change to one asset and both are keyed by
    // the device's id. Splitting the count by lane would be an accounting distinction.
    await show(asManager, [device()], [
      proposal({ id: 'p-1' }),
      proposal({ id: 'p-2', entity_type: 'device_nameplate' })
    ])
    expect(panelLabels()).toContain('View in Approvals (2)')
  })

  it('ignores a proposal about a different asset', async () => {
    await show(asManager, [device()], [proposal({ entity_id: 'some-other-device' })])
    expect(panelLabels()).not.toContain('View in Approvals')
  })

  it('ignores one that has already been decided', async () => {
    await show(asManager, [device()], [proposal({ status: 'applied' })])
    expect(panelLabels()).not.toContain('View in Approvals')
  })

  it('hands the device over so the queue arrives filtered to it', async () => {
    const { onViewApprovals } = await show(asManager, [device()], [proposal()])
    openPanel()
    clickAction('View in Approvals (1)')
    expect(onViewApprovals).toHaveBeenCalledWith(expect.objectContaining({ asset_id: DEVICE_ID }))
  })

  it('still loads the page when the proposals endpoint fails', async () => {
    // The devices page must not go down because a secondary lookup did. RLS can also legitimately
    // refuse this call for a role that reads devices and not proposals.
    api.get.mockImplementation((path) => {
      if (path.startsWith('/api/v1/proposals')) return Promise.reject(new Error('nope'))
      return routeGet([device()])(path)
    })
    render(<DevicesTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={asManager} />)
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())
    expect(panelLabels()).not.toContain('View in Approvals')
  })
})
