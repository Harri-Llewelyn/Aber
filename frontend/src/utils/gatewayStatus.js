/**
 * Gateway heartbeat helpers.
 *
 * The ingestion daemon stamps `gateways.last_heartbeat` on every Sparkplug B node-level
 * message (NBIRTH / NDATA / NDEATH). A gateway that stops beating never gets an explicit
 * OFFLINE write -- it just goes quiet -- so freshness has to be derived on read.
 *
 * MIRRORS public.gateway_status, and scripts/check-mirror-drift.mjs asserts the threshold matches.
 * The two must agree on the PENDING states as well; that is not machine-checked, so it is stated
 * here and in ensure_gateway_status_view() in identical terms.
 */

// node_red_flow.json beats every 30s; allow three missed beats before calling it stale.
export const HEARTBEAT_STALE_MS = 90_000;

/**
 * The two states a REMOTE gateway passes through before it has ever published.
 *
 *   PENDING_ENROLLMENT  a bundle has been issued; the appliance has not redeemed it yet
 *   AWAITING_BIRTH      the appliance enrolled and holds a credential; no NBIRTH yet
 *
 * Both are written by the enrolment path (migration 0025), and both are cleared by the first
 * heartbeat -- process_node_message() writes `status` unconditionally, so the transition to ONLINE
 * needs no code anywhere.
 */
export const GATEWAY_STATUS_PENDING_ENROLMENT = 'PENDING_ENROLLMENT';
export const GATEWAY_STATUS_AWAITING_BIRTH = 'AWAITING_BIRTH';

const PENDING_STATUSES = new Set([
  GATEWAY_STATUS_PENDING_ENROLMENT,
  GATEWAY_STATUS_AWAITING_BIRTH,
]);

/** Is this gateway mid-enrolment rather than in service or in trouble? */
export function isGatewayPending(gateway) {
  return PENDING_STATUSES.has(gateway?.status);
}

/**
 * Human labels. The raw values are SCREAMING_SNAKE because they are on the wire and in the
 * database; neither belongs in a badge a shopfloor manager reads.
 */
export const GATEWAY_STATUS_LABELS = {
  [GATEWAY_STATUS_PENDING_ENROLMENT]: 'AWAITING SETUP',
  [GATEWAY_STATUS_AWAITING_BIRTH]: 'ENROLLED — NO DATA YET',
  OFFLINE: 'OFFLINE / DDEATH',
};

export function isHeartbeatStale(lastHeartbeat, now = Date.now()) {
  if (!lastHeartbeat) return false;
  const ts = new Date(lastHeartbeat).getTime();
  if (Number.isNaN(ts)) return false;
  return now - ts > HEARTBEAT_STALE_MS;
}

/**
 * Status to display for a gateway: its stored status, downgraded to STALE when the
 * heartbeat has aged out. A gateway that has never reported keeps its stored status.
 *
 * THE PENDING STATES SHORT-CIRCUIT AHEAD OF THE STALENESS CHECK, and that ordering is the whole
 * point of this function existing rather than reading `status` directly.
 *
 * A gateway in PENDING_ENROLLMENT survives without it by luck: it has never beaten, so
 * `last_heartbeat` is NULL and the staleness arm is skipped. AWAITING_BIRTH does not. A gateway
 * being RE-ENROLLED -- new appliance, replaced hardware, a rotated credential -- carries the OLD
 * heartbeat from its previous life, which is minutes or months stale, so it would render STALE
 * while the truth is that it is waiting for its first message. That reads as a fault on a gateway
 * nobody has finished installing yet.
 */
export function gatewayLiveStatus(gateway, now = Date.now()) {
  const status = gateway?.status || 'OFFLINE';
  if (PENDING_STATUSES.has(status)) return status;
  if (status === 'OFFLINE') return 'OFFLINE';
  if (!gateway?.last_heartbeat) return status;
  return isHeartbeatStale(gateway.last_heartbeat, now) ? 'STALE' : status;
}

export function isGatewayOnline(gateway, now = Date.now()) {
  return gatewayLiveStatus(gateway, now) === 'ONLINE';
}

/**
 * Does this gateway want an operator's attention?
 *
 * NOT SIMPLY `live_status !== 'ONLINE'`, which is what the Cells page asked before the enrolment
 * states existed. A gateway created ten seconds ago and waiting for its bundle to be carried to a
 * machine is not a fault -- and treating it as one turns the whole Cells page amber the moment
 * somebody provisions a few appliances, which is exactly when the attention signal needs to still
 * mean something.
 *
 * An ARCHIVED gateway is also excluded: it is decommissioned on purpose and the pages that show it
 * label it as such.
 */
export function gatewayNeedsAttention(gateway, now = Date.now()) {
  if (!gateway || gateway.is_archived) return false;
  if (isGatewayPending(gateway)) return false;
  return gatewayLiveStatus(gateway, now) !== 'ONLINE';
}

/** Relative age of a heartbeat, e.g. "12s ago". */
export function formatHeartbeat(lastHeartbeat, now = Date.now()) {
  if (!lastHeartbeat) return 'Never';
  const ts = new Date(lastHeartbeat).getTime();
  if (Number.isNaN(ts)) return 'Never';

  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(ts).toLocaleString();
}

/**
 * APPLIANCE HEALTH, reported by the gateway itself on the heartbeat (migration 0035).
 *
 * These read columns that are NULL on every gateway that does not report them -- a virtual one, and
 * any appliance on a bundle predating that migration -- so each helper returns null rather than a
 * zero or a dash, and the caller decides how to say "not reported". A zero disk figure and an
 * unreported one must never render the same way.
 */

/**
 * The window the CA-expiry alert fires in.
 *
 * MIRRORS `acs-gateway-ca-expiring` in grafana/provisioning/alerting/alert-rules.yaml, whose
 * threshold is `lt 30`, and scripts/check-docs-drift.mjs asserts the two agree. They are one
 * decision -- long enough to schedule a fleet-wide trust-store update through a plant's change
 * process -- and a UI that warned on a different horizon from the alert would send an operator
 * looking for a rule that had not fired.
 */
export const CERT_EXPIRY_WARN_DAYS = 30;

/** Days until the reported CA expires. Negative once it has. Null when nothing was reported. */
export function certExpiryDays(certExpiresAt, now = Date.now()) {
  if (!certExpiresAt) return null;
  const ts = new Date(certExpiresAt).getTime();
  if (Number.isNaN(ts)) return null;
  return (ts - now) / 86_400_000;
}

/**
 * The CA expiry as a person reads it, or null when the appliance has not reported one.
 *
 * PAST IS SPELLED OUT RATHER THAN SIGNED. "in -3 days" is a number an operator has to decode at
 * exactly the moment they are least inclined to; an expired CA is the whole failure this column
 * exists to catch, so it says so.
 */
export function formatCertExpiry(certExpiresAt, now = Date.now()) {
  const days = certExpiryDays(certExpiresAt, now);
  if (days === null) return null;
  if (days < 0) return `EXPIRED ${Math.abs(Math.round(days))}d ago`;
  if (days < 1) return 'expires today';
  return `in ${Math.round(days)}d`;
}

/** True when the reported CA is inside the alert's window, or already gone. */
export function isCertExpiring(certExpiresAt, now = Date.now()) {
  const days = certExpiryDays(certExpiresAt, now);
  return days !== null && days < CERT_EXPIRY_WARN_DAYS;
}

/**
 * Bytes, at the precision an operator acts on.
 *
 * BINARY UNITS, because these come from node_exporter reading /proc, which counts in them -- and
 * because a disk figure that disagrees with what `df -h` on the appliance says is worse than no
 * figure at all. Zero is a real reading and formats as "0 B"; only null and undefined are absent.
 */
export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(Number(bytes))) return null;
  const n = Number(bytes);
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let value = Math.abs(n);
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  const rendered = i === 0 ? value : value.toFixed(value < 10 ? 1 : 0);
  return `${n < 0 ? '-' : ''}${rendered} ${units[i]}`;
}

/**
 * Milliseconds until an enrolment token expires, or null when there is nothing to count down.
 *
 * Negative is NOT clamped to zero: the modal distinguishes "expires in 4 minutes" from "expired 20
 * minutes ago", and a caller that only wants the former can clamp it itself.
 */
export function tokenTimeRemaining(expiresAt, now = Date.now()) {
  if (!expiresAt) return null;
  const ts = new Date(expiresAt).getTime();
  if (Number.isNaN(ts)) return null;
  return ts - now;
}

/** `mm:ss` for a countdown, or `Expired`. */
export function formatCountdown(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms <= 0) return 'Expired';
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
