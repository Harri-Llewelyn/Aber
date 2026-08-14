import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SchemasTab } from '../components/tabs/SchemasTab'
import { api } from '../api'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const CATALOG = [
  { metric_uuid: 'm1', name: 'Systems/TEMPERATURE', metric_group: 'Systems', datatype: 10, category: 'SAMPLE', standard: 'MTConnect', deprecated: false },
  { metric_uuid: 'm2', name: 'Controller/EXECUTION', metric_group: 'Controller', datatype: 12, category: 'EVENT', standard: 'MTConnect', deprecated: false },
  { metric_uuid: 'm3', name: 'Systems/SPINDLE_TEMPERATURE', metric_group: 'Systems', datatype: 10, category: 'SAMPLE', standard: 'MTConnect', deprecated: false }
]

const V1 = {
  schema_uuid: 'v1-uuid',
  schema_name: 'Robot_Arm_Schema',
  description: 'Six axis arm',
  schema_definition: {
    type: 'object',
    properties: { 'Systems/TEMPERATURE': { type: 'number' } },
    required: ['Systems/TEMPERATURE']
  },
  version: 1,
  status: 'active',
  parent_schema_id: null,
  change_description: 'Initial release'
}

const DRAFT_V2 = {
  ...V1,
  schema_uuid: 'v2-uuid',
  schema_name: 'Robot_Arm_Schema_v2',
  version: 2,
  status: 'draft',
  parent_schema_id: 'v1-uuid',
  change_description: 'Added spindle temperature threshold'
}

const ARCHIVED_V1 = { ...V1, status: 'archived' }
const ACTIVE_V2 = { ...DRAFT_V2, status: 'active' }

let schemaRows = []

const routes = () => ({
  '/api/v1/schemas': schemaRows,
  '/api/v1/metric-catalog': CATALOG,
  '/api/v1/metric-groups': [],
  '/api/v1/mtconnect-vocabulary': [],
  '/api/v1/iso22400-vocabulary': [],
  '/api/v1/opcua-vocabulary': [],
  '/api/v1/gateways': [],
  '/api/v1/devices': []
})

const showToast = vi.fn()

const renderTab = (canManage = true) => render(
  <SchemasTab showToast={showToast} hasPermission={() => canManage} onSelectSchema={vi.fn()} />
)

/**
 * Located by its heading, not by its position on the page.
 *
 * These used to be `document.querySelector('table')` and `tables[tables.length - 1]` -- the first
 * table was the catalog and the last was the registry. Then the two cards swapped order, and every
 * assertion in both files silently pointed at the wrong table. Naming what is wanted costs one
 * helper and cannot rot that way.
 */
const cardTable = (heading) => {
  const title = [...document.querySelectorAll('.card-header .section-title')]
    .find(h => h.textContent.includes(heading))
  return title?.closest('.card')?.querySelector('table')
}

const registryTable = () => cardTable('Registered Schemas')

const rowFor = (name) => {
  const cell = within(registryTable()).getByText(name)
  return cell.closest('tr')
}

/**
 * Select a schema row and return its context panel.
 *
 * The Actions column is gone: View / Edit Draft / Create Version / More all moved into the
 * right-hand drawer, so the row now carries identity and state and the panel carries what you can
 * DO about it. These assertions moved with them -- the rules being checked (a published version is
 * never editable, a lineage holds one draft, a fork is blocked with a reason rather than hidden)
 * are unchanged; only where they are rendered has moved.
 */
const panelFor = (name) => {
  fireEvent.click(within(registryTable()).getByText(name))
  return within(document.querySelector('.context-panel'))
}

beforeEach(() => {
  vi.clearAllMocks()
  schemaRows = [V1]
  api.get.mockImplementation((path) => {
    const table = routes()
    const key = Object.keys(table).find(r => path.startsWith(r))
    return Promise.resolve(key ? table[key] : [])
  })
})

describe('Registry — read-only protections and status badges', () => {
  it('badges an active schema as v1 · Active and marks it read-only', async () => {
    renderTab()
    await waitFor(() => expect(rowFor('Robot_Arm_Schema')).toBeTruthy())

    const row = rowFor('Robot_Arm_Schema')
    expect(within(row).getByText('v1 · Active')).toBeTruthy()
    expect(within(row).getByTitle('Read-only — this version is Active')).toBeTruthy()
  })

  it('badges an archived schema as v1 · Archived', async () => {
    schemaRows = [ARCHIVED_V1, ACTIVE_V2]
    renderTab()
    // Archived versions are history and hidden until asked for.
    await waitFor(() => expect(rowFor('Robot_Arm_Schema_v2')).toBeTruthy())
    expect(within(registryTable()).queryByText('Robot_Arm_Schema')).toBeNull()

    fireEvent.click(screen.getByTitle('Show the 1 archived version kept as history'))

    const archived = rowFor('Robot_Arm_Schema')
    expect(within(archived).getByText('v1 · Archived')).toBeTruthy()
    expect(within(archived).getByTitle('Read-only — this version is Archived')).toBeTruthy()
  })

  it('offers no edit affordance on a published version — only View and Create Version', async () => {
    renderTab()
    await waitFor(() => expect(rowFor('Robot_Arm_Schema')).toBeTruthy())

    const panel = panelFor('Robot_Arm_Schema')
    expect(panel.getByText('View Schema Detail')).toBeTruthy()
    // Not a disabled Edit button: editing an active schema is not a thing that can be done,
    // permissions notwithstanding, so the shape of the action is never offered.
    expect(panel.queryByText('Edit Draft')).toBeNull()
    expect(panel.getByText(/Create Version \(v2\)/)).toBeTruthy()
  })

  it('shows the change description in the registry', async () => {
    renderTab()
    await waitFor(() => expect(rowFor('Robot_Arm_Schema')).toBeTruthy())
    expect(within(rowFor('Robot_Arm_Schema')).getByText('Initial release')).toBeTruthy()
  })

  it('disables Create Version without schema-management permission, and says why', async () => {
    renderTab(false)
    await waitFor(() => expect(rowFor('Robot_Arm_Schema')).toBeTruthy())

    const button = panelFor('Robot_Arm_Schema').getByTitle('Requires Admin permissions')
    expect(button.disabled).toBe(true)
  })

  it('disables Create Version while a draft is already open, naming the draft', async () => {
    schemaRows = [V1, DRAFT_V2]
    renderTab()
    await waitFor(() => expect(rowFor('Robot_Arm_Schema')).toBeTruthy())

    const button = panelFor('Robot_Arm_Schema').getByTitle(
      'A draft (Robot_Arm_Schema_v2) already exists — publish or discard it first'
    )
    expect(button.disabled).toBe(true)
  })
})

describe('Registry — draft rows', () => {
  it('badges a draft and offers Edit Draft instead of View', async () => {
    schemaRows = [V1, DRAFT_V2]
    renderTab()
    await waitFor(() => expect(rowFor('Robot_Arm_Schema_v2')).toBeTruthy())

    // The badge stays on the row -- it is state, not an action.
    expect(within(rowFor('Robot_Arm_Schema_v2')).getByText('v2 · Draft')).toBeTruthy()

    const panel = panelFor('Robot_Arm_Schema_v2')
    expect(panel.getByText('Edit Draft')).toBeTruthy()
    // A draft is not the lineage head, so it cannot itself be forked.
    expect(panel.queryByText(/Create Version/)).toBeNull()
  })
})

describe('Forking — the change description prompt', () => {
  it('prompts for an optional change description and never for a version number', async () => {
    renderTab()
    await waitFor(() => expect(rowFor('Robot_Arm_Schema')).toBeTruthy())

    fireEvent.click(panelFor('Robot_Arm_Schema').getByText(/Create Version \(v2\)/))

    expect(screen.getByText('Create Version v2')).toBeTruthy()
    expect(screen.getByLabelText(/Change Description/)).toBeTruthy()
    // The number is computed by fork_schema() from the parent; a field would imply otherwise.
    expect(screen.queryByLabelText(/^Version/)).toBeNull()
  })

  it('posts the description to the versions endpoint and opens the resulting draft', async () => {
    api.post.mockResolvedValue({ ...DRAFT_V2, id: 'v2-uuid' })
    renderTab()
    await waitFor(() => expect(rowFor('Robot_Arm_Schema')).toBeTruthy())

    fireEvent.click(panelFor('Robot_Arm_Schema').getByText(/Create Version \(v2\)/))
    fireEvent.change(screen.getByLabelText(/Change Description/), {
      target: { value: 'Added spindle temperature threshold' }
    })

    schemaRows = [V1, DRAFT_V2]
    fireEvent.click(screen.getByText('Create Draft v2'))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/api/v1/schemas/v1-uuid/versions',
      { change_description: 'Added spindle temperature threshold' }
    ))

    // The draft opens straight away -- forking with nothing to edit is never the goal.
    await waitFor(() => expect(screen.getByText('Publish Version v2')).toBeTruthy())
  })

  it('sends the fork with no description when none is given', async () => {
    api.post.mockResolvedValue({ ...DRAFT_V2, change_description: null })
    renderTab()
    await waitFor(() => expect(rowFor('Robot_Arm_Schema')).toBeTruthy())

    fireEvent.click(panelFor('Robot_Arm_Schema').getByText(/Create Version \(v2\)/))
    fireEvent.click(screen.getByText('Create Draft v2'))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/api/v1/schemas/v1-uuid/versions', { change_description: '' }
    ))
  })
})

describe('Downloading a version definition', () => {
  // The anchor-click mechanism in downloadJSON() is not exercisable in jsdom, so the Blob is
  // captured instead: what matters is the exact bytes written and the filename, not the plumbing.
  let captured

  beforeEach(() => {
    captured = []
    // `URL.createObjectURL` and `Blob.prototype.text` are polyfilled in src/test/setup.js -- jsdom
    // ships neither, and without them this spy throws and the assertions below cannot read the
    // bytes. Spying on the real Blob rather than stubbing the constructor keeps this a test of
    // what downloadJSON() actually wrote.
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      captured.push(blob)
      return 'blob:mock'
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const downloadedText = () => captured[0].text()

  const clickRowDownload = async (name) => {
    fireEvent.click(panelFor(name).getByText('Download Definition (JSON)'))
  }

  it('offers the download from the context panel, not from the row', async () => {
    // It was the only item behind the row's "More" menu. With the Actions column gone, a
    // three-dot menu holding one entry would have been a click to reveal a click, so the
    // download became a direct panel action instead.
    renderTab()
    await waitFor(() => expect(rowFor('Robot_Arm_Schema')).toBeTruthy())

    const row = rowFor('Robot_Arm_Schema')
    expect(within(row).queryByText(/Download/i)).toBeNull()
    expect(within(row).queryByTitle('More')).toBeNull()
    expect(panelFor('Robot_Arm_Schema').getByText('Download Definition (JSON)')).toBeTruthy()
  })

  it('writes the stored definition verbatim, with no injected wrapper or title', async () => {
    renderTab()
    await waitFor(() => expect(rowFor('Robot_Arm_Schema')).toBeTruthy())
    await clickRowDownload('Robot_Arm_Schema')

    await waitFor(() => expect(captured.length).toBe(1))
    // Byte-for-byte the schema_definition. A published version is immutable, so the file has to
    // stay diffable against the database and against the previous version -- anything added here
    // would appear in every one of those diffs as noise that exists nowhere in the schema.
    expect(JSON.parse(await downloadedText())).toEqual(V1.schema_definition)
  })

  it('names the file after the version, which is what carries the version number', async () => {
    schemaRows = [V1, DRAFT_V2]
    const anchors = []
    const realCreate = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = realCreate(tag)
      if (tag === 'a') anchors.push(el)
      return el
    })

    renderTab()
    await waitFor(() => expect(rowFor('Robot_Arm_Schema_v2')).toBeTruthy())
    await clickRowDownload('Robot_Arm_Schema_v2')

    await waitFor(() => expect(anchors.length).toBe(1))
    // `.schema.json`, so editors and JSON Schema tooling recognise it -- the whole point of
    // opening the file elsewhere.
    expect(anchors[0].getAttribute('download')).toBe('Robot_Arm_Schema_v2.schema.json')
  })

  it('downloads an archived version too — reading history is not a privileged act', async () => {
    schemaRows = [ARCHIVED_V1, ACTIVE_V2]
    renderTab()
    await waitFor(() => expect(rowFor('Robot_Arm_Schema_v2')).toBeTruthy())
    fireEvent.click(screen.getByTitle('Show the 1 archived version kept as history'))

    await clickRowDownload('Robot_Arm_Schema')
    await waitFor(() => expect(captured.length).toBe(1))
    expect(JSON.parse(await downloadedText())).toEqual(ARCHIVED_V1.schema_definition)
  })

  it('is available without schema-management permission', async () => {
    // Downloading is a read. Gating it behind write authority would be the same category error as
    // gating the AAS export, which is deliberately allowed to Operator and Auditor.
    renderTab(false)
    await waitFor(() => expect(rowFor('Robot_Arm_Schema')).toBeTruthy())

    await clickRowDownload('Robot_Arm_Schema')
    await waitFor(() => expect(captured.length).toBe(1))
  })

  it('reports a schema with no definition instead of doing nothing', async () => {
    // downloadJSON() returns silently on falsy data, so this would otherwise be a dead button.
    schemaRows = [{ ...V1, schema_definition: null }]
    renderTab()
    await waitFor(() => expect(rowFor('Robot_Arm_Schema')).toBeTruthy())

    const item = panelFor('Robot_Arm_Schema').getByText('Download Definition (JSON)').closest('button')
    expect(item.disabled).toBe(true)
    expect(item.getAttribute('title')).toBe('This version has no definition to download')
  })

  it('offers the download as a visible button inside the detail modal', async () => {
    renderTab()
    await waitFor(() => expect(rowFor('Robot_Arm_Schema')).toBeTruthy())
    fireEvent.click(panelFor('Robot_Arm_Schema').getByText('View Schema Detail'))

    const modal = document.querySelector('.modal')
    fireEvent.click(within(modal).getByText('Download JSON'))

    await waitFor(() => expect(captured.length).toBe(1))
    expect(JSON.parse(await downloadedText())).toEqual(V1.schema_definition)
  })

  it('warns in the modal that a dirty draft downloads its last saved state', async () => {
    schemaRows = [V1, DRAFT_V2]
    renderTab()
    await waitFor(() => expect(rowFor('Robot_Arm_Schema_v2')).toBeTruthy())
    fireEvent.click(panelFor('Robot_Arm_Schema_v2').getByText('Edit Draft'))

    const modal = document.querySelector('.modal')
    fireEvent.click(within(modal).getByLabelText('Systems/SPINDLE_TEMPERATURE'))

    expect(within(modal).getByTitle(
      'Downloads the last saved draft — unsaved changes are not included'
    )).toBeTruthy()
  })
})

describe('Detail modal — read-only vs draft', () => {
  it('renders a published version as a list, with no metric checkboxes', async () => {
    renderTab()
    await waitFor(() => expect(rowFor('Robot_Arm_Schema')).toBeTruthy())
    fireEvent.click(panelFor('Robot_Arm_Schema').getByText('View Schema Detail'))

    // Scoped to the modal: the badge is deliberately on the row too, so an unscoped query
    // matches twice and would pass for the wrong reason.
    const modal = document.querySelector('.modal')
    expect(within(modal).getByText('v1 · Active')).toBeTruthy()
    expect(within(modal).getByText(/Active and read-only/)).toBeTruthy()
    expect(modal.querySelectorAll('input[type="checkbox"]').length).toBe(0)
    expect(screen.queryByText('Save Draft')).toBeNull()
    expect(screen.queryByText(/^Publish Version/)).toBeNull()
  })

  it('shows the change description prominently on a published version', async () => {
    renderTab()
    await waitFor(() => expect(rowFor('Robot_Arm_Schema')).toBeTruthy())
    fireEvent.click(panelFor('Robot_Arm_Schema').getByText('View Schema Detail'))

    const modal = document.querySelector('.modal')
    expect(within(modal).getByText('Change Description')).toBeTruthy()
    expect(within(modal).getByText('Initial release')).toBeTruthy()
  })

  it('lets a draft add and remove metrics, then publish', async () => {
    schemaRows = [V1, DRAFT_V2]
    api.put.mockResolvedValue({ id: 'v2-uuid' })
    api.post.mockResolvedValue({ schema_uuid: 'v2-uuid', version: 2, devices_rebound: 3, archived_schema_name: 'Robot_Arm_Schema' })
    renderTab()
    await waitFor(() => expect(rowFor('Robot_Arm_Schema_v2')).toBeTruthy())

    fireEvent.click(panelFor('Robot_Arm_Schema_v2').getByText('Edit Draft'))

    // Add a metric the forked definition did not carry.
    fireEvent.click(screen.getByLabelText('Systems/SPINDLE_TEMPERATURE'))
    fireEvent.click(screen.getByText('Publish Version v2'))

    await waitFor(() => expect(api.put).toHaveBeenCalled())
    const [putPath, putBody] = api.put.mock.calls[0]
    expect(putPath).toBe('/api/v1/schemas/v2-uuid')
    expect(Object.keys(putBody.schema_definition.properties).sort())
      .toEqual(['Systems/SPINDLE_TEMPERATURE', 'Systems/TEMPERATURE'])

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/v1/schemas/v2-uuid/publish', {}))
  })

  it('saves edits before publishing, so a publish can never activate what was not shown', async () => {
    schemaRows = [V1, DRAFT_V2]
    const order = []
    api.put.mockImplementation(async () => { order.push('save'); return { id: 'v2-uuid' } })
    api.post.mockImplementation(async () => { order.push('publish'); return { version: 2 } })
    renderTab()
    await waitFor(() => expect(rowFor('Robot_Arm_Schema_v2')).toBeTruthy())

    fireEvent.click(panelFor('Robot_Arm_Schema_v2').getByText('Edit Draft'))
    fireEvent.click(screen.getByLabelText('Systems/SPINDLE_TEMPERATURE'))
    fireEvent.click(screen.getByText('Publish Version v2'))

    await waitFor(() => expect(order).toEqual(['save', 'publish']))
  })

  it('does not publish when saving the edits was rejected', async () => {
    schemaRows = [V1, DRAFT_V2]
    api.put.mockRejectedValue(new Error('schema is active and immutable'))
    api.post.mockResolvedValue({ version: 2 })
    renderTab()
    await waitFor(() => expect(rowFor('Robot_Arm_Schema_v2')).toBeTruthy())

    fireEvent.click(panelFor('Robot_Arm_Schema_v2').getByText('Edit Draft'))
    fireEvent.click(screen.getByLabelText('Systems/SPINDLE_TEMPERATURE'))
    fireEvent.click(screen.getByText('Publish Version v2'))

    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(api.post).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith('schema is active and immutable', 'error')
  })

  it('shows the version history once a lineage has more than one member', async () => {
    schemaRows = [ARCHIVED_V1, ACTIVE_V2]
    renderTab()
    await waitFor(() => expect(rowFor('Robot_Arm_Schema_v2')).toBeTruthy())
    fireEvent.click(panelFor('Robot_Arm_Schema_v2').getByText('View Schema Detail'))

    const modal = document.querySelector('.modal')
    expect(within(modal).getByText(/Version History/)).toBeTruthy()
    expect(within(modal).getByText('Initial release')).toBeTruthy()
    expect(within(modal).getAllByText('Added spindle temperature threshold').length).toBeGreaterThan(0)
  })

  it('omits the history heading for a schema nobody has versioned', async () => {
    renderTab()
    await waitFor(() => expect(rowFor('Robot_Arm_Schema')).toBeTruthy())
    fireEvent.click(panelFor('Robot_Arm_Schema').getByText('View Schema Detail'))

    expect(screen.queryByText(/Version History/)).toBeNull()
  })
})
