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
  it('keeps only the two primary actions in the row itself', async () => {
    // The cell used to carry seven controls and take over half the row's width.
    await show([device()])

    expect(screen.getByRole('button', { name: /Telemetry/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Edit/i })).toBeInTheDocument()
    // Everything else moved behind the overflow menu.
    expect(screen.queryByRole('button', { name: /^Config/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Thread/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Archive/i })).not.toBeInTheDocument()
  })

  it('collects the secondary actions in the menu', async () => {
    await show([device()])
    openMenu()

    const labels = menuLabels().join('|')
    for (const expected of [/documents/i, /Digital Thread/i, /Configuration & 3D model/i,
      /Export AAS JSON/i, /Export AASX package/i, /Archive device/i]) {
      expect(labels).toMatch(expected)
    }
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
    expect(menu.getByRole('menuitem', { name: /Configuration & 3D model/i }).disabled).toBe(true)
    expect(menu.getByRole('menuitem', { name: /Archive device/i }).disabled).toBe(true)
    // Reads are not gated: an export is a read, and so is the audit trace.
    expect(menu.getByRole('menuitem', { name: /Digital Thread/i }).disabled).toBe(false)
    expect(menu.getByRole('menuitem', { name: /Export AAS JSON/i }).disabled).toBe(false)
  })

  it('toggles the documents accordion from the menu, and says which way it will go', async () => {
    await show([device()])

    openMenu()
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /Show documents/i }))

    openMenu()
    expect(menuLabels().join('|')).toMatch(/Hide documents/i)
  })
})
