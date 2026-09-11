/**
 * Provisioned-device staleness helpers. A manually added device defaults to OFFLINE whether idle or
 * overdue; `first_dbirth_at`, set once by ingestion on the real first birth, is the signal.
 * Client-side, like gatewayStatus.js.
 */

const PROVISIONING_OVERDUE_MS = 24 * 60 * 60 * 1000 // 24h

export function isProvisioningOverdue(device, now = Date.now()) {
  if (!device || device.is_quarantined || device.is_archived || device.first_dbirth_at) return false
  if (!device.created_at) return false
  const createdAt = new Date(device.created_at).getTime()
  if (Number.isNaN(createdAt)) return false
  return now - createdAt > PROVISIONING_OVERDUE_MS
}

/** Provisioned devices that have never received a DBIRTH, regardless of how long ago. */
export function isNeverSeen(device) {
  return !!device && !device.is_quarantined && !device.is_archived && !device.first_dbirth_at
}
