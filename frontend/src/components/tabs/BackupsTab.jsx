import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import { api } from '../../api'
import { usePolling } from '../../hooks/usePolling'
import { usePendingAction, usePendingKey } from '../../hooks/usePendingAction'
import { ActionButton } from '../common/ActionButton'
import { ConfirmModal } from '../modals/ConfirmModal'
import { Badge } from '../common/Badge'
import { ClearFilters } from '../common/ClearFilters'
import { EmptyState } from '../common/EmptyState'
import { ListFoot } from '../common/ListFoot'
import { LoadingState } from '../common/LoadingState'
import { TakeBackupModal } from '../modals/TakeBackupModal'
import { BackupDestinationModal } from '../modals/BackupDestinationModal'
import { CardHeading } from '../common/CardHeading'
import { ContextPanel, rowSelectHandler } from '../common/ContextPanel'
import { IconAlertTriangle, IconChevronRight, IconDatabase, IconHardDrive, IconShieldAlert, IconX } from '../common/Icons'
import { formatBytes, formatDateTime, formatRelative, NO_VALUE } from '../../utils/format'
import { readFlag, readSetting } from '../../config'

/**
 * How old the last successful backup may be before the page says backups have stopped: the nightly
 * default schedule plus half a day. The page cannot read the service's schedule, so a sparser one
 * needs this changed. check-docs-drift.mjs holds it equal to the Backup Stale alert rule.
 */
export const BACKUP_STALE_HOURS = 36

/**
 * How many of the newest backups the retention prune never removes, whatever their age.
 * check-docs-drift.mjs holds it equal to the floor in backup_prunable().
 */
const BACKUP_RETENTION_FLOOR = 3

/** The selection that opens the historian's panel rather than a run's. */
const HISTORIAN = 'historian'

/** Runs per page of the list; the list foot adds another page. */
const PAGE_SIZE = 30

/**
 * The list's filter. A cancelled run is listed under All only: it neither failed nor completed.
 * `empty` is what the list says when the filter matches nothing.
 */
const FILTERS = {
  all: { label: 'All runs', statuses: ['COMPLETED', 'FAILED', 'CANCELLED'] },
  completed: { label: 'Completed', statuses: ['COMPLETED'], empty: 'No run has completed yet.' },
  failed: { label: 'Failed', statuses: ['FAILED'], empty: 'No run has failed.' }
}

/**
 * Backups without a shell.
 *
 * Nothing on this page takes a backup: a browser cannot run pg_dump, so the page queues a row
 * and the backup service does the work, with the result arriving on the next poll. The list is
 * every finished run (`backup_jobs`), with the backup a completed one produced while it still
 * exists; the bytes never come here, and restore is a runbook. Administrator only, as the RLS and
 * every RPC are; App re-checks the role before rendering this.
 */
export function BackupsTab({ showToast }) {
  const [runs, setRuns] = useState([])
  const [total, setTotal] = useState(0)
  const [summary, setSummary] = useState(null)
  const [activeJob, setActiveJob] = useState(null)
  const [filter, setFilter] = useState('all')
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [loading, setLoading] = useState(true)
  const [paging, setPaging] = useState(false)
  const [error, setError] = useState(null)
  const [asking, setAsking] = useState(false)
  const [releaseFor, setReleaseFor] = useState(null)
  const [floorIds, setFloorIds] = useState(() => new Set())
  const [offsite, setOffsite] = useState(null)
  const [editingDestination, setEditingDestination] = useState(false)
  const [selectedId, setSelectedId] = useState(null)
  // The historian's own backup: undefined while physical backup is off or not yet read, null when
  // the historian cannot be read.
  const [historian, setHistorian] = useState(undefined)
  const historianOn = readFlag('VITE_HISTORIAN_PHYSICAL_BACKUP')
  const lastCall = useRef(0)

  const [cancelPending, runCancel] = usePendingAction()
  const [pendingKey, runKeyed] = usePendingKey()

  const refresh = useCallback(async () => {
    const call = ++lastCall.current
    const [page, active, sum, floor, destination, historianRow] = await Promise.all([
      api.listBackupRuns({ statuses: FILTERS[filter].statuses, limit }),
      api.activeBackupJob(),
      api.backupRunSummary(),
      // Soft: without it the Retention cells cannot say a backup is kept as one of the newest.
      api.newestBackupIds(BACKUP_RETENTION_FLOOR).catch(() => []),
      // Soft too: the list is worth showing without it, and the destination button is then left out.
      api.backupOffsiteDestination().catch(() => null),
      // A read that fails is reported the way an unreachable historian is: it cannot be read.
      historianOn ? api.historianBackupState().catch(() => null) : undefined
    ])
    // A response for an earlier filter or page size that lands after a later one is dropped.
    if (call !== lastCall.current) return
    setRuns(page.runs)
    setTotal(page.total)
    setActiveJob(active)
    setSummary(sum)
    setFloorIds(new Set(floor))
    setOffsite(destination)
    setHistorian(historianRow)
    setError(null)
  }, [filter, limit, historianOn])

  useEffect(() => {
    let cancelled = false
    refresh()
      .catch(err => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) { setLoading(false); setPaging(false) } })
    return () => { cancelled = true }
  }, [refresh])

  // A poll, not Realtime: a backup takes minutes and its row changes twice. Faster while one is
  // in flight so the card settles when the service finishes.
  usePolling(refresh, activeJob || historianRequest(historian)?.inFlight ? 5000 : 30000, !loading)

  // The dialog shows a refusal itself, so a throw here stays in it: the gate names the backup in
  // the way, and a toast would vanish before the sentence was read.
  const onRequest = async ({ note }) => {
    await api.requestBackup(note)
    setAsking(false)
    showToast('Backup queued. The service will take it shortly.', 'success')
    await refresh()
  }

  const onCancel = () => runCancel(async () => {
    try {
      const cancelled = await api.cancelBackupJob(activeJob.id)
      showToast(cancelled ? 'Backup cancelled.' : 'The service had already claimed it; it will finish or fail.', cancelled ? 'success' : 'info')
      await refresh()
    } catch (err) {
      showToast(err.message, 'error')
    }
  })

  const onRelease = async () => {
    const backup = releaseFor
    setReleaseFor(null)
    await runKeyed(backup.id, async () => {
      try {
        const released = await api.releaseBackup(backup.id)
        showToast(released ? `Released the backup from ${formatDateTime(backup.taken_at)}. The retention window now applies.` : 'That backup was not pinned.', released ? 'success' : 'info')
        await refresh()
      } catch (err) {
        showToast(err.message, 'error')
      }
    })
  }

  const onSaveDestination = async ({ values, secret }) => {
    await api.setBackupOffsiteDestination(Object.fromEntries(
      Object.entries(values).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v])
    ))
    if (secret) await api.setBackupOffsiteCredential(secret)
    setEditingDestination(false)
    showToast('Off-site destination saved. The service copies each backup on its next polls.', 'success')
    await refresh()
  }

  const onRemoveDestination = async () => {
    await api.clearBackupOffsiteDestination()
    setEditingDestination(false)
    showToast('Off-site destination removed. Copies already made stay in the bucket.', 'info')
    await refresh()
  }

  const onFilter = (value) => {
    setFilter(value)
    setLimit(PAGE_SIZE)
  }

  // No job row at all is a stack that has never run the backup service: the empty state, no warning.
  const neverRun = !summary?.firstRecordedAt
  const retentionDays = configuredRetentionDays()
  const selected = runs.find(r => r.id === selectedId) || null
  const toggleRun = (id) => setSelectedId(current => current === id ? null : id)

  return (
    <div className="page-layout page-fill">
      <div className="page-main">
        <div className="card card-fill">
          <CardHeading
            icon={<IconHardDrive size={15} />}
            title="Backups"
            description="Every backup run, newest first, and why any failed. Scheduled backups follow the retention window; requested ones are kept until released."
            actions={(
              <div className="btn-group">
                <DestinationButton destination={offsite} onEdit={() => setEditingDestination(true)} />
                {/* The primary action in the header, where every card keeps its. Disabled rather
                    than hidden while one is in flight: the gate refuses a second anyway, and the
                    callout below says why. */}
                <button
                  className="btn btn-primary btn-sm"
                  disabled={!!activeJob}
                  onClick={() => setAsking(true)}
                  title={activeJob ? 'One backup runs at a time' : 'Queue a backup of the whole stack now'}
                >
                  <IconHardDrive size={14} /> Take a backup
                </button>
              </div>
            )}
          />

          <div className="card-body stack">
            {error && (
              <div className="callout callout-danger">
                <IconShieldAlert size={14} className="callout-icon" />
                <div>{error}</div>
              </div>
            )}

            <RunningCard job={activeJob} onCancel={onCancel} cancelPending={cancelPending} historianOn={historianOn} />
            <CurrentState summary={summary} />
            {historianOn && historian !== undefined && (
              <>
                <HistorianState historian={historian} />
                {historian && (
                  <HistorianRow historian={historian} selected={selectedId === HISTORIAN} onSelect={() => toggleRun(HISTORIAN)} />
                )}
              </>
            )}

            {!loading && !neverRun && (
              <div className="filter-bar">
                <select
                  className="form-control control-sm"
                  value={filter}
                  onChange={e => onFilter(e.target.value)}
                  aria-label="Run status filter"
                  title="Show every run, or only the ones that completed or failed"
                >
                  {Object.entries(FILTERS).map(([id, f]) => <option key={id} value={id}>{f.label}</option>)}
                </select>
                <ClearFilters count={filter === 'all' ? 0 : 1} onClear={() => onFilter('all')} />
              </div>
            )}
          </div>

          {loading ? (
            <LoadingState label="backups" />
          ) : neverRun ? (
            <EmptyState message="No backups yet.">
              <p className="form-hint">Take one with the button above, or wait for the schedule.</p>
            </EmptyState>
          ) : runs.length === 0 ? (
            <EmptyState
              message="No backups yet."
              filtered={filter !== 'all'}
              filteredMessage={FILTERS[filter].empty}
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th title="When the backup was taken, or when a run without one ended. Open a run for its queued, started and finished times.">When</th>
                    <th title="How the run ended, with the reason when it failed or was withdrawn">Status</th>
                    <th title="Whether a person asked for the run or the schedule started it">Origin</th>
                    <th title="The note kept with the backup, saying why it was taken">Note</th>
                    <th title="The size of every file in the backup together">Size</th>
                    <th title="The components the backup holds. Open a run for each file and its size.">Holds</th>
                    <th title="Why the backup is still kept, or that the retention window applies">Retention</th>
                    <th title="Whether the encrypted copy has reached the off-site bucket">Off site</th>
                    <th className="row-actions" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {runs.map(run => (
                    <RunRow
                      key={run.id}
                      run={run}
                      inFloor={!!run.backup && floorIds.has(run.backup.id)}
                      offsiteBase={offsiteBase(offsite)}
                      retentionDays={retentionDays}
                      releasing={pendingKey === run.backup?.id}
                      onRelease={setReleaseFor}
                      selected={run.id === selectedId}
                      onSelect={() => toggleRun(run.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {!loading && !neverRun && (
            <ListFoot
              shown={runs.length}
              total={total}
              step={PAGE_SIZE}
              pending={paging}
              counted
              onMore={() => { setPaging(true); setLimit(l => l + PAGE_SIZE) }}
            />
          )}
        </div>
      </div>

      <RunPanel
        run={selected}
        offsiteBase={offsiteBase(offsite)}
        retentionDays={retentionDays}
        inFloor={!!selected?.backup && floorIds.has(selected.backup.id)}
        releasing={pendingKey === selected?.backup?.id}
        onRelease={setReleaseFor}
        onClose={() => setSelectedId(null)}
        showToast={showToast}
      />

      {historianOn && (
        <HistorianPanel
          historian={selectedId === HISTORIAN ? historian : null}
          onClose={() => setSelectedId(null)}
          showToast={showToast}
        />
      )}

      {editingDestination && (
        <BackupDestinationModal
          destination={offsite}
          credentialSet={!!offsite?.credentialSet}
          onSave={onSaveDestination}
          onRemove={onRemoveDestination}
          onClose={() => setEditingDestination(false)}
        />
      )}

      {asking && (
        <TakeBackupModal holds={takeBackupHolds(historianOn)} onConfirm={onRequest} onCancel={() => setAsking(false)} />
      )}

      {releaseFor && (
        <ConfirmModal
          title="Release backup"
          icon={<IconHardDrive size={18} />}
          message={`Release the backup from ${formatDateTime(releaseFor.taken_at)}${releaseFor.note ? ` (${releaseFor.note})` : ''}? Nothing is deleted now: the service prunes it once it is older than the retention window and not one of the newest ${floorWord}.`}
          confirmLabel="Release"
          pendingLabel="Releasing…"
          confirmClassName="btn btn-primary"
          onConfirm={onRelease}
          onCancel={() => setReleaseFor(null)}
        />
      )}
    </div>
  )
}

/**
 * The page's one statement about now, or null. A failure stands until a backup succeeds after it.
 * A last success older than BACKUP_STALE_HOURS (before the first success, the first job recorded)
 * covers a service that is not running, which records no failure. Same clock as the view the
 * Backup Stale rule reads (0144).
 */
function backupState(summary, now = Date.now()) {
  if (!summary?.firstRecordedAt) return null
  const lastGoodAt = summary.lastSuccess?.started_at || null
  if (summary.latestOutcome?.status === 'FAILED') return { kind: 'failed', lastGoodAt }
  const clock = new Date(lastGoodAt || summary.firstRecordedAt).getTime()
  if (now - clock > BACKUP_STALE_HOURS * 60 * 60 * 1000) return { kind: 'stale', lastGoodAt }
  return null
}

function CurrentState({ summary }) {
  const state = backupState(summary)
  if (!state) return null
  const failed = state.kind === 'failed'
  const lastGood = state.lastGoodAt
    ? `The last good backup was taken ${formatDateTime(state.lastGoodAt)}.`
    : failed
      ? 'No backup has succeeded yet.'
      : `None has succeeded since the first was queued ${formatDateTime(summary.firstRecordedAt)}.`

  return (
    <div
      className={failed ? 'callout callout-danger' : 'callout callout-warning'}
      role="status"
      data-testid="backup-state"
    >
      {failed
        ? <IconShieldAlert size={14} className="callout-icon" />
        : <IconAlertTriangle size={14} className="callout-icon" />}
      <div>
        <strong>{failed ? 'The last backup failed' : `No backup has succeeded in ${BACKUP_STALE_HOURS} hours`}</strong>
        {failed ? ', and none has succeeded since. ' : '. '}
        {lastGood}
        {failed
          ? ' The failed run below gives the reason.'
          : ' If nothing is queued or running, the backup service is probably not running.'}
      </div>
    </div>
  )
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const KIND_WORDS = { full: 'full', diff: 'differential', incr: 'incremental' }
const kindWord = (kind) => KIND_WORDS[kind] || kind

/**
 * The historian's one statement about now, or null: the platform line's rule on the clock
 * Historian Backup Stale reads. A failure (the read returns one only while it is newer than the
 * last success) stands until a backup succeeds; otherwise stale when the last success, or before
 * the first the first recorded run, is older than BACKUP_STALE_HOURS. Null in is unreachable.
 */
export function historianState(historian, now = Date.now()) {
  if (historian === null) return { kind: 'unreachable' }
  if (!historian) return null
  if (historian.last_failure_at) return { kind: 'failed' }
  const clock = historian.last_success_at || historian.first_recorded_at
  if (clock && now - new Date(clock).getTime() > BACKUP_STALE_HOURS * HOUR_MS) return { kind: 'stale' }
  return null
}

/**
 * When the sidecar takes its next backup, and which type, by its own rules
 * (physical_backup_missed_slot() and physical_backup_type() in timescaledb/physical_backup.sql):
 * the latest slot at hour_utc while nothing has been attempted since it (due now), else the next;
 * full on full_on's weekday or when the newest full is over seven days old by then. Null without
 * a schedule, which the sidecar records when it starts.
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

/**
 * The latest backup asked for from this page, while it is worth saying: waiting for the sidecar,
 * being taken, or how it ended within the last day. The sidecar looks once a minute, so one waiting
 * for minutes means its container is not running.
 */
export function historianRequest(historian, now = Date.now()) {
  if (!historian?.request_at) return null
  if (!historian.request_claimed_at) {
    return now - new Date(historian.request_at).getTime() > 3 * 60 * 1000
      ? { inFlight: true, tone: 'warning', label: 'Requested: not picked up', title: 'The backup sidecar looks for a request once a minute, so one waiting longer means its container is not running.' }
      : { inFlight: true, tone: 'info', label: 'Requested: queued', title: `Asked for ${formatDateTime(historian.request_at)}. The backup sidecar takes it within a minute.` }
  }
  if (!historian.request_finished_at) {
    return { inFlight: true, tone: 'info', label: 'Requested: being taken', title: `The backup sidecar started it ${formatDateTime(historian.request_claimed_at)}.` }
  }
  if (now - new Date(historian.request_finished_at).getTime() > DAY_MS) return null
  return historian.request_succeeded
    ? { inFlight: false, tone: 'success', label: 'Requested: taken', title: `Finished ${formatDateTime(historian.request_finished_at)}.` }
    : { inFlight: false, tone: 'danger', label: 'Requested: failed', title: `Failed ${formatDateTime(historian.request_finished_at)}. The historian's panel gives pgBackRest's reason.` }
}

/** The historian's line above the list: only when its backup is not working, or cannot be read. */
function HistorianState({ historian }) {
  const state = historianState(historian)
  if (!state) return null
  if (state.kind === 'unreachable') {
    return (
      <div className="callout callout-warning" role="status" data-testid="historian-state">
        <IconAlertTriangle size={14} className="callout-icon" />
        <div>
          <strong>The historian cannot be read</strong>, so this page cannot say whether its own backup is
          working. Its database did not answer: the timescaledb pod is probably down or restarting.
        </div>
      </div>
    )
  }
  const failed = state.kind === 'failed'
  const lastGood = historian.last_success_at
    ? `The last good one finished ${formatDateTime(historian.last_success_at)}.`
    : failed
      ? 'None has succeeded yet.'
      : `None has succeeded since backup was switched on ${formatDateTime(historian.first_recorded_at)}.`
  const reason = historian.last_failure_detail || 'pgBackRest recorded no reason.'
  return (
    <div className={failed ? 'callout callout-danger' : 'callout callout-warning'} role="status" data-testid="historian-state">
      {failed
        ? <IconShieldAlert size={14} className="callout-icon" />
        : <IconAlertTriangle size={14} className="callout-icon" />}
      <div className="backup-historian-state">
        <strong>{failed ? "The historian's last backup failed" : `No historian backup has succeeded in ${BACKUP_STALE_HOURS} hours`}</strong>
        {failed ? ` ${formatRelative(historian.last_failure_at)}, and none has succeeded since. ` : '. '}
        {lastGood}
        {failed
          ? <div className="truncate" title={reason}>{reason}</div>
          : ' Take a backup asks for one; if its request is not picked up, the backup sidecar is not running.'}
      </div>
    </div>
  )
}

/**
 * The historian's own backup as one line: the last success with its type and label, when the next
 * is due, the repository's size and a request from this page. Opens the historian's panel, which
 * has the whole of any failure.
 */
function HistorianRow({ historian: h, selected, onSelect }) {
  const next = nextHistorianBackup(h)
  const request = historianRequest(h)
  return (
    <button
      type="button"
      className={`backup-historian${selected ? ' backup-historian-selected' : ''}`}
      data-testid="historian-row"
      aria-pressed={selected}
      onClick={onSelect}
      title="Open the historian's own backup: its last run, its schedule and the whole of any failure"
    >
      <span className="backup-historian-name"><IconDatabase size={14} /> Historian</span>
      <span>
        {h.last_success_at
          ? <>Last backup {formatRelative(h.last_success_at)}, {kindWord(h.last_success_kind)}</>
          : 'No backup yet'}
        {h.last_success_label && <span className="mono cell-meta"> {h.last_success_label}</span>}
      </span>
      <span className="cell-meta">
        {!next ? 'Next: not known yet' : next.due ? 'Next: due now' : `Next ${formatDateTime(next.at)}, ${kindWord(next.kind)}`}
      </span>
      {h.repo_bytes != null && <span className="cell-meta">{formatBytes(h.repo_bytes)} in the repository</span>}
      {request && <Badge tone={request.tone} size="sm" title={request.title}>{request.label}</Badge>}
      <span className="backup-historian-chevron" aria-hidden="true"><IconChevronRight size={14} /></span>
    </button>
  )
}

const pad2 = (n) => String(n).padStart(2, '0')

/** The historian's panel: its last success and any newer failure in full, the schedule, the repository. */
function HistorianPanel({ historian: h, onClose, showToast }) {
  const state = h ? historianState(h) : null
  const next = h ? nextHistorianBackup(h) : null
  const request = h ? historianRequest(h) : null
  const badge = !h ? null
    : state?.kind === 'failed' ? <Badge tone="danger" size="sm">Failed</Badge>
      : state?.kind === 'stale' ? <Badge tone="warning" size="sm">Stale</Badge>
        : h.last_success_at ? <Badge tone="success" size="sm">Current</Badge>
          : <Badge tone="neutral" size="sm">No backup yet</Badge>

  const fields = h ? [
    ...(h.last_failure_at ? [
      { label: 'Reason', value: h.last_failure_detail || 'pgBackRest recorded no reason.', full: true },
      { label: 'Failed', value: `${formatDateTime(h.last_failure_at)}, ${kindWord(h.last_failure_kind)}` }
    ] : []),
    { label: 'Last backup', value: h.last_success_at ? `${formatDateTime(h.last_success_at)}, ${kindWord(h.last_success_kind)}` : 'None yet' },
    ...(h.last_success_label ? [{ label: 'Label', value: h.last_success_label, mono: true, copyable: true }] : []),
    { label: 'Next backup', value: !next ? 'Not known until the backup sidecar starts' : next.due ? 'Due now' : `${formatDateTime(next.at)}, ${kindWord(next.kind)}` },
    ...(h.hour_utc != null ? [{
      label: 'Schedule',
      value: `Daily at ${pad2(h.hour_utc)}:00 UTC: a full backup on ${WEEKDAYS[h.full_on]}s, or whenever the newest full is over a week old, and a differential otherwise.`,
      full: true
    }] : []),
    { label: 'Repository', value: h.repo_bytes != null ? `${formatBytes(h.repo_bytes)}, every backup it holds, WAL excluded` : NO_VALUE, full: true },
    ...(request ? [{ label: 'Requested', value: `${formatDateTime(h.request_at)}: ${request.label.replace('Requested: ', '')}` }] : [])
  ] : []

  return (
    <ContextPanel
      open={!!h}
      type="Historian backup"
      title="Historian"
      icon={<IconDatabase size={16} />}
      subtitle={badge}
      fields={fields}
      onCopy={showToast}
      onClose={onClose}
    />
  )
}

/** The backup in flight. A queued one that stays queued is the sign no service is running. */
function RunningCard({ job, onCancel, cancelPending, historianOn }) {
  if (!job) return null
  const pending = job.status === 'PENDING'
  const waitedMs = Date.now() - new Date(job.created_at).getTime()
  const stale = pending && waitedMs > 2 * 60 * 1000

  return (
    <div className={stale ? 'callout callout-warning' : 'callout callout-info'}>
      <IconHardDrive size={14} className="callout-icon" />
      <div style={{ flex: 1 }}>
        <div>
          <strong>{pending ? 'Queued' : 'Running'}</strong>
          <span style={{ color: 'var(--text-muted)' }}> · {job.origin === 'requested' ? 'on request' : 'scheduled'}</span>
          {job.note && <span style={{ color: 'var(--text-muted)' }}> · {job.note}</span>}
        </div>
        <div style={{ color: stale ? 'var(--warning-text)' : 'var(--text-muted)', fontSize: '12px', marginTop: '4px' }}>
          {stale
            ? 'No backup service has claimed this. Nothing will take it until the service is running; cancel it or start the service.'
            : pending
              ? 'Waiting for the backup service to claim it.'
              : `Started ${formatDateTime(job.started_at)}. Being written: ${componentSentence(historianOn)}.`}
        </div>
      </div>
      {pending && (
        <ActionButton
          className="btn btn-ghost"
          pending={cancelPending}
          pendingLabel="Cancelling…"
          onClick={onCancel}
          title="Withdraw this request before the service claims it"
        >
          <IconX size={13} />
          Cancel
        </ActionButton>
      )}
    </div>
  )
}

const STATUS_BADGES = {
  COMPLETED: { tone: 'success', label: 'Completed' },
  FAILED: { tone: 'danger', label: 'Failed' },
  CANCELLED: { tone: 'neutral', label: 'Cancelled' }
}

/** Taken for a backup (its data is as of the start); ended for a run that produced none. */
function runWhen(run) {
  return run.status === 'COMPLETED' ? (run.backup?.taken_at || run.started_at) : run.finished_at
}

/** What a run with no backup came to, in words: why it failed, was pruned or was withdrawn. */
function runOutcome(run) {
  if (run.backup) return null
  if (run.status === 'COMPLETED') return 'Pruned by the retention window'
  if (run.status === 'FAILED') return run.error || 'The service recorded no reason.'
  return 'Withdrawn before the service claimed it'
}

/**
 * One finished run, one line high: its outcome under the status badge is cut to a line, and the
 * whole of it, the times and the files are in the run's panel. A run with no backup shows a dash in
 * the columns that describe the files. The row opens the panel on a click anywhere and on Enter.
 */
function RunRow({ run, inFloor, offsiteBase: base, retentionDays, releasing, onRelease, selected, onSelect }) {
  const b = run.backup
  const badge = STATUS_BADGES[run.status] || { tone: 'neutral', label: run.status }
  const outcome = runOutcome(run)

  const none = <td className="cell-meta">{NO_VALUE}</td>

  return (
    <tr
      data-testid={`run-${run.id}`}
      className={`row-selectable${selected ? ' row-selected' : ''}`}
      tabIndex={0}
      onClick={rowSelectHandler(onSelect)}
      // Enter on the row itself only: Enter on the Release button inside it is that button's.
      onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); onSelect() } }}
      title="Open this run's details: its times, its files and the whole of any failure"
    >
      <td className="backup-run-short">
        {formatDateTime(runWhen(run))}
        {b && <div className="mono cell-meta">{b.stamp}</div>}
      </td>
      <td>
        <Badge tone={badge.tone} size="sm">{badge.label}</Badge>
        {outcome && (
          <div
            className={`cell-meta truncate backup-run-outcome${run.status === 'FAILED' ? ' backup-run-failed' : ''}`}
            title={outcome}
          >
            {outcome}
          </div>
        )}
      </td>
      <td className="backup-run-short">{run.origin === 'requested' ? 'On request' : 'Scheduled'}</td>
      <td className={run.note ? undefined : 'cell-meta'}>{run.note || NO_VALUE}</td>
      {b ? (
        <>
          <td className="backup-run-short">{formatBytes(b.size_bytes)}</td>
          <td><div className="truncate backup-run-holds" title={componentSummary(b.components)}>{componentSummary(b.components)}</div></td>
          <td className="backup-run-short"><RetentionCell backup={b} kept={keptBecause(b, { inFloor, retentionDays })} retentionDays={retentionDays} /></td>
          <td className="backup-run-short"><OffsiteCell backup={b} base={base} /></td>
        </>
      ) : (
        <>{none}{none}{none}{none}</>
      )}
      <td className="row-actions">
        {b?.pinned && (
          <ActionButton
            className="btn btn-ghost btn-sm"
            pending={releasing}
            pendingLabel="Releasing…"
            onClick={() => onRelease(b)}
            title="Let the retention window apply to this backup"
          >
            Release
          </ActionButton>
        )}
      </td>
    </tr>
  )
}

/** The run's retention, in the words the Retention column uses. */
function retentionText(backup, kept, retentionDays) {
  if (backup.pinned) return 'Pinned: the retention window does not apply until it is released'
  if (kept === 'floor') return `Kept: one of the newest ${floorWord}, though older than the ${retentionDays}-day window`
  if (kept === 'off') return 'Kept: pruning is off'
  if (backup.released_at) return `Released ${formatDateTime(backup.released_at)}`
  return 'Retention window'
}

/**
 * One run's details: the whole of a failure, the queued, started and finished times, and the files
 * a backup holds. Release is its one action, on a pinned backup.
 */
function RunPanel({ run, offsiteBase: base, retentionDays, inFloor, releasing, onRelease, onClose, showToast }) {
  const b = run?.backup
  const badge = run ? (STATUS_BADGES[run.status] || { tone: 'neutral', label: run.status }) : null
  const outcome = run ? runOutcome(run) : null

  const fields = run ? [
    ...(outcome ? [{ label: run.status === 'FAILED' ? 'Reason' : 'Outcome', value: outcome, full: true }] : []),
    { label: 'Origin', value: run.origin === 'requested' ? 'On request' : 'Scheduled' },
    { label: 'Note', value: run.note },
    { label: 'Queued', value: formatDateTime(run.created_at) },
    { label: 'Started', value: run.started_at ? formatDateTime(run.started_at) : 'Never' },
    { label: 'Finished', value: formatDateTime(run.finished_at) },
    ...(b ? [
      { label: 'Stamp', value: b.stamp, mono: true },
      { label: 'Size', value: formatBytes(b.size_bytes) },
      { label: 'Location', value: b.location, copyable: true, full: true, title: 'Where the files are inside the backup service\'s container' },
      { label: 'Retention', value: retentionText(b, keptBecause(b, { inFloor, retentionDays }), retentionDays), full: true },
      ...offsiteFields(b, base)
    ] : [])
  ] : []

  const actions = b?.pinned ? [{
    label: 'Release',
    primary: true,
    pending: releasing,
    pendingLabel: 'Releasing…',
    onClick: () => onRelease(b),
    title: 'Let the retention window apply to this backup'
  }] : []

  return (
    <ContextPanel
      open={!!run}
      type="Backup run"
      title={run ? formatDateTime(runWhen(run)) : ''}
      icon={<IconHardDrive size={16} />}
      subtitle={badge && <Badge tone={badge.tone} size="sm">{badge.label}</Badge>}
      fields={fields}
      actions={actions}
      onCopy={showToast}
      onClose={onClose}
      beforeActions={b && Array.isArray(b.components) && b.components.length > 0 && (
        <>
          <div className="context-panel-section-label">Files</div>
          <ul className="backup-files">
            {b.components.map(c => (
              <li key={c.file} title={COMPONENT_LABELS[c.name] || c.name}>
                <span className="mono">{c.file}</span>
                <span className="cell-meta">{formatBytes(c.size_bytes)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    />
  )
}

/** The off-site copy of one backup, as panel fields. */
function offsiteFields(backup, base) {
  if (backup.offsite_state === 'COPIED' && (!base || backup.offsite_location?.startsWith(base))) {
    return [
      { label: 'Off site', value: `Copied ${formatDateTime(backup.offsite_copied_at)}` },
      { label: 'Off-site copy', value: backup.offsite_location, copyable: true, full: true }
    ]
  }
  if (!base) return [{ label: 'Off site', value: 'No destination is set' }]
  if (backup.offsite_state === 'FAILED') {
    return [{
      label: 'Off site',
      value: `Failed, retrying (tried ${backup.offsite_attempts} time(s), last ${formatDateTime(backup.offsite_attempted_at)}): ${backup.offsite_error || 'the service recorded no reason.'}`,
      full: true
    }]
  }
  return [{ label: 'Off site', value: 'Waiting for the service to copy it' }]
}

/** backup.retentionDays as the chart hands it to the page, or null when it was not supplied. */
function configuredRetentionDays() {
  const days = Number.parseInt(readSetting('VITE_BACKUP_RETENTION_DAYS', ''), 10)
  return Number.isFinite(days) ? days : null
}

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five']
const floorWord = NUMBER_WORDS[BACKUP_RETENTION_FLOOR] || String(BACKUP_RETENTION_FLOOR)

/**
 * Why an unpinned backup the window has passed is still on the volume: 'floor' when it is one of
 * the newest BACKUP_RETENTION_FLOOR, 'off' when retention is disabled, otherwise null. Null too
 * when the page does not know the window.
 */
export function keptBecause(backup, { inFloor, retentionDays, now = Date.now() }) {
  if (!backup || backup.pinned || retentionDays == null) return null
  if (retentionDays <= 0) return 'off'
  const pastWindow = now - new Date(backup.taken_at).getTime() > retentionDays * 24 * 60 * 60 * 1000
  return pastWindow && inFloor ? 'floor' : null
}

function RetentionCell({ backup, kept, retentionDays }) {
  if (backup.pinned) {
    return <Badge tone="info" size="sm" title="The retention window does not apply until this backup is released">Pinned</Badge>
  }
  if (kept === 'floor') {
    return (
      <span className="cell-meta" title={`Older than the ${retentionDays}-day retention window. The prune never removes the newest ${floorWord} backups, so this one stays until newer backups succeed.`}>
        Kept: one of the newest {floorWord}
      </span>
    )
  }
  if (kept === 'off') {
    return <span className="cell-meta" title="backup.retentionDays is 0, so the service prunes nothing">Kept: pruning is off</span>
  }
  if (backup.released_at) return <span className="cell-meta">Released {formatDateTime(backup.released_at)}</span>
  return <span className="cell-meta">Retention window</span>
}

/** The destination fields the service needs before it copies anything, in the dialog's words. */
const OFFSITE_REQUIRED = [
  ['endpoint', 'the endpoint'], ['region', 'the region'], ['bucket', 'the bucket'],
  ['prefix', 'the key prefix'], ['access_key_id', 'the access key ID'], ['recipient', 'the encryption recipient']
]

/** What is still missing before the service copies anything, as backup_offsite_base() decides it. */
function offsiteMissing(destination) {
  if (!destination) return []
  const missing = OFFSITE_REQUIRED.filter(([k]) => !String(destination[k] || '').trim()).map(([, label]) => label)
  if (!destination.credentialSet) missing.push('the secret access key')
  return missing
}

/** Where copies go, <endpoint>/<bucket>/<prefix>/, the form offsite_location starts with. */
function offsiteBase(destination) {
  if (!destination || offsiteMissing(destination).length) return null
  return `${destination.endpoint.trim().replace(/\/+$/, '')}/${destination.bucket.trim()}/${destination.prefix.trim()}/`
}

/**
 * The off-site destination as a header button, left of Take a backup. Unset or incomplete is a
 * warning rather than an error: the backups are good, and they share a disk with the data they
 * protect. The warning is the button's description as well as its tooltip, so a screen reader
 * hears it. Set, it is a neutral button whose tooltip names where copies go.
 */
function DestinationButton({ destination, onEdit }) {
  const descriptionId = useId()
  if (!destination) return null
  const base = offsiteBase(destination)
  if (base) {
    return (
      <button className="btn btn-ghost btn-sm" onClick={onEdit} title={`Every backup is copied, encrypted, to ${base}`}>
        Change destination
      </button>
    )
  }
  const missing = offsiteMissing(destination)
  const untouched = missing.length === OFFSITE_REQUIRED.length + 1
  const message = untouched
    ? 'No off-site copy. Every backup is on the same disk as the data it protects, so a lost disk or node takes both.'
    : `The off-site copy cannot run. Still to set: ${missing.join(', ')}.`
  return (
    <>
      <button className="btn btn-warning btn-sm" onClick={onEdit} title={message} aria-describedby={descriptionId}>
        <IconAlertTriangle size={14} /> {untouched ? 'Set a destination' : 'Complete the destination'}
      </button>
      <span id={descriptionId} className="sr-only">{message}</span>
    </>
  )
}

/** One backup's copy: where it is, why it is not there yet, or that nothing is configured. */
function OffsiteCell({ backup, base }) {
  if (backup.offsite_state === 'COPIED' && (!base || backup.offsite_location?.startsWith(base))) {
    return (
      <Badge tone="success" size="sm" title={`${backup.offsite_location}\nCopied ${formatDateTime(backup.offsite_copied_at)}`}>
        Copied
      </Badge>
    )
  }
  if (!base) {
    return <span className="cell-meta" title="No off-site destination is set">{NO_VALUE}</span>
  }
  if (backup.offsite_state === 'FAILED') {
    const reason = backup.offsite_error || 'The service recorded no reason.'
    return (
      <span style={{ color: 'var(--danger-text)' }} title={`${reason}\nTried ${backup.offsite_attempts} time(s), last ${formatDateTime(backup.offsite_attempted_at)}; the service tries again.`}>
        Failed, retrying
      </span>
    )
  }
  return <span className="cell-meta" title="The service copies it on a coming poll, newest first">Waiting</span>
}

const COMPONENT_LABELS = {
  'supabase-db': 'platform database',
  'timescaledb': 'historian',
  'vault-key': 'Vault root key',
  'storage-objects': 'stored files',
  'forge': 'forge',
  'broker': 'broker accounts',
  'ca': 'internal CA'
}

/**
 * Every component a run writes, as a sentence fragment: "the platform database, ... and the internal
 * CA". Without the historian while pgBackRest backs it up.
 */
function componentSentence(historianOn = false) {
  const names = Object.entries(COMPONENT_LABELS)
    .filter(([name]) => !(historianOn && name === 'timescaledb'))
    .map(([, label]) => `the ${label}`)
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** What Take a backup's dialog says it writes, and that it asks the historian for its own backup. */
function takeBackupHolds(historianOn) {
  if (!historianOn) return componentSentence()
  return `${componentSentence(true)}. The historian's own backup takes a differential at the same time, which this backup does not wait for`
}

function componentSummary(components) {
  if (!Array.isArray(components) || components.length === 0) return NO_VALUE
  return components.map(c => COMPONENT_LABELS[c.name] || c.name).join(', ')
}
