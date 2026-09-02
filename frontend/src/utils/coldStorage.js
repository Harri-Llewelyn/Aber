/**
 * The cold telemetry catalogue, as the page needs it.
 *
 * =================================================================================================
 * THE STATE IS DERIVED IN SQL, NOT HERE, and this file deliberately does not recompute it.
 *
 * `cold_storage_rows()` (0068) returns a `state` column because the ordering it encodes --
 * claimed -> exported -> verified -> archived -- is enforced by CHECK constraints on the historian,
 * and a second implementation in JavaScript would be a fourth place that has to agree. What lives
 * here is what the STATE MEANS to a reader: its label, its tone, and the one sentence that says
 * whether the data is still in the hypertable.
 *
 * =================================================================================================
 * `archived` IS THE ONLY STATE WHERE THE RAW ROWS ARE GONE, and every other piece of copy on the
 * page exists to keep that distinction visible. The intermediate states are not failures and must
 * not read as them: a chunk that is `exported` but not yet `verified` has its data in BOTH places,
 * which is the safest state in the whole flow.
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
 * What each state means for the DATA, which is the question a reader actually has.
 *
 * Every one of these says where the rows are, because that is what decides whether anything needs
 * doing. "Verified" sounds finished and is not; "Failed" sounds like data loss and is the opposite.
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
 * Badge tone.
 *
 * `archived` IS NOT A SUCCESS COLOUR, and that is the one deliberate choice here. It is the normal
 * end state, but it is also the only one where deleting the object destroys history — so it reads
 * as a statement rather than as a tick. `failed` is a warning rather than an error for the reason
 * its meaning gives: nothing was lost, an export needs re-running.
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
 * Bytes as something a person reads.
 *
 * BINARY UNITS, matching what `storage-init.mjs` sets the bucket limits in and what Docker reports.
 * A page saying "1.1 GB" beside a bucket configured for 1073741824 invites the reader to work out
 * which of the two numbers is wrong.
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
 * The totals worth putting above the table.
 *
 * ROWS AND BYTES ARE COUNTED ONLY FOR WHAT IS ACTUALLY ARCHIVED. A total that included chunks still
 * sitting in the hypertable would answer no question: it is neither how much has been moved off the
 * operational database nor how much storage is in use. `pending` is counted separately because it
 * is the number that means "there is work outstanding".
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
