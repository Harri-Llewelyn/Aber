import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { api } from '../api'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

vi.mock('../lib/supabaseClient', () => ({
  supabase: { functions: { invoke: vi.fn() } }
}))

const device = (overrides = {}) => ({
  asset_id: 'aaaaaaaa-0000-4000-8000-000000000001',
  asset_name: 'CNC_01',
  sparkplug_id: 'devaaaaaaaa000040008000',
  status: 'ONLINE',
  is_quarantined: false,
  is_archived: false,
  active_gateway_id: 'gw-1',
  cell_id: 'cell-1',
  first_dbirth_at: '2026-07-27T12:00:00Z',
  created_at: '2026-07-20T12:00:00Z',
  ...overrides
})

const routeGet = (rows) => (path) => {
  if (path.startsWith('/api/v1/gateways')) {
    return Promise.resolve([{ gateway_id: 'gw-1', gateway_name: 'Line_A_Gateway', cell_id: 'cell-1', status: 'ONLINE', is_archived: false, devices: [] }])
  }
  if (path.startsWith('/api/v1/cells')) return Promise.resolve([{ cell_id: 'cell-1', cell_name: 'Cell 1' }])
  if (path.startsWith('/api/v1/devices')) return Promise.resolve(rows)
  return Promise.resolve([])
}

const show = async (rows, hasPermission = () => true) => {
  api.get.mockImplementation(routeGet(rows))
  render(<DevicesTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={hasPermission} />)
  await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())
}

const openMenu = (id = 'aaaaaaaa-0000-4000-8000-000000000001') =>
  fireEvent.click(screen.getByTestId(`device-actions-${id}`))

const menuLabels = () =>
  within(screen.getByRole('menu')).getAllByRole('menuitem').map(i => i.textContent)

beforeEach(() => vi.clearAllMocks())

describe('device row actions', () => {
  it('keeps only the primary action in the row itself', async () => {
    // The cell used to carry seven controls and take over half the row's width.
    await show([device()])

    expect(screen.getByRole('button', { name: /^Edit/i })).toBeInTheDocument()
    // Telemetry is no longer a button here: it navigated to a separate page and made you
    // re-select the device you were already looking at. It is now a drawer on the row below.
    expect(screen.queryByRole('button', { name: /^Telemetry$/i })).not.toBeInTheDocument()
    expect(screen.getByText('Telemetry')).toBeInTheDocument()
    // Everything else moved behind the overflow menu.
    expect(screen.queryByRole('button', { name: /^Config/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Thread/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Archive/i })).not.toBeInTheDocument()
  })

  it('collects the secondary actions in the menu', async () => {
    await show([device()])
    openMenu()

    const labels = menuLabels().join('|')
    for (const expected of [/Digital Thread/i, /Configuration Parameters/i,
      /Export AAS JSON/i, /Export AASX package/i, /Archive device/i]) {
      expect(labels).toMatch(expected)
    }
    // Documents left the menu: the accordion is rendered inline on every row, so there is
    // nothing here to toggle. This also returns a slot to a menu that had grown to seven items.
    expect(labels).not.toMatch(/documents/i)
  })

  it('promotes Restore into the row for an archived device', async () => {
    // Restore is the ONLY action that means anything on an archived row. Burying it in the menu
    // would make archived devices harder to work with, which is the opposite of the point.
    await show([device({ is_archived: true })])

    expect(screen.getByRole('button', { name: /Restore/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Edit/i })).not.toBeInTheDocument()
  })

  it('never offers Archive and Restore at once', async () => {
    await show([device({ is_archived: true })])
    openMenu()

    expect(menuLabels().join('|')).not.toMatch(/Archive device/i)
    // ...and no stray separator is left behind where the Archive item was filtered out.
    expect(within(screen.getByRole('menu')).queryAllByRole('separator').length).toBeLessThanOrEqual(1)
  })

  it('disables the write actions for a role that cannot manage devices', async () => {
    await show([device()], () => false)
    openMenu()

    const menu = within(screen.getByRole('menu'))
    expect(menu.getByRole('menuitem', { name: /Archive device/i }).disabled).toBe(true)
    // Reads are not gated: an export is a read, and so is the audit trace -- and so, now that
    // the 3D uploader has moved out of it, is Configuration Parameters. It shows what the
    // device declared at birth and writes nothing.
    expect(menu.getByRole('menuitem', { name: /Digital Thread/i }).disabled).toBe(false)
    expect(menu.getByRole('menuitem', { name: /Export AAS JSON/i }).disabled).toBe(false)
    expect(menu.getByRole('menuitem', { name: /Configuration Parameters/i }).disabled).toBe(false)
  })

  // Standardised on the Cells page's treatment: the accordion is part of the row, collapsed,
  // rather than something to be revealed through an overflow menu first.
  it('renders the documents accordion inline on every row, with no menu step', async () => {
    await show([device()])

    expect(screen.getByText('Attached Document Links')).toBeInTheDocument()
    // Present but closed: it fetches only on first expand, so an always-mounted row costs
    // no request.
    expect(screen.queryByText(/No external document links attached/)).not.toBeInTheDocument()
  })

  it('expands in place to reveal the links', async () => {
    await show([device()])

    fireEvent.click(screen.getByText('Attached Document Links'))

    await waitFor(() =>
      expect(screen.getByText(/No external document links attached to this device/)).toBeInTheDocument()
    )
  })
})

// The 3D model moved out of the Configuration modal and into the row's document accordion. It is
// an attachment, like a document link -- and it was the only control in that modal that wrote
// anything, which is why the modal is now open to every role.
describe('device 3D model attachment', () => {
  it('offers the uploader inside the expanded documents accordion', async () => {
    await show([device()])

    // Collapsed: the uploader is part of the accordion body, so it is not mounted yet.
    expect(screen.queryByTestId('model-3d-input')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Attached Document Links'))

    await waitFor(() => expect(screen.getByTestId('model-3d-input')).toBeInTheDocument())
  })

  it('shows the uploader even when the device has no document links', async () => {
    // The footer renders alongside the empty state, not instead of it -- otherwise a device with
    // a model but no links would have nowhere to show the model.
    await show([device()])

    fireEvent.click(screen.getByText('Attached Document Links'))

    await waitFor(() =>
      expect(screen.getByText(/No external document links attached to this device/)).toBeInTheDocument()
    )
    expect(screen.getByTestId('model-3d-input')).toBeInTheDocument()
  })

  it('no longer advertises the 3D model from the Configuration menu item', async () => {
    await show([device()])
    openMenu()

    const labels = menuLabels().join('|')
    expect(labels).toMatch(/Configuration Parameters/i)
    expect(labels).not.toMatch(/3D model/i)
  })

  it('withholds the upload controls from a role that cannot manage devices', async () => {
    await show([device()], () => false)

    fireEvent.click(screen.getByText('Attached Document Links'))

    // Both sides asserted, so this cannot pass just because the copy changed: a read-only role
    // is told the state ("No 3D model attached") and is NOT offered the drop prompt. RLS refuses
    // the write regardless -- this is the affordance, not the gate.
    await waitFor(() => expect(screen.getByText('No 3D model attached')).toBeInTheDocument())
    expect(screen.queryByText(/Drop a 3D model here/i)).not.toBeInTheDocument()
  })

  it('offers the drop prompt to a role that can manage devices', async () => {
    await show([device()])

    fireEvent.click(screen.getByText('Attached Document Links'))

    await waitFor(() => expect(screen.getByText(/Drop a 3D model here/i)).toBeInTheDocument())
  })
})
