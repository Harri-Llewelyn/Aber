import React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SchemasTab } from '../components/tabs/SchemasTab'
import { api } from '../api'
import { expectCardHeading } from '../test/cardHeading'

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
  it('names the page with its icon, title and description, and no title tip', async () => {
    renderTab()
    await waitForRegistry()
    const header = expectCardHeading('Schemas', /modelled to publish/)
    expect(header).toHaveTextContent('Build Schema from Catalog')
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

  it('offers IRI and IRDI only, and types an IEC CDD id as an IRDI', async () => {
    await openBuilder()
    const type = screen.getByRole('combobox', { name: 'Reference Type' })
    expect([...type.querySelectorAll('option')].map(o => o.value)).toEqual(['', 'IRI', 'IRDI'])

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
