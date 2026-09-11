import { isGatewayOnline, isGatewayPending } from './gatewayStatus'

/**
 * The Overview ribbon's figures. A shadow row is not part of the fleet: the playback gateway is
 * neither archived nor pending, so counted raw it lands in OFFLINE. The shadow count is returned
 * separately; the four buckets stay mutually exclusive and sum to `total`.
 */

/** The playback gateway (0060). One row per stack, seeded rather than created. */
export const isShadowGateway = (g) => !!(g && g.is_shadow)

/**
 * A shadow device: a stand-in minted per device a capture recorded. `shadow_of` names the original.
 */
export const isShadowDevice = (d) => !!(d && d.shadow_of)

/**
 * Gateway buckets over the real fleet. Awaiting setup is its own bucket: a gateway waiting for its
 * bundle is not offline.
 */
export function gatewayFleetCounts(gateways = []) {
  const real = gateways.filter((g) => !isShadowGateway(g))
  const live = real.filter((g) => !g.is_archived)
  return {
    total: real.length,
    // Only online while the heartbeat is fresh. Wrapped, not passed by reference: `filter` calls
    // back with the index second, and `isGatewayOnline(gateway, now)` would take it as the clock.
    online: live.filter((g) => isGatewayOnline(g)).length,
    pending: live.filter((g) => isGatewayPending(g)).length,
    offline: live.filter((g) => !isGatewayPending(g) && !isGatewayOnline(g)).length,
    archived: real.filter((g) => g.is_archived).length,
    shadow: gateways.filter((g) => isShadowGateway(g) && !g.is_archived).length
  }
}

/**
 * Device buckets over the real fleet. Quarantined is its own bucket, excluded from online and
 * offline. A missing `status` reads as online: a device before its first birth has none.
 */
export function deviceFleetCounts(devices = []) {
  const real = devices.filter((d) => !isShadowDevice(d))
  const live = real.filter((d) => !d.is_archived && !d.is_quarantined)
  return {
    total: real.length,
    online: live.filter((d) => d.status === 'ONLINE' || !d.status).length,
    offline: live.filter((d) => d.status === 'OFFLINE').length,
    quarantined: real.filter((d) => d.is_quarantined && !d.is_archived).length,
    archived: real.filter((d) => d.is_archived).length,
    shadow: devices.filter((d) => isShadowDevice(d) && !d.is_archived).length
  }
}
