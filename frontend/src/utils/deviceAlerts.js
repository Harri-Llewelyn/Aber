import { effectiveSparkplugId } from './sparkplugId';

/**
 * Matching a firing Grafana alert to the device it is about, shared by the Site Map, Cells,
 * Gateways and Devices. Device-scoped alerts only, filtered on `entity_type`, so a gateway or
 * platform alert can never colour a device chip; the top bar's pill does not filter. Indexed on
 * both `sparkplug_id` (the wire identity Grafana labels series with) and the nullable `entity_id`,
 * so a rename or a re-provision under a new UUID does not lose the alert.
 */

/** Severity ranking. A device with a critical AND a warning has a critical on it. */
const SEVERITY_RANK = { critical: 3, warning: 2, info: 1 };

/**
 * Index the active alerts by every identifier that can reach a device, worst severity winning.
 *
 * @param {Array} activeAlerts rows from `platform_alerts_active`; see hooks/usePlatformAlerts.
 *
 * @param {string} entityType which kind of subject to index. Defaults to 'device'.
 *
 * @returns {Map<string, object>} identifier -> the worst alert firing on it
 */
export function alertIndex(activeAlerts = [], entityType = 'device') {
  const worst = new Map();
  for (const alert of activeAlerts) {
    // A row without `entity_type` is a device alert: the webhook wrote nothing else before the
    // column existed.
    if ((alert?.entity_type ?? 'device') !== entityType) continue;
    for (const key of [alert?.sparkplug_id, alert?.entity_id]) {
      if (!key) continue;
      const held = worst.get(key);
      // `>` not `>=`, so the first alert of the worst severity wins. The view orders by starts_at
      // descending, so that is the most recent one.
      if (!held || (SEVERITY_RANK[alert.severity] || 0) > (SEVERITY_RANK[held.severity] || 0)) {
        worst.set(key, alert);
      }
    }
  }
  return worst;
}

/**
 * The worst alert firing on `device`, or null. Tries the wire identity first and the row's UUID
 * second, matching how the index is built.
 */
export function alertForDevice(index, device) {
  if (!index || !device) return null;
  const wireId = effectiveSparkplugId(device);
  return (wireId && index.get(wireId)) || (device.asset_id && index.get(device.asset_id)) || null;
}
