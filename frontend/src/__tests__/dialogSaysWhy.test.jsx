import React from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ActionButton } from '../components/common/ActionButton'
import { FieldError, fieldErrorProps } from '../components/common/FieldError'
import { sameForm, useFormCheck } from '../hooks/useFormCheck'
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
import { pressHeld, wrongIn } from '../test/dialogs'
import { changeOwnPassword } from '../utils/passwords'

/**
 * Every dialog says why it cannot go ahead, where the person is looking. Its primary is pressable: a
 * press with something missing sends nothing, says it beside each field, names the first above the
 * buttons and puts the focus there. A dialog that has just opened says nothing. A refusal from the
 * server is in the dialog's error slot as it was worded. frontend/README.md, "A dialog says why it
 * cannot go ahead".
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: {
      get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), addPerson: vi.fn(), changePersonEmail: vi.fn(),
      startFactorEnrolment: vi.fn(), verifyFactorCode: vi.fn(), removeFactor: vi.fn(), createBrokerSubscriber: vi.fn(),
      createServicePrincipal: vi.fn(), describeServicePrincipal: vi.fn()
    }
  }
})

vi.mock('../lib/supabaseClient', () => ({
  supabase: { functions: { invoke: vi.fn() } }
}))

vi.mock('../utils/passwords', async () => ({ ...(await vi.importActual('../utils/passwords')), changeOwnPassword: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(window, 'open').mockImplementation(() => null)
})

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
  const Form = ({ problem }) => (
    <Modal title="Rename Area" onClose={vi.fn()} problem={problem} footer={<ActionButton>Save</ActionButton>}>
      <input aria-label="Other" defaultValue="" />
    </Modal>
  )

  it('is a live region above the buttons, empty until there is a problem', () => {
    const { rerender } = render(<Form problem={null} />)
    const line = screen.getByRole('dialog').querySelector('.modal-problem')
    expect(line).toHaveTextContent(/^$/)
    expect(line).toHaveAttribute('aria-live', 'polite')
    expect(line).toHaveClass('form-hint', 'hint-danger')
    expect(line.parentElement.lastElementChild).toHaveClass('modal-actions')

    rerender(<Form problem="Give the area a name" />)
    expect(line).toHaveTextContent('Give the area a name')
    expect(line.querySelector('svg')).toBeTruthy()
  })

  it('is not drawn on a dialog that never refuses', () => {
    render(<Modal title="Shortcuts" onClose={vi.fn()}>Keys</Modal>)
    expect(document.querySelector('.modal-problem')).toBeNull()
  })
})

describe('ConfirmModal', () => {
  it('shows a refusal in the dialog as it was worded, and stays open', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('Cell has devices filed in it.'))
    render(<ConfirmModal title="Archive Entity" message="Archive it?" confirmLabel="Archive" onConfirm={onConfirm} onCancel={vi.fn()} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Archive' })) })
    const dialog = screen.getByRole('dialog', { name: 'Archive Entity' })
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Cell has devices filed in it.')
    expect(within(dialog).getByRole('button', { name: 'Archive' })).toBeEnabled()
  })
})

/** A form whose primary is pressable, as a dialog draws it: two fields, the second wrong as typed. */
function Example({ save, unchanged = false }) {
  const [name, setName] = React.useState('')
  const [code, setCode] = React.useState('')
  const check = useFormCheck({
    name: { id: 'ex-name', missing: !name && 'Give it a name' },
    code: { id: 'ex-code', missing: !code && 'Give it a code', wrong: code.includes(' ') && 'A code has no spaces' },
  }, { unchanged })
  return (
    <Modal title="Example" onClose={vi.fn()} problem={check.problem} dismiss="Cancel"
      footer={<ActionButton onClick={() => check.press(() => { save(); setCode('') })}>Save Example</ActionButton>}>
      <input aria-label="Name" id="ex-name" value={name} onChange={e => setName(e.target.value)} {...fieldErrorProps(check.errors.name, 'ex-name-error')} />
      <FieldError id="ex-name-error" error={check.errors.name} />
      <input aria-label="Code" id="ex-code" value={code} onChange={e => setCode(e.target.value)} {...fieldErrorProps(check.errors.code, 'ex-code-error')} />
      <FieldError id="ex-code-error" error={check.errors.code} />
    </Modal>
  )
}

describe('useFormCheck', () => {
  const dialog = () => screen.getByRole('dialog', { name: 'Example' })
  const type = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

  it('says nothing on open, and what is missing on every field at once when it is pressed', () => {
    const save = vi.fn()
    render(<Example save={save} />)
    expect(wrongIn(dialog())).toEqual([])

    pressHeld(dialog(), 'Save Example', 'Give it a name')
    expect(wrongIn(dialog())).toEqual(['Give it a name', 'Give it a code', 'Give it a name'])
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('Name')).toHaveFocus()
    expect(save).not.toHaveBeenCalled()

    // Each clears as it is fixed, and the line names the next.
    type('Name', 'Press')
    expect(wrongIn(dialog())).toEqual(['Give it a code', 'Give it a code'])
    pressHeld(dialog(), 'Save Example', 'Give it a code')
    expect(screen.getByLabelText('Code')).toHaveFocus()
    expect(save).not.toHaveBeenCalled()
  })

  it('says what is wrong with a value as it is typed, under its field alone', () => {
    render(<Example save={vi.fn()} />)
    type('Code', 'a b')
    expect(wrongIn(dialog())).toEqual(['A code has no spaces'])
    expect(dialog().querySelector('.modal-problem')).toHaveTextContent(/^$/)
    type('Name', 'Press')
    pressHeld(dialog(), 'Save Example', 'A code has no spaces')
  })

  it('starts again after a press that goes ahead, so a field it emptied is not asked for', () => {
    const save = vi.fn()
    render(<Example save={save} />)
    pressHeld(dialog(), 'Save Example', 'Give it a name')
    type('Name', 'Press')
    type('Code', 'ab')
    fireEvent.click(screen.getByRole('button', { name: 'Save Example' }))
    expect(save).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('Code')).toHaveValue('')
    expect(wrongIn(dialog())).toEqual([])
  })

  it('says that nothing has changed, and sends nothing', () => {
    const save = vi.fn()
    render(<Example save={save} unchanged />)
    type('Name', 'Press')
    type('Code', 'ab')
    pressHeld(dialog(), 'Save Example', 'Nothing has changed.')
    expect(save).not.toHaveBeenCalled()
  })

  it('compares two forms by what they hold', () => {
    expect(sameForm({ name: 'A', description: '' }, { name: 'A' })).toBe(true)
    expect(sameForm({ plan_x: 0.5 }, { plan_x: '0.5' })).toBe(true)
    expect(sameForm({ ids: ['a', 'b'] }, { ids: ['b', 'a'] })).toBe(true)
    expect(sameForm({ ids: ['a'] }, { ids: ['a', 'b'] })).toBe(false)
    expect(sameForm({ name: 'A' }, { name: 'a' })).toBe(false)
  })
})

/**
 * The dialogs a form is in front of: each opened, left incomplete, and pressed. `sends` is what the press
 * would have called. Dialogs held only by a typed gate say why in the gate's label; UploadCaptureModal
 * and StartPlaybackModal read files and the API first, and their own tests cover them.
 */
const DIALOGS = [
  {
    name: 'Acknowledge Alert — Device Offline',
    render: (spy) => <AcknowledgeAlertModal alert={{ alert_name: 'Device Offline' }} onConfirm={spy} onCancel={vi.fn()} />,
    confirm: 'Acknowledge Alert',
    says: ['Choose a reason'],
    focus: 'Reason',
  },
  {
    name: 'Add a Person',
    render: () => <AddPersonModal onClose={vi.fn()} />,
    confirm: /Add Person/,
    says: ['Enter their email address'],
    focus: 'Email',
    sends: () => api.addPerson,
  },
  {
    name: /Change the Email Address/,
    render: () => <ChangeEmailModal person={{ user_id: 'u1', email: 'op@site.test' }} onClose={vi.fn()} />,
    confirm: 'Change Email',
    says: ['Type their new email address'],
    focus: 'New Email Address',
    sends: () => api.changePersonEmail,
  },
  {
    name: 'Change Your Password',
    render: () => <ChangePasswordModal email="op@site.test" onClose={vi.fn()} />,
    confirm: 'Change Password',
    says: ['Enter your current password.', /The new password needs at least/],
    focus: 'Current Password',
    sends: () => changeOwnPassword,
    // The button submits a form, which jsdom does on a click.
  },
  {
    name: 'Add Authenticator',
    render: () => <AddSecondFactorModal factors={[]} onClose={vi.fn()} />,
    confirm: 'Continue',
    // The name is filled in for them.
    empty: (d) => fireEvent.change(within(d).getByLabelText('Name'), { target: { value: '  ' } }),
    says: ['Give it a name'],
    focus: 'Name',
    sends: () => api.startFactorEnrolment,
  },
  {
    name: 'Remove Authenticator — Phone',
    render: () => <RemoveSecondFactorModal factor={{ id: 'f1', friendly_name: 'Phone' }} needsCode onClose={vi.fn()} />,
    confirm: 'Remove Authenticator',
    says: ['Enter the 6-digit code Phone shows'],
    focus: 'Code from Phone',
    sends: () => api.verifyFactorCode,
  },
  {
    name: 'New Read-Only Broker Account',
    render: () => <BrokerSubscriberModal onClose={vi.fn()} />,
    confirm: 'Create Read-Only Account',
    says: ['Give the account a name', 'Say what the account is for'],
    focus: 'Name',
    sends: () => api.createBrokerSubscriber,
  },
  {
    name: 'New Machine Identity',
    render: () => <ServicePrincipalCreateModal onClose={vi.fn()} />,
    confirm: 'Create Machine Identity',
    empty: (d) => fireEvent.click(within(d).getAllByRole('checkbox').find(box => box.checked)),
    says: ['Give the identity a name', 'Choose at least one permission for it to hold'],
    focus: 'Name',
    sends: () => api.createServicePrincipal,
  },
  {
    name: /Describe/,
    render: () => <ServicePrincipalDescribeModal principal={{ principal_id: 'p1', name: 'Reports', purpose: '' }} onClose={vi.fn()} />,
    confirm: 'Save Identity',
    empty: (d) => fireEvent.change(within(d).getByLabelText('Name'), { target: { value: '' } }),
    says: ['Give the identity a name'],
    focus: 'Name',
    sends: () => api.describeServicePrincipal,
  },
  {
    name: /Report Platform Bug/,
    render: () => <BugReportModal onClose={vi.fn()} showToast={vi.fn()} persona="Operator" activeTab="devices" />,
    confirm: /Submit Issue on GitHub/,
    says: ['Give the issue a title'],
    focus: 'Issue Title',
    sends: () => window.open,
  },
  {
    name: /Approve Discovered Device/,
    render: (spy) => (
      <ApproveQuarantineModal
        item={{ asset_id: 'd1', asset_name: 'CNC_9', entity_type: 'DEVICE', reported_identity: 'cnc9' }}
        cells={[]} gateways={[]} areas={[{ area_id: 'a1', area_name: 'Machine Shop' }, { area_id: 'a2', area_name: 'Stores' }]}
        onApprove={spy} onMerge={vi.fn()} onCancel={vi.fn()}
      />
    ),
    confirm: /Approve/,
    empty: (d) => fireEvent.click(within(d).getByLabelText('Area-Wide')),
    says: ['Choose which area the device serves'],
    focus: 'Area',
  },
]

describe('a dialog with something missing', () => {
  it.each(DIALOGS.map(c => [String(c.name), c]))('%s says it on the press, beside each field, and sends nothing', (_, c) => {
    const spy = vi.fn()
    render(c.render(spy))
    const dialog = screen.getByRole('dialog', { name: c.name })
    c.empty?.(dialog)
    expect(wrongIn(dialog)).toEqual([])

    pressHeld(dialog, c.confirm, c.says[0])

    // Every field's own message, and the line above the buttons naming the first.
    const said = wrongIn(dialog)
    expect(said).toHaveLength(c.says.length + 1)
    c.says.forEach((says, i) => expect(said[i]).toMatch(says))
    const field = within(dialog).getByLabelText(c.focus)
    expect(field).toHaveFocus()
    expect(field).toHaveAccessibleDescription(expect.stringMatching(c.says[0]))
    expect(c.sends?.() ?? spy).not.toHaveBeenCalled()
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
    return { showToast, dialog, save: within(dialog).getByRole('button', { name: /Save Device/i }) }
  }

  it('marks the name required, asks for it on the press, and starts clean each time it opens', async () => {
    const { dialog } = await show()
    expect(within(dialog).getByLabelText('Device Name')).toHaveAttribute('aria-required', 'true')
    expect(dialog.querySelector('label[for="device-name"] .required-mark')).toBeTruthy()
    expect(wrongIn(dialog)).toEqual([])

    fireEvent.change(within(dialog).getByPlaceholderText(/Spindle rebuilt 2026-03/), { target: { value: 'Second lathe' } })
    expect(wrongIn(dialog)).toEqual([])
    pressHeld(dialog, /Save Device/, 'Give the device a name')
    expect(within(dialog).getByLabelText('Device Name')).toHaveFocus()
    expect(api.post).not.toHaveBeenCalled()

    fireEvent.change(within(dialog).getByLabelText('Device Name'), { target: { value: 'Lathe_02' } })
    expect(wrongIn(dialog)).toEqual([])
    fireEvent.change(within(dialog).getByLabelText('Device Name'), { target: { value: '' } })
    expect(wrongIn(dialog)).not.toEqual([])

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: /New Device/i }))
    expect(wrongIn(screen.getByRole('dialog', { name: 'Register New Device' }))).toEqual([])
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
