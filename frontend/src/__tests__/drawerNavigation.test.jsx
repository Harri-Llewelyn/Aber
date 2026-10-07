import React from 'react'
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { CellsTab } from '../components/tabs/CellsTab'
import { SchemasTab } from '../components/tabs/SchemasTab'
import { useArrivalSelection } from '../hooks/useArrivalSelection'
import { api } from '../api'

/**
 * Cross-drawer navigation: the hops between the pages' context drawers. Two halves have to work and
 * fail independently: the chip has to call the hand-over with the right identifier (the first
 * block, per drawer), and the destination has to open that entity rather than merely filter to it
 * (useArrivalSelection, in its own block).
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

vi.mock('../lib/supabaseClient', () => ({
  supabase: { functions: { invoke: vi.fn() }, auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) } }
}))

const NOW = Date.parse('2026-08-17T12:00:00Z')

const SCHEMA = {
  schema_uuid: 'sch-machining',
  schema_name: 'Machining_Cell_Schema',
  version: 1,
  status: 'PUBLISHED',
  definition: { metrics: [{ name: 'Systems/TEMPERATURE', datatype: 10 }] }
}

const gateway = {
  gateway_id: 'gw-1',
  gateway_name: 'Sim_Gateway_CNC',
  sparkplug_id: 'gwy120000000000400080000',
  cell_id: 'cell-1',
  location_scope: 'cell',
  status: 'ONLINE',
  is_archived: false,
  last_heartbeat: new Date(NOW - 20_000).toISOString(),
  device_count: 1,
  devices: [{ asset_id: 'dev-1', asset_name: 'Sim_CNC_Mill_01', status: 'ONLINE' }]
}

/**
 * The device carries its schema through `submodel_schema_ids` and not `schema_id`, the shape the
 * drawer used to render as "Not set", so the fixture is the broken case rather than the convenient
 * one.
 */
const device = {
  asset_id: 'dev-1',
  asset_name: 'Sim_CNC_Mill_01',
  status: 'ONLINE',
  sparkplug_id: 'dev220000000000400080000',
  active_gateway_id: 'gw-1',
  schema_id: null,
  submodel_schema_ids: ['sch-machining'],
  connection_method: 'Modbus TCP',
  cell_id: null,
  location_scope: 'cell',
  effective_cell_id: 'cell-1',
  gateway_cell_id: 'cell-1',
  location_source: 'inherited'
}

const cell = { cell_id: 'cell-1', cell_name: 'Assembly Line 1', is_archived: false, gateways: [gateway], gateway_count: 1 }

const routeGet = (overrides = {}) => (path) => {
  if (path.includes('/telemetry')) return Promise.resolve(overrides.telemetry ?? [])
  if (path.includes('/config')) return Promise.resolve(overrides.config ?? [])
  if (path.startsWith('/api/v1/cells')) return Promise.resolve(overrides.cells ?? [cell])
  if (path.startsWith('/api/v1/gateways')) return Promise.resolve(overrides.gateways ?? [gateway])
  if (path.startsWith('/api/v1/devices')) return Promise.resolve(overrides.devices ?? [device])
  if (path.startsWith('/api/v1/schemas')) return Promise.resolve(overrides.schemas ?? [SCHEMA])
  if (path.startsWith('/api/v1/metric-catalog')) return Promise.resolve(overrides.catalog ?? [])
  return Promise.resolve([])
}

beforeEach(() => {
  vi.clearAllMocks()
  window.history.pushState({}, '', '/')
  api.get.mockImplementation(routeGet())
})

afterEach(() => { vi.useRealTimers?.() })

const panel = () => document.querySelector('.context-panel')
const isOpen = () => panel()?.classList.contains('context-panel-open')
const list = () => within(document.querySelector('.page-main'))
const openRow = async (name) => {
  await waitFor(() => expect(list().getByText(name)).toBeInTheDocument())
  fireEvent.click(list().getByText(name))
  await waitFor(() => expect(isOpen()).toBe(true))
}
/** A chip is a BUTTON, which is what separates it from the text it replaced. */
const chip = (name) => within(panel()).getByRole('button', { name: new RegExp(name, 'i') })

describe('a drawer names its neighbours, and each one is a way to reach them', () => {
  it('cell drawer -> gateway chip hands over the gateway id', async () => {
    const onSelectGateway = vi.fn()
    render(<CellsTab showToast={vi.fn()} hasPermission={() => true} onViewTrail={vi.fn()}
      onSelectDevice={vi.fn()} onSelectGateway={onSelectGateway} />)
    await openRow('Assembly Line 1')

    fireEvent.click(chip('Sim_Gateway_CNC'))
    expect(onSelectGateway).toHaveBeenCalledWith('gw-1')
  })

  it('cell drawer -> device chip hands over the device id', async () => {
    const onSelectDevice = vi.fn()
    render(<CellsTab showToast={vi.fn()} hasPermission={() => true} onViewTrail={vi.fn()}
      onSelectDevice={onSelectDevice} onSelectGateway={vi.fn()} />)
    await openRow('Assembly Line 1')

    fireEvent.click(chip('Sim_CNC_Mill_01'))
    expect(onSelectDevice).toHaveBeenCalledWith('dev-1')
  })

  it('keeps the cell\'s online figure on the label, so the chips did not cost the summary', async () => {
    render(<CellsTab showToast={vi.fn()} hasPermission={() => true} onViewTrail={vi.fn()}
      onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} />)
    await openRow('Assembly Line 1')

    // "how big is this cell and is it healthy" is answered at a glance by a figure and slowly by
    // counting chips, so the label keeps it.
    expect(within(panel()).getByText(/Devices \(1\/1 online\)/)).toBeTruthy()
  })

  it('gateway drawer -> device chip hands over the device id', async () => {
    const onSelectDevice = vi.fn()
    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} onViewTrail={vi.fn()}
      initialSearchFilter="" onClearFilter={vi.fn()} onSelectDevice={onSelectDevice} />)
    await openRow('Sim_Gateway_CNC')

    fireEvent.click(chip('Sim_CNC_Mill_01'))
    expect(onSelectDevice).toHaveBeenCalledWith('dev-1')
  })

  it('device drawer -> schema chip hands over the schema uuid', async () => {
    const onSelectSchema = vi.fn()
    render(<DevicesTab showToast={vi.fn()} hasPermission={() => true} onViewTrail={vi.fn()}
      initialSearchFilter="" onClearFilter={vi.fn()} onSelectSchema={onSelectSchema} />)
    await openRow('Sim_CNC_Mill_01')

    fireEvent.click(chip('Machining_Cell_Schema'))
    expect(onSelectSchema).toHaveBeenCalledWith('sch-machining')
  })

  it('schema drawer -> device chip hands over the device id', async () => {
    const onSelectDevice = vi.fn()
    render(<SchemasTab showToast={vi.fn()} hasPermission={() => true} onSelectSchema={vi.fn()}
      onSelectDevice={onSelectDevice} />)
    await openRow('Machining_Cell_Schema')

    fireEvent.click(chip('Sim_CNC_Mill_01'))
    expect(onSelectDevice).toHaveBeenCalledWith('dev-1')
  })
})

/** The device drawer's schema field, which was the defect rather than a missing convenience. */
describe('the device drawer resolves a schema by either route', () => {
  const renderDevices = (extra = {}) => render(
    <DevicesTab showToast={vi.fn()} hasPermission={() => true} onViewTrail={vi.fn()}
      initialSearchFilter="" onClearFilter={vi.fn()} onSelectSchema={vi.fn()} {...extra} />
  )

  it('finds a schema attached through device_submodels, not only through schema_id', async () => {
    // The fixture carries schema_id: null and submodel_schema_ids: ['sch-machining']. Reading
    // `schema_id` alone rendered "Not set" while the table beside it listed the schema's tags from
    // the same row.
    renderDevices()
    await openRow('Sim_CNC_Mill_01')
    expect(chip('Machining_Cell_Schema')).toBeTruthy()
  })

  it('still finds one attached the 1:1 way', async () => {
    api.get.mockImplementation(routeGet({
      devices: [{ ...device, schema_id: 'sch-machining', submodel_schema_ids: [] }]
    }))
    renderDevices()
    await openRow('Sim_CNC_Mill_01')
    expect(chip('Machining_Cell_Schema')).toBeTruthy()
  })

  it('says nothing rather than inventing a chip when no schema is attached', async () => {
    api.get.mockImplementation(routeGet({
      devices: [{ ...device, schema_id: null, submodel_schema_ids: [] }]
    }))
    renderDevices()
    await openRow('Sim_CNC_Mill_01')
    expect(within(panel()).queryByRole('button', { name: /Machining_Cell_Schema/i })).toBeNull()
  })

  it('renders every attached schema, not just the first', async () => {
    const second = { ...SCHEMA, schema_uuid: 'sch-oee', schema_name: 'ISO22400_OEE_Schema' }
    api.get.mockImplementation(routeGet({
      schemas: [SCHEMA, second],
      devices: [{ ...device, submodel_schema_ids: ['sch-machining', 'sch-oee'] }]
    }))
    renderDevices()
    await openRow('Sim_CNC_Mill_01')
    expect(chip('Machining_Cell_Schema')).toBeTruthy()
    expect(chip('ISO22400_OEE_Schema')).toBeTruthy()
  })

  /**
   * Connection method is gone from the drawer as well as the form: ingestion is a Sparkplug B MQTT
   * subscriber with no other transport, so a row reading "Modbus TCP" describes nothing that
   * happens.
   */
  it('does not state a connection method the platform contradicts', async () => {
    renderDevices()
    await openRow('Sim_CNC_Mill_01')
    expect(within(panel()).queryByText(/Connection Method/i)).toBeNull()
    expect(within(panel()).queryByText(/Modbus TCP/i)).toBeNull()
  })

  /** The edit form's schema checkboxes, named by their schema. */
  const openEditPicker = async () => {
    await openRow('Sim_CNC_Mill_01')
    fireEvent.click(within(panel()).getByRole('button', { name: /Edit Details/i }))
    return within(await screen.findByRole('group', { name: /Schemas/i }))
  }

  it('ticks the attached schema when the edit form opens', async () => {
    // Copying schema_id straight into the form read "No schema assigned" for a device the rest of
    // the page showed as schema'd, and any other save confirmed it.
    renderDevices()
    const picker = await openEditPicker()
    expect(picker.getByRole('checkbox', { name: 'Machining_Cell_Schema' }).checked).toBe(true)
  })

  it('ticks a schema from either path, the column as well as a submodel', async () => {
    // A row read without the view still carries both: schemaIdsForDevice() unions them, as the
    // device_schemas view does.
    const second = { ...SCHEMA, schema_uuid: 'sch-oee', schema_name: 'ISO22400_OEE_Schema' }
    api.get.mockImplementation(routeGet({
      schemas: [SCHEMA, second],
      devices: [{ ...device, schema_id: 'sch-oee', submodel_schema_ids: ['sch-machining'] }]
    }))
    renderDevices()
    const picker = await openEditPicker()
    expect(picker.getByRole('checkbox', { name: 'ISO22400_OEE_Schema' }).checked).toBe(true)
    expect(picker.getByRole('checkbox', { name: 'Machining_Cell_Schema' }).checked).toBe(true)
  })

  it('offers every attached schema in the picker, with no note about extra submodels', async () => {
    const second = { ...SCHEMA, schema_uuid: 'sch-oee', schema_name: 'ISO22400_OEE_Schema' }
    api.get.mockImplementation(routeGet({
      schemas: [SCHEMA, second],
      devices: [{ ...device, submodel_schema_ids: ['sch-machining', 'sch-oee'] }]
    }))
    renderDevices()
    const picker = await openEditPicker()
    expect(picker.getAllByRole('checkbox').filter(cb => cb.checked)).toHaveLength(2)
    expect(screen.queryByText(/schemas attached/i)).toBeNull()
  })
})

/**
 * The destination half. Without this the chips merely filter, and a hop still ends in a click.
 */
describe('useArrivalSelection', () => {
  const rows = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }]
  const byId = (row, term) => row.id === term

  const run = (initial) => {
    const onArrive = vi.fn()
    const view = renderHook(
      ({ term, list }) => useArrivalSelection(term, list, byId, onArrive),
      { initialProps: { term: initial, list: rows } }
    )
    return { onArrive, ...view }
  }

  it('opens the entity a hand-over named', () => {
    const { onArrive } = run('b')
    expect(onArrive).toHaveBeenCalledWith(rows[1])
  })

  it('opens nothing for a term that is not an identifier', () => {
    // The pages' own search predicates match names with `includes`; this one matches ids with
    // `===`. Typing "Alpha" narrows the table and must NOT force a drawer open.
    const { onArrive } = run('Alpha')
    expect(onArrive).not.toHaveBeenCalled()
  })

  it('opens nothing on an empty term', () => {
    const { onArrive } = run('')
    expect(onArrive).not.toHaveBeenCalled()
  })

  it('waits for rows that have not loaded yet', () => {
    const onArrive = vi.fn()
    const { rerender } = renderHook(
      ({ term, list }) => useArrivalSelection(term, list, byId, onArrive),
      { initialProps: { term: 'a', list: [] } }
    )
    // The first render always precedes the fetch, so a one-shot read in the tab's initial state
    // would miss every hand-over. This is why it is a hook.
    expect(onArrive).not.toHaveBeenCalled()

    rerender({ term: 'a', list: rows })
    expect(onArrive).toHaveBeenCalledWith(rows[0])
  })

  it('does not re-open on a poll, so closing the drawer is permanent', () => {
    const onArrive = vi.fn()
    const { rerender } = renderHook(
      ({ term, list }) => useArrivalSelection(term, list, byId, onArrive),
      { initialProps: { term: 'a', list: rows } }
    )
    expect(onArrive).toHaveBeenCalledTimes(1)

    // Every refresh hands down a FRESH ARRAY. Without the memo this effect re-runs and re-opens the
    // panel the operator just dismissed, roughly every three seconds.
    rerender({ term: 'a', list: [...rows] })
    rerender({ term: 'a', list: [...rows] })
    expect(onArrive).toHaveBeenCalledTimes(1)
  })

  it('opens again when a SECOND hand-over names a different entity', () => {
    const onArrive = vi.fn()
    const { rerender } = renderHook(
      ({ term, list }) => useArrivalSelection(term, list, byId, onArrive),
      { initialProps: { term: 'a', list: rows } }
    )
    rerender({ term: 'b', list: rows })
    expect(onArrive).toHaveBeenNthCalledWith(2, rows[1])
  })

  it('re-opens the same entity after the filter has been cleared in between', () => {
    // Clearing is the only thing that resets the memory: navigate away, come back to the same
    // device, and it must open again rather than being remembered as already handled.
    const onArrive = vi.fn()
    const { rerender } = renderHook(
      ({ term, list }) => useArrivalSelection(term, list, byId, onArrive),
      { initialProps: { term: 'a', list: rows } }
    )
    rerender({ term: '', list: rows })
    rerender({ term: 'a', list: rows })
    expect(onArrive).toHaveBeenCalledTimes(2)
  })

  it('survives a malformed row rather than taking the page down over a convenience', () => {
    const onArrive = vi.fn()
    renderHook(() => useArrivalSelection('a', [null, ...rows], (r, t) => r.id === t, onArrive))
    expect(onArrive).toHaveBeenCalledWith(rows[0])
  })
})

/** The four pages, each opening the entity it was handed. */
describe('arriving with an identifier opens that entity\'s drawer', () => {
  it('Devices, by asset id', async () => {
    render(<DevicesTab showToast={vi.fn()} hasPermission={() => true} onViewTrail={vi.fn()}
      initialSearchFilter="dev-1" onClearFilter={vi.fn()} />)
    await waitFor(() => expect(isOpen()).toBe(true))
    expect(within(panel()).getByText('Sim_CNC_Mill_01')).toBeTruthy()
  })

  it('Devices, by sparkplug id -- which is what an alert row carries', async () => {
    render(<DevicesTab showToast={vi.fn()} hasPermission={() => true} onViewTrail={vi.fn()}
      initialSearchFilter="dev220000000000400080000" onClearFilter={vi.fn()} />)
    await waitFor(() => expect(isOpen()).toBe(true))
  })

  it('Gateways, by gateway id', async () => {
    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} onViewTrail={vi.fn()}
      initialSearchFilter="gw-1" onClearFilter={vi.fn()} />)
    await waitFor(() => expect(isOpen()).toBe(true))
  })

  it('Cells, by cell id', async () => {
    render(<CellsTab showToast={vi.fn()} hasPermission={() => true} onViewTrail={vi.fn()}
      onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} initialSearchFilter="cell-1" />)
    await waitFor(() => expect(isOpen()).toBe(true))
  })

  it('Schemas, by schema uuid', async () => {
    // The device drawer's Schema chip must land on that one schema, not on an unfiltered list of
    // every schema in the registry.
    render(<SchemasTab showToast={vi.fn()} hasPermission={() => true} onSelectSchema={vi.fn()}
      onSelectDevice={vi.fn()} initialSchemaId="sch-machining" />)
    await waitFor(() => expect(isOpen()).toBe(true))
    expect(within(panel()).getByText('Machining_Cell_Schema')).toBeTruthy()
  })

  it('opens nothing when the page is merely searched', async () => {
    render(<DevicesTab showToast={vi.fn()} hasPermission={() => true} onViewTrail={vi.fn()}
      initialSearchFilter="Mill" onClearFilter={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Sim_CNC_Mill_01')).toBeInTheDocument())
    expect(isOpen()).toBe(false)
  })
})
