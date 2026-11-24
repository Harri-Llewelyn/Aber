/**
 * Every field that can say what is wrong with it says it in a FieldError, and its control names that
 * error: `aria-invalid`, and an `aria-describedby` that keeps the field's hint and adds the error. A
 * hint keeps its own text and look while the error shows beneath it. A message about a control whose
 * value is not wrong (a copy the browser refused, a choice that can be saved) is named without
 * `aria-invalid`.
 */
import React, { useState } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { CellPlacementPicker } from '../components/common/CellPlacementPicker'
import { PermittedValuesField } from '../components/common/PermittedValuesField'
import { TimeWindowControl } from '../components/common/TimeWindowControl'
import { AddDerivedMetricModal } from '../components/modals/AddDerivedMetricModal'
import { AddPersonModal } from '../components/modals/AddPersonModal'
import { AddSecondFactorModal } from '../components/modals/AddSecondFactorModal'
import { ApproveQuarantineModal } from '../components/modals/ApproveQuarantineModal'
import { ChangeEmailModal } from '../components/modals/ChangeEmailModal'
import { DeviceNameplateModal } from '../components/modals/DeviceNameplateModal'
import { DisplayNameModal } from '../components/modals/DisplayNameModal'
import { ImportVocabularyModal } from '../components/modals/ImportVocabularyModal'
import { NewPasswordModal } from '../components/modals/NewPasswordModal'
import { RegisterAppModal } from '../components/modals/RegisterAppModal'
import { SchemaBuilderModal } from '../components/modals/SchemaBuilderModal'
import { SchemaDetailModal } from '../components/modals/SchemaDetailModal'
import { ServiceTokenInventoryModal } from '../components/modals/ServiceTokenInventoryModal'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import { ProfileTab } from '../components/tabs/ProfileTab'
import { tokenStatus } from '../utils/serviceIdentities'
import { rollingWindow, TIME_PRESETS } from '../utils/timeWindow'
import { fileOf } from './aasFixtures'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: {
      get: vi.fn(), post: vi.fn(), put: vi.fn(), registerApp: vi.fn(), revokeServiceToken: vi.fn(), siteVocabularyHolders: vi.fn(),
    }
  }
})

vi.mock('../lib/supabaseClient', () => ({
  SUPABASE_URL: 'https://api.site.test',
  SUPABASE_GATEWAY_KEY: 'sb_publishable_test',
  supabase: { functions: { invoke: vi.fn() }, auth: { getSession: vi.fn(() => new Promise(() => {})) } },
}))

vi.mock('../components/common/CopyableId', () => ({
  __esModule: true,
  default: () => null,
  copyText: vi.fn().mockResolvedValue(false),
}))

const PERSON = { user_id: 'u-1', email: 'operator@site.test', display_name: 'Owain' }
const TOO_LONG = 'N'.repeat(81)
const COPY_REFUSED = 'Could not reach the clipboard — select the value and copy it.'
const type = (control, value) => fireEvent.change(control, { target: { value } })

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockResolvedValue([])
  api.siteVocabularyHolders.mockResolvedValue(new Map())
})

/** The elements a control's aria-describedby names, in order. Each is in the document. */
const describers = (control) => (control.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean).map(id => {
  const el = document.getElementById(id)
  expect(el, `aria-describedby names #${id}, which is not there`).not.toBeNull()
  return el
})

/** The FieldError a control names that says `text`, checked to be one. */
const namedError = (control, text) => {
  const error = describers(control).find(el => el.matches('[role="alert"]'))
  expect(error, 'the control names no error').toBeTruthy()
  expect(error).toHaveClass('form-hint', 'hint-danger')
  expect(error.querySelector('svg')).not.toBeNull()
  expect(error).toHaveTextContent(text)
  return error
}

/**
 * The control says `text` and, where it has a `hint`, names that first and leaves it as it was. The
 * order is the reading order too: the hint is above the error.
 */
const saysWhy = (control, text, { hint, invalid = true } = {}) => {
  const error = namedError(control, text)
  if (invalid) expect(control).toHaveAttribute('aria-invalid', 'true')
  else expect(control).not.toHaveAttribute('aria-invalid')
  if (hint) {
    const named = describers(control)
    const said = named.find(el => el.textContent.includes(hint))
    expect(said, 'the control no longer names its hint').toBeTruthy()
    expect(said).not.toHaveClass('hint-danger')
    expect(named.indexOf(said)).toBeLessThan(named.indexOf(error))
    expect(said.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  }
}

/** Nothing is wrong with the control, and it names no error. */
const saysNothing = (control) => {
  expect(control).not.toHaveAttribute('aria-invalid')
  expect(describers(control).filter(el => el.matches('[role="alert"]'))).toEqual([])
}

describe('a person’s fields', () => {
  it('Add Person, the display name', () => {
    render(<AddPersonModal onClose={vi.fn()} />)
    const name = screen.getByLabelText(/^Display name/)
    saysNothing(name)
    type(name, TOO_LONG)
    saysWhy(name, 'A display name is 80 characters at most.', { hint: 'They can change it on their Profile page.' })
    type(name, 'Owain')
    saysNothing(name)
  })

  it('Change Name', () => {
    render(<DisplayNameModal person={PERSON} onClose={vi.fn()} />)
    const name = screen.getByLabelText('Display name')
    saysNothing(name)
    type(name, TOO_LONG)
    saysWhy(name, 'A display name is 80 characters at most.', { hint: 'Leave it empty to show their email address alone.' })
  })

  it('Change Email', () => {
    render(<ChangeEmailModal person={PERSON} onClose={vi.fn()} />)
    const email = screen.getByLabelText(/^New email address/)
    saysNothing(email)
    type(email, 'not-an-address')
    saysWhy(email, 'That is not an email address.', { hint: 'Their role, name and history stay.' })
    type(email, PERSON.email)
    saysWhy(email, 'That is already their email address.', { hint: 'Their role, name and history stay.' })
  })

  it('the display name on Profile', () => {
    render(
      <ProfileTab email={PERSON.email} userRole="Operator" theme="dark" sidebarMode="hover" settingsSource="account"
        displayName="Owain" onChangePassword={vi.fn()} onChangeTheme={vi.fn()} onChangeSidebarMode={vi.fn()} onSaveDisplayName={vi.fn()} />
    )
    const name = screen.getByLabelText('Display name')
    saysNothing(name)
    type(name, TOO_LONG)
    saysWhy(name, 'A display name is 80 characters at most.', { hint: 'Up to 80 characters.' })
  })

  it('Add Authenticator, the name', () => {
    render(<AddSecondFactorModal factors={[{ id: 'f-1', friendly_name: 'Work phone' }]} onAdded={vi.fn()} onClose={vi.fn()} />)
    const name = screen.getByLabelText(/^Name/)
    saysNothing(name)
    type(name, 'work phone')
    saysWhy(name, 'You already have an authenticator with that name.', { hint: 'So you can tell your authenticators apart' })
  })

  it('a password shown once, when its copy is refused', async () => {
    render(<NewPasswordModal email={PERSON.email} password="pw-shown-once" onClose={vi.fn()} showToast={vi.fn()} />)
    const password = screen.getByLabelText('Password')
    saysNothing(password)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy password' })) })
    // The value is right: it is the copy that failed.
    saysWhy(password, COPY_REFUSED, { invalid: false })
  })
})

describe('Register App', () => {
  it('the name and the addresses', () => {
    render(<RegisterAppModal onClose={vi.fn()} siteDomain="site.test" />)
    const name = screen.getByLabelText(/^Name/)
    const addresses = screen.getByLabelText(/^Addresses/)
    saysNothing(name)
    saysNothing(addresses)
    type(name, TOO_LONG)
    saysWhy(name, "An app's name is 80 characters at most.", { hint: 'Shown to a person when the app asks to sign them in.' })
    type(addresses, 'ftp://files.site.test')
    saysWhy(addresses, /^ftp:\/\/files\.site\.test must start with https/, { hint: 'One to a line' })
  })

  it('a value whose copy is refused, and that one alone', async () => {
    api.registerApp.mockResolvedValue({ id: 'app-1', name: 'Reports', client_type: 'confidential', client_secret: 'not-a-real-secret' })
    render(<RegisterAppModal onClose={vi.fn()} authUrl="https://api.site.test/auth/v1" showToast={vi.fn()} />)
    type(screen.getByLabelText(/^Name/), 'Reports')
    type(screen.getByLabelText(/^Addresses/), 'https://reports.site.test/cb')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Register App/ })) })

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy client secret' })) })
    saysWhy(screen.getByLabelText('Client secret'), COPY_REFUSED, { invalid: false })
    saysNothing(screen.getByLabelText('Client ID'))
    expect(screen.getAllByRole('alert')).toHaveLength(1)

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy client id' })) })
    saysWhy(screen.getByLabelText('Client ID'), COPY_REFUSED, { invalid: false })
    saysNothing(screen.getByLabelText('Client secret'))
  })
})

describe('a schema’s fields', () => {
  const CATALOG = [
    { metric_uuid: 'm-1', name: 'Systems/TEMPERATURE', datatype: 10, standard: 'MTConnect', description: '', deprecated: false },
  ]
  const tick = () => fireEvent.click(screen.getByText('Systems/TEMPERATURE').closest('label').querySelector('input'))
  const bound = (which) => screen.getByRole('spinbutton', { name: `${which} of Systems/TEMPERATURE` })
  const badRange = () => { type(bound('Minimum'), '9'); type(bound('Maximum'), '1') }
  const RANGE = 'Fix the range of Systems/TEMPERATURE: The minimum is above the maximum.'

  it('Build Schema from Catalog, the name and the metrics, from a save attempt', () => {
    render(<SchemaBuilderModal catalog={CATALOG} onSubmit={vi.fn()} onCancel={vi.fn()} />)
    const name = screen.getByLabelText(/^Schema Name/)
    const metrics = screen.getByRole('group', { name: /^Metrics/ })
    saysNothing(name)
    saysNothing(metrics)

    fireEvent.click(screen.getByRole('button', { name: 'Save Schema' }))
    saysWhy(name, 'Give the schema a name before saving it.')
    // A group takes no aria-invalid.
    saysWhy(metrics, 'Tick at least one metric.', { invalid: false })
  })

  it('Build Schema from Catalog, a range: marked as typed, and said from a save attempt', () => {
    render(<SchemaBuilderModal catalog={CATALOG} onSubmit={vi.fn()} onCancel={vi.fn()} />)
    tick()
    saysNothing(bound('Minimum'))
    badRange()
    expect(bound('Minimum')).toHaveAttribute('aria-invalid', 'true')
    expect(bound('Minimum')).not.toHaveAttribute('aria-describedby')

    fireEvent.click(screen.getByRole('button', { name: 'Save Schema' }))
    for (const which of ['Minimum', 'Maximum']) saysWhy(bound(which), RANGE)
  })

  it('a draft’s editor, a range', () => {
    const draft = { schema_uuid: 'd-1', schema_name: 'Mill', version: 1, status: 'draft', schema_definition: { type: 'object', properties: {} } }
    render(<SchemaDetailModal schema={draft} schemas={[draft]} catalog={CATALOG} canManage onSaveDraft={vi.fn()} onClose={vi.fn()} />)
    tick()
    saysNothing(bound('Maximum'))
    badRange()
    for (const which of ['Minimum', 'Maximum']) saysWhy(bound(which), RANGE)
  })

  it('neither draws its own border: the rule is App.css’s', () => {
    render(<SchemaBuilderModal catalog={CATALOG} onSubmit={vi.fn()} onCancel={vi.fn()} />)
    tick()
    badRange()
    fireEvent.click(screen.getByRole('button', { name: 'Save Schema' }))
    for (const control of [screen.getByLabelText(/^Schema Name/), bound('Minimum')]) expect(control.style.borderColor).toBe('')
  })
})

describe('a metric’s fields', () => {
  it('Add Derived Metric, a name the catalog holds', () => {
    const held = { metric_uuid: 'm-1', name: 'OEE', datatype: 10, deprecated: false }
    render(<AddDerivedMetricModal catalog={[held]} groups={[]} declared={new Set()} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    const name = screen.getByLabelText(/^Metric Name/)
    saysNothing(name)
    type(name, 'OEE')
    saysWhy(name, 'OEE is already in the catalog.')
  })

  it('Permitted Values, and nothing is said of a list that can be saved', () => {
    const Field = () => {
      const [value, setValue] = useState('')
      const error = value === 'one' ? 'A numeric metric\'s values are whole numbers. "one" is not one.' : null
      return <PermittedValuesField idPrefix="t" datatype={3} value={value} onChange={setValue} error={error} />
    }
    render(<Field />)
    const values = screen.getByLabelText('Permitted Values')
    saysNothing(values)
    type(values, 'one')
    saysWhy(values, 'whole numbers')
    expect(values.style.borderColor).toBe('')
    type(values, '1')
    saysNothing(values)
  })
})

describe('a device’s and a gateway’s fields', () => {
  it('Digital Nameplate, the year and the address, each under its own field', async () => {
    api.get.mockResolvedValue({ stored: null, template: [], published: {} })
    render(<DeviceNameplateModal asset={{ asset_id: 'd-1', asset_name: 'CNC_01' }} canManage onClose={vi.fn()} />)
    const year = await screen.findByLabelText(/^Year of construction/)
    const uri = screen.getByLabelText(/^Product URI/)
    saysNothing(year)
    saysNothing(uri)
    type(year, '24')
    saysWhy(year, 'Year of construction must be four digits.')
    saysNothing(uri)
    type(uri, 'manufacturer.example/p/1')
    saysWhy(uri, 'Product URI must be an absolute IRI, including its scheme — https://…')
    for (const control of [year, uri]) {
      expect(control.parentElement).toContainElement(namedError(control, /./))
    }
  })

  it('Edit Device Configuration, the change to Enforce', async () => {
    const SCHEMA = { schema_uuid: 's-1', schema_name: 'CNC_Mill_v1', device_count: 1 }
    const device = {
      asset_id: 'aaaaaaaa-0000-4000-8000-000000000001', asset_name: 'CNC_01', sparkplug_id: 'devaaaaaaaa000040008000',
      status: 'ONLINE', is_quarantined: false, is_archived: false, active_gateway_id: 'gw-1', location_scope: 'gateway',
      location_source: 'unassigned', conformance_policy: 'audit', created_at: '2026-07-20T12:00:00Z', schemas: [SCHEMA], schema_ids: ['s-1'],
    }
    api.get.mockImplementation(async (path) => (
      path.startsWith('/api/v1/devices') ? [device] : path.startsWith('/api/v1/schemas') ? [SCHEMA] : []
    ))
    render(<DevicesTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={() => true} />)
    fireEvent.click(await within(await waitFor(() => {
      const page = document.querySelector('.page-main')
      expect(page).not.toBeNull()
      return page
    })).findByText('CNC_01'))
    fireEvent.click(within(document.querySelector('.context-panel')).getByText('Edit Details'))
    const policy = screen.getByLabelText('Schema Conformance')
    const ticked = screen.getByLabelText('CNC_Mill_v1')
    if (!ticked.checked) fireEvent.click(ticked)
    saysNothing(policy)
    type(policy, 'enforce')
    // It can be saved: the line says what saving it does.
    saysWhy(policy, 'will not be written to the historian and cannot be recovered', { invalid: false })
    type(policy, 'audit')
    saysNothing(policy)
  })

  it('Edit Gateway, the Sparkplug group', async () => {
    const gateway = {
      gateway_id: 'bbbbbbbb-0000-4000-8000-000000000001', gateway_name: 'Line_A', location_scope: 'site_wide', status: 'ONLINE',
      deployment: 'remote', is_archived: false, sparkplug_group: 'Aber', last_heartbeat: new Date().toISOString(), devices: [],
    }
    api.get.mockImplementation(async (path) => (path.startsWith('/api/v1/gateways') ? [gateway] : []))
    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} onClearFilter={vi.fn()} />)
    fireEvent.click(await within(await waitFor(() => {
      const page = document.querySelector('.page-main')
      expect(page).not.toBeNull()
      return page
    })).findByText('Line_A'))
    fireEvent.click(within(document.querySelector('.context-panel')).getByRole('button', { name: /Edit Details/ }))
    const group = screen.getByLabelText('Sparkplug Group')
    saysNothing(group)
    type(group, 'Plant/B')
    saysWhy(group, 'cannot contain /')
    // Under the hint, which has no id to be named by.
    const hint = screen.getByText(/^The second level of every topic/)
    expect(hint.compareDocumentPosition(namedError(group, /./)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    type(group, '')
    saysWhy(group, 'A Sparkplug group cannot be empty.')
  })

  it('Approve Discovered Device says why it was held, under the id it published', () => {
    const item = { asset_id: 'd1', asset_name: 'CNC_9', entity_type: 'DEVICE', reported_identity: 'cnc9', quarantine_reason: 'The id is not one Aber issues.' }
    const { rerender } = render(<ApproveQuarantineModal item={item} cells={[]} gateways={[]} onApprove={vi.fn()} onMerge={vi.fn()} onCancel={vi.fn()} />)
    const reason = screen.getByRole('alert')
    expect(reason).toHaveTextContent('The id is not one Aber issues.')
    expect(reason).toHaveClass('form-hint', 'hint-danger')
    expect(reason.querySelector('svg')).not.toBeNull()
    expect(reason.closest('.form-group')).toHaveTextContent('Published Sparkplug ID')

    rerender(<ApproveQuarantineModal item={{ ...item, quarantine_reason: null }} cells={[]} gateways={[]} onApprove={vi.fn()} onMerge={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('the rest', () => {
  it('a token that could not be revoked, named by its Revoke button', async () => {
    const now = Date.parse('2026-09-03T12:00:00Z')
    const mint = (jti) => ({ jti, issued_at: new Date(now - 1e8).toISOString(), expires_at: new Date(now + 1e9).toISOString() })
    api.revokeServiceToken.mockRejectedValue(new Error('insufficient privileges'))
    render(<ServiceTokenInventoryModal principalName="Reader" status={tokenStatus([mint('kept'), mint('other')], now, new Set())} now={now}
      onClose={vi.fn()} onChanged={vi.fn()} showToast={vi.fn()} />)
    const row = (jti) => screen.getByText(jti, { selector: 'td' }).closest('tr')
    const button = (jti) => within(row(jti)).getByRole('button', { name: 'Revoke' })
    saysNothing(button('kept'))
    fireEvent.click(button('kept'))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Revoke Token' })).getByRole('button', { name: 'Revoke Token' }))
    await within(row('kept')).findByRole('alert')
    saysWhy(button('kept'), 'insufficient privileges', { invalid: false })
    saysNothing(button('other'))
  })

  it('Import vocabulary, a file that cannot be read', async () => {
    render(<ImportVocabularyModal onImported={vi.fn()} onClose={vi.fn()} />)
    const file = screen.getByLabelText(/^File/)
    saysNothing(file)
    fireEvent.change(file, { target: { files: [fileOf('not json', 'kpis.json')] } })
    await screen.findByRole('alert')
    saysWhy(file, /./, { hint: 'Only its ConceptDescriptions with IEC 61360 content are taken.' })
  })

  it('the time control’s custom range, both ends', () => {
    const REASON = 'This page shows 7 days at most.'
    const ranges = TIME_PRESETS
    render(<TimeWindowControl value={rollingWindow(ranges[0].value, ranges)} onChange={vi.fn()} ranges={ranges} limit={{ maxSpanMs: 7 * 864e5, reason: REASON }} />)
    fireEvent.click(screen.getByRole('group', { name: 'Time window' }).querySelector('.time-window-pick'))
    const from = screen.getByLabelText('From')
    const to = screen.getByLabelText('To')
    saysNothing(from)
    type(from, '2026-09-01T00:00')
    type(to, '2026-11-01T00:00')
    for (const control of [from, to]) saysWhy(control, REASON)
    type(to, '2026-09-02T00:00')
    for (const control of [from, to]) saysNothing(control)
  })

  it('a cell’s place, refused beside the words that say where it is now', () => {
    const area = { area_id: 'a', area_name: 'Shop', plan_path: null, plan_aspect: null, cells: [] }
    const others = [{ cell_id: 'press', cell_name: 'Press', area_id: 'a', plan_x: 0.5, plan_y: 0.5 }]
    const onChange = vi.fn()
    render(<CellPlacementPicker area={area} cells={others} cellId="new" value={{ x: 0.1, y: 0.1 }} onChange={onChange} minSpacing={0.08} />)
    const plan = document.querySelector('.area-plan')
    plan.querySelector('.area-plan-drawing').getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300 })
    fireEvent.click(plan, { clientX: 204, clientY: 150 })
    expect(onChange).not.toHaveBeenCalled()
    const error = screen.getByRole('alert')
    expect(error).toHaveTextContent("Too close to 'Press'")
    expect(error).toHaveClass('form-hint', 'hint-danger')
    expect(screen.getByText(/Placed 10% across, 10% down\. Click the plan where the cell is\./)).toBeInTheDocument()
  })
})
