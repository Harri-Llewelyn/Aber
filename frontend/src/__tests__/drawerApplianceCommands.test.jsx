import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import {
  CONVERGE_JOURNAL, FLOW_SYNC_LOG, RESET_BUNDLE_EDITOR_PASSWORD, RESET_EDITOR_PASSWORD
} from '../utils/applianceCommands'
import { applianceReportMissing } from '../utils/gatewayHealth'
import { FLOW_DRIFT_GRACE_MS } from '../utils/flowDrift'
import { api } from '../api'

/**
 * A Remote gateway's drawer shows the command to run on its appliance where its state is said: why the
 * platform failed, why nothing is reported, and how to reset a lost editor password. None of them moves
 * the actions: each is inside a group that is closed when the drawer opens, or after the actions.
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

/** An appliance that enrolled long ago, reports to its forge branch, and has nothing wrong with it. */
const gateway = (overrides = {}) => ({
  gateway_id: '5d000000-0000-4000-8000-000000001597',
  gateway_name: 'Paint Line',
  sparkplug_id: 'gwy5d0000000000400081597',
  sparkplug_group: 'Plant-A',
  status: 'ONLINE',
  deployment: 'remote',
  is_simulated: false,
  is_shadow: false,
  is_archived: false,
  cell_id: 'cell-1',
  location_scope: 'cell',
  access_url: 'http://paint-line:1880',
  last_heartbeat: NOW,
  devices: [],
  description: '',
  agent_version: '1.2.0',
  enrolled_at: LONG_AGO,
  credential_revoked_at: null,
  forge_repository_at: LONG_AGO,
  forge_head_sha: 'a'.repeat(40),
  forge_head_at: LONG_AGO,
  forge_head_flow_sha256: 'f'.repeat(64),
  forge_appliance_sha: 'b'.repeat(40),
  forge_appliance_at: NOW,
  health_reported_at: NOW,
  cert_expires_at: '2031-01-01T00:00:00Z',
  disk_free_bytes: 50_000_000_000,
  mem_available_bytes: 2_000_000_000,
  load_1m: 0.42,
  uptime_seconds: 86_400,
  flow_hash: 'f'.repeat(64),
  forge_appliance_platform_tag: 'v1.10.0',
  forge_appliance_platform_outcome: 'converged',
  forge_appliance_converged_at: NOW,
  ...overrides
})

const show = async (row, { userRole = 'Shopfloor_Manager' } = {}) => {
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
const blocks = () => [...panel().querySelectorAll('pre')]
/** The commands a reader sees before opening anything, and after. */
const shown = () => blocks().filter(b => !b.closest('[hidden]')).map(b => b.textContent)
const commandsIn = (root) => [...root.querySelectorAll('pre')].map(b => b.textContent)
const group = (name) => screen.queryByRole('button', { name })
const rowOf = (label) => [...panel().querySelectorAll('.context-field')].find(f => f.querySelector('dt')?.textContent.trim() === label)
/** Where a node is among the drawer's blocks: 'fields', 'facts', 'actions' or 'tools'. */
const placeOf = (node) => node.closest('.context-panel-extras') ? 'tools'
  : node.closest('.context-panel-actions') ? 'actions'
    : node.closest('.context-panel-facts') ? 'facts' : 'fields'

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/gateways')
})

describe('Health\'s Platform row', () => {
  it('offers the converge journal when the platform failed, under the row and inside the closed block', async () => {
    await show(gateway({ forge_appliance_platform_outcome: 'failed' }))

    expect(group(/^Health, Platform failed/)).toHaveAttribute('aria-expanded', 'false')
    expect(shown()).toEqual([])
    fireEvent.click(group(/^Health/))
    expect(shown()).toEqual([CONVERGE_JOURNAL])
    expect(rowOf('Platform').querySelector('dd').textContent).toContain('v1.10.0 · failed')
    expect(commandsIn(rowOf('Platform'))).toEqual([CONVERGE_JOURNAL])
    expect(within(rowOf('Platform')).getByRole('link', { name: 'Commands on the appliance' })).toBeInTheDocument()
  })

  it('offers it for a refused run too, whose tag is unknown', async () => {
    await show(gateway({ forge_appliance_platform_outcome: 'refused', forge_appliance_platform_tag: null }))

    fireEvent.click(group(/^Health, Platform refused/))
    expect(rowOf('Platform').querySelector('dd').textContent).toMatch(/^refused/)
    expect(commandsIn(rowOf('Platform'))).toEqual([CONVERGE_JOURNAL])
  })

  it('offers none while it converged', async () => {
    await show(gateway())

    expect(commandsIn(rowOf('Platform'))).toEqual([])
    expect(rowOf('Platform').querySelector('dd').textContent).toMatch(/^v1\.10\.0 · converged/)
  })
})

describe('Health\'s Flow row', () => {
  it('offers flow-sync\'s log when the flow differs from main', async () => {
    await show(gateway({ forge_head_flow_sha256: 'e'.repeat(64) }))

    fireEvent.click(group(/^Health, Flow differs from main/))
    expect(commandsIn(rowOf('Flow'))).toEqual([FLOW_SYNC_LOG])
  })

  it('offers none while it matches', async () => {
    await show(gateway())

    expect(commandsIn(rowOf('Flow'))).toEqual([])
  })
})

const MISSING = { forge_appliance_sha: null, forge_appliance_at: null, forge_appliance_platform_tag: null, forge_appliance_platform_outcome: null }

describe('an appliance that should have reported and never has', () => {
  it('is said in one closed line, which opens to flow-sync\'s log', async () => {
    await show(gateway(MISSING))

    const heading = group('Reported, No report from the appliance yet')
    expect(heading).toHaveAttribute('aria-expanded', 'false')
    expect(heading.closest('section').className).toBe('context-field-group')
    expect(placeOf(heading)).toBe('fields')
    expect(shown()).toEqual([])
    fireEvent.click(heading)
    expect(shown()).toEqual([FLOW_SYNC_LOG])
  })

  it('is said before the appliance has reported any health, which flow-sync does not send', async () => {
    await show(gateway({ ...MISSING, health_reported_at: null }))

    expect(group(/^Reported, No report/)).toBeInTheDocument()
  })

  it('is not said once it has reported: the Reported row is drawn instead', async () => {
    await show(gateway())

    expect(group(/^Reported/)).toBeNull()
    expect(rowOf('Reported')).toBeVisible()
  })

  it.each([
    ['one enrolled within two of flow-sync\'s passes', { enrolled_at: NOW }],
    ['one with no repository in the forge', { forge_repository_at: null }],
    ['one whose credential was revoked since', { credential_revoked_at: NOW }],
    ['an archived one', { is_archived: true }],
    ['one that never enrolled', { enrolled_at: null }],
    ['one that is a Host gateway now', { deployment: 'host' }],
  ])('is not said of %s', (_what, change) => {
    expect(applianceReportMissing(gateway(MISSING))).toBe(true)
    expect(applianceReportMissing(gateway({ ...MISSING, ...change }))).toBe(false)
  })

  it('waits two of flow-sync\'s passes after the enrolment', () => {
    const enrolled = new Date(LONG_AGO).getTime()
    expect(applianceReportMissing(gateway(MISSING), enrolled + FLOW_DRIFT_GRACE_MS - 1)).toBe(false)
    expect(applianceReportMissing(gateway(MISSING), enrolled + FLOW_DRIFT_GRACE_MS)).toBe(true)
  })

  it('is not offered for health figures the appliance has not sent: those come on the heartbeat', async () => {
    await show(gateway({
      cert_expires_at: null, disk_free_bytes: null, mem_available_bytes: null, load_1m: null, flow_hash: null,
      forge_appliance_platform_tag: null, forge_appliance_platform_outcome: null
    }))

    fireEvent.click(group(/^Health, No figures reported yet/))
    expect(shown()).toEqual([])
  })
})

describe('the editor password', () => {
  const heading = () => group('Editor Password, Reset it on the appliance')

  it('is a closed group after the actions, so it moves none of them', async () => {
    await show(gateway())

    expect(heading()).toHaveAttribute('aria-expanded', 'false')
    expect(placeOf(heading())).toBe('tools')
    expect(panel().querySelector('.context-panel-actions').textContent).not.toContain('Editor Password')
    expect(shown()).toEqual([])
  })

  it('opens to the reset and its restart, for each way an appliance is set up', async () => {
    await show(gateway())

    fireEvent.click(heading())
    expect(shown()).toEqual([RESET_EDITOR_PASSWORD, RESET_BUNDLE_EDITOR_PASSWORD])
    for (const text of shown()) expect(text).toMatch(/--reset-admin-password[\s\S]*restart node-red$/)
    for (const button of heading().closest('section').querySelectorAll('button.btn')) expect(button).toHaveClass('context-action')
  })

  it.each([
    ['an archived gateway, which keeps its console too', { is_archived: true }],
    ['a gateway whose credential was revoked', { credential_revoked_at: NOW }],
    ['a gateway with no console address', { access_url: '' }],
  ])('is shown for %s', async (_what, change) => {
    window.history.replaceState(null, '', '/gateways?lifecycle=active,archived')
    await show(gateway(change))

    expect(heading()).toBeInTheDocument()
  })

  it('is not shown for a gateway that never enrolled', async () => {
    await show(gateway({ ...MISSING, enrolled_at: null, forge_repository_at: null, health_reported_at: null, status: 'PENDING_ENROLLMENT' }))

    expect(heading()).toBeNull()
  })

  // Each keeps an appliance's columns, as a gateway changed from Remote does, with everything wrong.
  it.each([
    ['a Host gateway', { deployment: 'host' }],
    ['a Simulated gateway', { deployment: 'host', is_simulated: true }],
    ['the Playback gateway', { deployment: 'host', is_simulated: true, is_shadow: true }],
    ['a Third-party gateway', { deployment: 'third_party' }],
  ])('is not shown for %s, and nor is any other command', async (_what, kind) => {
    await show(gateway({ ...MISSING, forge_appliance_platform_outcome: 'failed', forge_head_flow_sha256: 'e'.repeat(64), ...kind }))

    expect(heading()).toBeNull()
    expect(blocks()).toEqual([])
  })

  it('opens closed for another gateway', async () => {
    const other = gateway({ gateway_id: '5d000000-0000-4000-8000-000000001598', gateway_name: 'Press Line' })
    api.get.mockImplementation((path) => Promise.resolve(path.startsWith('/api/v1/gateways') ? [gateway(), other] : []))
    api.enrolmentReadiness.mockResolvedValue({ ready: true, addresses: [] })
    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} userRole="Operator" />)
    const list = () => within(document.querySelector('.page-main'))
    await waitFor(() => expect(list().getByText('Press Line')).toBeInTheDocument())

    fireEvent.click(list().getByText('Paint Line'))
    fireEvent.click(heading())
    expect(heading()).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(list().getByText('Press Line'))
    expect(heading()).toHaveAttribute('aria-expanded', 'false')
  })
})
