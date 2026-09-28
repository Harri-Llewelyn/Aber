import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MetricsTab } from '../components/tabs/MetricsTab'
import { api } from '../api'
import { PERMISSION_UUIDS } from '../constants'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const CATALOG = [
  { metric_uuid: 'm1', name: 'Axes/DISPLACEMENT', metric_group: 'Axes', datatype: 10, category: 'SAMPLE', units: 'MILLIMETER', standard: 'MTConnect', deprecated: false },
  { metric_uuid: 'm2', name: 'Controller/EXECUTION', metric_group: 'Controller', datatype: 12, category: 'EVENT', standard: 'MTConnect', deprecated: false },
  { metric_uuid: 'm3', name: 'Controller/FIRMWARE', metric_group: 'Controller', datatype: 12, category: 'EVENT', standard: 'MTConnect', deprecated: false },
  { metric_uuid: 'm4', name: 'safety_interlock', metric_group: null, datatype: 11, category: 'EVENT', standard: null, deprecated: false },
  { metric_uuid: 'm9', name: 'temperature', metric_group: null, datatype: 10, deprecated: true }
]

const VOCABULARY = [
  { kind: 'DATA_ITEM_TYPE', name: 'ANGLE', category: 'SAMPLE' },
  { kind: 'DATA_ITEM_TYPE', name: 'ACCELERATION', category: 'SAMPLE' },
  { kind: 'DATA_ITEM_TYPE', name: 'EXECUTION', category: 'EVENT' },
  { kind: 'DATA_ITEM_TYPE', name: 'FIRMWARE', category: 'EVENT' },
  { kind: 'COMPONENT', name: 'Axes', category: null },
  { kind: 'COMPONENT', name: 'Actuator', category: null },
  { kind: 'UNIT', name: 'MILLIMETER', category: null },
  { kind: 'UNIT', name: 'PERCENT', category: null }
]

const ISO_VOCABULARY = [
  {
    name: 'AVAILABILITY', kpi_id: 'A', category: 'OEE', unit: 'PERCENT',
    formula: 'A = APT / PBT', description: 'Availability ratio',
    semantic_id: 'https://aber.local/semantics/iso22400/AVAILABILITY'
  },
  {
    name: 'MTBF', kpi_id: 'MTBF', category: 'Maintenance', unit: 'HOUR',
    formula: 'MTBF = APT / number of failures', description: 'Mean operating time between failures',
    semantic_id: 'https://aber.local/semantics/iso22400/MTBF'
  }
]

const OPCUA_VOCABULARY = [
  {
    name: 'ActualPosition', companion_spec: 'OPC 40010 Robotics',
    node_id: 'nsu=http://opcfoundation.org/UA/Robotics/;s=MotionDevice/Axes/Axis/ActualPosition',
    datatype: 'Double', unit: 'MILLIMETER', description: 'Current position of an axis.',
    semantic_id: 'http://opcfoundation.org/UA/Robotics/ActualPosition'
  },
  {
    name: 'Manufacturer', companion_spec: 'OPC 40001 Machinery',
    node_id: 'nsu=http://opcfoundation.org/UA/Machinery/;s=Machine/Identification/Manufacturer',
    datatype: 'LocalizedText', unit: null, description: 'Name of the machine manufacturer.',
    semantic_id: 'http://opcfoundation.org/UA/Machinery/Manufacturer'
  }
]

// A slice of ashrae223_vocabulary: two classes under different superclasses and one relation, which
// the Concept picker must leave out.
const ASHRAE223_VOCABULARY = [
  {
    name: 'TemperatureSensor', concept_kind: 'Class', label: 'Temperature sensor', subclass_of: 'Sensor',
    description: 'A `Sensor` that measures temperature.',
    semantic_id: 'http://data.ashrae.org/standard223#TemperatureSensor'
  },
  {
    name: 'Fan', concept_kind: 'Class', label: 'Fan', subclass_of: 'Equipment',
    description: 'A piece of `Equipment` that causes a gas to flow.',
    semantic_id: 'http://data.ashrae.org/standard223#Fan'
  },
  {
    name: 'hasProperty', concept_kind: 'Relation', label: 'has property', subclass_of: null,
    description: 'A `Relation` that associates a `Concept` with a `Property`.',
    semantic_id: 'http://data.ashrae.org/standard223#hasProperty'
  }
]

const routes = {
  '/api/v1/schemas': [],
  '/api/v1/metric-catalog': CATALOG,
  '/api/v1/metric-groups': [
    { group_uuid: 'g1', name: 'Axes', standard: 'MTConnect' },
    { group_uuid: 'g6', name: 'Actuator', standard: 'MTConnect' },
    { group_uuid: 'g2', name: 'OEE', standard: 'ISO 22400' },
    { group_uuid: 'g3', name: 'Machine', standard: 'OPC UA' },
    { group_uuid: 'g4', name: 'Hydraulic', standard: null },
    { group_uuid: 'g5', name: 'BMS', standard: 'ASHRAE 223P' }
  ],
  '/api/v1/mtconnect-vocabulary': VOCABULARY,
  '/api/v1/iso22400-vocabulary': ISO_VOCABULARY,
  '/api/v1/opcua-vocabulary': OPCUA_VOCABULARY,
  '/api/v1/ashrae223-vocabulary': ASHRAE223_VOCABULARY,
  '/api/v1/gateways': [],
  '/api/v1/devices': []
}

const renderTab = () => render(
  <MetricsTab showToast={vi.fn()} hasPermission={() => true} />
)

/** The catalog table is the first one on the page; the vocabulary panel below it is not a table. */
/**
 * Located by its heading, not by its position: the two cards have swapped order before, and a
 * positional query silently points at the wrong table.
 */
const cardTable = (heading) => {
  const title = [...document.querySelectorAll('.card-header .section-title')]
    .find(h => h.textContent.includes(heading))
  return title?.closest('.card')?.querySelector('table')
}

const catalogTable = () => cardTable('Metric Catalog')

/**
 * Waits for the catalog to render, then opens every group. The groups default to collapsed, so the
 * gate waits on a group header and then expands the sections the assertions read. Scoped to the
 * catalog table because the vocabulary panel has its own collapsible sections.
 */
const waitForCatalog = async () => {
  await waitFor(() => expect(catalogTable()).toBeTruthy())
  await waitFor(() => expect(within(catalogTable()).getAllByTitle(/^Expand /).length).toBeGreaterThan(0))
  for (const header of within(catalogTable()).queryAllByTitle(/^Expand /)) {
    fireEvent.click(header)
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation((path) => {
    const key = Object.keys(routes).find(r => path.startsWith(r))
    return Promise.resolve(key ? routes[key] : [])
  })
})

describe('Metric Catalog — collapsible groups', () => {
  it('opens COLLAPSED, showing each group header and its count rather than every row', async () => {
    // Collapsed on arrival: the catalog outgrew being unrolled, and the header count says what is
    // inside.
    renderTab()

    await waitFor(() => expect(screen.getByTitle('Expand Controller (2 metrics)')).toBeTruthy())
    expect(screen.queryByText('Axes/DISPLACEMENT')).toBeNull()
    expect(screen.queryByText('Controller/EXECUTION')).toBeNull()
    expect(screen.queryByText('safety_interlock')).toBeNull()

    // Collapsed is not uninformative: the header carries the group and how many metrics it has.
    const header = screen.getByTitle('Expand Controller (2 metrics)')
    expect(within(header).getByText('Controller')).toBeTruthy()
    expect(within(header).getByText('2')).toBeTruthy()
  })

  it('expands a single group without touching the others', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByTitle('Expand Controller (2 metrics)')).toBeTruthy())

    fireEvent.click(screen.getByTitle('Expand Controller (2 metrics)'))

    expect(screen.getByText('Controller/EXECUTION')).toBeTruthy()
    expect(screen.getByText('Controller/FIRMWARE')).toBeTruthy()
    // Expansion is per group, not a single global toggle.
    expect(screen.queryByText('Axes/DISPLACEMENT')).toBeNull()
  })

  it('collapses again on a second click', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByTitle('Expand Controller (2 metrics)')).toBeTruthy())

    fireEvent.click(screen.getByTitle('Expand Controller (2 metrics)'))
    fireEvent.click(screen.getByTitle('Collapse Controller'))

    expect(screen.queryByText('Controller/EXECUTION')).toBeNull()
  })

  it('leaves the rest of the row intact when expanded', async () => {
    // Guards the table rendering itself, not just visibility: expansion is a row-level condition
    // inside the same <tbody>, so a mistake here silently drops columns.
    renderTab()
    await waitForCatalog()

    const row = screen.getByText('Axes/DISPLACEMENT').closest('tr')
    expect(within(row).getByText('SAMPLE')).toBeTruthy()
    expect(within(row).getByText('MILLIMETER')).toBeTruthy()
    expect(within(row).getByRole('button', { name: /Deprecate/ })).toBeTruthy()
  })
})

// A second deprecated row that names a replacement, so the Superseded By column has a name to show.
const WITH_REPLACEMENT = [
  ...CATALOG,
  { metric_uuid: 'm8', name: 'Controller/OLD_EXECUTION', metric_group: 'Controller', datatype: 12, category: 'EVENT', standard: 'MTConnect', deprecated: true, superseded_by: 'm2' }
]

/**
 * #468. Deprecated metrics moved out of a collapsed tail inside the catalog table, where there was
 * nothing to act on, to a card of their own with a Restore per row.
 */
describe('Deprecated Metrics card', () => {
  const withCatalog = (rows) => api.get.mockImplementation((path) =>
    Promise.resolve(path.startsWith('/api/v1/metric-catalog')
      ? rows
      : (routes[Object.keys(routes).find(r => path.startsWith(r))] || [])))

  const deprecatedTable = () => cardTable('Deprecated Metrics')

  it('lists deprecated metrics on their own card, and not in the catalog table', async () => {
    renderTab()
    await waitForCatalog()
    await waitFor(() => expect(deprecatedTable()).toBeTruthy())

    expect(within(deprecatedTable()).getByText('temperature')).toBeTruthy()
    // Every group is open, so absence here means the row is not in the catalog at all.
    expect(within(catalogTable()).queryByText('temperature')).toBeNull()
  })

  it('renders no card when nothing is deprecated', async () => {
    withCatalog(CATALOG.filter(m => !m.deprecated))
    renderTab()
    await waitForCatalog()

    expect(screen.queryByText('Deprecated Metrics')).toBeNull()
  })

  it('names the replacement, not its uuid', async () => {
    withCatalog(WITH_REPLACEMENT)
    renderTab()
    await waitFor(() => expect(deprecatedTable()).toBeTruthy())

    const row = within(deprecatedTable()).getByText('Controller/OLD_EXECUTION').closest('tr')
    expect(within(row).getByText('Controller/EXECUTION')).toBeTruthy()
    expect(within(row).queryByText('m2')).toBeNull()
  })

  it('is not narrowed by the catalog search, which belongs to the card above', async () => {
    renderTab()
    await waitFor(() => expect(deprecatedTable()).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Search the metric catalog'), { target: { value: 'EXECUTION' } })
    expect(within(deprecatedTable()).getByText('temperature')).toBeTruthy()
  })

  it('disables Restore and Deprecate for a Shopfloor Manager, who holds archive:manage and not schema:manage', async () => {
    render(<MetricsTab showToast={vi.fn()} hasPermission={(p) => p !== PERMISSION_UUIDS.SCHEMA_MANAGE} />)
    await waitFor(() => expect(deprecatedTable()).toBeTruthy())

    const restore = within(deprecatedTable()).getByRole('button', { name: /Restore/ })
    expect(restore.disabled).toBe(true)
    expect(restore.title).toBe('Requires Admin permissions')
    await waitForCatalog()
    const deprecate = within(catalogTable()).getAllByRole('button', { name: /Deprecate/ })
    expect(deprecate.length).toBeGreaterThan(0)
    for (const button of deprecate) expect(button.disabled).toBe(true)
  })
})

describe('Restore Metric', () => {
  const setup = async (rows = CATALOG) => {
    api.get.mockImplementation((path) =>
      Promise.resolve(path.startsWith('/api/v1/metric-catalog')
        ? rows
        : (routes[Object.keys(routes).find(r => path.startsWith(r))] || [])))
    const showToast = vi.fn()
    render(<MetricsTab showToast={showToast} hasPermission={() => true} />)
    await waitFor(() => expect(cardTable('Deprecated Metrics')).toBeTruthy())
    return showToast
  }

  const openRestore = (name) => {
    const row = within(cardTable('Deprecated Metrics')).getByText(name).closest('tr')
    fireEvent.click(within(row).getByRole('button', { name: /Restore/ }))
    return document.querySelector('.modal')
  }

  it('asks first, naming the metric and the replacement pointer it clears', async () => {
    await setup(WITH_REPLACEMENT)
    const modal = openRestore('Controller/OLD_EXECUTION')

    expect(modal).toBeTruthy()
    expect(within(modal).getByText(/offered to schema authors/)).toBeTruthy()
    expect(within(modal).getByText('Controller/EXECUTION')).toBeTruthy()
    expect(modal.textContent).toMatch(/restoring clears that pointer/)
    expect(api.post).not.toHaveBeenCalled()
  })

  it('says there is no pointer to clear when none was named', async () => {
    await setup()
    const modal = openRestore('temperature')

    expect(modal.textContent).toMatch(/names no replacement/)
  })

  it('posts the restore route on confirmation and reloads the catalog', async () => {
    const showToast = await setup()
    openRestore('temperature')
    const loads = api.get.mock.calls.filter(([p]) => p.startsWith('/api/v1/metric-catalog')).length

    fireEvent.click(screen.getByRole('button', { name: 'Restore Metric' }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/v1/metric-catalog/m9/restore'))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/temperature.*restored/), 'success'))
    expect(api.get.mock.calls.filter(([p]) => p.startsWith('/api/v1/metric-catalog')).length).toBeGreaterThan(loads)
    expect(document.querySelector('.modal')).toBeNull()
  })

  it('posts nothing when cancelled', async () => {
    await setup()
    openRestore('temperature')

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(document.querySelector('.modal')).toBeNull()
    expect(api.post).not.toHaveBeenCalled()
  })

  it('reports a refused restore and leaves the dialog open', async () => {
    api.post.mockRejectedValueOnce(new Error('Metric not restored — it may no longer exist, or you may not have permission to change the catalog.'))
    const showToast = await setup()
    openRestore('temperature')

    fireEvent.click(screen.getByRole('button', { name: 'Restore Metric' }))

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/^Metric not restored/), 'error'))
    expect(document.querySelector('.modal')).toBeTruthy()
  })

  it('names Restore in the toast a deprecation leaves', async () => {
    const showToast = await setup()
    await waitForCatalog()
    const row = within(catalogTable()).getByText('Axes/DISPLACEMENT').closest('tr')
    fireEvent.click(within(row).getByRole('button', { name: /Deprecate/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Deprecate Metric' }))

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/deprecated.*restore it/), 'success'))
  })
})

/**
 * A metric's semantic id is an assertion about it, not part of what a device publishes, so an
 * Administrator corrects it in place. The name and datatype are shown and not offered.
 */
describe('Edit Metric — correcting a semantic id', () => {
  const EXECUTION_ID = 'https://aber.local/semantics/mtconnect/v2.0/DataItemType/EXECUTION'
  const IEC_CDD = '0112/2///61987#ABA565#009'
  const MAPPED = CATALOG.map(m => (m.metric_uuid === 'm2'
    ? { ...m, semantic_id: EXECUTION_ID, semantic_id_type: 'IRI' }
    : m))
  const modelling = (...names) => ({
    schema_definition: { type: 'object', properties: Object.fromEntries(names.map(n => [n, { type: 'string' }])) }
  })
  const SCHEMAS = [
    { schema_uuid: 's1', ...modelling('Controller/EXECUTION') },
    { schema_uuid: 's2', ...modelling('Controller/EXECUTION', 'Axes/DISPLACEMENT') }
  ]

  const setup = async (hasPermission = () => true) => {
    api.get.mockImplementation((path) => Promise.resolve(
      path.startsWith('/api/v1/metric-catalog') ? MAPPED
        : path.startsWith('/api/v1/schemas') ? SCHEMAS
          : (routes[Object.keys(routes).find(r => path.startsWith(r))] || [])))
    const showToast = vi.fn()
    render(<MetricsTab showToast={showToast} hasPermission={hasPermission} />)
    await waitForCatalog()
    return showToast
  }

  const editButtonFor = (name) =>
    within(within(catalogTable()).getByText(name).closest('tr')).getByRole('button', { name: /Edit/ })

  const openEdit = (name) => {
    fireEvent.click(editButtonFor(name))
    return within(document.querySelector('.modal'))
  }

  it('offers Edit on every row, disabled for a Shopfloor Manager as Deprecate is', async () => {
    await setup((p) => p !== PERMISSION_UUIDS.SCHEMA_MANAGE)

    const edits = within(catalogTable()).getAllByRole('button', { name: /Edit/ })
    expect(edits.length).toBe(within(catalogTable()).getAllByRole('button', { name: /Deprecate/ }).length)
    for (const button of edits) {
      expect(button.disabled).toBe(true)
      expect(button.title).toBe('Requires Admin permissions')
    }
    fireEvent.click(edits[0])
    expect(document.querySelector('.modal')).toBeNull()
  })

  it('offers Edit on a deprecated metric too, which still carries its id into schemas', async () => {
    await setup()
    const row = within(cardTable('Deprecated Metrics')).getByText('temperature').closest('tr')
    expect(within(row).getByRole('button', { name: /Edit/ }).disabled).toBe(false)
  })

  it('shows the name and datatype as text, and the stored pair in the field', async () => {
    await setup()
    const modal = openEdit('Controller/EXECUTION')

    expect(modal.getAllByText('Controller/EXECUTION').length).toBeGreaterThan(0)
    expect(modal.getByText('String')).toBeTruthy()
    // The semantic id is the only thing typed into: name and datatype have no control.
    expect(modal.getAllByRole('textbox')).toHaveLength(1)
    expect(modal.getByRole('textbox', { name: /Semantic ID/ }).value).toBe(EXECUTION_ID)
    expect(modal.getByRole('combobox', { name: 'Reference Type' }).value).toBe('IRI')
  })

  it('offers IRI and IRDI only', async () => {
    await setup()
    const modal = openEdit('Controller/EXECUTION')
    const options = [...modal.getByRole('combobox', { name: 'Reference Type' }).querySelectorAll('option')]
    expect(options.map(o => o.value)).toEqual(['', 'IRI', 'IRDI'])
  })

  it('says how many schemas model the metric, as Deprecate does', async () => {
    await setup()
    expect(openEdit('Controller/EXECUTION').getByText(/model this/).textContent).toMatch(/2\s+schemas\s+model this/)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(openEdit('Controller/FIRMWARE').getByText(/No schema models this metric/)).toBeTruthy()
  })

  it('has nothing to save until the pair changes', async () => {
    await setup()
    const modal = openEdit('Controller/EXECUTION')
    expect(modal.getByRole('button', { name: 'Save Semantic ID' }).disabled).toBe(true)
  })

  it('sends only the semantic id and its type, and reloads the catalog', async () => {
    api.put.mockResolvedValue({ id: 'm2' })
    const showToast = await setup()
    const modal = openEdit('Controller/EXECUTION')
    const loads = api.get.mock.calls.filter(([p]) => p.startsWith('/api/v1/metric-catalog')).length

    fireEvent.change(modal.getByRole('textbox', { name: /Semantic ID/ }), { target: { value: IEC_CDD } })
    expect(modal.getByRole('combobox', { name: 'Reference Type' }).value).toBe('IRDI')
    fireEvent.click(modal.getByRole('button', { name: 'Save Semantic ID' }))

    await waitFor(() => expect(api.put).toHaveBeenCalledWith(
      '/api/v1/metric-catalog/m2', { semantic_id: IEC_CDD, semantic_id_type: 'IRDI' }
    ))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/Controller\/EXECUTION.*saved/), 'success'))
    expect(api.get.mock.calls.filter(([p]) => p.startsWith('/api/v1/metric-catalog')).length).toBeGreaterThan(loads)
    expect(document.querySelector('.modal')).toBeNull()
  })

  it('clears the id and the type with it, which leaves the metric unmapped', async () => {
    api.put.mockResolvedValue({ id: 'm2' })
    const showToast = await setup()
    const modal = openEdit('Controller/EXECUTION')

    fireEvent.change(modal.getByRole('textbox', { name: /Semantic ID/ }), { target: { value: '' } })
    const type = modal.getByRole('combobox', { name: 'Reference Type' })
    expect(type.value).toBe('')
    expect(type.disabled).toBe(true)
    fireEvent.click(modal.getByRole('button', { name: 'Save Semantic ID' }))

    await waitFor(() => expect(api.put).toHaveBeenCalledWith(
      '/api/v1/metric-catalog/m2', { semantic_id: '', semantic_id_type: '' }
    ))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/cleared/), 'success'))
  })

  it('reports a refused edit and leaves the dialog open', async () => {
    api.put.mockRejectedValueOnce(new Error('Semantic id not changed — the metric may no longer exist, or you may not have permission to change the catalog.'))
    const showToast = await setup()
    const modal = openEdit('Controller/EXECUTION')

    fireEvent.change(modal.getByRole('textbox', { name: /Semantic ID/ }), { target: { value: IEC_CDD } })
    fireEvent.click(modal.getByRole('button', { name: 'Save Semantic ID' }))

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/^Semantic id not changed/), 'error'))
    expect(document.querySelector('.modal')).toBeTruthy()
  })

  it('writes nothing when cancelled', async () => {
    await setup()
    const modal = openEdit('Controller/EXECUTION')
    fireEvent.change(modal.getByRole('textbox', { name: /Semantic ID/ }), { target: { value: IEC_CDD } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(document.querySelector('.modal')).toBeNull()
    expect(api.put).not.toHaveBeenCalled()
  })

  it('marks a stored id that is the one Add Metric would suggest', async () => {
    await setup()
    const modal = openEdit('Controller/EXECUTION')

    expect(modal.getByText('· suggested')).toBeTruthy()
    expect(modal.queryByRole('button', { name: 'Use suggested' })).toBeNull()
  })

  it('puts back the id Add Metric would suggest for an unmapped MTConnect metric', async () => {
    // Restoring a cleared id used to mean retyping the derived IRI by hand.
    api.put.mockResolvedValue({ id: 'm3' })
    await setup()
    const modal = openEdit('Controller/FIRMWARE')
    expect(modal.getByRole('textbox', { name: /Semantic ID/ }).value).toBe('')

    fireEvent.click(modal.getByRole('button', { name: 'Use suggested' }))
    expect(modal.getByRole('combobox', { name: 'Reference Type' }).value).toBe('IRI')
    fireEvent.click(modal.getByRole('button', { name: 'Save Semantic ID' }))

    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/api/v1/metric-catalog/m3', {
      semantic_id: 'https://aber.local/semantics/mtconnect/v2.0/DataItemType/FIRMWARE',
      semantic_id_type: 'IRI'
    }))
  })

  it('suggests nothing for a local extension', async () => {
    await setup()
    const modal = openEdit('safety_interlock')

    expect(modal.queryByRole('button', { name: 'Use suggested' })).toBeNull()
    expect(modal.queryByText('· suggested')).toBeNull()
  })
})

describe('Metric Catalog — search', () => {
  const search = () => screen.getByLabelText('Search the metric catalog')

  it('auto-expands matching groups, so a search is not a list of shut headers', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByTitle('Expand Controller (2 metrics)')).toBeTruthy())

    fireEvent.change(search(), { target: { value: 'EXECUTION' } })

    // Revealed without anyone clicking a header -- the whole point of the override.
    expect(screen.getByText('Controller/EXECUTION')).toBeTruthy()
    expect(screen.queryByText('Controller/FIRMWARE')).toBeNull()
    expect(screen.queryByText('Axes/DISPLACEMENT')).toBeNull()
  })

  it('matches case-insensitively on the metric name', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByTitle('Expand Controller (2 metrics)')).toBeTruthy())

    fireEvent.change(search(), { target: { value: 'axes/' } })
    expect(screen.getByText('Axes/DISPLACEMENT')).toBeTruthy()
  })

  it('says so when nothing matches, rather than rendering a bare table header', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByTitle('Expand Controller (2 metrics)')).toBeTruthy())

    fireEvent.change(search(), { target: { value: 'no-such-metric' } })
    expect(screen.getByText(/No metric matches/)).toBeTruthy()
  })

  it('restores the collapsed view when the search is cleared', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByTitle('Expand Controller (2 metrics)')).toBeTruthy())

    fireEvent.change(search(), { target: { value: 'EXECUTION' } })
    expect(screen.getByText('Controller/EXECUTION')).toBeTruthy()

    fireEvent.change(search(), { target: { value: '' } })
    expect(screen.queryByText('Controller/EXECUTION')).toBeNull()
  })
})

describe('Metric Catalog — Add Metric toggle', () => {
  const addButton = () => screen.getByRole('button', { name: /Add Metric|Cancel/ })

  it('reads "Add Metric" while the form is closed', async () => {
    renderTab()
    await waitForCatalog()

    expect(addButton().textContent).toContain('Add Metric')
    expect(addButton().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Data Item Type')).toBeNull()
  })

  it('reads "Cancel" once the form is open', async () => {
    renderTab()
    await waitForCatalog()

    fireEvent.click(addButton())

    expect(addButton().textContent).toContain('Cancel')
    expect(addButton().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Data Item Type')).toBeTruthy()
  })

  it('closes the form again and returns the label', async () => {
    renderTab()
    await waitForCatalog()

    fireEvent.click(addButton())
    fireEvent.click(addButton())

    expect(addButton().textContent).toContain('Add Metric')
    expect(screen.queryByText('Data Item Type')).toBeNull()
  })

  it('is filled while it opens the form and ghost while it cancels one', async () => {
    /* Filled is what a create action looks like on every other page -- Build Schema from Catalog,
       New Area, New Cell. It cannot STAY filled once the form is open: the label is Cancel by
       then, and the form's own submit is the filled one, so two would compete. */
    renderTab()
    await waitForCatalog()

    expect(addButton().className).toContain('btn-primary')
    expect(addButton().className).not.toContain('btn-ghost')

    fireEvent.click(addButton())

    expect(addButton().className).toContain('btn-ghost')
    expect(addButton().className).not.toContain('btn-primary')
    // Exactly one filled button on screen: the form's own, which commits the metric.
    const filled = [...document.querySelectorAll('.btn-primary')]
    expect(filled).toHaveLength(1)
    expect(filled[0].textContent.trim()).toBe('Add')
  })

  it('discards what was typed, so a reopened form does not inherit stale input', async () => {
    // The label says Cancel, so it has to mean cancel.
    renderTab()
    await waitForCatalog()

    fireEvent.click(addButton())
    const description = screen.getByPlaceholderText('What this metric represents')
    fireEvent.change(description, { target: { value: 'half-finished note' } })
    expect(description.value).toBe('half-finished note')

    fireEvent.click(addButton())
    fireEvent.click(addButton())

    expect(screen.getByPlaceholderText('What this metric represents').value).toBe('')
  })

  it('disables the control without the manage permission, in either state', async () => {
    render(<MetricsTab showToast={vi.fn()} hasPermission={() => false} />)
    await waitForCatalog()

    const button = screen.getByRole('button', { name: /Add Metric/ })
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(screen.queryByText('Data Item Type')).toBeNull()
  })
})

// Multi-standard metric builder (MTConnect / ISO 22400 / OPC UA / ASHRAE 223P) and semantic ids

const standardSelect = () => screen.getByTitle(/Which vocabulary this metric is named from/)
// The Add Metric form's SemanticIdField, the only one on the page while no dialog is open.
const semanticIdInput = () => screen.getByRole('textbox', { name: /Semantic ID/ })
const referenceTypeSelect = () => screen.getByRole('combobox', { name: 'Reference Type' })
const useSuggestedButton = () => screen.queryByRole('button', { name: 'Use suggested' })
const datatypeSelect = () => screen.getByTitle(/How the value is encoded on the wire/)
const conceptSelect = () => screen.getByTitle(/The ASHRAE 223P concept this point is attached to/)
const addMetricButton = () => screen.getByRole('button', { name: /^Add$/ })

// The Units column header carries the same title text as the Units picker, so the query has to
// say which element kind it wants.
const unitsSelect = () =>
  screen.getAllByTitle(/MTConnect units|Only SAMPLE data items carry units/).find(el => el.tagName === 'SELECT')

/** The card a panel or section lives in, for scoping queries away from its neighbours. */
const cardFor = (heading) => screen.getByRole('heading', { name: heading }).closest('.card')

/**
 * The "Devices will publish this metric as …" line. Scoped because every vocabulary panel's
 * description quotes example metric names in the same mono markup.
 */
const namePreview = () => screen.getByText(/Devices will publish this metric as/)

const openForm = async () => {
  renderTab()
  await waitForCatalog()
  fireEvent.click(screen.getByRole('button', { name: /Add Metric/ }))
}

describe('Metric builder — standard selector', () => {
  it('opens on MTConnect, so the existing path is unchanged', async () => {
    await openForm()
    expect(standardSelect().value).toBe('MTConnect')
    expect(screen.getByText('Data Item Type')).toBeTruthy()
    expect(screen.getByText('Sub Type')).toBeTruthy()
  })

  it('swaps the picker to KPIs for ISO 22400 and drops the MTConnect-only fields', async () => {
    await openForm()
    fireEvent.change(standardSelect(), { target: { value: 'ISO 22400' } })

    expect(screen.getByText('KPI')).toBeTruthy()
    expect(screen.queryByText('Data Item Type')).toBeNull()
    // A KPI is a whole concept — there is no ACTUAL/COMMANDED variant to qualify.
    expect(screen.queryByText('Sub Type')).toBeNull()
  })

  it('swaps the picker to data points for OPC UA', async () => {
    await openForm()
    fireEvent.change(standardSelect(), { target: { value: 'OPC UA' } })

    expect(screen.getByText('Data Point')).toBeTruthy()
    expect(screen.queryByText('Data Item Type')).toBeNull()
  })

  it('takes free text for a custom metric, with no vocabulary behind it', async () => {
    await openForm()
    fireEvent.change(standardSelect(), { target: { value: '' } })

    expect(screen.getByText('Metric Name')).toBeTruthy()
    expect(screen.queryByText('Data Item Type')).toBeNull()
    expect(screen.queryByText('KPI')).toBeNull()
  })

  it('clears the previous vocabulary’s selection when the standard changes', async () => {
    // `standard` is what an AAS export reads to pick a namespace, so a type left over from
    // another vocabulary would be a wrong interoperability claim rather than a cosmetic bug.
    await openForm()
    fireEvent.change(standardSelect(), { target: { value: 'ISO 22400' } })
    fireEvent.change(screen.getByTitle(/ISO 22400-2 key performance indicator/), { target: { value: 'AVAILABILITY' } })
    expect(semanticIdInput().value).toContain('iso22400/AVAILABILITY')

    fireEvent.change(standardSelect(), { target: { value: 'MTConnect' } })
    // Nothing carried over: the ISO id is gone, and MTConnect derives nothing until a type is
    // chosen (the surviving group alone does not name a metric).
    expect(semanticIdInput().value).toBe('')
    expect(referenceTypeSelect().value).toBe('')
  })
})

describe('Metric builder — vocabulary prefill', () => {
  it('fills an ISO KPI’s unit, semantic id and group from the standard', async () => {
    await openForm()
    fireEvent.change(standardSelect(), { target: { value: 'ISO 22400' } })
    fireEvent.change(screen.getByTitle(/ISO 22400-2 key performance indicator/), { target: { value: 'AVAILABILITY' } })

    expect(unitsSelect().value).toBe('PERCENT')
    expect(semanticIdInput().value).toBe('https://aber.local/semantics/iso22400/AVAILABILITY')
    expect(referenceTypeSelect().value).toBe('IRI')
    // The group comes from the KPI family, so the composed name matches what the catalog uses.
    expect(within(namePreview()).getByText('OEE/AVAILABILITY')).toBeTruthy()
  })

  it('offers a unit the MTConnect enum does not list rather than showing blank', async () => {
    // MTBF is measured in HOUR. Without the fallback the select would silently drop the unit the
    // vocabulary had just supplied.
    await openForm()
    fireEvent.change(standardSelect(), { target: { value: 'ISO 22400' } })
    fireEvent.change(screen.getByTitle(/ISO 22400-2 key performance indicator/), { target: { value: 'MTBF' } })

    expect(unitsSelect().value).toBe('HOUR')
  })

  it('derives an OPC UA data point’s group from its browse path', async () => {
    await openForm()
    fireEvent.change(standardSelect(), { target: { value: 'OPC UA' } })
    fireEvent.change(
      screen.getByTitle(/OPC UA companion specification data point/),
      { target: { value: 'OPC 40010 Robotics::ActualPosition' } }
    )

    expect(within(namePreview()).getByText('MotionDevice/ActualPosition')).toBeTruthy()
    expect(semanticIdInput().value).toBe('http://opcfoundation.org/UA/Robotics/ActualPosition')
    // MotionDevice is not in this deployment's group registry, so it arrives pre-typed under
    // "+ New group…" rather than as a select value with no option behind it.
    expect(screen.getByPlaceholderText('e.g. Hydraulic').value).toBe('MotionDevice')
  })

  it('resolves the right row when two companion specs share a browse name', async () => {
    await openForm()
    fireEvent.change(standardSelect(), { target: { value: 'OPC UA' } })
    fireEvent.change(
      screen.getByTitle(/OPC UA companion specification data point/),
      { target: { value: 'OPC 40001 Machinery::Manufacturer' } }
    )

    expect(semanticIdInput().value).toBe('http://opcfoundation.org/UA/Machinery/Manufacturer')
    expect(within(namePreview()).getByText('Machine/Manufacturer')).toBeTruthy()
  })

  it('leaves the datatype unset, not "Double", when a group change orphans the data point', async () => {
    // The orphaning clears the whole prefill, datatype included. The select has to say so rather
    // than display its first option over a value that is no longer there.
    await openForm()
    fireEvent.change(standardSelect(), { target: { value: 'OPC UA' } })
    fireEvent.change(
      screen.getByTitle(/OPC UA companion specification data point/),
      { target: { value: 'OPC 40010 Robotics::ActualPosition' } }
    )
    expect(datatypeSelect().value).toBe('10')

    fireEvent.change(screen.getByTitle(/The category this metric belongs to/), { target: { value: 'Machine' } })

    expect(datatypeSelect().value).toBe('')
    expect(screen.getByText(/Choose a Sparkplug datatype/)).toBeTruthy()
    expect(addMetricButton().disabled).toBe(true)
  })
})

// 223P is the one vocabulary that names things rather than readings, so its prefill can say which
// concept and which semantic id but not how the value is encoded. Before #455 that undefined
// datatype was posted as-is (a NOT NULL violation the screen contradicted by showing "Double") and
// the Standard selector offered 223P with no picker behind it.
describe('Metric builder — ASHRAE 223P', () => {
  it('swaps the picker to concepts, offering classes and not relations', async () => {
    await openForm()
    fireEvent.change(standardSelect(), { target: { value: 'ASHRAE 223P' } })

    expect(screen.getByText('Concept')).toBeTruthy()
    expect(screen.queryByText('Data Item Type')).toBeNull()
    expect(screen.queryByText('Sub Type')).toBeNull()

    const offered = [...conceptSelect().querySelectorAll('option')].map(o => o.value)
    expect(offered).toContain('TemperatureSensor')
    expect(offered).toContain('Fan')
    // `BMS/hasProperty` would name nothing: a relation is a predicate, not a thing.
    expect(offered).not.toContain('hasProperty')
  })

  it('sections the picker by superclass, as the Vocabulary page does', async () => {
    await openForm()
    fireEvent.change(standardSelect(), { target: { value: 'ASHRAE 223P' } })

    const groups = [...conceptSelect().querySelectorAll('optgroup')].map(g => g.label)
    expect(groups).toContain('Sensor (1)')
    expect(groups).toContain('Equipment (1)')
  })

  it('fills the group and semantic id from a concept and leaves the datatype to the operator', async () => {
    await openForm()
    fireEvent.change(standardSelect(), { target: { value: 'ASHRAE 223P' } })
    fireEvent.change(conceptSelect(), { target: { value: 'TemperatureSensor' } })

    expect(semanticIdInput().value).toBe('http://data.ashrae.org/standard223#TemperatureSensor')
    expect(referenceTypeSelect().value).toBe('IRI')
    expect(within(namePreview()).getByText('BMS/TemperatureSensor')).toBeTruthy()

    // Nothing chosen, and the control says so rather than reading "Double".
    expect(datatypeSelect().value).toBe('')
    expect(screen.getByText(/Choose a Sparkplug datatype/)).toBeTruthy()
    expect(addMetricButton().disabled).toBe(true)
  })

  it('becomes addable once a datatype is chosen, and posts that datatype', async () => {
    await openForm()
    api.post.mockResolvedValue({})
    fireEvent.change(standardSelect(), { target: { value: 'ASHRAE 223P' } })
    fireEvent.change(conceptSelect(), { target: { value: 'TemperatureSensor' } })
    fireEvent.change(datatypeSelect(), { target: { value: '10' } })

    expect(screen.queryByText(/Choose a Sparkplug datatype/)).toBeNull()
    expect(addMetricButton().disabled).toBe(false)
    fireEvent.click(addMetricButton())

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/api/v1/metric-catalog',
      expect.objectContaining({
        name: 'BMS/TemperatureSensor',
        datatype: 10,
        standard: 'ASHRAE 223P',
        semantic_id: 'http://data.ashrae.org/standard223#TemperatureSensor',
        semantic_id_type: 'IRI'
      })
    ))
    // The datatype travelled as a number, never as undefined or ''.
    const body = api.post.mock.calls.find(([path]) => path === '/api/v1/metric-catalog')[1]
    expect(Number.isInteger(body.datatype)).toBe(true)
  })

  it('offers the 223P group under its standard, not under Local', async () => {
    await openForm()
    fireEvent.change(standardSelect(), { target: { value: 'ASHRAE 223P' } })

    const groupSelect = screen.getByTitle(/The category this metric belongs to/)
    const bms = [...groupSelect.querySelectorAll('option')].find(o => o.value === 'BMS')
    expect(bms.closest('optgroup').label).toBe('ASHRAE 223P (1)')
  })
})

describe('Metric builder — semantic id', () => {
  it('infers the reference type from a pasted IRI', async () => {
    await openForm()
    fireEvent.change(semanticIdInput(), { target: { value: 'https://example.org/concept/Torque' } })
    expect(referenceTypeSelect().value).toBe('IRI')
  })

  it('holds no reference type without an id, which would export as a Reference with no key', async () => {
    await openForm()
    api.post.mockResolvedValue({})
    fireEvent.change(screen.getByTitle(/MTConnect data item type/), { target: { value: 'ANGLE' } })
    fireEvent.change(semanticIdInput(), { target: { value: '' } })

    expect(referenceTypeSelect().disabled).toBe(true)
    expect(referenceTypeSelect().value).toBe('')
    // Forced past the disabled select, a type still does not attach to the blank id.
    fireEvent.change(referenceTypeSelect(), { target: { value: 'IRDI' } })
    fireEvent.click(addMetricButton())

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/api/v1/metric-catalog',
      expect.objectContaining({ name: 'ANGLE', semantic_id: '', semantic_id_type: '' })
    ))
  })

  it('leaves a metric addable once it has an id', async () => {
    await openForm()
    fireEvent.change(screen.getByTitle(/MTConnect data item type/), { target: { value: 'ANGLE' } })
    expect(screen.getByRole('button', { name: 'Add' }).disabled).toBe(false)
  })

  it('offers IRI and IRDI only', async () => {
    await openForm()
    expect([...referenceTypeSelect().querySelectorAll('option')].map(o => o.value)).toEqual(['', 'IRI', 'IRDI'])
  })

  it('says an Administrator can correct the id later with Edit, not that anyone can', async () => {
    await openForm()
    fireEvent.change(screen.getByTitle(/MTConnect data item type/), { target: { value: 'ANGLE' } })
    expect(namePreview().textContent).toMatch(/unlike the name, an Administrator can correct it later with Edit/)
  })

  it('retypes a prefilled IRI as an IRDI when an IRDI replaces it', async () => {
    // The shown type was the guess for the old id, so it follows the new one rather than staying
    // IRI beside an IRDI.
    await openForm()
    fireEvent.change(standardSelect(), { target: { value: 'ISO 22400' } })
    fireEvent.change(screen.getByTitle(/ISO 22400-2 key performance indicator/), { target: { value: 'AVAILABILITY' } })
    expect(referenceTypeSelect().value).toBe('IRI')

    fireEvent.change(semanticIdInput(), { target: { value: '0173-1#02-ABI218#003/0173-1#01-AGZ672#004' } })
    expect(referenceTypeSelect().value).toBe('IRDI')
  })

  it('stays addable when the operator clears the derived id entirely', async () => {
    // Unmapped must remain a legitimate state — nothing forces a semantic id on a metric.
    await openForm()
    fireEvent.change(screen.getByTitle(/MTConnect data item type/), { target: { value: 'ANGLE' } })
    fireEvent.change(semanticIdInput(), { target: { value: '' } })

    expect(semanticIdInput().value).toBe('')
    expect(screen.getByRole('button', { name: 'Add' }).disabled).toBe(false)
  })
})

describe('Metric builder — MTConnect semantic id derivation', () => {
  const typePicker = () => screen.getByTitle(/MTConnect data item type/)

  it('derives the data item type vocabulary id, in the local namespace', async () => {
    await openForm()
    fireEvent.change(typePicker(), { target: { value: 'ANGLE' } })
    fireEvent.change(screen.getByTitle(/The category this metric belongs to/), { target: { value: 'Axes' } })

    expect(semanticIdInput().value).toBe('https://aber.local/semantics/mtconnect/v2.0/DataItemType/ANGLE')
    expect(referenceTypeSelect().value).toBe('IRI')
  })

  it('derives nothing until a type is chosen', async () => {
    // With only a group picked the composed name is `Axes`, which names a group, not a metric.
    await openForm()
    fireEvent.change(screen.getByTitle(/The category this metric belongs to/), { target: { value: 'Axes' } })
    expect(semanticIdInput().value).toBe('')
  })

  it('keeps the concept id as the rest of the name is filled in', async () => {
    // The instance names the data item, not the concept: Axes/C/ANGLE and Axes/A/ANGLE share one
    // id, which is what lets a consumer group them (#457).
    await openForm()
    fireEvent.change(typePicker(), { target: { value: 'ANGLE' } })
    expect(semanticIdInput().value).toBe('https://aber.local/semantics/mtconnect/v2.0/DataItemType/ANGLE')

    fireEvent.change(screen.getByPlaceholderText('e.g. C'), { target: { value: 'C' } })
    expect(semanticIdInput().value).toBe('https://aber.local/semantics/mtconnect/v2.0/DataItemType/ANGLE')
  })

  it('derives nothing for a custom type, which no vocabulary defines', async () => {
    await openForm()
    fireEvent.change(typePicker(), { target: { value: '__custom__' } })
    fireEvent.change(screen.getByPlaceholderText('e.g. VIBRATION_RMS'), { target: { value: 'VIBRATION_RMS' } })

    expect(within(namePreview()).getByText('VIBRATION_RMS')).toBeTruthy()
    expect(semanticIdInput().value).toBe('')
    expect(referenceTypeSelect().value).toBe('')
  })

  it('stops deriving once the operator types their own', async () => {
    // A derivation that overwrote a hand-entered crosswalk on the next keystroke would be worse
    // than no prefill at all.
    await openForm()
    fireEvent.change(typePicker(), { target: { value: 'ANGLE' } })
    fireEvent.change(semanticIdInput(), { target: { value: '0173-1#02-AAO677#002' } })
    expect(referenceTypeSelect().value).toBe('IRDI')

    fireEvent.change(screen.getByPlaceholderText('e.g. C'), { target: { value: 'C' } })
    expect(semanticIdInput().value).toBe('0173-1#02-AAO677#002')
  })

  it('does not derive for the other standards, which bring their own', async () => {
    await openForm()
    fireEvent.change(standardSelect(), { target: { value: 'OPC UA' } })
    expect(semanticIdInput().value).toBe('')

    fireEvent.change(
      screen.getByTitle(/OPC UA companion specification data point/),
      { target: { value: 'OPC 40010 Robotics::ActualPosition' } }
    )
    expect(semanticIdInput().value).toBe('http://opcfoundation.org/UA/Robotics/ActualPosition')
  })
})

/**
 * The suggestion is what the metric's own standard gives it. It shows until the operator replaces
 * it and Use suggested brings it back. The latch users hit: touching Reference Type or the field
 * before choosing a type used to end the derivation until Cancel, so the form suggested nothing.
 */
describe('Metric builder — the suggested semantic id', () => {
  const ACCELERATION_ID = 'https://aber.local/semantics/mtconnect/v2.0/DataItemType/ACCELERATION'
  const ANGLE_ID = 'https://aber.local/semantics/mtconnect/v2.0/DataItemType/ANGLE'
  const ECLASS = '0173-1#02-AAO677#002'
  const groupSelect = () => screen.getByTitle(/The category this metric belongs to/)
  const typePicker = () => screen.getByTitle(/MTConnect data item type/)
  const chooseActuatorAcceleration = () => {
    fireEvent.change(groupSelect(), { target: { value: 'Actuator' } })
    fireEvent.change(typePicker(), { target: { value: 'ACCELERATION' } })
  }

  it('suggests the data item type id after IRI was chosen over an empty field', async () => {
    await openForm()
    // Disabled while the id is blank, so only a forced change reaches it now.
    expect(referenceTypeSelect().disabled).toBe(true)
    fireEvent.change(referenceTypeSelect(), { target: { value: 'IRI' } })
    chooseActuatorAcceleration()

    expect(semanticIdInput().value).toBe(ACCELERATION_ID)
    expect(referenceTypeSelect().value).toBe('IRI')
    expect(addMetricButton().disabled).toBe(false)
  })

  it('suggests it after a keystroke in the field that was then deleted', async () => {
    await openForm()
    fireEvent.change(semanticIdInput(), { target: { value: 'h' } })
    fireEvent.change(semanticIdInput(), { target: { value: '' } })
    chooseActuatorAcceleration()

    expect(semanticIdInput().value).toBe(ACCELERATION_ID)
  })

  it('marks the suggestion while it is shown, with nothing to restore', async () => {
    await openForm()
    chooseActuatorAcceleration()

    expect(screen.getByText('· suggested').title).toMatch(/ACCELERATION data item type's id/)
    expect(useSuggestedButton()).toBeNull()
  })

  it('puts the suggestion back with Use suggested once the operator has replaced it', async () => {
    await openForm()
    chooseActuatorAcceleration()
    fireEvent.change(semanticIdInput(), { target: { value: ECLASS } })
    expect(screen.queryByText('· suggested')).toBeNull()

    fireEvent.click(useSuggestedButton())

    expect(semanticIdInput().value).toBe(ACCELERATION_ID)
    expect(referenceTypeSelect().value).toBe('IRI')
    expect(useSuggestedButton()).toBeNull()
  })

  it('offers Use suggested after the suggestion was cleared, which stays legitimate until then', async () => {
    await openForm()
    chooseActuatorAcceleration()
    fireEvent.change(semanticIdInput(), { target: { value: '' } })

    expect(addMetricButton().disabled).toBe(false)
    fireEvent.click(useSuggestedButton())
    expect(semanticIdInput().value).toBe(ACCELERATION_ID)
  })

  it('keeps a typed id across a change of type, and suggests the new type', async () => {
    // A hand-entered crosswalk is never overwritten; the new type's id is one click away.
    await openForm()
    fireEvent.change(typePicker(), { target: { value: 'ANGLE' } })
    fireEvent.change(semanticIdInput(), { target: { value: ECLASS } })
    chooseActuatorAcceleration()

    expect(semanticIdInput().value).toBe(ECLASS)
    expect(referenceTypeSelect().value).toBe('IRDI')
    fireEvent.click(useSuggestedButton())
    expect(semanticIdInput().value).toBe(ACCELERATION_ID)
  })

  it('follows the type again once the suggestion is restored', async () => {
    await openForm()
    fireEvent.change(typePicker(), { target: { value: 'ANGLE' } })
    fireEvent.change(semanticIdInput(), { target: { value: ECLASS } })
    fireEvent.click(useSuggestedButton())
    expect(semanticIdInput().value).toBe(ANGLE_ID)

    fireEvent.change(typePicker(), { target: { value: 'ACCELERATION' } })
    expect(semanticIdInput().value).toBe(ACCELERATION_ID)
  })

  it('restores the id an ISO 22400 KPI carries', async () => {
    await openForm()
    fireEvent.change(standardSelect(), { target: { value: 'ISO 22400' } })
    fireEvent.change(screen.getByTitle(/ISO 22400-2 key performance indicator/), { target: { value: 'AVAILABILITY' } })
    fireEvent.change(semanticIdInput(), { target: { value: 'urn:example:availability' } })

    fireEvent.click(useSuggestedButton())
    expect(semanticIdInput().value).toBe('https://aber.local/semantics/iso22400/AVAILABILITY')
  })

  it('suggests nothing for a Custom metric, and posts its blank id as blank', async () => {
    // An invented id would only restate the name, and would hide the metric from the unmapped count.
    await openForm()
    api.post.mockResolvedValue({})
    fireEvent.change(standardSelect(), { target: { value: '' } })
    fireEvent.change(screen.getByPlaceholderText('e.g. VIBRATION_RMS'), { target: { value: 'VIBRATION_RMS' } })

    expect(semanticIdInput().value).toBe('')
    expect(screen.queryByText('· suggested')).toBeNull()
    expect(useSuggestedButton()).toBeNull()
    fireEvent.click(addMetricButton())

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/api/v1/metric-catalog',
      expect.objectContaining({ name: 'VIBRATION_RMS', standard: '', semantic_id: '', semantic_id_type: '' })
    ))
  })
})

describe('Metric Catalog table — standard and semantic id columns', () => {
  it('shows the standard a metric was named from, and names the absence of one', async () => {
    renderTab()
    await waitForCatalog()

    const mtconnectRow = screen.getByText('Axes/DISPLACEMENT').closest('tr')
    expect(within(mtconnectRow).getByText('MTConnect')).toBeTruthy()

    const localRow = screen.getByText('safety_interlock').closest('tr')
    expect(within(localRow).getAllByText('Local extension').length).toBeGreaterThan(0)
  })

  it('renders an unmapped metric as a dash rather than an empty cell', async () => {
    renderTab()
    await waitForCatalog()

    const row = screen.getByText('Axes/DISPLACEMENT').closest('tr')
    expect(within(row).getByTitle(/Not mapped to a standard concept/)).toBeTruthy()
  })

  it('renders a semantic id as a copyable value', async () => {
    const mapped = [{
      metric_uuid: 'm5', name: 'OEE/AVAILABILITY', metric_group: 'OEE', datatype: 10,
      category: 'SAMPLE', units: 'PERCENT', standard: 'ISO 22400', deprecated: false,
      semantic_id: 'https://aber.local/semantics/iso22400/AVAILABILITY',
      semantic_id_type: 'IRI'
    }]
    api.get.mockImplementation((path) =>
      Promise.resolve(path.startsWith('/api/v1/metric-catalog')
        ? mapped
        : (routes[Object.keys(routes).find(r => path.startsWith(r))] || [])))

    renderTab()
    const catalog = () => within(cardFor(/Metric Catalog/))
    // Groups start collapsed, so the row has to be revealed before it can be read.
    await waitForCatalog()
    await waitFor(() => expect(catalog().getByText('OEE/AVAILABILITY')).toBeTruthy())

    const row = catalog().getByText('OEE/AVAILABILITY').closest('tr')
    expect(within(row).getByRole('button', { name: /Copy semantic id \(IRI\)/ })).toBeTruthy()
  })
})

describe('Vocabulary handover — arriving from the Vocabulary page', () => {
  // The panel lives on the Vocabulary page (see VocabularyTab.test.jsx). This page owns the rule
  // that turns a vocabulary row into a metric, so the handover is resolved here.
  const renderWith = (entry, onConsume = vi.fn()) => render(
    <MetricsTab
      showToast={vi.fn()}
      hasPermission={() => true}
      pendingVocabularyEntry={entry}
      onConsumeVocabularyEntry={onConsume}
    />
  )

  it('opens the form on an ISO 22400 KPI, resolved from its name', async () => {
    renderWith({ standard: 'ISO 22400', name: 'AVAILABILITY' })
    await waitForCatalog()

    expect(standardSelect().value).toBe('ISO 22400')
    expect(semanticIdInput().value).toBe('https://aber.local/semantics/iso22400/AVAILABILITY')
    expect(within(namePreview()).getByText('OEE/AVAILABILITY')).toBeTruthy()
  })

  it('opens the form on an OPC UA point, resolved from spec and name together', async () => {
    renderWith({ standard: 'OPC UA', companionSpec: 'OPC 40010 Robotics', name: 'ActualPosition' })
    await waitForCatalog()

    expect(standardSelect().value).toBe('OPC UA')
    expect(within(namePreview()).getByText('MotionDevice/ActualPosition')).toBeTruthy()
  })

  it('opens the form on an MTConnect data item type', async () => {
    renderWith({ standard: 'MTConnect', type: 'ANGLE' })
    await waitForCatalog()

    expect(standardSelect().value).toBe('MTConnect')
  })

  it('opens the form on a 223P concept and waits for a datatype before it can be added', async () => {
    // The path #455 was found on: the form arrived filled, showed "Double", and posted no datatype.
    renderWith({ standard: 'ASHRAE 223P', name: 'TemperatureSensor' })
    await waitForCatalog()

    expect(standardSelect().value).toBe('ASHRAE 223P')
    expect(conceptSelect().value).toBe('TemperatureSensor')
    expect(within(namePreview()).getByText('BMS/TemperatureSensor')).toBeTruthy()
    expect(datatypeSelect().value).toBe('')
    expect(addMetricButton().disabled).toBe(true)

    fireEvent.change(datatypeSelect(), { target: { value: '12' } })
    expect(addMetricButton().disabled).toBe(false)
  })

  it('consumes the handover so returning here later does not reopen the form', async () => {
    const onConsume = vi.fn()
    renderWith({ standard: 'ISO 22400', name: 'AVAILABILITY' }, onConsume)
    await waitForCatalog()

    await waitFor(() => expect(onConsume).toHaveBeenCalled())
  })

  it('ignores an entry naming something no vocabulary has', async () => {
    // A stale handover -- a KPI removed between pages -- must not open a form half-filled with
    // whatever survived, which is what applying an unresolved entry would do.
    renderWith({ standard: 'ISO 22400', name: 'NO_SUCH_KPI' })
    await waitForCatalog()

    expect(screen.queryByText(/Devices will publish this metric as/)).toBeNull()
  })
})

// The Group picker follows the Standard selector: offering ISO 22400's KPI families under MTConnect
// invites a group that contradicts the metric's provenance, and `standard` is what an AAS export
// reads to choose a namespace.
describe('Add Metric — Group picker follows the Standard', () => {
  const openForm = async () => {
    renderTab()
    await waitForCatalog()
    fireEvent.click(screen.getByRole('button', { name: /Add Metric/ }))
  }
  const groupSelect = () => screen.getByTitle(/The category this metric belongs to/)
  // The catalog table also has a Standard column header, so match the form control's own text.
  const standardSelect = () => screen.getByTitle(/Which vocabulary this metric is named from/)
  const groupNames = () =>
    [...groupSelect().querySelectorAll('option')].map(o => o.textContent)

  it('offers MTConnect groups and local ones, but not another standard\'s', async () => {
    await openForm()

    expect(groupNames()).toContain('Axes')
    expect(groupNames()).toContain('Hydraulic')   // local: always available
    expect(groupNames()).not.toContain('OEE')
    expect(groupNames()).not.toContain('Machine')
  })

  it('swaps the options when the standard changes', async () => {
    await openForm()
    fireEvent.change(standardSelect(), { target: { value: 'ISO 22400' } })

    expect(groupNames()).toContain('OEE')
    expect(groupNames()).toContain('Hydraulic')
    expect(groupNames()).not.toContain('Axes')
  })

  it('leaves only local groups for a custom metric', async () => {
    await openForm()
    fireEvent.change(standardSelect(), { target: { value: '' } })

    expect(groupNames()).toContain('Hydraulic')
    expect(groupNames()).not.toContain('Axes')
    expect(groupNames()).not.toContain('OEE')
  })

  // Without this the selected group survives into a standard that does not offer it: the select
  // renders blank while the composed name keeps the old prefix.
  it('clears a group the new standard does not offer', async () => {
    await openForm()
    fireEvent.change(groupSelect(), { target: { value: 'Axes' } })
    expect(groupSelect().value).toBe('Axes')

    fireEvent.change(standardSelect(), { target: { value: 'ISO 22400' } })
    expect(groupSelect().value).toBe('')
  })

  it('keeps a group the new standard still offers', async () => {
    await openForm()
    fireEvent.change(groupSelect(), { target: { value: 'Hydraulic' } })

    fireEvent.change(standardSelect(), { target: { value: 'ISO 22400' } })
    // Local groups appear under every standard, so re-picking would be pointless friction.
    expect(groupSelect().value).toBe('Hydraulic')
  })

  it('records the standard on a group it registers, so the group files under it', async () => {
    // api.js used to drop `standard` here, so every group created through this form landed as
    // Local -- invisible while the picker merely bucketed, wrong once it filters.
    await openForm()
    api.post.mockResolvedValue({})

    fireEvent.change(groupSelect(), { target: { value: '__new__' } })
    fireEvent.change(screen.getByPlaceholderText('e.g. Hydraulic'), { target: { value: 'Coolant' } })
    fireEvent.change(screen.getByTitle(/MTConnect data item type/), { target: { value: 'ANGLE' } })
    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/api/v1/metric-groups',
      expect.objectContaining({ name: 'Coolant', standard: 'MTConnect' })
    ))
  })
})
