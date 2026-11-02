import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api'
import { useDisplayNames } from '../../hooks/useDisplayNames'
import { Badge } from '../common/Badge'
import { ColumnHeader } from '../common/SortHeader'
import { EmptyState } from '../common/EmptyState'
import { ListFoot } from '../common/ListFoot'
import { LoadingState } from '../common/LoadingState'
import { PersonName } from '../common/PersonName'
import { Tooltip } from '../common/Tooltip'
import { IconPlay, IconRecord, IconShieldAlert } from '../common/Icons'
import { formatBytes, formatDateTime, formatDuration, plural } from '../../utils/format'

/** Rows the Captures and Playbacks tabs first show, and how many Show more adds. */
export const HISTORY_PAGE = 20

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

/**
 * The Capture page's Captures or Playbacks tab: every finished recording (`kind` 'capture') or
 * playback ('playback'), newest first, a page at a time. The strips above it show a failure for
 * fifteen minutes; this is where it stays. A fragment, so the table is the card's scroller and
 * Show more stays under it on screen.
 *
 * `refreshKey` changes when a job of this kind finishes, which reads the list again.
 * `subjectName(sparkplugId)` names a played-back capture's subject.
 */
export function JobHistory({ kind, refreshKey, subjectName }) {
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

  const showMore = () => {
    const last = rows[rows.length - 1]
    if (!last || paging) return
    setPaging(true)
    api.jobHistory(kind, { before: { created_at: last.created_at, id: last.id }, limit: HISTORY_PAGE })
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
  }

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
      ) : (
        <>
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
                {rows.map(job => (
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
          <ListFoot
            shown={rows.length}
            total={more ? Math.max(total, rows.length + 1) : rows.length}
            step={HISTORY_PAGE}
            pending={paging}
            counted={more && total > rows.length}
            onMore={showMore}
          />
        </>
      )}
    </>
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
  const id = job.captures?.subject_sparkplug_id || job.capture_storage_path?.split('/')[0]
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
