import { deviceIds } from './sparkplugId';
import { isAcknowledged } from './alertAcknowledgement';
import { isSuppressed } from './alertSuppression';

/**
 * Matching a firing alert to the device it is about, shared by the Site Map, Cells, Gateways and
 * Devices. Device-scoped alerts only, filtered on `entity_type`, so a gateway, platform or
 * machine-identity alert can never colour a device chip; the top bar's pill does not filter.
 * Indexed on both `sparkplug_id` (the issued id, which telemetry and so Grafana's series are keyed
 * on) and the nullable `entity_id`, so a rename or a re-provision under a new UUID does not lose
 * the alert.
 */

/** Severity ranking. A device with a critical AND a warning has a critical on it. */
const SEVERITY_RANK = { critical: 3, warning: 2, info: 1 };

/**
 * An unacknowledged alert outranks any acknowledged one, whatever their severities: a device with
 * one of each shows Alert firing, because something on it is still nobody's. A suppressed one ranks
 * below both, where an index holds it at all.
 */
const rank = (alert) =>
  (isSuppressed(alert) ? 0 : isAcknowledged(alert) ? 10 : 20) + (SEVERITY_RANK[alert?.severity] || 0);

/**
 * Index the active alerts by every identifier that can reach a device, the unacknowledged and then
 * the worst severity winning. A suppressed alert colours nothing, so it is left out, except for a
 * drawer's banner, which says it is suppressed (`suppressed: true`).
 *
 * @param {Array} activeAlerts rows from `platform_alerts_active`; see hooks/usePlatformAlerts.
 *
 * @param {string} entityType which kind of subject to index. Defaults to 'device'.
 *
 * @param {object} options `{ suppressed }`: whether suppressed alerts are indexed too, below the rest.
 *
 * @returns {Map<string, object>} identifier -> the alert that decides its state
 */
export function alertIndex(activeAlerts = [], entityType = 'device', { suppressed = false } = {}) {
  const worst = new Map();
  for (const alert of activeAlerts) {
    // A row without `entity_type` is a device alert: the webhook wrote nothing else before the
    // column existed.
    if ((alert?.entity_type ?? 'device') !== entityType) continue;
    if (!suppressed && isSuppressed(alert)) continue;
    for (const key of [alert?.sparkplug_id, alert?.entity_id]) {
      if (!key) continue;
      const held = worst.get(key);
      // `>` not `>=`, so the first alert of the same rank wins. The view orders by starts_at
      // descending, so that is the most recent one.
      if (!held || rank(alert) > rank(held)) {
        worst.set(key, alert);
      }
    }
  }
  return worst;
}

/**
 * The alert that decides `device`'s state, or null. Looks up the issued id and the row's UUID,
 * matching how the index is built, and the issued id's alert wins a tie. Never the published id: no
 * series is labelled with it.
 */
export function alertForDevice(index, device) {
  if (!index || !device) return null;
  const { issued } = deviceIds(device);
  const byIssued = (issued && index.get(issued)) || null;
  const byRow = (device.asset_id && index.get(device.asset_id)) || null;
  if (!byIssued || !byRow) return byIssued || byRow;
  return rank(byRow) > rank(byIssued) ? byRow : byIssued;
}

/**
 * The state an alert gives what it colours: 'alert' (Alert firing) while nobody has acknowledged
 * it, 'acknowledged' (Alert acknowledged) once somebody has, and null for no alert. A suppressed
 * alert is 'suppressed', which colours nothing: only a drawer's banner is handed one.
 */
export function alertState(alert) {
  if (!alert) return null;
  if (isSuppressed(alert)) return 'suppressed';
  return isAcknowledged(alert) ? 'acknowledged' : 'alert';
}
