import React, { useCallback, useEffect, useRef, useState } from 'react'
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
import { SectionCount } from '../common/SectionCount'
import { TakeBackupModal } from '../modals/TakeBackupModal'
import { BackupDestinationModal } from '../modals/BackupDestinationModal'
import CopyableId from '../common/CopyableId'
import { HelpTip } from '../common/HelpTip'
import { IconAlertTriangle, IconHardDrive, IconShieldAlert, IconX } from '../common/Icons'
import { formatBytes, formatDateTime, NO_VALUE } from '../../utils/format'
import { readSetting } from '../../config'

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
  const lastCall = useRef(0)

  const [cancelPending, runCancel] = usePendingAction()
  const [pendingKey, runKeyed] = usePendingKey()

  const refresh = useCallback(async () => {
    const call = ++lastCall.current
    const [page, active, sum, floor, destination] = await Promise.all([
      api.listBackupRuns({ statuses: FILTERS[filter].statuses, limit }),
      api.activeBackupJob(),
      api.backupRunSummary(),
      // Soft: without it the Retention cells cannot say a backup is kept as one of the newest.
      api.newestBackupIds(BACKUP_RETENTION_FLOOR).catch(() => []),
      // Soft too: the list is worth showing without it, and the callout above it then says nothing.
      api.backupOffsiteDestination().catch(() => null)
    ])
    // A response for an earlier filter or page size that lands after a later one is dropped.
    if (call !== lastCall.current) return
    setRuns(page.runs)
    setTotal(page.total)
    setActiveJob(active)
    setSummary(sum)
    setFloorIds(new Set(floor))
    setOffsite(destination)
    setError(null)
  }, [filter, limit])

  useEffect(() => {
    let cancelled = false
    refresh()
      .catch(err => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) { setLoading(false); setPaging(false) } })
    return () => { cancelled = true }
  }, [refresh])

  // A poll, not Realtime: a backup takes minutes and its row changes twice. Faster while one is
  // in flight so the card settles when the service finishes.
  usePolling(refresh, activeJob ? 5000 : 30000, !loading)

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

  return (
    <div className="page-layout page-fill">
      <div className="page-main">
        <div className="card card-fill">
          <div className="card-header">
            <h3 className="section-title">
              Backups
              <HelpTip
                label="About backups"
                text="Every backup run, newest first, and why any failed. A requested backup is kept until released. Scheduled ones follow the retention window, but the newest three backups are always kept."
              />
              <SectionCount total={total} shown={runs.length} />
            </h3>
            {/* The primary action in the header, where every card keeps its. Disabled rather than
                hidden while one is in flight: the gate refuses a second anyway, and the callout
                below says why. */}
            <button
              className="btn btn-primary btn-sm"
              style={{ marginLeft: 'auto' }}
              disabled={!!activeJob}
              onClick={() => setAsking(true)}
              title={activeJob ? 'One backup runs at a time' : 'Queue a backup of the whole stack now'}
            >
              <IconHardDrive size={14} /> Take a backup
            </button>
          </div>

          <div className="card-body stack">
            {error && (
              <div className="callout callout-danger">
                <IconShieldAlert size={14} className="callout-icon" />
                <div>{error}</div>
              </div>
            )}

            <RunningCard job={activeJob} onCancel={onCancel} cancelPending={cancelPending} />
            <CurrentState summary={summary} />
            <OffsiteLine destination={offsite} onEdit={() => setEditingDestination(true)} showToast={showToast} />

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
                    <th title="When the backup was taken, or when a run without one ended. Hover a row for the queued, started and finished times.">When</th>
                    <th title="How the run ended, with the reason when it failed or was withdrawn">Status</th>
                    <th title="Whether a person asked for the run or the schedule started it">Origin</th>
                    <th title="The note kept with the backup, saying why it was taken">Note</th>
                    <th title="The size of every file in the backup together">Size</th>
                    <th title="The components the backup holds. Hover a row for each file and its size.">Holds</th>
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
              onMore={() => { setPaging(true); setLimit(l => l + PAGE_SIZE) }}
            />
          )}
        </div>
      </div>

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
        <TakeBackupModal holds={componentSentence()} onConfirm={onRequest} onCancel={() => setAsking(false)} />
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
 * Backup Stale rule reads (0011).
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

/** The backup in flight. A queued one that stays queued is the sign no service is running. */
function RunningCard({ job, onCancel, cancelPending }) {
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
              : `Started ${formatDateTime(job.started_at)}. Being written: ${componentSentence()}.`}
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

/** Shown on the row; the whole error is in the cell's tooltip. The service caps it at 2000. */
const ERROR_SHOWN = 200

/**
 * One finished run. A completed run shows its backup while the files exist; once the retention
 * window has pruned them the run stays, saying so. A run with no backup shows its outcome under the
 * status badge and a dash in the columns that describe the files.
 */
function RunRow({ run, inFloor, offsiteBase: base, retentionDays, releasing, onRelease }) {
  const b = run.backup
  const badge = STATUS_BADGES[run.status] || { tone: 'neutral', label: run.status }
  // Taken for a backup (its data is as of the start); ended for a run that produced none.
  const when = run.status === 'COMPLETED' ? (b?.taken_at || run.started_at) : run.finished_at

  let outcome = null
  if (!b) {
    if (run.status === 'COMPLETED') {
      outcome = (
        <span title="The service removed its files once they were older than the retention window. The run stays here as history.">
          Pruned by the retention window
        </span>
      )
    } else if (run.status === 'FAILED') {
      const reason = run.error || 'The service recorded no reason.'
      outcome = (
        <span style={{ color: 'var(--danger-text)' }} title={reason}>
          {reason.length > ERROR_SHOWN ? `${reason.slice(0, ERROR_SHOWN)}…` : reason}
        </span>
      )
    } else {
      outcome = <span>Withdrawn before the service claimed it</span>
    }
  }

  const none = <td className="cell-meta">{NO_VALUE}</td>

  return (
    <tr data-testid={`run-${run.id}`}>
      <td title={b ? b.location : runTimes(run)}>
        {formatDateTime(when)}
        {b && <div className="mono cell-meta">{b.stamp}</div>}
      </td>
      <td>
        <Badge tone={badge.tone} size="sm">{badge.label}</Badge>
        {outcome && <div className="cell-meta" style={{ maxWidth: '38ch' }}>{outcome}</div>}
      </td>
      <td>{run.origin === 'requested' ? 'On request' : 'Scheduled'}</td>
      <td className={run.note ? undefined : 'cell-meta'}>{run.note || NO_VALUE}</td>
      {b ? (
        <>
          <td>{formatBytes(b.size_bytes)}</td>
          <td title={componentDetail(b.components)}>{componentSummary(b.components)}</td>
          <td><RetentionCell backup={b} kept={keptBecause(b, { inFloor, retentionDays })} retentionDays={retentionDays} /></td>
          <td><OffsiteCell backup={b} base={base} /></td>
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
 * The destination, or its absence, above the list. Unset is a warning rather than an error: the
 * backups are good, and they share a disk with the data they protect.
 */
function OffsiteLine({ destination, onEdit, showToast }) {
  if (!destination) return null
  const base = offsiteBase(destination)
  const missing = offsiteMissing(destination)
  const untouched = missing.length === OFFSITE_REQUIRED.length + 1
  return (
    <div className={base ? 'callout' : 'callout callout-warning'} data-testid="offsite-line">
      {base
        ? <IconHardDrive size={14} className="callout-icon" />
        : <IconAlertTriangle size={14} className="callout-icon" />}
      <div style={{ flex: 1, display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
        {base ? (
          <>
            <span>Every backup is copied, encrypted, to</span>
            <CopyableId value={base} label="off-site destination" onNotify={showToast} />
          </>
        ) : untouched ? (
          <span>
            <strong>No off-site copy.</strong> Every backup is on the same disk as the data it
            protects, so a lost disk or node takes both.
          </span>
        ) : (
          <span>
            <strong>The off-site copy cannot run.</strong> Still to set: {missing.join(', ')}.
          </span>
        )}
      </div>
      <button className="btn btn-ghost btn-sm" onClick={onEdit} title="Where every backup is copied, and the key it is encrypted to">
        {base ? 'Change' : 'Set a destination'}
      </button>
    </div>
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

function runTimes(run) {
  return [
    `Queued ${formatDateTime(run.created_at)}`,
    run.started_at && `Started ${formatDateTime(run.started_at)}`,
    `Finished ${formatDateTime(run.finished_at)}`
  ].filter(Boolean).join('\n')
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

/** Every component a run writes, as a sentence fragment: "the platform database, ... and the internal CA". */
function componentSentence() {
  const names = Object.values(COMPONENT_LABELS).map(label => `the ${label}`)
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

function componentSummary(components) {
  if (!Array.isArray(components) || components.length === 0) return NO_VALUE
  return components.map(c => COMPONENT_LABELS[c.name] || c.name).join(', ')
}

function componentDetail(components) {
  if (!Array.isArray(components)) return ''
  return components.map(c => `${c.file}: ${formatBytes(c.size_bytes)}`).join('\n')
}
