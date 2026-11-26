import { deviceIds, gatewaySparkplugId } from './sparkplugId';
import { isAcknowledged } from './alertAcknowledgement';
import { isSuppressed } from './alertSuppression';
import { severityRank } from './tableSort';

/**
 * Matching a firing alert to the device or gateway it is about, shared by the Site Map, Cells,
 * Gateways and Devices. An index holds one kind of subject, filtered on `entity_type`, so a gateway,
 * platform or machine-identity alert can never colour a device chip, nor a device's a gateway row;
 * the top bar's pill does not filter. Indexed on both `sparkplug_id` (the issued id, which telemetry
 * and so Grafana's series are keyed on) and the nullable `entity_id`, so a rename or a re-provision
 * under a new UUID does not lose the alert.
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
  return worstAlert(issued && index.get(issued), device.asset_id && index.get(device.asset_id));
}

/**
 * The alert that decides `gateway`'s state, or null, from an index of gateway alerts
 * (`alertIndex(alerts, 'gateway')`). Looks up its Sparkplug edge node id and its row's UUID, and
 * the edge node id's alert wins a tie, as a device's issued id does.
 */
export function alertForGateway(index, gateway) {
  if (!index || !gateway) return null;
  const node = gateway.sparkplug_id || gatewaySparkplugId(gateway.gateway_id);
  return worstAlert(node && index.get(node), gateway.gateway_id && index.get(gateway.gateway_id));
}

/** The worst of `alerts` by the rank an index keeps, or null; the first wins a tie. Empty ones are skipped. */
export function worstAlert(...alerts) {
  return alerts.reduce((worst, alert) => (alert && (!worst || rank(alert) > rank(worst)) ? alert : worst), null);
}

// A status column's sort bands: a firing alert, then an acknowledged one, then the subject's own
// state. Each band holds the severity ranks of utils/tableSort.js, which run 0 to 8.
const SORT_BAND_ACKNOWLEDGED = 10;
const SORT_BAND_STATE = 20;

/**
 * A status column's value for a `rank` sort, as the Devices and Gateways tables sort: a firing alert
 * first, the worst severity first, then an acknowledged one, then `stateTone`, the Badge tone of the
 * subject's own status. A suppressed alert is no alert.
 */
export function statusSortRank(alert, stateTone) {
  if (!alert || isSuppressed(alert)) return SORT_BAND_STATE + severityRank(stateTone);
  const severity = severityRank(alert.severity === 'critical' ? 'danger' : 'warning');
  return (isAcknowledged(alert) ? SORT_BAND_ACKNOWLEDGED : 0) + severity;
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
