import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api'
import { useDisplayNames } from '../../hooks/useDisplayNames'
import { Badge } from '../common/Badge'
import { ColumnHeader } from '../common/SortHeader'
import { EmptyState } from '../common/EmptyState'
import { ListFoot } from '../common/ListFoot'
import { LoadingState } from '../common/LoadingState'
import { PersonName } from '../common/PersonName'
import { Tooltip } from '../common/Tooltip'
import { IconInfo, IconPlay, IconRecord, IconShieldAlert } from '../common/Icons'
import { formatBytes, formatDateTime, formatDuration, plural } from '../../utils/format'

/** Rows the Captures and Playbacks tabs first show, and how many Show more adds. */
export const HISTORY_PAGE = 20

/** What a search reads in one step, and the most rows it reads: older jobs than that are not searched. */
export const SEARCH_STEP = 200
export const SEARCH_ROWS = 1000

/** A finished job's status, as each kind names it: a stopped playback is not a fault. */
const OUTCOMES = {
  capture: {
    COMPLETED: { label: 'Stored', tone: 'success' },
    FAILED: { label: 'Failed', tone: 'danger' },
    CANCELLED: { label: 'Cancelled', tone: 'neutral' }
  },
  playback: {
    COMPLETED: { label: 'Completed', tone: 'success' },
    FAILED: { label: 'Failed', tone: 'danger' },
    CANCELLED: { label: 'Stopped', tone: 'neutral' }
  }
}

/** A stored capture's file name: the last segment of its path. */
const fileNameOf = (path) => String(path || '').split('/').pop()

/** The Sparkplug ID of what a playback played back: its capture's subject, or the first segment of a deleted capture's path. */
const playedIdOf = (job) => job.captures?.subject_sparkplug_id || job.capture_storage_path?.split('/')[0]

/**
 * What a search matches in a finished job, lower-cased and one field to a line, so a query never
 * matches across two: the note, the file name, the subject's name and Sparkplug ID, who started it
 * (their name, and their id), the status as the database and the tab say it, the failure a row
 * shows, and the job's id. `startedBy` is the starter's name, `subjectName(sparkplugId)` names a
 * played-back capture's subject.
 */
export function jobSearchText(kind, job, { startedBy, subjectName } = {}) {
  const outcome = OUTCOMES[kind][job.status]
  const subject = kind === 'capture'
    ? [job.devices?.name || job.gateways?.name, job.subject_sparkplug_id, job.device_sparkplug_id]
    : [subjectName?.(playedIdOf(job)), playedIdOf(job)]
  return [
    kind === 'capture' ? job.note : job.captures?.note,
    fileNameOf(kind === 'capture' ? job.storage_path : job.capture_storage_path),
    ...subject,
    startedBy,
    job.requested_by,
    job.status,
    outcome?.label,
    job.status === 'FAILED' ? job.error : null,
    job.id
  ].filter(Boolean).join('\n').toLowerCase()
}

/**
 * The Capture page's Captures or Playbacks tab: every finished recording (`kind` 'capture') or
 * playback ('playback'), newest first, a page at a time. The strips above it show a failure for
 * fifteen minutes; this is where it stays. A fragment, so the table is the card's scroller and
 * Show more stays under it on screen.
 *
 * `refreshKey` changes when a job of this kind finishes, which reads the list again.
 * `subjectName(sparkplugId)` names a played-back capture's subject. `search` narrows the list to
 * the jobs it matches (`jobSearchText()`). `jobId` lists that one job alone, with a line saying
 * so, and `onShowAll` leaves it.
 */
export function JobHistory({ kind, refreshKey, subjectName, search = '', jobId = '', onShowAll }) {
  return jobId
    ? <OneJob kind={kind} jobId={jobId} refreshKey={refreshKey} subjectName={subjectName} onShowAll={onShowAll} />
    : <JobList kind={kind} refreshKey={refreshKey} subjectName={subjectName} search={search} />
}

const nounOf = (kind) => (kind === 'playback' ? 'playback' : 'recording')

function JobList({ kind, refreshKey, subjectName, search }) {
  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [more, setMore] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(null)
  const [paging, setPaging] = useState(false)
  // How many rows a re-read asks for, so a job finishing does not take away what Show more added.
  const wanted = useRef(HISTORY_PAGE)

  useEffect(() => {
    let alive = true
    // A thunk, so a stub without the method reads as a failed read rather than throwing here.
    Promise.resolve().then(() => api.jobHistory(kind, { limit: wanted.current }))
      .then(page => {
        if (!alive) return
        setRows(page.rows)
        setTotal(page.remaining)
        setMore(page.more)
        setError(null)
        setLoaded(true)
      })
      .catch(err => {
        if (!alive) return
        setError(err.message)
        setLoaded(true)
      })
    return () => { alive = false }
  }, [kind, refreshKey])

  const names = useDisplayNames(useMemo(() => rows.map(r => r.requested_by), [rows]))

  const readOlder = useCallback((step = HISTORY_PAGE) => {
    const last = rows[rows.length - 1]
    if (!last || paging) return
    setPaging(true)
    api.jobHistory(kind, { before: { created_at: last.created_at, id: last.id }, limit: step })
      .then(page => {
        const seen = new Set(rows.map(r => r.id))
        const next = [...rows, ...page.rows.filter(r => !seen.has(r.id))]
        wanted.current = Math.max(HISTORY_PAGE, next.length)
        setRows(next)
        setTotal(rows.length + page.remaining)
        setMore(page.more)
        setError(null)
      })
      .catch(err => setError(err.message))
      .finally(() => setPaging(false))
  }, [kind, rows, paging])

  // A search reads on through the older jobs until it has them all, or SEARCH_ROWS of them, so a
  // job that is not on the first page is found, not reported missing.
  const query = search.trim().toLowerCase()
  const capped = rows.length >= SEARCH_ROWS
  useEffect(() => {
    if (query && more && !paging && !error && !capped) readOlder(SEARCH_STEP)
  }, [query, more, paging, error, capped, readOlder])
  const reading = Boolean(query) && more && !capped && !error

  const found = useMemo(
    () => (query
      ? rows.filter(job => jobSearchText(kind, job, { startedBy: names.get(job.requested_by), subjectName }).includes(query))
      : rows),
    [rows, query, kind, names, subjectName]
  )

  const what = kind === 'playback' ? 'finished playbacks' : 'finished recordings'
  return (
    <>
      {error && (
        <div className="card-body">
          <div className="callout callout-danger" role="status">
            <IconShieldAlert size={14} className="callout-icon" />
            <div>Could not read the {what}: {error}</div>
          </div>
        </div>
      )}
      {!loaded ? (
        <LoadingState label={what} />
      ) : rows.length === 0 ? (
        !error && <EmptyState
          icon={kind === 'playback' ? <IconPlay size={36} /> : <IconRecord size={36} />}
          message={`No ${what} yet.`}
        />
      ) : found.length === 0 ? (
        reading
          ? <LoadingState label={`older ${what}`} />
          : <EmptyState
            icon={kind === 'playback' ? <IconPlay size={36} /> : <IconRecord size={36} />}
            filtered
            message={`No ${what} yet.`}
            filteredMessage={<>No {what} match <strong>{search.trim()}</strong>.</>}
          />
      ) : (
        <>
          <JobTable kind={kind} jobs={found} names={names} subjectName={subjectName} />
          {query ? (
            <div className="list-foot">
              <span className="list-foot-end" role="status">
                {reading
                  ? `Searching older ${what}…`
                  : more
                    ? `Searched the newest ${rows.length.toLocaleString('en-GB')} of ${total.toLocaleString('en-GB')} ${what}. Older ones are not searched.`
                    : `${found.length} of ${rows.length} ${what} match.`}
              </span>
            </div>
          ) : (
            <ListFoot
              shown={rows.length}
              total={more ? Math.max(total, rows.length + 1) : rows.length}
              step={HISTORY_PAGE}
              pending={paging}
              counted={more && total > rows.length}
              onMore={() => readOlder()}
            />
          )}
        </>
      )}
    </>
  )
}

/**
 * One job, by its id: the line that says so and how to leave it, then the job's row. A job that is
 * not finished, or whose id is no job's, is not listed, and the empty state says so.
 */
function OneJob({ kind, jobId, refreshKey, subjectName, onShowAll }) {
  const [rows, setRows] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    Promise.resolve().then(() => api.jobHistory(kind, { job: jobId, limit: 1 }))
      .then(page => {
        if (!alive) return
        setRows(page.rows)
        setError(null)
        setLoaded(true)
      })
      .catch(err => {
        if (!alive) return
        setError(err.message)
        setLoaded(true)
      })
    return () => { alive = false }
  }, [kind, jobId, refreshKey])

  const names = useDisplayNames(useMemo(() => rows.map(r => r.requested_by), [rows]))
  const noun = nounOf(kind)
  return (
    <>
      <div className="callout callout-info capture-job-line" role="status">
        <IconInfo size={14} className="callout-icon" />
        <div>
          <strong>Showing one {noun}.</strong> The rest of the finished {noun}s are not listed.
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onShowAll}>
          Show all {noun}s
        </button>
      </div>
      {error && (
        <div className="card-body">
          <div className="callout callout-danger" role="status">
            <IconShieldAlert size={14} className="callout-icon" />
            <div>Could not read the {noun}: {error}</div>
          </div>
        </div>
      )}
      {!loaded ? (
        <LoadingState label={`the ${noun}`} />
      ) : rows.length === 0 ? (
        !error && <EmptyState
          icon={kind === 'playback' ? <IconPlay size={36} /> : <IconRecord size={36} />}
          message={`No finished ${noun} has this id. One still in progress is in the strip above, and is listed here when it ends.`}
        />
      ) : (
        <JobTable kind={kind} jobs={rows} names={names} subjectName={subjectName} />
      )}
    </>
  )
}

/** The table of jobs: the card's scroller, a direct child of it. */
function JobTable({ kind, jobs, names, subjectName }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <ColumnHeader title="When it was started, in your time zone.">Started</ColumnHeader>
            <ColumnHeader title={kind === 'playback'
              ? 'The subject of the capture that was played back.'
              : 'The gateway or device that was recorded.'}>Subject</ColumnHeader>
            <ColumnHeader title="How it ended.">Status</ColumnHeader>
            <ColumnHeader title={kind === 'playback'
              ? 'How long it ran, and how many messages it published.'
              : 'How long it recorded, and how much.'}>Length</ColumnHeader>
            <ColumnHeader title="The person who started it.">Started by</ColumnHeader>
            <ColumnHeader title="What a failed one said went wrong.">Failure</ColumnHeader>
          </tr>
        </thead>
        <tbody>
          {jobs.map(job => (
            <HistoryRow
              key={job.id}
              kind={kind}
              job={job}
              name={names.get(job.requested_by)}
              subjectName={subjectName}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function HistoryRow({ kind, job, name, subjectName }) {
  const outcome = OUTCOMES[kind][job.status] || { label: job.status, tone: 'neutral' }
  return (
    <tr>
      <td className="cell-meta">{formatDateTime(job.created_at)}</td>
      <td>{subjectOf(kind, job, subjectName)}</td>
      <td><Badge tone={outcome.tone} size="sm">{outcome.label}</Badge></td>
      <td className="cell-meta">{lengthOf(kind, job)}</td>
      <td><Starter id={job.requested_by} name={name} /></td>
      <td className="capture-history-failure">{job.status === 'FAILED' ? job.error : null}</td>
    </tr>
  )
}

/** What a job was about: a recording's subject, or the subject of the capture a playback played. */
function subjectOf(kind, job, subjectName) {
  if (kind === 'capture') return job.devices?.name || job.gateways?.name || job.subject_sparkplug_id
  // A deleted capture leaves its file's path, whose first segment is the subject.
  const id = playedIdOf(job)
  return subjectName?.(id) || <span className="mono">{id}</span>
}

/** How long it ran, and how much: a recording's size, a playback's messages. */
function lengthOf(kind, job) {
  const ran = formatDuration(job.elapsed_seconds)
  if (kind === 'capture') return job.bytes > 0 ? `${ran} · ${formatBytes(job.bytes)}` : ran
  const sent = job.messages_total
    ? `${job.messages_sent || 0} of ${plural(job.messages_total, 'message')}`
    : plural(job.messages_sent || 0, 'message')
  return `${ran} · ${sent}`
}

/** The person who started it, by the name display_names_for() answers, keyed by their id. */
function Starter({ id, name }) {
  if (!id) return <span className="context-field-empty">—</span>
  if (name) return <Tooltip text={id}><span><PersonName name={name} /></span></Tooltip>
  return <Tooltip text={id}><span className="mono">{String(id).slice(0, 8)}</span></Tooltip>
}
