import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import { GATEWAY_TYPES, NEVER_FILLED_ROWS, gatewayShowsRow, gatewayType } from '../utils/gatewayType'
import { helpTipText } from '../test/tooltips'
import { api } from '../api'

/**
 * A gateway's drawer shows the rows its kind can fill and none it never can: a Host gateway has no
 * appliance, so no CA expiry, disk, memory, load, flow, platform or custom row. A row a kind could
 * fill but has not yet is shown and reads Not set. The rule is one table in utils/gatewayType.js,
 * keyed on the kind; these tests read the rows the drawer draws for each kind against it.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), enrolmentReadiness: vi.fn() }
  }
})

const NOW = new Date().toISOString()

/** What a Remote appliance reports, every figure present. */
const APPLIANCE = {
  agent_version: '1.5.0',
  forge_head_sha: 'abcdef0123456789abcdef0123456789abcdef01',
  forge_head_at: NOW,
  forge_appliance_sha: '0123456789abcdef0123456789abcdef01234567',
  forge_appliance_at: NOW,
  health_reported_at: NOW,
  cert_expires_at: '2031-01-01T00:00:00Z',
  disk_free_bytes: 50_000_000_000,
  mem_available_bytes: 2_000_000_000,
  load_1m: 0.42,
  uptime_seconds: 86_400,
  flow_hash: 'f'.repeat(64),
  forge_appliance_platform_tag: 'v1.2.0',
  forge_appliance_platform_outcome: 'converged',
  forge_appliance_converged_at: NOW,
  forge_appliance_custom_outcome: 'ok',
  forge_appliance_custom_revision: 'abcdef0123456789',
  enrolled_at: NOW,
  forge_repository_at: NOW,
}

/** What a host-run connector's heartbeat reports: its uptime, nothing of an appliance's. */
const HEARTBEAT = { health_reported_at: NOW, uptime_seconds: 3600 }

const gateway = (overrides = {}) => ({
  gateway_id: '5d000000-0000-4000-8000-000000000001',
  gateway_name: 'Flow_1',
  sparkplug_id: 'gwy5d0000000000400080000',
  sparkplug_group: 'Plant-A',
  status: 'ONLINE',
  deployment: 'host',
  is_simulated: false,
  is_shadow: false,
  is_archived: false,
  cell_id: 'cell-1',
  location_scope: 'cell',
  access_url: 'http://node-red.localhost',
  last_heartbeat: NOW,
  devices: [],
  description: 'A flow',
  ...overrides
})

const KINDS = {
  host: (extra) => gateway({ ...extra }),
  simulated: (extra) => gateway({ is_simulated: true, ...extra }),
  playback: (extra) => gateway({ is_simulated: true, is_shadow: true, ...extra }),
  thirdParty: (extra) => gateway({ deployment: 'third_party', ...extra }),
  remote: (extra) => gateway({ deployment: 'remote', ...extra }),
}

const routeGet = (rows) => (path) => {
  if (path.startsWith('/api/v1/cells')) return Promise.resolve([{ cell_id: 'cell-1', cell_name: 'Assembly', is_archived: false }])
  if (path.startsWith('/api/v1/gateways')) return Promise.resolve(rows)
  return Promise.resolve([])
}

const show = async (row, { userRole = 'Shopfloor_Manager' } = {}) => {
  api.get.mockImplementation(routeGet([row]))
  api.enrolmentReadiness.mockResolvedValue({ ready: true, addresses: [] })
  render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} userRole={userRole} />)
  await waitFor(() => expect(screen.getByText(row.gateway_name)).toBeTruthy())
  fireEvent.click(within(document.querySelector('.page-main')).getByText(row.gateway_name))
  return within(document.querySelector('.context-panel'))
}

/** The drawer's field labels, top to bottom. */
const rows = () => [...document.querySelectorAll('.context-panel dt.context-field-label')].map(dt => dt.textContent.trim())
/** The value shown under one field's label. */
const valueOf = (label) => {
  const dt = [...document.querySelectorAll('.context-panel dt.context-field-label')].find(d => d.textContent.trim() === label)
  return dt?.parentElement.querySelector('dd')?.textContent.trim()
}

beforeEach(() => {
  vi.clearAllMocks()
  globalThis.__ABER_CONFIG__ = { VITE_PRIMARY_HOST_ID: 'plant1' }
})
afterEach(() => { delete globalThis.__ABER_CONFIG__ })

const FIXED = ['Gateway UUID', 'Sparkplug Edge Node ID', 'Sparkplug Topic Path', 'Location', 'Last Heartbeat']

describe('a Host gateway\'s drawer', () => {
  it('hides the seven appliance rows it can never fill, and keeps the two its heartbeat fills', async () => {
    await show(KINDS.host(HEARTBEAT))

    expect(rows()).toEqual([...FIXED, 'Health Reported', 'Runtime Uptime', 'Description'])
    for (const label of ['CA Expires', 'Disk Free', 'Memory Available', 'Load (1m)', 'Flow', 'Platform', 'Custom']) {
      expect(rows(), label).not.toContain(label)
    }
    expect(valueOf('Runtime Uptime')).toBe('1h 0m')
  })

  it('hides them whatever the row holds: a row edited to Host keeps its appliance columns', async () => {
    await show(KINDS.host(APPLIANCE))

    expect(rows()).toEqual([...FIXED, 'Health Reported', 'Runtime Uptime', 'Description'])
  })

  it('shows no health row before it has reported any', async () => {
    await show(KINDS.host({}))

    expect(rows()).toEqual([...FIXED, 'Description'])
  })

  it('shows Launch UI and Archive Gateway after 8 rows, not 15', async () => {
    await show(KINDS.host(HEARTBEAT))

    expect(rows()).toHaveLength(8)
    expect(screen.getByRole('link', { name: /Launch UI/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Archive Gateway/ })).toBeTruthy()
  })

  it('keeps Show Broker Credential for an Administrator', async () => {
    await show(KINDS.host(HEARTBEAT), { userRole: 'Administrator' })

    expect(screen.getByRole('button', { name: /Show Broker Credential/ })).toBeTruthy()
  })

  it('says its repository in one line, and the reason in the label\'s help tip', async () => {
    await show(KINDS.host(HEARTBEAT))

    const label = [...document.querySelectorAll('.context-panel .context-field-label')].find(l => l.textContent.trim() === 'Repository')
    const field = label.closest('.context-field')
    expect(field.querySelector('.context-field-value').textContent).toBe('None: edit it in Node-RED')
    expect(helpTipText('What Repository means', field)).toMatch(/^A host-run gateway has no repository\./)
    expect(document.querySelector('.context-panel').textContent).not.toMatch(/which several host gateways can share/)
  })
})

describe('the other kinds\' drawers', () => {
  it('shows a Simulated gateway the Host\'s rows', async () => {
    await show(KINDS.simulated(HEARTBEAT))

    expect(rows()).toEqual([...FIXED, 'Health Reported', 'Runtime Uptime', 'Description'])
  })

  it('shows the Playback gateway no health row, since the daemon records none for it', async () => {
    await show(KINDS.playback({ ...HEARTBEAT, ...APPLIANCE }))

    expect(rows()).toEqual([...FIXED, 'Description'])
  })

  it('shows a Third-party gateway what it does not get, and no row it never fills', async () => {
    await show(KINDS.thirdParty({ ...APPLIANCE }))

    expect(rows()).toEqual([...FIXED, 'Not Provided', 'Description'])
  })

  it('shows a Remote gateway every row, and reads Not set where it has not reported', async () => {
    await show(KINDS.remote({
      ...APPLIANCE,
      cert_expires_at: null, disk_free_bytes: null, mem_available_bytes: null, load_1m: null,
      flow_hash: null, forge_appliance_platform_tag: null, forge_appliance_custom_outcome: null
    }))

    expect(rows()).toEqual([
      ...FIXED, 'Bundle', 'Committed', 'Reported',
      'Health Reported', 'CA Expires', 'Disk Free', 'Memory Available', 'Load (1m)', 'Runtime Uptime',
      'Flow', 'Platform', 'Custom', 'Description'
    ])
    for (const label of ['CA Expires', 'Disk Free', 'Memory Available', 'Load (1m)', 'Flow', 'Platform', 'Custom']) {
      expect(valueOf(label), label).toBe('Not set')
    }
  })

  it('leaves a Remote gateway\'s forge rows out until each has a value, as before', async () => {
    await show(KINDS.remote({ health_reported_at: NOW }))

    for (const label of ['Bundle', 'Committed', 'Reported']) expect(rows(), label).not.toContain(label)
    expect(rows()).toContain('CA Expires')
  })
})

describe('the rule, in one table', () => {
  it('names every row the Remote drawer draws, so a renamed row cannot slip out of it', async () => {
    await show(KINDS.remote(APPLIANCE))
    const drawn = new Set(rows())

    for (const [kind, labels] of Object.entries(NEVER_FILLED_ROWS)) {
      for (const label of labels) expect(drawn.has(label), `${kind}: ${label}`).toBe(true)
    }
  })

  it('hides no row from a Remote gateway, which runs on an appliance of its own', () => {
    expect(NEVER_FILLED_ROWS[GATEWAY_TYPES.REMOTE]).toEqual([])
  })

  it('is keyed on the gateway\'s kind, Playback first and Simulated before Host', () => {
    expect(gatewayShowsRow(KINDS.host({}), 'Disk Free')).toBe(false)
    expect(gatewayShowsRow(KINDS.simulated({}), 'Disk Free')).toBe(false)
    expect(gatewayShowsRow(KINDS.playback({}), 'Runtime Uptime')).toBe(false)
    expect(gatewayShowsRow(KINDS.host({}), 'Runtime Uptime')).toBe(true)
    expect(gatewayShowsRow(KINDS.remote({}), 'Disk Free')).toBe(true)
    expect(gatewayShowsRow(KINDS.host({}), 'Gateway UUID')).toBe(true)
    expect(gatewayType(KINDS.playback({}))).toBe(GATEWAY_TYPES.PLAYBACK)
  })

  it('never hides a row a kind fills in every drawer: the identifiers, the location, the heartbeat', () => {
    for (const labels of Object.values(NEVER_FILLED_ROWS)) {
      for (const label of [...FIXED, 'Description']) expect(labels).not.toContain(label)
    }
  })
})
