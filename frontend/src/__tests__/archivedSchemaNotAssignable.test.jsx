import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { assignableSchemas, isAssignableSchema } from '../utils/schemaVersion'
import { api } from '../api'

/**
 * An archived schema must not be assignable from Edit Details: publishing v2 archives v1 and
 * repoints every device, and a device set to `enforce` judged against the superseded version has
 * readings dropped. Two assertions: archived versions are filtered out, and the version the device
 * is already on is kept so the select does not fall back to its first entry and reassign on the
 * next save. The database refuses the write as well.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

vi.mock('../lib/supabaseClient', () => ({
  supabase: { functions: { invoke: vi.fn() } }
}))

const V1 = 'ssssssss-0000-4000-8000-000000000001'
const V2 = 'ssssssss-0000-4000-8000-000000000002'
const DRAFT = 'ssssssss-0000-4000-8000-000000000003'

const SCHEMAS = [
  { schema_uuid: V1, schema_name: 'Test_Schema', version: 1, status: 'archived', parent_schema_id: null },
  { schema_uuid: V2, schema_name: 'Test_Schema_v2', version: 2, status: 'active', parent_schema_id: V1 },
  { schema_uuid: DRAFT, schema_name: 'Test_Schema_v3', version: 3, status: 'draft', parent_schema_id: V2 }
]

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

const show = async (rows) => {
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/gateways')) return Promise.resolve(GATEWAYS)
    if (path.startsWith('/api/v1/cells')) return Promise.resolve(CELLS)
    if (path.startsWith('/api/v1/quarantine')) return Promise.resolve([])
    if (path.startsWith('/api/v1/schemas')) return Promise.resolve(SCHEMAS)
    if (path.startsWith('/api/v1/devices')) return Promise.resolve(rows)
    return Promise.resolve([])
  })
  render(<DevicesTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={() => true} />)
  await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())
}

const openEdit = () => {
  fireEvent.click(within(document.querySelector('.page-main')).getByText('CNC_01'))
  fireEvent.click(within(document.querySelector('.context-panel')).getByText('Edit Details'))
}

/**
 * The schema picker, found by its "no schema" option rather than by position: the modal holds
 * several selects and the tab holds a schema filter that legitimately lists archived versions.
 */
const schemaSelect = () =>
  [...document.querySelectorAll('.modal select')].find(
    el => within(el).queryByText('— No schema assigned —')
  )

const optionTexts = () => [...schemaSelect().options].map(o => o.textContent.trim())

beforeEach(() => vi.clearAllMocks())

describe('assignableSchemas()', () => {

  it('drops archived versions and keeps drafts', () => {
    const offered = assignableSchemas(SCHEMAS, '').map(s => s.schema_name)
    expect(offered).toEqual(['Test_Schema_v2', 'Test_Schema_v3'])
  })

  it('keeps the archived version the device is already carrying', () => {
    const offered = assignableSchemas(SCHEMAS, V1).map(s => s.schema_name)
    expect(offered).toEqual(['Test_Schema', 'Test_Schema_v2', 'Test_Schema_v3'])
  })

  it('treats a row with no status as active, the way the column default does', () => {
    expect(isAssignableSchema({ schema_uuid: 'x', schema_name: 'legacy' })).toBe(true)
  })
})

describe('the Edit Details schema picker', () => {

  it('does not offer an archived version to a device that is not on one', async () => {
    await show([device({ schema_id: V2 })])
    openEdit()
    expect(optionTexts()).not.toContain('Test_Schema')
    expect(optionTexts()).toContain('Test_Schema_v2')
  })

  it('still offers a draft, which is how a version is tried before publishing', async () => {
    await show([device({ schema_id: V2 })])
    openEdit()
    expect(optionTexts()).toContain('Test_Schema_v3')
  })

  it('keeps a device that is already on an archived version showing it, labelled', async () => {
    await show([device({ schema_id: V1 })])
    openEdit()
    expect(schemaSelect().value).toBe(V1)
    expect(optionTexts()).toContain('Test_Schema · Archived')
  })

  it('says what to do about it rather than only that it is archived', async () => {
    await show([device({ schema_id: V1 })])
    openEdit()
    expect(
      within(document.querySelector('.modal')).getByText(/still on an archived version/)
    ).toBeTruthy()
  })

  it('says nothing of the kind for a device on the current version', async () => {
    await show([device({ schema_id: V2 })])
    openEdit()
    expect(
      within(document.querySelector('.modal')).queryByText(/still on an archived version/)
    ).toBeNull()
  })
})
