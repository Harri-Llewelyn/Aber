import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { usePolling } from '../../hooks/usePolling'
import { usePendingAction, usePendingKey } from '../../hooks/usePendingAction'
import { ActionButton } from '../common/ActionButton'
import { ConfirmModal } from '../modals/ConfirmModal'
import { TakeBackupModal } from '../modals/TakeBackupModal'
import { BackupDestinationModal } from '../modals/BackupDestinationModal'
import CopyableId from '../common/CopyableId'
import { HelpTip } from '../common/HelpTip'
import { IconAlertTriangle, IconHardDrive, IconShieldAlert, IconX } from '../common/Icons'
import { formatBytes } from '../../utils/coldStorage'
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
export const BACKUP_RETENTION_FLOOR = 3

/** Runs per page of the list; "Show more" adds another page. */
const PAGE_SIZE = 30

/** The list's filter. A cancelled run is listed under All only: it neither failed nor completed. */
const FILTERS = {
  all: { label: 'All runs', statuses: ['COMPLETED', 'FAILED', 'CANCELLED'], empty: 'No run has finished yet.' },
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
  const [more, setMore] = useState(false)
  const [summary, setSummary] = useState(null)
  const [activeJob, setActiveJob] = useState(null)
  const [filter, setFilter] = useState('all')
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [loading, setLoading] = useState(true)
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
      // Soft: without it the Retention cells say what they said before the floor existed.
      api.newestBackupIds(BACKUP_RETENTION_FLOOR).catch(() => []),
      // Soft too: the list is worth showing without it, and the line above it then says nothing.
      api.backupOffsiteDestination().catch(() => null)
    ])
    // A response for an earlier filter or page size that lands after a later one is dropped.
    if (call !== lastCall.current) return
    setRuns(page.runs)
    setMore(page.more)
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
      .finally(() => { if (!cancelled) setLoading(false) })
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
        showToast(released ? `Released the backup from ${formatWhen(backup.taken_at)}. The retention window now applies.` : 'That backup was not pinned.', released ? 'success' : 'info')
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

  if (loading) {
    return <div style={{ color: 'var(--text-muted)', padding: '24px 0' }}>Loading backups…</div>
  }

  // No job row at all is a stack that has never run the backup service: the empty state, no warning.
  const neverRun = !summary?.firstRecordedAt
  const retentionDays = configuredRetentionDays()

  return (
    <div className="page-layout">
      <div className="page-main">
        <div className="card">
          <div className="card-header">
            <h3 className="section-title">
              Backups
              <HelpTip
                label="About backups"
                text="Every backup run, newest first, and why any failed. A requested backup is kept until released. Scheduled ones follow the retention window, but the newest three backups are always kept."
              />
            </h3>
            {/* The primary action in the header, where every card keeps its. Disabled rather than
                hidden while one is in flight: the gate refuses a second anyway, and the card
                above the table says why. */}
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

          <div className="card-body">
            {error && (
              <div className="callout" style={{ borderColor: 'var(--danger)', color: 'var(--danger-text)' }}>
                <IconShieldAlert size={14} className="callout-icon" />
                <div>{error}</div>
              </div>
            )}

            <RunningCard job={activeJob} onCancel={onCancel} cancelPending={cancelPending} />
            <CurrentState summary={summary} />
            <OffsiteLine destination={offsite} onEdit={() => setEditingDestination(true)} showToast={showToast} />

            {neverRun ? (
              <div style={{ color: 'var(--text-dim)', fontSize: '12px', padding: '10px 0' }}>
                No backups exist yet. Take one above, or wait for the schedule.
              </div>
            ) : (
              <>
                <div className="filter-bar" style={{ marginTop: '12px' }}>
                  <select
                    className="form-control"
                    style={{ width: '160px' }}
                    value={filter}
                    onChange={e => onFilter(e.target.value)}
                    aria-label="Run status filter"
                    title="Show every run, or only the ones that completed or failed"
                  >
                    {Object.entries(FILTERS).map(([id, f]) => <option key={id} value={id}>{f.label}</option>)}
                  </select>
                </div>

                {runs.length === 0 ? (
                  <div style={{ color: 'var(--text-dim)', fontSize: '12px', padding: '10px 0' }}>
                    {FILTERS[filter].empty}
                  </div>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>When</th>
                          <th>Status</th>
                          <th>Origin</th>
                          <th>Note</th>
                          <th>Size</th>
                          <th>Holds</th>
                          <th>Retention</th>
                          <th>Off site</th>
                          <th aria-label="Actions" />
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

                {more && (
                  <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0' }}>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => setLimit(l => l + PAGE_SIZE)}
                      title={`List the next ${PAGE_SIZE} older runs`}
                    >
                      Show more
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
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
        <TakeBackupModal onConfirm={onRequest} onCancel={() => setAsking(false)} />
      )}

      {releaseFor && (
        <ConfirmModal
          message={`Release the backup from ${formatWhen(releaseFor.taken_at)}${releaseFor.note ? ` (${releaseFor.note})` : ''}? Nothing is deleted now: the service prunes it once it is older than the retention window and not one of the newest ${floorWord}.`}
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
export function backupState(summary, now = Date.now()) {
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
    ? `The last good backup was taken ${formatWhen(state.lastGoodAt)}.`
    : failed
      ? 'No backup has succeeded yet.'
      : `None has succeeded since the first was queued ${formatWhen(summary.firstRecordedAt)}.`

  return (
    <div
      className={failed ? 'callout' : 'callout callout-warning'}
      style={{ margin: '12px 0 0', ...(failed ? { borderColor: 'var(--danger)' } : {}) }}
      role="status"
      data-testid="backup-state"
    >
      {failed
        ? <span className="callout-icon" style={{ display: 'inline-flex', color: 'var(--danger)' }}><IconShieldAlert size={14} /></span>
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
    <div className="callout" style={{ borderColor: stale ? 'var(--warning)' : 'var(--accent)', margin: '12px 0' }}>
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
              : `Started ${formatWhen(job.started_at)}. Both databases, the storage objects and the forge are being written.`}
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
          <IconX size={13} style={{ verticalAlign: '-2px', marginRight: '4px' }} />
          Cancel
        </ActionButton>
      )}
    </div>
  )
}

const STATUS_BADGES = {
  COMPLETED: { className: 'badge badge-online', label: 'Completed' },
  FAILED: { className: 'badge badge-offline', label: 'Failed' },
  CANCELLED: { className: 'badge badge-neutral', label: 'Cancelled' }
}

/** Shown on the row; the whole error is in the cell's tooltip. The service caps it at 2000. */
const ERROR_SHOWN = 200

/**
 * One finished run. A completed run shows its backup while the files exist; once the retention
 * window has pruned them the run stays, saying so. A failed run shows the service's reason.
 */
function RunRow({ run, inFloor, offsiteBase: base, retentionDays, releasing, onRelease }) {
  const b = run.backup
  const badge = STATUS_BADGES[run.status] || { className: 'badge badge-neutral', label: run.status }
  // Taken for a backup (its data is as of the start); ended for a run that produced none.
  const when = run.status === 'COMPLETED' ? (b?.taken_at || run.started_at) : run.finished_at

  let outcome = null
  if (!b) {
    if (run.status === 'COMPLETED') {
      outcome = (
        <span style={{ color: 'var(--text-muted)' }} title="The service removed its files once they were older than the retention window. The run stays here as history.">
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
      outcome = <span style={{ color: 'var(--text-muted)' }}>Withdrawn before the service claimed it</span>
    }
  }

  return (
    <tr data-testid={`run-${run.id}`}>
      <td title={b ? b.location : runTimes(run)}>
        {formatWhen(when)}
        {b && <div className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{b.stamp}</div>}
      </td>
      <td><span className={badge.className}>{badge.label}</span></td>
      <td>{run.origin === 'requested' ? 'On request' : 'Scheduled'}</td>
      <td style={{ color: run.note ? undefined : 'var(--text-dim)' }}>{run.note || '—'}</td>
      {b ? (
        <>
          <td>{formatBytes(b.size_bytes)}</td>
          <td title={componentDetail(b.components)}>{componentSummary(b.components)}</td>
          <td><RetentionCell backup={b} kept={keptBecause(b, { inFloor, retentionDays })} retentionDays={retentionDays} /></td>
          <td><OffsiteCell backup={b} base={base} /></td>
        </>
      ) : (
        <td colSpan={4}>{outcome}</td>
      )}
      <td style={{ textAlign: 'right' }}>
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
  const muted = { color: 'var(--text-muted)' }
  if (backup.pinned) {
    return <span className="badge badge-info" title="The retention window does not apply until this backup is released">Pinned</span>
  }
  if (kept === 'floor') {
    return (
      <span style={muted} title={`Older than the ${retentionDays}-day retention window. The prune never removes the newest ${floorWord} backups, so this one stays until newer backups succeed.`}>
        Kept: one of the newest {floorWord}
      </span>
    )
  }
  if (kept === 'off') {
    return <span style={muted} title="backup.retentionDays is 0, so the service prunes nothing">Kept: pruning is off</span>
  }
  if (backup.released_at) return <span style={muted}>Released {formatWhen(backup.released_at)}</span>
  return <span style={muted}>Retention window</span>
}

/** The destination fields the service needs before it copies anything, in the dialog's words. */
const OFFSITE_REQUIRED = [
  ['endpoint', 'the endpoint'], ['region', 'the region'], ['bucket', 'the bucket'],
  ['prefix', 'the key prefix'], ['access_key_id', 'the access key ID'], ['recipient', 'the encryption recipient']
]

/** What is still missing before the service copies anything, as backup_offsite_base() decides it. */
export function offsiteMissing(destination) {
  if (!destination) return []
  const missing = OFFSITE_REQUIRED.filter(([k]) => !String(destination[k] || '').trim()).map(([, label]) => label)
  if (!destination.credentialSet) missing.push('the secret access key')
  return missing
}

/** Where copies go, <endpoint>/<bucket>/<prefix>/, the form offsite_location starts with. */
export function offsiteBase(destination) {
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
    <div
      className={base ? 'callout' : 'callout callout-warning'}
      style={{ margin: '12px 0 0', ...(base ? { borderColor: 'var(--border)' } : {}) }}
      data-testid="offsite-line"
    >
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
      <button className="btn btn-sm" onClick={onEdit} title="Where every backup is copied, and the key it is encrypted to">
        {base ? 'Change' : 'Set a destination'}
      </button>
    </div>
  )
}

/** One backup's copy: where it is, why it is not there yet, or that nothing is configured. */
function OffsiteCell({ backup, base }) {
  const muted = { color: 'var(--text-muted)' }
  if (backup.offsite_state === 'COPIED' && (!base || backup.offsite_location?.startsWith(base))) {
    return (
      <span className="badge badge-online" title={`${backup.offsite_location}\nCopied ${formatWhen(backup.offsite_copied_at)}`}>
        Copied
      </span>
    )
  }
  if (!base) {
    return backup.offsite_state === 'COPIED'
      ? <span style={muted} title={backup.offsite_location}>Copied earlier</span>
      : <span style={muted} title="No off-site destination is set">—</span>
  }
  if (backup.offsite_state === 'FAILED') {
    const reason = backup.offsite_error || 'The service recorded no reason.'
    return (
      <span style={{ color: 'var(--danger-text)' }} title={`${reason}\nTried ${backup.offsite_attempts} time(s), last ${formatWhen(backup.offsite_attempted_at)}; the service tries again.`}>
        Failed, retrying
      </span>
    )
  }
  return <span style={muted} title="The service copies it on a coming poll, newest first">Waiting</span>
}

function runTimes(run) {
  return [
    `Queued ${formatWhen(run.created_at)}`,
    run.started_at && `Started ${formatWhen(run.started_at)}`,
    `Finished ${formatWhen(run.finished_at)}`
  ].filter(Boolean).join('\n')
}

const COMPONENT_LABELS = {
  'supabase-db': 'platform database',
  'timescaledb': 'historian',
  'vault-key': 'Vault root key',
  'storage-objects': '3D models',
  'forge': 'forge',
  'broker': 'broker accounts',
  'ca': 'internal CA'
}

function componentSummary(components) {
  if (!Array.isArray(components) || components.length === 0) return '—'
  return components.map(c => COMPONENT_LABELS[c.name] || c.name).join(', ')
}

function componentDetail(components) {
  if (!Array.isArray(components)) return ''
  return components.map(c => `${c.file}: ${formatBytes(c.size_bytes)}`).join('\n')
}

function formatWhen(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}
