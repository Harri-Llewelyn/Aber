import React from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { AccessControlTab } from '../components/tabs/AccessControlTab'
import { CaptureTab } from '../components/tabs/CaptureTab'
import { api } from '../api'

/**
 * A Third-party gateway reads Third-party on Access Control and Capture, from the same helper as
 * the Gateways page, and Access Control offers it a credential with the settings its node needs.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: {
      get: vi.fn(),
      listGatewayCredentials: vi.fn(),
      listBrokerInventory: vi.fn(),
      listServicePrincipals: vi.fn(),
      listServiceTokens: vi.fn(),
      listRevokedServiceTokens: vi.fn(),
      listRevokedServicePrincipals: vi.fn(),
      listCaptures: vi.fn(),
      activeCaptureJob: vi.fn(),
      recentCaptureJobs: vi.fn(),
      playbackTargets: vi.fn(),
      activePlaybackJob: vi.fn(),
      recentPlaybackJobs: vi.fn(),
      playbackWorkerStatus: vi.fn(),
      playbackStaleCredentials: vi.fn(),
    }
  }
})
vi.mock('../hooks/useRealtimeTable', () => ({ useRealtimeTable: vi.fn() }))

// The dialog's own behaviour has its suite; here, what the page hands it.
const opened = vi.hoisted(() => ({ gateway: null }))
vi.mock('../components/modals/GatewayCredentialModal', () => ({
  GatewayCredentialModal: ({ gateway }) => { opened.gateway = gateway; return <div data-testid="credential-modal" /> }
}))

const THIRD_PARTY = {
  id: '4c000000-0000-4000-8000-000000000001',
  name: 'Vendor_Node',
  sparkplug_id: 'gwy4c0000000000400080000',
  sparkplug_group: 'Plant-A',
  deployment: 'third_party', is_shadow: false, is_simulated: false, is_archived: false, status: 'ONLINE',
  enrolled_at: null, credential_revoked_at: null, issued_at: null
}

beforeEach(() => {
  vi.clearAllMocks()
  opened.gateway = null
  api.listBrokerInventory.mockResolvedValue({ clients: [], roles: [], read_at: '2026-10-20T00:00:00Z' })
  api.listServicePrincipals.mockResolvedValue([])
  api.listServiceTokens.mockResolvedValue(new Map())
  api.listRevokedServiceTokens.mockResolvedValue(new Set())
  api.listRevokedServicePrincipals.mockResolvedValue(new Map())
  api.get.mockImplementation(path => Promise.resolve(path.includes('gateways') ? [THIRD_PARTY] : []))
  api.listCaptures.mockResolvedValue([])
  api.activeCaptureJob.mockResolvedValue(null)
  api.recentCaptureJobs.mockResolvedValue([])
  api.activePlaybackJob.mockResolvedValue(null)
  api.recentPlaybackJobs.mockResolvedValue([])
  api.playbackTargets.mockResolvedValue([])
  api.playbackWorkerStatus.mockResolvedValue(null)
  api.playbackStaleCredentials.mockResolvedValue([])
})

describe('Access Control', () => {
  it('reads Third-party, and offers Generate with the settings its node needs', async () => {
    api.listGatewayCredentials.mockResolvedValue([THIRD_PARTY])
    render(<AccessControlTab showToast={vi.fn()} />)

    const row = (await screen.findByText('Vendor_Node')).closest('tr')
    expect(within(row).getByText('Third-party')).toBeTruthy()
    expect(within(row).queryByRole('button', { name: /Bundle/ })).toBeNull()
    fireEvent.click(within(row).getByRole('button', { name: /Generate/ }))

    await waitFor(() => expect(screen.getByTestId('credential-modal')).toBeTruthy())
    expect(opened.gateway).toMatchObject({
      gateway_id: THIRD_PARTY.id, sparkplug_id: THIRD_PARTY.sparkplug_id,
      deployment: 'third_party', sparkplug_group: 'Plant-A'
    })
  })
})

describe('Capture', () => {
  it('reads Third-party in the Type column', async () => {
    render(<CaptureTab showToast={vi.fn()} userRole="Administrator" />)
    const row = (await screen.findByText('Vendor_Node')).closest('tr')
    expect(within(row).getByText('Third-party')).toBeTruthy()
  })
})
