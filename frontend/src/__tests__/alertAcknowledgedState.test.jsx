import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { api } from '../api'
import { tooltipOf } from '../test/tooltips'

/**
 * The Alert acknowledged state on the Devices page (0231). An acknowledged alert still fires, so
 * the device's row keeps a badge beside its lifecycle state, drawn hollow with a tick and reading
 * ACKNOWLEDGED, never ALARM or WARNING; one nobody has acknowledged wins.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

vi.mock('../lib/supabaseClient', () => ({
  supabase: { functions: { invoke: vi.fn() } }
}))

const DEVICE = {
  asset_id: 'aaaaaaaa-0000-4000-8000-000000000231',
  asset_name: 'Press_04',
  sparkplug_id: 'devaaaaaaaa000040008231',
  status: 'ONLINE',
  is_quarantined: false,
  is_archived: false,
  active_gateway_id: 'gw-1',
  cell_id: null,
  location_scope: 'cell',
  effective_cell_id: 'cell-a',
  gateway_cell_id: 'cell-a',
  location_source: 'inherited',
  cell_mismatch: false,
  first_dbirth_at: '2026-07-27T12:00:00Z',
  created_at: '2026-07-20T12:00:00Z',
}

const alert = (over = {}) => ({
  fingerprint: 'fp-press-04', entity_type: 'device', entity_id: DEVICE.asset_id, sparkplug_id: DEVICE.sparkplug_id,
  alert_name: 'Hydraulic Pressure Low', severity: 'critical', summary: 'Below 80 bar', ...over,
})
const acknowledged = (over = {}) => alert({
  acknowledged_at: '2026-11-04T09:05:00Z', acknowledged_by: 'a0d17231-0000-4000-8000-0000000231a1',
  acknowledged_by_email: 'op@aber.local', acknowledgement_reason: 'planned_work', ...over,
})

const routeGet = (path) => {
  if (path.startsWith('/api/v1/gateways')) return Promise.resolve([])
  if (path.startsWith('/api/v1/cells')) return Promise.resolve([{ cell_id: 'cell-a', cell_name: 'Line 1', is_archived: false }])
  if (path.startsWith('/api/v1/devices')) return Promise.resolve([DEVICE])
  return Promise.resolve([])
}

const statusCell = async (activeAlerts) => {
  api.get.mockImplementation(routeGet)
  render(<DevicesTab showToast={vi.fn()} hasPermission={() => true} activeAlerts={activeAlerts} />)
  const name = await screen.findByText('Press_04', { selector: 'td strong' })
  return name.closest('tr')
}

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState({}, '', '/devices')
})

describe('the Devices page draws Alert acknowledged', () => {
  it('as a hollow badge with a tick, saying who and why', async () => {
    const row = await statusCell([acknowledged()])
    const badge = within(row).getByText('ACKNOWLEDGED').closest('.badge')
    expect(badge).toHaveClass('badge-acknowledged')
    expect(badge.querySelector('svg')).toBeTruthy()
    expect(row).not.toHaveTextContent(/ALARM|WARNING/)
    expect(tooltipOf(badge)).toBe('Hydraulic Pressure Low — acknowledged by op@aber.local: Planned work')
  })

  it('as ALARM while another alert on it is nobody\'s', async () => {
    const row = await statusCell([
      acknowledged(),
      alert({ fingerprint: 'fp-press-04-b', alert_name: 'Oil Temperature High', severity: 'warning' }),
    ])
    await waitFor(() => expect(row).toHaveTextContent('WARNING'))
    expect(row).not.toHaveTextContent('ACKNOWLEDGED')
  })
})
