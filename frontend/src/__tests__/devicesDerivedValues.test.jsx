/**
 * The Devices drawer's Derived Metrics: each derived metric whose inputs the device reports, with its
 * current value by the rule derived_current() holds, its tag and the window in words. One read when the
 * drawer opens on a device; a device with no value, a read that fails, and a device none of whose
 * derived metrics apply are each said in words or leave the field out.
 */
import React from 'react'
import { render, screen, within, waitFor, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { api } from '../api'
import { telemetryKey } from '../utils/history'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), readDerivedCurrent: vi.fn() } }
})

vi.mock('../lib/supabaseClient', () => ({
  supabase: { functions: { invoke: vi.fn() }, auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) } }
}))

const NOW = Date.parse('2026-07-28T12:00:00Z')
const base = {
  status: 'ONLINE', cell_id: null, location_scope: 'cell', effective_cell_id: 'cell-1', gateway_cell_id: 'cell-1',
  location_source: 'inherited', active_gateway_id: 'gw-1',
}
const press = { ...base, asset_id: 'dev-1', asset_name: 'Press 1', sparkplug_id: 'dev_1111222233334444', last_birth_metrics: ['Controller/PART_COUNT', 'Controller/EXECUTION', 'Power/PHASE_A', 'Power/PHASE_B'] }
const lathe = { ...base, asset_id: 'dev-2', asset_name: 'Lathe 3', sparkplug_id: 'dev_5555666677778888', last_birth_metrics: ['Spindle/LOAD'] }
const cell = { cell_id: 'cell-1', cell_name: 'Assembly', is_archived: false, gateways: [], gateway_count: 0 }
const catalog = [
  { name: 'Controller/PART_COUNT', units: 'COUNT', datatype: 10 },
  { name: 'Controller/EXECUTION', datatype: 12 },
  { name: 'Power/PHASE_A', units: 'kW', datatype: 10 },
  { name: 'Power/PHASE_B', units: 'kW', datatype: 10 },
  { name: 'Spindle/LOAD', units: 'kW', datatype: 10 },
  { name: 'Controller/PARTS_PER_HOUR', units: 'COUNT/HOUR', datatype: 10, derivation: { kind: 'counter_rate', input: 'Controller/PART_COUNT' } },
  { name: 'Controller/UPTIME', datatype: 10, derivation: { kind: 'time_in_state', input: 'Controller/EXECUTION', states: ['ACTIVE'] } },
  { name: 'Power/TOTAL', units: 'kW', datatype: 10, derivation: { kind: 'sum', inputs: [{ metric: 'Power/PHASE_A', sign: 1 }, { metric: 'Power/PHASE_B', sign: 1 }] } },
]

const routeGet = (path) => {
  if (path.includes('/telemetry')) return Promise.resolve([])
  if (path.includes('/config')) return Promise.resolve([])
  if (path.startsWith('/api/v1/cells')) return Promise.resolve([cell])
  if (path.startsWith('/api/v1/devices')) return Promise.resolve([press, lathe])
  if (path.startsWith('/api/v1/metric-catalog')) return Promise.resolve(catalog)
  return Promise.resolve([])
}

const END = '2026-07-28T12:00:00.000Z'
const current = (name, value, window = 60) => ({ asset_id: telemetryKey(press), metric_name: name, value, observed_at: END, window_minutes: window })

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)
  api.get.mockImplementation(routeGet)
  api.readDerivedCurrent.mockResolvedValue([
    current('Controller/PARTS_PER_HOUR', 120.4), current('Controller/UPTIME', 0.5), current('Power/TOTAL', 7, 0),
  ])
})

afterEach(() => { vi.useRealTimers() })

const panel = () => document.querySelector('.context-panel')
const list = () => within(document.querySelector('.page-main'))

const open = async (name) => {
  render(
    <DevicesTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()}
      initialSchemaFilter="" onClearSchemaFilter={vi.fn()} onSelectDevice={vi.fn()} onViewTrail={vi.fn()} />
  )
  await waitFor(() => expect(screen.getByText(name)).toBeInTheDocument())
  fireEvent.click(list().getByText(name))
  await waitFor(() => expect(panel()?.classList.contains('context-panel-open')).toBe(true))
}

const field = () => within(panel()).queryByText('Derived Metrics')?.closest('.context-field')

describe("the Devices drawer's derived metrics", () => {
  it('lists each derived metric the device reports the inputs of, with its value, its tag and its window', async () => {
    await open('Press 1')
    await waitFor(() => expect(field()?.textContent).toContain('120.4 COUNT/HOUR'))
    const rows = [...field().querySelectorAll('.derived-values li')].map(li => li.textContent.replace(/\s+/g, ' ').trim())
    expect(rows).toEqual([
      'Controller/PARTS_PER_HOUR Derived 120.4 COUNT/HOUR over the last hour',
      'Controller/UPTIME Derived 0.5 over the last hour',
      'Power/TOTAL Derived 7 kW at the last whole minute',
    ])
  })

  it('reads once, for the device and its derived metrics, when the drawer opens', async () => {
    await open('Press 1')
    await waitFor(() => expect(api.readDerivedCurrent).toHaveBeenCalledTimes(1))
    expect(api.readDerivedCurrent.mock.calls[0][0]).toEqual({
      assetIds: [telemetryKey(press)],
      metricNames: ['Controller/PARTS_PER_HOUR', 'Controller/UPTIME', 'Power/TOTAL'],
    })
    // The page's own polls go by, and the drawer reads nothing more.
    await act(async () => { await vi.advanceTimersByTimeAsync(20000) })
    expect(api.readDerivedCurrent).toHaveBeenCalledTimes(1)
  })

  it('says a device with no value has none yet, and never reads it as zero', async () => {
    api.readDerivedCurrent.mockResolvedValue([current('Controller/PARTS_PER_HOUR', 0)])
    await open('Press 1')
    await waitFor(() => expect(field()?.textContent).toContain('0 COUNT/HOUR over the last hour'))
    expect(field().textContent).toContain('Controller/UPTIME')
    expect(field().textContent.match(/No value yet\./g)).toHaveLength(2)
  })

  it('says a read that failed, in words', async () => {
    api.readDerivedCurrent.mockRejectedValue(new Error('the historian is out'))
    await open('Press 1')
    await waitFor(() => expect(field()?.textContent).toContain('Could not be read.'))
  })

  it('has no field for a device none of whose derived metrics apply, and reads nothing', async () => {
    await open('Lathe 3')
    expect(field()).toBeFalsy()
    expect(api.readDerivedCurrent).not.toHaveBeenCalled()
  })
})
