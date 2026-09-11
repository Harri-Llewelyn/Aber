/**
 * The cold telemetry catalogue, as the page needs it. The state is derived in SQL by
 * `cold_storage_rows()` (claimed, exported, verified, archived, enforced by CHECK constraints on
 * the historian) and is not recomputed here. This file holds what each state means to a reader:
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
 * The totals above the table. Rows and bytes count only what is archived; `pending` is counted
 * separately as the work outstanding.
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
