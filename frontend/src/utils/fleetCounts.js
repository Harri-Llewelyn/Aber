import { isGatewayOnline, isGatewayPending } from './gatewayStatus'

/**
 * The fleet figures the rail signals and the Site Map show. A shadow row is not part of the fleet:
 * the playback gateway is neither archived nor pending, so counted raw it lands in OFFLINE. The
 * shadow count is returned separately, outside `total`.
 */

/** The playback gateway (0060). One row per stack, seeded rather than created. */
export const isShadowGateway = (g) => !!(g && g.is_shadow)

/**
 * A shadow device: a stand-in minted per device a capture recorded. `shadow_of` names the original.
 */
export const isShadowDevice = (d) => !!(d && d.shadow_of)

/**
 * Gateway buckets over the real fleet. Awaiting setup is its own bucket: a gateway waiting for its
 * bundle is not offline. The four buckets are mutually exclusive and sum to `total`.
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
 * Device figures over the real fleet. Quarantined counts devices waiting to be admitted, archived
 * ones aside. No online or offline here: count devices by state with deviceSummaryCounts() in
 * deviceStatus.js, the rule every page's devices summary uses.
 */
export function deviceFleetCounts(devices = []) {
  const real = devices.filter((d) => !isShadowDevice(d))
  return {
    total: real.length,
    quarantined: real.filter((d) => d.is_quarantined && !d.is_archived).length,
    archived: real.filter((d) => d.is_archived).length,
    shadow: devices.filter((d) => isShadowDevice(d) && !d.is_archived).length
  }
}
