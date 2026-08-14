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

/**
 * Select a gateway row and return its context panel.
 *
 * The overflow menu is gone. Digital Thread and Documents moved into the drawer, which left a
 * three-dot menu holding one item -- a click to reveal a click -- so Archive was promoted into the
 * row beside Edit and the menu was removed. The documents accordion moved with them: it was
 * mounted once per row, collapsed, and is now mounted once for the selected gateway.
 *
 * The rules under test are unchanged. Only where they render has moved.
 */
const openPanel = (name = 'Virtual_Gateway_NodeRED') => {
  fireEvent.click(within(document.querySelector('.page-main')).getByText(name))
  return within(document.querySelector('.context-panel'))
}
const inRow = () => within(document.querySelector('.page-main'))

beforeEach(() => vi.clearAllMocks())

describe('gateway row actions', () => {
  it('leaves no action controls in the row at all', async () => {
    // The ACTIONS column is gone. The row is identity and state; every action lives in the
    // drawer the row opens.
    await show([gateway()])

    expect(inRow().queryByRole('link', { name: /Launch UI/i })).not.toBeInTheDocument()
    expect(inRow().queryByRole('button', { name: /^Edit/i })).not.toBeInTheDocument()
    expect(inRow().queryByRole('button', { name: /^Archive/i })).not.toBeInTheDocument()
    expect(inRow().queryByRole('button', { name: /^Thread/i })).not.toBeInTheDocument()
    expect(inRow().queryByRole('button', { name: /^Docs/i })).not.toBeInTheDocument()
    expect(screen.queryByTestId('gateway-actions-gw-1')).not.toBeInTheDocument()
  })

  it('keeps Launch UI prominent — it is the only action that leaves the dashboard', async () => {
    await show([gateway()])
    const launch = openPanel().getByRole('link', { name: /Launch UI/i })

    expect(launch.className).toMatch(/btn-primary/)
    expect(launch.getAttribute('href')).toBe('http://localhost:1880')
    expect(launch.getAttribute('rel')).toContain('noopener')
  })

  it('omits Launch UI for a gateway with no access URL', async () => {
    await show([gateway({ access_url: null })])

    const panel = openPanel()
    expect(panel.queryByRole('link', { name: /Launch UI/i })).not.toBeInTheDocument()
    // The panel still works: Edit and Archive are unaffected.
    expect(panel.getByText('Edit Details')).toBeInTheDocument()
    expect(panel.getByText(/Archive Gateway/i)).toBeInTheDocument()
  })

  it('collects the secondary actions in the panel', async () => {
    await show([gateway()])
    const panel = openPanel()

    expect(panel.getByText(/View Digital Thread/i)).toBeTruthy()
    expect(panel.getByText(/Manage Documents/i)).toBeTruthy()
    expect(panel.getByText(/Edit Details/i)).toBeTruthy()
  })

  it('promotes Restore into the row for an archived gateway', async () => {
    await show([gateway({ is_archived: true })])

    const panel = openPanel()
    expect(panel.getByText(/Restore Gateway/i)).toBeInTheDocument()
    expect(panel.queryByText('Edit Details')).not.toBeInTheDocument()
  })

  it('never offers Archive and Restore at once', async () => {
    await show([gateway({ is_archived: true })])

    const panel = openPanel()
    expect(panel.getByText(/Restore Gateway/i)).toBeInTheDocument()
    expect(panel.queryByText(/Archive Gateway/i)).not.toBeInTheDocument()
  })

  it('disables the write action for a role that cannot manage gateways', async () => {
    await show([gateway()], () => false)

    const panel = openPanel()
    expect(panel.getByText('Edit Details').closest('button').disabled).toBe(true)
    expect(panel.getByText(/Archive Gateway/i).closest('button').disabled).toBe(true)
    // Reads stay open, as on Devices.
    expect(panel.getByText(/View Digital Thread/i).closest('button').disabled).toBe(false)
  })

  it('reaches documents through the panel action, not an accordion', async () => {
    // The accordion is gone from both places. It was mounted once per row (a hundred collapsed
    // drawers on a hundred-gateway page), then once in the drawer -- where it was a cramped list
    // in a 360px column. Manage Documents opens the full editor instead.
    await show([gateway()])

    expect(inRow().queryByText('Attached Document Links')).toBeNull()

    const panel = openPanel()
    expect(panel.queryByText('Attached Document Links')).toBeNull()
    expect(panel.getByText('Manage Documents')).toBeInTheDocument()
  })
})

// Document link counts are still fetched once per page and grouped by entity id -- the request
// that used to feed the accordion badges. The badges themselves are gone with the accordion, but
// the fetch is what EntityDocumentsModal's "n attached" figure and any future badge rest on, and
// it must stay off the poll: ingestion stamps last_heartbeat ~every 30s per gateway, so folding it
// into load() would issue a documents query on the busiest subscription in the app.
describe('gateway document link counts', () => {
  const withDocs = (rows, docs) => (path) => {
    if (path.startsWith('/api/v1/documents')) return Promise.resolve(docs)
    if (path.startsWith('/api/v1/cells')) return Promise.resolve([{ cell_id: 'cell-1', cell_name: 'Assembly Line 1' }])
    if (path.startsWith('/api/v1/gateways')) return Promise.resolve(rows)
    if (path.startsWith('/api/v1/devices')) return Promise.resolve([])
    return Promise.resolve([])
  }

  it('asks for every gateway document once, not once per row', async () => {
    api.get.mockImplementation(withDocs([gateway()], []))
    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Virtual_Gateway_NodeRED')).toBeInTheDocument())
    const docCalls = api.get.mock.calls.filter(([p]) => p.startsWith('/api/v1/documents'))
    expect(docCalls).toHaveLength(1)
    expect(docCalls[0][0]).toBe('/api/v1/documents?entity_type=gateway')
  })

  it('renders the page even when the count cannot be fetched', async () => {
    api.get.mockImplementation((path) => {
      if (path.startsWith('/api/v1/documents')) return Promise.reject(new Error('boom'))
      return withDocs([gateway()], [])(path)
    })
    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Virtual_Gateway_NodeRED')).toBeInTheDocument())
  })
})
