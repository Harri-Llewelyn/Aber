import React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { ConfirmModal } from '../components/modals/ConfirmModal'
import { StartCaptureModal } from '../components/modals/StartCaptureModal'
import { UploadCaptureModal } from '../components/modals/UploadCaptureModal'
import { AutomationDetail } from '../components/tabs/AutomationDetail'
import { CaptureTab } from '../components/tabs/CaptureTab'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { PeopleSection } from '../components/tabs/PeopleSection'
import { tabLink } from '../test/tabBar'
import { pressHeld } from '../test/dialogs'

/**
 * Typed text guards removing a person's access, whoever they are, and every act that cannot be
 * undone (frontend/README.md, "Typed text guards removing access and what cannot be undone"). Each
 * gated dialog holds its button until the record's own name is typed, and then acts once. Permanent
 * Delete's is in EntitiesTab.test.jsx and Discard Draft's in schemaVersioningUi.test.jsx.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: Object.fromEntries(Object.keys(actual.api).map(name => [name, vi.fn()])) }
})
vi.mock('../lib/supabaseClient', () => ({ supabase: { functions: { invoke: vi.fn() } } }))
vi.mock('../hooks/useRealtimeTable', () => ({ useRealtimeTable: vi.fn() }))
// The automation's YAML editor is not what is tested here, and CodeMirror needs layout jsdom lacks.
vi.mock('../components/common/AutomationEditor', () => ({ AutomationEditor: () => null }))

/** The dialog's button is held until `text` is typed whole; then one click acts once. */
async function holdsUntilTyped({ dialog, label, text, button: name, act }) {
  const d = within(dialog)
  const button = d.getByRole('button', { name })
  const field = d.getByLabelText(`Type the ${label} to confirm`)
  expect(d.getByText(text, { selector: '.typed-gate-text' })).toBeInTheDocument()

  expect(button).toBeDisabled()
  expect(button).toHaveClass('btn-disabled')
  fireEvent.click(button)
  fireEvent.change(field, { target: { value: text.slice(0, -1) } })
  expect(button).toBeDisabled()
  fireEvent.change(field, { target: { value: text.toUpperCase() } })
  expect(button).toBeDisabled()
  expect(act).not.toHaveBeenCalled()

  fireEvent.change(field, { target: { value: ` ${text} ` } })
  expect(button).toBeEnabled()
  fireEvent.click(button)
  await waitFor(() => expect(act).toHaveBeenCalledTimes(1))
}

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/')
})

describe('the gate', () => {
  const open = (requireTyped) => render(
    <ConfirmModal title="Delete record" message="Gone." confirmLabel="Delete" requireTyped={requireTyped} onConfirm={vi.fn()} onCancel={vi.fn()} />
  )

  it('can be opened when the record\'s own name ends in a space', () => {
    open('Line 1 ')
    fireEvent.change(screen.getByLabelText('Type the name to confirm'), { target: { value: 'Line 1' } })
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled()
  })

  it('says beside the field, and on the held button, what is missing', () => {
    open('Line 1')
    const field = screen.getByLabelText('Type the name to confirm')
    expect(field).toHaveAccessibleDescription('The action below stays disabled until this matches exactly.')
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveAccessibleDescription('Type the name above to enable this')
    fireEvent.change(field, { target: { value: 'Line 1' } })
    expect(field).toHaveAccessibleDescription('Matches — the action below is now enabled.')
  })

  it.each([undefined, null, '', '  '])('is not drawn for %j', (requireTyped) => {
    open(requireTyped)
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled()
  })
})

describe('Remove Access', () => {
  const ME = 'a0000000-0000-4000-8000-000000000001'
  const person = (user_id, email, role, extra = {}) => ({
    user_id, email, role, status: 'active', sign_in_blocked: false, role_on_restore: null,
    invited_at: null, last_sign_in_at: '2026-10-01T09:00:00Z', created_at: '2026-09-01T09:00:00Z', ...extra,
  })

  const openRemove = async (who, shownAs) => {
    api.listPeople.mockResolvedValue([person(ME, 'me@site.test', 'Administrator'), who])
    api.personSessionSummary.mockResolvedValue({ open_sessions: 0, last_active_at: null })
    api.removePersonAccess.mockResolvedValue({ user_id: who.user_id, access: 'removed' })
    render(<PeopleSection showToast={vi.fn()} currentUserId={ME} />)
    fireEvent.click((await screen.findByText(shownAs)).closest('tr'))
    const drawer = within(await screen.findByRole('complementary', { name: / person$/ }))
    fireEvent.click(drawer.getByRole('button', { name: 'Remove Access' }))
    return screen.findByRole('dialog')
  }

  it.each(['Operator', 'Administrator'])('asks for the email address of an %s', async (role) => {
    const who = person('a0000000-0000-4000-8000-000000000003', 'sam.jones@site.test', role, { display_name: 'Sam Jones' })
    const dialog = await openRemove(who, 'Sam Jones')
    await holdsUntilTyped({
      dialog, label: 'email address', text: 'sam.jones@site.test', button: 'Remove Access', act: api.removePersonAccess,
    })
    expect(api.removePersonAccess).toHaveBeenCalledWith(who.user_id)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('asks for what the dialog names them by, for an account with no email address', async () => {
    const who = person('a0000000-0000-4000-8000-000000000004', null, 'Operator', { display_name: 'Sam Jones' })
    const dialog = await openRemove(who, 'Sam Jones')
    expect(dialog).toHaveAccessibleName('Remove Access — Sam Jones')
    await holdsUntilTyped({ dialog, label: 'name', text: 'Sam Jones', button: 'Remove Access', act: api.removePersonAccess })
  })

  it('is asked for again when the first removal did not finish', async () => {
    const who = person('a0000000-0000-4000-8000-000000000005', 'half@site.test', null, { status: 'removed', role_on_restore: 'Operator' })
    const dialog = await openRemove(who, 'half@site.test')
    expect(within(dialog).getByRole('button', { name: 'Remove Access' })).toBeDisabled()
    expect(within(dialog).getByLabelText('Type the email address to confirm')).toBeInTheDocument()
  })
})

describe('Reject Device', () => {
  const held = {
    quarantine_id: 'qtn-1', asset_id: 'cccccccc-0000-4000-8000-000000000003', asset_name: 'unknown_robot',
    reported_identity: 'devffffffffffffffffffff1', quarantine_reason: 'UNKNOWN_DEVICE', gateway_id: 'gw-1',
    gateway_name: 'Line_A_Gateway', discovered_at: '2026-11-20T09:00:00Z', entity_type: 'DEVICE',
  }

  it('asks for the device name', async () => {
    api.get.mockImplementation(path => Promise.resolve(path.startsWith('/api/v1/quarantine') ? [held] : []))
    api.post.mockResolvedValue({})
    render(<DevicesTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={() => true} />)
    await waitFor(() => expect(tabLink(/^Quarantine/)).toBeTruthy())
    fireEvent.click(tabLink(/^Quarantine/))
    fireEvent.click(within((await screen.findByText('unknown_robot')).closest('tr')).getByRole('button', { name: 'Reject' }))
    await holdsUntilTyped({
      dialog: screen.getByRole('dialog', { name: 'Reject Device' }),
      label: 'device name', text: 'unknown_robot', button: 'Reject Device', act: api.post,
    })
    expect(api.post).toHaveBeenCalledWith(`/api/v1/quarantine/${held.asset_id}/reject`, {})
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})

describe('a stored capture', () => {
  const GATEWAY = { id: 'gw-1', name: 'Line 1 Gateway', sparkplug_id: 'gwy120000000000400080000', is_archived: false, is_simulated: false }
  const DEVICE = { id: 'dev-1', name: 'CNC Spindle', sparkplug_id: 'dev270000000000400080000', gateway_id: 'gw-1', is_archived: false }
  const CAPTURES = {
    gateway: {
      id: 'cap-1', subject_kind: 'gateway', gateway_id: 'gw-1', device_id: null, subject_sparkplug_id: GATEWAY.sparkplug_id,
      storage_path: 'gwy120000000000400080000/6f0e.json', size_bytes: 2386, message_count: 6, note: 'pre-trip baseline',
      source: 'recorded', recorded_at: '2026-08-27T14:30:00.000Z', manifest: { birth_captured: true, metric_names: [], topic_count: 2 },
    },
    device: {
      id: 'cap-2', subject_kind: 'device', gateway_id: null, device_id: 'dev-1', subject_sparkplug_id: DEVICE.sparkplug_id,
      storage_path: 'dev270000000000400080000/7a1b.json', size_bytes: 1200, message_count: 3, note: null,
      source: 'recorded', recorded_at: '2026-08-28T09:00:00.000Z', manifest: { birth_captured: true, metric_names: [], topic_count: 1 },
    },
  }

  describe('Delete Capture', () => {
    it.each([
      ['gateway', '/capture/gateway', 'Line 1 Gateway'],
      ['device', '/capture/device', 'CNC Spindle'],
    ])('asks for the name of the %s it was recorded from', async (kind, path, name) => {
      window.history.replaceState(null, '', path)
      api.get.mockImplementation(p => Promise.resolve(p.includes('gateways') ? [GATEWAY] : p.includes('devices') ? [DEVICE] : []))
      api.listCaptures.mockResolvedValue([CAPTURES[kind]])
      for (const read of ['activeCaptureJob', 'activePlaybackJob']) api[read].mockResolvedValue(null)
      for (const read of ['recentCaptureJobs', 'recentPlaybackJobs', 'playbackStaleCredentials']) api[read].mockResolvedValue([])
      api.deleteCapture.mockResolvedValue()
      render(<CaptureTab showToast={vi.fn()} userRole="Administrator" />)
      fireEvent.click((await screen.findByText(name, { selector: 'td, td *' })).closest('tr'))
      fireEvent.click(await screen.findByRole('button', { name: 'Delete Capture' }))

      const dialog = await screen.findByRole('dialog', { name: /^Delete Capture — / })
      expect(dialog).toHaveAccessibleDescription(expect.stringContaining(`Delete the capture of ${name}, recorded `))
      await holdsUntilTyped({ dialog, label: `${kind} name`, text: name, button: 'Delete Capture', act: api.deleteCapture })
      expect(api.deleteCapture).toHaveBeenCalledWith(CAPTURES[kind])
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    })
  })

  describe('Replace and Record', () => {
    const subject = { kind: 'device', id: 'dev-1', name: 'CNC Spindle' }

    it('asks for the name of what it was recorded from', async () => {
      const onConfirm = vi.fn().mockResolvedValue()
      render(<StartCaptureModal subject={subject} existing={CAPTURES.device} onConfirm={onConfirm} onCancel={vi.fn()} />)
      await holdsUntilTyped({
        dialog: screen.getByRole('dialog'), label: 'device name', text: 'CNC Spindle', button: 'Replace and Record', act: onConfirm,
      })
      expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ replace: true }))
    })

    it('asks for nothing when no capture is stored', async () => {
      const onConfirm = vi.fn().mockResolvedValue()
      render(<StartCaptureModal subject={subject} existing={null} onConfirm={onConfirm} onCancel={vi.fn()} />)
      expect(screen.queryByLabelText(/^Type the /)).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Start Recording' }))
      await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ replace: false })))
    })
  })

  describe('Replace and Upload', () => {
    const SUBJECTS = [
      { kind: 'gateway', id: 'gw-1', name: 'Line 1 Gateway', sparkplugId: GATEWAY.sparkplug_id, capture: CAPTURES.gateway },
      { kind: 'device', id: 'dev-1', name: 'CNC Spindle', sparkplugId: DEVICE.sparkplug_id, capture: CAPTURES.device },
      { kind: 'device', id: 'dev-2', name: 'Press', sparkplugId: 'dev280000000000400080000', capture: null },
    ]
    const upload = async (preset) => {
      const onConfirm = vi.fn().mockResolvedValue()
      const doc = {
        aber_capture_version: 1, capture_epoch_ms: 1700000000000, identities: { edge_nodes: [], devices: [] },
        messages: [{ offset_ms: 0, topic: `spBv1.0/Aber/NBIRTH/${GATEWAY.sparkplug_id}`, payload: {} }],
      }
      const file = new File([JSON.stringify(doc)], 'elsewhere.json', { type: 'application/json' })
      render(<UploadCaptureModal file={file} subjects={SUBJECTS} presetSubject={preset} onConfirm={onConfirm} onCancel={vi.fn()} />)
      await screen.findByLabelText('File It Against')
      return onConfirm
    }
    const choose = (key) => fireEvent.change(screen.getByLabelText('File It Against'), { target: { value: key } })

    it('asks for the name of what the stored capture was recorded from', async () => {
      const onConfirm = await upload(SUBJECTS[0])
      await holdsUntilTyped({
        dialog: screen.getByRole('dialog'), label: 'gateway name', text: 'Line 1 Gateway', button: 'Replace and Upload', act: onConfirm,
      })
      expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ replace: true, expectedCaptureId: 'cap-1' }))
    })

    it('asks again when another subject is chosen, and for nothing when that one has no capture', async () => {
      const onConfirm = await upload(SUBJECTS[0])
      fireEvent.change(screen.getByLabelText('Type the gateway name to confirm'), { target: { value: 'Line 1 Gateway' } })
      choose('device:dev-1')
      expect(screen.getByLabelText('Type the device name to confirm')).toHaveValue('')
      expect(screen.getByRole('button', { name: 'Replace and Upload' })).toBeDisabled()
      choose('device:dev-2')
      expect(screen.queryByLabelText(/^Type the /)).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Upload Capture' }))
      await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ replace: false })))
    })

    it('asks for the subject first, on the press, and for no name before one is chosen', async () => {
      const onConfirm = await upload(null)
      expect(screen.queryByLabelText(/^Type the /)).toBeNull()
      pressHeld(screen.getByRole('dialog'), 'Upload Capture', 'Choose a gateway or device to file it against')
      expect(screen.getByLabelText('File It Against')).toHaveFocus()
      expect(onConfirm).not.toHaveBeenCalled()
    })
  })
})

describe('Delete Automation', () => {
  const stored = {
    id: 'lathe-3-spindle-hot', alias: 'Lathe 3 spindle bearing hot', description: '', enabled: true,
    triggers: [{ trigger: 'threshold', device: '3f1c9a6e-2b4d-4e8a-9c71-5d0e8f2a4b13', metric: 'Spindle/LOAD', above: 80 }],
    actions: [{ action: 'alert', severity: 'warning' }],
  }

  it('asks for the automation name', async () => {
    api.automationsDocument.mockResolvedValue({ automations: [stored], devices: {} })
    api.automationRow.mockResolvedValue({ id: 'row-1', key: stored.id, automation_triggers: [] })
    api.readAutomationAlerts.mockResolvedValue({ active: [], history: [] })
    api.get.mockResolvedValue([])
    api.deleteAutomation.mockResolvedValue()
    render(<AutomationDetail automationKey={stored.id} showToast={vi.fn()} canWrite hasPermission={() => true} onExport={vi.fn()} />)
    await screen.findByRole('heading', { name: stored.alias })
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await holdsUntilTyped({
      dialog: screen.getByRole('dialog', { name: /^Delete Automation — / }),
      label: 'automation name', text: stored.alias, button: 'Delete Automation', act: api.deleteAutomation,
    })
    expect(api.deleteAutomation).toHaveBeenCalledWith(stored.id)
  })
})
