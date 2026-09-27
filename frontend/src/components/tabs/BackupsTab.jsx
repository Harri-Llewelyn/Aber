import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import { usePolling } from '../../hooks/usePolling'
import { usePendingAction, usePendingKey } from '../../hooks/usePendingAction'
import { ActionButton } from '../common/ActionButton'
import { ConfirmModal } from '../modals/ConfirmModal'
import { TakeBackupModal } from '../modals/TakeBackupModal'
import { HelpTip } from '../common/HelpTip'
import { IconHardDrive, IconShieldAlert, IconX } from '../common/Icons'
import { formatBytes } from '../../utils/coldStorage'

/**
 * Backups without a shell.
 *
 * Nothing on this page takes a backup: a browser cannot run pg_dump, so the page queues a row
 * and the backup service does the work, with the result arriving on the next poll. One backup
 * runs at a time (a partial unique index, not a rule of this component), a requested one is
 * pinned until released, and the bytes never come here: the table says where they are and how
 * big, and restore is a runbook. Administrator only, as the RLS and every RPC are; App re-checks
 * the role before rendering this.
 */
export function BackupsTab({ showToast }) {
  const [backups, setBackups] = useState([])
  const [activeJob, setActiveJob] = useState(null)
  const [recentJobs, setRecentJobs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [asking, setAsking] = useState(false)
  const [releaseFor, setReleaseFor] = useState(null)

  const [cancelPending, runCancel] = usePendingAction()
  const [pendingKey, runKeyed] = usePendingKey()

  const refresh = useCallback(async () => {
    const [list, active, recent] = await Promise.all([
      api.listBackups(), api.activeBackupJob(), api.recentBackupJobs(4)
    ])
    setBackups(list)
    setActiveJob(active)
    setRecentJobs(recent)
    setError(null)
  }, [])

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

  if (loading) {
    return <div style={{ color: 'var(--text-muted)', padding: '24px 0' }}>Loading backups…</div>
  }

  return (
    <div className="page-layout">
      <div className="page-main">
        <div className="card">
          <div className="card-header">
            <h3 className="section-title">
              Backups
              <HelpTip
                label="About backups"
                text="Both databases, the 3D models and the forge, on the backup service's own volume. A requested backup is kept until released; scheduled ones follow the retention window. Restoring is a runbook run from a shell."
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
            <RecentFailures jobs={recentJobs} />

            {backups.length === 0 ? (
              <div style={{ color: 'var(--text-dim)', fontSize: '12px', padding: '10px 0' }}>
                No backups exist yet. Take one above, or wait for the schedule.
              </div>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Taken</th>
                      <th>Origin</th>
                      <th>Note</th>
                      <th>Size</th>
                      <th>Holds</th>
                      <th>Retention</th>
                      <th aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {backups.map(b => (
                      <tr key={b.id} data-testid={`backup-${b.stamp}`}>
                        <td title={b.location}>
                          {formatWhen(b.taken_at)}
                          <div className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{b.stamp}</div>
                        </td>
                        <td>{b.origin === 'requested' ? 'On request' : 'Scheduled'}</td>
                        <td style={{ color: b.note ? undefined : 'var(--text-dim)' }}>{b.note || '—'}</td>
                        <td>{formatBytes(b.size_bytes)}</td>
                        <td title={componentDetail(b.components)}>{componentSummary(b.components)}</td>
                        <td>
                          {b.pinned
                            ? <span className="badge badge-info" title="The retention window does not apply until this backup is released">Pinned</span>
                            : b.released_at
                              ? <span style={{ color: 'var(--text-muted)' }}>Released {formatWhen(b.released_at)}</span>
                              : <span style={{ color: 'var(--text-muted)' }}>Retention window</span>}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {b.pinned && (
                            <ActionButton
                              className="btn btn-ghost btn-sm"
                              pending={pendingKey === b.id}
                              pendingLabel="Releasing…"
                              onClick={() => setReleaseFor(b)}
                              title="Let the retention window apply to this backup"
                            >
                              Release
                            </ActionButton>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>

      {asking && (
        <TakeBackupModal onConfirm={onRequest} onCancel={() => setAsking(false)} />
      )}

      {releaseFor && (
        <ConfirmModal
          message={`Release the backup from ${formatWhen(releaseFor.taken_at)}${releaseFor.note ? ` (${releaseFor.note})` : ''}? Nothing is deleted now: the service prunes it once it is older than the retention window.`}
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

/** Failures and cancellations only: a completed job is the backup row below. */
function RecentFailures({ jobs }) {
  const failed = jobs.filter(j => j.status === 'FAILED')
  if (failed.length === 0) return null
  return (
    <div style={{ margin: '8px 0 12px' }}>
      {failed.map(j => (
        <div key={j.id} className="callout" style={{ borderColor: 'var(--danger)', marginBottom: '6px' }}>
          <IconShieldAlert size={14} className="callout-icon" />
          <div style={{ fontSize: '12px' }}>
            <strong>Backup failed</strong> {formatWhen(j.finished_at)}
            {j.note && <span style={{ color: 'var(--text-muted)' }}> · {j.note}</span>}
            <div style={{ color: 'var(--danger-text)', marginTop: '2px' }}>{j.error}</div>
          </div>
        </div>
      ))}
    </div>
  )
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
