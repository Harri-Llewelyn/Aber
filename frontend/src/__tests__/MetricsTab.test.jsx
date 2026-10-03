import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { MetricsTab } from '../components/tabs/MetricsTab'
import { api } from '../api'
import { PERMISSION_UUIDS } from '../constants'
import { requiresRolesTitle } from '../hooks/usePermissions'

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

// A slice of idta_submodel_templates: the Digital Nameplate identifies most elements by IEC CDD IRDI
// and a few by IRI, and records which.
const NAMEPLATE = {
  template_id: 'https://admin-shell.io/idta/nameplate/3/0/Nameplate', template_name: 'Digital Nameplate', template_version: '3.0'
}
const TEMPLATE_ELEMENTS = [
  { ...NAMEPLATE, id_short: 'ManufacturerName', semantic_id: '0112/2///61987#ABA565#009', semantic_id_type: 'IRDI', description: 'Legal name of the manufacturer.' },
  { ...NAMEPLATE, id_short: 'SerialNumber', semantic_id: '0112/2///61987#ABA951#009', semantic_id_type: 'IRDI', description: 'Serial number of this instance.' },
  { ...NAMEPLATE, id_short: 'UniqueFacilityIdentifier', semantic_id: 'https://admin-shell.io/idta/nameplate/3/0/UniqueFacilityIdentifier', semantic_id_type: 'IRI', description: 'Facility the product was made in.' }
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
  '/api/v1/idta-submodel-templates': TEMPLATE_ELEMENTS,
  '/api/v1/gateways': [],
  '/api/v1/devices': []
}

const APP_CSS = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8')

const renderTab = () => render(
  <MetricsTab showToast={vi.fn()} hasPermission={() => true} />
)

/**
 * The table on a tab of the page's one card, selecting that tab first. Located by the tab's name,
 * not by position. Null until the tab's table renders.
 */
const cardTable = (tabName) => {
  const tab = screen.queryByRole('tab', { name: tabName })
  if (!tab) return null
  if (tab.getAttribute('aria-selected') !== 'true') fireEvent.click(tab)
  return document.querySelector('.card table')
}

const catalogTable = () => cardTable('Metric Catalog')

/** The metric drawer, open while a row is selected. */
const drawer = () => document.querySelector('.context-panel')
const drawerButton = (name) => within(drawer()).getByRole('button', { name })

/** Selecting a row opens the drawer. `table` scopes the name, which the drawer title repeats. */
const selectMetric = (table, name) => {
  fireEvent.click(within(table).getByText(name).closest('tr'))
  return within(drawer())
}

/**
 * Waits for the catalog to render, then opens every group. The groups default to collapsed, so the
 * gate waits on a group header and then expands the sections the assertions read.
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

describe('Metrics page: one card with two tabs', () => {
  it('names the page in the card heading, with the rail icon and a one-sentence description', async () => {
    renderTab()
    await waitFor(() => expect(catalogTable()).toBeTruthy())

    expect(document.querySelector('.page-heading')).toBeNull()
    expect(document.querySelectorAll('.card')).toHaveLength(1)
    const heading = document.querySelector('.card-heading')
    expect(heading.querySelector('h3.section-title').textContent).toBe('Metrics')
    expect(heading.querySelector('h3 svg')).toBeTruthy()
    const description = heading.querySelector('.card-heading-description').textContent
    expect(description.match(/[.!?](\s|$)/g)).toHaveLength(1)
    expect(description.split(' ').length).toBeLessThanOrEqual(28)
  })

  it('puts the tabs directly in the card, catalog first and selected, Deprecated always present', async () => {
    renderTab()
    await waitFor(() => expect(catalogTable()).toBeTruthy())

    const tablist = screen.getByRole('tablist')
    expect(tablist.parentElement).toHaveClass('card')
    expect(screen.getAllByRole('tab').map(t => t.textContent)).toEqual(['Metric Catalog', 'Deprecated Metrics'])
    expect(screen.getByRole('tab', { name: 'Metric Catalog' }).getAttribute('aria-selected')).toBe('true')
  })

  it('scrolls the table inside the card, not the page', async () => {
    renderTab()
    await waitFor(() => expect(catalogTable()).toBeTruthy())

    const fill = document.querySelector('.page-fill .card-fill')
    expect(fill).toBeTruthy()
    expect(catalogTable().parentElement).toHaveClass('table-wrap')
    expect(catalogTable().parentElement.parentElement).toBe(fill)
    expect(deprecatedTableOf().parentElement.parentElement).toBe(fill)
  })

  it('carries no count on the card, its tabs or the group headings', async () => {
    renderTab()
    await waitFor(() => expect(catalogTable()).toBeTruthy())

    expect(document.querySelector('.card .section-count')).toBeNull()
    for (const tab of screen.getAllByRole('tab')) expect(tab.textContent).not.toMatch(/\d/)
  })

  it('puts the tab’s "?" first in the toolbar row and Add Metric at its right-hand end', async () => {
    renderTab()
    await waitFor(() => expect(catalogTable()).toBeTruthy())

    const bar = screen.getByRole('tablist').nextElementSibling
    expect(bar).toHaveClass('filter-bar')
    expect(bar.firstElementChild).toBe(screen.getByRole('button', { name: 'About the metric catalog' }))
    expect(screen.getByRole('button', { name: /Add Metric/ }).closest('.filter-bar-actions').parentElement).toBe(bar)

    deprecatedTableOf()
    const deprecatedBar = screen.getByRole('tablist').nextElementSibling
    expect(deprecatedBar.firstElementChild).toBe(screen.getByRole('button', { name: 'About deprecated metrics' }))
    expect(screen.queryByRole('button', { name: /Add Metric/ })).toBeNull()
  })

  it('closes the drawer when the tab changes, since its row is no longer listed', async () => {
    renderTab()
    await waitForCatalog()

    selectMetric(catalogTable(), 'Axes/DISPLACEMENT')
    expect(drawer().getAttribute('aria-hidden')).toBe('false')
    fireEvent.click(screen.getByRole('tab', { name: 'Deprecated Metrics' }))
    expect(drawer().getAttribute('aria-hidden')).toBe('true')
  })
})

/** The Deprecated Metrics tab's table, selecting the tab first. */
const deprecatedTableOf = () => cardTable('Deprecated Metrics')

describe('Metric Catalog — collapsible groups', () => {
  it('opens COLLAPSED, showing each group header rather than every row', async () => {
    // Collapsed on arrival: the catalog outgrew being unrolled.
    renderTab()

    await waitFor(() => expect(screen.getByTitle('Expand Controller (2 metrics)')).toBeTruthy())
    expect(screen.queryByText('Axes/DISPLACEMENT')).toBeNull()
    expect(screen.queryByText('Controller/EXECUTION')).toBeNull()
    expect(screen.queryByText('safety_interlock')).toBeNull()

    // The header names the group and carries no count; its tooltip says how many it holds.
    const header = screen.getByTitle('Expand Controller (2 metrics)')
    expect(within(header).getByText('Controller')).toBeTruthy()
    expect(header.querySelector('.section-count')).toBeNull()
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
    // Actions live in the drawer, not in the row.
    expect(within(row).queryByRole('button')).toBeNull()
  })
})

// A second deprecated row that names a replacement, so the Superseded By column has a name to show.
const WITH_REPLACEMENT = [
  ...CATALOG,
  { metric_uuid: 'm8', name: 'Controller/OLD_EXECUTION', metric_group: 'Controller', datatype: 12, category: 'EVENT', standard: 'MTConnect', deprecated: true, superseded_by: 'm2' }
]

/**
 * Deprecated metrics have a tab of their own, where Restore is one row away, rather than a
 * collapsed tail inside the catalog table.
 */
describe('Deprecated Metrics tab', () => {
  const withCatalog = (rows) => api.get.mockImplementation((path) =>
    Promise.resolve(path.startsWith('/api/v1/metric-catalog')
      ? rows
      : (routes[Object.keys(routes).find(r => path.startsWith(r))] || [])))

  const deprecatedTable = () => cardTable('Deprecated Metrics')

  it('lists deprecated metrics on their own tab, and not in the catalog table', async () => {
    renderTab()
    await waitForCatalog()
    await waitFor(() => expect(deprecatedTable()).toBeTruthy())

    expect(within(deprecatedTable()).getByText('temperature')).toBeTruthy()
    // Every group is open, so absence here means the row is not in the catalog at all.
    expect(within(catalogTable()).queryByText('temperature')).toBeNull()
  })

  it('keeps the tab when nothing is deprecated, and says so', async () => {
    withCatalog(CATALOG.filter(m => !m.deprecated))
    renderTab()
    await waitForCatalog()

    fireEvent.click(screen.getByRole('tab', { name: 'Deprecated Metrics' }))
    expect(screen.getByText('No metric is deprecated.')).toBeTruthy()
    expect(document.querySelector('.card table')).toBeNull()
  })

  it('names the replacement, not its uuid', async () => {
    withCatalog(WITH_REPLACEMENT)
    renderTab()
    await waitFor(() => expect(deprecatedTable()).toBeTruthy())

    const row = within(deprecatedTable()).getByText('Controller/OLD_EXECUTION').closest('tr')
    expect(within(row).getByText('Controller/EXECUTION')).toBeTruthy()
    expect(within(row).queryByText('m2')).toBeNull()
  })

  it('is not narrowed by the catalog search, which belongs to the catalog tab', async () => {
    renderTab()
    await waitFor(() => expect(catalogTable()).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Search the metric catalog'), { target: { value: 'EXECUTION' } })
    expect(within(deprecatedTable()).getByText('temperature')).toBeTruthy()
    expect(screen.queryByLabelText('Search the metric catalog')).toBeNull()
  })

  it('disables Restore and Deprecate for a Shopfloor Manager, who holds archive:manage and not schema:manage', async () => {
    render(<MetricsTab showToast={vi.fn()} hasPermission={(p) => p !== PERMISSION_UUIDS.SCHEMA_MANAGE} />)
    await waitFor(() => expect(deprecatedTable()).toBeTruthy())

    selectMetric(deprecatedTable(), 'temperature')
    const restore = drawerButton('Restore')
    expect(restore.disabled).toBe(true)
    expect(restore.title).toBe(requiresRolesTitle(PERMISSION_UUIDS.SCHEMA_MANAGE))
    await waitForCatalog()
    selectMetric(catalogTable(), 'Axes/DISPLACEMENT')
    const deprecate = drawerButton('Deprecate')
    expect(deprecate.disabled).toBe(true)
    expect(deprecate.title).toBe(requiresRolesTitle(PERMISSION_UUIDS.SCHEMA_MANAGE))
  })

  it('keeps the card and its rows on screen while the catalog reloads', async () => {
    renderTab()
    await waitFor(() => expect(deprecatedTable()).toBeTruthy())

    let release
    api.get.mockImplementation((path) => (path.startsWith('/api/v1/metric-catalog')
      ? new Promise(resolve => { release = () => resolve(CATALOG) })
      : Promise.resolve(routes[Object.keys(routes).find(r => path.startsWith(r))] || [])))
    api.post.mockResolvedValue({})
    selectMetric(deprecatedTable(), 'temperature')
    fireEvent.click(drawerButton('Restore'))
    fireEvent.click(screen.getByRole('button', { name: 'Restore Metric' }))
    await waitFor(() => expect(release).toBeTruthy())

    expect(within(deprecatedTable()).getByText('temperature')).toBeTruthy()
    expect(screen.queryByText('Loading catalog…')).toBeNull()
    release()
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
    selectMetric(cardTable('Deprecated Metrics'), name)
    fireEvent.click(drawerButton('Restore'))
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
    selectMetric(catalogTable(), 'Axes/DISPLACEMENT')
    fireEvent.click(drawerButton('Deprecate'))
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

  const openEdit = (name) => {
    selectMetric(catalogTable(), name)
    fireEvent.click(drawerButton('Edit'))
    return within(document.querySelector('.modal'))
  }

  it('offers Edit in the drawer, disabled for a Shopfloor Manager as Deprecate is', async () => {
    await setup((p) => p !== PERMISSION_UUIDS.SCHEMA_MANAGE)

    selectMetric(catalogTable(), 'Controller/EXECUTION')
    const edit = drawerButton('Edit')
    expect(edit.disabled).toBe(true)
    expect(edit.title).toBe(requiresRolesTitle(PERMISSION_UUIDS.SCHEMA_MANAGE))
    fireEvent.click(edit)
    expect(document.querySelector('.modal')).toBeNull()
  })

  it('offers Edit on a deprecated metric too, which still carries its id into schemas', async () => {
    await setup()
    selectMetric(cardTable('Deprecated Metrics'), 'temperature')
    expect(drawerButton('Edit').disabled).toBe(false)
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

    expect(modal.getByText('Suggested')).toBeTruthy()
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
    expect(modal.queryByText('Suggested')).toBeNull()
  })

  it('points a metric at a nameplate element chosen from the search, not typed', async () => {
    api.put.mockResolvedValue({ id: 'm3' })
    await setup()
    const modal = openEdit('Controller/FIRMWARE')
    fireEvent.click(modal.getByRole('button', { name: 'Search vocabularies' }))
    fireEvent.change(modal.getByRole('textbox', { name: 'Search the vocabularies and templates' }), { target: { value: 'serial' } })
    fireEvent.click(within(modal.getByRole('list', { name: 'Matching concepts' })).getAllByRole('button')[0])

    expect(modal.getByRole('combobox', { name: 'Reference Type' }).value).toBe('IRDI')
    expect(modal.getByRole('note').textContent).toMatch(/SerialNumber comes from IDTA Digital Nameplate 3\.0/)
    fireEvent.click(modal.getByRole('button', { name: 'Save Semantic ID' }))

    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/api/v1/metric-catalog/m3', {
      semantic_id: '0112/2///61987#ABA951#009', semantic_id_type: 'IRDI'
    }))
  })

  it('keeps the label row to the label and its help, so the narrow dialog does not wrap it', async () => {
    // Seen live: in the 480px dialog, Use suggested and Search vocabularies beside the label wrapped
    // it onto three lines and pushed the search button over the Reference Type select.
    await setup()
    const modal = openEdit('Controller/EXECUTION')
    const labelRow = document.querySelector('label[for="metric-edit-semantic-id"]').parentElement
    expect(labelRow.contains(modal.getByText('Suggested'))).toBe(false)

    fireEvent.change(modal.getByRole('textbox', { name: /Semantic ID/ }), { target: { value: '' } })
    for (const name of ['Use suggested', 'Search vocabularies']) {
      expect(labelRow.contains(modal.getByRole('button', { name })), `${name} sits in the label row`).toBe(false)
    }
  })

  it('closes only the search on Escape, and the dialog on the next one', async () => {
    await setup()
    const modal = openEdit('Controller/FIRMWARE')
    fireEvent.click(modal.getByRole('button', { name: 'Search vocabularies' }))
    fireEvent.change(modal.getByRole('textbox', { name: 'Search the vocabularies and templates' }), { target: { value: 'serial' } })
    // From a result as much as from the search box: both sit in the panel.
    fireEvent.keyDown(within(modal.getByRole('list', { name: 'Matching concepts' })).getAllByRole('button')[0], { key: 'Escape' })

    expect(document.querySelector('.modal')).toBeTruthy()
    expect(modal.queryByRole('textbox', { name: 'Search the vocabularies and templates' })).toBeNull()
    expect(document.activeElement).toBe(modal.getByRole('button', { name: 'Search vocabularies' }))
    expect(api.put).not.toHaveBeenCalled()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.querySelector('.modal')).toBeNull()
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

  it('lets a group the search opened be closed', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByTitle('Expand Controller (2 metrics)')).toBeTruthy())

    fireEvent.change(search(), { target: { value: 'EXECUTION' } })
    fireEvent.click(screen.getByTitle('Collapse Controller'))
    expect(screen.queryByText('Controller/EXECUTION')).toBeNull()
  })
})

describe('Metric Catalog — Expand all / Collapse all', () => {
  const allButton = () => screen.getByRole('button', { name: /^(Expand|Collapse) all$/ })
  const groupToggles = () => [...catalogTable().querySelectorAll('.table-group-button')]
  const openGroups = () => groupToggles().filter(b => b.getAttribute('aria-expanded') === 'true').length

  it('sits in the toolbar row and reads "Expand all" while every group is shut', async () => {
    renderTab()
    await waitFor(() => expect(catalogTable()).toBeTruthy())

    expect(allButton().closest('.filter-bar')).toBeTruthy()
    expect(allButton().textContent).toBe('Expand all')
    expect(openGroups()).toBe(0)
  })

  it('opens every group, then reads "Collapse all" and shuts them again', async () => {
    renderTab()
    await waitFor(() => expect(catalogTable()).toBeTruthy())

    fireEvent.click(allButton())
    expect(openGroups()).toBe(groupToggles().length)
    expect(screen.getByText('safety_interlock')).toBeTruthy()
    expect(allButton().textContent).toBe('Collapse all')

    fireEvent.click(allButton())
    expect(openGroups()).toBe(0)
    expect(allButton().textContent).toBe('Expand all')
  })

  it('closes the groups a search opened, and keeps the search', async () => {
    renderTab()
    await waitFor(() => expect(catalogTable()).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Search the metric catalog'), { target: { value: 'o' } })
    expect(openGroups()).toBe(groupToggles().length)
    expect(allButton().textContent).toBe('Collapse all')

    fireEvent.click(allButton())
    expect(openGroups()).toBe(0)
    expect(screen.queryByText('Controller/EXECUTION')).toBeNull()
    expect(screen.getByLabelText('Search the metric catalog').value).toBe('o')
    expect(allButton().textContent).toBe('Expand all')
  })

  it('pins each group heading below the table header while its rows scroll', () => {
    // jsdom does no layout, so the rule is read from the stylesheet: the band sticks at the pinned
    // header's height inside the card's table scroller.
    expect(APP_CSS).toMatch(/\n\.table-group-row > td \{\n {2}position: sticky;\n {2}top: var\(--table-head-height, 0px\);/)
    expect(APP_CSS).toMatch(/\n\.card-fill > \.table-wrap \{ --table-head-height: 40px; \}/)
  })
})

describe('Metric Catalog — Add Metric dialog', () => {
  const addButton = () => screen.getByRole('button', { name: /Add Metric/ })

  it('is a filled toolbar button that opens no form until pressed', async () => {
    renderTab()
    await waitForCatalog()

    expect(addButton().textContent).toContain('Add Metric')
    expect(addButton().className).toContain('btn-primary')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText('Data Item Type')).toBeNull()
  })

  it('opens a dialog carrying the form', async () => {
    renderTab()
    await waitForCatalog()

    fireEvent.click(addButton())

    const dialog = screen.getByRole('dialog', { name: 'Add Metric' })
    expect(within(dialog).getByText('Data Item Type')).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'Add' })).toBeTruthy()
  })

  it('closes on Cancel and on Escape', async () => {
    renderTab()
    await waitForCatalog()

    fireEvent.click(addButton())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(addButton())
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('discards what was typed, so a reopened dialog does not inherit stale input', async () => {
    renderTab()
    await waitForCatalog()

    fireEvent.click(addButton())
    const description = screen.getByPlaceholderText('What this metric represents')
    fireEvent.change(description, { target: { value: 'half-finished note' } })
    expect(description.value).toBe('half-finished note')

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(addButton())

    expect(screen.getByPlaceholderText('What this metric represents').value).toBe('')
  })

  it('disables the control without the manage permission, and names the role that holds it', async () => {
    render(<MetricsTab showToast={vi.fn()} hasPermission={() => false} />)
    await waitForCatalog()

    expect(addButton().disabled).toBe(true)
    expect(addButton().title).toBe(requiresRolesTitle(PERMISSION_UUIDS.SCHEMA_MANAGE))
    fireEvent.click(addButton())
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows a refused add in the dialog, which stays open', async () => {
    api.post.mockRejectedValueOnce(new Error('duplicate key'))
    await openFormForError()
    expect(screen.getByRole('alert').textContent).toMatch(/duplicate key/)
    expect(screen.getByRole('dialog', { name: 'Add Metric' })).toBeTruthy()
  })
})

// Fills the smallest valid MTConnect metric and presses Add.
const openFormForError = async () => {
  renderTab()
  await waitForCatalog()
  fireEvent.click(screen.getByRole('button', { name: /Add Metric/ }))
  fireEvent.change(screen.getByTitle(/The MTConnect data item type/), { target: { value: 'ANGLE' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add' }))
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
}

describe('Metric drawer', () => {
  it('opens on a row with its fields and closes on a second click', async () => {
    renderTab()
    await waitForCatalog()

    const inDrawer = selectMetric(catalogTable(), 'Axes/DISPLACEMENT')
    expect(drawer().getAttribute('aria-hidden')).toBe('false')
    expect(inDrawer.getByText('MILLIMETER')).toBeTruthy()
    expect(inDrawer.getByRole('button', { name: 'Edit' })).toBeTruthy()
    expect(inDrawer.getByRole('button', { name: 'Deprecate' })).toBeTruthy()
    expect(inDrawer.queryByRole('button', { name: 'Restore' })).toBeNull()

    fireEvent.click(within(catalogTable()).getByText('Axes/DISPLACEMENT').closest('tr'))
    expect(drawer().getAttribute('aria-hidden')).toBe('true')
  })

  it('offers Restore, not Deprecate, on a deprecated metric', async () => {
    renderTab()
    await waitFor(() => expect(cardTable('Deprecated Metrics')).toBeTruthy())

    const inDrawer = selectMetric(cardTable('Deprecated Metrics'), 'temperature')
    expect(inDrawer.getByRole('button', { name: 'Restore' })).toBeTruthy()
    expect(inDrawer.queryByRole('button', { name: 'Deprecate' })).toBeNull()
  })

  it('shows the metric icon and one primary, listed first: Edit on a catalog metric', async () => {
    renderTab()
    await waitForCatalog()

    selectMetric(catalogTable(), 'Axes/DISPLACEMENT')
    expect(drawer().querySelector('.context-panel-icon svg')).toBeTruthy()
    const actions = [...drawer().querySelectorAll('.context-action')]
    expect(actions.filter(a => a.classList.contains('btn-primary'))).toHaveLength(1)
    expect(actions[0].textContent).toMatch(/Edit/)
    expect(actions[0]).toHaveClass('btn-primary')
  })

  it('makes Restore the one primary on a deprecated metric, listed first', async () => {
    renderTab()
    await waitFor(() => expect(cardTable('Deprecated Metrics')).toBeTruthy())

    selectMetric(cardTable('Deprecated Metrics'), 'temperature')
    const actions = [...drawer().querySelectorAll('.context-action')]
    expect(actions.filter(a => a.classList.contains('btn-primary'))).toHaveLength(1)
    expect(actions[0].textContent).toMatch(/Restore/)
    expect(actions[0]).toHaveClass('btn-primary')
  })

  it('opens from a row on Enter, on both tabs, and every row is a selectable row', async () => {
    renderTab()
    await waitForCatalog()

    const row = within(catalogTable()).getByText('Axes/DISPLACEMENT').closest('tr')
    expect(row).toHaveClass('row-selectable')
    expect(row.tabIndex).toBe(0)
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(drawer().getAttribute('aria-hidden')).toBe('false')
    expect(within(drawer()).getAllByText('Axes/DISPLACEMENT').length).toBeGreaterThan(0)

    const deprecatedRow = within(cardTable('Deprecated Metrics')).getByText('temperature').closest('tr')
    expect(deprecatedRow).toHaveClass('row-selectable')
    fireEvent.keyDown(deprecatedRow, { key: ' ' })
    expect(within(drawer()).getByRole('button', { name: 'Restore' })).toBeTruthy()
  })

  it('leaves a key pressed on the copy chip to the chip, and toggles closed on a second Enter', async () => {
    api.get.mockImplementation((path) => Promise.resolve(path.startsWith('/api/v1/metric-catalog')
      ? CATALOG.map(m => (m.metric_uuid === 'm1' ? { ...m, semantic_id: 'https://aber.local/semantics/x/DISPLACEMENT', semantic_id_type: 'IRI' } : m))
      : (routes[Object.keys(routes).find(r => path.startsWith(r))] || [])))
    renderTab()
    await waitForCatalog()

    const row = within(catalogTable()).getByText('Axes/DISPLACEMENT').closest('tr')
    fireEvent.keyDown(within(row).getByRole('button', { name: /Copy semantic id/ }), { key: 'Enter' })
    expect(drawer().getAttribute('aria-hidden')).toBe('true')

    fireEvent.keyDown(row, { key: 'Enter' })
    expect(drawer().getAttribute('aria-hidden')).toBe('false')
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(drawer().getAttribute('aria-hidden')).toBe('true')
  })
})

// Multi-standard metric builder (MTConnect / ISO 22400 / OPC UA / ASHRAE 223P) and semantic ids

const standardSelect = () => screen.getByTitle(/Which vocabulary this metric is named from/)
// The Add Metric form's SemanticIdField, the only one on the page while no dialog is open.
const semanticIdInput = () => screen.getByRole('textbox', { name: /Semantic ID/ })
const referenceTypeSelect = () => screen.getByRole('combobox', { name: 'Reference Type' })
const useSuggestedButton = () => screen.queryByRole('button', { name: 'Use suggested' })
// The Datatype column header shares the picker's first sentence, so the query names the element kind.
const datatypeSelect = () =>
  screen.getAllByTitle(/How the value is encoded on the wire/).find(el => el.tagName === 'SELECT')
const conceptSelect = () => screen.getByTitle(/The ASHRAE 223P concept this point is attached to/)
const addMetricButton = () => screen.getByRole('button', { name: /^Add$/ })

// The Units column header has a title of its own, but a query by title text can still match the
// wrong element kind, so it names the select.
const unitsSelect = () =>
  screen.getAllByTitle(/The unit of measure|Only SAMPLE data items carry units/).find(el => el.tagName === 'SELECT')

/** The "Devices will publish this metric as …" line. */
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

    fireEvent.change(screen.getByTitle(/The component this metric belongs to/), { target: { value: 'Machine' } })

    expect(datatypeSelect().value).toBe('')
    expect(screen.getByText(/Choose a Sparkplug datatype/)).toBeTruthy()
    expect(addMetricButton().disabled).toBe(true)
  })
})

/**
 * Two companion specifications can define one browse name: the seed has Manufacturer, Mass and
 * PowerOnDuration twice each. The API orders by spec, so a lookup by name alone finds Machinery's
 * Manufacturer whichever was chosen.
 */
describe('Metric builder — OPC UA points that share a browse name', () => {
  const AM_MANUFACTURER = {
    name: 'Manufacturer', companion_spec: 'OPC 40540 Additive Manufacturing',
    node_id: 'nsu=http://opcfoundation.org/UA/AdditiveManufacturing/;s=FeedstockType/Manufacturer',
    datatype: 'String', unit: null, description: 'Manufacturer of the feedstock.',
    semantic_id: 'http://opcfoundation.org/UA/AdditiveManufacturing/Manufacturer'
  }
  const AM_KEY = 'OPC 40540 Additive Manufacturing::Manufacturer'
  const groupSelect = () => screen.getByTitle(/The component this metric belongs to/)
  const dataPointSelect = () => screen.getByTitle(/OPC UA companion specification data point/)

  // FeedstockType is registered, so the prefill selects it as a group rather than typing it new.
  const mockVocabularies = () => api.get.mockImplementation((path) => Promise.resolve(
    path.startsWith('/api/v1/opcua-vocabulary') ? [...OPCUA_VOCABULARY, AM_MANUFACTURER]
      : path.startsWith('/api/v1/metric-groups')
        ? [...routes['/api/v1/metric-groups'], { group_uuid: 'g7', name: 'FeedstockType', standard: 'OPC UA' }]
        : (routes[Object.keys(routes).find(r => path.startsWith(r))] || [])))

  const chooseSecondManufacturer = async () => {
    mockVocabularies()
    await openForm()
    fireEvent.change(standardSelect(), { target: { value: 'OPC UA' } })
    fireEvent.change(dataPointSelect(), { target: { value: AM_KEY } })
  }

  it('shows the second specification\'s point as the one chosen', async () => {
    await chooseSecondManufacturer()

    expect(dataPointSelect().value).toBe(AM_KEY)
    expect(within(namePreview()).getByText('FeedstockType/Manufacturer')).toBeTruthy()
    expect(semanticIdInput().value).toBe(AM_MANUFACTURER.semantic_id)
  })

  it('keeps the point and its suggested id when the group is set back to the point\'s own', async () => {
    await chooseSecondManufacturer()
    fireEvent.change(groupSelect(), { target: { value: '' } })
    fireEvent.change(groupSelect(), { target: { value: 'FeedstockType' } })

    expect(dataPointSelect().value).toBe(AM_KEY)
    expect(within(namePreview()).getByText('FeedstockType/Manufacturer')).toBeTruthy()
    expect(semanticIdInput().value).toBe(AM_MANUFACTURER.semantic_id)
    expect(screen.getByText('Suggested')).toBeTruthy()
  })

  it('clears the point when the group is the other specification\'s', async () => {
    // Machine is where Machinery's Manufacturer files, not the feedstock's.
    await chooseSecondManufacturer()
    fireEvent.change(groupSelect(), { target: { value: 'Machine' } })

    expect(dataPointSelect().value).toBe('')
    expect(semanticIdInput().value).toBe('')
  })

  it('arrives from the Vocabulary page on the second specification\'s point', async () => {
    mockVocabularies()
    render(
      <MetricsTab
        showToast={vi.fn()}
        hasPermission={() => true}
        pendingVocabularyEntry={{ standard: 'OPC UA', companionSpec: 'OPC 40540 Additive Manufacturing', name: 'Manufacturer' }}
        onConsumeVocabularyEntry={vi.fn()}
      />
    )
    await waitForCatalog()

    await waitFor(() => expect(dataPointSelect().value).toBe(AM_KEY))
    expect(semanticIdInput().value).toBe(AM_MANUFACTURER.semantic_id)
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

    const groupSelect = screen.getByTitle(/The component this metric belongs to/)
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
    fireEvent.change(screen.getByTitle(/The component this metric belongs to/), { target: { value: 'Axes' } })

    expect(semanticIdInput().value).toBe('https://aber.local/semantics/mtconnect/v2.0/DataItemType/ANGLE')
    expect(referenceTypeSelect().value).toBe('IRI')
  })

  it('derives nothing until a type is chosen', async () => {
    // With only a group picked the composed name is `Axes`, which names a group, not a metric.
    await openForm()
    fireEvent.change(screen.getByTitle(/The component this metric belongs to/), { target: { value: 'Axes' } })
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
 * before choosing a type ended the derivation until Cancel, so the form suggested nothing.
 */
describe('Metric builder — the suggested semantic id', () => {
  const ACCELERATION_ID = 'https://aber.local/semantics/mtconnect/v2.0/DataItemType/ACCELERATION'
  const ANGLE_ID = 'https://aber.local/semantics/mtconnect/v2.0/DataItemType/ANGLE'
  const ECLASS = '0173-1#02-AAO677#002'
  const groupSelect = () => screen.getByTitle(/The component this metric belongs to/)
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

    expect(screen.getByText('Suggested').title).toMatch(/ACCELERATION data item type's id/)
    expect(useSuggestedButton()).toBeNull()
  })

  it('puts the suggestion back with Use suggested once the operator has replaced it', async () => {
    await openForm()
    chooseActuatorAcceleration()
    fireEvent.change(semanticIdInput(), { target: { value: ECLASS } })
    expect(screen.queryByText('Suggested')).toBeNull()

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
    expect(screen.queryByText('Suggested')).toBeNull()
    expect(useSuggestedButton()).toBeNull()
    fireEvent.click(addMetricButton())

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/api/v1/metric-catalog',
      expect.objectContaining({ name: 'VIBRATION_RMS', standard: '', semantic_id: '', semantic_id_type: '' })
    ))
  })
})

/**
 * Every concept the platform holds an id for can be chosen rather than typed: the four vocabularies
 * and the IDTA template elements, which the AAS exporter matches by semantic id, so a typo there
 * fails silently.
 */
describe('Metric builder — choosing a semantic id from the vocabularies', () => {
  const MANUFACTURER_NAME = '0112/2///61987#ABA565#009'
  const openSearch = () => fireEvent.click(screen.getByRole('button', { name: 'Search vocabularies' }))
  const search = (text) =>
    fireEvent.change(screen.getByRole('textbox', { name: 'Search the vocabularies and templates' }), { target: { value: text } })
  const options = () => within(screen.getByRole('list', { name: 'Matching concepts' })).getAllByRole('button')
  const typePicker = () => screen.getByTitle(/MTConnect data item type/)

  it('lists matches from every source with their standard and id', async () => {
    await openForm()
    openSearch()
    search('manufacturer')

    const listed = options().map(o => o.textContent)
    expect(listed.some(t => t.includes('ManufacturerName') && t.includes('IDTA Digital Nameplate 3.0') && t.includes(MANUFACTURER_NAME))).toBe(true)
    expect(listed.some(t => t.includes('Manufacturer') && t.includes('OPC UA') && t.includes('http://opcfoundation.org/UA/Machinery/Manufacturer'))).toBe(true)
  })

  it('sets the id and the reference type the template records, and closes', async () => {
    await openForm()
    openSearch()
    search('ManufacturerName')
    fireEvent.click(options()[0])

    expect(semanticIdInput().value).toBe(MANUFACTURER_NAME)
    expect(referenceTypeSelect().value).toBe('IRDI')
    expect(screen.queryByRole('textbox', { name: 'Search the vocabularies and templates' })).toBeNull()
  })

  it('says what a cross-standard choice costs, and keeps the metric MTConnect', async () => {
    await openForm()
    api.post.mockResolvedValue({})
    fireEvent.change(typePicker(), { target: { value: 'ANGLE' } })
    openSearch()
    expect(screen.getByText(/A metric carries one semantic id: another standard's concept replaces the MTConnect one/)).toBeTruthy()
    search('ManufacturerName')
    fireEvent.click(options()[0])

    expect(screen.getByRole('note').textContent)
      .toMatch(/ManufacturerName comes from IDTA Digital Nameplate 3\.0\. A metric carries\s+one semantic id, so it replaces any MTConnect id; the metric stays MTConnect/)
    expect(useSuggestedButton()).toBeTruthy()
    fireEvent.click(addMetricButton())

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/api/v1/metric-catalog',
      expect.objectContaining({
        name: 'ANGLE', standard: 'MTConnect', semantic_id: MANUFACTURER_NAME, semantic_id_type: 'IRDI'
      })
    ))
  })

  it('makes no cost note for the metric\'s own concept, which is its suggestion', async () => {
    await openForm()
    fireEvent.change(typePicker(), { target: { value: 'ANGLE' } })
    fireEvent.change(semanticIdInput(), { target: { value: '' } })
    openSearch()
    search('ANGLE')
    fireEvent.click(options()[0])

    expect(semanticIdInput().value).toBe('https://aber.local/semantics/mtconnect/v2.0/DataItemType/ANGLE')
    expect(screen.getByText('Suggested')).toBeTruthy()
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('maps a Custom metric to a standard concept without minting one', async () => {
    await openForm()
    fireEvent.change(standardSelect(), { target: { value: '' } })
    fireEvent.change(screen.getByPlaceholderText('e.g. VIBRATION_RMS'), { target: { value: 'VIBRATION_RMS' } })
    openSearch()
    search('availability')
    fireEvent.click(options()[0])

    expect(semanticIdInput().value).toBe('https://aber.local/semantics/iso22400/AVAILABILITY')
    expect(referenceTypeSelect().value).toBe('IRI')
    // A local extension has no standard of its own for the choice to replace.
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('leaves out 223P relations, which name no concept a metric measures', async () => {
    await openForm()
    openSearch()
    search('hasProperty')

    expect(screen.queryByRole('list', { name: 'Matching concepts' })).toBeNull()
    expect(screen.getByText(/Nothing matches “hasProperty”/)).toBeTruthy()
  })

  it('keeps free text: an id no source holds is typed as before', async () => {
    await openForm()
    openSearch()
    fireEvent.click(screen.getByRole('button', { name: 'Close search' }))
    fireEvent.change(semanticIdInput(), { target: { value: 'urn:example:torque' } })

    expect(semanticIdInput().value).toBe('urn:example:torque')
    expect(referenceTypeSelect().value).toBe('IRI')
  })

  it('reads each reference table once per visit, not again after a change to the catalog', async () => {
    await openForm()
    api.post.mockResolvedValue({})
    fireEvent.change(typePicker(), { target: { value: 'ANGLE' } })
    fireEvent.click(addMetricButton())
    await waitFor(() => expect(api.get.mock.calls.filter(([p]) => p === '/api/v1/metric-catalog').length).toBe(2))

    for (const table of ['/api/v1/mtconnect-vocabulary', '/api/v1/idta-submodel-templates']) {
      expect(api.get.mock.calls.filter(([p]) => p === table)).toHaveLength(1)
    }
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

  it('renders a semantic id as a copyable value that keeps its end', async () => {
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
    const catalog = () => within(catalogTable())
    // Groups start collapsed, so the row has to be revealed before it can be read.
    await waitForCatalog()
    await waitFor(() => expect(catalog().getByText('OEE/AVAILABILITY')).toBeTruthy())

    const row = catalog().getByText('OEE/AVAILABILITY').closest('tr')
    const chip = within(row).getByRole('button', { name: /Copy semantic id \(IRI\)/ })
    // Cut in the middle: every id shares the prefix, so the end is what tells two apart.
    expect(chip.querySelector('.copyable-id-tail').textContent).toBe('cs/iso22400/AVAILABILITY')
  })

  it('writes Standard, Category and Datatype as plain text in the row\'s one meta style', async () => {
    renderTab()
    await waitForCatalog()

    const row = screen.getByText('Axes/DISPLACEMENT').closest('tr')
    expect(row.querySelector('.badge')).toBeNull()
    for (const text of ['MTConnect', 'SAMPLE', 'Double', 'MILLIMETER']) {
      expect(within(row).getByText(text).closest('td')).toHaveClass('cell-meta')
    }
  })

  it('shares one fixed column set between the two tabs', async () => {
    renderTab()
    await waitForCatalog()

    const cols = (table) => [...table.querySelectorAll(':scope > colgroup > col')].map(c => c.className)
    const catalogCols = cols(catalogTable())
    const deprecatedCols = cols(cardTable('Deprecated Metrics'))
    expect(catalogCols).toHaveLength(7)
    expect(deprecatedCols.slice(0, 7)).toEqual(catalogCols)
    expect(deprecatedCols[7]).toBe('metric-col-superseded')
    // Fixed layout: the widths come from the colgroup, not from the rows that happen to be open.
    expect(APP_CSS).toMatch(/\n\.metric-table \{ table-layout: fixed;/)
    for (const c of catalogCols.filter(Boolean)) {
      expect(APP_CSS).toMatch(new RegExp(`\\n\\.${c} \\{ width: \\d+px; \\}`))
    }
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

  it('opens the dialog on an ISO 22400 KPI, resolved from its name', async () => {
    renderWith({ standard: 'ISO 22400', name: 'AVAILABILITY' })
    await waitForCatalog()

    expect(standardSelect().value).toBe('ISO 22400')
    expect(semanticIdInput().value).toBe('https://aber.local/semantics/iso22400/AVAILABILITY')
    expect(within(namePreview()).getByText('OEE/AVAILABILITY')).toBeTruthy()
  })

  it('opens the dialog on an OPC UA point, resolved from spec and name together', async () => {
    renderWith({ standard: 'OPC UA', companionSpec: 'OPC 40010 Robotics', name: 'ActualPosition' })
    await waitForCatalog()

    expect(standardSelect().value).toBe('OPC UA')
    expect(within(namePreview()).getByText('MotionDevice/ActualPosition')).toBeTruthy()
  })

  it('opens the dialog on an MTConnect data item type', async () => {
    renderWith({ standard: 'MTConnect', type: 'ANGLE' })
    await waitForCatalog()

    expect(standardSelect().value).toBe('MTConnect')
  })

  it('opens the dialog on a 223P concept and waits for a datatype before it can be added', async () => {
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

  it('consumes the handover so returning here later does not reopen the dialog', async () => {
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
  const groupSelect = () => screen.getByTitle(/The component this metric belongs to/)
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
