/**
 * Gateway heartbeat helpers.
 *
 * The ingestion daemon stamps `gateways.last_heartbeat` on every Sparkplug B node-level
 * message (NBIRTH / NDATA / NDEATH). A gateway that stops beating never gets an explicit
 * OFFLINE write -- it just goes quiet -- so freshness has to be derived on read.
 */

// node_red_flow.json beats every 30s; allow three missed beats before calling it stale.
export const HEARTBEAT_STALE_MS = 90_000;

export function isHeartbeatStale(lastHeartbeat, now = Date.now()) {
  if (!lastHeartbeat) return false;
  const ts = new Date(lastHeartbeat).getTime();
  if (Number.isNaN(ts)) return false;
  return now - ts > HEARTBEAT_STALE_MS;
}

/**
 * Status to display for a gateway: its stored status, downgraded to STALE when the
 * heartbeat has aged out. A gateway that has never reported keeps its stored status.
 */
export function gatewayLiveStatus(gateway, now = Date.now()) {
  const status = gateway?.status || 'OFFLINE';
  if (status === 'OFFLINE') return 'OFFLINE';
  if (!gateway?.last_heartbeat) return status;
  return isHeartbeatStale(gateway.last_heartbeat, now) ? 'STALE' : status;
}

export function isGatewayOnline(gateway, now = Date.now()) {
  return gatewayLiveStatus(gateway, now) === 'ONLINE';
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
