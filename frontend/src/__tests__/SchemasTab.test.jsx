import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SchemasTab } from '../components/tabs/SchemasTab'
import { api } from '../api'

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
