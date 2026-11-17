import React from 'react'
import { render, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SchemasTab } from '../components/tabs/SchemasTab'
import { api } from '../api'
import { getByTooltip } from '../test/tooltips'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

/**
 * The Validate Payload tooltip names a schema by its lineage and version once, then its status:
 * `Robot_Arm_Schema v2 (Draft)`, not `v2 · Draft of Robot_Arm_Schema_v2`.
 */
const DEFINITION = { type: 'object', properties: { 'Systems/TEMPERATURE': { type: 'number' } } }

const V1 = {
  schema_uuid: 'v1-uuid',
  schema_name: 'Robot_Arm_Schema',
  lineage_name: 'Robot_Arm_Schema',
  schema_definition: DEFINITION,
  version: 1,
  status: 'archived',
  parent_schema_id: null,
  change_description: 'Initial release'
}
const DRAFT_V2 = {
  ...V1,
  schema_uuid: 'v2-uuid',
  schema_name: 'Robot_Arm_Schema_v2',
  version: 2,
  status: 'draft',
  parent_schema_id: 'v1-uuid',
  change_description: 'More'
}

const routes = { '/api/v1/schemas': [V1, DRAFT_V2] }

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation((path) => {
    const key = Object.keys(routes).find(r => path.startsWith(r))
    return Promise.resolve(key ? routes[key] : [])
  })
})

describe('the Validate Payload tooltip', () => {
  it('prints the lineage’s name and the version once, then the status', async () => {
    render(<SchemasTab showToast={vi.fn()} hasPermission={() => true} onSelectSchema={vi.fn()} />)
    const table = await waitFor(() => {
      const found = [...document.querySelectorAll('.card-header .section-title')]
        .find(h => h.textContent.includes('Schemas'))?.closest('.card')?.querySelector('table')
      if (!found) throw new Error('the registry has not drawn')
      return found
    })
    fireEvent.click(await within(table).findByText('Robot_Arm_Schema_v2'))

    const panel = document.querySelector('.context-panel')
    const button = getByTooltip(
      "Judge one DDATA payload against Robot_Arm_Schema v2 (Draft), by ingestion's Schema Conformance rules",
      panel
    )
    expect(button.textContent).toContain('Validate Payload')
  })
})
