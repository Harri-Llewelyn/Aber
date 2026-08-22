import { effectiveSparkplugId } from './sparkplugId';

/**
 * Matching a firing Grafana alert to the device it is about.
 *
 * EXTRACTED FROM DevicesTab RATHER THAN WRITTEN FRESH. That page has resolved alerts against
 * devices correctly for some time; issue #34 asks for the same treatment on Overview, Cells and
 * Gateways, and copying the logic to three more call sites is how four pages end up disagreeing
 * about which device an alert belongs to. The rules below are that implementation, moved.
 *
 * DEVICE-SCOPED ALERTS ONLY, AND THAT FILTER IS THE POINT OF THIS PARAGRAPH. Since the platform alert rules landed
 * the same feed carries `gateway` and `platform` alerts, and the shopfloor map uses what this
 * returns to paint a device chip red. Without the filter a stale GATEWAY would redden nothing (its
 * wire id matches no device) right up until the day someone re-provisions an asset and the two id
 * spaces collide -- at which point a gateway fault would colour an unrelated machine, and the map
 * would be asserting something no rule said. Filtering on `entity_type` makes that impossible
 * rather than unlikely.
 *
 * The Topbar pill deliberately does NOT filter: a platform alert is exactly what an operator should
 * see there, and it is the one surface with room to say what the alert is about.
 *
 * INDEXED ON BOTH IDENTIFIERS ON PURPOSE. `platform_alerts` carries `sparkplug_id` -- the immutable
 * wire identity Grafana labels its series with -- and an `entity_id` that the webhook resolves at
 * write time and which is nullable: an alert can arrive for an id no row matches, and
 * there is deliberately no foreign key on it. Matching on either means a rename
 * cannot lose the alert, and a device re-provisioned under a new UUID with the same wire id is
 * still found, which is exactly what a re-provision does.
 */

/** Severity ranking. A device with a critical AND a warning has a critical on it. */
const SEVERITY_RANK = { critical: 3, warning: 2, info: 1 };

/**
 * Index the active alerts by every identifier that can reach a device, worst severity winning.
 *
 * @param {Array} activeAlerts rows from `platform_alerts_active` -- see hooks/usePlatformAlerts.
 * @param {string} entityType which kind of subject to index. Defaults to 'device'.
 * @returns {Map<string, object>} identifier -> the worst alert firing on it
 */
export function alertIndex(activeAlerts = [], entityType = 'device') {
  const worst = new Map();
  for (const alert of activeAlerts) {
    // `entity_type` is absent on a row written before 0023 was generalised, and every such row was
    // a device alert -- the webhook refused to write anything else. Defaulting keeps those legible
    // rather than silently dropping them from the map.
    if ((alert?.entity_type ?? 'device') !== entityType) continue;
    for (const key of [alert?.sparkplug_id, alert?.entity_id]) {
      if (!key) continue;
      const held = worst.get(key);
      // `>` not `>=`, so the FIRST alert of the worst severity wins rather than the last. The view
      // orders by starts_at descending, which makes that the most recent one -- and an operator
      // reading one summary should be reading the current one.
      if (!held || (SEVERITY_RANK[alert.severity] || 0) > (SEVERITY_RANK[held.severity] || 0)) {
        worst.set(key, alert);
      }
    }
  }
  return worst;
}

/**
 * The worst alert firing on `device`, or null.
 *
 * Tries the wire identity first and the row's UUID second, matching how the index is built. A
 * device with neither resolves to null rather than to whatever `undefined` happens to collide with.
 */
export function alertForDevice(index, device) {
  if (!index || !device) return null;
  const wireId = effectiveSparkplugId(device);
  return (wireId && index.get(wireId)) || (device.asset_id && index.get(device.asset_id)) || null;
}
