import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { api } from '../api'

/**
 * The Devices tab's Schema Conformance control (migration 0050).
 *
 * THIS IS THE ONE FIELD ON THE FORM THAT CAN DESTROY DATA. Setting it to `enforce` makes the
 * ingestion daemon drop a metric whose value contradicts the device's bound schema, and telemetry
 * that was never written cannot be fetched back from anywhere -- unlike a schema edit, which can
 * be reverted.
 *
 * So the assertions here are about the two ways the control can mislead rather than about it
 * rendering: choosing `enforce` on a device with no schema attached does nothing at all, and
 * choosing it on a device that has one starts discarding readings on the next message.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

vi.mock('../lib/supabaseClient', () => ({
  supabase: { functions: { invoke: vi.fn() } }
}))

const SCHEMA_UUID = 'ssssssss-0000-4000-8000-000000000001'

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
  effective_cell_id: 'cell-1',
  gateway_cell_id: 'cell-1',
  location_source: 'inherited',
  conformance_policy: 'audit',
  created_at: '2026-07-20T12:00:00Z',
  ...overrides
})

const GATEWAYS = [{
  gateway_id: 'gw-1', gateway_name: 'Line_A_Gateway', sparkplug_id: 'gwy-1',
  cell_id: 'cell-1', location_scope: 'cell', status: 'ONLINE', is_archived: false, devices: []
}]
const CELLS = [{ cell_id: 'cell-1', cell_name: 'Assembly', is_archived: false }]
const SCHEMAS = [{ schema_uuid: SCHEMA_UUID, schema_name: 'CNC_Mill_v1', device_count: 1 }]

const routeGet = (rows, schemas) => (path) => {
  if (path.startsWith('/api/v1/gateways')) return Promise.resolve(GATEWAYS)
  if (path.startsWith('/api/v1/cells')) return Promise.resolve(CELLS)
  if (path.startsWith('/api/v1/quarantine')) return Promise.resolve([])
  if (path.startsWith('/api/v1/schemas')) return Promise.resolve(schemas)
  if (path.startsWith('/api/v1/devices')) return Promise.resolve(rows)
  return Promise.resolve([])
}

const show = async (rows, schemas = SCHEMAS) => {
  api.get.mockImplementation(routeGet(rows, schemas))
  render(<DevicesTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={() => true} />)
  await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())
}

const openEdit = () => {
  fireEvent.click(within(document.querySelector('.page-main')).getByText('CNC_01'))
  fireEvent.click(within(document.querySelector('.context-panel')).getByText('Edit Details'))
}

/** The conformance select, found by the option text rather than by position. */
const policySelect = () =>
  [...document.querySelectorAll('select')].find(
    el => within(el).queryByText(/Audit — record the violation/)
  )

beforeEach(() => vi.clearAllMocks())

describe('the Schema Conformance control', () => {

  it('offers both policies and shows the device\'s current one', async () => {
    await show([device({ schema_id: SCHEMA_UUID, conformance_policy: 'enforce' })])
    openEdit()
    expect(policySelect().value).toBe('enforce')
  })

  it('defaults to audit for a device that has never been set', async () => {
    // A row cached or created before 0050 has no such key. Absent must read as audit, which is
    // what the column defaults to, rather than rendering blank and saving something else.
    const d = device({ schema_id: SCHEMA_UUID })
    delete d.conformance_policy
    await show([d])
    openEdit()
    expect(policySelect().value).toBe('audit')
  })

  it('does not offer the control when creating a device', async () => {
    // A device being created has no schema attached, so the choice could not do anything, and the
    // column defaults server-side. Offering it would be a control that decides nothing.
    await show([device()])
    fireEvent.click(screen.getByText(/Register Device|Add Device|New Device/i))
    expect(policySelect()).toBeUndefined()
  })

  it('warns that enforcing does nothing when no schema is attached', async () => {
    // THE STATE THAT LOOKS LIKE IT WORKED. With nothing bound the daemon has nothing to judge
    // against, so `enforce` is inert -- and an operator who set it would reasonably believe they
    // had switched something on.
    await show([device({ schema_id: null })], [])
    openEdit()
    fireEvent.change(policySelect(), { target: { value: 'enforce' } })
    expect(screen.getByText(/no schema attached, so enforcing does nothing/i)).toBeInTheDocument()
  })

  it('warns that readings will be discarded when switching a schema-bound device on', async () => {
    await show([device({ schema_id: SCHEMA_UUID })])
    openEdit()
    fireEvent.change(policySelect(), { target: { value: 'enforce' } })
    expect(screen.getByText(/cannot be recovered/i)).toBeInTheDocument()
  })

  it('does not re-warn a device that already enforces', async () => {
    // The warning is about the CHANGE, not the state. Somebody reopening a device that already
    // enforces does not need telling again, and a banner that never goes away stops being read.
    await show([device({ schema_id: SCHEMA_UUID, conformance_policy: 'enforce' })])
    openEdit()
    expect(screen.queryByText(/cannot be recovered/i)).not.toBeInTheDocument()
  })

  it('sends the chosen policy on save', async () => {
    api.put.mockResolvedValue({})
    await show([device({ schema_id: SCHEMA_UUID })])
    openEdit()
    fireEvent.change(policySelect(), { target: { value: 'enforce' } })
    fireEvent.click(screen.getByRole('button', { name: /Save Configuration/i }))

    await waitFor(() => expect(api.put).toHaveBeenCalled())
    const [, body] = api.put.mock.calls[0]
    expect(body.conformance_policy).toBe('enforce')
  })
})
