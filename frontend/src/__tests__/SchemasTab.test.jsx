import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SchemasTab } from '../components/tabs/SchemasTab'
import { api } from '../api'
import { expectCardHeading, expectSearchFirst, expectToolbarButton } from '../test/cardHeading'

/**
 * The schema registry. The metric catalog left this page for its own (MetricsTab.test.jsx), so
 * what is left here is the registry and the one route into it: a schema may only be built from
 * catalog rows, which is what guarantees every metric it names carries a standard and a semantic
 * id. Everything downstream -- device tags, unmodelled-metric detection, the tag filters -- reads
 * those, so a free-text JSON Schema box would be the hole they all fall through.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const CATALOG = [
  { metric_uuid: 'm1', name: 'Axes/DISPLACEMENT', datatype: 10, category: 'SAMPLE', standard: 'MTConnect', deprecated: false }
]

const routes = {
  '/api/v1/schemas': [],
  '/api/v1/metric-catalog': CATALOG,
  '/api/v1/gateways': [],
  '/api/v1/devices': []
}

const renderTab = (hasPermission = () => true) => render(
  <SchemasTab showToast={vi.fn()} hasPermission={hasPermission} onSelectSchema={vi.fn()} />
)

/** The registry renders its empty state once the load resolves; that is the gate. */
const waitForRegistry = () =>
  waitFor(() => expect(screen.getByText(/No schemas registered yet/)).toBeTruthy())

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation((path) => {
    const key = Object.keys(routes).find(r => path.startsWith(r))
    return Promise.resolve(key ? routes[key] : [])
  })
})

describe('the schemas card header', () => {
  it('names the page with its icon, title and description, and no title tip, and its button in the toolbar', async () => {
    renderTab()
    await waitForRegistry()
    expectCardHeading('Schemas', /modelled to publish/)
    expectToolbarButton(/Build Schema from Catalog/)
  })

  it('starts the toolbar with the search box, then the status', async () => {
    renderTab()
    await waitForRegistry()
    expect(expectSearchFirst('Search the schema registry').nextElementSibling)
      .toBe(screen.getByLabelText('Filter schemas by lifecycle state'))
  })
})

/**
 * The registry rows: the Devices column is a link that says what it counts, a row opens the
 * drawer by mouse and by keyboard, and the drawer carries the schema's icon and one primary.
 */
describe('the registry rows', () => {
  const schema = (n, name) => ({
    schema_uuid: `${n}${n}${n}${n}0000-0000-4000-8000-00000000000${n}`, schema_name: name,
    version: 1, status: 'active', parent_schema_id: null, schema_definition: { properties: {} }
  })
  const S1 = schema(1, 'Three_Devices')
  const S2 = schema(2, 'One_Device')
  const S3 = schema(3, 'No_Devices')
  const device = (id, schemaId) => ({ asset_id: id, asset_name: id, submodel_schema_ids: [schemaId] })

  let onSelectSchema
  const renderRegistry = async () => {
    onSelectSchema = vi.fn()
    api.get.mockImplementation((path) => Promise.resolve({
      '/api/v1/schemas': [S1, S2, S3],
      '/api/v1/metric-catalog': CATALOG,
      '/api/v1/devices': [device('d1', S1.schema_uuid), device('d2', S1.schema_uuid), device('d3', S1.schema_uuid), device('d4', S2.schema_uuid)]
    }[path] || []))
    render(<SchemasTab showToast={vi.fn()} hasPermission={() => true} onSelectSchema={onSelectSchema} />)
    await waitFor(() => expect(screen.getByText('Three_Devices')).toBeTruthy())
  }
  const devicesCell = (name) => screen.getByText(name).closest('tr').lastElementChild

  it('words the Devices link "3 devices" and "1 device", with a plain dash at zero', async () => {
    await renderRegistry()

    expect(devicesCell('Three_Devices').querySelector('a.count-link')).toHaveTextContent(/^3 devices$/)
    expect(devicesCell('Three_Devices').querySelector('a.count-link')).toHaveAttribute('href', `/devices?schema=${S1.schema_uuid}`)
    expect(devicesCell('One_Device').querySelector('a.count-link')).toHaveTextContent(/^1 device$/)
    expect(devicesCell('No_Devices')).toHaveTextContent(/^—$/)
    expect(devicesCell('No_Devices').querySelector('a, button')).toBeNull()
    // No pill markup anywhere in the column, and none on the card heading.
    expect(document.querySelector('tbody .section-count')).toBeNull()
    expect(document.querySelector('.card-heading .section-count')).toBeNull()
  })

  it('opens the Devices page filtered to the schema, without opening the drawer', async () => {
    await renderRegistry()

    fireEvent.click(screen.getByRole('link', { name: '3 devices' }))
    expect(onSelectSchema).toHaveBeenCalledWith(S1.schema_uuid)
    expect(document.querySelector('.row-selected')).toBeNull()
  })

  it('opens the drawer from the row on Enter and on Space, and only from the row itself', async () => {
    await renderRegistry()
    const row = screen.getByText('Three_Devices').closest('tr')
    expect(row).toHaveClass('row-selectable')
    expect(row).toHaveAttribute('tabIndex', '0')

    fireEvent.keyDown(row, { key: 'Enter' })
    expect(row).toHaveClass('row-selected')
    fireEvent.keyDown(row, { key: ' ' })
    expect(row).not.toHaveClass('row-selected')

    // Enter on the link inside the row is the link's, not the row's.
    fireEvent.keyDown(screen.getByRole('link', { name: '3 devices' }), { key: 'Enter' })
    expect(row).not.toHaveClass('row-selected')
  })

  it('titles the drawer with the schema icon and lists one primary action first', async () => {
    await renderRegistry()
    fireEvent.click(screen.getByText('Three_Devices'))

    const panel = document.querySelector('.context-panel')
    expect(panel.querySelector('.context-panel-icon svg')).toBeTruthy()
    const primaries = panel.querySelectorAll('.context-panel-actions .btn-primary')
    expect(primaries).toHaveLength(1)
    expect(panel.querySelector('.context-panel-actions .context-action')).toBe(primaries[0])
    expect(primaries[0]).toBe(within(panel).getByRole('button', { name: /View Schema Detail/ }))
  })
})

/**
 * Sorting the registry (#801): Version by its number, and Devices by the devices attached, each
 * counted once however many times it lists the schema.
 */
describe('the registry sorts by a column (#801)', () => {
  const schema = (n, name, version) => ({
    schema_uuid: `${n}${n}${n}${n}0000-0000-4000-8000-00000000000${n}`, schema_name: name,
    version, status: 'active', parent_schema_id: null, schema_definition: { properties: {} }
  })
  // In this order from the API. Robot_Schema predates versioning, so it has no number and reads v1.
  const LATHE = schema(1, 'Lathe_Schema', 9)
  const PRESS = schema(2, 'Press_Schema', 10)
  const ROBOT = schema(3, 'Robot_Schema', null)
  const OVEN = schema(4, 'Oven_Schema', 2)
  const device = (id, ...schemas) => ({ asset_id: id, asset_name: id, submodel_schema_ids: schemas.map(s => s.schema_uuid) })
  // Lathe 3, Press 2 (d1 lists it twice), Robot 1, Oven none.
  const DEVICES = [
    device('d1', PRESS, PRESS), device('d2', PRESS), device('d3', LATHE), device('d4', LATHE), device('d5', LATHE, ROBOT)
  ]

  const renderSorted = async (url = '/schemas') => {
    window.history.replaceState(null, '', url)
    api.get.mockImplementation((path) => Promise.resolve({
      '/api/v1/schemas': [LATHE, PRESS, ROBOT, OVEN],
      '/api/v1/metric-catalog': CATALOG,
      '/api/v1/devices': DEVICES
    }[path] || []))
    renderTab()
    await waitFor(() => expect(screen.getByText('Lathe_Schema')).toBeTruthy())
  }
  const names = () => [...document.querySelectorAll('.table-wrap tbody tr')].map(r => r.querySelector('strong').textContent)
  const address = () => window.location.pathname + window.location.search

  it('sorts Version by its number, so v10 follows v9, and reverses on a second click', async () => {
    await renderSorted()
    const header = screen.getByRole('columnheader', { name: 'Version' })
    expect(within(screen.getByText('Robot_Schema').closest('tr')).getByText('v1 · Active')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Version' }))
    expect(names()).toEqual(['Robot_Schema', 'Oven_Schema', 'Lathe_Schema', 'Press_Schema'])
    expect(header).toHaveAttribute('aria-sort', 'ascending')
    expect(address()).toBe('/schemas?sort=version')

    fireEvent.click(screen.getByRole('button', { name: 'Version' }))
    expect(names()).toEqual(['Press_Schema', 'Lathe_Schema', 'Oven_Schema', 'Robot_Schema'])
    expect(header).toHaveAttribute('aria-sort', 'descending')
    expect(address()).toBe('/schemas?sort=-version')
  })

  it('sorts Devices by the count the link shows, with the dash at zero sorting as none', async () => {
    await renderSorted()
    expect(screen.getByRole('link', { name: '2 devices' }).closest('tr')).toBe(screen.getByText('Press_Schema').closest('tr'))

    fireEvent.click(screen.getByRole('button', { name: 'Devices' }))
    expect(names()).toEqual(['Oven_Schema', 'Robot_Schema', 'Press_Schema', 'Lathe_Schema'])
    fireEvent.click(screen.getByRole('button', { name: 'Devices' }))
    expect(names()).toEqual(['Lathe_Schema', 'Press_Schema', 'Robot_Schema', 'Oven_Schema'])
  })

  it('opens sorted when the address already holds a sort', async () => {
    await renderSorted('/schemas?sort=-devices')
    expect(names()).toEqual(['Lathe_Schema', 'Press_Schema', 'Robot_Schema', 'Oven_Schema'])
    expect(screen.getByRole('columnheader', { name: 'Devices' })).toHaveAttribute('aria-sort', 'descending')
    expect(address()).toBe('/schemas?sort=-devices')
  })
})

/** A picker's group heading counts what is ticked in it, not how big the group is. */
describe('the builder group headings', () => {
  const PICKER = [
    { metric_uuid: 'a1', name: 'Axes/DISPLACEMENT', datatype: 10, standard: 'MTConnect', deprecated: false },
    { metric_uuid: 'a2', name: 'Axes/VELOCITY', datatype: 10, standard: 'MTConnect', deprecated: false },
    { metric_uuid: 'c1', name: 'Controller/EXECUTION', datatype: 12, standard: 'MTConnect', deprecated: false }
  ]

  const band = (label) => [...document.querySelectorAll('.modal .metric-picker-group')]
    .find(b => b.querySelector('.table-group-label').textContent === label)

  it('says nothing until a metric is ticked, then "N selected"; the overall count stays', async () => {
    api.get.mockImplementation((path) => Promise.resolve(
      path === '/api/v1/metric-catalog' ? PICKER : []))
    renderTab()
    await waitForRegistry()
    fireEvent.click(screen.getByRole('button', { name: /Build Schema from Catalog/ }))
    await waitFor(() => expect(band('Axes')).toBeTruthy())

    expect(band('Axes')).toHaveTextContent(/^Axes$/)
    expect(band('Controller')).toHaveTextContent(/^Controller$/)

    fireEvent.click(screen.getByRole('checkbox', { name: /Axes\/DISPLACEMENT/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Axes\/VELOCITY/ }))
    expect(band('Axes')).toHaveTextContent(/^Axes2 selected$/)
    expect(band('Controller')).toHaveTextContent(/^Controller$/)
    expect(screen.getByText('2 selected', { selector: '.form-label .section-count' })).toBeTruthy()

    // The opaque band is a class, not an inline glass tint.
    expect(band('Axes').getAttribute('style')).toBeNull()
  })
})

describe('Schema actions', () => {
  it('offers Build Schema from Catalog as the only way to create a schema', async () => {
    // Register New Schema no longer takes a raw JSON Schema document as free text, which could name
    // metrics outside the catalog with no standard and no semantic id.
    renderTab()
    await waitForRegistry()

    expect(screen.getByRole('button', { name: /Build Schema from Catalog/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Register New Schema/ })).toBeNull()
  })

  it('gates the builder behind the manage permission', async () => {
    renderTab(() => false)
    await waitForRegistry()

    expect(screen.getByRole('button', { name: /Build Schema from Catalog/ }).disabled).toBe(true)
  })
})

describe('what the page no longer loads', () => {
  /**
   * The catalog is still read, for the builder and the detail modal's metric picker. The four
   * vocabularies are not: they existed for the Add Metric form's type picker, which is on the
   * Metrics page now, and leaving them here would be four requests per visit feeding nothing.
   */
  it('reads the catalog but none of the standard vocabularies', async () => {
    renderTab()
    await waitForRegistry()

    const paths = api.get.mock.calls.map(([p]) => p)
    expect(paths).toContain('/api/v1/metric-catalog')
    for (const vocabulary of [
      '/api/v1/mtconnect-vocabulary',
      '/api/v1/iso22400-vocabulary',
      '/api/v1/opcua-vocabulary',
      '/api/v1/ashrae223-vocabulary',
      '/api/v1/metric-groups'
    ]) {
      expect(paths, `${vocabulary} is fetched by a page with no type picker`).not.toContain(vocabulary)
    }
  })
})

/**
 * The builder builds a schema and nothing else. A device is given its schema on the Devices page,
 * where its cell, area and conformance policy are decided too; the definition is downloaded from
 * this page's context panel.
 */
describe('the schema builder builds a schema', () => {
  const openBuilder = async () => {
    renderTab()
    await waitForRegistry()
    fireEvent.click(screen.getByRole('button', { name: /Build Schema from Catalog/ }))
    // The name field, not the title: the trigger button carries that text too.
    await waitFor(() => expect(screen.getByLabelText(/Schema Name/)).toBeTruthy())
  }

  it('offers no device provisioning and no spec sheet', async () => {
    await openBuilder()

    // Selecting a metric is what used to reveal the provisioning fields.
    fireEvent.click(screen.getByRole('checkbox'))

    expect(screen.queryByText(/Device Name/i)).toBeNull()
    expect(screen.queryByText(/Assigned Edge Gateway/i)).toBeNull()
    expect(screen.queryByText(/Group ID/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /Provision/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /Download Spec/i })).toBeNull()
  })

  it('never registers a device', async () => {
    await openBuilder()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.change(screen.getByLabelText(/Schema Name/), { target: { value: 'KUKA_R2e_Schema' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save Schema$/ }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/v1/schemas', expect.anything()))
    expect(api.post).not.toHaveBeenCalledWith('/api/v1/devices', expect.anything())
  })

  it('does not fetch gateways, which nothing on the page reads any more', async () => {
    renderTab()
    await waitForRegistry()
    expect(api.get.mock.calls.map(([p]) => p)).not.toContain('/api/v1/gateways')
  })
})

/**
 * Saving used to be refused by a disabled button with no explanation, which cannot answer the
 * question a reader who has just tried to save is asking. The button stays clickable and the click
 * is what says what is missing.
 */
describe('the builder says why it will not save', () => {
  const openBuilder = async () => {
    renderTab()
    await waitForRegistry()
    fireEvent.click(screen.getByRole('button', { name: /Build Schema from Catalog/ }))
    // The name field, not the title: the trigger button carries that text too.
    await waitFor(() => expect(screen.getByLabelText(/Schema Name/)).toBeTruthy())
  }

  it('accuses nobody before they have tried to save', async () => {
    await openBuilder()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('names the empty name, and saves nothing', async () => {
    await openBuilder()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: /^Save Schema$/ }))

    await waitFor(() => expect(screen.getByText(/Give the schema a name/)).toBeTruthy())
    expect(api.post).not.toHaveBeenCalled()
  })

  it('names the empty metric picker too', async () => {
    await openBuilder()
    fireEvent.change(screen.getByLabelText(/Schema Name/), { target: { value: 'Named_But_Empty' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save Schema$/ }))

    await waitFor(() => expect(screen.getByText(/Tick at least one metric/)).toBeTruthy())
    expect(api.post).not.toHaveBeenCalled()
  })

  it('says what is still needed on the button itself, before it is clicked', async () => {
    await openBuilder()
    const save = screen.getByRole('button', { name: /^Save Schema$/ })
    expect(save.getAttribute('title')).toMatch(/a name and at least one metric/)
  })

  it('saves once the form is complete', async () => {
    await openBuilder()
    fireEvent.change(screen.getByLabelText(/Schema Name/), { target: { value: 'KUKA_R2e_Schema' } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: /^Save Schema$/ }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/api/v1/schemas',
      expect.objectContaining({ schema_name: 'KUKA_R2e_Schema' })
    ))
  })

  it('explains the semantic id rather than leaving it to be guessed at', async () => {
    await openBuilder()
    expect(screen.getByRole('button', { name: /What a semantic ID is for/ })).toBeTruthy()
  })

  it('offers IRI, IRDI and ExpandedNodeId only, and types an IEC CDD id as an IRDI', async () => {
    await openBuilder()
    const type = screen.getByRole('combobox', { name: 'Reference Type' })
    expect([...type.querySelectorAll('option')].map(o => o.value)).toEqual(['', 'IRI', 'IRDI', 'ExpandedNodeId'])

    fireEvent.change(screen.getByRole('textbox', { name: /Semantic ID/ }), { target: { value: '0112/2///61987#ABA565#009' } })
    expect(type.value).toBe('IRDI')

    fireEvent.change(screen.getByLabelText(/Schema Name/), { target: { value: 'Nameplate_Schema' } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: /^Save Schema$/ }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/api/v1/schemas',
      expect.objectContaining({ semantic_id: '0112/2///61987#ABA565#009', semantic_id_type: 'IRDI' })
    ))
  })
})

describe('the builder reads an OPC UA id', () => {
  it('types an ExpandedNodeId as one', async () => {
    renderTab()
    await waitForRegistry()
    fireEvent.click(screen.getByRole('button', { name: /Build Schema from Catalog/ }))
    await waitFor(() => expect(screen.getByLabelText(/Schema Name/)).toBeTruthy())

    fireEvent.change(screen.getByRole('textbox', { name: /Semantic ID/ }),
      { target: { value: 'nsu=http://opcfoundation.org/UA/Machinery/;i=1012' } })
    expect(screen.getByRole('combobox', { name: 'Reference Type' }).value).toBe('ExpandedNodeId')
  })
})
