/**
 * Gateway heartbeat helpers. Ingestion stamps `gateways.last_heartbeat` on every node-level
 * message; a gateway that stops beating never gets an OFFLINE write, so freshness is derived on
 * read. Mirrors public.gateway_status, and scripts/check-mirror-drift.mjs asserts the threshold
 * matches. The PENDING states must agree with ensure_gateway_status_view() as well, which is not
 * machine-checked.
 */

// node_red_flow.json beats every 30s; allow three missed beats before calling it stale.
export const HEARTBEAT_STALE_MS = 90_000;

/**
 * The two states a remote gateway passes through before it has published: PENDING_ENROLLMENT (a
 * bundle issued, not redeemed) and AWAITING_BIRTH (enrolled and holding a credential, no NBIRTH
 * yet). Both are cleared by the first heartbeat, since process_node_message() writes `status`
 * unconditionally.
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

/** Human labels for the SCREAMING_SNAKE wire values. */
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
 * Status to display: the stored status, downgraded to STALE when the heartbeat has aged out. The
 * pending states short-circuit ahead of the staleness check: a re-enrolled gateway carries the old
 * heartbeat from its previous life and would otherwise render STALE while waiting for its first
 * message.
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
 * Whether this gateway wants an operator's attention. Not `live_status !== 'ONLINE'`: a gateway
 * waiting for its bundle to be carried to a machine is not a fault. Archived gateways are excluded.
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
 * Appliance health, reported by the gateway itself on the heartbeat. The columns are NULL on every
 * gateway that does not report them, so each helper returns null rather than a zero or a dash: a
 * zero disk figure and an unreported one must never render the same way.
 */

/**
 * The window the CA-expiry alert fires in. Mirrors `acs-gateway-ca-expiring` in
 * grafana/provisioning/alerting/alert-rules.yaml (`lt 30`); scripts/check-docs-drift.mjs asserts
 * the two agree.
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
 * The CA expiry as a person reads it, or null when unreported. Past is spelled out rather than
 * signed: an expired CA is the failure this column exists to catch.
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
 * Bytes at the precision an operator acts on, in binary units, because node_exporter counts in them
 * and `df -h` on the appliance agrees. Zero is a real reading; only null and undefined are absent.
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
 * Milliseconds until an enrolment token expires, or null. Negative is not clamped: the modal
 * distinguishes expires in 4 minutes from expired 20 minutes ago.
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
