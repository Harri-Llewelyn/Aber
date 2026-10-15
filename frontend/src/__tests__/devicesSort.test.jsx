import React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { api } from '../api'

/**
 * Sorting the Devices page's two tables by a column (#801): the Registered roster and the Quarantine
 * queue. A column sorts on what its cell shows, so the fixtures sit where that differs from the field
 * underneath: a status an alert outranks, a type read off the schema's metric groups, a cell by its
 * name rather than its id, a lane by its label, a time by its instant.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

vi.mock('../lib/supabaseClient', () => ({
  supabase: { functions: { invoke: vi.fn() } }
}))

const DAY = 24 * 60 * 60 * 1000

const device = (overrides = {}) => ({
  asset_id: 'aaaaaaaa-0000-4000-8000-000000000001',
  asset_name: 'CNC_01',
  sparkplug_id: 'devaaaaaaaa000040008000',
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
  ...overrides
})

const GATEWAYS = [
  { gateway_id: 'gw-1', gateway_name: 'Line_A_Gateway', cell_id: 'cell-a', location_scope: 'cell', status: 'ONLINE', is_archived: false, devices: [] }
]
// Ids in the opposite order to the names, so a sort on the id comes out differently.
const CELLS = [
  { cell_id: 'cell-a', cell_name: 'Line 10', is_archived: false },
  { cell_id: 'cell-b', cell_name: 'Line 9', is_archived: false }
]
// A device's Type is the groups of the metrics its schema models. Each schema is named against the
// order of its tags, so a sort on the schema's name comes out differently.
const SCHEMAS = [
  { schema_uuid: 'schema-press', schema_name: 'Zeta Press', schema_definition: { properties: { 'Hydraulic/PRESSURE': {}, 'Axes/LOAD': {} } } },
  { schema_uuid: 'schema-meter', schema_name: 'Alpha Meter', schema_definition: { properties: { 'Energy/KWH': {} } } },
  { schema_uuid: 'schema-lathe', schema_name: 'Mid Lathe', schema_definition: { properties: { 'Spindle/SPEED': {} } } }
]

// Running, in Line 10 through its gateway, typed Energy.
const drill = device({
  asset_id: 'aaaaaaaa-0000-4000-8000-000000000001', asset_name: 'Drill_Online',
  sparkplug_id: 'devaaaaaaaa000040008001', submodel_schema_ids: ['schema-meter']
})
// Archived, with an alarm still firing on it; its row shows only ARCHIVED.
const saw = device({
  asset_id: 'bbbbbbbb-0000-4000-8000-000000000002', asset_name: 'Old_Saw',
  sparkplug_id: 'devbbbbbbbb000040008002', is_archived: true, submodel_schema_ids: ['schema-lathe']
})
// Running, with an alarm firing on it; Site-Wide, so its Cell is a lane's label.
const press = device({
  asset_id: 'cccccccc-0000-4000-8000-000000000003', asset_name: 'Press_Alarm',
  sparkplug_id: 'devcccccccc000040008003', submodel_schema_ids: ['schema-press'],
  location_scope: 'site_wide', location_source: 'site_wide', effective_cell_id: null
})
// Went quiet; no schema, so no Type; no gateway and no cell, so Unassigned.
const mill = device({
  asset_id: 'dddddddd-0000-4000-8000-000000000004', asset_name: 'Mill_Offline',
  sparkplug_id: 'devdddddddd000040008004', status: 'OFFLINE', submodel_schema_ids: [],
  active_gateway_id: null, gateway_cell_id: null, location_source: 'unassigned', effective_cell_id: null
})
// Registered five days ago and never heard from, so overdue; set on Line 9 itself.
const lathe = device({
  asset_id: 'eeeeeeee-0000-4000-8000-000000000005', asset_name: 'Lathe_Overdue',
  sparkplug_id: 'deveeeeeeee000040008005', status: 'OFFLINE', first_dbirth_at: null,
  created_at: new Date(Date.now() - 5 * DAY).toISOString(), submodel_schema_ids: ['schema-lathe'],
  cell_id: 'cell-b', effective_cell_id: 'cell-b', location_source: 'explicit'
})

// As the API returns them, in no column's order.
const ROSTER = [drill, saw, press, mill, lathe]

const ALERTS = [
  { alert_name: 'Overpressure', severity: 'critical', entity_type: 'device', sparkplug_id: press.sparkplug_id },
  { alert_name: 'Blade temperature', severity: 'critical', entity_type: 'device', sparkplug_id: saw.sparkplug_id }
]

const queued = (overrides = {}) => ({
  quarantine_id: 'qtn-1',
  asset_id: 'ffffffff-0000-4000-8000-000000000001',
  asset_name: 'Unknown_Robot',
  reported_identity: 'devffffffffffffffffffff1',
  quarantine_reason: 'UNKNOWN_DEVICE',
  gateway_id: 'gw-1',
  gateway_name: 'Line_A_Gateway',
  discovered_at: '2026-10-15T09:00:00+01:00',
  entity_type: 'DEVICE',
  ...overrides
})

// 09:00+01:00 is 08:00Z: by the text of its time the robot would come last, by its instant second.
const QUEUE = [
  queued(),
  queued({
    quarantine_id: 'qtn-2', asset_id: 'ffffffff-0000-4000-8000-000000000002', asset_name: 'Stray_Sensor',
    reported_identity: 'devffffffffffffffffffff2', gateway_name: null, discovered_at: '2026-10-15T08:30:00Z'
  }),
  queued({
    quarantine_id: 'qtn-3', asset_id: 'ffffffff-0000-4000-8000-000000000003', asset_name: 'Mystery_Pump',
    reported_identity: 'devffffffffffffffffffff3', gateway_name: 'Boiler_Gateway', discovered_at: '2026-10-15T07:00:00Z'
  })
]

const routeGet = (rows, quarantine) => (path) => {
  if (path.startsWith('/api/v1/gateways')) return Promise.resolve(GATEWAYS)
  if (path.startsWith('/api/v1/cells')) return Promise.resolve(CELLS)
  if (path.startsWith('/api/v1/quarantine')) return Promise.resolve(quarantine)
  if (path.startsWith('/api/v1/schemas')) return Promise.resolve(SCHEMAS)
  if (path.startsWith('/api/v1/devices')) return Promise.resolve(rows)
  return Promise.resolve([])
}

const show = async ({ rows = ROSTER, quarantine = QUEUE } = {}) => {
  api.get.mockImplementation(routeGet(rows, quarantine))
  render(<DevicesTab showToast={vi.fn()} hasPermission={() => true} activeAlerts={ALERTS} />)
  await waitFor(() => expect(document.querySelector('.tab-strip')).toBeTruthy())
  await waitFor(() => expect(document.querySelector('.loading-wrap')).toBeNull())
}

/** The names down the table on show, in order: each row leads with its name in bold. */
const listed = () =>
  [...document.querySelectorAll('.page-main tbody tr')].map(r => r.querySelector('td strong').textContent)
const sortBy = (name) => fireEvent.click(screen.getByRole('button', { name }))
const header = (name) => screen.getByRole('columnheader', { name })
const sortInAddress = () => new URLSearchParams(window.location.search).get('sort')

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState({}, '', '/devices')
})

describe('Devices: sorting the Registered roster by a column (#801)', () => {
  it('sorts Status by severity, an alarm on a running device first and an archived one last', async () => {
    window.history.replaceState(null, '', '/devices?lifecycle=all')
    await show()

    sortBy('Status')
    // The press is ONLINE but alarming, so the alarm decides; the saw's alarm does not, since its row
    // shows only ARCHIVED.
    expect(listed()).toEqual(['Press_Alarm', 'Lathe_Overdue', 'Mill_Offline', 'Drill_Online', 'Old_Saw'])
    expect(header('Status')).toHaveAttribute('aria-sort', 'ascending')
    expect(sortInAddress()).toBe('status')
    expect(new URLSearchParams(window.location.search).get('lifecycle')).toBe('all')
  })

  it('reverses Status on a second click, the archived device still last, since it has no lifecycle state', async () => {
    window.history.replaceState(null, '', '/devices?lifecycle=all')
    await show()

    sortBy('Status')
    sortBy('Status')
    expect(listed()).toEqual(['Drill_Online', 'Mill_Offline', 'Lathe_Overdue', 'Press_Alarm', 'Old_Saw'])
    expect(header('Status')).toHaveAttribute('aria-sort', 'descending')
    expect(sortInAddress()).toBe('-status')
  })

  it('sorts Type by the tags the row shows, not the schema behind them, with a device that has none last either way', async () => {
    await show()

    sortBy('Type')
    expect(listed()).toEqual(['Press_Alarm', 'Drill_Online', 'Lathe_Overdue', 'Mill_Offline'])
    expect(sortInAddress()).toBe('type')

    sortBy('Type')
    expect(listed()).toEqual(['Lathe_Overdue', 'Drill_Online', 'Press_Alarm', 'Mill_Offline'])
    expect(header('Type')).toHaveAttribute('aria-sort', 'descending')
    expect(sortInAddress()).toBe('-type')
  })

  it('sorts Cell by the cell\'s name in natural order, a lane by its label, and a device no cell resolves to last either way', async () => {
    await show()

    sortBy('Cell')
    // Line 9 before Line 10, though Line 10's id sorts first.
    expect(listed()).toEqual(['Lathe_Overdue', 'Drill_Online', 'Press_Alarm', 'Mill_Offline'])
    expect(header('Cell')).toHaveAttribute('aria-sort', 'ascending')

    sortBy('Cell')
    expect(listed()).toEqual(['Press_Alarm', 'Drill_Online', 'Lathe_Overdue', 'Mill_Offline'])
    expect(sortInAddress()).toBe('-cell')
  })

  it('opens sorted when the address names a sort, which the hidden Quarantine table leaves in place', async () => {
    // Status is not a column of the queue, whose table is not on show.
    window.history.replaceState(null, '', '/devices?sort=-status')
    await show()

    expect(listed()).toEqual(['Drill_Online', 'Mill_Offline', 'Lathe_Overdue', 'Press_Alarm'])
    expect(header('Status')).toHaveAttribute('aria-sort', 'descending')
    expect(sortInAddress()).toBe('-status')
  })
})

describe('Devices: sorting the Quarantine queue by a column (#801)', () => {
  const openQueue = () => fireEvent.click(screen.getByRole('tab', { name: /^Quarantine/ }))

  it('sorts Discovered At by instant, not by the text of the time, and reverses it on a second click', async () => {
    await show()
    openQueue()
    expect(listed()).toEqual(['Unknown_Robot', 'Stray_Sensor', 'Mystery_Pump'])

    sortBy('Discovered At')
    expect(listed()).toEqual(['Mystery_Pump', 'Unknown_Robot', 'Stray_Sensor'])
    expect(header('Discovered At')).toHaveAttribute('aria-sort', 'ascending')
    expect(window.location.pathname).toBe('/devices/quarantine')
    expect(sortInAddress()).toBe('discovered_at')

    sortBy('Discovered At')
    expect(listed()).toEqual(['Stray_Sensor', 'Unknown_Robot', 'Mystery_Pump'])
    expect(header('Discovered At')).toHaveAttribute('aria-sort', 'descending')
    expect(sortInAddress()).toBe('-discovered_at')
  })

  it('puts a birth with no gateway name, drawn as a dash, last either way', async () => {
    await show()
    openQueue()

    sortBy('Gateway')
    expect(listed()).toEqual(['Mystery_Pump', 'Unknown_Robot', 'Stray_Sensor'])

    sortBy('Gateway')
    expect(listed()).toEqual(['Unknown_Robot', 'Mystery_Pump', 'Stray_Sensor'])
    expect(sortInAddress()).toBe('-gateway')
  })

  it('opens sorted when the address names a sort on its tab, which the hidden roster does not tidy away', async () => {
    window.history.replaceState(null, '', '/devices/quarantine?sort=-discovered_at')
    await show()

    expect(screen.getByRole('tab', { name: /^Quarantine/ })).toHaveAttribute('aria-selected', 'true')
    expect(listed()).toEqual(['Stray_Sensor', 'Unknown_Robot', 'Mystery_Pump'])
    expect(header('Discovered At')).toHaveAttribute('aria-sort', 'descending')
    expect(window.location.pathname + window.location.search).toBe('/devices/quarantine?sort=-discovered_at')
  })
})
