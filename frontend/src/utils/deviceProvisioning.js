/**
 * Provisioned-device staleness helpers.
 *
 * A device created via the manual "add device" form has no way to distinguish "just fine,
 * sitting idle" from "was supposed to report in by now and hasn't" -- status defaults to
 * OFFLINE either way. first_dbirth_at (set once, by ingestion.py, on the device's real first
 * birth) is the signal; this mirrors gatewayStatus.js's client-side, no-backend-cron pattern.
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
