import { describe, it, expect } from 'vitest'
import {
  gatewayFleetCounts,
  deviceFleetCounts,
  isShadowGateway,
  isShadowDevice
} from '../utils/fleetCounts'
import { HEARTBEAT_STALE_MS } from '../utils/gatewayStatus'

/**
 * The Overview ribbon's arithmetic. A playback gateway and its shadow device must not be counted in
 * the fleet; counted raw, the playback gateway lands in OFFLINE and reports a permanent fault.
 */

const fresh = () => new Date(Date.now() - 1000).toISOString()
const stale = () => new Date(Date.now() - (HEARTBEAT_STALE_MS + 60_000)).toISOString()

/** An online gateway: enrolled, and beating recently. */
const gateway = (over = {}) => ({
  gateway_id: 'gwy-' + Math.random().toString(16).slice(2),
  is_shadow: false,
  is_archived: false,
  status: 'ONLINE',
  last_heartbeat: fresh(),
  enrolled_at: '2026-01-01T00:00:00Z',
  ...over
})

const device = (over = {}) => ({
  device_id: 'dev-' + Math.random().toString(16).slice(2),
  shadow_of: null,
  is_archived: false,
  is_quarantined: false,
  status: 'ONLINE',
  ...over
})

describe('the shadow predicates', () => {
  it('reads a gateway shadow off is_shadow and a device shadow off shadow_of', () => {
    // Different columns on purpose: a device has no is_shadow flag, and `shadow_of` names the
    // original it stands in for.
    expect(isShadowGateway({ is_shadow: true })).toBe(true)
    expect(isShadowGateway({ is_shadow: false })).toBe(false)
    expect(isShadowDevice({ shadow_of: 'dev-abc' })).toBe(true)
    expect(isShadowDevice({ shadow_of: null })).toBe(false)
  })

  it('survives a null or undefined row rather than throwing', () => {
    // These run on a 3s poll against a list that is briefly empty on first paint.
    expect(isShadowGateway(undefined)).toBe(false)
    expect(isShadowDevice(null)).toBe(false)
    expect(gatewayFleetCounts()).toMatchObject({ total: 0, online: 0, shadow: 0 })
    expect(deviceFleetCounts()).toMatchObject({ total: 0, online: 0, shadow: 0 })
  })
})

describe('gatewayFleetCounts', () => {
  it('leaves the playback gateway out of the total and out of every bucket', () => {
    const counts = gatewayFleetCounts([
      gateway(), gateway(), gateway(), gateway(),
      gateway({ is_shadow: true, last_heartbeat: null, enrolled_at: null })
    ])
    expect(counts.total).toBe(4)
    expect(counts.online).toBe(4)
    expect(counts.shadow).toBe(1)
  })

  it('does not report the playback gateway as a fault', () => {
    // The defect: a shadow gateway is neither archived nor pending, so the offline arm swallowed
    // it.
    const counts = gatewayFleetCounts([
      gateway(),
      gateway({ is_shadow: true, last_heartbeat: null, enrolled_at: null })
    ])
    expect(counts.offline).toBe(0)
    expect(counts.pending).toBe(0)
  })

  it('keeps awaiting-setup out of the offline bucket', () => {
    // A physical gateway sits in PENDING_ENROLLMENT from creation until somebody carries its
    // bundle to a machine. Counted as offline, ordering four appliances shows four faults.
    const counts = gatewayFleetCounts([
      gateway(),
      gateway({ last_heartbeat: null, enrolled_at: null, status: 'PENDING_ENROLLMENT' }),
      gateway({ last_heartbeat: stale() })
    ])
    expect(counts.pending).toBe(1)
    expect(counts.offline).toBe(1)
    expect(counts.online).toBe(1)
  })

  it('sums its four buckets to the total, with shadow deliberately outside them', () => {
    // The property the ribbon's own comment claims. `shadow` is returned for a tooltip and must
    // NOT participate: folding it in would restore the miscount under a different name.
    const gateways = [
      gateway(),
      gateway({ last_heartbeat: stale() }),
      gateway({ last_heartbeat: null, enrolled_at: null, status: 'PENDING_ENROLLMENT' }),
      gateway({ is_archived: true }),
      gateway({ is_shadow: true, last_heartbeat: null, enrolled_at: null })
    ]
    const c = gatewayFleetCounts(gateways)
    expect(c.online + c.pending + c.offline + c.archived).toBe(c.total)
    expect(c.total).toBe(4)
    expect(c.shadow).toBe(1)
  })

  it('does not count an archived shadow gateway as one to mention', () => {
    // The tooltip offers to explain a row the Gateways page can reveal. An archived one is not in
    // that default view either, so mentioning it would send a reader looking for nothing.
    const c = gatewayFleetCounts([gateway(), gateway({ is_shadow: true, is_archived: true })])
    expect(c.shadow).toBe(0)
    expect(c.archived).toBe(0)
  })
})

describe('deviceFleetCounts', () => {
  it('leaves shadow devices out of the total and out of every bucket', () => {
    const counts = deviceFleetCounts([
      device(), device(), device(), device(), device(), device(),
      device({ shadow_of: 'dev-real', status: 'OFFLINE' })
    ])
    expect(counts.total).toBe(6)
    expect(counts.online).toBe(6)
    expect(counts.offline).toBe(0)
    expect(counts.shadow).toBe(1)
  })

  it('keeps quarantined out of online and offline', () => {
    // These used to overlap: a quarantined device is stored with status OFFLINE, so one pending
    // device was reported twice on the same screen -- once as a fault, once as a queue entry.
    const counts = deviceFleetCounts([
      device(),
      device({ is_quarantined: true, status: 'OFFLINE' })
    ])
    expect(counts.quarantined).toBe(1)
    expect(counts.offline).toBe(0)
    expect(counts.online).toBe(1)
  })

  it('treats a device with no status yet as online', () => {
    // A row written before its first birth carries no status. Calling that a fault reports one on
    // every device between provisioning and its first message.
    expect(deviceFleetCounts([device({ status: null })]).online).toBe(1)
  })

  it('sums its four buckets to the total, with shadow deliberately outside them', () => {
    const devices = [
      device(),
      device({ status: 'OFFLINE' }),
      device({ is_quarantined: true, status: 'OFFLINE' }),
      device({ is_archived: true }),
      device({ shadow_of: 'dev-real', status: 'OFFLINE' })
    ]
    const c = deviceFleetCounts(devices)
    expect(c.online + c.offline + c.quarantined + c.archived).toBe(c.total)
    expect(c.total).toBe(4)
    expect(c.shadow).toBe(1)
  })

  it('agrees with the fleet this stack actually runs', () => {
    // The provisioned demonstration floor plus one replay, which is the shape that surfaced this:
    // six Sim_ devices and one `Sim_BMS_Zone_HVAC (replay)`.
    const c = deviceFleetCounts([
      device({ name: 'Sim_BMS_Zone_HVAC' }),
      device({ name: 'Sim_Cell3_Aggregator' }),
      device({ name: 'Sim_CNC_Mill_01' }),
      device({ name: 'Sim_CNC_Mill_02' }),
      device({ name: 'Sim_Robot_Arm_01' }),
      device({ name: 'Sim_Tool_Changer_01' }),
      device({ name: 'Sim_BMS_Zone_HVAC (replay)', shadow_of: 'dev-hvac', status: 'OFFLINE' })
    ])
    expect(`${c.online}/${c.total}`).toBe('6/6')
  })
})
