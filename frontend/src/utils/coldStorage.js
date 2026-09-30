/**
 * The cold telemetry catalogue, as the page needs it. The state is derived in SQL by
 * `cold_storage_rows()` (claimed, exported, verified, archived or failed, enforced by CHECK
 * constraints on the historian) and is not recomputed here. This file holds what each state means to a reader:
 * label, tone, and whether the rows are still in the hypertable. `archived` is the only state where
 * the raw rows are gone.
 */

export const COLD_STATES = {
  CLAIMED: 'claimed',
  EXPORTED: 'exported',
  VERIFIED: 'verified',
  ARCHIVED: 'archived',
  FAILED: 'failed',
}

const STATE_LABELS = {
  [COLD_STATES.CLAIMED]: 'Claimed',
  [COLD_STATES.EXPORTED]: 'Exported',
  [COLD_STATES.VERIFIED]: 'Verified',
  [COLD_STATES.ARCHIVED]: 'On cold storage',
  [COLD_STATES.FAILED]: 'Failed',
}

/**
 * What each state means for the data. Every entry says where the rows are, because that decides
 * whether anything needs doing.
 */
const STATE_MEANINGS = {
  [COLD_STATES.CLAIMED]:
    'Selected for export. The rows are still in the hypertable and nothing has been written yet.',
  [COLD_STATES.EXPORTED]:
    'Written to object storage but not yet read back. The rows are in BOTH places — the safest '
    + 'state in the sequence, and not one that needs acting on.',
  [COLD_STATES.VERIFIED]:
    'The object was downloaded and its row count matched. The rows are still in the hypertable; '
    + 'they are removed by `cold_archive --drop`, which is a separate step on purpose.',
  [COLD_STATES.ARCHIVED]:
    'The raw rows have been dropped. This object is the ONLY remaining copy of this span of '
    + 'telemetry.',
  [COLD_STATES.FAILED]:
    'An export attempt failed and the error is recorded. Nothing was dropped — a chunk cannot be '
    + 'removed unless its export was verified first.',
}

/**
 * Badge tone. `archived` is not a success colour: it is the only state where deleting the object
 * destroys history. `failed` is a warning, not an error: nothing was lost, an export needs
 * re-running.
 */
const STATE_TONES = {
  [COLD_STATES.CLAIMED]: 'neutral',
  [COLD_STATES.EXPORTED]: 'neutral',
  [COLD_STATES.VERIFIED]: 'ok',
  [COLD_STATES.ARCHIVED]: 'neutral',
  [COLD_STATES.FAILED]: 'warning',
}

export function coldStateLabel(state) {
  return STATE_LABELS[state] || state || 'Unknown'
}

export function coldStateMeaning(state) {
  return STATE_MEANINGS[state] || 'This state is not one the dashboard knows about.'
}

export function coldStateTone(state) {
  return STATE_TONES[state] || 'neutral'
}

/**
 * Bytes as something a person reads. Binary units, matching what `storage-init.mjs` sets the bucket
 * limits in and what Docker reports.
 */
export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '—'
  const n = Number(bytes)
  if (!Number.isFinite(n)) return '—'
  if (n < 1024) return `${n} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = n / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/**
 * The totals above the table. Rows and bytes count only what is archived; `verified` (awaiting
 * the drop) and `failed` are counted separately.
 */
export function coldStorageSummary(rows) {
  const list = rows || []
  const archived = list.filter(r => r.state === COLD_STATES.ARCHIVED)
  return {
    total: list.length,
    archived: archived.length,
    // Awaiting the drop: verified, so the export is sound, but the rows are still taking space.
    verified: list.filter(r => r.state === COLD_STATES.VERIFIED).length,
    failed: list.filter(r => r.state === COLD_STATES.FAILED).length,
    rows: archived.reduce((sum, r) => sum + Number(r.row_count || 0), 0),
    bytes: archived.reduce((sum, r) => sum + Number(r.object_bytes || 0), 0),
    // The oldest span still reachable at all. Useful precisely because it answers "how far back can
    // I go", which the hypertable alone can no longer tell you once anything has been dropped.
    oldest: list.reduce(
      (min, r) => (!min || (r.range_start && r.range_start < min) ? r.range_start : min),
      null,
    ),
  }
}

/**
 * Days past the tiering threshold before a backlog is worth acting on.
 *
 * UP TO ONE CHUNK INTERVAL IS NORMAL. Chunks are at most seven days (the chart's ceiling on
 * timescaledb.retention.chunkInterval) and one is not eligible for export until its whole span is
 * past the threshold, so a healthy site sits between zero and seven days behind. Fourteen is two of
 * those: beyond anything the ordinary cadence produces, and still two weeks before a historian
 * with retention off is short of disk.
 *
 * The same number is the Archive Backlog alert rule's threshold
 * (grafana/provisioning/alerting/alert-rules.yaml, `aber-archive-backlog`). A page that called a
 * backlog fine while the alert was firing would be the more convincing of the two, so
 * check-docs-drift.mjs holds them level.
 */
export const ARCHIVE_BACKLOG_TOLERANCE_DAYS = 14

/** Seconds of overdue as whole days, for display. */
export function overdueDays(seconds) {
  const n = Number(seconds)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.round((n / 86400) * 10) / 10
}

/**
 * `warning` once the backlog passes the tolerance, neutral below it.
 *
 * Never `success`: an archive that is up to date is the expected state, and colouring it green
 * would make the ordinary case shout as loudly as the one that needs somebody.
 */
export function backlogTone(seconds) {
  return overdueDays(seconds) > ARCHIVE_BACKLOG_TOLERANCE_DAYS ? 'warning' : 'neutral'
}

/**
 * The destination fields an Administrator sets, in the order the page asks for them.
 *
 * KEPT IN STEP WITH `unconfigured()` in ingestion/cold_archive.py BY HAND, and the labels are the
 * same words on purpose: the exporter's refusal ends up in a CronJob log, and an operator matching
 * that log against this page should not have to translate. Two languages, one list; a test asserts
 * the page's half and the migration seeds exactly these keys.
 */
const DESTINATION_FIELDS = [
  { key: 'archive.endpoint', label: 'S3 endpoint' },
  { key: 'archive.region', label: 'S3 region' },
  { key: 'archive.bucket', label: 'S3 bucket' },
  { key: 'archive.access_key_id', label: 'S3 access key ID' },
]

/**
 * What is still missing before anything can be exported, as labels.
 *
 * `siteKey` is included but is NOT set from the page: it is frozen at install because it is the
 * prefix every object is already addressed under. It appears here so an operator is told the whole
 * truth in one place rather than discovering the last field from a failed job.
 */
export function missingDestination({ values = {}, credentialSet = false, siteKey = '' } = {}) {
  const missing = DESTINATION_FIELDS
    .filter(f => !String(values[f.key] ?? '').trim())
    .map(f => f.label)
  if (!credentialSet) missing.push('the secret access key')
  if (!String(siteKey ?? '').trim()) missing.push('the site key (set at install)')
  return missing
}

/** `endpoint/bucket/site=key/`, or null when there is not enough to name one. */
export function destinationSummary({ endpoint = '', bucket = '', siteKey = '' } = {}) {
  if (!endpoint.trim() || !bucket.trim()) return null
  const base = `${endpoint.trim().replace(/\/+$/, '')}/${bucket.trim()}`
  return siteKey.trim() ? `${base}/site=${siteKey.trim()}/` : `${base}/`
}

/** A window in seconds as `14 days`, `12 hours` or `1 day`; whole days when it divides evenly. */
export function formatWindow(seconds) {
  const s = Number(seconds)
  if (!Number.isFinite(s) || s <= 0) return null
  const unit = s % 86400 === 0 ? ['day', 86400] : ['hour', 3600]
  const n = Math.round(s / unit[1])
  return `${n} ${unit[0]}${n === 1 ? '' : 's'}`
}

/**
 * The one sentence the page states about the raw window (`raw_telemetry_window()`, 0005), or null
 * when the historian could not say. `archiveEnabled` is the page's own setting; `archive_armed` is
 * what the archiver last reported to the historian, which is what the retention job obeys.
 */
export function rawWindowStatement(window, archiveEnabled) {
  if (!window) return null
  const kept = window.raw_window_seconds == null
    ? 'Raw telemetry is kept indefinitely.'
    : `Raw telemetry is kept for ${formatWindow(window.raw_window_seconds)}.`
  const older = window.raw_window_seconds == null
    ? ''
    : archiveEnabled
      ? ' Older readings are in the 1-minute, 5-minute and 1-hour rollups, and here on cold storage.'
      : ' Older readings are in the 1-minute, 5-minute and 1-hour rollups only.'
  // Switched on, and the archiver has not run since: the window still drops unexported chunks.
  const pending = archiveEnabled && !window.archive_armed && window.raw_window_seconds != null
    ? ' The archiver has not run since archiving was switched on; until it does, raw chunks '
      + 'past the window are dropped without being exported.'
    : ''
  return kept + older + pending
}
