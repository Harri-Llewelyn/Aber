import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import { api } from '../api'
import { tooltipOf } from '../test/tooltips'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const device = (n, overrides = {}) => ({
  asset_id: `dev-${n}`,
  asset_name: `CNC_${String(n).padStart(2, '0')}`,
  status: 'ONLINE',
  is_quarantined: false,
  active_gateway_id: 'gw-1',
  ...overrides
})

const gateway = (devices) => ({
  gateway_id: 'gw-1',
  gateway_name: 'Line_A_Gateway',
  sparkplug_id: 'gwy100000000000400080000',
  cell_id: 'cell-1',
  status: 'ONLINE',
  deployment: 'remote',
  is_archived: false,
  last_heartbeat: new Date().toISOString(),
  device_count: devices.length,
  devices
})

const show = async (devices) => {
  const gw = gateway(devices)
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/cells')) return Promise.resolve([{ cell_id: 'cell-1', cell_name: 'Assembly Line 1' }])
    if (path.startsWith('/api/v1/gateways')) return Promise.resolve([gw])
    if (path.startsWith('/api/v1/devices')) return Promise.resolve(devices)
    return Promise.resolve([])
  })
  render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()} />)
  await waitFor(() => expect(screen.getByText('Line_A_Gateway')).toBeInTheDocument())
}

const twenty = Array.from({ length: 20 }, (_, i) => device(i + 1))

beforeEach(() => vi.clearAllMocks())

describe('the gateway devices column', () => {
  it('shows every device when the fleet is small', async () => {
    await show([device(1), device(2)])

    expect(screen.getByText('2 Online / 0 Offline')).toBeInTheDocument()
    expect(screen.getByText('CNC_01')).toBeInTheDocument()
    expect(screen.getByText('CNC_02')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^\+/ })).not.toBeInTheDocument()
  })

  it('collapses a large fleet instead of rendering one chip per device', async () => {
    // Past three tags, the Online / Offline summary counting as one, the rest collapse into +N.
    await show(twenty)

    expect(screen.getByText('CNC_01')).toBeInTheDocument()
    expect(screen.getByText('CNC_02')).toBeInTheDocument()
    expect(screen.queryByText('CNC_20')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '+18' })).toBeInTheDocument()
  })

  it('never collapses the Online/Offline summary', async () => {
    // It is the answer to "is this gateway healthy" -- the question the column exists to answer.
    // Hiding it behind a "+18" would defeat the column entirely.
    await show(twenty)
    expect(screen.getByText('20 Online / 0 Offline')).toBeInTheDocument()
  })

  it('pins a quarantined device however deep in the fleet it sits', async () => {
    // Same rule as Unmodelled on the Devices row: it is the one entry that calls for action, and
    // it would otherwise be lost among nineteen healthy ones.
    const fleet = [...twenty.slice(0, 19), device(20, { is_quarantined: true, status: 'OFFLINE' })]
    await show(fleet)

    expect(screen.getByText('CNC_20 (quarantined)')).toBeInTheDocument()
    // ...and it displaced a healthy device rather than widening the row.
    expect(screen.queryByText('CNC_02')).not.toBeInTheDocument()
  })

  it('names the hidden devices in the tooltip, not their UUIDs', async () => {
    // The entries are keyed by asset_id; a tooltip full of UUIDs would be worse than none.
    await show(twenty)

    const title = tooltipOf(screen.getByRole('button', { name: '+18' }))
    expect(title).toMatch(/^CNC_03, CNC_04/)
    expect(title).not.toMatch(/dev-/)
  })

  it('expands to the full fleet on demand', async () => {
    await show(twenty)
    fireEvent.click(screen.getByRole('button', { name: '+18' }))

    expect(screen.getByText('CNC_20')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'show less' })).toBeInTheDocument()
  })

  it('still reports an empty gateway plainly rather than as a zero count', async () => {
    await show([])
    expect(screen.getByText(/No devices assigned/i)).toBeInTheDocument()
  })
})

/* The summary and the chips read the shared status helpers, as the drawer and the Devices page do:
   Online is ONLINE, Offline is OFFLINE after a first birth, and a device never heard from is
   Awaiting first birth. A quarantined device is in none of them, and an archived one is listed but
   counted nowhere. */
describe('the devices column counts by the shared status rules', () => {
  const BORN = '2026-10-01T08:00:00Z'
  const chip = (text) => screen.getByText(text, { selector: '.badge' })
  const summary = () => screen.getByText(/^\d+ Online \/ /).textContent

  it('counts a quarantined device in neither Online nor Offline, and draws it amber and pinned', async () => {
    // Stored ONLINE, as the quarantine insert writes it.
    await show([...twenty.slice(0, 4), device(5, { is_quarantined: true, status: 'ONLINE' })])
    expect(summary()).toBe('4 Online / 0 Offline')
    expect(chip('CNC_05 (quarantined)')).toHaveClass('badge-warning')
    expect(tooltipOf(chip('CNC_05 (quarantined)'))).toBe('CNC_05 — QUARANTINED')
  })

  it('counts a device never heard from apart, as Awaiting first birth, and an OFFLINE one after its birth as Offline', async () => {
    await show([
      device(1),
      device(2, { status: 'OFFLINE', first_dbirth_at: BORN }),
      device(3, { status: 'OFFLINE', first_dbirth_at: null }),
      // A missing status is not running.
      device(4, { status: null, first_dbirth_at: BORN })
    ])
    expect(summary()).toBe('1 Online / 2 Offline / 1 Awaiting first birth')
    fireEvent.click(screen.getByRole('button', { name: /^\+/ }))
    expect(chip('CNC_01')).toHaveClass('badge-online')
    expect(chip('CNC_04')).toHaveClass('badge-neutral')
    expect(tooltipOf(chip('CNC_03'))).toBe('CNC_03 — AWAITING FIRST BIRTH')
  })

  it('says nothing of Awaiting first birth while no device is', async () => {
    await show([device(1), device(2, { status: 'OFFLINE', first_dbirth_at: BORN })])
    expect(summary()).toBe('1 Online / 1 Offline')
  })

  /* The gateways embed carries `first_dbirth_at`, and the row reads its devices from it alone: no
     flat device list is needed to tell Offline from Awaiting first birth. */
  it('reads each device’s first birth from the gateway’s own embed', async () => {
    const gw = gateway([
      device(1, { first_dbirth_at: BORN }),
      device(2, { status: 'OFFLINE', first_dbirth_at: BORN }),
      device(3, { status: 'OFFLINE', first_dbirth_at: null })
    ])
    api.get.mockImplementation((path) => {
      if (path.startsWith('/api/v1/gateways')) return Promise.resolve([gw])
      return Promise.resolve([])
    })
    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} />)
    await waitFor(() => expect(screen.getByText('Line_A_Gateway')).toBeInTheDocument())
    expect(summary()).toBe('1 Online / 1 Offline / 1 Awaiting first birth')
  })

  it('lists an archived device, marked, and leaves it out of the summary, the sort and the drawer’s count', async () => {
    await show([device(1), device(2, { is_archived: true, status: 'ONLINE' })])
    expect(summary()).toBe('1 Online / 0 Offline')
    expect(chip('CNC_02 (archived)')).toHaveClass('badge-neutral')
    expect(tooltipOf(chip('CNC_02 (archived)'))).toBe('CNC_02 — ARCHIVED')

    fireEvent.click(screen.getByText('Line_A_Gateway', { selector: 'tbody strong' }))
    const panel = await waitFor(() => {
      const open = document.querySelector('.context-panel-open')
      expect(open).toBeTruthy()
      return open
    })
    expect(within(panel).getByText('Devices (1)')).toBeInTheDocument()
    expect(within(panel).getByRole('link', { name: /CNC_02/ })).toHaveTextContent('ARCHIVED')
  })

  it('sorts by the devices in service, so archived ones do not lift a gateway', async () => {
    const at = (id, name, devs) => ({ ...gateway(devs), gateway_id: id, gateway_name: name })
    const archived = (n) => device(n, { is_archived: true })
    api.get.mockImplementation((path) => {
      if (path.startsWith('/api/v1/gateways')) {
        return Promise.resolve([
          at('gw-a', 'Few_Live', [device(1), archived(2), archived(3), archived(4)]),
          at('gw-b', 'More_Live', [device(5), device(6)])
        ])
      }
      return Promise.resolve([])
    })
    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} />)
    await waitFor(() => expect(screen.getByText('Few_Live')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Devices' }))
    fireEvent.click(screen.getByRole('button', { name: 'Devices' }))
    expect([...document.querySelectorAll('.table-wrap tbody tr strong')].map(s => s.textContent)).toEqual(['More_Live', 'Few_Live'])
  })

  /* The Playback gateway serves replay lanes and nothing else: on this page they are what it serves,
     so only archived devices leave its counts. */
  it('counts the Playback gateway’s replay lanes as the devices it serves', async () => {
    const lane = (n) => device(n, { shadow_of: `dev-src-${n}`, asset_name: `Lane_${n}` })
    const playback = { ...gateway([lane(1), lane(2)]), gateway_id: 'gw-play', gateway_name: 'Playback', is_shadow: true, is_simulated: true, deployment: 'host', cell_id: null }
    api.get.mockImplementation((path) => {
      if (path.startsWith('/api/v1/gateways')) return Promise.resolve([playback])
      return Promise.resolve([])
    })
    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} />)
    await waitFor(() => expect(screen.getByText('Playback', { selector: 'tbody strong' })).toBeInTheDocument())
    expect(summary()).toBe('2 Online / 0 Offline')
    expect(screen.getByText('Lane_1')).toBeInTheDocument()
  })

  it('names the column Devices, and says in its title what it lists', async () => {
    await show([device(1)])
    const header = screen.getByRole('columnheader', { name: 'Devices' })
    expect(tooltipOf(within(header).getByRole('button', { name: 'Devices' }))).toMatch(/^The devices this gateway serves/)
    expect(screen.queryByText(/Connected Devices/)).toBeNull()
  })
})

describe('the gateways table sorts by a column (#801)', () => {
  const ago = (ms) => new Date(Date.now() - ms).toISOString()
  const MINUTE = 60_000
  const DAY = 24 * 60 * MINUTE
  const devices = (prefix, n) => Array.from({ length: n }, (_, i) => device(`${prefix}-${i}`, { asset_name: `${prefix}_${i}` }))
  const at = (id, name, devs, overrides) => ({ ...gateway(devs), gateway_id: id, gateway_name: name, ...overrides })

  /* In this order from the API. Stale_Gateway is stored ONLINE but its heartbeat has aged out, and
     Enrolled_Gateway keeps a heartbeat from a previous life. Archived_Gateway shows no status and no
     devices, Pending_Gateway has never been heard from, and two have no location: one scoped to a
     cell with none, and one simulated, which cannot hold a cell. */
  const fleet = () => [
    at('gw-archived', 'Archived_Gateway', devices('arch', 4), { is_archived: true, last_heartbeat: ago(2 * DAY), cell_id: 'cell-1' }),
    at('gw-online', 'Online_Gateway', devices('on', 2), { last_heartbeat: ago(10_000), cell_id: 'cell-2' }),
    at('gw-offline', 'Offline_Gateway', devices('off', 1), { status: 'OFFLINE', last_heartbeat: ago(60 * MINUTE), cell_id: null, location_scope: 'site_wide' }),
    at('gw-pending', 'Pending_Gateway', [], { status: 'PENDING_ENROLLMENT', last_heartbeat: null, cell_id: null, location_scope: 'cell' }),
    at('gw-enrolled', 'Enrolled_Gateway', devices('enr', 3), { status: 'AWAITING_BIRTH', last_heartbeat: ago(3 * DAY), cell_id: 'cell-9' }),
    at('gw-stale', 'Stale_Gateway', devices('stale', 5), { last_heartbeat: ago(10 * MINUTE), is_simulated: true, deployment: 'host' })
  ]

  const showFleet = async (url = '/gateways?lifecycle=all') => {
    window.history.replaceState(null, '', url)
    api.get.mockImplementation((path) => {
      if (path.startsWith('/api/v1/cells')) return Promise.resolve([{ cell_id: 'cell-1', cell_name: 'Assembly Line 1' }, { cell_id: 'cell-2', cell_name: 'Boiler Bay' }])
      if (path.startsWith('/api/v1/gateways')) return Promise.resolve(fleet())
      return Promise.resolve([])
    })
    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} />)
    await waitFor(() => expect(document.querySelectorAll('.table-wrap tbody tr')).toHaveLength(6))
  }
  const rows = () => [...document.querySelectorAll('.table-wrap tbody tr')]
  const names = () => rows().map(r => r.querySelector('strong').textContent.replace('_Gateway', ''))
  const address = () => window.location.pathname + window.location.search

  it('ranks Gateway Status by the badge’s severity, not its word, with an archived gateway last either way', async () => {
    await showFleet()
    const header = screen.getByRole('columnheader', { name: 'Gateway Status' })

    // Stale's amber, then waiting on a person, waiting on a machine, grey Offline, green Online.
    fireEvent.click(screen.getByRole('button', { name: 'Gateway Status' }))
    expect(names()).toEqual(['Stale', 'Pending', 'Enrolled', 'Offline', 'Online', 'Archived'])
    expect(header).toHaveAttribute('aria-sort', 'ascending')
    expect(address()).toBe('/gateways?lifecycle=all&sort=status')

    fireEvent.click(screen.getByRole('button', { name: 'Gateway Status' }))
    expect(names()).toEqual(['Online', 'Offline', 'Enrolled', 'Pending', 'Stale', 'Archived'])
    expect(header).toHaveAttribute('aria-sort', 'descending')
    expect(address()).toBe('/gateways?lifecycle=all&sort=-status')
  })

  it('sorts Last Heartbeat by instant with Never last, and Devices by count with an archived gateway last', async () => {
    await showFleet()
    expect(within(rows()[3]).getByText('Never')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Last Heartbeat' }))
    expect(names()).toEqual(['Enrolled', 'Archived', 'Offline', 'Stale', 'Online', 'Pending'])
    fireEvent.click(screen.getByRole('button', { name: 'Last Heartbeat' }))
    expect(names()).toEqual(['Online', 'Stale', 'Offline', 'Archived', 'Enrolled', 'Pending'])

    fireEvent.click(screen.getByRole('button', { name: 'Devices' }))
    expect(names()).toEqual(['Pending', 'Offline', 'Online', 'Enrolled', 'Stale', 'Archived'])
    fireEvent.click(screen.getByRole('button', { name: 'Devices' }))
    expect(names()).toEqual(['Stale', 'Enrolled', 'Online', 'Offline', 'Pending', 'Archived'])
  })

  it('sorts Location by the cell’s name, or its id where the cell is unknown, with no location last either way', async () => {
    await showFleet()
    fireEvent.click(screen.getByRole('button', { name: 'Location' }))
    expect(names()).toEqual(['Archived', 'Online', 'Enrolled', 'Offline', 'Pending', 'Stale'])
    fireEvent.click(screen.getByRole('button', { name: 'Location' }))
    expect(names()).toEqual(['Offline', 'Enrolled', 'Online', 'Archived', 'Pending', 'Stale'])
  })

  /* The open drawer drops the UUID and Devices columns; a sort by one of them stays in the
     address and in the order of the rows, and its header returns marked when the drawer closes. */
  it('opens sorted from the address, and keeps the order while the drawer hides the sorted column', async () => {
    await showFleet('/gateways?lifecycle=all&sort=-devices')
    const sorted = ['Stale', 'Enrolled', 'Online', 'Offline', 'Pending', 'Archived']
    expect(names()).toEqual(sorted)
    expect(screen.getByRole('columnheader', { name: 'Devices' })).toHaveAttribute('aria-sort', 'descending')

    fireEvent.click(screen.getByText('Online_Gateway', { selector: 'tbody strong' }))
    await waitFor(() => expect(screen.queryByRole('columnheader', { name: 'Devices' })).toBeNull())
    expect(screen.queryByRole('columnheader', { name: 'Gateway UUID' })).toBeNull()
    expect(document.querySelectorAll('th[aria-sort]')).toHaveLength(0)
    expect(names()).toEqual(sorted)
    expect(address()).toBe('/gateways?lifecycle=all&sort=-devices&gateway=gw-online')

    fireEvent.click(screen.getByText('Online_Gateway', { selector: 'tbody strong' }))
    await waitFor(() => expect(screen.getByRole('columnheader', { name: 'Devices' })).toHaveAttribute('aria-sort', 'descending'))
    expect(names()).toEqual(sorted)
  })
})
