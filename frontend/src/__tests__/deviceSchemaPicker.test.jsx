import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { api } from '../api'

/**
 * The Devices form's schema picker: every schema attached by either path, ticked, and saved as
 * device_submodels rows through PUT /api/v1/devices/:id/schemas, which also clears the deprecated
 * `devices.schema_id`. The device PUT and POST never carry `schema_id`.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

vi.mock('../lib/supabaseClient', () => ({
  supabase: { functions: { invoke: vi.fn() } }
}))

const SPINDLE = 'ssssssss-0000-4000-8000-000000000001'
const ENERGY = 'ssssssss-0000-4000-8000-000000000002'
const OEE = 'ssssssss-0000-4000-8000-000000000003'
const SCHEMAS = [
  { schema_uuid: SPINDLE, schema_name: 'Spindle_Schema', status: 'active' },
  { schema_uuid: ENERGY, schema_name: 'Energy_Schema', status: 'active' },
  { schema_uuid: OEE, schema_name: 'OEE_Schema', status: 'active' },
]

const DEVICE_ID = 'aaaaaaaa-0000-4000-8000-000000000001'
const device = (overrides = {}) => ({
  asset_id: DEVICE_ID,
  asset_name: 'CNC_01',
  sparkplug_id: 'devaaaaaaaa000040008000',
  status: 'ONLINE',
  is_quarantined: false,
  is_archived: false,
  active_gateway_id: 'gw-1',
  cell_id: null,
  location_scope: 'cell',
  effective_cell_id: 'cell-1',
  gateway_cell_id: 'cell-1',
  location_source: 'inherited',
  conformance_policy: 'audit',
  created_at: '2026-07-20T12:00:00Z',
  schema_id: null,
  submodel_schema_ids: [],
  ...overrides
})

const GATEWAYS = [{
  gateway_id: 'gw-1', gateway_name: 'Line_A_Gateway', sparkplug_id: 'gwy-1',
  cell_id: 'cell-1', location_scope: 'cell', status: 'ONLINE', is_archived: false, devices: []
}]
const CELLS = [{ cell_id: 'cell-1', cell_name: 'Assembly', is_archived: false }]

let showToast

const show = async (rows) => {
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/gateways')) return Promise.resolve(GATEWAYS)
    if (path.startsWith('/api/v1/cells')) return Promise.resolve(CELLS)
    if (path.startsWith('/api/v1/quarantine')) return Promise.resolve([])
    if (path.startsWith('/api/v1/schemas')) return Promise.resolve(SCHEMAS)
    if (path.startsWith('/api/v1/devices')) return Promise.resolve(rows)
    return Promise.resolve([])
  })
  showToast = vi.fn()
  render(<DevicesTab showToast={showToast} onSelectDevice={vi.fn()} hasPermission={() => true} />)
  await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())
}

/** The picker: a group named by its legend, one labelled checkbox per schema. */
const picker = () => within(screen.getByRole('group', { name: /Schemas/ }))
const box = (name) => picker().getByRole('checkbox', { name })
const ticked = () => picker().getAllByRole('checkbox').filter(cb => cb.checked)
  .map(cb => cb.closest('label').textContent.trim())

const openEdit = () => {
  fireEvent.click(within(document.querySelector('.page-main')).getByText('CNC_01'))
  fireEvent.click(within(document.querySelector('.context-panel')).getByText('Edit Details'))
}

const save = () => fireEvent.click(screen.getByRole('button', { name: /Save Configuration/i }))

/** The calls to the schemas endpoint, as [path, body]. */
const schemaWrites = () => api.put.mock.calls.filter(([path]) => path.endsWith('/schemas'))

beforeEach(() => vi.clearAllMocks())

describe('creating a device', () => {
  it('attaches every ticked schema after the device exists', async () => {
    api.post.mockResolvedValue({ id: 'new-device-id' })
    api.put.mockResolvedValue({})
    await show([device()])

    fireEvent.click(screen.getByText(/New Device/))
    fireEvent.change(screen.getByPlaceholderText('e.g. CNC Mill 01'), { target: { value: 'Lathe_7' } })
    fireEvent.click(box('Spindle_Schema'))
    fireEvent.click(box('Energy_Schema'))
    save()

    await waitFor(() => expect(schemaWrites()).toHaveLength(1))
    const [[, created]] = api.post.mock.calls
    expect(created).not.toHaveProperty('schema_id')
    const [[path, body]] = schemaWrites()
    expect(path).toBe('/api/v1/devices/new-device-id/schemas')
    expect([...body.schema_ids].sort()).toEqual([SPINDLE, ENERGY].sort())
  })

  it('writes no schemas when none is ticked', async () => {
    api.post.mockResolvedValue({ id: 'new-device-id' })
    await show([device()])

    fireEvent.click(screen.getByText(/New Device/))
    fireEvent.change(screen.getByPlaceholderText('e.g. CNC Mill 01'), { target: { value: 'Lathe_7' } })
    save()

    await waitFor(() => expect(api.post).toHaveBeenCalled())
    expect(schemaWrites()).toHaveLength(0)
  })

  it('closes the form when the schemas fail, so a second save cannot create a second device', async () => {
    api.post.mockResolvedValue({ id: 'new-device-id' })
    api.put.mockRejectedValue(new Error('schema "Old" (v1) is archived and cannot be assigned to a device'))
    await show([device()])

    fireEvent.click(screen.getByText(/New Device/))
    fireEvent.change(screen.getByPlaceholderText('e.g. CNC Mill 01'), { target: { value: 'Lathe_7' } })
    fireEvent.click(box('Spindle_Schema'))
    save()

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/^Device created, but its schemas were not attached/), 'error'
    ))
    expect(screen.queryByRole('group', { name: /Schemas/ })).toBeNull()
    expect(api.post).toHaveBeenCalledTimes(1)
  })
})

describe('editing a device', () => {
  it('ticks the whole set, from the view and the column alike', async () => {
    await show([device({ schema_id: SPINDLE, submodel_schema_ids: [SPINDLE, ENERGY] })])
    openEdit()
    expect(ticked().sort()).toEqual(['Energy_Schema', 'Spindle_Schema'])
    expect(box('OEE_Schema').checked).toBe(false)
  })

  it('removes a schema that came from schema_id by writing the rest', async () => {
    api.put.mockResolvedValue({})
    await show([device({ schema_id: SPINDLE, submodel_schema_ids: [SPINDLE, ENERGY] })])
    openEdit()

    fireEvent.click(box('Spindle_Schema'))
    save()

    await waitFor(() => expect(schemaWrites()).toHaveLength(1))
    const [devicePath, deviceBody] = api.put.mock.calls[0]
    expect(devicePath).toBe(`/api/v1/devices/${DEVICE_ID}`)
    expect(deviceBody).not.toHaveProperty('schema_id')
    expect(schemaWrites()[0]).toEqual([`/api/v1/devices/${DEVICE_ID}/schemas`, { schema_ids: [ENERGY] }])
  })

  it('adds a schema beside the ones already attached', async () => {
    api.put.mockResolvedValue({})
    await show([device({ submodel_schema_ids: [SPINDLE] })])
    openEdit()

    fireEvent.click(box('OEE_Schema'))
    save()

    await waitFor(() => expect(schemaWrites()).toHaveLength(1))
    expect([...schemaWrites()[0][1].schema_ids].sort()).toEqual([SPINDLE, OEE].sort())
  })

  it('writes no schemas when the set did not change', async () => {
    api.put.mockResolvedValue({})
    await show([device({ schema_id: SPINDLE, submodel_schema_ids: [SPINDLE] })])
    openEdit()
    save()

    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(schemaWrites()).toHaveLength(0)
  })

  it('no longer names extra submodels in a note', async () => {
    await show([device({ submodel_schema_ids: [SPINDLE, ENERGY] })])
    openEdit()
    expect(screen.queryByText(/schemas attached/i)).toBeNull()
    expect(screen.queryByText(/sets only the primary/i)).toBeNull()
  })
})

describe('the picker is a labelled group of checkboxes', () => {
  it('names the group by its legend and each checkbox by its schema', async () => {
    await show([device()])
    openEdit()
    // Native checkboxes in a fieldset: Tab moves between them and Space toggles, with no handler.
    expect(screen.getByRole('group', { name: 'Schemas (optional)' })).toBeTruthy()
    for (const { schema_name } of SCHEMAS) {
      expect(box(schema_name).tagName).toBe('INPUT')
    }
  })
})
