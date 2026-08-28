import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api'
import { REALTIME_ENABLED } from '../../constants'
import { useRealtimeTable } from '../../hooks/useRealtimeTable'
import { usePendingAction } from '../../hooks/usePendingAction'
import { ActionButton } from '../common/ActionButton'
import { ActionMenu } from '../common/ActionMenu'
import CopyableId from '../common/CopyableId'
import { ConfirmModal } from '../modals/ConfirmModal'
import { StartCaptureModal } from '../modals/StartCaptureModal'
import { StartPlaybackModal } from '../modals/StartPlaybackModal'
import { UploadCaptureModal } from '../modals/UploadCaptureModal'
import {
  IconDownload, IconPlay, IconRecord, IconShieldAlert, IconTrash, IconUpload
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
  // `{ file, preset }` -- the dropped or chosen file, and the subject it came from when a row's
  // menu opened the picker rather than the page-level drop zone.
  const [uploadFile, setUploadFile] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [playFor, setPlayFor] = useState(null)
  const [activePlayback, setActivePlayback] = useState(null)
  const [recentPlaybacks, setRecentPlaybacks] = useState([])
  const [busyId, setBusyId] = useState(null)
  const fileRef = useRef(null)
  const [stopPending, runStop] = usePendingAction()
  const [stopPlayPending, runStopPlay] = usePendingAction()

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
    const [active, recent, activePlay, recentPlay] = await Promise.all([
      api.activeCaptureJob(),
      api.recentCaptureJobs(4),
      api.activePlaybackJob(),
      api.recentPlaybackJobs(4)
    ])
    setActiveJob(active)
    setRecentJobs(recent)
    setActivePlayback(activePlay)
    setRecentPlaybacks(recentPlay)
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
  useRealtimeTable(['capture_jobs', 'playback_jobs'], refreshAll,
    { enabled: REALTIME_ENABLED, debounceMs: 400 })

  useEffect(() => {
    if (!activeJob && !activePlayback) return
    const timer = setInterval(refreshAll, REALTIME_ENABLED ? 10000 : 2000)
    return () => clearInterval(timer)
  }, [activeJob, activePlayback, refreshAll])

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
      // Only meaningful for a device row now; a gateway's simulated flag is a badge on its name.
      context: subjectKind === 'device'
        ? (gatewayName.get(subject.gateway_id) || 'Unbound')
        : null,
      isSimulated: subjectKind === 'gateway' && !!subject.is_simulated,
      capture: captureBySubject.get(`${subjectKind}:${subject.id}`) || null
    }))
  }, [subjectKind, gateways, devices, captureBySubject, gatewayName])

  /** Every subject the upload dialog can file a capture against, both tabs at once. */
  const allSubjects = useMemo(() => ([
    ...gateways.map(g => ({
      kind: 'gateway', id: g.id, name: g.name, sparkplugId: g.sparkplug_id,
      capture: captureBySubject.get(`gateway:${g.id}`) || null
    })),
    ...devices.map(d => ({
      kind: 'device', id: d.id, name: d.name, sparkplugId: d.sparkplug_id,
      capture: captureBySubject.get(`device:${d.id}`) || null
    }))
  ]), [gateways, devices, captureBySubject])

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

  const onPlay = async ({ targetGatewayId, deviceMap, speed }) => {
    await api.startPlayback({ captureId: playFor.id, targetGatewayId, deviceMap, speed })
    setPlayFor(null)
    showToast('Publishing the capture…', 'success')
    await refreshAll()
  }

  const onStopPlayback = () => runStopPlay(async () => {
    try {
      const stopped = await api.stopPlayback(activePlayback.id)
      showToast(stopped ? 'Stopping the playback.' : 'That playback had already finished.', 'success')
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

  // The file picker feeds the same dialog the drop zone does. `pendingPreset` carries the subject
  // when a row's menu opened it, so the dialog starts on the right one instead of asking a question
  // the operator has already answered by clicking that row.
  const pendingPreset = useRef(null)
  const onFilePicked = (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setUploadFile({ file, preset: pendingPreset.current })
    pendingPreset.current = null
  }

  const askUpload = (row) => {
    pendingPreset.current = { kind: row.kind, id: row.id }
    fileRef.current?.click()
  }

  const onUpload = async ({ subject, replace }) => {
    const { messages } = await api.uploadCapture({
      subjectKind: subject.kind,
      subjectId: subject.id,
      sparkplugId: subject.sparkplugId,
      file: uploadFile.file,
      note: uploadFile.file.name,
      replace
    })
    setUploadFile(null)
    showToast(`Uploaded ${messages} message${messages === 1 ? '' : 's'} for ${subject.name}.`, 'success')
    await refreshAll()
  }

  // ------------------------------------------------------------------------------------------
  if (loading) {
    return <div style={{ color: 'var(--text-muted)', padding: '24px 0' }}>Loading captures…</div>
  }

  return (
    <>
      {/* `.card` with a `.card-header`, matching the Schemas page's Registered Schemas table
          rather than `.panel`. The two looked alike and were not: `.panel-title` sits at a
          different weight and the header has no room for the controls a table needs beside it. */}
      <div className="card" style={{ marginBottom: '24px' }}>
        <div className="card-header">
          <h3 className="section-title">
            Broker Capture <span className="section-count">{captures.length}</span>
          </h3>
        </div>

        <p style={{ color: 'var(--text-muted)', fontSize: '13px', margin: '0 0 4px' }}>
          Record what a gateway or a single device actually said, and keep it. One capture is stored
          per subject, and a new recording replaces it. Publishing a capture rewrites every captured
          identity onto a simulated gateway's own assets, because the broker pins each topic's
          edge-node segment to the account that publishes it.
        </p>

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
        <PlaybackCard
          job={activePlayback}
          onStop={onStopPlayback}
          stopPending={stopPlayPending}
          canManage={canManage}
        />
        <RecentFailures jobs={recentJobs} />
        <RecentFailures jobs={recentPlaybacks} kind="playback" />

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

        {/* THE DROP ZONE IS FOR A FILE, NOT FOR A ROW. Dragging a capture row somewhere to publish
            it was considered and does not work: a playback needs a target gateway, a device map and
            a speed, none of which a drag can carry, so it would open the dialog anyway -- a novel
            gesture that saves nothing and has no keyboard equivalent. Dragging a FILE in is the
            gesture Model3DUploader and FlowBackupUploader already use, and it means what it looks
            like: take this thing that is not in the app and put it in.

            It asks which subject afterwards rather than before, because the file is the thing the
            operator has and the subject is the one question it cannot answer. */}
        {canManage && (
          <div
            role="button"
            tabIndex={0}
            aria-label="Upload a capture file"
            onClick={() => fileRef.current?.click()}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') fileRef.current?.click() }}
            onDragOver={e => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={e => {
              e.preventDefault()
              setDragging(false)
              const dropped = e.dataTransfer?.files?.[0]
              if (dropped) setUploadFile({ file: dropped, preset: null })
            }}
            style={{
              marginTop: '12px', padding: '12px', textAlign: 'center', cursor: 'pointer',
              border: `1px dashed ${dragging ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: '8px',
              background: dragging ? 'rgba(0,212,255,0.06)' : 'transparent',
              fontSize: '12px', color: 'var(--text-muted)'
            }}
            title="Upload a capture recorded elsewhere, or by ingestion/capture.py record"
          >
            <IconUpload size={14} style={{ verticalAlign: '-2px', marginRight: '6px' }} />
            Drop a capture file here, or click to choose one
          </div>
        )}

        <div className="table-wrap" style={{ marginTop: '12px' }}>
          <table>
            <thead>
              <tr>
                <th title={subjectKind === 'gateway'
                  ? 'The edge gateway a capture would record every message from'
                  : 'A single device, recorded with its gateway’s birth certificate'}>
                  {subjectKind === 'gateway' ? 'Gateway' : 'Device'}
                </th>
                {/* WAS "Data", SHOWING Live/Simulated FOR EVERY GATEWAY. It named nothing, every row
                    on an ordinary fleet said the same thing, and it silently became the parent
                    gateway on the Devices tab -- one column with two meanings. `is_simulated` is now
                    a badge beside the name, where it is only present when it is true and therefore
                    only present when it says something. */}
                {subjectKind === 'device' && (
                  <th title="The edge node this device publishes through, and the one a capture of it also records the birth certificate from">
                    Gateway
                  </th>
                )}
                <th title="The wire identity. A capture is filed under this, and playback rewrites it onto the target's own assets">
                  Sparkplug ID
                </th>
                <th title="The one capture stored for this subject. Recording again replaces it">
                  Stored capture
                </th>
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
                  onPlay={() => setPlayFor(row.capture)}
                  playbackBlocked={!!activePlayback}
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
        onChange={onFilePicked}
      />

      {uploadFile && (
        <UploadCaptureModal
          file={uploadFile.file}
          subjects={allSubjects}
          presetSubject={uploadFile.preset
            ? allSubjects.find(s => s.kind === uploadFile.preset.kind && s.id === uploadFile.preset.id)
            : null}
          onConfirm={onUpload}
          onCancel={() => setUploadFile(null)}
        />
      )}

      {startFor && (
        <StartCaptureModal
          subject={startFor}
          existing={startFor.capture}
          onConfirm={onStart}
          onCancel={() => setStartFor(null)}
        />
      )}

      {/* The confirm-then-pick dialog that used to be here is gone: UploadCaptureModal carries the
          replace warning itself, after the file has been read, so the operator sees what they are
          about to destroy AND what they are about to store it with -- rather than confirming a
          replacement before knowing whether the file is even a capture. */}

      {playFor && (
        <StartPlaybackModal
          capture={playFor}
          onConfirm={onPlay}
          onCancel={() => setPlayFor(null)}
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
          {job.note && <span style={{ color: 'var(--text-muted)' }}> · {job.note}</span>}
        </div>
        {pending ? (
          <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginTop: '4px' }}>
            Waiting for the ingestion daemon to pick it up. If this does not start within a few
            seconds, the daemon is not running.
          </div>
        ) : (
          <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginTop: '4px' }}>
            {job.messages} message{job.messages === 1 ? '' : 's'} · {formatSize(job.bytes)} ·{' '}
            {job.elapsed_seconds}s of {job.max_seconds}s
            {' · '}
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
/**
 * How long a finished failure stays on the page.
 *
 * IT USED TO BE FOREVER, and that was wrong in a way a screenshot made obvious: the query takes the
 * last four finished jobs, so a failure sat at the top of the page until four more jobs pushed it
 * out -- which on a stack where nobody captures daily is indefinitely. It read as a live fault.
 *
 * This banner exists to explain "the thing you just did failed", because the running card clears on
 * failure and the table otherwise looks exactly as it did before. That job is minutes old. Anything
 * older is history, and history belongs in the job list rather than shouting from the top of a page.
 */
const FAILURE_VISIBLE_MS = 15 * 60 * 1000

function RecentFailures({ jobs, kind = 'capture' }) {
  const cutoff = Date.now() - FAILURE_VISIBLE_MS
  const failed = (jobs || []).filter(j => {
    if (j.status !== 'FAILED' && j.status !== 'CANCELLED') return false
    // No finished_at means it has only just been written; show it rather than hiding a fresh one.
    if (!j.finished_at) return true
    const at = new Date(j.finished_at).getTime()
    return Number.isNaN(at) || at >= cutoff
  })
  if (failed.length === 0) return null
  return (
    <div style={{ marginTop: '12px' }}>
      {failed.map(job => (
        <div key={job.id} className="callout" style={{ borderColor: 'var(--danger)', marginTop: '6px' }}>
          <IconShieldAlert size={14} className="callout-icon" />
          <div style={{ fontSize: '12px' }}>
            <strong>
              {job.devices?.name || job.gateways?.name
                || job.subject_sparkplug_id || job.target_edge_node_id}
            </strong>
            {' — '}{kind === 'playback' ? 'playback ' : ''}
            {job.status === 'CANCELLED' ? 'cancelled' : 'failed'}
            {job.error ? `: ${job.error}` : '.'}
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * The playback in flight.
 *
 * A SEPARATE CARD FROM THE CAPTURE ONE, not a shared "job" card, because they are different acts
 * with different stakes and different stop semantics. A capture consumes; a playback WRITES to the
 * historian under a gateway's identity, and the card says which gateway so that is never a guess.
 */
function PlaybackCard({ job, onStop, stopPending, canManage }) {
  if (!job) return null
  const target = job.gateways?.name || job.target_edge_node_id
  const pending = job.status === 'PENDING'
  const total = job.messages_total || 0

  return (
    <div className="callout" style={{ borderColor: 'var(--accent)', marginTop: '12px' }}>
      <IconPlay size={14} className="callout-icon" />
      <div style={{ flex: 1 }}>
        <div>
          <strong>{pending ? 'Queued' : 'Publishing'} as {target}</strong>
          <span style={{ color: 'var(--text-muted)' }}> · {job.speed}× speed</span>
        </div>
        <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginTop: '4px' }}>
          {pending
            ? 'Waiting for the playback worker to pick it up. If this does not start within a few seconds, the worker is not running.'
            : `${job.messages_sent}${total ? ` of ${total}` : ''} message${job.messages_sent === 1 ? '' : 's'} published · ${job.elapsed_seconds}s`}
        </div>
      </div>
      {canManage && (
        <ActionButton
          className="btn btn-ghost"
          pending={stopPending}
          pendingLabel="Stopping…"
          onClick={onStop}
          title="Stop publishing now. What has already been published stays in the historian."
        >
          Stop
        </ActionButton>
      )}
    </div>
  )
}

function SubjectRow({
  row, canManage, busy, blocked, playbackBlocked,
  onCapture, onDownload, onDelete, onUpload, onPlay
}) {
  const capture = row.capture
  return (
    <tr>
      <td>
        {row.name}
        {/* ONLY WHEN TRUE, which is the whole point of it being a badge rather than a column. A
            gateway whose telemetry is observed is the ordinary case and needs no label; one whose
            telemetry is synthetic is the exception, and the only kind a playback may target. */}
        {row.isSimulated && (
          <span
            className="badge badge-neutral"
            style={{ fontSize: '11px', marginLeft: '8px' }}
            title="This gateway's telemetry is generated rather than observed (0052). Only a simulated gateway may be a playback target."
          >
            SIMULATED
          </span>
        )}
      </td>
      {row.kind === 'device' && (
        <td style={{ color: 'var(--text-muted)', fontSize: '12px' }}>{row.context}</td>
      )}
      <td><CopyableId value={row.sparkplugId} label="Sparkplug ID" /></td>
      <td>
        {!capture && <span style={{ color: 'var(--text-dim)' }}>—</span>}
        {capture && (
          <div style={{ fontSize: '12px' }}>
            <div>
              {capture.message_count} message{capture.message_count === 1 ? '' : 's'} ·{' '}
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
      {/* THE PRIMARY ACT STAYS A BUTTON; THE REST GO BEHIND THE OVERFLOW MENU. Five buttons in a
          cell is what this row had, and `.table-wrap` is `overflow-x: auto`, so on a narrow
          viewport they were the first thing to disappear off the right-hand edge. ActionMenu exists
          for exactly that -- it portals out of the scroll container, which is why it is a component
          rather than a few lines of inline JSX. Capture is the verb the page is named after, so it
          keeps its own button. */}
      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        {canManage && (
          <button
            className="btn btn-ghost btn-sm"
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
        {/* `label` is the trigger's VISIBLE text, not just its accessible name -- ActionMenu renders
            it beside the chevron. So the default is used rather than a per-row string, which would
            put the subject's name in the button twice. */}
        <ActionMenu
          disabled={busy}
          items={[
            canManage && capture && {
              label: 'Play back…',
              icon: <IconPlay size={13} />,
              disabled: playbackBlocked,
              title: playbackBlocked
                ? 'A playback is already running'
                : 'Publish this capture onto a simulated gateway',
              onClick: onPlay
            },
            capture && {
              label: 'Download',
              icon: <IconDownload size={13} />,
              onClick: onDownload
            },
            canManage && {
              label: capture ? 'Replace by upload…' : 'Upload a capture…',
              icon: <IconUpload size={13} />,
              onClick: onUpload
            },
            canManage && capture && { separator: true },
            canManage && capture && {
              label: 'Delete capture',
              icon: <IconTrash size={13} />,
              danger: true,
              onClick: onDelete
            }
          ]}
        />
      </td>
    </tr>
  )
}

/** Bytes → a short human string. Local, for the same reason FlowBackupUploader's is. */
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
