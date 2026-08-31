import { isGatewayOnline, isGatewayPending } from './gatewayStatus'

/**
 * The Overview ribbon's figures, and the one rule that decides what they count.
 *
 * =================================================================================================
 * A SHADOW ROW IS NOT PART OF THE FLEET, AND THIS IS THE ONLY PLACE THAT SENTENCE IS WRITTEN.
 *
 * It was previously written three times and obeyed twice. The Gateways page hides `is_shadow` by
 * default, the Devices page hides `shadow_of`, and the shopfloor map omits the shadow lane outright
 * -- with the reason recorded above `laneDevices`: *"a replay is not now -- a lane of stand-ins for
 * machines invites exactly the miscount the lanes exist to prevent."*
 *
 * THE KPI RIBBON WAS COMMITTING THAT MISCOUNT. It counted `gateways.length` and `devices.length`
 * raw, so a stack with one playback gateway and one shadow device read `4/5` and `6/7` while both
 * pages showed four and six. And worse than an off-by-one: the playback gateway is neither archived
 * nor pending, so it landed in the OFFLINE bucket and the summary reported a permanent fault on the
 * one row behaving exactly as designed.
 *
 * Extracted here rather than fixed in place so the rule has a name, a test, and one definition to
 * change if a third derived lane ever arrives.
 *
 * =================================================================================================
 * THE SHADOW FIGURE IS RETURNED, NOT DISCARDED
 *
 * A row the Gateways page has a toggle for should not vanish from the summary without trace. The
 * ribbon's question is "is everything up?", and "there is also a replay lane" belongs in an honest
 * answer to it -- so the count comes back for the caller to put in a tooltip, deliberately OUTSIDE
 * the four buckets. Folding it in would break the property the quarantine note protects: online,
 * pending, offline and archived are mutually exclusive and sum to `total`.
 */

/** The playback gateway (0060). One row per stack, seeded rather than created. */
export const isShadowGateway = (g) => !!(g && g.is_shadow)

/**
 * A shadow device (0060) -- a stand-in minted per device a capture recorded.
 *
 * `shadow_of` rather than a flag, matching the Devices page: the column is the ORIGINAL it stands
 * in for, so its presence is what makes the row a shadow. There is no `is_shadow` on devices.
 */
export const isShadowDevice = (d) => !!(d && d.shadow_of)

/**
 * Gateway buckets over the real fleet.
 *
 * AWAITING SETUP IS ITS OWN BUCKET AND OFFLINE EXCLUDES IT. A physical gateway sits in
 * PENDING_ENROLLMENT from creation until somebody carries its bundle to a machine. Counted as
 * offline, ordering four appliances on a Monday shows four faults on the overview.
 */
export function gatewayFleetCounts(gateways = []) {
  const real = gateways.filter((g) => !isShadowGateway(g))
  const live = real.filter((g) => !g.is_archived)
  return {
    total: real.length,
    // Only "online" while the heartbeat is fresh: an edge node that stops publishing never writes
    // an OFFLINE status, it just goes quiet.
    //
    // WRAPPED, NOT PASSED BY REFERENCE. `Array.prototype.filter` calls back with (element, index,
    // array) and `isGatewayOnline(gateway, now = Date.now())` takes the clock second -- so
    // `.filter(isGatewayOnline)` hands it the INDEX as the current time. Every gateway after the
    // first is then compared against a `now` of 1, 2, 3..., the staleness subtraction goes
    // negative, and a gateway that has not beaten in a week reports ONLINE. The point-free form
    // reads better and is wrong; the suite caught it on the sum-to-total assertion.
    online: live.filter((g) => isGatewayOnline(g)).length,
    pending: live.filter((g) => isGatewayPending(g)).length,
    offline: live.filter((g) => !isGatewayPending(g) && !isGatewayOnline(g)).length,
    archived: real.filter((g) => g.is_archived).length,
    shadow: gateways.filter((g) => isShadowGateway(g) && !g.is_archived).length
  }
}

/**
 * Device buckets over the real fleet.
 *
 * QUARANTINED IS ITS OWN BUCKET AND ONLINE/OFFLINE EXCLUDE IT. These used to overlap: a quarantined
 * device is stored with status OFFLINE, so one pending device was counted as "1 Offline" here AND
 * on a separate Pending Quarantine card -- the same device reported twice on one screen, with the
 * offline figure implying a fault where the real state was "waiting to be admitted".
 *
 * A MISSING `status` READS AS ONLINE, preserved from the original expression. A device row written
 * before its first birth has no status, and calling that a fault would report one on every device
 * between provisioning and its first message.
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
