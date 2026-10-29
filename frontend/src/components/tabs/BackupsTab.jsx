import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import { api } from '../../api'
import { usePolling } from '../../hooks/usePolling'
import { useUrlState } from '../../hooks/useUrlState'
import { backupUrl } from '../../routes'
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
import { IconAlertTriangle, IconDatabase, IconHardDrive, IconShieldAlert, IconX } from '../common/Icons'
import { SummaryCard, SummaryCards } from '../common/SummaryCard'
import { cronIntervalSeconds } from '../../utils/cronInterval'
import { formatBytes, formatClockTime, formatDateTime, formatDuration, formatRelative, NO_VALUE, plural } from '../../utils/format'
import { nextHistorianBackup } from '../../utils/historianBackupSchedule'
import { readFlag, readSetting } from '../../config'
import { Tooltip } from '../common/Tooltip'
import { ColumnHeader } from '../common/SortHeader'

/**
 * How old the last successful backup may be before the page says backups have stopped: the nightly
 * default schedule plus half a day. The Backup Stale alert rule cannot read the service's schedule,
 * so a sparser one needs this and the rule changed. check-docs-drift.mjs holds the two equal.
 */
export const BACKUP_STALE_HOURS = 36

/**
 * The margin above the newest backup's size that free space on the backup volume must clear before
 * the page says the next backup may not fit: a fifth of that backup, and at least 1 GiB, for growth
 * since it was taken.
 */
export const FREE_SPACE_MARGIN_RATIO = 0.2
export const FREE_SPACE_MARGIN_MIN_BYTES = 1024 ** 3

/**
 * How many of the newest backups the retention prune never removes, whatever their age.
 * check-docs-drift.mjs holds it equal to the floor in backup_prunable().
 */
const BACKUP_RETENTION_FLOOR = 3

/**
 * The databases pgBackRest backs up, in the order the page lists them; a key is also the selection
 * that opens that database's panel rather than a run's. The historian's state is read over the FDW
 * and can be unreachable, and only it takes requests: the platform backup already dumps the
 * platform database.
 */
const PHYSICAL = [
  {
    key: 'platform',
    read: () => api.platformBackupState(),
    name: 'Platform database',
    noun: 'the platform database',
    unreachable: 'Its backup record did not answer.',
    staleHint: ' With no failure recorded, the backup sidecar is probably not running: kubectl -n aber logs supabase-db-0 -c pgbackrest says why.'
  },
  {
    key: 'historian',
    read: () => api.historianBackupState(),
    name: 'Historian',
    noun: 'the historian',
    unreachable: 'Its database did not answer: the timescaledb pod is probably down or restarting.',
    staleHint: ' Take a backup asks for one; if its request is not picked up, the backup sidecar is not running.'
  }
]
const capitalised = (db) => `${db.noun.charAt(0).toUpperCase()}${db.noun.slice(1)}`

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
  const [filter, setFilter] = useUrlState('status', 'all', { allowed: Object.keys(FILTERS) })
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [loading, setLoading] = useState(true)
  const [paging, setPaging] = useState(false)
  const [error, setError] = useState(null)
  const [asking, setAsking] = useState(false)
  const [releaseFor, setReleaseFor] = useState(null)
  const [floorIds, setFloorIds] = useState(() => new Set())
  const [offsite, setOffsite] = useState(null)
  const [editingDestination, setEditingDestination] = useState(false)
  // A run's id, or a database's PHYSICAL key, in the address as `?run=`.
  const [selectedId, setSelectedId] = useUrlState('run')
  // Each database's own backup by PHYSICAL key: undefined while its physical backup is off or not
  // yet read, null when it cannot be read.
  const [physical, setPhysical] = useState({})
  const historianOn = readFlag('VITE_HISTORIAN_PHYSICAL_BACKUP')
  const platformOn = readFlag('VITE_PLATFORM_PHYSICAL_BACKUP')
  const lastCall = useRef(0)

  const [cancelPending, runCancel] = usePendingAction()
  const [pendingKey, runKeyed] = usePendingKey()

  const refresh = useCallback(async () => {
    const call = ++lastCall.current
    const on = { historian: historianOn, platform: platformOn }
    const [page, active, sum, floor, destination, ...states] = await Promise.all([
      api.listBackupRuns({ statuses: FILTERS[filter].statuses, limit }),
      api.activeBackupJob(),
      api.backupRunSummary(),
      // Soft: without it the Retention cells cannot say a backup is kept as one of the newest.
      api.newestBackupIds(BACKUP_RETENTION_FLOOR).catch(() => []),
      // Soft too: the list is worth showing without it, and the destination button is then left out.
      api.backupOffsiteDestination().catch(() => null),
      // A read that fails is reported the way an unreachable historian is: it cannot be read.
      ...PHYSICAL.map(db => on[db.key] ? db.read().catch(() => null) : undefined)
    ])
    // A response for an earlier filter or page size that lands after a later one is dropped.
    if (call !== lastCall.current) return
    setRuns(page.runs)
    setTotal(page.total)
    setActiveJob(active)
    setSummary(sum)
    setFloorIds(new Set(floor))
    setOffsite(destination)
    setPhysical(Object.fromEntries(PHYSICAL.map((db, i) => [db.key, states[i]])))
    setError(null)
  }, [filter, limit, historianOn, platformOn])

  useEffect(() => {
    let cancelled = false
    refresh()
      .catch(err => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) { setLoading(false); setPaging(false) } })
    return () => { cancelled = true }
  }, [refresh])

  // A poll, not Realtime: a backup takes minutes and its row changes twice. Faster while one is
  // in flight so the card settles when the service finishes.
  usePolling(refresh, activeJob || historianRequest(physical.historian)?.inFlight ? 5000 : 30000, !loading)

  // The dialog shows a refusal itself, so a throw here stays in it: the gate names the backup in
  // the way, and a toast would vanish before the sentence was read.
  const onRequest = async ({ note }) => {
    await api.requestBackup(note)
    setAsking(false)
    showToast('Backup queued. The service will take it shortly.', 'success', { to: backupUrl() })
    await refresh()
  }

  const onCancel = () => runCancel(async () => {
    try {
      const cancelled = await api.cancelBackupJob(activeJob.id)
      showToast(cancelled ? 'Backup cancelled.' : 'The service had already claimed it; it will finish or fail.', cancelled ? 'success' : 'info',
        { to: backupUrl() })
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
        showToast(released ? `Released the backup from ${formatDateTime(backup.taken_at)}. The retention window now applies.` : 'That backup was not pinned.', released ? 'success' : 'info',
          { to: backupUrl(backup.id) })
        await refresh()
      } catch (err) {
        showToast(err.message, 'error')
      }
    })
  }

  const onSaveDestination = ({ values }) => api.setBackupOffsiteDestination(Object.fromEntries(
    Object.entries(values).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v])
  ))

  const onDestinationSaved = async () => {
    setEditingDestination(false)
    showToast('Off-site destination saved. The service copies each backup on its next polls.', 'success', { to: backupUrl() })
    await refresh()
  }

  const onRemoveDestination = async () => {
    await api.clearBackupOffsiteDestination()
    setEditingDestination(false)
    showToast('Off-site destination removed. Copies already made stay in the bucket.', 'info', { to: backupUrl() })
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

  // The Backup runs card opens the newest run that completed or failed. A filter that hides it is
  // cleared, so the run is in the list and its panel opens on the next load.
  const newestId = summary?.latestOutcome?.id || null
  const openNewest = () => {
    if (selectedId !== newestId && filter !== 'all' && !runs.some(r => r.id === newestId)) onFilter('all')
    toggleRun(newestId)
  }

  return (
    <div className="page-layout page-fill">
      <div className="page-main">
        <div className="card card-fill">
          <CardHeading
            icon={<IconHardDrive size={15} />}
            title="Backups"
            description="Every backup run, newest first, and why any failed. Scheduled backups follow the retention window; requested ones are kept until released."
          />

          {/* The status filter narrows the list of runs, so it waits for one. */}
          <div className="filter-bar">
            {!loading && !neverRun && (
              <select
                className="form-control control-sm"
                value={filter}
                onChange={e => onFilter(e.target.value)}
                aria-label="Run status filter"
              >
                {Object.entries(FILTERS).map(([id, f]) => <option key={id} value={id}>{f.label}</option>)}
              </select>
            )}
            <div className="filter-bar-actions">
              <ClearFilters count={filter === 'all' ? 0 : 1} onClear={() => onFilter('all')} />
              <DestinationButton destination={offsite} onEdit={() => setEditingDestination(true)} />
              {/* The main button, last. Disabled rather than hidden while one is in flight: the
                  gate refuses a second anyway, and the callout below says why. */}
              <Tooltip text={activeJob ? 'One backup runs at a time' : 'Queue a backup of the whole stack now'}>
                <button
                  className="btn btn-primary btn-sm"
                  disabled={!!activeJob}
                  onClick={() => setAsking(true)}
                >
                  <IconHardDrive size={14} /> Take a backup
                </button>
              </Tooltip>
            </div>
          </div>

          {/* Above the cards, which it says cannot be trusted while it shows. */}
          {error && (
            <div className="card-body backup-banner">
              <div className="callout callout-danger">
                <IconShieldAlert size={14} className="callout-icon" />
                <div>{error}</div>
              </div>
            </div>
          )}

          <BackupSummary
            summary={summary}
            physical={physical}
            selectedId={selectedId}
            onOpenNewest={newestId ? openNewest : null}
            onOpenDatabase={toggleRun}
          />

          {/* Full width, outside the row: it holds a Cancel button, and no card can hold a button. */}
          {activeJob && (
            <div className="card-body backup-banner">
              <RunningCard job={activeJob} onCancel={onCancel} cancelPending={cancelPending} historianOn={historianOn} />
            </div>
          )}

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
                    <ColumnHeader title="When the backup was taken, or when a run without one ended. A run's panel gives every time.">When</ColumnHeader>
                    <ColumnHeader title="How the run ended, with the reason when it failed or was withdrawn">Status</ColumnHeader>
                    <ColumnHeader title="Whether a person asked for the run or the schedule started it">Origin</ColumnHeader>
                    <ColumnHeader title="The note kept with the backup, saying why it was taken">Note</ColumnHeader>
                    <ColumnHeader title="The size of every file in the backup together">Size</ColumnHeader>
                    <ColumnHeader title="The components the backup holds. A run's panel gives each file and its size.">Holds</ColumnHeader>
                    <ColumnHeader title="Why the backup is still kept, or that the retention window applies">Retention</ColumnHeader>
                    <ColumnHeader title="Whether the encrypted copy has reached the off-site bucket. Waiting: a coming poll copies it, newest first. A dash: no destination.">Off site</ColumnHeader>
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

      {PHYSICAL.filter(db => physical[db.key] !== undefined).map(db => (
        <PhysicalBackupPanel
          key={db.key}
          db={db}
          row={selectedId === db.key ? physical[db.key] : null}
          onClose={() => setSelectedId(null)}
          showToast={showToast}
        />
      ))}

      {editingDestination && (
        <BackupDestinationModal
          destination={offsite}
          credentialSet={!!offsite?.credentialSet}
          onSave={onSaveDestination}
          writeCredential={api.setBackupOffsiteCredential}
          onSaved={onDestinationSaved}
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

/** The page's statement about now as a sentence, or null while backups are working. */
function backupStateSentence(summary, state) {
  if (!state) return null
  const failed = state.kind === 'failed'
  const lastGood = state.lastGoodAt
    ? `The last good backup was taken ${formatDateTime(state.lastGoodAt)}.`
    : failed
      ? 'No backup has succeeded yet.'
      : `None has succeeded since the first was queued ${formatDateTime(summary.firstRecordedAt)}.`
  return failed
    ? `The last backup failed, and none has succeeded since. ${lastGood} The card opens the failed run, with its reason.`
    : `No backup has succeeded in ${BACKUP_STALE_HOURS} hours. ${lastGood} If nothing is queued or running, the backup service is probably not running.`
}

/**
 * The two warnings the cards raise, each null when it does not apply. `slow`: the last completed
 * run took more than half the shortest gap between scheduled runs, so backups are heading for
 * running into the next one. `space`: free space on the backup volume is below the newest backup
 * plus the margin, so the next backup may not fit. Neither applies without the service's report.
 */
export function backupWarnings(summary) {
  const interval = cronIntervalSeconds(summary?.service?.schedule)
  const duration = Number(summary?.lastSuccess?.duration_seconds)
  const slow = interval && Number.isFinite(duration) && duration > interval / 2 ? { duration, interval } : null
  const free = summary?.service?.volumeFreeBytes
  const size = summary?.newestSizeBytes
  let space = null
  if (free != null && size != null) {
    const needed = Number(size) + Math.max(Number(size) * FREE_SPACE_MARGIN_RATIO, FREE_SPACE_MARGIN_MIN_BYTES)
    if (Number(free) < needed) space = { free: Number(free), size: Number(size) }
  }
  return { slow, space }
}

/** A card's tooltip as paragraphs, leaving out the ones that do not apply. */
const paragraphs = (...parts) => parts.filter(Boolean)
/** Sentences into one paragraph, or null when none applies. */
const paragraph = (...parts) => parts.filter(Boolean).join(' ') || null

/**
 * The row of cards under the toolbar: the backup runs, each database's own backup while it has
 * one, and the backup volume. Backup runs and Storage wait for a stack that has run the service.
 */
function BackupSummary({ summary, physical, selectedId, onOpenNewest, onOpenDatabase }) {
  const ran = !!summary?.firstRecordedAt
  const databases = PHYSICAL.filter(db => physical[db.key] !== undefined)
  if (!ran && databases.length === 0) return null
  return (
    <SummaryCards label="Backup summary" testId="backup-summary">
      {ran && <RunsCard summary={summary} selected={!!onOpenNewest && selectedId === summary.latestOutcome?.id} onOpen={onOpenNewest} />}
      {databases.map(db => (
        <PhysicalBackupCard key={db.key} db={db} row={physical[db.key]} selected={selectedId === db.key} onOpen={() => onOpenDatabase(db.key)} />
      ))}
      {ran && <StorageCard summary={summary} />}
    </SummaryCards>
  )
}

/**
 * The backup runs: the last good backup's age and successes in 30 days, and whether backups are
 * working now. A run that failed and is not yet followed by a success, no success in
 * BACKUP_STALE_HOURS, or a run that took more than half the gap between runs. Opens the newest run.
 */
function RunsCard({ summary, selected, onOpen }) {
  const state = backupState(summary)
  const { slow } = backupWarnings(summary)
  const last = summary.lastSuccess
  const failed = state?.kind === 'failed'
  const median = summary.medianDurationSeconds
  const medianRuns = summary.medianRuns || 14
  const missed = summary.runs30d > 0 && summary.succeeded30d < summary.runs30d

  const words = failed ? 'Last run failed'
    : state ? `None in ${BACKUP_STALE_HOURS} hours`
      : slow ? `Slow: ${formatDuration(slow.duration)}${median != null ? `, median ${formatDuration(median)}` : ''}`
        : last ? 'Up to date' : 'Waiting for the first backup'

  return (
    <SummaryCard
      title="Backup runs"
      testId="card-runs"
      value={last ? formatRelative(last.started_at) : 'No good backup yet'}
      unit={last ? 'last good backup' : undefined}
      detail={summary.runs30d ? `${summary.succeeded30d} of ${summary.runs30d} succeeded in 30 days` : 'No runs in 30 days'}
      // Any failure in the window is marked, unless the card already says the last one failed.
      flagged={missed && !failed}
      state={words}
      tone={failed ? 'danger' : state || slow ? 'warning' : undefined}
      tip={paragraphs(
        backupStateSentence(summary, state),
        slow && `The last backup took ${formatDuration(slow.duration)}, more than half the ${formatDuration(slow.interval)} between scheduled backups. If backups keep growing, one will soon run into the next.`,
        paragraph(
          !state && (last ? `The last good backup was taken ${formatDateTime(last.started_at)}.` : 'No backup has completed yet.'),
          summary.runs30d
            ? `${summary.succeeded30d} of the ${summary.runs30d} runs that ended in the last 30 days completed. A cancelled run is not counted.`
            : 'No run has ended in the last 30 days.'
        ),
        paragraph(
          last?.duration_seconds != null && !slow && `The last good backup took ${formatDuration(last.duration_seconds)}.`,
          median != null && `The median of the last ${medianRuns} is ${formatDuration(median)}.`
        ),
        onOpen && !failed && 'The card opens the newest run.'
      )}
      selected={selected}
      onOpen={onOpen || undefined}
    />
  )
}

/**
 * The backup volume: free space (of the total), the space every backup holds and the newest copy
 * off site, with the oldest restorable backup in the tooltip. Warns when the next may not fit.
 * Opens nothing.
 */
function StorageCard({ summary }) {
  const { space } = backupWarnings(summary)
  const service = summary.service
  const offsite = summary.newestOffsite
  const held = summary.backupsHeld ?? 0
  const reported = service?.reportedAt ? ` As of ${formatDateTime(service.reportedAt)}.` : ''

  return (
    <SummaryCard
      title="Storage"
      testId="card-storage"
      value={service?.volumeFreeBytes != null ? formatBytes(service.volumeFreeBytes) : NO_VALUE}
      unit={service?.volumeTotalBytes != null ? `free of ${formatBytes(service.volumeTotalBytes)}` : 'free'}
      detail={`${formatBytes(summary.bytesHeld ?? 0)} in ${plural(held, 'backup')} · ${offsite ? `newest off site ${formatRelative(offsite.taken_at)}` : 'none off site'}`}
      state={space ? 'May not fit' : service ? 'Room for the next backup' : 'Not reported yet'}
      tone={space ? 'warning' : undefined}
      tip={paragraphs(
        space && `The next backup may not fit. The backup volume has ${formatBytes(space.free)} free, and the last backup was ${formatBytes(space.size)}. Release pinned backups you no longer need, shorten the retention window, or give the volume more space.`,
        service
          ? `Free space on the backup volume, as the backup service last reported it.${reported} On local-path this is the node's whole disk, shared with the databases.`
          : 'The backup service has not reported its volume yet. It does at start, and after each backup and each prune.',
        paragraph(
          `Every backup on the volume together is ${formatBytes(summary.bytesHeld ?? 0)}, in ${plural(held, 'backup')}.`,
          summary.oldestTakenAt
            ? `The oldest restorable backup was taken ${formatDateTime(summary.oldestTakenAt)}. Retention, pinning and the newest-three floor decide it.`
            : 'No backup is on the volume.'
        ),
        offsite
          ? `The newest backup with a copy off site was taken ${formatDateTime(offsite.taken_at)} and copied ${formatDateTime(offsite.copied_at)}.`
          : summary.offsiteDestinationSet ? 'No backup has been copied to the destination yet.' : 'No off-site destination is set.'
      )}
    />
  )
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const KIND_WORDS = { full: 'full', diff: 'differential', incr: 'incremental' }
const kindWord = (kind) => KIND_WORDS[kind] || kind

/**
 * One database's own backup in one statement about now, or null: the Backup runs card's rule on the
 * clock its Backup Stale rule reads. A failure (the read returns one only while it is newer than the
 * last success) stands until a backup succeeds; otherwise stale when the last success, or before the
 * first the first recorded run, is older than BACKUP_STALE_HOURS. Null in is unreachable.
 */
export function physicalBackupState(row, now = Date.now()) {
  if (row === null) return { kind: 'unreachable' }
  if (!row) return null
  if (row.last_failure_at) return { kind: 'failed' }
  const clock = row.last_success_at || row.first_recorded_at
  if (clock && now - new Date(clock).getTime() > BACKUP_STALE_HOURS * HOUR_MS) return { kind: 'stale' }
  return null
}

/**
 * The historian's latest backup asked for from this page, while it is worth saying: waiting for
 * the sidecar, being taken, or how it ended within the last day. The sidecar looks once a minute,
 * so one waiting for minutes means its container is not running. The platform database's row
 * carries no request.
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

/**
 * A database's own backup as a card: the last success's age and type, when the next is due, the
 * repository's size and, for the historian, a request from this page. Its state is failed (with the
 * start of pgBackRest's reason), stale, or cannot be read. Opens its panel, which has the whole of
 * any failure; one that cannot be read has no panel, so opens nothing.
 */
function PhysicalBackupCard({ db, row: h, selected, onOpen }) {
  const state = physicalBackupState(h)
  const testId = `card-${db.key}`
  if (state?.kind === 'unreachable') {
    return (
      <SummaryCard
        title={db.name}
        testId={testId}
        value="Not known"
        detail={db.unreachable}
        state="Cannot be read"
        tone="warning"
        tip={`${capitalised(db)} cannot be read, so this page cannot say whether its own backup is working. ${db.unreachable}`}
      />
    )
  }

  const next = nextHistorianBackup(h)
  const request = historianRequest(h)
  const failed = state?.kind === 'failed'
  const reason = h.last_failure_detail || 'pgBackRest recorded no reason.'
  const lastGood = h.last_success_at
    ? `The last good one finished ${formatDateTime(h.last_success_at)}, ${kindWord(h.last_success_kind)}.`
    : failed
      ? 'None has succeeded yet.'
      : h.first_recorded_at ? `None has succeeded since backup was switched on ${formatDateTime(h.first_recorded_at)}.` : 'None has run yet.'
  // A daily schedule's next run is within a day, so the card gives its time; the tooltip the date.
  const nextShort = !next ? 'Next: not known yet' : next.due ? 'Next: due now' : `Next ${formatClockTime(next.at)}, ${kindWord(next.kind)}`
  const nextLong = !next ? 'The next is not known until the backup sidecar starts.'
    : next.due ? 'The next is due now.' : `The next is ${formatDateTime(next.at)}, ${kindWord(next.kind)}.`

  return (
    <SummaryCard
      title={db.name}
      testId={testId}
      badge={request && <Badge tone={request.tone} size="sm">{request.label}</Badge>}
      value={h.last_success_at ? formatRelative(h.last_success_at) : 'No backup yet'}
      unit={h.last_success_at ? `last backup, ${kindWord(h.last_success_kind)}` : undefined}
      detail={[nextShort, h.repo_bytes != null && `${formatBytes(h.repo_bytes)} held`].filter(Boolean).join(' · ')}
      state={failed ? `Failed ${formatRelative(h.last_failure_at)}: ${reason}`
        : state ? `None in ${BACKUP_STALE_HOURS} hours`
          : h.last_success_at ? 'Up to date' : 'Waiting for its first backup'}
      tone={failed ? 'danger' : state ? 'warning' : undefined}
      tip={paragraphs(
        paragraph(
          failed && `${capitalised(db)}'s last backup failed ${formatRelative(h.last_failure_at)}, and none has succeeded since.`,
          state && !failed && `No ${db.noun.replace(/^the /, '')} backup has succeeded in ${BACKUP_STALE_HOURS} hours.`,
          lastGood
        ),
        failed ? reason : state ? db.staleHint.trim() : null,
        paragraph(
          h.last_success_label && `Its label is ${h.last_success_label}.`,
          nextLong,
          h.repo_bytes != null && `The repository holds ${formatBytes(h.repo_bytes)}: every backup it keeps, WAL excluded.`
        ),
        request && `${request.label}. ${request.title}`
      )}
      selected={selected}
      onOpen={onOpen}
    />
  )
}

const pad2 = (n) => String(n).padStart(2, '0')

/** A database's panel: its last success and any newer failure in full, the schedule, the repository. */
function PhysicalBackupPanel({ db, row: h, onClose, showToast }) {
  const state = h ? physicalBackupState(h) : null
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
      type={`${db.name} backup`}
      title={db.name}
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
    >
      <td className="backup-run-short">
        {formatDateTime(runWhen(run))}
        {b && <div className="mono cell-meta">{b.stamp}</div>}
      </td>
      <td>
        <Badge tone={badge.tone} size="sm">{badge.label}</Badge>
        {/* Cut to one line; the tooltip, and the run's panel, give the whole of it. */}
        {outcome && (
          <Tooltip text={outcome}>
            <div className={`cell-meta truncate backup-run-outcome${run.status === 'FAILED' ? ' backup-run-failed' : ''}`}>
              {outcome}
            </div>
          </Tooltip>
        )}
      </td>
      <td className="backup-run-short">{run.origin === 'requested' ? 'On request' : 'Scheduled'}</td>
      <td className={run.note ? undefined : 'cell-meta'}>{run.note || NO_VALUE}</td>
      {b ? (
        <>
          <td className="backup-run-short">{formatBytes(b.size_bytes)}</td>
          <td><Tooltip text={componentSummary(b.components)}><div className="truncate backup-run-holds">{componentSummary(b.components)}</div></Tooltip></td>
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
      { label: 'Location', value: b.location, copyable: true, full: true, help: 'Where the files are inside the backup service\'s container' },
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
              <Tooltip key={c.file} text={COMPONENT_LABELS[c.name] || c.name}>
                <li>
                  <span className="mono">{c.file}</span>
                  <span className="cell-meta">{formatBytes(c.size_bytes)}</span>
                </li>
              </Tooltip>
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
      <Tooltip text={`Older than the ${retentionDays}-day retention window. The prune never removes the newest ${floorWord} backups, so this one stays until newer backups succeed.`}>
        <span className="cell-meta">Kept: one of the newest {floorWord}</span>
      </Tooltip>
    )
  }
  if (kept === 'off') {
    return <Tooltip text="The retention window is 0 days, so the service prunes nothing"><span className="cell-meta">Kept: pruning is off</span></Tooltip>
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
 * The off-site destination as a toolbar button, left of Take a backup. Unset or incomplete is a
 * warning rather than an error: the backups are good, and they share a disk with the data they
 * protect. The warning is the button's description as well as its tooltip, so a screen reader
 * hears it once. Set, it is filled, as a toolbar's actions are, and its tooltip names where copies go.
 */
function DestinationButton({ destination, onEdit }) {
  const descriptionId = useId()
  if (!destination) return null
  const base = offsiteBase(destination)
  if (base) {
    return (
      <Tooltip text={`Every backup is copied, encrypted, to ${base}`}>
        <button className="btn btn-primary btn-sm" onClick={onEdit}>Change destination</button>
      </Tooltip>
    )
  }
  const missing = offsiteMissing(destination)
  const untouched = missing.length === OFFSITE_REQUIRED.length + 1
  const message = untouched
    ? 'No off-site copy. Every backup is on the same disk as the data it protects, so a lost disk or node takes both.'
    : `The off-site copy cannot run. Still to set: ${missing.join(', ')}.`
  return (
    <>
      <Tooltip text={message} describe={false}>
        <button className="btn btn-warning btn-sm" onClick={onEdit} aria-describedby={descriptionId}>
          <IconAlertTriangle size={14} /> {untouched ? 'Set a destination' : 'Complete the destination'}
        </button>
      </Tooltip>
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
    return <span className="cell-meta">{NO_VALUE}</span>
  }
  if (backup.offsite_state === 'FAILED') {
    const reason = backup.offsite_error || 'The service recorded no reason.'
    return (
      <Tooltip text={`${reason}\nTried ${backup.offsite_attempts} time(s), last ${formatDateTime(backup.offsite_attempted_at)}; the service tries again.`}>
        <span style={{ color: 'var(--danger-text)' }}>Failed, retrying</span>
      </Tooltip>
    )
  }
  return <span className="cell-meta">Waiting</span>
}

const COMPONENT_LABELS = {
  'supabase-db': 'platform database',
  'timescaledb': 'historian',
  'vault-key': 'Vault root key',
  'storage-objects': 'stored files',
  'forge': 'forge',
  'broker': 'broker accounts',
  'grafana': 'Grafana',
  'ca': 'internal CA'
}

/** A label that is a name, which a sentence gives without "the". */
const NAMED_COMPONENTS = new Set(['grafana'])

/**
 * Every component a run writes, as a sentence fragment: "the platform database, ..., Grafana and the
 * internal CA". Without the historian while pgBackRest backs it up.
 */
function componentSentence(historianOn = false) {
  const names = Object.entries(COMPONENT_LABELS)
    .filter(([name]) => !(historianOn && name === 'timescaledb'))
    .map(([name, label]) => (NAMED_COMPONENTS.has(name) ? label : `the ${label}`))
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
