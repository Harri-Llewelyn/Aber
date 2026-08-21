import { effectiveSparkplugId } from './sparkplugId';

/**
 * Matching a firing Grafana alert to the device it is about.
 *
 * EXTRACTED FROM DevicesTab RATHER THAN WRITTEN FRESH. That page has resolved alerts against
 * devices correctly for some time; issue #34 asks for the same treatment on Overview, Cells and
 * Gateways, and copying the logic to three more call sites is how four pages end up disagreeing
 * about which device an alert belongs to. The rules below are that implementation, moved.
 *
 * INDEXED ON BOTH IDENTIFIERS ON PURPOSE. `device_alerts` carries `sparkplug_id` -- the immutable
 * wire identity Grafana labels its series with -- and a `device_id` that the webhook resolves at
 * write time and which is nullable: an alert can arrive for an id no row matches, and
 * `ON DELETE SET NULL` clears it if the device is later purged. Matching on either means a rename
 * cannot lose the alert, and a device re-provisioned under a new UUID with the same wire id is
 * still found, which is exactly what a re-provision does.
 */

/** Severity ranking. A device with a critical AND a warning has a critical on it. */
const SEVERITY_RANK = { critical: 3, warning: 2, info: 1 };

/**
 * Index the active alerts by every identifier that can reach a device, worst severity winning.
 *
 * @param {Array} activeAlerts rows from `device_alerts_active` -- see hooks/useDeviceAlerts.
 * @returns {Map<string, object>} identifier -> the worst alert firing on it
 */
export function alertIndex(activeAlerts = []) {
  const worst = new Map();
  for (const alert of activeAlerts) {
    for (const key of [alert?.sparkplug_id, alert?.device_id]) {
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
