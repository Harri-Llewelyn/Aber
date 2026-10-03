const DAY_MS = 24 * 60 * 60 * 1000

/**
 * When the historian's backup sidecar takes its next backup, and which type, by its own rules
 * (physical_backup_missed_slot() and physical_backup_type() in timescaledb/physical_backup.sql;
 * check-mirror-drift.mjs runs this against them): the latest slot at hour_utc while nothing has
 * been attempted since it (due now), else the next; full on full_on's weekday, with no full yet, or
 * when the newest full is over seven days old by then. Null without a schedule, which the sidecar
 * records when it starts.
 */
export function nextHistorianBackup(historian, now = Date.now()) {
  if (!historian || historian.hour_utc == null) return null
  const d = new Date(now)
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), historian.hour_utc)
  const latest = today <= now ? today : today - DAY_MS
  const attempted = !!historian.last_attempt_at && new Date(historian.last_attempt_at).getTime() >= latest
  const at = attempted ? latest + DAY_MS : latest
  const lastFull = historian.last_full_at ? new Date(historian.last_full_at).getTime() : null
  const full = new Date(at).getUTCDay() === historian.full_on || lastFull === null ||
    lastFull < Math.max(at, now) - 7 * DAY_MS
  return { at, due: !attempted, kind: full ? 'full' : 'diff' }
}
