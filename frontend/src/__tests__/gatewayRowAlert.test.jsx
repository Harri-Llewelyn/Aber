import React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { api } from '../api'
import { tooltipOf } from '../test/tooltips'
import { alertForGateway, alertIndex, statusSortRank, worstAlert } from '../utils/alertSubjects'
import { playbackAlert } from '../utils/playbackGateway'
import { gatewaySparkplugId } from '../utils/sparkplugId'

/**
 * A gateway's firing alert on the Gateways page, drawn as the Devices page draws a device's: a badge
 * under the status in its row, with the same words and the same order when sorted by status, and the
 * alert at the top of its drawer. An acknowledged one is the hollow badge; a suppressed one colours no
 * row, and the drawer's banner says it is suppressed. The Playback gateway's alert may be one on a
 * playback, which is what lists it by itself.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

vi.mock('../lib/supabaseClient', () => ({
  supabase: { functions: { invoke: vi.fn() } }
}))

const NOW = new Date().toISOString()
const uuid = (n) => `7000000${n}-0000-4000-8000-00000000000${n}`
const gateway = (n, overrides = {}) => ({
  gateway_id: uuid(n), gateway_name: `Gateway_${n}`, sparkplug_id: gatewaySparkplugId(uuid(n)), sparkplug_group: 'Plant-A', cell_id: null, location_scope: 'site_wide',
  status: 'ONLINE', deployment: 'host', is_simulated: false, is_shadow: false, is_archived: false, access_url: null,
  last_heartbeat: NOW, device_count: 0, devices: [], ...overrides,
})
const PLAYBACK = gateway(9, { gateway_name: 'Playback', is_simulated: true, is_shadow: true, status: 'OFFLINE', last_heartbeat: null })

const alert = (gw, overrides = {}) => ({
  id: `a-${gw.gateway_id}`, fingerprint: `f-${gw.gateway_id}`, entity_type: 'gateway', sparkplug_id: gw.sparkplug_id,
  entity_id: null, alert_name: 'Gateway Stale', severity: 'warning', summary: 'No heartbeat for 5 minutes',
  rule_uid: 'aber-gateway-stale', starts_at: '2026-11-26T08:00:00Z', ...overrides,
})
const acknowledged = (gw, overrides = {}) => alert(gw, {
  acknowledged_at: '2026-11-26T08:05:00Z', acknowledged_by: 'a0d17231-0000-4000-8000-0000000231a1',
  acknowledged_by_email: 'op@aber.local', acknowledgement_reason: 'planned_work', ...overrides,
})
const playbackJob = (overrides = {}) => ({
  id: 'a-job', fingerprint: 'f-job', alert_name: 'Capture or Playback Failed', severity: 'warning', entity_type: 'platform',
  rule_uid: 'aber-job-failed', labels: { job: 'playback job 8b1f1a52-5ed9-4f35-9a3c-000000000001' }, ...overrides,
})

const open = async (rows, { activeAlerts = [], address = '/gateways' } = {}) => {
  api.get.mockImplementation((path) => Promise.resolve(path.startsWith('/api/v1/gateways') ? rows : []))
  window.history.replaceState(null, '', address)
  const view = render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} userRole="Shopfloor_Manager" activeAlerts={activeAlerts} />)
  await waitFor(() => expect(screen.queryByText(/Loading gateways/)).toBeNull())
  return view
}

const rowOf = (name) => screen.getByText(name, { selector: 'td strong' }).closest('tr')
/** The row's status cell: the fifth, with the drawer closed. */
const statusOf = (name) => rowOf(name).querySelectorAll('td')[4]
const alertBadgeIn = (cell) => [...cell.querySelectorAll('.badge')].find(b => /^(ALARM|WARNING|ACKNOWLEDGED)$/.test(b.textContent)) || null
const listed = () => [...document.querySelectorAll('tbody tr td strong')].map(el => el.textContent)
const banner = () => document.querySelector('.context-panel[aria-hidden="false"] .context-alert')

beforeEach(() => vi.clearAllMocks())

describe('a gateway row', () => {
  it('says a critical alert as ALARM under its status, which it keeps', async () => {
    const gw = gateway(1)
    await open([gw], { activeAlerts: [alert(gw, { severity: 'critical' })] })

    const cell = statusOf('Gateway_1')
    expect(cell).toHaveTextContent('ONLINE')
    const badge = alertBadgeIn(cell)
    expect(badge).toHaveTextContent('ALARM')
    expect(badge).toHaveClass('badge-danger', 'badge-sm')
    expect(badge.querySelector('svg')).toBeTruthy()
    expect(tooltipOf(badge)).toBe('Gateway Stale — No heartbeat for 5 minutes')
  })

  it('says any other as WARNING, found by its row\'s UUID too', async () => {
    const gw = gateway(1)
    await open([gw], { activeAlerts: [alert(gw, { sparkplug_id: null, entity_id: gw.gateway_id })] })

    const badge = alertBadgeIn(statusOf('Gateway_1'))
    expect(badge).toHaveTextContent('WARNING')
    expect(badge).toHaveClass('badge-warning')
  })

  it('says an acknowledged one as the hollow ACKNOWLEDGED, with who and why', async () => {
    const gw = gateway(1)
    await open([gw], { activeAlerts: [acknowledged(gw)] })

    const badge = alertBadgeIn(statusOf('Gateway_1'))
    expect(badge).toHaveTextContent('ACKNOWLEDGED')
    expect(badge).toHaveClass('badge-acknowledged')
    expect(tooltipOf(badge)).toBe('Gateway Stale — acknowledged by op@aber.local: Planned work')
  })

  it.each([
    ['a suppressed alert', (gw) => alert(gw, { suppressed: true })],
    ['an alert on one of its devices', (gw) => alert(gw, { entity_type: 'device' })],
    ['an alert on another gateway', () => alert(gateway(2))],
    ['a platform alert', () => alert(gateway(2), { entity_type: 'platform', sparkplug_id: null })],
  ])('draws nothing for %s', async (_what, make) => {
    const gw = gateway(1)
    await open([gw], { activeAlerts: [make(gw)] })
    expect(alertBadgeIn(statusOf('Gateway_1'))).toBeNull()
  })

  it('draws the mark a Devices row draws for the same alert', async () => {
    const device = {
      asset_id: 'aaaaaaaa-0000-4000-8000-000000000231', asset_name: 'Press_04', sparkplug_id: 'devaaaaaaaa000040008231',
      status: 'ONLINE', is_quarantined: false, is_archived: false, active_gateway_id: null, cell_id: null,
      location_scope: 'cell', effective_cell_id: null, location_source: 'inherited', first_dbirth_at: '2026-07-27T12:00:00Z',
    }
    const marks = []
    for (const severity of ['critical', 'warning', 'acknowledged']) {
      const gw = gateway(1)
      const on = (subject) => (severity === 'acknowledged' ? acknowledged(subject) : alert(subject, { severity }))
      const gateways = await open([gw], { activeAlerts: [on(gw)] })
      const gatewayMark = alertBadgeIn(statusOf('Gateway_1'))

      api.get.mockImplementation((path) => Promise.resolve(path.startsWith('/api/v1/devices') ? [device] : []))
      window.history.replaceState(null, '', '/devices')
      const devices = render(<DevicesTab showToast={vi.fn()} hasPermission={() => true} activeAlerts={[{ ...on(gw), entity_type: 'device', sparkplug_id: device.sparkplug_id }]} />)
      const deviceRow = (await screen.findByText('Press_04', { selector: 'td strong' })).closest('tr')
      const deviceMark = alertBadgeIn(deviceRow)

      marks.push([gatewayMark.className, gatewayMark.textContent, deviceMark.className, deviceMark.textContent])
      expect(gatewayMark.className).toBe(deviceMark.className)
      expect(gatewayMark.textContent).toBe(deviceMark.textContent)
      expect(gatewayMark.querySelector('svg').innerHTML).toBe(deviceMark.querySelector('svg').innerHTML)
      devices.unmount()
      gateways.unmount()
    }
    expect(marks.map(m => m[1])).toEqual(['ALARM', 'WARNING', 'ACKNOWLEDGED'])
  })
})

describe('sorting by status', () => {
  it('puts a firing alert first, the worst first, then an acknowledged one, then the status', async () => {
    const calm = gateway(1)
    const warned = gateway(2)
    const alarmed = gateway(3, { status: 'OFFLINE' })
    const handled = gateway(4)
    const quiet = gateway(5, { status: 'OFFLINE' })
    const hushed = gateway(6)
    await open([calm, warned, alarmed, handled, quiet, hushed], {
      activeAlerts: [
        alert(warned), alert(alarmed, { severity: 'critical' }), acknowledged(handled, { severity: 'critical' }),
        alert(hushed, { severity: 'critical', suppressed: true }),
      ],
    })

    fireEvent.click(screen.getByRole('button', { name: 'Gateway Status' }))
    expect(listed()).toEqual(['Gateway_3', 'Gateway_2', 'Gateway_4', 'Gateway_5', 'Gateway_1', 'Gateway_6'])
  })

  it('ranks as the Devices page ranks', () => {
    const gw = gateway(1)
    const ranks = [
      statusSortRank(alert(gw, { severity: 'critical' }), 'success'),
      statusSortRank(alert(gw), 'success'),
      statusSortRank(acknowledged(gw, { severity: 'critical' }), 'success'),
      statusSortRank(acknowledged(gw), 'success'),
      statusSortRank(null, 'danger'),
      statusSortRank(alert(gw, { suppressed: true }), 'neutral'),
      statusSortRank(null, 'success'),
    ]
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks)
    expect(statusSortRank(alert(gw, { suppressed: true }), 'neutral')).toBe(statusSortRank(null, 'neutral'))
  })
})

describe('the drawer', () => {
  it('says a firing alert at the top, before its fields, with a link to its history', async () => {
    const gw = gateway(1)
    await open([gw], { activeAlerts: [alert(gw, { severity: 'critical' })], address: `/gateways?gateway=${gw.gateway_id}` })

    await waitFor(() => expect(banner()).toBeTruthy())
    expect(banner().closest('.context-panel-warnings')).toBeTruthy()
    expect(banner()).toHaveTextContent('Gateway Stale')
    expect(banner()).toHaveTextContent('CRITICAL')
    expect(banner()).toHaveTextContent(/Alert firing/)
    const fields = document.querySelector('.context-panel[aria-hidden="false"] .context-panel-fields')
    expect(banner().compareDocumentPosition(fields) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const history = within(banner()).getByRole('link', { name: /Alert history/ })
    expect(decodeURIComponent(history.getAttribute('href'))).toContain(gw.sparkplug_id)
  })

  it.each([
    ['an acknowledged one', (gw) => acknowledged(gw), /Alert acknowledged/, 'context-alert-acknowledged'],
    ['a suppressed one', (gw) => alert(gw, { suppressed: true, suppressed_until: '2026-11-26T12:00:00Z' }), /Alert suppressed/, 'context-alert-suppressed'],
  ])('says %s as Devices does', async (_what, make, words, modifier) => {
    const gw = gateway(1)
    await open([gw], { activeAlerts: [make(gw)], address: `/gateways?gateway=${gw.gateway_id}` })

    await waitFor(() => expect(banner()).toBeTruthy())
    expect(banner()).toHaveTextContent(words)
    expect(banner()).toHaveClass(modifier)
  })

  it('has no alert for a gateway with none', async () => {
    const gw = gateway(1)
    await open([gw, gateway(2)], { activeAlerts: [alert(gateway(2))], address: `/gateways?gateway=${gw.gateway_id}` })
    await waitFor(() => expect(document.querySelector('.context-panel[aria-hidden="false"]')).toBeTruthy())
    expect(banner()).toBeNull()
  })
})

describe('the Playback gateway', () => {
  it.each([
    ['an alert on it', alert(PLAYBACK)],
    ['an alert of a playback', playbackJob()],
  ])('listed by %s shows that alert on its row and in its drawer', async (_what, firing) => {
    await open([gateway(1), PLAYBACK], { activeAlerts: [firing] })

    expect(listed()).toEqual(['Gateway_1', 'Playback'])
    expect(alertBadgeIn(statusOf('Playback'))).toHaveTextContent('WARNING')
    expect(alertBadgeIn(statusOf('Gateway_1'))).toBeNull()

    fireEvent.click(rowOf('Playback'))
    await waitFor(() => expect(banner()).toHaveTextContent(firing.alert_name))
  })

  it('shows the worse of its own and a playback\'s, its own winning a tie', () => {
    const own = alert(PLAYBACK)
    const critical = playbackJob({ severity: 'critical' })
    expect(playbackAlert(PLAYBACK, [own, critical])).toBe(critical)
    expect(playbackAlert(PLAYBACK, [playbackJob(), own])).toBe(own)
    expect(playbackAlert(PLAYBACK, [playbackJob({ suppressed: true })])).toBeNull()
    expect(playbackAlert(PLAYBACK, [playbackJob({ suppressed: true })], { suppressed: true })?.alert_name).toBe('Capture or Playback Failed')
  })
})

describe('alertForGateway', () => {
  const gw = gateway(1)

  it('finds a gateway by its edge node id and by its UUID, and derives the edge node id from the UUID', () => {
    expect(alertForGateway(alertIndex([alert(gw)], 'gateway'), gw)?.alert_name).toBe('Gateway Stale')
    expect(alertForGateway(alertIndex([alert(gw, { sparkplug_id: null, entity_id: gw.gateway_id })], 'gateway'), gw)).not.toBeNull()
    expect(alertForGateway(alertIndex([alert(gw)], 'gateway'), { gateway_id: gw.gateway_id })).not.toBeNull()
  })

  it('takes the worse of the two, the edge node id\'s winning a tie', () => {
    const byNode = alert(gw, { id: 'node', entity_id: null })
    const byRow = alert(gw, { id: 'row', sparkplug_id: null, entity_id: gw.gateway_id })
    expect(alertForGateway(alertIndex([byRow, byNode], 'gateway'), gw).id).toBe('node')
    const worse = { ...byRow, severity: 'critical' }
    expect(alertForGateway(alertIndex([byNode, worse], 'gateway'), gw).id).toBe('row')
  })

  it('is null without an index, a gateway or an alert', () => {
    expect(alertForGateway(null, gw)).toBeNull()
    expect(alertForGateway(alertIndex([alert(gw)], 'gateway'), null)).toBeNull()
    expect(alertForGateway(alertIndex([alert(gw)]), gw)).toBeNull()
    expect(worstAlert()).toBeNull()
    expect(worstAlert(null, undefined, '')).toBeNull()
  })
})
