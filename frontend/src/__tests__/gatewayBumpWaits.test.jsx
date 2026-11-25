import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import { FORGE_ORGANISATION, GITEA_URL } from '../constants'
import { api } from '../api'

/**
 * The drawer's Platform row says which release waits for approval while Aber's pull request for it is
 * open: a link to the pull request for the two roles the forge admits, and the same words for the rest.
 * It is no warning, and changes neither the row's tone nor the Health block's summary.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), enrolmentReadiness: vi.fn() }
  }
})

const NOW = new Date().toISOString()
const LONG_AGO = '2026-01-01T00:00:00Z'
const SPARKPLUG_ID = 'gwy5d0000000000400081599'

/** An appliance on an older release than the site, with nothing wrong, whose bump waits. */
const gateway = (overrides = {}) => ({
  gateway_id: '5d000000-0000-4000-8000-000000001599',
  gateway_name: 'Paint Line',
  sparkplug_id: SPARKPLUG_ID,
  sparkplug_group: 'Plant-A',
  status: 'ONLINE',
  deployment: 'remote',
  is_simulated: false,
  is_shadow: false,
  is_archived: false,
  cell_id: 'cell-1',
  location_scope: 'cell',
  last_heartbeat: NOW,
  devices: [],
  description: '',
  enrolled_at: LONG_AGO,
  forge_repository_at: LONG_AGO,
  forge_head_sha: 'a'.repeat(40),
  forge_head_at: LONG_AGO,
  forge_head_flow_sha256: 'f'.repeat(64),
  forge_appliance_sha: 'b'.repeat(40),
  forge_appliance_at: NOW,
  health_reported_at: NOW,
  cert_expires_at: '2031-01-01T00:00:00Z',
  disk_free_bytes: 50_000_000_000,
  flow_hash: 'f'.repeat(64),
  forge_appliance_platform_tag: 'v1.9.0',
  forge_appliance_platform_outcome: 'converged',
  forge_appliance_converged_at: NOW,
  forge_bump_tag: 'v1.10.0',
  forge_bump_number: 3,
  ...overrides
})

const show = async (row, userRole = 'Administrator') => {
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/cells')) return Promise.resolve([{ cell_id: 'cell-1', cell_name: 'Assembly', is_archived: false }])
    if (path.startsWith('/api/v1/gateways')) return Promise.resolve([row])
    return Promise.resolve([])
  })
  api.enrolmentReadiness.mockResolvedValue({ ready: true, addresses: [] })
  render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} userRole={userRole} />)
  const list = () => within(document.querySelector('.page-main'))
  await waitFor(() => expect(list().getByText(row.gateway_name)).toBeInTheDocument())
  fireEvent.click(list().getByText(row.gateway_name))
}

const panel = () => document.querySelector('.context-panel')
const rowOf = (label) => [...panel().querySelectorAll('.context-field')].find(f => f.querySelector('dt')?.textContent.trim() === label)
const platform = () => rowOf('Platform').querySelector('dd')

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/gateways')
})

describe('the Platform row, while a bump waits', () => {
  it.each(['Administrator', 'Shopfloor_Manager'])('links %s to the pull request, after what the row says', async (role) => {
    await show(gateway(), role)

    expect(platform().textContent).toMatch(/^v1\.9\.0 · converged .+ · v1\.10\.0 waits for approval/)
    const link = within(platform()).getByRole('link', { name: /^v1\.10\.0 waits for approval/, hidden: true })
    expect(link).toHaveAttribute('href', `${GITEA_URL}/${FORGE_ORGANISATION}/gateway-${SPARKPLUG_ID}/pulls/3`)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it.each(['Operator', 'Auditor'])('says it to %s in words, whom the forge does not admit', async (role) => {
    await show(gateway(), role)

    expect(platform().textContent).toMatch(/ · v1\.10\.0 waits for approval$/)
    expect(platform().querySelector('a')).toBeNull()
  })

  it('is no warning, and leaves the row and the block as they were', async () => {
    await show(gateway())

    expect(platform().className).toBe('context-field-value')
    expect(screen.getByRole('button', { name: /^Health, Nothing needs attention/ })).toBeInTheDocument()
    expect(panel().querySelector('.context-warnings')).toBeNull()
  })

  it('stands beside a failed convergence without taking its tone', async () => {
    await show(gateway({ forge_appliance_platform_outcome: 'failed' }))

    expect(platform()).toHaveClass('context-field-danger')
    expect(platform().textContent).toMatch(/^v1\.9\.0 · failed · v1\.10\.0 waits for approval/)
    expect(platform().querySelector('.waiting-bump-link')).not.toBeNull()
    expect(screen.getByRole('button', { name: /^Health, Platform failed/ })).toBeInTheDocument()
    // The command for the failure is still under the value.
    expect(platform().querySelector('pre')).not.toBeNull()
  })

  it('is all the row says of an appliance that has reported no convergence', async () => {
    await show(gateway({ forge_appliance_platform_tag: null, forge_appliance_platform_outcome: null, forge_appliance_converged_at: null }))

    expect(platform().textContent.trim()).toBe('v1.10.0 waits for approval')
  })
})

describe('the Platform row, while none waits', () => {
  it.each([
    ['none is recorded', { forge_bump_tag: null, forge_bump_number: null }],
    ['the row predates the columns', { forge_bump_tag: undefined, forge_bump_number: undefined }],
    ['only half is recorded', { forge_bump_number: null }],
  ])('says the last convergence alone where %s', async (_, overrides) => {
    await show(gateway(overrides))

    expect(platform().textContent).toMatch(/^v1\.9\.0 · converged /)
    expect(platform().textContent).not.toContain('waits')
    expect(platform().querySelector('a')).toBeNull()
  })

  it('is empty for an appliance that runs the bundle alone', async () => {
    await show(gateway({
      forge_bump_tag: null, forge_bump_number: null, forge_appliance_platform_tag: null,
      forge_appliance_platform_outcome: null, forge_appliance_converged_at: null
    }))

    expect(platform().textContent).toBe('Not set')
  })
})
