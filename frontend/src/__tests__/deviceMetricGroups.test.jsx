import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { api } from '../api'
import { filterList, offered, openDropdown, pick, picked } from '../test/listFilters'

/**
 * A device's metric groups go by one name, Metric groups, and the two findings (Unmodelled, Out of
 * vocabulary) are not among them: they sit in the Status column and the Status filter, and the
 * drawer shows each as a warning badge beside the lifecycle state.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

vi.mock('../lib/supabaseClient', () => ({
  supabase: { functions: { invoke: vi.fn() } }
}))

const AXES = 'ssssssss-0000-4000-8000-000000000001'
const ENVIRONMENT = 'ssssssss-0000-4000-8000-000000000002'
const SCHEMAS = [
  {
    schema_uuid: AXES, schema_name: 'Axes_Schema', status: 'active',
    schema_definition: { properties: { 'Axes/X/POSITION': {}, 'Controller/EXECUTION': {} } }
  },
  {
    schema_uuid: ENVIRONMENT, schema_name: 'Environment_Schema', status: 'active',
    schema_definition: { properties: { 'Environmental/TEMPERATURE': {} } }
  },
]
const CATALOG = [{
  metric_uuid: 'm1', name: 'Controller/EXECUTION', datatype: 12, deprecated: false,
  permitted_values: ['READY', 'ACTIVE', 'STOPPED']
}]

const device = (overrides = {}) => ({
  asset_id: 'aaaaaaaa-0000-4000-8000-000000000001',
  asset_name: 'Press_01',
  sparkplug_id: 'devaaaaaaaa000040008001',
  status: 'ONLINE',
  is_quarantined: false,
  is_archived: false,
  active_gateway_id: 'gw-1',
  cell_id: null,
  location_scope: 'gateway',
  effective_cell_id: 'cell-1',
  gateway_cell_id: 'cell-1',
  location_source: 'followed_cell',
  conformance_policy: 'audit',
  first_dbirth_at: '2026-07-27T12:00:00Z',
  created_at: '2026-07-20T12:00:00Z',
  submodel_schema_ids: [AXES],
  last_birth_metrics: ['Axes/X/POSITION', 'Controller/EXECUTION'],
  ...overrides
})

// Declared a metric its schema does not model.
const press = device({ last_birth_metrics: ['Axes/X/POSITION', 'Controller/EXECUTION', 'Spare/FLAG'] })
// Reports a value outside the vocabulary (see TELEMETRY).
const lathe = device({
  asset_id: 'aaaaaaaa-0000-4000-8000-000000000002', asset_name: 'Lathe_02', sparkplug_id: 'devaaaaaaaa000040008002'
})
// Nothing wrong with it.
const sensor = device({
  asset_id: 'aaaaaaaa-0000-4000-8000-000000000003', asset_name: 'Sensor_03', sparkplug_id: 'devaaaaaaaa000040008003',
  submodel_schema_ids: [ENVIRONMENT], last_birth_metrics: ['Environmental/TEMPERATURE']
})
const FLEET = [press, lathe, sensor]

const TELEMETRY = [
  { asset_id: lathe.sparkplug_id, metric_name: 'Controller/EXECUTION', val_string: 'RUNNING' },
  { asset_id: press.sparkplug_id, metric_name: 'Controller/EXECUTION', val_string: 'ACTIVE' }
]

const GATEWAYS = [{
  gateway_id: 'gw-1', gateway_name: 'Line_A_Gateway', sparkplug_id: 'gwy-1',
  cell_id: 'cell-1', location_scope: 'cell', status: 'ONLINE', is_archived: false, devices: []
}]
const CELLS = [{ cell_id: 'cell-1', cell_name: 'Assembly', is_archived: false }]

const show = async ({ rows = FLEET, telemetry = TELEMETRY, url = '/devices' } = {}) => {
  window.history.replaceState({}, '', url)
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/gateways')) return Promise.resolve(GATEWAYS)
    if (path.startsWith('/api/v1/cells')) return Promise.resolve(CELLS)
    if (path.startsWith('/api/v1/quarantine')) return Promise.resolve([])
    if (path.startsWith('/api/v1/schemas')) return Promise.resolve(SCHEMAS)
    if (path.startsWith('/api/v1/metric-catalog')) return Promise.resolve(CATALOG)
    if (path.startsWith('/api/v1/telemetry')) return Promise.resolve(telemetry)
    if (path.startsWith('/api/v1/devices')) return Promise.resolve(rows)
    return Promise.resolve([])
  })
  render(<DevicesTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={() => true} />)
  await waitFor(() => expect(document.querySelector('.loading-wrap')).toBeNull())
}

const queryOf = (key) => new URLSearchParams(window.location.search).get(key)
const listed = () => [...document.querySelectorAll('.page-main tbody tr')].map(r => r.querySelector('td strong').textContent)
const rowOf = (name) => [...document.querySelectorAll('.page-main tbody tr')]
  .find(r => r.querySelector('td strong')?.textContent === name)
/** A row's cells by the column's header. */
const cellOf = (name, header) => {
  const heads = [...document.querySelectorAll('.page-main thead th')].map(h => h.textContent)
  return rowOf(name).querySelectorAll('td')[heads.indexOf(header)]
}
const panel = () => document.querySelector('.context-panel')
const open = (name) => fireEvent.click(within(document.querySelector('.page-main')).getByText(name))

beforeEach(() => vi.clearAllMocks())

describe('the roster', () => {
  it('names the column Metric groups, and holds only the groups there', async () => {
    await show()

    const heads = [...document.querySelectorAll('.page-main thead th')].map(h => h.textContent)
    expect(heads).toEqual(['Name', 'Device UUID', 'Status', 'Metric groups', 'Cell'])

    const groups = cellOf('Press_01', 'Metric groups')
    expect(groups.textContent).toBe('AxesController')
    expect(groups.textContent).not.toMatch(/Unmodelled/)
    expect(cellOf('Lathe_02', 'Metric groups').textContent).not.toMatch(/vocabulary/)
  })

  it('shows each finding in the Status column, beside the lifecycle badge, Unmodelled with its count', async () => {
    await show()

    const status = cellOf('Press_01', 'Status')
    expect(within(status).getByText('ONLINE')).toBeTruthy()
    const unmodelled = within(status).getByText('Unmodelled (1)')
    expect(unmodelled.closest('span')).toHaveAccessibleDescription(/Spare\/FLAG/)

    const vocabulary = within(cellOf('Lathe_02', 'Status')).getByText('Out of vocabulary')
    expect(vocabulary.closest('span')).toHaveAccessibleDescription(/Controller\/EXECUTION = RUNNING/)

    // A device with nothing wrong carries no finding.
    expect(cellOf('Sensor_03', 'Status').textContent).not.toMatch(/Unmodelled|vocabulary/)
  })

  it('sorts Metric groups by the groups, and keeps the sort in the address as ?sort=group', async () => {
    await show()

    fireEvent.click(screen.getByRole('button', { name: 'Metric groups' }))
    // "Axes, Controller" (two devices, in the order they arrived) before "Environmental".
    expect(listed()).toEqual(['Press_01', 'Lathe_02', 'Sensor_03'])
    expect(queryOf('sort')).toBe('group')
    fireEvent.click(screen.getByRole('button', { name: 'Metric groups' }))
    expect(listed()).toEqual(['Sensor_03', 'Press_01', 'Lathe_02'])
    expect(queryOf('sort')).toBe('-group')
  })
})

describe('the Status sort', () => {
  it('ranks by the alert and the lifecycle state, so a finding leaves a row where it was', async () => {
    // All three are ONLINE; two carry a finding. They keep the order they arrived in.
    await show({ url: '/devices?sort=status' })

    expect(listed()).toEqual(['Press_01', 'Lathe_02', 'Sensor_03'])
    expect(screen.getByRole('columnheader', { name: 'Status' })).toHaveAttribute('aria-sort', 'ascending')
  })
})

describe('the filters', () => {
  it('offers the Metric groups filter the groups only, never a finding', async () => {
    await show()

    expect(offered(filterList('Metric groups'))).toEqual(['Axes', 'Controller', 'Environmental'])
  })

  it('offers Out of vocabulary beside Publishing unmodelled metrics in Status, and lists its devices', async () => {
    await show()

    const status = openDropdown('Status')
    expect(offered(status)).toEqual(expect.arrayContaining(['Publishing unmodelled metrics', 'Out of vocabulary']))
    pick('Status', 'out_of_vocabulary')
    await waitFor(() => expect(listed()).toEqual(['Lathe_02']))
    expect(queryOf('status')).toBe('out_of_vocabulary')

    pick('Status', 'unmodelled')
    await waitFor(() => expect(listed()).toEqual(['Press_01']))
  })

  it('narrows by Metric groups, in the address as ?group=', async () => {
    await show()

    pick('Metric groups', 'Environmental')
    await waitFor(() => expect(listed()).toEqual(['Sensor_03']))
    expect(queryOf('group')).toBe('Environmental')
    expect(queryOf('type')).toBeNull()
  })

  it('counts Out of vocabulary towards Needs attention, with Unmodelled', async () => {
    await show()
    expect(screen.getByRole('button', { name: /Needs attention \(2\)/ })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Needs attention/ }))
    await waitFor(() => expect(listed()).toEqual(['Press_01', 'Lathe_02']))
  })

  it('does not count a device whose last values are legal, or whose telemetry is not in', async () => {
    await show({ telemetry: [] })
    // Only Press_01 (Unmodelled): the vocabulary check has nothing to read, so it says nothing.
    expect(screen.getByRole('button', { name: /Needs attention \(1\)/ })).toBeTruthy()
  })
})

describe('an old ?type= link', () => {
  it('?type=Unmodelled opens the Status filter on Publishing unmodelled metrics', async () => {
    await show({ url: '/devices?type=Unmodelled' })

    await waitFor(() => expect(listed()).toEqual(['Press_01']))
    expect(picked('Status')).toEqual(['unmodelled'])
    expect(queryOf('type')).toBeNull()
    expect(queryOf('status')).toBe('unmodelled')
  })

  it('?type=Out of vocabulary opens the Status filter on Out of vocabulary', async () => {
    await show({ url: '/devices?type=Out%20of%20vocabulary' })

    await waitFor(() => expect(listed()).toEqual(['Lathe_02']))
    expect(picked('Status')).toEqual(['out_of_vocabulary'])
    expect(queryOf('type')).toBeNull()
  })

  it('?type=Axes becomes ?group=Axes', async () => {
    await show({ url: '/devices?type=Axes' })

    await waitFor(() => expect(listed()).toEqual(['Press_01', 'Lathe_02']))
    expect(queryOf('group')).toBe('Axes')
    expect(queryOf('type')).toBeNull()
    expect(queryOf('status')).toBeNull()
    expect(picked('Metric groups')).toEqual(['Axes'])
  })

  it('splits a list that held both, and keeps what the address already chose', async () => {
    await show({ url: '/devices?type=Axes,Unmodelled&status=unborn' })

    await waitFor(() => expect(listed()).toEqual(['Press_01']))
    expect(queryOf('group')).toBe('Axes')
    expect(queryOf('status')).toBe('unborn,unmodelled')
    expect(queryOf('type')).toBeNull()
  })
})

describe('the drawer', () => {
  it('names the row Metric groups and lists the groups only', async () => {
    await show()
    open('Press_01')

    const labels = [...panel().querySelectorAll('dt')].map(dt => dt.textContent)
    expect(labels).toContain('Metric groups')
    expect(labels).not.toContain('Classification')
    const row = [...panel().querySelectorAll('dt')].find(dt => dt.textContent.startsWith('Metric groups'))
    expect(row.nextElementSibling.textContent).toBe('Axes, Controller')
  })

  it('shows each finding as a warning badge in the subtitle, its hover text listing the metrics', async () => {
    await show()
    open('Press_01')

    const subtitle = panel().querySelector('.context-panel-subtitle')
    expect(within(subtitle).getByText('ONLINE')).toBeTruthy()
    const badge = within(subtitle).getByText('Unmodelled (1)').closest('span')
    expect(badge).toHaveClass('badge-warning')
    expect(badge).toHaveAccessibleDescription(/Spare\/FLAG/)
    expect(within(subtitle).queryByText('Out of vocabulary')).toBeNull()
  })

  it('shows Out of vocabulary in the subtitle of a device that has it', async () => {
    await show()
    open('Lathe_02')

    const subtitle = panel().querySelector('.context-panel-subtitle')
    const badge = within(subtitle).getByText('Out of vocabulary').closest('span')
    expect(badge).toHaveClass('badge-warning')
    expect(badge).toHaveAccessibleDescription(/Controller\/EXECUTION = RUNNING/)
  })

  it('shows no badge for a device with no finding', async () => {
    await show()
    open('Sensor_03')

    expect(panel().querySelector('.context-panel-subtitle').querySelectorAll('.badge-warning')).toHaveLength(0)
  })
})

describe('the edit form', () => {
  const openEdit = (name) => {
    open(name)
    fireEvent.click(within(panel()).getByText('Edit Details'))
  }
  const schemaBox = (name) => within(screen.getByRole('group', { name: /Schemas/ })).getByRole('checkbox', { name })
  const groupsLine = () => screen.queryByText('Metric Groups', { selector: 'dt' })?.nextElementSibling ?? null

  it('has no Device Type / Classification box, and no field for the groups', async () => {
    await show()
    openEdit('Sensor_03')

    expect(screen.queryByText(/Device Type/)).toBeNull()
    expect(screen.queryByText(/Classification/)).toBeNull()
    expect(document.querySelector('.derived-tags')).toBeNull()
  })

  it('says, under the Schemas, which metric groups the ticked schemas model, and follows them', async () => {
    await show()
    openEdit('Press_01')

    expect(groupsLine().textContent).toBe('Axes, Controller')
    // A static field after the checklist, not an input.
    expect(groupsLine().closest('.static-field').querySelector('input, select')).toBeNull()
    const schemas = screen.getByRole('group', { name: /Schemas/ })
    expect(schemas.compareDocumentPosition(groupsLine()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    fireEvent.click(schemaBox('Environment_Schema'))
    expect(groupsLine().textContent).toBe('Axes, Controller, Environmental')

    fireEvent.click(schemaBox('Axes_Schema'))
    expect(groupsLine().textContent).toBe('Environmental')
  })

  it('has no line with no schema ticked', async () => {
    await show()
    openEdit('Press_01')

    fireEvent.click(schemaBox('Axes_Schema'))
    expect(groupsLine()).toBeNull()
  })
})
