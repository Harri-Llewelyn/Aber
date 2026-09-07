import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  ApprovalsTab,
  canDecide,
  diffRows,
  refusalFor,
  ageLabel,
  keyLabel
} from '../components/tabs/ApprovalsTab'
import { api } from '../api'
import { PERMISSION_UUIDS } from '../constants'

vi.mock('../api', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn() }
}))

/**
 * The Approvals page.
 *
 * THE PROPERTY WORTH GUARDING HERE IS THE ASYMMETRY, and it is invisible in a screenshot: a
 * `Shopfloor_Manager` decides the asset lanes and an `Administrator` alone decides a schema
 * publication, because `0069` withdrew `schema:manage` from that role and `0087` made the RPC
 * enforce it. A page that offered Approve on a schema proposal to a manager would not be a
 * security hole -- the RPC refuses it -- but it would be a button that always fails, which is how
 * people learn to distrust a control rather than a permission.
 *
 * THE SECOND IS THE CAP'S REPAIR. The per-asset cap is only livable if editing the proposal you
 * already have is one click from the refusal; otherwise the constraint reads as a wall and people
 * propose against a neighbouring asset instead, or stop proposing.
 */

const OPERATOR_ID = 'aaaaaaaa-0000-4000-8000-000000000001'
const MANAGER_ID  = 'aaaaaaaa-0000-4000-8000-000000000002'

const deviceProposal = (over = {}) => ({
  id: 'p-device',
  entity_type: 'devices',
  entity_id: 'dev-1',
  patch: { name: 'Cell 4 Lathe' },
  rationale: 'the label on the machine says so',
  status: 'open',
  proposed_by: OPERATOR_ID,
  proposed_at: new Date().toISOString(),
  decided_by: null,
  decided_at: null,
  decision_reason: null,
  applied_thread_id: null,
  target_label: 'Lathe_01',
  target_missing: false,
  current: { name: 'Lathe_01' },
  ...over
})

const schemaProposal = (over = {}) => ({
  id: 'p-schema',
  entity_type: 'schemas',
  entity_id: 'sch-2',
  patch: { publish: true },
  rationale: null,
  status: 'open',
  proposed_by: OPERATOR_ID,
  proposed_at: new Date().toISOString(),
  decided_by: null,
  decided_at: null,
  decision_reason: null,
  applied_thread_id: null,
  target_label: 'CNC_Mill v2',
  target_missing: false,
  current: { schema_name: 'CNC_Mill', version: 2, status: 'draft' },
  ...over
})

function mockLoad(proposals) {
  api.get.mockImplementation((path) => {
    if (path === '/api/v1/proposals') return Promise.resolve(proposals)
    if (path === '/api/v1/assets') return Promise.resolve([{ id: 'dev-1', name: 'Lathe_01' }])
    if (path === '/api/v1/proposals/publishable-schemas') return Promise.resolve([])
    if (path.startsWith('/api/v1/proposals/allowed-keys/')) return Promise.resolve(['name', 'description'])
    return Promise.resolve([])
  })
}

/**
 * Select a row, which is what opens the drawer the actions live in.
 *
 * THE ACTIONS ARE NOT ON THE ROW, and that is the app's own convention rather than this page's
 * invention: Cells, Gateways and Devices all moved their actions into the context drawer, because
 * a card per row put three proposals in a viewport and made the list unscannable at the size a
 * queue actually reaches.
 */
async function selectRow(index = 0) {
  const rows = await screen.findAllByTestId('proposal-row')
  fireEvent.click(rows[index])
  return rows[index]
}

const renderTab = (props = {}) => render(
  <ApprovalsTab
    showToast={vi.fn()}
    hasPermission={() => true}
    userRole="Shopfloor_Manager"
    currentUserId={MANAGER_ID}
    {...props}
  />
)

beforeEach(() => {
  vi.clearAllMocks()
  api.post.mockResolvedValue({})
  api.put.mockResolvedValue({})
})

describe('who may decide which lane', () => {
  it('lets a manager decide the asset lanes', () => {
    expect(canDecide('devices', 'Shopfloor_Manager')).toBe(true)
    expect(canDecide('device_nameplate', 'Shopfloor_Manager')).toBe(true)
  })

  it('does NOT let a manager decide a schema publication', () => {
    // 0069 withdrew schema:manage from this role; 0087 made publish_schema_version() enforce it.
    expect(canDecide('schemas', 'Shopfloor_Manager')).toBe(false)
  })

  it('lets an administrator decide every lane', () => {
    for (const lane of ['devices', 'device_nameplate', 'schemas']) {
      expect(canDecide(lane, 'Administrator')).toBe(true)
    }
  })

  it('lets an operator decide nothing', () => {
    for (const lane of ['devices', 'device_nameplate', 'schemas']) {
      expect(canDecide(lane, 'Operator')).toBe(false)
    }
  })
})

describe('the page draws the gate it was given', () => {
  it('offers a manager Approve on a device proposal', async () => {
    mockLoad([deviceProposal()])
    renderTab()
    await selectRow()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
  })

  it('offers a manager NO Approve on a schema proposal', async () => {
    mockLoad([schemaProposal()])
    renderTab()
    await selectRow()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull()
  })

  it('offers an administrator Approve on a schema proposal', async () => {
    mockLoad([schemaProposal()])
    renderTab({ userRole: 'Administrator' })
    await selectRow()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
  })

  it('offers a proposer Edit and Withdraw on their own open proposal, and no decision', async () => {
    mockLoad([deviceProposal()])
    renderTab({ userRole: 'Operator', currentUserId: OPERATOR_ID })
    await selectRow()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Withdraw' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
  })

  it('offers nothing on a proposal that is already decided', async () => {
    mockLoad([deviceProposal({
      status: 'applied', decided_by: MANAGER_ID, decided_at: new Date().toISOString()
    })])
    renderTab()
    await selectRow()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Withdraw' })).toBeNull()
  })
})

describe('what a proposal says it would change', () => {
  it('shows the current value beside the proposed one', () => {
    const rows = diffRows(deviceProposal())
    expect(rows).toEqual([{ key: 'name', from: 'Lathe_01', to: 'Cell 4 Lathe', unchanged: false }])
  })

  it('marks a key whose proposed value already matches', () => {
    // Worth showing rather than hiding: it tells the approver that part is a no-op.
    const rows = diffRows(deviceProposal({ patch: { name: 'Lathe_01' } }))
    expect(rows[0].unchanged).toBe(true)
  })

  it('gives the schema lane no diff at all', () => {
    // Its patch names an ACT, not a column, so a "current value" would be invented.
    expect(diffRows(schemaProposal())).toEqual([])
  })

  it('describes the schema lane in words instead', async () => {
    mockLoad([schemaProposal()])
    renderTab({ userRole: 'Administrator' })
    await selectRow()
    expect(screen.getByText(/archives its predecessor/i)).toBeInTheDocument()
  })

  it('falls back to the raw key for one it has no label for', () => {
    // The authoritative list is proposable_columns(); a label map that FILTERED would be a second
    // allowlist, and a key added to the database would silently vanish from the form.
    expect(keyLabel('some_new_column')).toBe('some_new_column')
    expect(keyLabel('serial_number')).toBe('Serial number')
  })
})

describe('the two caps fail differently', () => {
  it('offers to open the proposal you already have', () => {
    const existing = deviceProposal()
    const refusal = refusalFor({ code: '23505' }, existing)
    expect(refusal.openExisting).toBe(true)
    expect(refusal.message).toMatch(/already have an open proposal/i)
  })

  it('does not offer that when the row is not in hand', () => {
    expect(refusalFor({ code: '23505' }, undefined).openExisting).toBe(false)
  })

  it('passes the per-person ceiling through in the database wording', () => {
    // The repair is different -- decide or withdraw something else -- and the message says how
    // many are open, which no sentence written here could know.
    const refusal = refusalFor({ code: '23514', message: 'you already have 10 open proposal(s)' }, null)
    expect(refusal.openExisting).toBe(false)
    expect(refusal.message).toMatch(/10 open/)
  })

  it('reports a refusal as a refusal', () => {
    expect(refusalFor({ code: '42501' }, null).message).toMatch(/not permitted/i)
  })
})

describe('the cap is one click from its repair', () => {
  it('opens the existing proposal for editing when the per-asset cap refuses', async () => {
    const existing = deviceProposal()
    mockLoad([existing])
    api.post.mockRejectedValueOnce({ code: '23505', message: 'duplicate key' })

    renderTab({ userRole: 'Operator', currentUserId: OPERATOR_ID })
    await screen.findAllByTestId('proposal-row')

    fireEvent.click(screen.getByRole('button', { name: /propose a change/i }))
    await waitFor(() => expect(screen.getByLabelText('Device')).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText('Device'), { target: { value: 'dev-1' } })
    await waitFor(() => expect(screen.getByLabelText('Name')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Something else' } })
    fireEvent.click(screen.getByRole('button', { name: 'Propose' }))

    const openIt = await screen.findByRole('button', { name: /open the proposal you already have/i })
    fireEvent.click(openIt)

    // The composer is now editing that row rather than starting a second one, which is the whole
    // point: the refusal has to lead somewhere.
    await waitFor(() => expect(screen.getByText('Edit your proposal')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument()
  })
})

describe('rejecting', () => {
  it('will not send without a reason', async () => {
    mockLoad([deviceProposal()])
    renderTab()
    await selectRow()

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    const heading = await screen.findByText('Reject this proposal')
    // SCOPED TO THE DIALOG. The card's Reject and the dialog's confirm are both `btn-danger`, so a
    // query over the whole document finds the one that opened the dialog rather than the one that
    // sends it -- and the assertion would then be about the wrong button entirely.
    const dialog = heading.closest('.modal')
    const confirm = within(dialog).getByRole('button', { name: 'Reject' })

    // The constraint requires it too; this is the form agreeing with the database rather than
    // standing in for it.
    expect(confirm).toBeDisabled()
  })

  it('sends the reason it was given', async () => {
    mockLoad([deviceProposal()])
    renderTab()
    await selectRow()

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    const heading = await screen.findByText('Reject this proposal')
    const dialog = heading.closest('.modal')
    fireEvent.change(screen.getByLabelText(/why\?/i), {
      target: { value: 'that machine is being retired' }
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/api/v1/proposals/p-device/reject',
      { reason: 'that machine is being retired' }
    ))
  })
})

describe('the queue is worked from the front', () => {
  it('lists open proposals oldest first', async () => {
    const older = deviceProposal({ id: 'older', target_label: 'Older', proposed_at: '2026-09-01T00:00:00Z' })
    const newer = deviceProposal({ id: 'newer', target_label: 'Newer', proposed_at: '2026-09-05T00:00:00Z' })
    // Handed back newest-first, which is the order the history wants and the queue does not.
    mockLoad([newer, older])
    renderTab()

    await screen.findAllByTestId('proposal-row')
    const cards = screen.getAllByTestId('proposal-row')
    expect(within(cards[0]).getByText('Older')).toBeInTheDocument()
  })

  it('separates what is waiting from what was decided', async () => {
    mockLoad([
      deviceProposal({ id: 'open-one', target_label: 'Waiting' }),
      deviceProposal({
        id: 'done-one', target_label: 'Done', status: 'rejected',
        decided_by: MANAGER_ID, decided_at: '2026-09-05T00:00:00Z',
        decision_reason: 'not this quarter'
      })
    ])
    renderTab()
    const rows = await screen.findAllByTestId('proposal-row')
    // One row in each table, under its own card.
    expect(rows).toHaveLength(2)
    expect(screen.getByText('Awaiting a decision')).toBeInTheDocument()
    expect(screen.getByText('Decided')).toBeInTheDocument()

    // The reason lives in the drawer now, not on the row -- which is what lets a long list of
    // decisions stay scannable.
    fireEvent.click(rows[1])
    expect(screen.getByText(/not this quarter/)).toBeInTheDocument()
  })
})

describe('an expired proposal names nobody', () => {
  it('says the timer closed it rather than inventing an approver', async () => {
    // decided_by is NULL by design: the timer has no session and is not a person.
    mockLoad([deviceProposal({
      status: 'expired', decided_by: null, decided_at: '2026-09-05T00:00:00Z'
    })])
    renderTab()
    await selectRow()
    expect(screen.getByText(/the expiry timer, which is not a person/)).toBeInTheDocument()
  })
})

describe('proposing', () => {
  it('is offered only to somebody who holds proposal:create', async () => {
    mockLoad([])
    renderTab({ hasPermission: (p) => p !== PERMISSION_UUIDS.PROPOSAL_CREATE })
    await waitFor(() => expect(screen.getByText(/nothing is waiting/i)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /propose a change/i })).toBeNull()
  })

  it('asks the database which fields a lane admits', async () => {
    mockLoad([])
    renderTab({ userRole: 'Operator', currentUserId: OPERATOR_ID })
    await waitFor(() => expect(screen.getByRole('button', { name: /propose a change/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /propose a change/i }))

    // proposable_columns() is the only place that answer exists; a list hardcoded in the component
    // would be a second allowlist to keep in step.
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/v1/proposals/allowed-keys/devices'))
  })

  it('sends only the fields somebody actually filled in', async () => {
    mockLoad([])
    renderTab({ userRole: 'Operator', currentUserId: OPERATOR_ID })
    await waitFor(() => expect(screen.getByRole('button', { name: /propose a change/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /propose a change/i }))

    await waitFor(() => expect(screen.getByLabelText('Device')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Device'), { target: { value: 'dev-1' } })
    await waitFor(() => expect(screen.getByLabelText('Name')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Cell 4 Lathe' } })
    fireEvent.click(screen.getByRole('button', { name: 'Propose' }))

    // `description` was never touched, so it is not in the patch -- which is what keeps this a
    // PATCH rather than a whole-row snapshot that reverts whatever moved underneath it.
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/v1/proposals', {
      entity_type: 'devices',
      entity_id: 'dev-1',
      patch: { name: 'Cell 4 Lathe' },
      rationale: ''
    }))
  })
})

describe('the composer says why it will not send', () => {
  it('names what is still missing, and disables Propose until it is not', async () => {
    // A control that is greyed out with no explanation is one somebody presses twice and then
    // reports as broken -- which is exactly what happened: Propose with no device chosen did
    // nothing at all, correctly, and said nothing about why.
    mockLoad([])
    renderTab({ userRole: 'Operator', currentUserId: OPERATOR_ID })
    await waitFor(() => expect(screen.getByRole('button', { name: /propose a change/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /propose a change/i }))

    await waitFor(() => expect(screen.getByLabelText('Device')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Propose' })).toBeDisabled()
    expect(screen.getByText(/choose a device and at least one field to change/i)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Device'), { target: { value: 'dev-1' } })
    await waitFor(() => expect(screen.getByLabelText('Name')).toBeInTheDocument())
    // Still short of a field to change, and it now says only that.
    expect(screen.getByRole('button', { name: 'Propose' })).toBeDisabled()
    expect(screen.getByText(/choose at least one field to change/i)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Cell 4 Lathe' } })
    expect(screen.getByRole('button', { name: 'Propose' })).toBeEnabled()
  })

  it('asks a schema proposal only for its draft', async () => {
    // The schema lane's patch is the act and takes no arguments, so there is no field to fill in
    // and the only thing outstanding is which draft.
    api.get.mockImplementation((path) => {
      if (path === '/api/v1/proposals') return Promise.resolve([])
      if (path === '/api/v1/assets') return Promise.resolve([])
      if (path === '/api/v1/proposals/publishable-schemas') {
        return Promise.resolve([{ id: 'sch-2', schema_name: 'CNC_Mill', version: 2 }])
      }
      if (path.startsWith('/api/v1/proposals/allowed-keys/')) return Promise.resolve(['publish'])
      return Promise.resolve([])
    })
    renderTab({ userRole: 'Operator', currentUserId: OPERATOR_ID })
    await waitFor(() => expect(screen.getByRole('button', { name: /propose a change/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /propose a change/i }))

    await waitFor(() => expect(screen.getByLabelText('What kind of change')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('What kind of change'), { target: { value: 'schemas' } })

    await waitFor(() => expect(screen.getByLabelText('Draft to publish')).toBeInTheDocument())
    expect(screen.getByText(/choose a draft to publish/i)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Draft to publish'), { target: { value: 'sch-2' } })
    expect(screen.getByRole('button', { name: 'Propose' })).toBeEnabled()
  })
})

describe('finding a decision again', () => {
  const decidedSet = () => [
    deviceProposal({
      id: 'd1', target_label: 'Lathe_01', status: 'rejected', entity_type: 'devices',
      decided_by: MANAGER_ID, decided_at: '2026-09-05T00:00:00Z', decision_reason: 'being retired'
    }),
    deviceProposal({
      id: 'd2', target_label: 'Press_02', status: 'applied', entity_type: 'device_nameplate',
      patch: { serial_number: 'SN-9' }, current: {},
      decided_by: MANAGER_ID, decided_at: '2026-09-06T00:00:00Z'
    }),
    schemaProposal({
      id: 'd3', target_label: 'CNC_Mill v2', status: 'applied',
      decided_by: MANAGER_ID, decided_at: '2026-09-06T12:00:00Z'
    })
  ]

  it('filters by the kind of change', async () => {
    mockLoad(decidedSet())
    renderTab()
    await screen.findAllByTestId('proposal-row')

    fireEvent.change(screen.getByTitle('Filter by the kind of change'), {
      target: { value: 'device_nameplate' }
    })
    const rows = screen.getAllByTestId('proposal-row')
    expect(rows).toHaveLength(1)
    expect(within(rows[0]).getByText('Press_02')).toBeInTheDocument()
  })

  it('searches the subject and the reason a decision was given', async () => {
    // The three things somebody remembers about a decision they are trying to find again.
    mockLoad(decidedSet())
    renderTab()
    await screen.findAllByTestId('proposal-row')

    const box = screen.getByTitle(/filter decided proposals/i)
    fireEvent.change(box, { target: { value: 'retired' } })
    let rows = screen.getAllByTestId('proposal-row')
    expect(rows).toHaveLength(1)
    expect(within(rows[0]).getByText('Lathe_01')).toBeInTheDocument()

    fireEvent.change(box, { target: { value: 'CNC' } })
    rows = screen.getAllByTestId('proposal-row')
    expect(rows).toHaveLength(1)
    expect(within(rows[0]).getByText('CNC_Mill v2')).toBeInTheDocument()
  })

  it('says when a filter is what emptied the list, not the absence of decisions', async () => {
    mockLoad(decidedSet())
    renderTab()
    await screen.findAllByTestId('proposal-row')

    fireEvent.change(screen.getByTitle(/filter decided proposals/i), {
      target: { value: 'nothing matches this' }
    })
    expect(screen.getByText(/no decided proposal matches the selected filter/i)).toBeInTheDocument()
  })

  it('does not filter the queue that is still waiting', async () => {
    // The filters belong to the record, not to the work. A filter that also narrowed the queue
    // would hide something waiting for a decision behind a control somebody set and forgot.
    mockLoad([
      deviceProposal({ id: 'open-1', target_label: 'Waiting_Device' }),
      schemaProposal({
        id: 'd3', target_label: 'CNC_Mill v2', status: 'applied',
        decided_by: MANAGER_ID, decided_at: '2026-09-06T12:00:00Z'
      })
    ])
    renderTab()
    await screen.findAllByTestId('proposal-row')

    fireEvent.change(screen.getByTitle('Filter by the kind of change'), { target: { value: 'schemas' } })
    const rows = screen.getAllByTestId('proposal-row')
    // The open device proposal survives; only the decided table narrowed.
    expect(rows.some(r => within(r).queryByText('Waiting_Device'))).toBe(true)
  })
})

describe('following an approval into the Digital Thread', () => {
  it('offers the hand-over on a proposal that was applied', async () => {
    const onViewThread = vi.fn()
    mockLoad([deviceProposal({
      status: 'applied', decided_by: MANAGER_ID, decided_at: '2026-09-06T00:00:00Z',
      applied_thread_id: 4321
    })])
    renderTab({ onViewThread })
    await selectRow()

    fireEvent.click(screen.getByRole('button', { name: /view in digital thread/i }))
    // THE TARGET, NOT THE PROPOSAL. What a reader wants after an approval is the machine's history
    // with the approval in it, beside everything else that happened to it.
    expect(onViewThread).toHaveBeenCalledWith(expect.objectContaining({ entity_id: 'dev-1' }))
  })

  it('does not offer it on a rejection, which changed nothing', async () => {
    // `applied_thread_id` is set by the approval and by nothing else. A dead button on the three
    // outcomes that wrote no row would teach the reader the control lies.
    const onViewThread = vi.fn()
    mockLoad([deviceProposal({
      status: 'rejected', decided_by: MANAGER_ID, decided_at: '2026-09-06T00:00:00Z',
      decision_reason: 'no', applied_thread_id: null
    })])
    renderTab({ onViewThread })
    await selectRow()
    expect(screen.queryByRole('button', { name: /view in digital thread/i })).toBeNull()
  })

  it('does not offer it while the proposal is still open', async () => {
    const onViewThread = vi.fn()
    mockLoad([deviceProposal()])
    renderTab({ onViewThread })
    await selectRow()
    expect(screen.queryByRole('button', { name: /view in digital thread/i })).toBeNull()
  })
})

describe('the composer is a dialog', () => {
  it('opens over the page and closes on Escape', async () => {
    mockLoad([])
    renderTab({ userRole: 'Operator', currentUserId: OPERATOR_ID })
    await waitFor(() => expect(screen.getByRole('button', { name: /propose a change/i })).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /propose a change/i }))
    const heading = await screen.findByText('Propose a change', { selector: '.modal-title' })
    // `.modal` caps at the viewport and scrolls inside itself, which the nameplate lane needs:
    // eleven fields is taller than a laptop once the pickers and the rationale are above them.
    expect(heading.closest('.modal')).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText('Propose a change', { selector: '.modal-title' })).toBeNull())
  })
})

describe('ageLabel', () => {
  const base = new Date('2026-09-07T12:00:00Z').getTime()
  it('reads in the coarsest unit that is still true', () => {
    expect(ageLabel('2026-09-07T11:59:30Z', base)).toBe('just now')
    expect(ageLabel('2026-09-07T11:30:00Z', base)).toBe('30m ago')
    expect(ageLabel('2026-09-07T09:00:00Z', base)).toBe('3h ago')
    expect(ageLabel('2026-09-04T12:00:00Z', base)).toBe('3d ago')
  })
})
