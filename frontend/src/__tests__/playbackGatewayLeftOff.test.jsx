import React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import { api } from '../api'
import { currentUrl } from '../hooks/useUrlState'
import { gatewayUrl } from '../routes'
import { openFiltersPanel, pick, valuesShown } from '../test/listFilters'
import { PLAYBACK_GATEWAY_TIP, playbackProblem } from '../utils/playbackGateway'

/**
 * The Playback gateway is left off the Gateways page until its check is on, in the Filters panel as
 * Devices' Show replay lanes is. What is pinned: the check and the address; that its row is found by the
 * flag and never by its name; that a link to it shows it and opens its drawer; that a search which finds
 * it alone says it is hidden; that no count changes; and that something wrong with it shows it, which the
 * check says.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const PLAYBACK_ID = '60000000-0000-4000-8000-000000000001'
const PLAYBACK_NODE = 'gwy160000000000400080000'

const gateway = (overrides = {}) => ({
  gateway_id: 'gw-1', gateway_name: 'Host_Gateway_NodeRED', sparkplug_id: 'gwy100000000000400080000', sparkplug_group: 'Plant-A',
  cell_id: null, location_scope: 'cell', status: 'ONLINE', deployment: 'host', is_simulated: false, is_shadow: false,
  is_archived: false, access_url: null, last_heartbeat: new Date().toISOString(), device_count: 0, devices: [],
  ...overrides,
})
const playback = (overrides = {}) => gateway({
  gateway_id: PLAYBACK_ID, gateway_name: 'Playback', sparkplug_id: PLAYBACK_NODE,
  is_simulated: true, is_shadow: true, status: 'OFFLINE', last_heartbeat: null, ...overrides,
})
const retired = () => gateway({ gateway_id: 'gw-old', gateway_name: 'Retired_Gateway', is_archived: true })

const open = async (rows, { devices = [], activeAlerts = [], address = '/gateways' } = {}) => {
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/gateways')) return Promise.resolve(rows)
    if (path.startsWith('/api/v1/devices')) return Promise.resolve(devices)
    return Promise.resolve([])
  })
  window.history.replaceState(null, '', address)
  render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} userRole="Shopfloor_Manager" activeAlerts={activeAlerts} />)
  await waitFor(() => expect(screen.queryByText(/Loading gateways/)).toBeNull())
}

const bar = () => document.querySelector('.filter-bar')
/** The check in the Filters panel, opening the panel, or null where it is not offered. */
const check = () => within(openFiltersPanel()).queryByRole('checkbox', { name: /^Show Playback gateway/ })
/** The check as it reads, its count after its words. */
const reads = () => check().closest('label').textContent
/** What its tip says. */
const tip = async () => {
  fireEvent.focus(within(openFiltersPanel()).getByRole('button', { name: 'About show playback gateway' }))
  return (await screen.findByRole('tooltip')).textContent
}
const listed = () => [...document.querySelectorAll('tbody tr td strong')].map(el => el.textContent)
const drawerOpen = () => document.querySelector('.context-panel')?.getAttribute('aria-hidden') === 'false'
const search = (text) => fireEvent.change(screen.getByLabelText(/Search gateways/), { target: { value: text } })

beforeEach(() => vi.clearAllMocks())

describe('the check', () => {
  it('leaves it off by default, and is no filter that was changed', async () => {
    await open([gateway(), playback()])

    expect(listed()).toEqual(['Host_Gateway_NodeRED'])
    expect(reads()).toBe('Show Playback gateway 1')
    expect(check()).not.toBeChecked()
    expect(await tip()).toBe(PLAYBACK_GATEWAY_TIP)
    expect(within(bar()).getByRole('button', { name: 'Filters' })).toBeInTheDocument()
    expect(screen.queryByText(/Clear filters/)).toBeNull()
    expect(currentUrl()).toBe('/gateways')
  })

  it('shows it, is counted, and the address keeps it', async () => {
    await open([gateway(), playback()])
    fireEvent.click(check())

    expect(listed()).toEqual(['Host_Gateway_NodeRED', 'Playback'])
    expect(check()).toBeChecked()
    expect(within(bar()).getByRole('button', { name: 'Filters (1)' })).toBeInTheDocument()
    expect(currentUrl()).toBe('/gateways?playback=1')

    fireEvent.click(screen.getByRole('button', { name: /Clear filters \(1\)/ }))
    expect(listed()).toEqual(['Host_Gateway_NodeRED'])
    expect(currentUrl()).toBe('/gateways')
  })

  it('opens on from a link that keeps it', async () => {
    await open([gateway(), playback()], { address: '/gateways?playback=1' })

    expect(listed()).toEqual(['Host_Gateway_NodeRED', 'Playback'])
    expect(check()).toBeChecked()
  })

  it('goes by the flag, and never by the name', async () => {
    await open([gateway({ gateway_name: 'Playback' }), playback({ gateway_name: 'Recordings' })])
    expect(listed()).toEqual(['Playback'])
  })

  it('is not offered where there is none', async () => {
    await open([gateway()])
    expect(check()).toBeNull()
  })

  it('is there on an install with no gateway of its own, which says none yet', async () => {
    await open([playback()])
    expect(screen.getByText('No gateways yet.')).toBeInTheDocument()
    expect(screen.queryByText(/it is hidden/)).toBeNull()

    fireEvent.click(check())
    expect(listed()).toEqual(['Playback'])
    expect(screen.getByText('No gateways yet besides the Playback gateway.')).toBeInTheDocument()
  })

  it('drops that line once a gateway of its own exists', async () => {
    await open([gateway(), playback()], { address: '/gateways?playback=1' })
    expect(screen.queryByText(/No gateways yet/)).toBeNull()
  })
})

describe('the counts', () => {
  it('are of every gateway, as they were', async () => {
    await open([gateway(), playback(), retired()])

    expect(listed()).toEqual(['Host_Gateway_NodeRED'])
    expect(valuesShown('Lifecycle')).toEqual(['Active 2', 'Archived 1'])
    expect(valuesShown('Type')).toEqual(['Remote 0', 'Third-party 0', 'Host 1', 'Simulated 0', 'Playback 1'])
    expect(within(bar()).getByRole('button', { name: 'Has quarantined devices (0)' })).toBeInTheDocument()
  })

  it('show every row once the check is on', async () => {
    await open([gateway(), playback(), retired()], { address: '/gateways?playback=1' })

    expect(listed()).toHaveLength(2)
    pick('Lifecycle', 'active', 'archived')
    expect(listed()).toHaveLength(3)
  })
})

describe('the Type and Status filters', () => {
  it('list it when Type names it, and the check says that it is showing', async () => {
    await open([gateway(), playback()])
    pick('Type', 'playback')

    expect(listed()).toEqual(['Playback'])
    expect(check()).not.toBeChecked()
    expect(reads()).toBe('Show Playback gateway 1 showing')
    expect(await tip()).toBe('Shown because the Type filter names it.')
  })

  it.each([
    ['Type', 'simulated'],
    ['Status', 'OFFLINE'],
  ])('do not list it under %s %s, even when shown', async (filter, value) => {
    await open([gateway(), playback()], { address: '/gateways?playback=1' })
    pick(filter, value)
    expect(listed()).not.toContain('Playback')
    expect(screen.getByText('No gateways match these filters.')).toBeInTheDocument()
  })
})

describe('a link to it', () => {
  it.each([
    ['its UUID', gatewayUrl(PLAYBACK_ID)],
    ['its Sparkplug id', gatewayUrl(PLAYBACK_NODE)],
    ['its open drawer', `/gateways?gateway=${PLAYBACK_ID}`],
  ])('by %s shows it and opens its drawer', async (_by, address) => {
    await open([gateway(), playback()], { address })

    await waitFor(() => expect(drawerOpen()).toBe(true))
    await waitFor(() => expect(listed()).toContain('Playback'))
    expect(check()).toBeChecked()
    expect(currentUrl()).toContain('playback=1')
  })

  it('leaves the check free to leave it off again', async () => {
    await open([gateway(), playback()], { address: `/gateways?gateway=${PLAYBACK_ID}` })
    await waitFor(() => expect(listed()).toContain('Playback'))

    fireEvent.click(check())
    expect(listed()).toEqual(['Host_Gateway_NodeRED'])
    expect(check()).not.toBeChecked()
  })

  it('to another gateway leaves it off', async () => {
    await open([gateway(), playback()], { address: gatewayUrl('gw-1') })

    await waitFor(() => expect(drawerOpen()).toBe(true))
    expect(check()).not.toBeChecked()
  })
})

describe('a search', () => {
  it('that finds it alone says it is hidden, with a button to show it', async () => {
    await open([gateway(), playback()])
    search('playb')

    expect(screen.getByText('Only the Playback gateway matches, and it is hidden.')).toBeInTheDocument()
    expect(screen.queryByText('No gateways match these filters.')).toBeNull()

    fireEvent.click(within(document.querySelector('.empty-state')).getByRole('button', { name: 'Show Playback gateway' }))
    expect(listed()).toEqual(['Playback'])
    expect(currentUrl()).toBe('/gateways?search=playb&playback=1')
  })

  it('says so on an install with no gateway of its own too', async () => {
    await open([playback()])
    search('playb')
    expect(screen.getByText('Only the Playback gateway matches, and it is hidden.')).toBeInTheDocument()
  })

  it('that finds nothing says that nothing matches', async () => {
    await open([gateway(), playback()])
    search('press line')

    expect(screen.getByText('No gateways match these filters.')).toBeInTheDocument()
    expect(document.querySelector('.empty-state button')).toBeNull()
  })

  it('that finds others too lists the others', async () => {
    await open([gateway({ gateway_name: 'Playground' }), playback()])
    search('play')
    expect(listed()).toEqual(['Playground'])
  })
})

describe('something wrong with it', () => {
  const onGateway = (overrides = {}) => ({
    id: 'a-1', fingerprint: 'f-1', alert_name: 'Gateway Clock Skew', severity: 'warning',
    entity_type: 'gateway', sparkplug_id: PLAYBACK_NODE, entity_id: null, ...overrides,
  })
  const job = (kind, overrides = {}) => ({
    id: 'a-2', fingerprint: 'f-2', alert_name: 'Capture or Playback Failed', severity: 'warning', entity_type: 'platform',
    rule_uid: 'aber-job-failed', labels: { job: `${kind} job 8b1f1a52-5ed9-4f35-9a3c-000000000001` }, ...overrides,
  })
  const held = { asset_id: 'd-1', asset_name: 'Lathe 1', is_quarantined: true, active_gateway_id: PLAYBACK_ID }

  it.each([
    ['an alert on it', { activeAlerts: [onGateway()] }, 'an alert is firing: Gateway Clock Skew'],
    ['an alert on it by its row', { activeAlerts: [onGateway({ sparkplug_id: null, entity_id: PLAYBACK_ID })] }, 'an alert is firing: Gateway Clock Skew'],
    ['an acknowledged alert on it', { activeAlerts: [onGateway({ acknowledged_at: '2026-11-25T10:00:00Z' })] }, 'an alert is firing: Gateway Clock Skew'],
    ['a failed replay', { activeAlerts: [job('playback')] }, 'an alert is firing: Capture or Playback Failed'],
    ['a stuck replay', { activeAlerts: [job('playback', { rule_uid: 'aber-job-stuck', alert_name: 'Capture or Playback Stuck' })] }, 'an alert is firing: Capture or Playback Stuck'],
    ['a worker that does not report', { activeAlerts: [job('playback', { rule_uid: 'aber-playback-worker-stale', alert_name: 'Playback Worker Not Reporting', labels: {} })] }, 'an alert is firing: Playback Worker Not Reporting'],
    ['a device in quarantine', { devices: [held] }, 'it has a device in quarantine'],
  ])('%s shows it, and the check says that one is showing, and why', async (_what, state, words) => {
    await open([gateway(), playback()], state)

    expect(listed()).toEqual(['Host_Gateway_NodeRED', 'Playback'])
    expect(check()).not.toBeChecked()
    expect(reads()).toBe('Show Playback gateway 1 showing')
    expect(await tip()).toBe(`Shown because ${words}.`)
    // Not what a person chose, so no filter was changed and the address holds nothing.
    expect(within(bar()).getByRole('button', { name: 'Filters' })).toBeInTheDocument()
    expect(screen.queryByText(/Clear filters/)).toBeNull()
    expect(currentUrl()).toBe('/gateways')
  })

  it.each([
    ['a failed capture', { activeAlerts: [job('capture')] }],
    ['an alert on another gateway', { activeAlerts: [onGateway({ sparkplug_id: 'gwy100000000000400080000' })] }],
    ['an alert on a device', { activeAlerts: [onGateway({ entity_type: 'device' })] }],
    ['a suppressed alert', { activeAlerts: [onGateway({ suppressed: true })] }],
    ['a suppressed alert of a replay', { activeAlerts: [job('playback', { suppressed: true })] }],
    ['a device in quarantine elsewhere', { devices: [{ ...held, active_gateway_id: 'gw-1' }] }],
  ])('%s leaves it off', async (_what, state) => {
    await open([gateway(), playback()], state)
    expect(listed()).toEqual(['Host_Gateway_NodeRED'])
    expect(reads()).toBe('Show Playback gateway 1')
  })

  it('says why beside a check that is on, too', async () => {
    await open([gateway(), playback()], { activeAlerts: [onGateway()], address: '/gateways?playback=1' })
    expect(reads()).toBe('Show Playback gateway 1')
    expect(await tip()).toBe('Shown because an alert is firing: Gateway Clock Skew.')
  })

  it('is found by Has quarantined devices, which counts it', async () => {
    await open([gateway(), playback()], { devices: [held] })
    fireEvent.click(within(bar()).getByRole('button', { name: 'Has quarantined devices (1)' }))
    expect(listed()).toEqual(['Playback'])
  })

  it('is the gateway that has it, by its ids', () => {
    expect(playbackProblem(playback(), { activeAlerts: [onGateway()] })).not.toBeNull()
    expect(playbackProblem(playback(), {})).toBeNull()
    expect(playbackProblem(null)).toBeNull()
  })
})

describe('the Filters panel', () => {
  it('holds Lifecycle and Type over the check, and the toolbar holds neither', async () => {
    await open([gateway(), playback()])
    const panel = openFiltersPanel()

    expect(within(panel).getByRole('button', { name: 'Lifecycle, Active' })).toHaveAttribute('aria-expanded', 'true')
    expect(within(panel).getByRole('button', { name: 'Type' })).toHaveAttribute('aria-expanded', 'false')
    const controls = panel.querySelector('.filters-popover-controls')
    expect([...controls.children].map(c => c.className)).toEqual(['filter-sections', 'filter-list-head'])
    expect(within(bar()).queryByRole('button', { name: /^(Lifecycle|Type):/ })).toBeNull()
  })

  it('counts its own filters, and clears them alone', async () => {
    await open([gateway(), playback(), retired()], { address: '/gateways?lifecycle=active,archived&type=host&playback=1&status=ONLINE' })

    expect(within(bar()).getByRole('button', { name: 'Filters (3)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Clear filters \(4\)/ })).toBeInTheDocument()

    fireEvent.click(within(openFiltersPanel()).getByRole('button', { name: 'Clear' }))
    expect(within(bar()).getByRole('button', { name: 'Filters' })).toBeInTheDocument()
    expect(currentUrl()).toBe('/gateways?status=ONLINE')
  })

  it('says whether Has quarantined devices is on, as the toggles beside it do', async () => {
    await open([gateway()])
    const toggle = () => within(bar()).getByRole('button', { name: /^Has quarantined devices/ })
    expect(toggle()).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle())
    expect(toggle()).toHaveAttribute('aria-pressed', 'true')
  })
})
