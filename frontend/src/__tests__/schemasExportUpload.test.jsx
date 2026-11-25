import React from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SchemasTab } from '../components/tabs/SchemasTab'
import { api } from '../api'
import { requiresRolesTitle } from '../hooks/usePermissions'
import { PERMISSION_UUIDS } from '../constants'
import { schemaUrl } from '../routes'
import { tooltipOf } from '../test/tooltips'
import { pressHeld } from '../test/dialogs'

/**
 * Export and Upload on the Schemas list. Export saves the schemas ticked, or every schema in force with
 * none ticked ("Export (2)"), as device-schemas.yaml, one export for a schema in place of Download
 * JSON; Upload reads a file in the browser, shows what each schema would become line by line, applies
 * it only when confirmed, and ends in a toast that links to what it made.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), deviceSchemasDocument: vi.fn(), applyDeviceSchemas: vi.fn() },
  }
})

const download = vi.hoisted(() => ({ blobs: [] }))
vi.mock('../utils/downloadBlob', () => ({ downloadBlob: (blob, name) => download.blobs.push({ blob, name }) }))

const ARM = {
  schema_uuid: 'arm-uuid', schema_name: 'Robot_Arm_Schema', version: 1, status: 'active', parent_schema_id: null,
  change_description: 'Initial release', schema_definition: { type: 'object', properties: { 'Spindle/LOAD': { type: 'number' } } },
}
const CONVEYOR = {
  schema_uuid: 'conveyor-uuid', schema_name: 'Conveyor_Schema', version: 1, status: 'active', parent_schema_id: null,
  change_description: 'Initial release', schema_definition: { type: 'object', properties: { 'Belt/SPEED': { type: 'number' } } },
}
const ARM_V2 = {
  ...ARM, schema_uuid: 'arm-v2-uuid', schema_name: 'Robot_Arm_Schema_v2', version: 2, status: 'draft', parent_schema_id: 'arm-uuid',
}
let schemaRows = []

const documentOf = (names) => names.map(name => ({ name, metrics: [{ name: 'Spindle/LOAD', minimum: 0 }] }))

const showToast = vi.fn()
const renderTab = (canManage = true) => render(
  <SchemasTab showToast={showToast} hasPermission={() => canManage} onSelectSchema={vi.fn()} />
)
const ready = () => waitFor(() => expect(screen.getByRole('checkbox', { name: 'Select Robot_Arm_Schema' })).toBeTruthy())
const dialog = () => within(document.querySelector('dialog[open]'))
const toolbar = () => document.querySelector('.filter-bar-actions')

beforeEach(() => {
  vi.clearAllMocks()
  download.blobs.length = 0
  schemaRows = [ARM, CONVEYOR]
  api.get.mockImplementation((path) => Promise.resolve(path.startsWith('/api/v1/schemas') ? schemaRows : []))
  api.deviceSchemasDocument.mockResolvedValue(documentOf(['Conveyor_Schema', 'Robot_Arm_Schema']))
})

describe('Export', () => {
  it('has Upload, Export and the builder in the toolbar, filled, as the Automations page has them', async () => {
    renderTab()
    await ready()
    const buttons = [...toolbar().querySelectorAll('button')].filter(b => b.textContent.trim())
    expect(buttons.map(b => b.textContent.trim())).toEqual(['Upload', 'Export', 'Build Schema from Catalog'])
    for (const b of buttons) expect(b).toHaveClass('btn-primary')
  })

  it('exports every schema in force when none is ticked, as device-schemas.yaml, and says so', async () => {
    renderTab()
    await ready()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Export$/ })) })
    expect(api.deviceSchemasDocument).toHaveBeenCalledWith(null)
    expect(download.blobs).toHaveLength(1)
    expect(download.blobs[0].name).toBe('device-schemas.yaml')
    const text = await download.blobs[0].blob.text()
    expect(text).toBe('- name: Conveyor_Schema\n  metrics:\n    - name: Spindle/LOAD\n      minimum: 0\n- name: Robot_Arm_Schema\n  metrics:\n    - name: Spindle/LOAD\n      minimum: 0\n')
    expect(showToast).toHaveBeenCalledWith('Exported 2 schemas to device-schemas.yaml', 'success')
  })

  it('counts the schemas ticked, "Export (2)", and exports those', async () => {
    renderTab()
    await ready()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Robot_Arm_Schema' }))
    expect(screen.getByRole('button', { name: 'Export (1)' })).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Conveyor_Schema' }))
    const button = screen.getByRole('button', { name: 'Export (2)' })
    expect(tooltipOf(button)).toBe('Download the 2 schemas you ticked, as they are in force, as device-schemas.yaml')
    await act(async () => { fireEvent.click(button) })
    expect(api.deviceSchemasDocument).toHaveBeenCalledWith(['arm-uuid', 'conveyor-uuid'])
    // Unticking goes back to every schema.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Robot_Arm_Schema' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Conveyor_Schema' }))
    expect(screen.getByRole('button', { name: /^Export$/ })).toBeTruthy()
  })

  it('ticking a row does not open its drawer', async () => {
    renderTab()
    await ready()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Robot_Arm_Schema' }))
    expect(document.querySelector('.context-panel')?.classList.contains('open') ?? false).toBe(false)
  })

  it('has a box in the header that ticks every row shown, and clears them, and a mark for some', async () => {
    renderTab()
    await ready()
    const head = screen.getByRole('checkbox', { name: 'Select every schema shown' })
    fireEvent.click(head)
    expect(screen.getByRole('button', { name: 'Export (2)' })).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Conveyor_Schema' }))
    expect(head.indeterminate).toBe(true)
    fireEvent.click(head)
    expect(screen.getByRole('button', { name: 'Export (2)' })).toBeTruthy()
    fireEvent.click(head)
    expect(screen.getByRole('button', { name: /^Export$/ })).toBeTruthy()
  })

  it('exports one schema from its drawer, in place of Download JSON, whichever version is open', async () => {
    schemaRows = [ARM, ARM_V2]
    renderTab()
    await ready()
    fireEvent.click(within(document.querySelector('tbody')).getByText('Robot_Arm_Schema_v2'))
    const panel = within(document.querySelector('.context-panel'))
    expect(panel.queryByText('Download JSON')).toBeNull()
    await act(async () => { fireEvent.click(panel.getByText('Export YAML')) })
    expect(api.deviceSchemasDocument).toHaveBeenCalledWith(['arm-v2-uuid'])
    expect(download.blobs[0].name).toBe('device-schemas.yaml')
  })

  it('says so when no schema is in force to export, and writes no file', async () => {
    api.deviceSchemasDocument.mockResolvedValue([])
    renderTab()
    await ready()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Export$/ })) })
    expect(download.blobs).toHaveLength(0)
    expect(showToast).toHaveBeenCalledWith('There is no schema in force to export. A draft is exported once it is published', 'error')
  })

  it('says why it could not, when the read is refused', async () => {
    api.deviceSchemasDocument.mockRejectedValue(new Error('The schemas could not be read'))
    renderTab()
    await ready()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Export$/ })) })
    expect(showToast).toHaveBeenCalledWith('The schemas could not be read', 'error')
  })

  it('is open to every role, where Upload is greyed for a role that may not manage schemas', async () => {
    renderTab(false)
    await ready()
    expect(screen.getByRole('button', { name: /^Export$/ })).toBeEnabled()
    const upload = screen.getByRole('button', { name: /Upload/ })
    expect(upload).toBeDisabled()
    expect(tooltipOf(upload)).toBe(requiresRolesTitle(PERMISSION_UUIDS.SCHEMA_MANAGE))
  })
})

describe('Upload', () => {
  const file = (text, name = 'device-schemas.yaml') => new File([text], name, { type: 'application/yaml' })
  const choose = async (f) => {
    await act(async () => { fireEvent.change(screen.getByTestId('schemas-file'), { target: { files: [f] } }) })
  }
  const FILE_TEXT = [
    '- name: Robot_Arm_Schema', '  metrics:', '    - name: Spindle/LOAD', '      minimum: 0',
    '- name: Conveyor_Schema', '  metrics:', '    - name: Belt/SPEED',
    '- name: Press_Schema', '  metrics:', '    - name: Press/FORCE', '',
  ].join('\n')
  const results = [
    { index: 0, name: 'Robot_Arm_Schema', status: 'changed', id: null, version: 2, schema_name: 'Robot_Arm_Schema_v2', changes: ['description', 'metrics'],
      metrics: { added: ['Spindle/LOAD'], removed: ['Belt/OLD'], changed: ['Spindle/TEMPERATURE'] }, reasons: [] },
    { index: 1, name: 'Conveyor_Schema', status: 'unchanged', id: 'conveyor-uuid', version: 1, schema_name: 'Conveyor_Schema', changes: [], metrics: null, reasons: [] },
    { index: 2, name: 'Press_Schema', status: 'new', id: null, version: 1, schema_name: 'Press_Schema', changes: [], metrics: null, reasons: [] },
  ]

  it('parses the file in the browser and previews each schema as new, changed or unchanged, in words', async () => {
    api.applyDeviceSchemas.mockResolvedValue(results)
    renderTab()
    await ready()
    await choose(file(FILE_TEXT))
    expect(api.applyDeviceSchemas).toHaveBeenCalledTimes(1)
    expect(api.applyDeviceSchemas.mock.calls[0][1]).toBe(true)
    expect(api.applyDeviceSchemas.mock.calls[0][0].map(s => s.name)).toEqual(['Robot_Arm_Schema', 'Conveyor_Schema', 'Press_Schema'])
    const d = dialog()
    expect(d.getByRole('heading', { name: /Apply device-schemas\.yaml/ })).toBeInTheDocument()
    expect(d.getByText('1 new, 1 changed, 1 unchanged')).toBeInTheDocument()
    expect(d.getByText('version 1, in force')).toBeInTheDocument()
    expect(d.getByText('a new draft, v2 (Robot_Arm_Schema_v2): adds Spindle/LOAD; removes Belt/OLD; changes the range of Spindle/TEMPERATURE; changes the description')).toBeInTheDocument()
    // The confirm repeats the act and the count of what it writes.
    expect(d.getByRole('button', { name: 'Apply 2 Schemas' })).toBeEnabled()
  })

  it('says it deletes nothing, never edits a published version, and is all or none', async () => {
    api.applyDeviceSchemas.mockResolvedValue(results)
    renderTab()
    await ready()
    await choose(file(FILE_TEXT))
    const lead = document.querySelector('.modal-lead')
    expect(lead).toHaveTextContent('all of it or none')
    expect(lead).toHaveTextContent('never edited')
    expect(lead).toHaveTextContent('new draft version')
    expect(lead).toHaveTextContent('deletes nothing')
  })

  it('applies the whole file in one call with false, when confirmed, and ends with a toast that opens the list', async () => {
    api.applyDeviceSchemas.mockResolvedValue(results)
    renderTab()
    await ready()
    await choose(file(FILE_TEXT))
    const reads = api.get.mock.calls.length
    await act(async () => { fireEvent.click(dialog().getByRole('button', { name: 'Apply 2 Schemas' })) })
    expect(api.applyDeviceSchemas).toHaveBeenCalledTimes(2)
    expect(api.applyDeviceSchemas.mock.calls[1][1]).toBe(false)
    expect(showToast).toHaveBeenCalledWith('Applied 2 schemas from device-schemas.yaml (1 new, 1 new draft)', 'success', { to: '/schemas' })
    expect(document.querySelector('dialog')).toBeNull()
    // The list is read again, for the new schema and the new draft.
    expect(api.get.mock.calls.length).toBeGreaterThan(reads)
  })

  it('links the toast to the schema when the file wrote just one', async () => {
    const made = { ...results[2], id: 'press-uuid' }
    api.applyDeviceSchemas.mockResolvedValue([made])
    renderTab()
    await ready()
    await choose(file(FILE_TEXT))
    await act(async () => { fireEvent.click(dialog().getByRole('button', { name: 'Apply 1 Schema' })) })
    expect(showToast).toHaveBeenCalledWith("Schema 'Press_Schema' created from device-schemas.yaml", 'success', { to: schemaUrl('press-uuid') })
  })

  it('names a new draft by its version and links to it', async () => {
    api.applyDeviceSchemas.mockResolvedValue([{ ...results[0], id: 'draft-uuid' }])
    renderTab()
    await ready()
    await choose(file(FILE_TEXT))
    await act(async () => { fireEvent.click(dialog().getByRole('button', { name: 'Apply 1 Schema' })) })
    expect(showToast).toHaveBeenCalledWith("Draft v2 of 'Robot_Arm_Schema' created from device-schemas.yaml", 'success', { to: schemaUrl('draft-uuid') })
  })

  it('lists a refused schema with every reason and its line, and applies nothing', async () => {
    api.applyDeviceSchemas.mockResolvedValue([
      results[2],
      {
        index: 0, name: 'Robot_Arm_Schema', status: 'refused', id: null, version: null, schema_name: null, changes: [], metrics: null,
        reasons: [
          { path: '$[0].metrics[0].name', message: '`Spindle/LOAD` is not in the metric catalogue. Register it on the Metrics page first.' },
          { path: '$[0].metrics[0].minimum', message: 'The minimum is above the maximum.' },
        ],
      },
    ])
    renderTab()
    await ready()
    await choose(file(FILE_TEXT))
    const d = dialog()
    // Refusals first, the line each is on, and the database's own words for why.
    const heads = [...document.querySelectorAll('.apply-result-head')].map(h => h.textContent)
    expect(heads[0]).toMatch(/^Refused/)
    expect(heads[1]).toMatch(/^New/)
    expect(d.getByText('Line 3')).toBeInTheDocument()
    expect(d.getByText('Line 4')).toBeInTheDocument()
    expect(d.getByText('The minimum is above the maximum.')).toBeInTheDocument()
    expect(document.querySelector('.modal-problem')).toHaveTextContent('1 schema refused. Fix the lines named above, then try again.')
    expect(d.getByRole('button', { name: 'Apply 1 Schema' })).toBeDisabled()
    expect(api.applyDeviceSchemas).toHaveBeenCalledTimes(1)
  })

  it('shows a refusal the apply itself gives, as the database worded it, and toasts nothing', async () => {
    api.applyDeviceSchemas.mockResolvedValueOnce(results).mockRejectedValueOnce(new Error('A second factor is required: enrol one under Profile.'))
    renderTab()
    await ready()
    await choose(file(FILE_TEXT))
    await act(async () => { fireEvent.click(dialog().getByRole('button', { name: 'Apply 2 Schemas' })) })
    expect(dialog().getByText('A second factor is required: enrol one under Profile.')).toBeInTheDocument()
    expect(showToast).not.toHaveBeenCalled()
  })

  it('shows what another writer changed since the preview, when the apply refuses a schema', async () => {
    const refused = [{ index: 0, name: 'Robot_Arm_Schema', status: 'refused', reasons: [{ path: '$[0]', message: '`Robot_Arm_Schema` has a draft already. Publish or discard it.' }] }]
    api.applyDeviceSchemas.mockResolvedValueOnce(results).mockResolvedValueOnce(refused)
    renderTab()
    await ready()
    await choose(file(FILE_TEXT))
    await act(async () => { fireEvent.click(dialog().getByRole('button', { name: 'Apply 2 Schemas' })) })
    expect(dialog().getByText(/has a draft already/)).toBeInTheDocument()
    expect(showToast).not.toHaveBeenCalled()
    expect(document.querySelector('dialog')).not.toBeNull()
  })

  it('says nothing would change, and applies nothing, for a file that is what the site has', async () => {
    api.applyDeviceSchemas.mockResolvedValue([results[1]])
    renderTab()
    await ready()
    await choose(file(FILE_TEXT))
    const d = dialog()
    expect(d.getByText('Every schema here is already as the file says. Nothing would change.')).toBeInTheDocument()
    pressHeld(screen.getByRole('dialog'), 'Apply 0 Schemas', 'Nothing has changed.')
    expect(api.applyDeviceSchemas).toHaveBeenCalledTimes(1)
  })

  it('names the line of a syntax error in the file without asking the database', async () => {
    renderTab()
    await ready()
    await choose(file('- name: a\n  metrics: []\n  metrics: []\n'))
    expect(dialog().getByText('Line 3')).toBeInTheDocument()
    expect(api.applyDeviceSchemas).not.toHaveBeenCalled()
  })

  it('says an empty file is empty', async () => {
    renderTab()
    await ready()
    await choose(file(''))
    expect(document.querySelector('.modal-problem')).toHaveTextContent('The file is empty. Write at least one schema.')
    expect(api.applyDeviceSchemas).not.toHaveBeenCalled()
  })

  it('refuses a file that is too large to be a file of schemas', async () => {
    renderTab()
    await ready()
    const big = file('x', 'big.yaml')
    Object.defineProperty(big, 'size', { value: 9 * 1024 * 1024 })
    await choose(big)
    expect(showToast).toHaveBeenCalledWith('big.yaml is larger than 8 MiB, more than a file of schemas holds', 'error')
    expect(document.querySelector('dialog')).toBeNull()
  })

  it('offers Upload through the toolbar button, which opens the file chooser for YAML', async () => {
    renderTab()
    await ready()
    const input = screen.getByTestId('schemas-file')
    const click = vi.spyOn(input, 'click')
    fireEvent.click(screen.getByRole('button', { name: /Upload/ }))
    expect(click).toHaveBeenCalled()
    expect(input).toHaveAttribute('accept', expect.stringContaining('.yaml'))
  })
})
