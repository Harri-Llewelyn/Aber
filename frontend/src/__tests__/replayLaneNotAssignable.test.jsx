import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { ApproveQuarantineModal } from '../components/modals/ApproveQuarantineModal'
import { api } from '../api'
import { gatewayAcceptsDevices, noDeviceAssignmentReason } from '../utils/gatewayType'

/**
 * A device cannot be assigned to the Playback gateway: it would appear on the shadow lane without
 * `shadow_of`, an asset with no provenance. The real guard is in the database
 * (supabase/migrations/test_shadow_lane_is_not_assignable.py); these cover the UI courtesy, and one
 * property of it: disabled, not filtered. Dropping shadow gateways from the list would leave a
 * replay-lane device's own gateway absent from the select, and saving the form would silently move
 * it off the lane.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

vi.mock('../lib/supabaseClient', () => ({
  supabase: { functions: { invoke: vi.fn() } }
}))

const CELL_1 = 'cell-1'
const PLAYBACK = 'gw-playback'

const GATEWAYS = [
  { gateway_id: 'gw-1', gateway_name: 'Line_A_Gateway', sparkplug_id: 'gwy-1', cell_id: CELL_1, location_scope: 'cell', status: 'ONLINE', is_archived: false, devices: [] },
  // `gateways_shadow_is_simulated` requires is_simulated, and `gateways_synthetic_has_no_cell`
  // forbids a cell -- so the fixture cannot be written any other way.
  { gateway_id: PLAYBACK, gateway_name: 'Playback', cell_id: null, location_scope: 'cell', deployment: 'host', is_simulated: true, is_shadow: true, status: 'ONLINE', is_archived: false, devices: [] }
]

const CELLS = [{ cell_id: CELL_1, cell_name: 'Assembly', is_archived: false }]

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
  effective_cell_id: CELL_1,
  gateway_cell_id: CELL_1,
  location_source: 'inherited',
  cell_mismatch: false,
  first_dbirth_at: '2026-07-27T12:00:00Z',
  created_at: '2026-07-20T12:00:00Z',
  ...overrides
})

const routeGet = (rows) => (path) => {
  if (path.startsWith('/api/v1/gateways')) return Promise.resolve(GATEWAYS)
  if (path.startsWith('/api/v1/cells')) return Promise.resolve(CELLS)
  if (path.startsWith('/api/v1/quarantine')) return Promise.resolve([])
  if (path.startsWith('/api/v1/devices')) return Promise.resolve(rows)
  return Promise.resolve([])
}

const show = async (rows, expectName = 'CNC_01') => {
  api.get.mockImplementation(routeGet(rows))
  render(<DevicesTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={() => true} />)
  await waitFor(() => expect(screen.getByText(expectName)).toBeTruthy())
}

const openEdit = (name = 'CNC_01') => {
  fireEvent.click(within(document.querySelector('.page-main')).getByText(name))
  fireEvent.click(within(document.querySelector('.context-panel')).getByText('Edit Details'))
}

/** The device form's gateway control, found by the option only it renders. */
const gatewaySelect = () => {
  const modal = document.querySelector('.modal, .modal-content') || document
  return [...modal.querySelectorAll('select')].find(
    (s) => [...s.options].some((o) => o.textContent.includes('Unassigned Gateway'))
  )
}

const optionFor = (select, gatewayId) =>
  [...select.options].find((o) => o.value === gatewayId)

beforeEach(() => vi.clearAllMocks())

describe('gatewayAcceptsDevices', () => {
  it('refuses a shadow gateway', () => {
    expect(gatewayAcceptsDevices({ is_shadow: true })).toBe(false)
  })

  it('accepts an ordinary gateway', () => {
    expect(gatewayAcceptsDevices({ is_shadow: false })).toBe(true)
  })

  it('accepts a merely simulated gateway', () => {
    // The two are not the same lane and only one is minted: a simulator's devices are created by an
    // operator like any other; the replay lane stands in for a real machine and must record which
    // one.
    expect(gatewayAcceptsDevices({ is_simulated: true, is_shadow: false })).toBe(true)
  })

  it('accepts null, because a device with no gateway is unassigned rather than invalid', () => {
    expect(gatewayAcceptsDevices(null)).toBe(true)
    expect(gatewayAcceptsDevices(undefined)).toBe(true)
  })

  it('explains itself only for the gateway it refuses', () => {
    expect(noDeviceAssignmentReason({ is_shadow: false })).toBeNull()
    expect(noDeviceAssignmentReason({ is_shadow: true })).toMatch(/replay lanes/i)
    // Names the gesture that DOES work. A refusal that does not is a support question.
    expect(noDeviceAssignmentReason({ is_shadow: true })).toMatch(/playback/i)
  })
})

describe("the device form's gateway picker", () => {
  it('disables the Playback gateway', async () => {
    await show([device()])
    openEdit()
    const select = gatewaySelect()
    expect(optionFor(select, PLAYBACK).disabled).toBe(true)
  })

  it('leaves ordinary gateways selectable', async () => {
    await show([device()])
    openEdit()
    const select = gatewaySelect()
    expect(optionFor(select, 'gw-1').disabled).toBe(false)
  })

  it('still LISTS the Playback gateway rather than hiding it', async () => {
    // THE REGRESSION THIS TEST EXISTS FOR. See the header: filtering the option away would make a
    // replay lane's own form fall back to "Unassigned" and move it off the lane on save.
    await show([device()])
    openEdit()
    expect(optionFor(gatewaySelect(), PLAYBACK)).toBeTruthy()
  })

  it('keeps an existing replay lane showing its own gateway', async () => {
    // A device that IS a lane. Its gateway must remain the select's value -- a disabled option is
    // still a rendered, selected one, which is the whole reason for disabling rather than removing.
    await show([device({
      asset_id: 'bbbbbbbb-0000-4000-8000-000000000002',
      asset_name: 'CNC_01 (replay)',
      active_gateway_id: PLAYBACK,
      effective_cell_id: null,
      gateway_cell_id: null,
      location_source: 'shadow'
    })], 'CNC_01 (replay)')
    openEdit('CNC_01 (replay)')
    expect(gatewaySelect().value).toBe(PLAYBACK)
  })

  it('says why the option is unavailable', async () => {
    await show([device()])
    openEdit()
    expect(screen.getByText(/replay lanes, minted when a capture is played/i)).toBeTruthy()
  })
})

describe("the quarantine approval modal's gateway picker", () => {
  // An auto-discovered device is approved ONTO a gateway, which is the same assignment by another
  // door -- and the one an operator reaches without ever opening the Devices form.
  const item = {
    device_id: 'cccccccc-0000-4000-8000-000000000003',
    reported_name: 'Unknown_Spindle',
    sparkplug_id: 'devcccccccc000040008000',
    gateway_id: 'gw-1',
    gateway_name: 'Line_A_Gateway'
  }

  const openModal = () => render(
    <ApproveQuarantineModal
      item={item}
      cells={CELLS}
      gateways={GATEWAYS}
      suggestion={null}
      onApprove={vi.fn()}
      onMerge={vi.fn()}
      onCancel={vi.fn()}
    />
  )

  it('disables the Playback gateway', () => {
    openModal()
    const select = [...document.querySelectorAll('select')].find(
      (s) => [...s.options].some((o) => o.textContent.includes('Unassigned Gateway'))
    )
    expect(optionFor(select, PLAYBACK).disabled).toBe(true)
    expect(optionFor(select, 'gw-1').disabled).toBe(false)
  })
})
