import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  ApprovalsTab,
  ActorLabel,
  diffRows,
  keyLabel,
  KINDS,
  filterProposals,
  locationNameMap
} from '../components/tabs/ApprovalsTab'
import { canDecide } from '../utils/proposalAuthority'
import { api } from '../api'
import { ENTITY_KIND_BY_TABLE, ENTITY_TABLE_BY_KIND } from '../constants'
import { formatDateTime } from '../utils/format'
import { expectCardHeading } from '../test/cardHeading'

vi.mock('../api', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), getAuditTrailRow: vi.fn() }
}))

/**
 * The Approvals page. The property worth guarding is the gate: an `Administrator` or a
 * `Shopfloor_Manager` decides every live lane, nobody decides the withdrawn schema lane, and the
 * page must not offer a button the RPC will refuse. The second is the cap's repair: editing the
 * proposal you already have must be one click from the refusal.
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
  proposed_by_email: 'ops.person@aber.test',
  proposed_at: new Date().toISOString(),
  decided_by: null,
  decided_at: null,
  decision_reason: null,
  applied_trail_id: null,
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
  proposed_by_email: 'ops.person@aber.test',
  proposed_at: new Date().toISOString(),
  decided_by: null,
  decided_at: null,
  decision_reason: null,
  applied_trail_id: null,
  target_label: 'CNC_Mill v2',
  target_missing: false,
  current: { schema_name: 'CNC_Mill', version: 2, status: 'draft' },
  ...over
})

function mockLoad(proposals) {
  api.get.mockImplementation((path) => {
    if (path === '/api/v1/proposals') return Promise.resolve(proposals)
    return Promise.resolve([])
  })
}

/**
 * Select a row, which opens the drawer the actions live in. The actions are not on the row, by the
 * app's convention.
 */
async function selectRow(index = 0) {
  const rows = await screen.findAllByTestId('proposal-row')
  fireEvent.click(rows[index])
  return rows[index]
}

/** The decided proposals are the second tab; Awaiting a decision is the default. */
const showDecided = () => fireEvent.click(screen.getByRole('tab', { name: 'Decided' }))
const showAwaiting = () => fireEvent.click(screen.getByRole('tab', { name: /^Awaiting a decision/ }))

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
  api.getAuditTrailRow.mockResolvedValue(null)
})

describe('who may decide which lane', () => {
  it('lets a manager decide the asset lanes', () => {
    expect(canDecide('devices', 'Shopfloor_Manager')).toBe(true)
    expect(canDecide('device_nameplate', 'Shopfloor_Manager')).toBe(true)
  })

  it('does NOT let a manager decide a schema publication', () => {
    // The schema lane is withdrawn: nothing can be filed in it and nothing left in it can be
    // decided, so it is false for an Administrator too.
    expect(canDecide('schemas', 'Shopfloor_Manager')).toBe(false)
    expect(canDecide('schemas', 'Administrator')).toBe(false)
  })

  it('lets an administrator decide every live lane', () => {
    for (const lane of KINDS.map(l => l.id)) {
      expect(canDecide(lane, 'Administrator'), lane).toBe(true)
    }
  })

  it('lets a manager decide every live lane too', () => {
    // Cells and gateways resolve cell:manage and gateway:manage, held by exactly these two roles,
    // so the answer is the same for both today.
    for (const lane of KINDS.map(l => l.id)) {
      expect(canDecide(lane, 'Shopfloor_Manager'), lane).toBe(true)
    }
  })

  it('lets an operator decide nothing', () => {
    for (const lane of [...KINDS.map(l => l.id), 'schemas']) {
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

  it('offers nobody a decision on a proposal in the withdrawn schema lane', async () => {
    // The schema lane is withdrawn. Historical rows still render, but there is no decision left to
    // make on one.
    mockLoad([schemaProposal()])
    renderTab({ userRole: 'Administrator' })
    await selectRow()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull()
  })

  it('offers a proposer Withdraw on their own open proposal, and no decision', async () => {
    // Edit is not a button here: extending a proposal is a hand-over to the asset's own dialog, and
    // appears only when the caller supplied somewhere to hand over to.
    mockLoad([deviceProposal()])
    renderTab({ userRole: 'Operator', currentUserId: OPERATOR_ID })
    await selectRow()
    expect(screen.getByRole('button', { name: 'Withdraw' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  })

  it('offers nothing on a proposal that is already decided', async () => {
    mockLoad([deviceProposal({
      status: 'applied', decided_by: MANAGER_ID, decided_at: new Date().toISOString()
    })])
    renderTab()
    showDecided()
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
    expect(screen.getByText(/request to publish a schema draft/i)).toBeInTheDocument()
  })

  it('falls back to the raw key for one it has no label for', () => {
    // The authoritative list is proposable_columns(); a label map that FILTERED would be a second
    // allowlist, and a key added to the database would silently vanish from the form.
    expect(keyLabel('some_new_column')).toBe('some_new_column')
    expect(keyLabel('serial_number')).toBe('Serial number')
  })
})

describe('rejecting', () => {
  it('will not send without a reason', async () => {
    mockLoad([deviceProposal()])
    renderTab()
    await selectRow()

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    const heading = await screen.findByText('Reject this proposal')
    // Scoped to the dialog: the card's Reject and the dialog's confirm are both `btn-danger`.
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

  it('marks the rows on both tabs as opening the drawer, and a rejected proposal a readable badge', async () => {
    mockLoad([
      deviceProposal({ id: 'open-1', target_label: 'Open one' }),
      deviceProposal({ id: 'rej-1', target_label: 'Rejected one', status: 'rejected', decided_by: MANAGER_ID, decided_at: '2026-09-05T00:00:00Z' })
    ])
    renderTab()

    const [open] = await screen.findAllByTestId('proposal-row')
    expect(open.tagName).toBe('TR')
    expect(open).toHaveClass('row-selectable')
    showDecided()
    const [rejected] = await screen.findAllByTestId('proposal-row')
    expect(rejected).toHaveClass('row-selectable')
    expect(document.querySelector('.badge-danger')).not.toBeNull()
    expect(document.querySelector('.badge-offline')).toBeNull()
  })

  it('separates what is waiting from what was decided, one tab each', async () => {
    mockLoad([
      deviceProposal({ id: 'open-one', target_label: 'Waiting' }),
      deviceProposal({
        id: 'done-one', target_label: 'Done', status: 'rejected',
        decided_by: MANAGER_ID, decided_at: '2026-09-05T00:00:00Z',
        decision_reason: 'not this quarter'
      })
    ])
    renderTab()
    // Awaiting a decision is the tab the page opens on.
    expect(screen.getByRole('tab', { name: /^Awaiting a decision/ })).toHaveAttribute('aria-selected', 'true')
    let rows = await screen.findAllByTestId('proposal-row')
    expect(rows).toHaveLength(1)
    expect(within(rows[0]).getByText('Waiting')).toBeInTheDocument()

    showDecided()
    rows = screen.getAllByTestId('proposal-row')
    expect(rows).toHaveLength(1)
    expect(within(rows[0]).getByText('Done')).toBeInTheDocument()

    // The reason lives in the drawer now, not on the row -- which is what lets a long list of
    // decisions stay scannable.
    fireEvent.click(rows[0])
    expect(screen.getByText(/not this quarter/)).toBeInTheDocument()
  })

  it('closes the drawer when the tab changes, since its row is no longer on screen', async () => {
    mockLoad([deviceProposal()])
    renderTab()
    await selectRow()
    expect(document.querySelector('.context-panel-open')).toBeTruthy()
    showDecided()
    expect(document.querySelector('.context-panel-open')).toBeNull()
  })
})

describe('an expired proposal names nobody', () => {
  it('says the timer closed it rather than inventing an approver', async () => {
    // decided_by is NULL by design: the timer has no session and is not a person.
    mockLoad([deviceProposal({
      status: 'expired', decided_by: null, decided_at: '2026-09-05T00:00:00Z'
    })])
    renderTab()
    showDecided()
    await selectRow()
    expect(screen.getByText(/the expiry timer, which is not a person/)).toBeInTheDocument()
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
    showDecided()
    await screen.findAllByTestId('proposal-row')

    fireEvent.change(screen.getByLabelText('Filter decided proposals by kind'), {
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
    showDecided()
    await screen.findAllByTestId('proposal-row')

    const box = screen.getByLabelText(/filter decided proposals by what/i)
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
    showDecided()
    await screen.findAllByTestId('proposal-row')

    fireEvent.change(screen.getByLabelText(/filter decided proposals by what/i), {
      target: { value: 'nothing matches this' }
    })
    expect(screen.getByText(/no decided proposal matches these filters/i)).toBeInTheDocument()
  })

  it('does not filter the queue that is still waiting', async () => {
    // The two filter bars are independent, so a filter set while reading the record cannot hide
    // something waiting for a decision.
    mockLoad([
      deviceProposal({ id: 'open-1', target_label: 'Waiting_Device' }),
      schemaProposal({
        id: 'd3', target_label: 'CNC_Mill v2', status: 'applied',
        decided_by: MANAGER_ID, decided_at: '2026-09-06T12:00:00Z'
      })
    ])
    renderTab()
    showDecided()
    await screen.findAllByTestId('proposal-row')

    fireEvent.change(screen.getByLabelText('Filter decided proposals by kind'), { target: { value: 'schemas' } })
    showAwaiting()
    const rows = screen.getAllByTestId('proposal-row')
    // The open device proposal survives; only the decided table narrowed.
    expect(rows.some(r => within(r).queryByText('Waiting_Device'))).toBe(true)
    expect(screen.getByLabelText('Filter open proposals by kind')).toHaveValue('all')
  })
})

describe('following an approval into the Audit Trail', () => {
  it('offers the hand-over on a proposal that was applied', async () => {
    const onViewTrail = vi.fn()
    mockLoad([deviceProposal({
      status: 'applied', decided_by: MANAGER_ID, decided_at: '2026-09-06T00:00:00Z',
      applied_trail_id: 4321
    })])
    renderTab({ onViewTrail })
    showDecided()
    await selectRow()

    fireEvent.click(screen.getByRole('button', { name: /view in audit trail/i }))
    // THE TARGET, NOT THE PROPOSAL. What a reader wants after an approval is the machine's history
    // with the approval in it, beside everything else that happened to it.
    expect(onViewTrail).toHaveBeenCalledWith({ id: 'dev-1', type: 'DEVICE', purged: false })
  })

  /* `audit_trail_page()` compares `entity_type` exactly, and the approval row is filed under the
     lane's table. Filtered to DEVICE, a cell's or a nameplate's approval row is not listed. */
  it.each([
    ['cells', 'CELL'],
    ['gateways', 'GATEWAY'],
    ['areas', 'AREA'],
    ['device_nameplate', 'NAMEPLATE']
  ])('opens a %s approval filtered to %s', async (lane, kind) => {
    const onViewTrail = vi.fn()
    mockLoad([deviceProposal({
      entity_type: lane, entity_id: `${lane}-1`, status: 'applied', decided_by: MANAGER_ID,
      decided_at: '2026-09-06T00:00:00Z', applied_trail_id: 4321
    })])
    renderTab({ onViewTrail })
    showDecided()
    await selectRow()

    fireEvent.click(screen.getByRole('button', { name: /view in audit trail/i }))
    expect(onViewTrail).toHaveBeenCalledWith({ id: `${lane}-1`, type: kind, purged: false })
  })

  it('maps every lane to the kind whose filter asks for that lane', () => {
    for (const { id } of KINDS) {
      expect(ENTITY_TABLE_BY_KIND[ENTITY_KIND_BY_TABLE[id]], id).toBe(id)
    }
  })

  it('asks for purged rows when the subject has been deleted', async () => {
    // The trail hides a deleted entity's rows unless asked, and the approval row is one of them.
    const onViewTrail = vi.fn()
    mockLoad([deviceProposal({
      entity_type: 'cells', entity_id: 'cell-gone', target_label: 'cell-gone', target_missing: true,
      current: null, status: 'applied', decided_by: MANAGER_ID,
      decided_at: '2026-09-06T00:00:00Z', applied_trail_id: 4321
    })])
    renderTab({ onViewTrail })
    showDecided()
    await selectRow()

    fireEvent.click(screen.getByRole('button', { name: /view in audit trail/i }))
    expect(onViewTrail).toHaveBeenCalledWith({ id: 'cell-gone', type: 'CELL', purged: true })
  })

  it('does not offer it on a rejection, which changed nothing', async () => {
    // `applied_trail_id` is set by the approval and by nothing else. A dead button on the three
    // outcomes that wrote no row would teach the reader the control lies.
    const onViewTrail = vi.fn()
    mockLoad([deviceProposal({
      status: 'rejected', decided_by: MANAGER_ID, decided_at: '2026-09-06T00:00:00Z',
      decision_reason: 'no', applied_trail_id: null
    })])
    renderTab({ onViewTrail })
    showDecided()
    await selectRow()
    expect(screen.queryByRole('button', { name: /view in audit trail/i })).toBeNull()
  })

  it('does not offer it while the proposal is still open', async () => {
    const onViewTrail = vi.fn()
    mockLoad([deviceProposal()])
    renderTab({ onViewTrail })
    await selectRow()
    expect(screen.queryByRole('button', { name: /view in audit trail/i })).toBeNull()
  })
})


describe('the columns say one thing each', () => {
  it('names the fields a proposal would change, rather than "summary"', async () => {
    mockLoad([deviceProposal()])
    renderTab()
    await screen.findAllByTestId('proposal-row')
    expect(screen.getAllByText('Field(s) changed').length).toBeGreaterThan(0)
    expect(screen.queryByText('Summary')).toBeNull()
  })

  it('splits the state from the moment', async () => {
    // One column was doing two jobs: a state that takes a badge and a moment that takes a clock,
    // under a heading that described only the first.
    mockLoad([deviceProposal()])
    renderTab()
    const [row] = await screen.findAllByTestId('proposal-row')
    const cells = row.querySelectorAll('td')
    expect(within(cells[3]).getByText('open')).toBeInTheDocument()
    expect(cells[4].textContent).toMatch(/just now|ago/)
  })

  it('drops the proposer column, which held a uuid nothing could resolve', async () => {
    mockLoad([deviceProposal()])
    renderTab()
    await screen.findAllByTestId('proposal-row')
    expect(screen.queryByText('Proposed by', { selector: 'th' })).toBeNull()
  })

  it('names the proposer in the drawer, by the email the token carried', async () => {
    mockLoad([deviceProposal()])
    // A manager reading somebody else's proposal is the case the uuid failed at.
    renderTab({ currentUserId: MANAGER_ID })
    await selectRow()
    expect(screen.getByText('ops.person@aber.test')).toBeInTheDocument()
  })

  it('still says "you" on your own, which needed no lookup', async () => {
    mockLoad([deviceProposal()])
    renderTab({ userRole: 'Operator', currentUserId: OPERATOR_ID })
    await selectRow()
    expect(screen.getByText('you')).toBeInTheDocument()
  })

  it('falls back to the uuid when the token carried no email', async () => {
    // A real state rather than an error: a blank cell would read as a missing proposer.
    mockLoad([deviceProposal({ proposed_by_email: null })])
    renderTab({ currentUserId: MANAGER_ID })
    await selectRow()
    expect(screen.getByText(OPERATOR_ID.slice(0, 8))).toBeInTheDocument()
  })

  it('gives the drawer a wall-clock time as well as a relative one', async () => {
    // "31m ago" is what triage reads and cannot be quoted into a ticket; the drawer is where
    // somebody goes to get a time out of the app.
    mockLoad([deviceProposal({ proposed_at: '2026-09-06T09:15:00Z' })])
    renderTab()
    await selectRow()
    expect(screen.getByText('Proposed at')).toBeInTheDocument()
    const shown = formatDateTime('2026-09-06T09:15:00Z')
    expect(screen.getByText(new RegExp(shown.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeInTheDocument()
  })

  it('gives a decided proposal its decision time too', async () => {
    mockLoad([deviceProposal({
      status: 'applied', decided_by: MANAGER_ID, decided_at: '2026-09-06T10:00:00Z'
    })])
    renderTab()
    showDecided()
    await selectRow()
    expect(screen.getByText('Decided at')).toBeInTheDocument()
  })

  it('finds a decision by who asked for it', async () => {
    mockLoad([deviceProposal({
      status: 'applied', decided_by: MANAGER_ID, decided_at: '2026-09-06T10:00:00Z'
    })])
    renderTab()
    showDecided()
    await screen.findAllByTestId('proposal-row')
    fireEvent.change(screen.getByLabelText(/filter decided proposals by what/i), {
      target: { value: 'ops.person' }
    })
    expect(screen.getAllByTestId('proposal-row')).toHaveLength(1)
  })
})


describe('a machine proposer is named, and marked as a machine', () => {
  // A machine identity has no email for its token to carry; `list_proposer_names()` gives the
  // person deciding its proposal the name an Administrator gave it.
  const MACHINE_ID = 'b1000000-0000-4000-8000-000000000009'

  it('shows the name with a machine mark', () => {
    render(<ActorLabel id={MACHINE_ID} machineName="Line 3 scheduler" currentUserId={MANAGER_ID} />)
    expect(screen.getByText('Line 3 scheduler')).toBeInTheDocument()
    expect(screen.getByText('machine')).toBeInTheDocument()
    expect(screen.queryByText(MACHINE_ID.slice(0, 8))).toBeNull()
  })

  it('keeps the eight characters for a principal with no name and no email', () => {
    render(<ActorLabel id={MACHINE_ID} machineName={null} currentUserId={MANAGER_ID} />)
    expect(screen.getByText(MACHINE_ID.slice(0, 8))).toBeInTheDocument()
    expect(screen.queryByText('machine')).toBeNull()
  })

  it('names a person by email, with no machine mark', () => {
    render(<ActorLabel id={OPERATOR_ID} email="ops.person@aber.test" currentUserId={MANAGER_ID} />)
    expect(screen.getByText('ops.person@aber.test')).toBeInTheDocument()
    expect(screen.queryByText('machine')).toBeNull()
  })

  it('still says "you" and a dash where it always did', () => {
    const { container } = render(<ActorLabel id={null} />)
    expect(container.textContent).toBe('—')
    render(<ActorLabel id={MANAGER_ID} machineName="Not me" currentUserId={MANAGER_ID} />)
    expect(screen.getByText('you')).toBeInTheDocument()
  })

  it('names the machine in the drawer of the proposal it filed', async () => {
    mockLoad([deviceProposal({
      entity_type: 'cells', proposed_by: MACHINE_ID, proposed_by_email: null,
      proposed_by_machine_name: 'Line 3 scheduler'
    })])
    renderTab({ currentUserId: MANAGER_ID })
    await selectRow()
    expect(screen.getByText('Line 3 scheduler')).toBeInTheDocument()
    expect(screen.getByText('machine')).toBeInTheDocument()
  })

  it('finds a proposal by the machine that filed it', async () => {
    mockLoad([
      deviceProposal({ id: 'p-machine', proposed_by: MACHINE_ID, proposed_by_email: null,
                       proposed_by_machine_name: 'Line 3 scheduler' }),
      deviceProposal({ id: 'p-person', entity_id: 'dev-2' })
    ])
    renderTab()
    await screen.findAllByTestId('proposal-row')
    fireEvent.change(screen.getByLabelText(/filter open proposals by what/i), {
      target: { value: 'scheduler' }
    })
    expect(screen.getAllByTestId('proposal-row')).toHaveLength(1)
  })
})


describe('arriving from another page', () => {
  it('points the queue at one device when that is what was asked for', async () => {
    // The device drawer's "N changes awaiting decision" sends the machine's uuid, which matches
    // nothing a person would type and exactly the rows that drawer was talking about.
    mockLoad([
      deviceProposal({ id: 'open-1', entity_id: 'dev-1', target_label: 'Lathe_01' }),
      deviceProposal({ id: 'open-2', entity_id: 'dev-9', target_label: 'Press_02' })
    ])
    renderTab({ initialSubject: 'dev-1' })
    await screen.findAllByTestId('proposal-row')
    const rows = screen.getAllByTestId('proposal-row')
    expect(rows).toHaveLength(1)
    expect(within(rows[0]).getByText('Lathe_01')).toBeInTheDocument()
  })

  it('lets go of the hand-over so the filter is not permanent', async () => {
    const onClearFocus = vi.fn()
    mockLoad([deviceProposal({ entity_id: 'dev-1' })])
    renderTab({ initialSubject: 'dev-1', onClearFocus })
    await waitFor(() => expect(onClearFocus).toHaveBeenCalled())
  })

  it('hands back to the entity rather than opening a form of its own', async () => {
    // Extending your own open proposal happens in the entity's own dialog (Edit Details, or
    // Digital Nameplate), so this drawer action is a route there, not a dialog here.
    const onOpenSubject = vi.fn()
    mockLoad([deviceProposal({ proposed_by: OPERATOR_ID })])
    renderTab({ userRole: 'Operator', currentUserId: OPERATOR_ID, onOpenSubject })
    await selectRow()

    fireEvent.click(screen.getByRole('button', { name: /add to this proposal/i }))
    expect(onOpenSubject).toHaveBeenCalledWith(expect.objectContaining({ entity_id: 'dev-1' }))
  })

  it('offers no such route to somebody who did not file it', async () => {
    const onOpenSubject = vi.fn()
    mockLoad([deviceProposal({ proposed_by: 'somebody-else' })])
    renderTab({ onOpenSubject })
    await selectRow()
    expect(screen.queryByRole('button', { name: /add to this proposal/i })).toBeNull()
  })
})

describe('the queue that is waiting can be filtered too', () => {
  it('narrows the open queue by the kind of change', async () => {
    mockLoad([
      deviceProposal({ id: 'o1', target_label: 'Lathe_01' }),
      deviceProposal({ id: 'o2', entity_type: 'device_nameplate', target_label: 'Press_02' })
    ])
    renderTab()
    await screen.findAllByTestId('proposal-row')

    fireEvent.change(screen.getByLabelText('Filter open proposals by kind'), {
      target: { value: 'device_nameplate' }
    })
    const rows = screen.getAllByTestId('proposal-row')
    expect(rows).toHaveLength(1)
    expect(within(rows[0]).getByText('Press_02')).toBeInTheDocument()
  })

  it('says when a filter emptied the queue, not that nothing is waiting', async () => {
    // The two sentences mean opposite things to an approver: one is "you are done", the other is
    // "you are looking through a slot".
    mockLoad([deviceProposal({ target_label: 'Lathe_01' })])
    renderTab()
    await screen.findAllByTestId('proposal-row')

    fireEvent.change(screen.getByLabelText(/filter open proposals by what/i), {
      target: { value: 'nothing matches this' }
    })
    expect(screen.getByText(/nothing open matches these filters/i)).toBeInTheDocument()
    expect(screen.queryByText(/nothing is waiting/i)).toBeNull()
  })

  it('can be cleared, so an arrival from a device is not a one-way door', async () => {
    mockLoad([
      deviceProposal({ id: 'open-1', entity_id: 'dev-1', target_label: 'Lathe_01' }),
      deviceProposal({ id: 'open-2', entity_id: 'dev-9', target_label: 'Press_02' })
    ])
    renderTab({ initialSubject: 'dev-1' })
    await screen.findAllByTestId('proposal-row')
    expect(screen.getAllByTestId('proposal-row')).toHaveLength(1)

    fireEvent.click(screen.getAllByRole('button', { name: /clear filters/i })[0])
    expect(screen.getAllByTestId('proposal-row')).toHaveLength(2)
  })

  it('counts what it would clear, like every other filter bar', async () => {
    /* The button reads "Clear filters (n)", and n moves because two filters can be set. */
    mockLoad([
      deviceProposal({ id: 'o1', target_label: 'Lathe_01' }),
      deviceProposal({ id: 'o2', entity_type: 'device_nameplate', target_label: 'Press_02' })
    ])
    renderTab()
    await screen.findAllByTestId('proposal-row')

    expect(screen.queryByRole('button', { name: /clear filters/i })).toBeNull()

    fireEvent.change(screen.getByLabelText('Filter open proposals by kind'), {
      target: { value: 'device_nameplate' }
    })
    expect(screen.getByRole('button', { name: /clear filters/i })).toHaveTextContent('Clear filters (1)')

    fireEvent.change(screen.getByLabelText(/filter open proposals by what/i), { target: { value: 'Press' } })
    expect(screen.getByRole('button', { name: /clear filters/i })).toHaveTextContent('Clear filters (2)')

    fireEvent.click(screen.getByRole('button', { name: /clear filters/i }))
    expect(screen.queryByRole('button', { name: /clear filters/i })).toBeNull()
    expect(screen.getAllByTestId('proposal-row')).toHaveLength(2)
  })
})

describe('filterProposals', () => {
  const rows = [
    { id: 'a', entity_type: 'devices', entity_id: 'dev-1', target_label: 'Lathe_01',
      proposed_by_email: 'ops@x.test', rationale: 'worn spindle', decision_reason: null },
    { id: 'b', entity_type: 'schemas', entity_id: 'sch-2', target_label: 'CNC_Mill v2',
      proposed_by_email: 'eng@x.test', rationale: null, decision_reason: 'not yet' }
  ]

  it('matches the id underneath, which is how a route arrives pointed at one asset', () => {
    // Nobody types a uuid into this box; the device drawer does, and it must match.
    expect(filterProposals(rows, 'all', 'dev-1').map(r => r.id)).toEqual(['a'])
  })

  it('matches the proposer, the rationale and the reason', () => {
    expect(filterProposals(rows, 'all', 'eng@').map(r => r.id)).toEqual(['b'])
    expect(filterProposals(rows, 'all', 'spindle').map(r => r.id)).toEqual(['a'])
    expect(filterProposals(rows, 'all', 'not yet').map(r => r.id)).toEqual(['b'])
  })

  it('applies the lane and the text together, not either', () => {
    expect(filterProposals(rows, 'schemas', 'Lathe')).toEqual([])
    expect(filterProposals(rows, 'devices', 'Lathe').map(r => r.id)).toEqual(['a'])
  })

  it('leaves the rows alone when nothing is asked of it', () => {
    expect(filterProposals(rows, 'all', '')).toHaveLength(2)
    expect(filterProposals(rows, 'all', '   ')).toHaveLength(2)
  })
})

describe('the page finishes loading what it asks for', () => {
  /**
   * `loadAll` sets several pieces of state in sequence and `usePolling` swallows what it throws,
   * so an error partway down leaves the queue rendered and the rest of the load skipped. Asserting
   * the last thing the load does makes the middle of it observable.
   */
  it('asks for nothing it no longer reads, and reaches the end of the load', async () => {
    api.get.mockImplementation((path) => {
      if (path === '/api/v1/proposals') return Promise.resolve([deviceProposal({
        patch: { cell_id: 'cell-weld' }, current: { cell_id: null }
      })])
      if (path === '/api/v1/cells') return Promise.resolve([{ cell_id: 'cell-weld', cell_name: 'Weld Bay' }])
      return Promise.resolve([])
    })
    renderTab()
    await selectRow()
    // The name only appears if the load ran to completion.
    await waitFor(() => expect(screen.getByText('Weld Bay')).toBeTruthy())
    const asked = api.get.mock.calls.map(c => c[0])
    expect(asked).toContain('/api/v1/cells')
    expect(asked.some(p => p.includes('publishable-schemas'))).toBe(false)
  })
})

describe('locationNameMap', () => {
  const cells = [
    { cell_id: 'cell-unfiled', cell_name: 'Goods In' },
    { cell_id: 'cell-weld', cell_name: 'Weld Bay' }
  ]
  const areas = [{
    area_id: 'area-north',
    area_name: 'North Shop',
    cells: [{ cell_id: 'cell-weld', cell_name: 'Weld Bay' }],
  }]

  it('names a cell and an area', () => {
    const names = locationNameMap(cells, areas)
    expect(names.get('cell-weld')).toBe('Weld Bay')
    expect(names.get('area-north')).toBe('North Shop')
  })

  /* Neither list is complete on its own: an area embeds only the cells filed under it. */
  it('keeps a cell that is filed under no area', () => {
    expect(locationNameMap(cells, areas).get('cell-unfiled')).toBe('Goods In')
    expect(locationNameMap([], areas).get('cell-unfiled')).toBeUndefined()
  })

  it('survives either list being absent', () => {
    expect(locationNameMap(undefined, undefined).size).toBe(0)
    expect(locationNameMap(cells, undefined).size).toBe(2)
  })
})

describe('a relocation names the cells rather than their uuids', () => {
  const relocation = deviceProposal({
    id: 'p-move',
    patch: { cell_id: 'cell-weld' },
    current: { cell_id: 'cell-paint' }
  })

  const mockWithCells = () => api.get.mockImplementation((path) => {
    if (path === '/api/v1/proposals') return Promise.resolve([relocation])
    if (path === '/api/v1/cells') return Promise.resolve([
      { cell_id: 'cell-weld', cell_name: 'Weld Bay' },
      { cell_id: 'cell-paint', cell_name: 'Paint Line' }
    ])
    return Promise.resolve([])
  })

  it('shows both sides of the move by name', async () => {
    mockWithCells()
    renderTab()
    await selectRow()
    await waitFor(() => expect(screen.getByText('Weld Bay')).toBeTruthy())
    expect(screen.getByText('Paint Line')).toBeTruthy()
    expect(screen.queryByText('cell-weld')).toBeNull()
  })

  /* The uuid is what the audit trail and the filter speak, so it is kept where it costs nothing. */
  it('keeps the uuid in the tooltip', async () => {
    mockWithCells()
    renderTab()
    await selectRow()
    await waitFor(() => expect(screen.getByText('Weld Bay').getAttribute('title')).toBe('cell-weld'))
  })

  /* Falls back rather than hides: an archived or deleted cell is a real state, and a reviewer
     reading a uuid is better served than one reading a blank. */
  it('falls back to the uuid when nothing resolves it', async () => {
    api.get.mockImplementation((path) => {
      if (path === '/api/v1/proposals') return Promise.resolve([relocation])
      return Promise.resolve([])
    })
    renderTab()
    await selectRow()
    await waitFor(() => expect(screen.getByText('cell-weld')).toBeTruthy())
  })
})

describe('a cell, a gateway or an area proposal names its subject', () => {
  const CELL_ID = 'c0000000-0000-4000-8000-000000000001'
  const GATEWAY_ID = 'a0000000-0000-4000-8000-000000000002'
  const AREA_ID = 'e0000000-0000-4000-8000-000000000003'

  // As `GET /api/v1/proposals` hands them over: named, with the row each patch would change.
  const cellMove = (over = {}) => deviceProposal({
    id: 'p-cell', entity_type: 'cells', entity_id: CELL_ID,
    patch: { area_id: 'area-paint' }, target_label: 'Weld Bay',
    current: { name: 'Weld Bay', area_id: 'area-yard' }, ...over
  })
  const gatewayUrl = (over = {}) => deviceProposal({
    id: 'p-gateway', entity_type: 'gateways', entity_id: GATEWAY_ID,
    patch: { access_url: 'https://line3.test' }, target_label: 'Line 3 edge',
    current: { name: 'Line 3 edge', access_url: null }, ...over
  })
  const areaIcon = (over = {}) => deviceProposal({
    id: 'p-area', entity_type: 'areas', entity_id: AREA_ID,
    patch: { icon: 'Warehouse' }, target_label: 'North Shop',
    current: { name: 'North Shop', icon: 'Factory' }, ...over
  })

  const mockSubjects = (proposals) => api.get.mockImplementation((path) => {
    if (path === '/api/v1/proposals') return Promise.resolve(proposals)
    if (path === '/api/v1/areas') return Promise.resolve([
      { area_id: 'area-yard', area_name: 'Goods Yard', cells: [] },
      { area_id: 'area-paint', area_name: 'Paint Shop', cells: [] }
    ])
    return Promise.resolve([])
  })

  /** Open the row naming `label` and read its drawer's before/after table as [field, now, proposed]. */
  async function diffOf(label) {
    const rows = await screen.findAllByTestId('proposal-row')
    fireEvent.click(rows.find(r => within(r).queryByText(label)))
    const table = document.querySelector('.modal-table')
    return [...table.querySelectorAll('tbody tr')].map(tr => [...tr.cells].map(td => td.textContent))
  }

  it('shows each subject by name, never its uuid', async () => {
    mockSubjects([cellMove(), gatewayUrl(), areaIcon()])
    renderTab()
    const rows = await screen.findAllByTestId('proposal-row')
    const subjects = rows.map(r => r.querySelector('td strong').textContent).sort()
    expect(subjects).toEqual(['Line 3 edge', 'North Shop', 'Weld Bay'])
    for (const id of [CELL_ID, GATEWAY_ID, AREA_ID]) expect(screen.queryByText(id)).toBeNull()
  })

  it('diffs a cell against its current row, naming both areas', async () => {
    mockSubjects([cellMove()])
    renderTab()
    expect(await diffOf('Weld Bay')).toEqual([['Area', 'Goods Yard', 'Paint Shop']])
  })

  it('diffs a gateway and an area against their current rows', async () => {
    mockSubjects([gatewayUrl(), areaIcon()])
    renderTab()
    expect(await diffOf('Line 3 edge')).toEqual([['Access URL', '—', 'https://line3.test']])
    expect(await diffOf('North Shop')).toEqual([['Icon', 'Factory', 'Warehouse']])
  })

  it('marks a subject that no longer exists', async () => {
    mockSubjects([cellMove({ target_label: CELL_ID, target_missing: true, current: null })])
    renderTab()
    const [row] = await screen.findAllByTestId('proposal-row')
    expect(within(row).getByText(CELL_ID)).toBeInTheDocument()
    expect(within(row).getByText('MISSING')).toBeInTheDocument()
  })

  it('keeps the uuid when the subject could not be read, without calling it missing', async () => {
    mockSubjects([gatewayUrl({ target_label: GATEWAY_ID, target_missing: false, current: null })])
    renderTab()
    const [row] = await screen.findAllByTestId('proposal-row')
    expect(within(row).getByText(GATEWAY_ID)).toBeInTheDocument()
    expect(within(row).queryByText('MISSING')).toBeNull()
  })

  it("finds a proposal by its subject's name", async () => {
    mockSubjects([cellMove(), gatewayUrl(), areaIcon()])
    renderTab()
    await screen.findAllByTestId('proposal-row')
    fireEvent.change(screen.getByLabelText(/filter open proposals by what/i), { target: { value: 'line 3' } })
    const rows = screen.getAllByTestId('proposal-row')
    expect(rows).toHaveLength(1)
    expect(within(rows[0]).getByText('Line 3 edge')).toBeInTheDocument()
  })
})

describe('one card, two tabs, no counts, and attention only on work this viewer can do', () => {
  const decidedOne = (id, at) => deviceProposal({
    id, target_label: id, status: 'applied', decided_by: MANAGER_ID, decided_at: at
  })

  it('is one card: the heading, the tab bar inside it, then the toolbar row', async () => {
    mockLoad([])
    const { container } = renderTab()
    await screen.findByText('Nothing is waiting. A proposal appears here when somebody asks for a change they cannot make themselves.')
    expectCardHeading('Approvals', /proposed but may not make themselves/)
    expect(document.querySelectorAll('.card')).toHaveLength(1)
    expect(container.querySelector('.page-layout')).toHaveClass('page-fill')
    const card = document.querySelector('.card')
    expect(card).toHaveClass('card-fill')
    const strip = card.querySelector(':scope > .tab-strip')
    expect(strip).toBeTruthy()
    expect(strip.previousElementSibling).toHaveClass('card-heading')
    const bar = strip.nextElementSibling
    expect(bar).toHaveClass('filter-bar')
    // The tab's HelpTip first.
    const help = within(bar).getByRole('button', { name: 'About the open queue' })
    expect(bar.firstElementChild.contains(help)).toBe(true)
  })

  it('counts nothing on the heading or the tabs, and flags nothing while nothing waits', async () => {
    mockLoad([])
    renderTab()
    await screen.findByText('Nothing is waiting. A proposal appears here when somebody asks for a change they cannot make themselves.')
    expect(document.querySelector('.card-heading .section-count')).toBeNull()
    expect(screen.getAllByRole('tab').map(t => t.textContent)).toEqual(['Awaiting a decision', 'Decided'])
    expect(document.querySelector('.tab-strip-attention')).toBeNull()
  })

  it('flags Awaiting with how many this viewer may decide, leaving out their own and the schema lane', async () => {
    mockLoad([
      deviceProposal({ id: 'o1', target_label: 'Lathe_01' }),
      deviceProposal({ id: 'o2', target_label: 'Press_02', entity_type: 'cells' }),
      deviceProposal({ id: 'mine', target_label: 'Mine', proposed_by: MANAGER_ID }),
      schemaProposal()
    ])
    renderTab()
    await screen.findAllByTestId('proposal-row')
    const awaiting = screen.getByRole('tab', { name: 'Awaiting a decision, 2 waiting' })
    expect(awaiting.querySelector('.tab-strip-attention')).toHaveTextContent('2')
    // A filter narrows the list, not the work waiting.
    fireEvent.change(screen.getByLabelText('Filter open proposals by kind'), { target: { value: 'cells' } })
    expect(screen.getByRole('tab', { name: 'Awaiting a decision, 2 waiting' })).toBeInTheDocument()
  })

  it('flags nothing for a viewer who may decide none of it', async () => {
    mockLoad([deviceProposal({ id: 'o1', proposed_by: 'somebody-else' })])
    renderTab({ userRole: 'Operator', currentUserId: OPERATOR_ID })
    await screen.findAllByTestId('proposal-row')
    expect(screen.getByRole('tab', { name: 'Awaiting a decision' })).toBeInTheDocument()
    expect(document.querySelector('.tab-strip-attention')).toBeNull()
  })

  it('keeps the heading and the card on screen while the first load runs', () => {
    api.get.mockImplementation(() => new Promise(() => {}))
    renderTab()
    expect(screen.getByRole('heading', { name: 'Approvals' })).toBeInTheDocument()
    expect(screen.getAllByText('Loading proposals…')).toHaveLength(1)
  })

  it('lists the decided proposals by decision time, newest first', async () => {
    mockLoad([
      decidedOne('Decided-early', '2026-09-01T00:00:00Z'),
      decidedOne('Decided-late', '2026-09-09T00:00:00Z')
    ])
    renderTab()
    showDecided()
    const rows = await screen.findAllByTestId('proposal-row')
    expect(within(rows[0]).getByText('Decided-late')).toBeInTheDocument()
  })

  it('draws a status through the shared badge, dot included', async () => {
    mockLoad([deviceProposal()])
    renderTab()
    const [row] = await screen.findAllByTestId('proposal-row')
    expect(row.querySelector('.badge-pending .badge-dot')).not.toBeNull()
  })
})

describe('the diff says what happened, by status', () => {
  const heading = () => document.querySelector('.context-panel-facts .context-panel-section-label').textContent
  const columns = () => [...document.querySelectorAll('.modal-table thead th')].map(th => th.textContent)
  const cells = () => [...document.querySelectorAll('.modal-table tbody tr')]
    .map(tr => [...tr.cells].map(td => td.textContent))
  const applied = (over = {}) => deviceProposal({
    status: 'applied', decided_by: MANAGER_ID, decided_at: '2026-09-06T10:00:00Z',
    applied_trail_id: 4321,
    // The live row already holds the applied value, which is why it cannot be Before.
    current: { name: 'Cell 4 Lathe' }, ...over
  })

  it('says what an open proposal would change, Now against Proposed, flagging a no-op part', async () => {
    mockLoad([deviceProposal({ patch: { name: 'Cell 4 Lathe', description: 'same' }, current: { name: 'Lathe_01', description: 'same' } })])
    renderTab()
    await selectRow()
    expect(heading()).toBe('What would change')
    expect(columns()).toEqual(['Field', 'Now', 'Proposed'])
    expect(cells()).toEqual([['Name', 'Lathe_01', 'Cell 4 Lathe'], ['Description', 'same', 'sameunchanged']])
  })

  it('says what an applied proposal changed, Before from its audit record against After', async () => {
    api.getAuditTrailRow.mockResolvedValue({ id: 4321, action: 'PROPOSAL_APPLIED', replaced: { name: 'Lathe_01' } })
    mockLoad([applied()])
    renderTab()
    showDecided()
    await selectRow()
    expect(heading()).toBe('What changed')
    await waitFor(() => expect(columns()).toEqual(['Field', 'Before', 'After']))
    expect(cells()).toEqual([['Name', 'Lathe_01', 'Cell 4 Lathe']])
    expect(api.getAuditTrailRow).toHaveBeenCalledWith(4321)
    // Applied means it changed: the live row matching the patch is not a no-op.
    expect(screen.queryByText('unchanged')).toBeNull()
  })

  it('shows After alone, and says why, when the viewer cannot read the audit record', async () => {
    api.getAuditTrailRow.mockResolvedValue(null)
    mockLoad([applied()])
    renderTab()
    showDecided()
    await selectRow()
    expect(await screen.findByText(/You cannot read the audit record this change wrote/)).toBeInTheDocument()
    expect(columns()).toEqual(['Field', 'After'])
    expect(cells()).toEqual([['Name', 'Cell 4 Lathe']])
    expect(screen.queryByText('unchanged')).toBeNull()
  })

  it('treats a refused read as an unreadable record', async () => {
    api.getAuditTrailRow.mockRejectedValue(new Error('permission denied'))
    mockLoad([applied()])
    renderTab()
    showDecided()
    await selectRow()
    expect(await screen.findByText(/You cannot read the audit record this change wrote/)).toBeInTheDocument()
    expect(columns()).toEqual(['Field', 'After'])
  })

  it.each(['rejected', 'withdrawn', 'expired'])('says what a %s proposal asked for, Proposed alone', async (status) => {
    mockLoad([deviceProposal({ status, decided_at: '2026-09-06T10:00:00Z', decided_by: MANAGER_ID })])
    renderTab()
    showDecided()
    await selectRow()
    expect(heading()).toBe('What was proposed')
    expect(columns()).toEqual(['Field', 'Proposed'])
    expect(cells()).toEqual([['Name', 'Cell 4 Lathe']])
    // Nothing was changed, so no audit record is read.
    expect(api.getAuditTrailRow).not.toHaveBeenCalled()
  })
})

describe('a row opens its proposal from the keyboard too', () => {
  it('is in the Tab order, and Enter on it toggles the drawer', async () => {
    mockLoad([deviceProposal()])
    renderTab()
    const [row] = await screen.findAllByTestId('proposal-row')
    expect(row).toHaveAttribute('tabindex', '0')
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(document.querySelector('.context-panel-open')).toBeTruthy()
    expect(row).toHaveClass('row-selected')
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(document.querySelector('.context-panel-open')).toBeNull()
  })

  it('opens on Space as well, and the click toggles it the same way', async () => {
    mockLoad([deviceProposal()])
    renderTab()
    const [row] = await screen.findAllByTestId('proposal-row')
    fireEvent.keyDown(row, { key: ' ' })
    expect(document.querySelector('.context-panel-open')).toBeTruthy()
    fireEvent.click(row)
    expect(document.querySelector('.context-panel-open')).toBeNull()
  })

  it('ignores a key pressed inside the row rather than on it', async () => {
    mockLoad([deviceProposal()])
    renderTab()
    const [row] = await screen.findAllByTestId('proposal-row')
    fireEvent.keyDown(row.querySelector('td strong'), { key: 'Enter' })
    expect(document.querySelector('.context-panel-open')).toBeNull()
  })
})

describe('the drawer carries the proposal icon and one primary action, listed first', () => {
  const primaries = () => [...document.querySelectorAll('.context-panel-actions .btn-primary')]
  const firstAction = () => document.querySelector('.context-panel-actions .context-action')

  it('makes Approve the primary for somebody who may decide', async () => {
    mockLoad([deviceProposal()])
    renderTab()
    await selectRow()
    expect(document.querySelector('.context-panel-open .context-panel-icon svg')).toBeTruthy()
    expect(primaries()).toHaveLength(1)
    expect(firstAction()).toHaveTextContent('Approve')
    expect(firstAction()).toHaveClass('btn-primary')
  })

  it('makes the hand-over the primary on your own open proposal', async () => {
    mockLoad([deviceProposal()])
    renderTab({ userRole: 'Operator', currentUserId: OPERATOR_ID, onOpenSubject: vi.fn() })
    await selectRow()
    expect(primaries()).toHaveLength(1)
    expect(firstAction()).toHaveTextContent('Add to this proposal')
  })

  it('makes View in Audit Trail the primary on an applied proposal', async () => {
    mockLoad([deviceProposal({
      status: 'applied', decided_by: MANAGER_ID, decided_at: '2026-09-06T00:00:00Z', applied_trail_id: 4321
    })])
    renderTab({ onViewTrail: vi.fn() })
    showDecided()
    await selectRow()
    expect(primaries()).toHaveLength(1)
    expect(firstAction()).toHaveTextContent('View in Audit Trail')
  })
})
