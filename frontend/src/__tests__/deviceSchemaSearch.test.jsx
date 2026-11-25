import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { PERMISSION_UUIDS } from '../constants'
import { api } from '../api'

/**
 * The device form's schemas, with a site's worth of them: found by a search, saved although a search
 * hides them, and read only by a role that may only propose. What a row says is held by
 * schemaPicker.test.jsx, and what a save writes by deviceSchemaPicker.test.jsx.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

vi.mock('../lib/supabaseClient', () => ({
  supabase: { functions: { invoke: vi.fn() } }
}))

const DEVICE_ID = 'aaaaaaaa-0000-4000-8000-000000000001'
const idOf = (n) => `ssssssss-0000-4000-8000-${String(n).padStart(12, '0')}`

/** Sixty schemas, the 41st of them the one that carries Spindle/LOAD and the 50th an archived version. */
const SIXTY = Array.from({ length: 60 }, (_, i) => {
  const n = i + 1
  const metric = n === 41 ? 'Spindle/LOAD' : `Group${n}/VALUE`
  return {
    schema_uuid: idOf(n), schema_name: `Schema_${String(n).padStart(2, '0')}`, version: 1,
    status: n === 50 ? 'archived' : 'active', description: '',
    schema_definition: { properties: { [metric]: { type: 'number' } } }
  }
})

const device = (overrides = {}) => ({
  asset_id: DEVICE_ID, asset_name: 'CNC_01', sparkplug_id: 'devaaaaaaaa000040008000', status: 'ONLINE',
  is_quarantined: false, is_archived: false, active_gateway_id: 'gw-1', cell_id: null,
  location_scope: 'gateway', effective_cell_id: 'cell-1', gateway_cell_id: 'cell-1',
  location_source: 'followed_cell', conformance_policy: 'audit', created_at: '2026-07-20T12:00:00Z',
  submodel_schema_ids: [], ...overrides
})

const asOperator = (id) => id === PERMISSION_UUIDS.PROPOSAL_CREATE

const show = async ({ rows = [device()], schemas = SIXTY, hasPermission = () => true } = {}) => {
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/gateways')) {
      return Promise.resolve([{ gateway_id: 'gw-1', gateway_name: 'Line_A_Gateway', sparkplug_id: 'gwy-1', cell_id: 'cell-1', location_scope: 'cell', status: 'ONLINE', is_archived: false, devices: [] }])
    }
    if (path.startsWith('/api/v1/cells')) return Promise.resolve([{ cell_id: 'cell-1', cell_name: 'Assembly', is_archived: false }])
    if (path.startsWith('/api/v1/schemas')) return Promise.resolve(schemas)
    if (path.startsWith('/api/v1/devices')) return Promise.resolve(rows)
    return Promise.resolve([])
  })
  render(<DevicesTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={hasPermission} />)
  await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())
}

const openEdit = (action = 'Edit Details') => {
  fireEvent.click(within(document.querySelector('.page-main')).getByText('CNC_01'))
  fireEvent.click(within(document.querySelector('.context-panel')).getByText(action))
}
const openNew = () => {
  fireEvent.click(screen.getByText(/New Device/))
  fireEvent.change(screen.getByPlaceholderText('e.g. CNC Mill 01'), { target: { value: 'Lathe_7' } })
}

const picker = () => screen.getByRole('group', { name: /^Schemas \(optional\)/ })
const box = (name) => within(picker()).queryByRole('checkbox', { name })
const names = () => within(picker()).queryAllByRole('checkbox').map(cb => cb.getAttribute('aria-label'))
const type = (value) => fireEvent.change(within(picker()).getByLabelText('Search name, description or metric'), { target: { value } })
const save = () => fireEvent.click(screen.getByRole('button', { name: /Save Configuration/i }))
const schemaWrites = () => api.put.mock.calls.filter(([path]) => path.endsWith('/schemas'))

beforeEach(() => {
  vi.clearAllMocks()
  api.post.mockResolvedValue({ id: 'new-device-id' })
  api.put.mockResolvedValue({})
})

describe('Register New Device', () => {
  it('finds a schema by a metric it models, and saves it with one the search hides', async () => {
    await show()
    openNew()
    expect(names()).toHaveLength(59)
    fireEvent.click(box('Schema_03'))
    type('spindle/load')
    expect(names()).toEqual(['Schema_41'])
    expect(picker().textContent).toContain('models Spindle/LOAD')
    fireEvent.click(box('Schema_41'))
    expect(box('Schema_03')).toBeNull()
    expect(screen.getByRole('group', { name: 'Schemas (optional) 2 selected' })).toBeTruthy()
    save()

    await waitFor(() => expect(schemaWrites()).toHaveLength(1))
    expect([...schemaWrites()[0][1].schema_ids].sort()).toEqual([idOf(3), idOf(41)])
  })

  it('offers no archived version', async () => {
    await show()
    openNew()
    expect(names()).not.toContain('Schema_50 · Archived')
  })

  it('says where to make one when the site has none', async () => {
    await show({ schemas: [] })
    openNew()
    expect(within(picker()).getByText('No schemas yet. Create one on the Schemas page.')).toBeTruthy()
    expect(names()).toEqual([])
  })

  it('lists the one schema a site has', async () => {
    await show({ schemas: SIXTY.slice(0, 1) })
    openNew()
    expect(names()).toEqual(['Schema_01'])
  })
})

describe('Edit Device Configuration', () => {
  it('opens on the schemas the device has, its archived version among them, and warns of it', async () => {
    await show({ rows: [device({ submodel_schema_ids: [idOf(58), idOf(50)] })] })
    openEdit()
    expect(names().slice(0, 3)).toEqual(['Schema_50 · Archived', 'Schema_58', 'Schema_01'])
    expect(box('Schema_50 · Archived').checked).toBe(true)
    expect(within(picker()).getByText(/still on an archived version/)).toBeTruthy()
  })

  it('saves a set the search hides whole, as it was', async () => {
    await show({ rows: [device({ submodel_schema_ids: [idOf(58), idOf(50)] })] })
    openEdit()
    type('spindle')
    expect(names()).toEqual(['Schema_41'])
    save()
    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(schemaWrites()).toHaveLength(0)
  })

  it('names the metric groups the ticked schemas model, whatever the search lists', async () => {
    await show({ rows: [device({ submodel_schema_ids: [idOf(7)] })] })
    openEdit()
    expect(within(picker()).getByText('Metric groups these schemas model: Group7')).toBeTruthy()
    type('spindle')
    fireEvent.click(box('Schema_41'))
    expect(within(picker()).getByText('Metric groups these schemas model: Group7, Spindle')).toBeTruthy()
  })

  it('says what the schemas are for, under the list', async () => {
    await show()
    openEdit()
    expect(picker().textContent).toContain('its Schema Conformance setting decides')
    expect(picker().textContent).toContain('if it turns up in the Quarantine queue')
  })
})

describe('proposing a change', () => {
  it('shows the schemas ticked and held, says why, and still searches them', async () => {
    await show({ rows: [device({ submodel_schema_ids: [idOf(7)] })], hasPermission: asOperator })
    openEdit('Propose a Change')
    const boxes = within(picker()).getAllByRole('checkbox')
    expect(boxes).toHaveLength(59)
    expect(boxes.every(cb => cb.disabled)).toBe(true)
    expect(box('Schema_07').checked).toBe(true)
    expect(within(picker()).getByText(/an Administrator or a Shopfloor Manager changes them/)).toBeTruthy()
    type('spindle/load')
    expect(names()).toEqual(['Schema_41'])
    expect(box('Schema_41').disabled).toBe(true)
  })
})
