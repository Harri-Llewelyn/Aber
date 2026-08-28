import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api'
import { REALTIME_ENABLED } from '../../constants'
import { useRealtimeTable } from '../../hooks/useRealtimeTable'
import { usePendingAction } from '../../hooks/usePendingAction'
import { ActionButton } from '../common/ActionButton'
import CopyableId from '../common/CopyableId'
import { ConfirmModal } from '../modals/ConfirmModal'
import { StartCaptureModal } from '../modals/StartCaptureModal'
import {
  IconDownload, IconRecord, IconShieldAlert, IconTrash, IconUpload
} from '../common/Icons'

/**
 * Recording the broker, from the dashboard.
 *
 * `ingestion/capture.py record` records live Sparkplug traffic to a file and publishes it back
 * rebased onto now — a dashboard verified against a machine that was on site for two hours, a fault
 * reproduced by editing a value by hand, a load test at a multiple of real time. Until this page a
 * capture was a file on whoever's laptop happened to run the recorder, which is the wrong place for
 * the only copy of a fault nobody can reproduce on demand.
 *
 * ---------------------------------------------------------------------------------------------
 * NOTHING ON THIS PAGE RECORDS ANYTHING. A browser cannot open an MQTT subscription: mosquitto
 * listens on 1883 TCP with no WebSocket listener, and the recording credential is a server-side
 * secret a bundle would publish. The page queues a row and the INGESTION DAEMON does the work — it
 * already holds `spBv1.0/#` and the credential, so a capture costs no second broker connection and
 * does not split the `seq` stream the daemon's own gap detection depends on.
 *
 * What that means here is that every button is a database call and every result arrives
 * asynchronously. There is no request whose response is the outcome.
 *
 * ---------------------------------------------------------------------------------------------
 * ONE CAPTURE AT A TIME, AND THE DATABASE IS WHAT SAYS SO. A partial unique index on
 * `capture_jobs` admits one PENDING-or-RECORDING row across the whole stack, so two browser tabs
 * cannot race it. The single card below is the interface to that fact, not an implementation of it:
 * disabling the buttons is a courtesy, and the refusal that arrives anyway names the capture
 * already running.
 *
 * ONE STORED CAPTURE PER SUBJECT, likewise — two partial unique indexes. A new recording replaces
 * the old, which is what bounds the bucket, and the cost is real: a capture of a rare fault can be
 * destroyed by a routine re-record. `StartCaptureModal` is the only thing standing there, which is
 * why it names the capture and its note rather than asking whether you are sure.
 *
 * ---------------------------------------------------------------------------------------------
 * THE ROLE GATES MIRROR THE RLS, THEY DO NOT IMPLEMENT IT. `0055` grants SELECT on both tables to
 * Administrator, Shopfloor_Manager and Auditor, and the gates refuse a start to anyone but the
 * first two. `canManage` decides what is offered; the database decides what happens.
 */
export function CaptureTab({ showToast, userRole }) {
  const [subjectKind, setSubjectKind] = useState('gateway')
  const [gateways, setGateways] = useState([])
  const [devices, setDevices] = useState([])
  const [captures, setCaptures] = useState([])
  const [activeJob, setActiveJob] = useState(null)
  const [recentJobs, setRecentJobs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [startFor, setStartFor] = useState(null)
  const [deleteFor, setDeleteFor] = useState(null)
  const [uploadFor, setUploadFor] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const fileRef = useRef(null)
  const [stopPending, runStop] = usePendingAction()

  const canManage = userRole === 'Administrator' || userRole === 'Shopfloor_Manager'

  // ------------------------------------------------------------------------------------------
  // Loading
  // ------------------------------------------------------------------------------------------
  const loadSubjects = useCallback(async () => {
    const [gws, devs] = await Promise.all([
      api.get('/api/v1/gateways'),
      api.get('/api/v1/devices')
    ])
    // ARCHIVED SUBJECTS ARE LEFT OUT rather than shown and disabled. `start_capture_job()` refuses
    // them — an archived gateway publishes nothing, so the capture would run its full duration and
    // produce an empty file — and a row that exists only to be refused is a row that invites the
    // click that gets refused.
    setGateways((gws || []).filter(g => !g.is_archived))
    setDevices((devs || []).filter(d => !d.is_archived && d.gateway_id))
  }, [])

  const loadJobs = useCallback(async () => {
    const [active, recent] = await Promise.all([
      api.activeCaptureJob(),
      api.recentCaptureJobs(4)
    ])
    setActiveJob(active)
    setRecentJobs(recent)
    return active
  }, [])

  const loadCaptures = useCallback(async () => {
    setCaptures(await api.listCaptures())
  }, [])

  const refreshAll = useCallback(async () => {
    try {
      await Promise.all([loadCaptures(), loadJobs()])
      setError(null)
    } catch (err) {
      setError(err.message)
    }
  }, [loadCaptures, loadJobs])

  useEffect(() => {
    let cancelled = false
    Promise.all([loadSubjects(), loadCaptures(), loadJobs()])
      .then(() => { if (!cancelled) { setError(null); setLoading(false) } })
      .catch(err => { if (!cancelled) { setError(err.message); setLoading(false) } })
    return () => { cancelled = true }
  }, [loadSubjects, loadCaptures, loadJobs])

  /**
   * Progress arrives over Realtime, which is why `capture_jobs` is in the publication and carries
   * REPLICA IDENTITY FULL.
   *
   * PAIRED WITH A TIMER, not trusted alone, for the reason useRealtimeTable's own header gives:
   * Realtime has no replay, so a dropped socket loses every change in the gap and the client is
   * never told. A capture that finished during that gap would leave a card counting up forever.
   * The timer runs ONLY while something is in flight — an idle page opens no interval at all.
   */
  useRealtimeTable('capture_jobs', refreshAll, { enabled: REALTIME_ENABLED, debounceMs: 400 })

  useEffect(() => {
    if (!activeJob) return
    const timer = setInterval(refreshAll, REALTIME_ENABLED ? 10000 : 2000)
    return () => clearInterval(timer)
  }, [activeJob, refreshAll])

  // Refetch the stored captures when a job finishes: the row that replaces the old capture is
  // written by the daemon at finalise, and nothing about the job's own change payload carries it.
  const lastJobId = useRef(null)
  useEffect(() => {
    if (activeJob) { lastJobId.current = activeJob.id; return }
    if (lastJobId.current) { lastJobId.current = null; loadCaptures().catch(() => {}) }
  }, [activeJob, loadCaptures])

  // ------------------------------------------------------------------------------------------
  // Rows
  // ------------------------------------------------------------------------------------------
  const captureBySubject = useMemo(() => {
    const map = new Map()
    for (const capture of captures) {
      const key = capture.subject_kind === 'gateway' ? capture.gateway_id : capture.device_id
      if (key) map.set(`${capture.subject_kind}:${key}`, capture)
    }
    return map
  }, [captures])

  const gatewayName = useMemo(() => {
    const map = new Map()
    for (const g of gateways) map.set(g.id, g.name)
    return map
  }, [gateways])

  const rows = useMemo(() => {
    const source = subjectKind === 'gateway' ? gateways : devices
    return source.map(subject => ({
      id: subject.id,
      kind: subjectKind,
      name: subject.name,
      sparkplugId: subject.sparkplug_id,
      // A device's context is the gateway it publishes through, which is also the edge node a
      // capture of it records the birth certificate from.
      context: subjectKind === 'gateway'
        ? (subject.is_simulated ? 'Simulated' : 'Live')
        : (gatewayName.get(subject.gateway_id) || 'Unbound'),
      capture: captureBySubject.get(`${subjectKind}:${subject.id}`) || null
    }))
  }, [subjectKind, gateways, devices, captureBySubject, gatewayName])

  // ------------------------------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------------------------------
  const onStart = async ({ note, seconds, replace }) => {
    const row = startFor
    await api.startCapture({
      subjectKind: row.kind, subjectId: row.id, note, seconds, replace
    })
    setStartFor(null)
    showToast(`Recording ${row.name}…`, 'success')
    await refreshAll()
  }

  const onStop = () => runStop(async () => {
    try {
      const stopped = await api.stopCapture(activeJob.id)
      showToast(stopped ? 'Stopping — the daemon finishes on its next message.' : 'That capture had already finished.', 'success')
      await refreshAll()
    } catch (err) {
      showToast(err.message, 'error')
    }
  })

  const onDownload = async (capture) => {
    setBusyId(capture.id)
    try {
      const url = await api.captureUrl(capture.storage_path)
      // A signed URL in a new tab rather than a fetch-and-blob: the bucket is private, the link is
      // short-lived, and the browser's own download handling is what an operator expects.
      window.open(url, '_blank', 'noopener')
    } catch (err) {
      showToast(err.message, 'error')
    } finally {
      setBusyId(null)
    }
  }

  const onDelete = async () => {
    const capture = deleteFor
    try {
      await api.deleteCapture(capture)
      showToast('Capture deleted.', 'success')
    } catch (err) {
      showToast(err.message, 'error')
    }
    setDeleteFor(null)
    await refreshAll()
  }

  const onUploadPicked = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !uploadFor) return
    const row = uploadFor
    setUploadFor(null)
    setBusyId(row.id)
    try {
      const { messages } = await api.uploadCapture({
        subjectKind: row.kind,
        subjectId: row.id,
        sparkplugId: row.sparkplugId,
        file,
        note: file.name,
        // The picker is only offered after the same confirmation a re-record needs, so by the time
        // a file has been chosen the replacement is already authorised.
        replace: !!row.capture
      })
      showToast(`Uploaded ${messages} message${messages === 1 ? '' : 's'} for ${row.name}.`, 'success')
    } catch (err) {
      showToast(err.message, 'error')
    } finally {
      setBusyId(null)
      await refreshAll()
    }
  }

  const askUpload = (row) => {
    if (row.capture) { setUploadFor(row); return }   // confirmed below, then the picker opens
    setUploadFor(row)
    // No stored capture: nothing is destroyed, so go straight to the file picker.
    setTimeout(() => fileRef.current?.click(), 0)
  }

  // ------------------------------------------------------------------------------------------
  if (loading) {
    return <div style={{ color: 'var(--text-muted)', padding: '24px 0' }}>Loading captures…</div>
  }

  return (
    <>
      <div className="panel">
        <div className="panel-header">
          <div>
            <div className="panel-title">Broker Capture</div>
            <div className="panel-subtitle">
              Record what a gateway or a single device actually said, and keep it. A capture is
              replayed with <code>python ingestion/capture.py play</code> — rebased onto now and
              rewritten onto a simulated gateway's own assets, because the broker pins every topic's
              edge-node segment to the account that publishes it.
            </div>
          </div>
        </div>

        {error && (
          <div className="callout" style={{ borderColor: 'var(--danger)', color: 'var(--danger-text)' }}>
            <IconShieldAlert size={14} className="callout-icon" />
            <div>{error}</div>
          </div>
        )}

        {!canManage && (
          <div className="callout">
            <IconShieldAlert size={14} className="callout-icon" />
            <div>
              You can read captures and download them. Recording one, replacing one and deleting one
              require Administrator or Shopfloor Manager.
            </div>
          </div>
        )}

        <RunningCard job={activeJob} onStop={onStop} stopPending={stopPending} canManage={canManage} />
        <RecentFailures jobs={recentJobs} />

        {/* Two tabs rather than two pages: the question "what do I want to record" has exactly two
            answers, and a device capture is a gateway capture narrowed to one device — it still
            records the edge node's birth certificate, which is where the alias table lives. */}
        {/* The same markup the Vocabulary panel uses for its standards, rather than classes of this
            page's own: `btn btn-sm` with the selected one primary, inside a flex `role="tablist"`.
            A `.subtab` class would have needed a rule in App.css that does not exist, and an
            unstyled button looks like a bug rather than a tab. */}
        <div
          role="tablist"
          aria-label="Capture subject"
          style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '16px' }}
        >
          <button
            role="tab"
            aria-selected={subjectKind === 'gateway'}
            className={`btn btn-sm ${subjectKind === 'gateway' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setSubjectKind('gateway')}
            title="Record everything one gateway publishes, every device beneath it included"
          >
            Gateways
            <span className="section-count" style={{ marginLeft: '6px' }}>{gateways.length}</span>
          </button>
          <button
            role="tab"
            aria-selected={subjectKind === 'device'}
            className={`btn btn-sm ${subjectKind === 'device' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setSubjectKind('device')}
            title="Record one device, plus its gateway's birth certificate"
          >
            Devices
            <span className="section-count" style={{ marginLeft: '6px' }}>{devices.length}</span>
          </button>
        </div>

        <div className="table-wrap" style={{ marginTop: '12px' }}>
          <table>
            <thead>
              <tr>
                <th>{subjectKind === 'gateway' ? 'Gateway' : 'Device'}</th>
                <th>{subjectKind === 'gateway' ? 'Data' : 'Via gateway'}</th>
                <th>Sparkplug ID</th>
                <th>Stored capture</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={5} style={{ color: 'var(--text-muted)', padding: '14px' }}>
                  {subjectKind === 'gateway'
                    ? 'No gateways registered. Create one on the Gateways tab.'
                    : 'No devices bound to a gateway. A device with no gateway has no edge node to record from.'}
                </td></tr>
              )}
              {rows.map(row => (
                <SubjectRow
                  key={row.id}
                  row={row}
                  canManage={canManage}
                  busy={busyId === row.id}
                  blocked={!!activeJob}
                  onCapture={() => setStartFor(row)}
                  onDownload={() => onDownload(row.capture)}
                  onDelete={() => setDeleteFor(row.capture)}
                  onUpload={() => askUpload(row)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* One input for every row. Rendered once and pointed at whichever row asked, because a
          file input per row is a hundred hidden inputs on a large fleet. */}
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        style={{ display: 'none' }}
        onChange={onUploadPicked}
      />

      {startFor && (
        <StartCaptureModal
          subject={startFor}
          existing={startFor.capture}
          onConfirm={onStart}
          onCancel={() => setStartFor(null)}
        />
      )}

      {uploadFor && uploadFor.capture && (
        <ConfirmModal
          message={`Uploading replaces the capture of ${uploadFor.name} recorded ${formatWhen(uploadFor.capture.recorded_at)}${uploadFor.capture.note ? ` — ${uploadFor.capture.note}` : ''}. That recording is destroyed and cannot be recovered.`}
          confirmLabel="Choose a file"
          onCancel={() => setUploadFor(null)}
          onConfirm={() => fileRef.current?.click()}
        />
      )}

      {deleteFor && (
        <ConfirmModal
          message={`Delete the capture recorded ${formatWhen(deleteFor.recorded_at)}${deleteFor.note ? ` — ${deleteFor.note}` : ''}? The file is removed from storage and cannot be recovered.`}
          confirmLabel="Delete capture"
          pendingLabel="Deleting…"
          onCancel={() => setDeleteFor(null)}
          onConfirm={onDelete}
        />
      )}
    </>
  )
}

/**
 * The one running capture.
 *
 * COUNTS UP RATHER THAN DOWN, which is not the obvious choice. A countdown implies the number is a
 * promise, and it is not: the recording stops at whichever of the three caps is met first, and the
 * message and size caps routinely arrive before the clock does. Elapsed against the duration cap
 * says the same thing without claiming to know which one will bind.
 */
function RunningCard({ job, onStop, stopPending, canManage }) {
  if (!job) return null
  const subject = job.devices?.name || job.gateways?.name || job.subject_sparkplug_id
  const pending = job.status === 'PENDING'

  return (
    <div className="callout" style={{ borderColor: 'var(--accent)', marginTop: '12px' }}>
      <IconRecord size={14} className="callout-icon" />
      <div style={{ flex: 1 }}>
        <div>
          <strong>{pending ? 'Queued' : 'Recording'} — {subject}</strong>
          {job.note && <span style={{ color: 'var(--text-muted)' }}> Â· {job.note}</span>}
        </div>
        {pending ? (
          <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginTop: '4px' }}>
            Waiting for the ingestion daemon to pick it up. If this does not start within a few
            seconds, the daemon is not running.
          </div>
        ) : (
          <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginTop: '4px' }}>
            {job.messages} message{job.messages === 1 ? '' : 's'} Â· {formatSize(job.bytes)} Â·{' '}
            {job.elapsed_seconds}s of {job.max_seconds}s
            {' Â· '}
            {job.birth_captured
              ? 'birth certificate captured'
              : 'no birth certificate yet'}
          </div>
        )}
        {/* THE BANNER SETTLES RATHER THAN VANISHING. This warning is only on screen while the card
            is, which is exactly the window nobody is watching — so it also resolves into
            `birth_captured` on the finished record, where a file that cannot replay properly stops
            looking identical to one that can. */}
        {!pending && !job.birth_captured && job.elapsed_seconds > 10 && (
          <div style={{ color: 'var(--warning-text)', fontSize: '12px', marginTop: '4px' }}>
            No <code>NBIRTH</code> or <code>DBIRTH</code> has arrived. A capture without one replays
            as <code>unresolved_alias</code> against an alias-optimised gateway and drops every
            metric. The finished capture will be marked <strong>no birth</strong>.
          </div>
        )}
      </div>
      {canManage && (
        <ActionButton
          className="btn btn-ghost"
          pending={stopPending}
          pendingLabel="Stopping…"
          onClick={onStop}
          title="Finish this capture now and keep what it has recorded"
        >
          Stop
        </ActionButton>
      )}
    </div>
  )
}

/**
 * Recently failed jobs.
 *
 * SHOWN BECAUSE THE CARD GOES AWAY. A capture that fails clears the running card and leaves the
 * table looking exactly as it did before anybody pressed anything — which reads as the button not
 * having worked. The `error` column is where the reason is, and this is the only place it surfaces.
 */
function RecentFailures({ jobs }) {
  const failed = (jobs || []).filter(j => j.status === 'FAILED' || j.status === 'CANCELLED')
  if (failed.length === 0) return null
  return (
    <div style={{ marginTop: '12px' }}>
      {failed.map(job => (
        <div key={job.id} className="callout" style={{ borderColor: 'var(--danger)', marginTop: '6px' }}>
          <IconShieldAlert size={14} className="callout-icon" />
          <div style={{ fontSize: '12px' }}>
            <strong>{job.devices?.name || job.gateways?.name || job.subject_sparkplug_id}</strong>
            {' — '}{job.status === 'CANCELLED' ? 'cancelled' : 'failed'}
            {job.error ? `: ${job.error}` : '.'}
          </div>
        </div>
      ))}
    </div>
  )
}

function SubjectRow({ row, canManage, busy, blocked, onCapture, onDownload, onDelete, onUpload }) {
  const capture = row.capture
  return (
    <tr>
      <td>{row.name}</td>
      <td>
        <span className="badge badge-neutral" style={{ fontSize: '11px' }}>{row.context}</span>
      </td>
      <td><CopyableId value={row.sparkplugId} label="Sparkplug ID" /></td>
      <td>
        {!capture && <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>None</span>}
        {capture && (
          <div style={{ fontSize: '12px' }}>
            <div>
              {capture.message_count} message{capture.message_count === 1 ? '' : 's'} Â·{' '}
              {formatSize(capture.size_bytes)}
              {capture.source === 'uploaded' && (
                <span className="badge badge-neutral" style={{ fontSize: '11px', marginLeft: '6px' }}>
                  UPLOADED
                </span>
              )}
              {/* THE ONE BADGE ON THIS PAGE THAT CHANGES A DECISION. Everything else here is
                  provenance; this says whether the file will actually replay. */}
              {capture.manifest?.birth_captured === false && (
                <span
                  className="badge badge-warning"
                  style={{ fontSize: '11px', marginLeft: '6px' }}
                  title="No NBIRTH or DBIRTH was recorded, so this capture replays as unresolved_alias against an alias-optimised gateway and drops every metric."
                >
                  NO BIRTH
                </span>
              )}
            </div>
            <div style={{ color: 'var(--text-muted)' }}>
              {formatWhen(capture.recorded_at)}{capture.note ? ` — ${capture.note}` : ''}
            </div>
          </div>
        )}
      </td>
      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        {canManage && (
          <button
            className="btn btn-ghost"
            onClick={onCapture}
            disabled={busy || blocked}
            title={blocked
              ? 'A capture is already running. One at a time on this stack.'
              : capture
                ? 'Record again — this replaces the stored capture'
                : 'Record this subject'}
          >
            <IconRecord size={13} /> Capture
          </button>
        )}
        {capture && (
          <button className="btn btn-ghost" onClick={onDownload} disabled={busy} title="Download the capture file">
            <IconDownload size={13} />
          </button>
        )}
        {canManage && (
          <button
            className="btn btn-ghost"
            onClick={onUpload}
            disabled={busy}
            title={capture ? 'Upload a capture, replacing the stored one' : 'Upload a capture recorded elsewhere'}
          >
            <IconUpload size={13} />
          </button>
        )}
        {canManage && capture && (
          <button className="btn btn-ghost" onClick={onDelete} disabled={busy} title="Delete this capture">
            <IconTrash size={13} />
          </button>
        )}
      </td>
    </tr>
  )
}

/** Bytes â†’ a short human string. Local, for the same reason FlowBackupUploader's is. */
export function formatSize(bytes) {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** A timestamp an operator can compare with their own memory of the shift. */
export function formatWhen(iso) {
  if (!iso) return 'at an unknown time'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'at an unknown time'
  return date.toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
  })
}
