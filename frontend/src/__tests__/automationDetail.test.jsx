import React from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { diagnosticCount } from '@codemirror/lint'
import { AutomationsTab } from '../components/tabs/AutomationsTab'
import { AUTOMATION_EXAMPLE, AUTOMATION_WRITE_TITLE } from '../utils/automations'
import { PERMISSION_UUIDS } from '../constants'
import { api } from '../api'
import { tooltipOf } from '../test/tooltips'

/**
 * One automation: its YAML in the editor, rendered from the database with a comment beside each
 * device id; Save checks the text and shows what it would do before it changes anything; Delete
 * asks; Enable and Disable act at once; the recent firings with their labels and values; a link to
 * its history in the Audit Trail; a new automation starts from the example; and for a role that may
 * not write the editor is read-only and no control would be refused.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: {
      readAutomations: vi.fn(),
      automationsDocument: vi.fn(),
      automationRow: vi.fn(),
      readAutomationAlerts: vi.fn(),
      applyAutomations: vi.fn(),
      setAutomationEnabled: vi.fn(),
      deleteAutomation: vi.fn(),
      get: vi.fn(),
    },
  }
})

const download = vi.hoisted(() => ({ blobs: [] }))
vi.mock('../utils/downloadBlob', () => ({ downloadBlob: (blob, name) => download.blobs.push({ blob, name }) }))

beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }
  Range.prototype.getBoundingClientRect = () => rect
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} })
})

const LATHE = '3f1c9a6e-2b4d-4e8a-9c71-5d0e8f2a4b13'
const TRIGGER = 'aaaaaaaa-0000-4000-8000-000000000001'
const NOW = new Date('2026-11-09T12:00:00Z').getTime()

const stored = {
  id: 'lathe-3-spindle-hot', alias: 'Lathe 3 spindle bearing hot', description: 'Check the coolant.', enabled: true,
  triggers: [{ trigger: 'threshold', device: LATHE, metric: 'Spindle/BEARING_TEMPERATURE', above: 80, for: '5m' }],
  actions: [{ action: 'alert', severity: 'warning' }],
}
const devices = { [LATHE]: { name: 'Lathe 3', place: 'Cell 2 · Machining' } }
const rendered = [
  '- id: lathe-3-spindle-hot',
  '  alias: Lathe 3 spindle bearing hot',
  '  description: Check the coolant.',
  '  enabled: true',
  '  triggers:',
  '    - trigger: threshold',
  `      device: ${LATHE} # Lathe 3 · Cell 2 · Machining`,
  '      metric: Spindle/BEARING_TEMPERATURE',
  '      above: 80',
  '      for: 5m',
  '  actions:',
  '    - action: alert',
  '      severity: warning',
  '',
].join('\n')

const firings = {
  active: [{ id: 'f2', fingerprint: `condition:${TRIGGER}:${LATHE}:Spindle/BEARING_TEMPERATURE`, severity: 'warning', starts_at: '2026-11-09T11:00:00Z' }],
  history: [
    {
      id: 'f2', fingerprint: `condition:${TRIGGER}:${LATHE}:Spindle/BEARING_TEMPERATURE`, status: 'firing', ends_at: null,
      starts_at: '2026-11-09T11:00:00Z', entity_id: LATHE, sparkplug_id: 'devlathe', severity: 'warning',
      labels: { severity: 'warning', metric: 'Spindle/BEARING_TEMPERATURE' }, values: { value: 83.5, threshold: 80 },
    },
    {
      id: 'f1', fingerprint: `condition:${TRIGGER}:${LATHE}:Spindle/BEARING_TEMPERATURE`, status: 'resolved',
      starts_at: '2026-11-08T08:00:00Z', ends_at: '2026-11-08T08:30:00Z', entity_id: LATHE, sparkplug_id: 'devlathe', severity: 'warning',
      labels: { severity: 'warning' }, values: { value: 81, threshold: 80 },
    },
    // Another automation's alert: not this one's firing.
    {
      id: 'f9', fingerprint: `condition:bbbbbbbb-0000-4000-8000-000000000002:${LATHE}:Press/CYCLE_TIME`, status: 'resolved',
      starts_at: '2026-11-08T07:00:00Z', ends_at: '2026-11-08T07:30:00Z', entity_id: LATHE, severity: 'critical', labels: {}, values: {},
    },
  ],
}

const show = async ({ role = 'Shopfloor_Manager', toast = vi.fn(), url = '/automations/lathe-3-spindle-hot', permitted = () => true } = {}) => {
  window.history.replaceState(null, '', url)
  await act(async () => { render(<AutomationsTab showToast={toast} userRole={role} hasPermission={permitted} />) })
  return toast
}

const editorView = () => EditorView.findFromDOM(document.querySelector('.automation-editor').shadowRoot.querySelector('.cm-editor'))
const editorText = () => editorView().state.doc.toString()
/** Replaces the editor's whole text, as typing would. */
const type = (text) => act(() => { const v = editorView(); v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } }) })
const dialog = () => within(document.querySelector('dialog[open]'))

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  download.blobs.length = 0
  api.automationsDocument.mockResolvedValue({ automations: [stored], devices })
  api.automationRow.mockResolvedValue({ id: 'row-1', key: stored.id, automation_triggers: [{ id: TRIGGER, is_archived: false }] })
  api.readAutomationAlerts.mockResolvedValue(firings)
  api.get.mockResolvedValue([])
  api.readAutomations.mockResolvedValue({ automations: [], devices: {}, rows: [], active: [], history: [] })
  api.setAutomationEnabled.mockResolvedValue({})
  api.deleteAutomation.mockResolvedValue(undefined)
})
afterEach(() => { vi.useRealTimers() })

describe('one automation', () => {
  it("shows its YAML as the database renders it, with the device's name and place beside its id", async () => {
    await show()
    expect(api.automationsDocument).toHaveBeenCalledWith(['lathe-3-spindle-hot'])
    expect(editorText()).toBe(rendered)
    expect(screen.getByRole('heading', { name: 'Lathe 3 spindle bearing hot' })).toBeInTheDocument()
    expect(document.querySelector('.automation-head')).toHaveTextContent('Enabled')
  })

  it('says in one line that comments are not kept, and where words go', async () => {
    await show()
    const note = screen.getByText(/Comments you type here are not kept/)
    expect(note).toHaveTextContent('put words in description:')
    expect(note).toHaveTextContent('written again every time this opens')
  })

  it("gives the line to paste in VS Code, pointing at this site's schema", async () => {
    await show()
    expect(screen.getByText(/In VS Code, start your own file with this line/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /schema line/ })).toBeInTheDocument()
    const line = `# yaml-language-server: $schema=${window.location.origin}/json-schema/automations.schema.json`
    expect(document.querySelector('.automation-schema-line')).toHaveTextContent(line.slice(0, 30))
  })

  it('lists its recent firings with their labels and values, and leaves out another automation\'s', async () => {
    await show()
    const table = screen.getByRole('table', { name: /most recent times this automation raised an alert/ })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Lathe 3')
    expect(rows[0]).toHaveTextContent('Spindle/BEARING_TEMPERATURE')
    expect(rows[0]).toHaveTextContent('Firing · 1 h so far')
    expect(rows[0]).toHaveTextContent('severity=warning, metric=Spindle/BEARING_TEMPERATURE')
    expect(rows[0]).toHaveTextContent('value=83.5, threshold=80')
    expect(rows[1]).toHaveTextContent('Ended · 30 min')
    expect(within(rows[0]).getByRole('link', { name: 'Lathe 3' })).toHaveAttribute('href', `/devices?search=${LATHE}`)
    // The firing one is said in the heading's badge too.
    expect(document.querySelector('.automation-head')).toHaveTextContent('1 firing now')
  })

  it('says when it has not fired yet', async () => {
    api.readAutomationAlerts.mockResolvedValue({ active: [], history: [] })
    await show()
    expect(screen.getByText('This automation has not fired yet.')).toBeInTheDocument()
  })

  it('links to its history in the Audit Trail by its own id, for a reader of the Audit Trail', async () => {
    await show()
    expect(screen.getByRole('link', { name: /View Audit Trail/ })).toHaveAttribute('href', '/audit-trail?search=row-1&type=AUTOMATION')
  })

  it('leaves the Audit Trail link out for a role that cannot open it', async () => {
    await show({ permitted: (p) => p !== PERMISSION_UUIDS.AUDIT_TRAIL_READ })
    expect(screen.queryByRole('link', { name: /View Audit Trail/ })).toBeNull()
  })

  it('says so, with a way back, when no automation has the id', async () => {
    api.automationsDocument.mockResolvedValue({ automations: [], devices: {} })
    await show({ url: '/automations/gone' })
    expect(await screen.findByText(/No automation has the id/)).toHaveTextContent('gone')
    expect(screen.getByRole('link', { name: /Automations/ })).toHaveAttribute('href', '/automations')
  })

  it('opens an automation whose id is `new` with ?open=1, where /automations/new is the starter', async () => {
    api.automationsDocument.mockResolvedValue({ automations: [{ ...stored, id: 'new' }], devices })
    api.automationRow.mockResolvedValue({ id: 'row-new', key: 'new', automation_triggers: [] })
    await show({ url: '/automations/new?open=1' })
    expect(api.automationsDocument).toHaveBeenCalledWith(['new'])
    expect(editorText()).toContain('- id: new')
  })
})

describe('a new automation', () => {
  it('starts from the example in the reference, and reads nothing from the database for it', async () => {
    await show({ url: '/automations/new' })
    expect(editorText()).toBe(AUTOMATION_EXAMPLE)
    expect(api.automationsDocument).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'New automation' })).toBeInTheDocument()
    expect(screen.getByText(/Starts from the example in the reference/)).toBeInTheDocument()
    // Nothing to enable, export or delete yet, and nothing to wait for before saving it.
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Disable' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull()
    expect(screen.getByRole('button', { name: /Save/ })).toBeEnabled()
  })
})

describe('Save', () => {
  it('is off until something is edited', async () => {
    await show()
    const save = screen.getByRole('button', { name: /Save/ })
    expect(save).toBeDisabled()
    expect(tooltipOf(save)).toBe('Nothing has changed since this was read')
    type(rendered.replace('above: 80', 'above: 90'))
    expect(screen.getByRole('button', { name: /Save/ })).toBeEnabled()
    type(rendered)
    expect(screen.getByRole('button', { name: /Save/ })).toBeDisabled()
  })

  it('checks the text with the database first and shows what it would do, before anything is written', async () => {
    api.applyAutomations.mockResolvedValue([{ index: 0, key: stored.id, status: 'changed', id: 'row-1', changes: ['triggers'], reasons: [] }])
    await show()
    type(rendered.replace('above: 80', 'above: 90'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save/ })) })
    // The JSON the YAML parses to, as a dry run.
    expect(api.applyAutomations).toHaveBeenCalledTimes(1)
    const [doc, dryRun] = api.applyAutomations.mock.calls[0]
    expect(dryRun).toBe(true)
    expect(doc).toEqual([{ ...stored, triggers: [{ ...stored.triggers[0], above: 90 }] }].map(a => ({ id: a.id, alias: a.alias, description: a.description, enabled: true, triggers: a.triggers, actions: a.actions })))
    const d = dialog()
    expect(d.getByText('1 changed')).toBeInTheDocument()
    expect(d.getByText('changes triggers')).toBeInTheDocument()
    // The confirm repeats the act and the count.
    expect(d.getByRole('button', { name: 'Save 1 Automation' })).toBeEnabled()
  })

  it('applies it, with false, only when confirmed, and ends with a toast that links to the automation', async () => {
    api.applyAutomations.mockResolvedValue([{ index: 0, key: stored.id, status: 'changed', id: 'row-1', changes: ['triggers'], reasons: [] }])
    const toast = await show()
    type(rendered.replace('above: 80', 'above: 90'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save/ })) })
    await act(async () => { fireEvent.click(dialog().getByRole('button', { name: 'Save 1 Automation' })) })
    expect(api.applyAutomations).toHaveBeenCalledTimes(2)
    expect(api.applyAutomations.mock.calls[1][1]).toBe(false)
    expect(toast).toHaveBeenCalledWith("Automation 'lathe-3-spindle-hot' changed", 'success', { to: '/automations/lathe-3-spindle-hot' })
    // Read again, so the editor shows what the database now renders.
    expect(api.automationsDocument).toHaveBeenCalledTimes(2)
    expect(document.querySelector('dialog')).toBeNull()
  })

  it('writes nothing when cancelled', async () => {
    api.applyAutomations.mockResolvedValue([{ index: 0, key: stored.id, status: 'changed', changes: ['triggers'], reasons: [] }])
    await show()
    type(rendered.replace('above: 80', 'above: 90'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save/ })) })
    fireEvent.click(dialog().getByRole('button', { name: 'Cancel' }))
    expect(api.applyAutomations).toHaveBeenCalledTimes(1)
    expect(editorText()).toContain('above: 90')
  })

  it('shows every reason of a refusal on its line, holds the confirm, and marks the lines in the editor', async () => {
    api.applyAutomations.mockResolvedValue([{
      index: 0, key: stored.id, status: 'refused', id: null, changes: [],
      reasons: [
        { path: '$[0].triggers[0].above', message: '`above` is a number.' },
        { path: '$[0].triggers[0].device', message: 'No device has the id 3f1c9a6e-2b4d-4e8a-9c71-5d0e8f2a4b13.' },
      ],
    }])
    await show()
    type(rendered.replace('above: 80', 'above: hot'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save/ })) })
    const d = dialog()
    expect(d.getByText('1 refused')).toBeInTheDocument()
    expect(d.getByText('Line 9')).toBeInTheDocument()
    expect(d.getByText('`above` is a number.')).toBeInTheDocument()
    expect(d.getByText('Line 7')).toBeInTheDocument()
    // Why it cannot go ahead, said above the buttons; the confirm looks refused.
    expect(document.querySelector('.modal-problem')).toHaveTextContent('1 automation refused. Fix the lines named below, then try again.')
    const confirm = d.getByRole('button', { name: 'Save 0 Automations' })
    expect(confirm).toBeDisabled()
    expect(confirm).toHaveClass('btn-disabled')
    // Closing it leaves the marks on the lines the refusal named.
    fireEvent.click(d.getByRole('button', { name: 'Cancel' }))
    await act(async () => { await new Promise(r => setTimeout(r, 400)) })
    expect(diagnosticCount(editorView().state)).toBe(2)
    expect(api.applyAutomations).toHaveBeenCalledTimes(1)
  })

  it('names the line of a syntax error without asking the database', async () => {
    await show()
    type('- id: a\n  alias: one\n  alias: two\n')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save/ })) })
    const d = dialog()
    expect(d.getByText('Line 3')).toBeInTheDocument()
    expect(d.getByText('Map keys must be unique')).toBeInTheDocument()
    expect(document.querySelector('.modal-problem')).toHaveTextContent('The file is not YAML the page can read')
    expect(api.applyAutomations).not.toHaveBeenCalled()
    expect(d.getByRole('button', { name: /^Save 0 Automations$/ })).toBeDisabled()
  })

  it('says an empty text cannot be saved', async () => {
    await show({ url: '/automations/new' })
    type('# nothing yet\n')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save/ })) })
    expect(document.querySelector('.modal-problem')).toHaveTextContent('The file is empty')
    expect(api.applyAutomations).not.toHaveBeenCalled()
  })

  it('shows what the database refused at the second call, as it worded it, and stays open', async () => {
    api.applyAutomations
      .mockResolvedValueOnce([{ index: 0, key: stored.id, status: 'changed', changes: ['triggers'], reasons: [] }])
      .mockRejectedValueOnce(new Error('A second factor is required to change the platform. Add one on your Profile.'))
    await show()
    type(rendered.replace('above: 80', 'above: 90'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save/ })) })
    await act(async () => { fireEvent.click(dialog().getByRole('button', { name: 'Save 1 Automation' })) })
    expect(document.querySelector('.modal-error')).toHaveTextContent('A second factor is required to change the platform.')
    expect(document.querySelector('dialog[open]')).not.toBeNull()
  })

  it('says nothing would change when every automation is as it was, and holds the confirm without a red note', async () => {
    api.applyAutomations.mockResolvedValue([{ index: 0, key: stored.id, status: 'unchanged', changes: [], reasons: [] }])
    await show()
    type(`${rendered}\n`)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save/ })) })
    const d = dialog()
    expect(d.getByText(/Nothing would change/)).toBeInTheDocument()
    expect(d.getByRole('button', { name: 'Save 0 Automations' })).toBeDisabled()
    expect(document.querySelector('.modal-problem')).toHaveTextContent('')
  })

  it('moves to the automation saved under a new id, which is a new one, and leaves the old one as it was', async () => {
    api.applyAutomations.mockResolvedValue([{ index: 0, key: 'lathe-4', status: 'new', id: 'row-2', changes: [], reasons: [] }])
    const toast = await show()
    type(rendered.replace('id: lathe-3-spindle-hot', 'id: lathe-4'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save/ })) })
    expect(dialog().getByText('New')).toBeInTheDocument()
    await act(async () => { fireEvent.click(dialog().getByRole('button', { name: 'Save 1 Automation' })) })
    expect(toast).toHaveBeenCalledWith("Automation 'lathe-4' created", 'success', { to: '/automations/lathe-4' })
    expect(window.location.pathname).toBe('/automations/lathe-4')
  })

  it('saves a new automation, and opens it', async () => {
    api.applyAutomations.mockResolvedValue([{ index: 0, key: 'lathe-3-spindle-hot', status: 'new', id: 'row-1', changes: [], reasons: [] }])
    const toast = await show({ url: '/automations/new' })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save/ })) })
    await act(async () => { fireEvent.click(dialog().getByRole('button', { name: 'Save 1 Automation' })) })
    expect(toast).toHaveBeenCalledWith("Automation 'lathe-3-spindle-hot' created", 'success', { to: '/automations/lathe-3-spindle-hot' })
    expect(window.location.pathname).toBe('/automations/lathe-3-spindle-hot')
  })
})

describe('Delete', () => {
  it('asks first, naming the automation, and the confirm repeats the act', async () => {
    await show()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    const d = dialog()
    expect(d.getByText('Lathe 3 spindle bearing hot', { selector: 'strong' })).toBeInTheDocument()
    expect(d.getByText(/open alerts resolve/)).toBeInTheDocument()
    expect(api.deleteAutomation).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(d.getByRole('button', { name: 'Delete Automation' })) })
    expect(api.deleteAutomation).toHaveBeenCalledWith('lathe-3-spindle-hot')
  })

  it('ends with a toast and the list, where the automation is no longer', async () => {
    const toast = await show()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await act(async () => { fireEvent.click(dialog().getByRole('button', { name: 'Delete Automation' })) })
    expect(toast).toHaveBeenCalledWith("Automation 'Lathe 3 spindle bearing hot' deleted", 'success', { to: '/automations' })
    expect(window.location.pathname).toBe('/automations')
  })

  it('keeps the dialog open with the refusal when the database refuses', async () => {
    api.deleteAutomation.mockRejectedValue(new Error('Only a Shopfloor Manager or an Administrator may delete an automation.'))
    await show()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await act(async () => { fireEvent.click(dialog().getByRole('button', { name: 'Delete Automation' })) })
    expect(document.querySelector('.modal-error')).toHaveTextContent('Only a Shopfloor Manager or an Administrator may delete an automation.')
    expect(window.location.pathname).toBe('/automations/lathe-3-spindle-hot')
  })

  it('can be cancelled', async () => {
    await show()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(dialog().getByRole('button', { name: 'Cancel' }))
    expect(api.deleteAutomation).not.toHaveBeenCalled()
  })
})

describe('Disable, Enable and Export', () => {
  it('disables at once, with a toast that links to it, and reads it again', async () => {
    const toast = await show()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Disable' })) })
    expect(api.setAutomationEnabled).toHaveBeenCalledWith('lathe-3-spindle-hot', false)
    expect(toast).toHaveBeenCalledWith("Automation 'Lathe 3 spindle bearing hot' disabled", 'success', { to: '/automations/lathe-3-spindle-hot' })
    expect(api.automationsDocument).toHaveBeenCalledTimes(2)
  })

  it('offers Enable for a disabled one', async () => {
    api.automationsDocument.mockResolvedValue({ automations: [{ ...stored, enabled: false }], devices })
    const toast = await show()
    expect(document.querySelector('.automation-head')).toHaveTextContent('Disabled')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Enable' })) })
    expect(api.setAutomationEnabled).toHaveBeenCalledWith('lathe-3-spindle-hot', true)
    expect(toast).toHaveBeenCalledWith("Automation 'Lathe 3 spindle bearing hot' enabled", 'success', { to: '/automations/lathe-3-spindle-hot' })
  })

  it('keeps what was typed when the switch is turned', async () => {
    await show()
    type(rendered.replace('above: 80', 'above: 90'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Disable' })) })
    expect(editorText()).toContain('above: 90')
  })

  it('exports this automation alone, as automations.yaml', async () => {
    const toast = await show()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Export' })) })
    expect(api.automationsDocument).toHaveBeenLastCalledWith(['lathe-3-spindle-hot'])
    expect(download.blobs[0].name).toBe('automations.yaml')
    expect(await download.blobs[0].blob.text()).toBe(rendered)
    expect(toast).toHaveBeenCalledWith('Exported 1 automation to automations.yaml', 'success')
  })
})

describe('for a role that may not write', () => {
  it('shows the YAML to read, with Save, Delete and Disable off and saying who may', async () => {
    await show({ role: 'Operator' })
    expect(editorView().state.readOnly).toBe(true)
    for (const name of ['Disable', 'Delete', /Save/]) {
      const button = screen.getByRole('button', { name })
      expect(button).toBeDisabled()
      expect(button).toHaveClass('btn-disabled')
    }
    expect(tooltipOf(screen.getByRole('button', { name: 'Delete' }))).toBe(AUTOMATION_WRITE_TITLE)
    // A reader may still take it as a file.
    expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled()
  })

  it('lets a writer edit', async () => {
    await show({ role: 'Administrator' })
    expect(editorView().state.readOnly).toBe(false)
  })

  it('orders the toolbar: the way back, then Disable, Export, Delete, and Save last, each filled', async () => {
    await show()
    expect(document.querySelector('.filter-bar').firstElementChild).toHaveTextContent('Automations')
    const actions = [...document.querySelectorAll('.filter-bar-actions button')].map(b => b.textContent.trim())
    expect(actions).toEqual(['Disable', 'Export', 'Delete', 'Save'])
    for (const b of document.querySelectorAll('.filter-bar-actions button')) expect(b).toHaveClass('btn-primary')
  })
})

describe('Upload', () => {
  const file = (text, name = 'automations.yaml') => new File([text], name, { type: 'application/yaml' })
  const choose = async (f) => {
    const input = screen.getByTestId('automations-file')
    await act(async () => { fireEvent.change(input, { target: { files: [f] } }) })
  }
  const FILE_TEXT = [
    '- id: one', '  alias: One', '  triggers:', '    - trigger: threshold', `      device: ${LATHE}`, '      metric: Spindle/LOAD', '      above: 1',
    '  actions:', '    - action: alert', '      severity: info',
    '- id: two', '  alias: Two', '  triggers: []', '  enabled: false', '  actions:', '    - action: alert', '      severity: info',
    '- id: three', '  alias: Three', '',
  ].join('\n')
  const results = [
    { index: 0, key: 'one', status: 'new', id: null, changes: [], reasons: [] },
    { index: 1, key: 'two', status: 'changed', id: 'r2', changes: ['alias'], reasons: [] },
    { index: 2, key: 'three', status: 'unchanged', id: 'r3', changes: [], reasons: [] },
  ]

  it('parses the file in the browser and previews each automation as new, changed or unchanged', async () => {
    api.applyAutomations.mockResolvedValue(results)
    await show({ url: '/automations' })
    await choose(file(FILE_TEXT))
    expect(api.applyAutomations).toHaveBeenCalledTimes(1)
    expect(api.applyAutomations.mock.calls[0][1]).toBe(true)
    expect(api.applyAutomations.mock.calls[0][0].map(a => a.id)).toEqual(['one', 'two', 'three'])
    const d = dialog()
    expect(d.getByText('1 new, 1 changed, 1 unchanged')).toBeInTheDocument()
    expect(d.getByText('changes alias')).toBeInTheDocument()
    expect(d.getByRole('heading', { name: /Apply automations\.yaml/ })).toBeInTheDocument()
    // The confirm repeats the act and the count of what it writes.
    expect(d.getByRole('button', { name: 'Apply 2 Automations' })).toBeEnabled()
  })

  it('says it deletes nothing, and that it is all or none', async () => {
    api.applyAutomations.mockResolvedValue(results)
    await show({ url: '/automations' })
    await choose(file(FILE_TEXT))
    expect(document.querySelector('.modal-lead')).toHaveTextContent('all of it or none')
    expect(document.querySelector('.modal-lead')).toHaveTextContent('deletes nothing')
  })

  it('applies the whole file in one call with false, when confirmed, and ends with a toast', async () => {
    api.applyAutomations.mockResolvedValue(results)
    const toast = await show({ url: '/automations' })
    await choose(file(FILE_TEXT))
    await act(async () => { fireEvent.click(dialog().getByRole('button', { name: 'Apply 2 Automations' })) })
    expect(api.applyAutomations).toHaveBeenCalledTimes(2)
    expect(api.applyAutomations.mock.calls[1][1]).toBe(false)
    expect(toast).toHaveBeenCalledWith('Applied 2 automations from automations.yaml (1 new, 1 changed)', 'success', { to: '/automations' })
    expect(document.querySelector('dialog')).toBeNull()
    // The list is read again.
    expect(api.readAutomations.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('links the toast to the automation when the file wrote just one', async () => {
    api.applyAutomations.mockResolvedValue([results[0]])
    const toast = await show({ url: '/automations' })
    await choose(file(FILE_TEXT))
    await act(async () => { fireEvent.click(dialog().getByRole('button', { name: 'Apply 1 Automation' })) })
    expect(toast).toHaveBeenCalledWith("Automation 'one' created from automations.yaml", 'success', { to: '/automations/one' })
  })

  it('lists a bad trigger with every reason and its line, and applies nothing', async () => {
    api.applyAutomations.mockResolvedValue([
      results[0],
      {
        index: 1, key: 'two', status: 'refused', id: null, changes: [],
        reasons: [{ path: '$[1].triggers', message: '`triggers` is the list of what starts the automation.' }, { path: '$[1].enabled', message: '`enabled` is true or false.' }],
      },
    ])
    await show({ url: '/automations' })
    await choose(file(FILE_TEXT))
    const d = dialog()
    // Refusals first, the line each is on, and the file's own words for why.
    const heads = [...document.querySelectorAll('.apply-result-head')].map(h => h.textContent)
    expect(heads[0]).toMatch(/^Refused/)
    expect(heads[1]).toMatch(/^New/)
    expect(d.getByText('Line 13')).toBeInTheDocument()
    expect(d.getByText('Line 14')).toBeInTheDocument()
    expect(d.getByText('`enabled` is true or false.')).toBeInTheDocument()
    expect(document.querySelector('.modal-problem')).toHaveTextContent('1 automation refused')
    expect(d.getByRole('button', { name: 'Apply 1 Automation' })).toBeDisabled()
    expect(api.applyAutomations).toHaveBeenCalledTimes(1)
  })

  it('names the line of a syntax error in the file without asking the database', async () => {
    await show({ url: '/automations' })
    await choose(file('- id: a\n  alias: one\n  alias: two\n'))
    expect(dialog().getByText('Line 3')).toBeInTheDocument()
    expect(api.applyAutomations).not.toHaveBeenCalled()
  })

  it('refuses a file that is too large to be a file of automations', async () => {
    const toast = await show({ url: '/automations' })
    const big = file('x', 'big.yaml')
    Object.defineProperty(big, 'size', { value: 3 * 1024 * 1024 })
    await choose(big)
    expect(toast).toHaveBeenCalledWith('big.yaml is larger than 2 MiB, more than a file of automations holds', 'error')
    expect(document.querySelector('dialog')).toBeNull()
  })

  it('offers Upload to a writer through the toolbar button, which opens the file chooser', async () => {
    await show({ url: '/automations' })
    const input = screen.getByTestId('automations-file')
    const click = vi.spyOn(input, 'click')
    fireEvent.click(screen.getByRole('button', { name: /Upload/ }))
    expect(click).toHaveBeenCalled()
    expect(input).toHaveAttribute('accept', expect.stringContaining('.yaml'))
  })
})
