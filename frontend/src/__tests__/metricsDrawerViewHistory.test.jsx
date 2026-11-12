/**
 * The Metrics page's drawer says View History on every tab it opens one on (Metric Catalog, Derived and
 * Deprecated Metrics), as the Devices, Cells and Areas drawers do: an ordinary link to the History page's
 * Metric tab with that metric chosen, shown to every role. The Metric tab reads the metric from that
 * address. uPlot draws on a canvas jsdom does not have, so a stand-in is mounted.
 */
import React from 'react'
import { render, screen, waitFor, fireEvent, within, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MetricsTab } from '../components/tabs/MetricsTab'
import { HistoryTab } from '../components/tabs/HistoryTab'
import { api } from '../api'
import { PERMISSION_UUIDS } from '../constants'
import { metricHistoryUrl } from '../routes'
import { metricHistoryPath } from '../utils/history'
import { queryTabLink } from '../test/tabBar'

vi.mock('../hooks/usePolling', () => ({ usePolling: () => {} }))

vi.mock('uplot', () => {
  class FakePlot {
    constructor(opts, data, target) {
      this.over = document.createElement('div')
      this.over.className = 'u-over'
      target.appendChild(this.over)
    }
    setSize() {}
    destroy() { this.over.remove() }
  }
  FakePlot.paths = { stepped: () => () => null }
  return { default: FakePlot }
})

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: {
      get: vi.fn(), post: vi.fn(), put: vi.fn(), readCarriedTelemetry: vi.fn(), readTelemetryChanges: vi.fn(),
      readHourOfDay: vi.fn(), readAlertOccurrences: vi.fn(),
    },
  }
})

const metric = (id, name, datatype, extra = {}) => ({
  metric_uuid: id, name, metric_group: name.split('/')[0], datatype, standard: null, deprecated: false, derivation: null, ...extra,
})

const CATALOG = [
  metric('m1', 'Spindle/LOAD', 10, { units: 'kW' }),
  metric('m2', 'Power/OLD_METER', 10, { units: 'kW', deprecated: true }),
  metric('d1', 'Spindle/LOAD_PER_HOUR', 10, { derivation: { kind: 'counter_rate', input: 'Spindle/LOAD' } }),
]

const LATHE = '2b3e0c4a-1111-4000-8000-000000000001'
const devices = [
  { asset_id: LATHE, asset_name: 'Lathe 3', last_birth_metrics: ['Spindle/LOAD'], effective_cell_id: 'c1', location_source: 'inherited', status: 'ONLINE' },
]

const routes = {
  '/api/v1/schemas': [],
  '/api/v1/metric-catalog': CATALOG,
  '/api/v1/metric-groups': [{ group_uuid: 'g1', name: 'Spindle', standard: null }, { group_uuid: 'g2', name: 'Power', standard: null }],
  '/api/v1/uncatalogued-metrics': [],
  '/api/v1/devices': devices,
  '/api/v1/cells': [{ cell_id: 'c1', cell_name: 'Turning', area_id: 'a1' }],
  '/api/v1/areas': [{ area_id: 'a1', area_name: 'Hall B' }],
}

const drawer = () => document.querySelector('.context-panel')
const rowOf = (table, name) => within(table).getByText(name)

/** The Metrics page on a tab, with the metric's drawer open. */
const openDrawer = async ({ tab = null, name, ...props }) => {
  render(<MetricsTab showToast={vi.fn()} hasPermission={() => true} {...props} />)
  if (tab) {
    await waitFor(() => expect(queryTabLink(tab)).toBeTruthy())
    fireEvent.click(queryTabLink(tab))
  }
  await waitFor(() => expect(document.querySelector('.card table')).toBeTruthy())
  // The catalog's groups start collapsed: open them before a row can be chosen.
  if (!tab) {
    await waitFor(() => expect(within(document.querySelector('.card table')).getAllByRole('button', { expanded: false }).length).toBeGreaterThan(0))
    for (const header of within(document.querySelector('.card table')).getAllByRole('button', { expanded: false })) fireEvent.click(header)
  }
  fireEvent.click(rowOf(document.querySelector('.card table'), name))
  await waitFor(() => expect(drawer().getAttribute('aria-hidden')).toBe('false'))
  return within(drawer())
}

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation((path) => {
    const key = Object.keys(routes).find(r => path.startsWith(r))
    return Promise.resolve(key ? routes[key] : [])
  })
  api.readCarriedTelemetry.mockResolvedValue([])
  api.readTelemetryChanges.mockResolvedValue([])
  api.readHourOfDay.mockResolvedValue([])
  api.readAlertOccurrences.mockResolvedValue([])
  document.documentElement.setAttribute('data-theme', 'dark')
  window.history.pushState({}, '', '/metrics')
})

afterEach(() => {
  cleanup()
  window.history.pushState({}, '', '/')
})

describe("the Metrics page's drawer: View History", () => {
  it('builds the Metric tab path, the metric one encoded segment, as the tab builds its own', () => {
    expect(metricHistoryUrl('Spindle/LOAD')).toBe('/history/metric/Spindle%2FLOAD')
    expect(metricHistoryUrl('Spindle/LOAD')).toBe(metricHistoryPath('Spindle/LOAD'))
    expect(metricHistoryUrl('a b')).toBe(metricHistoryPath('a b'))
  })

  it('is on the Metric Catalog drawer, a link to the Metric tab on that metric', async () => {
    const panel = await openDrawer({ name: 'Spindle/LOAD' })
    expect(panel.getByRole('link', { name: /View History/ })).toHaveAttribute('href', '/history/metric/Spindle%2FLOAD')
  })

  it('is on the Derived drawer, with no special case for a derived metric', async () => {
    const panel = await openDrawer({ tab: 'Derived', name: 'Spindle/LOAD_PER_HOUR' })
    expect(panel.getByRole('link', { name: /View History/ })).toHaveAttribute('href', '/history/metric/Spindle%2FLOAD_PER_HOUR')
  })

  it('is on the Deprecated Metrics drawer', async () => {
    const panel = await openDrawer({ tab: 'Deprecated Metrics', name: 'Power/OLD_METER' })
    expect(panel.getByRole('link', { name: /View History/ })).toHaveAttribute('href', '/history/metric/Power%2FOLD_METER')
  })

  it('sits before View Audit Trail, as the Cells and Areas drawers place it', async () => {
    const panel = await openDrawer({ name: 'Spindle/LOAD' })
    const links = panel.getAllByRole('link').map(l => l.textContent.trim())
    expect(links.findIndex(t => /View History/.test(t))).toBeGreaterThanOrEqual(0)
    expect(links.findIndex(t => /View History/.test(t))).toBeLessThan(links.findIndex(t => /View Audit Trail/.test(t)))
  })

  it('is shown to a reader who cannot open the Audit Trail', async () => {
    const panel = await openDrawer({ name: 'Spindle/LOAD', hasPermission: (p) => p !== PERMISSION_UUIDS.AUDIT_TRAIL_READ })
    expect(panel.queryByRole('link', { name: /View Audit Trail/ })).toBeNull()
    expect(panel.getByRole('link', { name: /View History/ })).toHaveAttribute('href', '/history/metric/Spindle%2FLOAD')
  })

  it('is shown to a reader who holds no permission at all, whose Deprecate is off', async () => {
    const panel = await openDrawer({ name: 'Spindle/LOAD', hasPermission: () => false })
    expect(panel.getByRole('link', { name: /View History/ })).toHaveAttribute('href', '/history/metric/Spindle%2FLOAD')
    expect(panel.getByRole('button', { name: 'Deprecate' })).toBeDisabled()
  })

  it('opens the History page on that metric when it is followed', async () => {
    const panel = await openDrawer({ name: 'Spindle/LOAD' })
    fireEvent.click(panel.getByRole('link', { name: /View History/ }))
    expect(window.location.pathname).toBe('/history/metric/Spindle%2FLOAD')
  })
})

describe('the Metric tab at that address', () => {
  it('opens on the metric the drawer named, and reads it across the devices that report it', async () => {
    // The address the drawer gives, followed as a link, then the page that answers to it.
    const panel = await openDrawer({ name: 'Spindle/LOAD' })
    const href = panel.getByRole('link', { name: /View History/ }).getAttribute('href')
    cleanup()
    window.history.pushState({}, '', href)
    render(<HistoryTab showToast={vi.fn()} userRole="Operator" />)
    expect(await screen.findByRole('button', { name: 'Metric: Spindle/LOAD' })).toBeInTheDocument()
    expect(within(screen.getByRole('navigation', { name: 'History' })).getByRole('link', { name: 'Metric' })).toHaveAttribute('aria-current', 'page')
    await waitFor(() => expect(api.readCarriedTelemetry).toHaveBeenCalled())
    expect(api.readCarriedTelemetry.mock.calls[0][0].metricNames).toEqual(['Spindle/LOAD'])
    expect(api.readCarriedTelemetry.mock.calls[0][0].assetIds).toHaveLength(1)
  })
})
