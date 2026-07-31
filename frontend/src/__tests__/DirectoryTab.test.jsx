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
