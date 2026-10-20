import React from 'react'
import { render, screen, waitFor, fireEvent, within, configure } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import App from '../App'
import { api } from '../api'
import { supabase } from '../lib/supabaseClient'
import { TABS } from '../navigation'

/**
 * The export warning's hand-over through the whole dashboard: a device exported with a metric that
 * has no semantic id warns in a toast, and the toast opens the Metrics catalog with Unmapped on.
 * The pieces are tested apart (deviceExportModal, MetricsTab, aasExport); this holds the wiring
 * App adds between them, and which roles are offered the link.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(),
      getUser: vi.fn(),
      onAuthStateChange: vi.fn(),
      signOut: vi.fn()
    },
    channel: vi.fn().mockReturnValue({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnThis()
    }),
    removeChannel: vi.fn(),
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: [], error: null })
    })
  }
}))

vi.mock('../utils/downloadJSON', () => ({ downloadJSON: vi.fn() }))
vi.mock('../utils/downloadBlob', () => ({ downloadBlob: vi.fn() }))

// Each page is a lazy chunk, and a cold transform of the larger ones can outlast the 1 s default.
configure({ asyncUtilTimeout: 8000 })
vi.setConfig({ testTimeout: 20000 })

const sessionFor = (role) => ({
  user: { id: `user-${role}`, email: `${role}@aber.local`, app_metadata: { role } }
})

const DEVICE = {
  asset_id: 'aaaaaaaa-0000-4000-8000-000000000001', asset_name: 'CNC_01',
  sparkplug_id: 'devaaaaaaaa000040008000', status: 'ONLINE', is_quarantined: false,
  is_archived: false, active_gateway_id: 'gw-1', cell_id: 'cell-1', submodel_schema_ids: [],
  first_dbirth_at: '2026-07-27T12:00:00Z', created_at: '2026-07-20T12:00:00Z'
}

const CATALOG = [
  { metric_uuid: 'c1', name: 'Axes/DISPLACEMENT', metric_group: 'Axes', datatype: 10, category: 'SAMPLE', standard: 'MTConnect', semantic_id: 'https://aber.local/semantics/mtconnect/DISPLACEMENT', deprecated: false },
  { metric_uuid: 'c2', name: 'Controller/EXECUTION', metric_group: 'Controller', datatype: 12, category: 'EVENT', standard: 'MTConnect', semantic_id: null, deprecated: false },
  { metric_uuid: 'c3', name: 'safety_interlock', metric_group: null, datatype: 11, category: null, standard: null, semantic_id: null, deprecated: false }
]

const ROUTES = [
  ['/api/v1/devices', [DEVICE]],
  ['/api/v1/gateways', [{ gateway_id: 'gw-1', gateway_name: 'Line_A_Gateway', cell_id: 'cell-1', status: 'ONLINE', is_archived: false, devices: [] }]],
  ['/api/v1/cells', [{ cell_id: 'cell-1', cell_name: 'Cell 1' }]],
  ['/api/v1/metric-catalog', CATALOG]
]

/** Opens the app on the Devices page as `role`, and runs an AAS JSON export that leaves two metrics unmapped. */
const exportAs = async (role) => {
  supabase.auth.getSession.mockResolvedValue({ data: { session: sessionFor(role) } })
  supabase.auth.getUser.mockResolvedValue({ data: { user: sessionFor(role).user }, error: null })
  window.history.pushState({}, '', '/devices')
  render(<App />)

  fireEvent.click(await screen.findByText(DEVICE.asset_name, { selector: '.page-main *' }))
  fireEvent.click(within(document.querySelector('.context-panel')).getByRole('button', { name: /Export…/ }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Export' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
}

beforeEach(() => {
  vi.clearAllMocks()
  window.sessionStorage.clear()
  supabase.auth.onAuthStateChange.mockImplementation(() => ({ data: { subscription: { unsubscribe: vi.fn() } } }))
  supabase.auth.signOut.mockResolvedValue({ error: null })
  api.get.mockImplementation((path) => Promise.resolve(ROUTES.find(([prefix]) => path.startsWith(prefix))?.[1] ?? []))
  api.post.mockResolvedValue({
    aas: {}, stats: { submodels: 3, telemetry_metrics: 11, unmapped_semantic_ids: 2 }
  })
})

describe('the export warning about unmapped metrics', () => {
  it('opens the Metrics catalog with Unmapped on, and goes away', async () => {
    await exportAs('Administrator')

    const toast = await screen.findByRole('link', { name: /2 metrics carried no semantic id\. Open them on the Metrics page/ })
    expect(toast).toHaveAttribute('title', 'Go to Metrics')
    expect(toast).toHaveAttribute('href', '/metrics?unmapped=1')
    fireEvent.click(toast)

    await waitFor(() => expect(window.location.pathname).toBe('/metrics'))
    const unmapped = await screen.findByRole('button', { name: /^Unmapped \(\d+\)$/ })
    expect(unmapped).toHaveAttribute('aria-pressed', 'true')
    // The button renders before the catalog arrives, so its count is read once the rows are in.
    expect(await screen.findByText('Controller/EXECUTION')).toBeInTheDocument()
    expect(unmapped).toHaveTextContent('Unmapped (2)')
    expect(screen.getByText('safety_interlock')).toBeInTheDocument()
    expect(screen.queryByText('Axes/DISPLACEMENT')).toBeNull()
    expect(screen.queryByRole('link', { name: /carried no semantic id/ })).toBeNull()
  })

  it('applies once: leaving the Metrics page and coming back by the navigation starts unfiltered', async () => {
    await exportAs('Administrator')
    fireEvent.click(await screen.findByRole('link', { name: /Open them on the Metrics page/ }))
    await screen.findByRole('button', { name: /^Unmapped \(\d+\)$/ })

    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', { name: 'Devices' }))
    await waitFor(() => expect(window.location.pathname).toBe('/devices'))
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', { name: 'Metrics' }))

    const unmapped = await screen.findByRole('button', { name: /^Unmapped \(\d+\)$/ })
    expect(unmapped).toHaveAttribute('aria-pressed', 'false')
  })

  it.each(['Administrator', 'Shopfloor_Manager', 'Operator', 'Auditor'])(
    'is offered to %s, because every role has the Metrics page',
    async (role) => {
      await exportAs(role)
      expect(await screen.findByRole('link', { name: /Open them on the Metrics page/ })).toBeInTheDocument()
    }
  )
})

/**
 * Every role has the Metrics page today. The link is still offered only to a reader who has it, so
 * a page gated later does not leave the warning pointing at a blank page: here the page is given a
 * role gate for the test.
 */
describe('the export warning for a role that cannot open the Metrics page', () => {
  const metricsPage = TABS.find(t => t.id === 'metrics')
  beforeEach(() => { metricsPage.role = 'Administrator' })
  afterEach(() => { delete metricsPage.role })

  it('stays plain text', async () => {
    await exportAs('Operator')

    expect(await screen.findByText(/2 metrics carried no semantic id/)).toBeInTheDocument()
    expect(screen.queryByText(/Metrics page/)).toBeNull()
    expect(screen.queryByRole('link', { name: /carried no semantic id/ })).toBeNull()
  })

  it('is still a link for a role that can open it', async () => {
    await exportAs('Administrator')

    expect(await screen.findByRole('link', { name: /Open them on the Metrics page/ })).toBeInTheDocument()
  })
})
