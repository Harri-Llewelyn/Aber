import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import { api } from '../api'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const gateway = (overrides = {}) => ({
  gateway_id: 'gw-1',
  gateway_name: 'Virtual_Gateway_NodeRED',
  sparkplug_id: 'gwy100000000000400080000',
  cell_id: 'cell-1',
  status: 'ONLINE',
  ip_address: '192.168.1.50',
  is_virtual: true,
  is_archived: false,
  access_url: 'http://localhost:1880',
  last_heartbeat: new Date().toISOString(),
  device_count: 0,
  devices: [],
  ...overrides
})

const routeGet = (rows) => (path) => {
  if (path.startsWith('/api/v1/cells')) return Promise.resolve([{ cell_id: 'cell-1', cell_name: 'Assembly Line 1' }])
  if (path.startsWith('/api/v1/gateways')) return Promise.resolve(rows)
  if (path.startsWith('/api/v1/devices')) return Promise.resolve([])
  return Promise.resolve([])
}

const show = async (rows, hasPermission = () => true) => {
  api.get.mockImplementation(routeGet(rows))
  render(<GatewaysTab showToast={vi.fn()} hasPermission={hasPermission} initialSearchFilter="" onClearFilter={vi.fn()} />)
  await waitFor(() => expect(screen.getByText(rows[0].gateway_name)).toBeInTheDocument())
}

const openMenu = (id = 'gw-1') => fireEvent.click(screen.getByTestId(`gateway-actions-${id}`))
const menuLabels = () => within(screen.getByRole('menu')).getAllByRole('menuitem').map(i => i.textContent)

beforeEach(() => vi.clearAllMocks())

describe('gateway row actions', () => {
  it('keeps Launch UI and Edit in the row, and nothing else', async () => {
    await show([gateway()])

    expect(screen.getByRole('link', { name: /Launch UI/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Edit/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Thread/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Archive/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Docs/i })).not.toBeInTheDocument()
  })

  it('keeps Launch UI prominent — it is the only action that leaves the dashboard', async () => {
    await show([gateway()])
    const launch = screen.getByRole('link', { name: /Launch UI/i })

    expect(launch.className).toMatch(/btn-primary/)
    expect(launch.getAttribute('href')).toBe('http://localhost:1880')
    expect(launch.getAttribute('rel')).toContain('noopener')
  })

  it('omits Launch UI for a gateway with no access URL', async () => {
    await show([gateway({ access_url: null })])

    expect(screen.queryByRole('link', { name: /Launch UI/i })).not.toBeInTheDocument()
    // The row still works: Edit and the menu are unaffected.
    expect(screen.getByRole('button', { name: /^Edit/i })).toBeInTheDocument()
    expect(screen.getByTestId('gateway-actions-gw-1')).toBeInTheDocument()
  })

  it('collects the secondary actions in the menu', async () => {
    await show([gateway()])
    openMenu()

    const labels = menuLabels().join('|')
    expect(labels).toMatch(/documents/i)
    expect(labels).toMatch(/Digital Thread/i)
    expect(labels).toMatch(/Archive gateway/i)
  })

  it('promotes Restore into the row for an archived gateway', async () => {
    await show([gateway({ is_archived: true })])

    expect(screen.getByRole('button', { name: /Restore/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Edit/i })).not.toBeInTheDocument()
  })

  it('never offers Archive and Restore at once', async () => {
    await show([gateway({ is_archived: true })])
    openMenu()

    expect(menuLabels().join('|')).not.toMatch(/Archive gateway/i)
  })

  it('disables the write action for a role that cannot manage gateways', async () => {
    await show([gateway()], () => false)

    expect(screen.getByRole('button', { name: /^Edit/i }).disabled).toBe(true)

    openMenu()
    const menu = within(screen.getByRole('menu'))
    expect(menu.getByRole('menuitem', { name: /Archive gateway/i }).disabled).toBe(true)
    // Reads stay open, as on Devices.
    expect(menu.getByRole('menuitem', { name: /Digital Thread/i }).disabled).toBe(false)
  })

  it('toggles the documents accordion from the menu', async () => {
    await show([gateway()])

    openMenu()
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /Show documents/i }))

    openMenu()
    expect(menuLabels().join('|')).toMatch(/Hide documents/i)
  })
})
