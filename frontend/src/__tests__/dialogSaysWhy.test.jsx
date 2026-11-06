import React from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ActionButton } from '../components/common/ActionButton'
import { Modal } from '../components/common/Modal'
import { ConfirmModal } from '../components/modals/ConfirmModal'
import { AcknowledgeAlertModal } from '../components/modals/AcknowledgeAlertModal'
import { AddPersonModal } from '../components/modals/AddPersonModal'
import { AddSecondFactorModal } from '../components/modals/AddSecondFactorModal'
import { ApproveQuarantineModal } from '../components/modals/ApproveQuarantineModal'
import { BrokerSubscriberModal } from '../components/modals/BrokerSubscriberModal'
import { BugReportModal } from '../components/modals/BugReportModal'
import { ChangeEmailModal } from '../components/modals/ChangeEmailModal'
import { ChangePasswordModal } from '../components/modals/ChangePasswordModal'
import { RemoveSecondFactorModal } from '../components/modals/RemoveSecondFactorModal'
import { ServicePrincipalCreateModal } from '../components/modals/ServicePrincipalCreateModal'
import { ServicePrincipalDescribeModal } from '../components/modals/ServicePrincipalDescribeModal'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { api } from '../api'

/**
 * Every dialog says why it cannot go ahead, where the person is looking, and its confirm looks
 * refused while it cannot: greyed by ActionButton, the first problem in a warning hint inside the
 * dialog from the first edit (never on open), and a refusal from the server in the dialog's error
 * slot as it was worded. frontend/README.md, "A dialog says why it cannot go ahead".
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }
})

vi.mock('../lib/supabaseClient', () => ({
  supabase: { functions: { invoke: vi.fn() } }
}))

beforeEach(() => vi.clearAllMocks())

/** The text of every warning hint in the dialog, joined: where a reason is said. */
const reasons = (dialog) => [...dialog.querySelectorAll('.hint-danger')].map(el => el.textContent.trim()).join(' ').trim()

describe('ActionButton', () => {
  it('greys a disabled button, as it greys a refused one', () => {
    render(<ActionButton disabled>Save</ActionButton>)
    expect(screen.getByRole('button', { name: 'Save' })).toHaveClass('btn-disabled')
  })

  it('keeps a pending one legible, though it is disabled too', () => {
    render(<ActionButton pending disabled pendingLabel="Saving…">Save</ActionButton>)
    const button = screen.getByRole('button', { name: /Saving/ })
    expect(button).toBeDisabled()
    expect(button).toHaveClass('btn-loading')
    expect(button).not.toHaveClass('btn-disabled')
  })

  it('adds the class once when the caller already gives it', () => {
    render(<ActionButton disabled className="btn btn-primary btn-disabled">Save</ActionButton>)
    expect(screen.getByRole('button').className.match(/btn-disabled/g)).toHaveLength(1)
  })

  it('leaves an enabled button as the caller styled it', () => {
    render(<ActionButton className="btn btn-danger">Remove</ActionButton>)
    expect(screen.getByRole('button').className).toBe('btn btn-danger')
  })
})

describe("Modal's problem line", () => {
  const Form = ({ problem, touched }) => {
    const [name, setName] = React.useState('')
    return (
      <Modal title="Rename area" onClose={vi.fn()} problem={problem ?? (name ? null : 'Give the area a name')} touched={touched}
        footer={<ActionButton disabled={!name}>Save</ActionButton>}>
        <label htmlFor="n">Name</label>
        <input id="n" value={name} onChange={e => setName(e.target.value)} />
        <input aria-label="Other" defaultValue="" />
      </Modal>
    )
  }

  it('says nothing on open, then the problem from the first edit, in a live region above the buttons', () => {
    render(<Form />)
    const dialog = screen.getByRole('dialog')
    const line = dialog.querySelector('.modal-problem')
    expect(line).toHaveTextContent(/^$/)
    expect(line).toHaveAttribute('aria-live', 'polite')
    expect(line).toHaveClass('form-hint', 'hint-danger')
    expect(line.parentElement.lastElementChild).toHaveClass('modal-actions')

    fireEvent.change(screen.getByLabelText('Other'), { target: { value: 'x' } })
    expect(line).toHaveTextContent('Give the area a name')
    expect(line.querySelector('svg')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Machine Shop' } })
    expect(line).toHaveTextContent(/^$/)
  })

  it('follows `touched` where the dialog says when to start', () => {
    const { rerender } = render(<Form touched={false} />)
    fireEvent.change(screen.getByLabelText('Other'), { target: { value: 'x' } })
    expect(document.querySelector('.modal-problem')).toHaveTextContent(/^$/)
    rerender(<Form touched />)
    expect(document.querySelector('.modal-problem')).toHaveTextContent('Give the area a name')
  })

  it('is not drawn on a dialog that never refuses', () => {
    render(<Modal title="Shortcuts" onClose={vi.fn()}>Keys</Modal>)
    expect(document.querySelector('.modal-problem')).toBeNull()
  })
})

describe('ConfirmModal', () => {
  it('shows a refusal in the dialog as it was worded, and stays open', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('Cell has devices filed in it.'))
    render(<ConfirmModal title="Archive entity" message="Archive it?" confirmLabel="Archive" onConfirm={onConfirm} onCancel={vi.fn()} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Archive' })) })
    const dialog = screen.getByRole('dialog', { name: 'Archive entity' })
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Cell has devices filed in it.')
    expect(within(dialog).getByRole('button', { name: 'Archive' })).toBeEnabled()
  })
})

/**
 * The dialogs whose confirm a form holds: each opened empty, then given one edit that leaves it
 * incomplete. Dialogs held only by a typed gate say why in the gate's label; UploadCaptureModal and
 * StartPlaybackModal read files and the API first, and their own tests cover them.
 */
const DIALOGS = [
  {
    name: 'Acknowledge alert',
    render: () => <AcknowledgeAlertModal alert={{ alert_name: 'Device Offline' }} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    confirm: 'Acknowledge alert',
    edit: (d) => fireEvent.change(within(d).getByLabelText('Note (optional)'), { target: { value: 'belt change' } }),
    says: 'Choose a reason',
  },
  {
    name: 'Add a person',
    render: () => <AddPersonModal onClose={vi.fn()} />,
    confirm: /Add Person/,
    edit: (d) => fireEvent.change(within(d).getByLabelText('Display name (optional)'), { target: { value: 'Owain' } }),
    says: 'Enter their email address',
  },
  {
    name: /Change the email address/,
    render: () => <ChangeEmailModal person={{ user_id: 'u1', email: 'op@site.test' }} onClose={vi.fn()} />,
    confirm: 'Change Email',
    edit: (d) => fireEvent.change(within(d).getByLabelText('New email address'), { target: { value: 'op@' } }),
    says: 'That is not an email address.',
  },
  {
    name: 'Change your password',
    render: () => <ChangePasswordModal email="op@site.test" onClose={vi.fn()} />,
    confirm: 'Change Password',
    edit: (d) => fireEvent.change(within(d).getByLabelText('New password'), { target: { value: 'short' } }),
    says: 'Enter your current password.',
  },
  {
    name: 'Add Authenticator',
    render: () => <AddSecondFactorModal factors={[]} onClose={vi.fn()} />,
    confirm: 'Continue',
    // The name is filled in for them, so the edit that leaves it incomplete empties it.
    open: 'enabled',
    edit: (d) => fireEvent.change(within(d).getByLabelText('Name'), { target: { value: '  ' } }),
    says: 'Give it a name',
  },
  {
    name: 'Remove Phone',
    render: () => <RemoveSecondFactorModal factor={{ id: 'f1', friendly_name: 'Phone' }} needsCode onClose={vi.fn()} />,
    confirm: 'Remove Authenticator',
    edit: (d) => fireEvent.change(within(d).getByLabelText('Code from Phone'), { target: { value: '12' } }),
    says: 'Enter the 6-digit code Phone shows',
  },
  {
    name: 'New read-only broker account',
    render: () => <BrokerSubscriberModal onClose={vi.fn()} />,
    confirm: 'Create Read-Only Account',
    edit: (d) => fireEvent.change(within(d).getByLabelText('Name'), { target: { value: 'Line 4 OEE board' } }),
    says: 'Say what the account is for',
  },
  {
    name: 'New machine identity',
    render: () => <ServicePrincipalCreateModal onClose={vi.fn()} />,
    confirm: 'Create Machine Identity',
    edit: (d) => fireEvent.change(within(d).getByLabelText('Purpose (optional)'), { target: { value: 'reports' } }),
    says: 'Give the identity a name',
  },
  {
    name: /Describe/,
    render: () => <ServicePrincipalDescribeModal principal={{ principal_id: 'p1', name: 'Reports', purpose: '' }} onClose={vi.fn()} />,
    confirm: 'Save',
    edit: (d) => fireEvent.change(within(d).getByLabelText('Name'), { target: { value: '' } }),
    says: 'Give the identity a name',
  },
  {
    name: /Report platform bug/,
    render: () => <BugReportModal onClose={vi.fn()} showToast={vi.fn()} persona="Operator" activeTab="devices" />,
    confirm: /Submit Issue on GitHub/,
    edit: (d) => fireEvent.change(within(d).getByLabelText('Issue Title'), { target: { value: ' ' } }),
    says: 'Give the issue a title',
  },
  {
    name: /Approve Discovered Device/,
    render: () => (
      <ApproveQuarantineModal
        item={{ asset_id: 'd1', asset_name: 'CNC_9', entity_type: 'DEVICE', reported_identity: 'cnc9' }}
        cells={[]} gateways={[]} areas={[{ area_id: 'a1', area_name: 'Machine Shop' }, { area_id: 'a2', area_name: 'Stores' }]}
        onApprove={vi.fn()} onMerge={vi.fn()} onCancel={vi.fn()}
      />
    ),
    confirm: /Approve/,
    open: 'enabled',
    edit: (d) => fireEvent.click(within(d).getByLabelText('Area-Wide')),
    says: 'Choose which area the device serves',
  },
]

describe('a dialog whose form holds its confirm', () => {
  it.each(DIALOGS.map(c => [String(c.name), c]))('%s says why, from the first edit', (_, c) => {
    render(c.render())
    const dialog = screen.getByRole('dialog', { name: c.name })
    const confirm = within(dialog).getByRole('button', { name: c.confirm })
    if (c.open !== 'enabled') {
      expect(confirm).toBeDisabled()
      expect(confirm).toHaveClass('btn-disabled')
    }
    expect(reasons(dialog)).toBe('')

    c.edit(dialog)

    expect(confirm).toBeDisabled()
    expect(confirm).toHaveClass('btn-disabled')
    expect(reasons(dialog)).toContain(c.says)
  })
})

describe('New Device', () => {
  const show = async () => {
    api.get.mockImplementation((path) => Promise.resolve(path.startsWith('/api/v1/gateways')
      ? [{ gateway_id: 'gw-1', gateway_name: 'Line_A_Gateway', status: 'ONLINE', is_archived: false, devices: [] }]
      : []))
    const showToast = vi.fn()
    render(<DevicesTab showToast={showToast} onSelectDevice={vi.fn()} hasPermission={() => true} />)
    await waitFor(() => expect(api.get).toHaveBeenCalled())
    fireEvent.click(await screen.findByRole('button', { name: /New Device/i }))
    const dialog = screen.getByRole('dialog', { name: 'Register New Device' })
    return { showToast, dialog, save: within(dialog).getByRole('button', { name: /Save Configuration/i }) }
  }

  it('holds Save until the device has a name, marks the name required, and says so from the first edit', async () => {
    const { dialog, save } = await show()
    expect(save).toBeDisabled()
    expect(save).toHaveClass('btn-disabled')
    expect(within(dialog).getByLabelText('Device Name')).toHaveAttribute('aria-required', 'true')
    expect(dialog.querySelector('label[for="device-name"] .required-mark')).toBeTruthy()
    expect(reasons(dialog)).toBe('')

    fireEvent.change(within(dialog).getByPlaceholderText(/Spindle rebuilt 2026-03/), { target: { value: 'Second lathe' } })
    expect(dialog.querySelector('.modal-problem')).toHaveTextContent('Give the device a name')

    fireEvent.change(within(dialog).getByLabelText('Device Name'), { target: { value: 'Lathe_02' } })
    expect(save).toBeEnabled()
    expect(save).not.toHaveClass('btn-disabled')
    expect(reasons(dialog)).toBe('')
  })

  it('shows a refusal in the dialog, as it was worded, and toasts nothing behind it', async () => {
    api.post.mockRejectedValue(new Error('This action needs a second factor. Add one on your Profile page.'))
    const { showToast, dialog, save } = await show()
    fireEvent.change(within(dialog).getByLabelText('Device Name'), { target: { value: 'Lathe_02' } })
    await act(async () => { fireEvent.click(save) })
    expect(within(dialog).getByRole('alert')).toHaveTextContent('This action needs a second factor. Add one on your Profile page.')
    expect(showToast).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Register New Device' })).toBeInTheDocument()
  })
})
