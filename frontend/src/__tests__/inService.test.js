import { describe, it, expect } from 'vitest'
import {
  isDeviceInService, isGatewayInService, inServiceDevices, inServiceGateways, areaWideInService
} from '../utils/inService'
import {
  deviceSummaryState, deviceSummaryCounts, deviceSummaryText, deviceColumnTags, devicesOnlineLabel
} from '../utils/deviceStatus'

/**
 * Equipment in service, the one rule every page's place counts read: not archived, and for a
 * device not a replay lane. A quarantined device is on the shopfloor, so it counts.
 */

const device = (over = {}) => ({ asset_id: 'd1', asset_name: 'CNC_01', status: 'ONLINE', ...over })
const BORN = '2026-10-01T08:00:00Z'

describe('equipment in service', () => {
  it('counts a device unless it is archived or a replay lane, and a quarantined one too', () => {
    expect(isDeviceInService(device())).toBe(true)
    expect(isDeviceInService(device({ is_quarantined: true }))).toBe(true)
    expect(isDeviceInService(device({ is_archived: true }))).toBe(false)
    expect(isDeviceInService(device({ shadow_of: 'd0' }))).toBe(false)
    expect(isDeviceInService(null)).toBe(false)
  })

  it('counts a gateway unless it is archived, the Playback gateway included', () => {
    expect(isGatewayInService({ gateway_id: 'g1' })).toBe(true)
    expect(isGatewayInService({ gateway_id: 'g1', is_shadow: true })).toBe(true)
    expect(isGatewayInService({ gateway_id: 'g1', is_archived: true })).toBe(false)
  })

  it('keeps replay lanes when asked, and still leaves archived devices out', () => {
    const rows = [device(), device({ asset_id: 'd2', shadow_of: 'd1' }), device({ asset_id: 'd3', is_archived: true })]
    expect(inServiceDevices(rows).map(d => d.asset_id)).toEqual(['d1'])
    expect(inServiceDevices(rows, { replayLanes: true }).map(d => d.asset_id)).toEqual(['d1', 'd2'])
    expect(inServiceDevices(undefined)).toEqual([])
    expect(inServiceGateways([{ gateway_id: 'g1' }, { gateway_id: 'g2', is_archived: true }])).toHaveLength(1)
  })

  it('finds what is Area-Wide in an area and in service, and no simulated or Playback gateway', () => {
    const wide = { location_source: 'area_wide', effective_area_id: 'a1' }
    const devices = [
      device({ asset_id: 'w1', ...wide }),
      device({ asset_id: 'w2', ...wide, is_archived: true }),
      device({ asset_id: 'w3', ...wide, shadow_of: 'w1' }),
      device({ asset_id: 'w4', location_source: 'area_wide', effective_area_id: 'a2' })
    ]
    const gw = (id, over = {}) => ({ gateway_id: id, location_scope: 'area_wide', area_id: 'a1', ...over })
    const gateways = [gw('g1'), gw('g2', { is_archived: true }), gw('g3', { is_simulated: true }), gw('g4', { is_shadow: true })]
    const found = areaWideInService('a1', devices, gateways)
    expect(found.devices.map(d => d.asset_id)).toEqual(['w1'])
    expect(found.gateways.map(g => g.gateway_id)).toEqual(['g1'])
  })
})

/**
 * A devices column's summary, by the Devices page's lines: Online is ONLINE, Offline is OFFLINE
 * after a first birth, Awaiting first birth is never heard from, and quarantined is none of them.
 */
describe('the devices column summary', () => {
  it('puts each device in one state', () => {
    expect(deviceSummaryState(device({ first_dbirth_at: BORN }))).toBe('online')
    expect(deviceSummaryState(device({ status: 'OFFLINE', first_dbirth_at: BORN }))).toBe('offline')
    expect(deviceSummaryState(device({ status: 'OFFLINE' }))).toBe('awaitingBirth')
    // A quarantined device arrives stored ONLINE.
    expect(deviceSummaryState(device({ is_quarantined: true }))).toBe('quarantined')
    // A missing status is not running.
    expect(deviceSummaryState(device({ status: null, first_dbirth_at: BORN }))).toBe('offline')
  })

  it('names Awaiting first birth only while a device is', () => {
    const rows = [device(), device({ status: 'OFFLINE', first_dbirth_at: BORN }), device({ is_quarantined: true })]
    expect(deviceSummaryCounts(rows)).toEqual({ online: 1, offline: 1, awaitingBirth: 0, quarantined: 1 })
    expect(deviceSummaryText(rows)).toBe('1 Online / 1 Offline')
    expect(deviceSummaryText([...rows, device({ status: 'OFFLINE' })])).toBe('1 Online / 1 Offline / 1 Awaiting first birth')
  })

  /* The label the Cells drawer and the Site Map's panels share. A quarantined device arrives stored
     ONLINE, and a missing status is not running: neither is online. */
  it('labels a panel\'s devices online by the same rule, with the quarantined and unborn apart', () => {
    const rows = [
      device({ first_dbirth_at: BORN }),
      device({ asset_id: 'd2', is_quarantined: true }),
      device({ asset_id: 'd3', status: null, first_dbirth_at: BORN }),
      device({ asset_id: 'd4', status: 'OFFLINE' })
    ]
    expect(deviceSummaryCounts(rows)).toEqual({ online: 1, offline: 1, awaitingBirth: 1, quarantined: 1 })
    expect(devicesOnlineLabel(rows)).toBe('Devices (1/4 online · 1 quarantined · 1 awaiting first birth)')
    expect(devicesOnlineLabel(rows.slice(0, 2))).toBe('Devices (1/2 online · 1 quarantined)')
    expect(devicesOnlineLabel([rows[0], rows[2]])).toBe('Devices (1/2 online)')
    expect(devicesOnlineLabel([])).toBe('Devices')
    expect(devicesOnlineLabel()).toBe('Devices')
  })

  it('lists an archived device marked and muted, and pins a quarantined one in amber', () => {
    const live = device({ asset_id: 'd1' })
    const old = device({ asset_id: 'd2', asset_name: 'CNC_02', is_archived: true })
    const held = device({ asset_id: 'd3', asset_name: 'Unknown_01', is_quarantined: true })
    const [summary, ...chips] = deviceColumnTags([live, old, held], [live, held])
    expect(summary).toMatchObject({ priority: true, content: '1 Online / 0 Offline' })
    expect(chips[0]).toMatchObject({ className: 'badge badge-sm badge-online', title: 'CNC_01 — ONLINE', priority: false })
    expect(chips[1]).toMatchObject({ className: 'badge badge-sm badge-neutral', title: 'CNC_02 — ARCHIVED', content: 'CNC_02 (archived)' })
    expect(chips[2]).toMatchObject({ className: 'badge badge-sm badge-warning', content: 'Unknown_01 (quarantined)', priority: true })
  })
})
