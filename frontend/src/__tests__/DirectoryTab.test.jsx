import React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DirectoryTab } from '../components/tabs/DirectoryTab'
import { PERMISSION_UUIDS } from '../constants'
import { api } from '../api'

vi.mock('../api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn()
  }
}))

const SERVICES = [
  {
    service_uuid: 'svc-1',
    service_name: 'Kong Gateway',
    service_type: 'HTTP',
    endpoint_url: 'http://localhost:54321',
    status: 'ONLINE',
    last_heartbeat: '2026-07-25T10:00:00Z'
  },
  {
    service_uuid: 'svc-2',
    service_name: 'Sparkplug Ingestion Daemon',
    service_type: 'MQTT',
    endpoint_url: 'mqtt://localhost:1883',
    status: 'ONLINE',
    last_heartbeat: '2026-07-25T10:00:00Z'
  }
]

async function renderTab(hasPermission) {
  const showToast = vi.fn()
  render(<DirectoryTab showToast={showToast} hasPermission={hasPermission} />)
  await waitFor(() => {
    expect(screen.getByRole('button', { name: /Sync Edge Flows via GitOps/i })).toBeInTheDocument()
  })
  return { showToast }
}

describe('DirectoryTab GitOps sync guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.get.mockResolvedValue(SERVICES)
  })

  // The card used to render a hardcoded SYNCED / a8f3e4b status. Nothing in the
  // stack can observe what Node-RED is running, so any such claim is fabricated.
  it('claims no deployment status', async () => {
    await renderTab(vi.fn().mockReturnValue(true))

    expect(screen.queryByText(/SYNCED/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/a8f3e4b/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Commit:/i)).not.toBeInTheDocument()
    expect(api.get).not.toHaveBeenCalledWith(expect.stringContaining('/gitops/status'))
  })

  // The Edge Function enforces Administrator/Shopfloor_Manager server-side, and
  // gitops:manage is seeded to exactly those two roles. Gating on gateway:manage
  // would hand edge-flow deployment to anyone who can register a gateway.
  it('gates the sync button on gitops:manage, not gateway:manage', async () => {
    const hasPermission = vi.fn((uuid) => uuid === PERMISSION_UUIDS.GATEWAY_MANAGE)
    await renderTab(hasPermission)

    expect(screen.getByRole('button', { name: /Sync Edge Flows via GitOps/i })).toBeDisabled()
    expect(hasPermission).toHaveBeenCalledWith(PERMISSION_UUIDS.GITOPS_MANAGE)
  })

  it('enables the sync button for a holder of gitops:manage', async () => {
    const hasPermission = vi.fn((uuid) => uuid === PERMISSION_UUIDS.GITOPS_MANAGE)
    await renderTab(hasPermission)

    expect(screen.getByRole('button', { name: /Sync Edge Flows via GitOps/i })).not.toBeDisabled()
  })

  // The deployment is a full replace of every running flow, so a single stray
  // click must not reach the Edge Function.
  it('does not deploy until the confirmation is accepted', async () => {
    const hasPermission = vi.fn().mockReturnValue(true)
    await renderTab(hasPermission)

    fireEvent.click(screen.getByRole('button', { name: /Sync Edge Flows via GitOps/i }))

    expect(await screen.findByText(/permanently lost/i)).toBeInTheDocument()
    expect(api.post).not.toHaveBeenCalled()
  })

  it('cancelling the confirmation deploys nothing', async () => {
    const hasPermission = vi.fn().mockReturnValue(true)
    await renderTab(hasPermission)

    fireEvent.click(screen.getByRole('button', { name: /Sync Edge Flows via GitOps/i }))
    fireEvent.click(await screen.findByRole('button', { name: /^Cancel$/i }))

    await waitFor(() => {
      expect(screen.queryByText(/permanently lost/i)).not.toBeInTheDocument()
    })
    expect(api.post).not.toHaveBeenCalled()
  })

  it('deploys only after the confirmation is accepted', async () => {
    const hasPermission = vi.fn().mockReturnValue(true)
    api.post.mockResolvedValue({ status: 'DEPLOYED', message: 'Deployed 26 Node-RED nodes' })
    const { showToast } = await renderTab(hasPermission)

    fireEvent.click(screen.getByRole('button', { name: /Sync Edge Flows via GitOps/i }))
    fireEvent.click(await screen.findByRole('button', { name: /^Confirm$/i }))

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith(
        '/api/v1/gitops/deploy-flow',
        expect.objectContaining({ commit_message: expect.any(String) })
      )
    })
    expect(showToast).toHaveBeenCalledWith(expect.any(String), 'success')
  })
})

/**
 * The page's own controls, in the `.filter-bar` every other list page uses.
 *
 * Refresh moved in from a `.page-actions` row that sat ABOVE the GitOps deployment panel, where
 * it read as an action on the deployment rather than on the table it actually reloads. Search
 * and the type picker are new: a stack with an ingestion daemon, a broker, Node-RED, Kong,
 * PostgREST and a handful of Edge Functions is past the point where scanning beats filtering.
 */
describe('DirectoryTab filter bar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.get.mockResolvedValue(SERVICES)
  })

  const search = () => screen.getByPlaceholderText(/Search services/)
  const typePicker = () => screen.getByTitle(/Show only one kind of service/)

  it('holds the search, the type picker and Refresh in one bar', async () => {
    await renderTab(vi.fn().mockReturnValue(true))

    const bar = document.querySelector('.filter-bar')
    expect(bar).toBeTruthy()
    expect(bar.contains(search())).toBe(true)
    expect(bar.contains(typePicker())).toBe(true)
    expect(bar.contains(screen.getByTitle(/Refresh service directory heartbeats/))).toBe(true)
    // And no row of its own left behind.
    expect(document.querySelector('.page-actions')).toBeNull()
  })

  it('filters on name', async () => {
    await renderTab(vi.fn().mockReturnValue(true))
    fireEvent.change(search(), { target: { value: 'ingestion' } })

    expect(screen.getByText('Sparkplug Ingestion Daemon')).toBeInTheDocument()
    expect(screen.queryByText('Kong Gateway')).not.toBeInTheDocument()
  })

  // An endpoint is often what an engineer has to hand -- a port from a compose file, a URL from
  // a log line -- rather than the service's registered name.
  it('filters on the endpoint URL too', async () => {
    await renderTab(vi.fn().mockReturnValue(true))
    fireEvent.change(search(), { target: { value: '1883' } })

    expect(screen.getByText('Sparkplug Ingestion Daemon')).toBeInTheDocument()
    expect(screen.queryByText('Kong Gateway')).not.toBeInTheDocument()
  })

  it('filters by service type', async () => {
    await renderTab(vi.fn().mockReturnValue(true))
    fireEvent.change(typePicker(), { target: { value: 'MQTT' } })

    expect(screen.getByText('Sparkplug Ingestion Daemon')).toBeInTheDocument()
    expect(screen.queryByText('Kong Gateway')).not.toBeInTheDocument()
  })

  // Derived from the rows, not hardcoded: the directory is a registry anything can register
  // into, so a fixed <option> list would silently hide a service type nobody anticipated.
  it('offers the service types actually present, not a fixed list', async () => {
    await renderTab(vi.fn().mockReturnValue(true))

    const options = [...typePicker().options].map(o => o.value)
    expect(options).toEqual(['', 'HTTP', 'MQTT'])
  })

  // A heading that says 2 above a table showing 1 is worse than no count at all, because it is
  // the number that gets quoted.
  it('counts what is on screen, not what was fetched', async () => {
    await renderTab(vi.fn().mockReturnValue(true))
    expect(screen.getByRole('heading', { name: /Active Stack Microservices/ }).textContent).toContain('2')

    fireEvent.change(typePicker(), { target: { value: 'MQTT' } })
    expect(screen.getByRole('heading', { name: /Active Stack Microservices/ }).textContent).toContain('1')
  })

  it('says so when a filter matches nothing', async () => {
    await renderTab(vi.fn().mockReturnValue(true))
    fireEvent.change(search(), { target: { value: 'nothing-registered-under-this' } })

    expect(screen.getByText(/No services match the filter/)).toBeInTheDocument()
  })
})
