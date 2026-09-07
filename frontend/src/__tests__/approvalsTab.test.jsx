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
    await screen.findByTestId('proposal-card')
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
  })

  it('offers a manager NO Approve on a schema proposal', async () => {
    mockLoad([schemaProposal()])
    renderTab()
    await waitFor(() => expect(screen.getByText('CNC_Mill v2')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull()
  })

  it('offers an administrator Approve on a schema proposal', async () => {
    mockLoad([schemaProposal()])
    renderTab({ userRole: 'Administrator' })
    await waitFor(() => expect(screen.getByText('CNC_Mill v2')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
  })

  it('offers a proposer Edit and Withdraw on their own open proposal, and no decision', async () => {
    mockLoad([deviceProposal()])
    renderTab({ userRole: 'Operator', currentUserId: OPERATOR_ID })
    await screen.findByTestId('proposal-card')
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Withdraw' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
  })

  it('offers nothing on a proposal that is already decided', async () => {
    mockLoad([deviceProposal({
      status: 'applied', decided_by: MANAGER_ID, decided_at: new Date().toISOString()
    })])
    renderTab()
    await screen.findByTestId('proposal-card')
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
    await waitFor(() => expect(screen.getByText('CNC_Mill v2')).toBeInTheDocument())
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
    await screen.findByTestId('proposal-card')

    fireEvent.click(screen.getByRole('button', { name: 'Propose a change' }))
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
    await screen.findByTestId('proposal-card')

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
    await screen.findByTestId('proposal-card')

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

    await screen.findAllByTestId('proposal-card')
    const cards = screen.getAllByTestId('proposal-card')
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
    await screen.findAllByTestId('proposal-card')
    expect(screen.getByText('Decided')).toBeInTheDocument()
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
    await screen.findByTestId('proposal-card')
    expect(screen.getByText('the expiry timer')).toBeInTheDocument()
  })
})

describe('proposing', () => {
  it('is offered only to somebody who holds proposal:create', async () => {
    mockLoad([])
    renderTab({ hasPermission: (p) => p !== PERMISSION_UUIDS.PROPOSAL_CREATE })
    await waitFor(() => expect(screen.getByText(/nothing is waiting/i)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Propose a change' })).toBeNull()
  })

  it('asks the database which fields a lane admits', async () => {
    mockLoad([])
    renderTab({ userRole: 'Operator', currentUserId: OPERATOR_ID })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Propose a change' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Propose a change' }))

    // proposable_columns() is the only place that answer exists; a list hardcoded in the component
    // would be a second allowlist to keep in step.
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/v1/proposals/allowed-keys/devices'))
  })

  it('sends only the fields somebody actually filled in', async () => {
    mockLoad([])
    renderTab({ userRole: 'Operator', currentUserId: OPERATOR_ID })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Propose a change' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Propose a change' }))

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

describe('ageLabel', () => {
  const base = new Date('2026-09-07T12:00:00Z').getTime()
  it('reads in the coarsest unit that is still true', () => {
    expect(ageLabel('2026-09-07T11:59:30Z', base)).toBe('just now')
    expect(ageLabel('2026-09-07T11:30:00Z', base)).toBe('30m ago')
    expect(ageLabel('2026-09-07T09:00:00Z', base)).toBe('3h ago')
    expect(ageLabel('2026-09-04T12:00:00Z', base)).toBe('3d ago')
  })
})
