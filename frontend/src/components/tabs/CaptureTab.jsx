import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api'
import { REALTIME_ENABLED } from '../../constants'
import { useRealtimeTable } from '../../hooks/useRealtimeTable'
import { usePendingAction } from '../../hooks/usePendingAction'
import { ActionButton } from '../common/ActionButton'
import CopyableId from '../common/CopyableId'
import { gatewayType, gatewayTypeLabel, gatewayTypeDescription, gatewayTypeTone } from '../../utils/gatewayType'
import { ContextPanel, rowSelectHandler } from '../common/ContextPanel'
import { schemasForDevice } from '../../utils/deviceTags'
import { ConfirmModal } from '../modals/ConfirmModal'
import { StartCaptureModal } from '../modals/StartCaptureModal'
import { StartPlaybackModal } from '../modals/StartPlaybackModal'
import { UploadCaptureModal } from '../modals/UploadCaptureModal'
import {
  IconDownload, IconPlay, IconRecord, IconShieldAlert, IconTrash, IconUpload, IconX
} from '../common/Icons'

/**
 * Recording the broker, and publishing a recording back.
 *
 * `ingestion/capture.py record` records live Sparkplug traffic to a file and publishes it back
 * rebased onto now — a dashboard verified against a machine that was on site for two hours, a fault
 * reproduced by editing a value by hand, a load test at a multiple of real time. Until this page a
 * capture was a file on whoever's laptop happened to run the recorder, which is the wrong place for
 * the only copy of a fault nobody can reproduce on demand.
 *
 * ---------------------------------------------------------------------------------------------
 * NOTHING ON THIS PAGE RECORDS OR PUBLISHES ANYTHING. A browser cannot open an MQTT subscription:
 * mosquitto listens on 1883 TCP with no WebSocket listener, and both credentials are server-side
 * secrets a bundle would publish. The page queues a row and one of two server processes does the
 * work — the ingestion daemon for a capture, the playback worker for a publication.
 *
 * What that means here is that every action is a database call and every result arrives
 * asynchronously over Realtime. There is no request whose response is the outcome.
 *
 * ---------------------------------------------------------------------------------------------
 * TWO CARDS, BECAUSE THEY ARE TWO ACTS WITH DIFFERENT STAKES. Capture consumes: it reads what is
 * already on the wire. Playback WRITES, under a gateway's own identity, into the historian that
 * everything downstream reads. Putting a running playback in among the capture rows made the more
 * consequential of the two the quieter one on the page.
 *
 * ONE CAPTURE AT A TIME AND ONE STORED CAPTURE PER SUBJECT, both enforced by partial unique
 * indexes rather than by this component: two browser tabs cannot race a database constraint. The
 * cards and the disabled buttons are the interface to those facts, not an implementation of them.
 *
 * THE ROLE GATES MIRROR THE RLS, THEY DO NOT IMPLEMENT IT. `0055` and `0056` grant SELECT to
 * Administrator, Shopfloor_Manager and Auditor, and refuse every write to anyone but the first two.
 */
export function CaptureTab({ showToast, userRole, onSelectSchema }) {
  const [subjectKind, setSubjectKind] = useState('gateway')
  const [gateways, setGateways] = useState([])
  const [devices, setDevices] = useState([])
  const [captures, setCaptures] = useState([])
  const [activeJob, setActiveJob] = useState(null)
  const [recentJobs, setRecentJobs] = useState([])
  const [activePlayback, setActivePlayback] = useState(null)
  const [recentPlaybacks, setRecentPlaybacks] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [selectedId, setSelectedId] = useState(null)
  const [startFor, setStartFor] = useState(null)
  const [deleteFor, setDeleteFor] = useState(null)
  const [playFor, setPlayFor] = useState(null)
  const [uploadFile, setUploadFile] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [busyId, setBusyId] = useState(null)

  const [storedFilter, setStoredFilter] = useState('all')
  const [gatewayFilter, setGatewayFilter] = useState('')
  const [search, setSearch] = useState('')
  const [draggingPlay, setDraggingPlay] = useState(false)
  // Set when a file is dropped on the Playback card: once it has been stored, the playback dialog
  // opens on the capture it produced rather than sending the operator back to the table to find it.
  const [playAfterUpload, setPlayAfterUpload] = useState(false)
  const [schemas, setSchemas] = useState([])

  const fileRef = useRef(null)
  const playFileRef = useRef(null)
  const [stopPending, runStop] = usePendingAction()
  const [stopPlayPending, runStopPlay] = usePendingAction()

  const canManage = userRole === 'Administrator' || userRole === 'Shopfloor_Manager'

  // ------------------------------------------------------------------------------------------
  // Loading
  // ------------------------------------------------------------------------------------------
  const loadSubjects = useCallback(async () => {
    const [gws, devs, schemaList] = await Promise.all([
      api.get('/api/v1/gateways'),
      api.get('/api/v1/devices'),
      // Read only to NAME a device's schema in the panel. Defaulted rather than allowed to reject
      // the batch: a page that cannot record a capture because a schema list failed would be
      // trading the whole feature for a label.
      api.get('/api/v1/schemas').catch(() => [])
    ])
    setSchemas(schemaList || [])
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
   * Progress arrives over Realtime, which is why both job tables are in the publication and carry
   * REPLICA IDENTITY FULL.
   *
   * PAIRED WITH A TIMER, not trusted alone, for the reason useRealtimeTable's own header gives:
   * Realtime has no replay, so a dropped socket loses every change in the gap and the client is
   * never told. A job that finished during that gap would leave a card counting up forever. The
   * timer runs ONLY while something is in flight — an idle page opens no interval at all.
   */
  useRealtimeTable(['capture_jobs', 'playback_jobs'], refreshAll,
    { enabled: REALTIME_ENABLED, debounceMs: 400 })

  useEffect(() => {
    if (!activeJob && !activePlayback) return
    const timer = setInterval(refreshAll, REALTIME_ENABLED ? 10000 : 2000)
    return () => clearInterval(timer)
  }, [activeJob, activePlayback, refreshAll])

  // Refetch the stored captures when a capture job finishes: the row that replaces the old capture
  // is written by the daemon at finalise, and the job's own change payload does not carry it.
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

  // THE ROW, not just the name: a device's Type is its gateway's, and deciding it needs all three
  // of `is_shadow`, `is_simulated` and `deployment` rather than a label.
  const gatewayById = useMemo(() => {
    const map = new Map()
    for (const g of gateways) map.set(g.id, g)
    return map
  }, [gateways])

  const allRows = useMemo(() => {
    // THE PLAYBACK LANE IS NOT A CAPTURE SUBJECT, in either tab.
    //
    // A shadow gateway publishes only while a playback is running, so recording from it means
    // capturing a capture -- a file whose contents are another file, replayed. Its shadow devices
    // are the same thing one level down: `shadow_of` says they exist to receive a replay, not to
    // report a machine.
    //
    // Offering them read as an oversight rather than a choice, because everything else on this page
    // is a subject somebody might genuinely want to record. Starting a playback is unaffected:
    // `playbackTargets()` selects on `is_shadow` and is a different query for a different question.
    const source = (subjectKind === 'gateway' ? gateways : devices)
      .filter(s => subjectKind === 'gateway' ? !s.is_shadow : !s.shadow_of)
    return source.map(subject => ({
      id: subject.id,
      kind: subjectKind,
      name: subject.name,
      sparkplugId: subject.sparkplug_id,
      // Only meaningful for a device row; a gateway's simulated flag is a badge on its name.
      context: subjectKind === 'device'
        ? (gatewayName.get(subject.gateway_id) || 'Unbound')
        : null,
      gatewayId: subjectKind === 'device' ? subject.gateway_id : subject.id,
      // THE TYPE OF THE GATEWAY, for a device row as much as a gateway one: a device's readings are
      // as synthetic as the edge node publishing them, and the device rows are where an operator is
      // most likely to forget that. `gatewayType()` reads three fields and applies the lane
      // precedence, so Shadow does not present as Simulated.
      type: gatewayType(
        subjectKind === 'gateway' ? subject : gatewayById.get(subject.gateway_id)
      ),
      // Carried so the panel can name the device's schema without a second lookup per selection.
      device: subjectKind === 'device' ? subject : null,
      capture: captureBySubject.get(`${subjectKind}:${subject.id}`) || null
    }))
  }, [subjectKind, gateways, devices, captureBySubject, gatewayName])

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return allRows.filter(row => {
      if (storedFilter === 'with' && !row.capture) return false
      if (storedFilter === 'without' && row.capture) return false
      if (gatewayFilter && row.gatewayId !== gatewayFilter) return false
      if (!needle) return true
      return row.name.toLowerCase().includes(needle)
        || (row.sparkplugId || '').toLowerCase().includes(needle)
    })
  }, [allRows, storedFilter, gatewayFilter, search])

  // The gateway filter is only offered on the Devices tab, so it only counts there -- otherwise
  // switching tabs with one set would show "Clear filters (1)" for a control that is not on screen.
  const activeFilterCount = (storedFilter !== 'all' ? 1 : 0)
    + (search.trim() ? 1 : 0)
    + (subjectKind === 'device' && gatewayFilter ? 1 : 0)
  const withCapture = allRows.filter(r => r.capture).length

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

  // Resolved from the CURRENT rows rather than captured on click: this page refreshes on a timer
  // and over Realtime, so a held object would freeze at the moment it was selected — the panel
  // would show a capture that had since been replaced, beside a table row that had updated.
  const selected = allRows.find(r => r.id === selectedId) || null

  // `schemasForDevice` handles both attachment paths -- the device_submodels join and the legacy
  // 1:1 `schema_id` -- in one place, which is why it is used rather than reading either directly.
  const selectedSchemas = useMemo(
    () => (selected?.device ? schemasForDevice(selected.device, schemas) : []),
    [selected, schemas]
  )

  // ------------------------------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------------------------------
  const onStart = async ({ note, seconds, replace }) => {
    const row = startFor
    await api.startCapture({ subjectKind: row.kind, subjectId: row.id, note, seconds, replace })
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
    try {
      await api.deleteCapture(deleteFor)
      showToast('Capture deleted.', 'success')
    } catch (err) {
      showToast(err.message, 'error')
    }
    setDeleteFor(null)
    await refreshAll()
  }

  const onFilePicked = (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file && selected) {
      setPlayAfterUpload(false)
      setUploadFile({ file, preset: { kind: selected.kind, id: selected.id } })
    }
  }

  /**
   * A file dropped on the Playback card: store it, then publish it.
   *
   * THE SUBJECT IS INFERRED FROM THE FILE AND OFFERED, NOT ASSUMED. A capture records the edge node
   * it came from, so an edited file almost always belongs to the subject it was downloaded from --
   * but "almost always" is exactly why the dialog still shows the choice rather than filing it
   * silently. A guess that is usually right and occasionally files a capture against the wrong
   * gateway is worse than no guess.
   *
   * Reading the file twice is deliberate: this pass only looks at `identities`, and
   * UploadCaptureModal does the validation. Splitting them keeps the guess from becoming a second
   * place that decides what a valid capture is.
   */
  const onPlayFileChosen = async (file) => {
    let preset = null
    try {
      const doc = JSON.parse(await file.text())
      const ids = [
        ...(doc?.identities?.devices || []),
        ...(doc?.identities?.edge_nodes || [])
      ]
      for (const id of ids) {
        const match = allSubjects.find(s => s.sparkplugId === id)
        if (match) { preset = { kind: match.kind, id: match.id }; break }
      }
    } catch {
      // Not readable as a capture. Left for UploadCaptureModal to explain properly.
    }
    setPlayAfterUpload(true)
    setUploadFile({ file, preset })
  }

  const onPlayFilePicked = (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) onPlayFileChosen(file)
  }

  const onUpload = async ({ subject, replace }) => {
    const { id, messages, manifest } = await api.uploadCapture({
      subjectKind: subject.kind,
      subjectId: subject.id,
      sparkplugId: subject.sparkplugId,
      file: uploadFile.file,
      note: uploadFile.file.name,
      replace
    })
    const chain = playAfterUpload
    setUploadFile(null)
    setPlayAfterUpload(false)
    showToast(`Uploaded ${messages} message${messages === 1 ? '' : 's'} for ${subject.name}.`, 'success')
    await refreshAll()

    // STRAIGHT INTO THE PLAYBACK DIALOG when the file arrived on the Playback card. Built from what
    // the upload returned rather than found by re-reading the list: `refreshAll` has just replaced
    // that array, and searching it for "the one that appeared" is a race with a definite answer
    // sitting in the response.
    if (chain) {
      setPlayFor({
        id,
        subject_sparkplug_id: subject.sparkplugId,
        message_count: messages,
        note: uploadFile.file.name,
        storage_path: `${subject.sparkplugId}/capture.json`,
        manifest
      })
    }
  }

  // ------------------------------------------------------------------------------------------
  if (loading) {
    return <div style={{ color: 'var(--text-muted)', padding: '24px 0' }}>Loading captures…</div>
  }

  const capture = selected?.capture || null

  return (
    <div className="page-layout">
      <div className="page-main">

        {/* ====================================================================================
            PLAYBACK, IN A CARD OF ITS OWN AND ABOVE CAPTURE.
            It is the act with consequences: it writes into the historian under a gateway's own
            identity, and everything downstream reads that. As one banner among the capture rows it
            was the quieter of the two, which is backwards.
            ==================================================================================== */}
        <div className="card" style={{ marginBottom: 'var(--stack)' }}>
          {/* "Playback", not "Broker Playback". The page is Capture, the description says broker in
              its first line, and a two-word title where one will do is a word the reader has to
              skip on every visit. Same for the card below. */}
          <div className="card-header">
            <h3 className="section-title">Playback</h3>
          </div>

          <div className="card-body">
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', margin: '0 0 12px' }}>
              Publish a stored capture back into the stack as a simulated gateway — through the real
              broker, down the real ingestion path, rebased onto now. Every captured identity is
              rewritten onto the target's own assets, because the broker pins each topic's edge-node
              segment to the account that publishes it.
            </p>

            <PlaybackCard
              job={activePlayback}
              onStop={onStopPlayback}
              stopPending={stopPlayPending}
              canManage={canManage}
            />
            <RecentFailures jobs={recentPlaybacks} kind="playback" />

            {/* PUBLISH A FILE STRAIGHT FROM DISK, WHICH IS A DIFFERENT ERRAND FROM THE PANEL'S DROP
                ZONE. That one stores a capture against a subject. This one is the end of a loop the
                design already invites: the capture format is JSON *specifically* so it can be
                hand-edited, so download-edit-play is a first-class workflow and it was
                the one path that still went through three separate screens.

                IT CANNOT SKIP THE STORING STEP, and pretending otherwise would be the wrong
                shortcut. A playback reads its capture out of Storage -- `playback_jobs` holds a
                path, and the worker is confined by RLS to the object its running job names -- so a
                file has to land somewhere before it can be published. What this does is chain the
                two dialogs: file in, subject confirmed, then straight into the playback dialog with
                the new capture selected.

                THE SUBJECT IS GUESSED FROM THE FILE, not assumed. A capture records the edge node
                it came from, so an edited file usually belongs to the subject it was downloaded
                from -- but "usually" is why the dialog still shows the choice. */}
            {canManage && (
              <div
                role="button"
                tabIndex={0}
                aria-label="Publish a capture file"
                onClick={() => playFileRef.current?.click()}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') playFileRef.current?.click() }}
                onDragOver={e => { e.preventDefault(); setDraggingPlay(true) }}
                onDragLeave={() => setDraggingPlay(false)}
                onDrop={e => {
                  e.preventDefault()
                  setDraggingPlay(false)
                  const dropped = e.dataTransfer?.files?.[0]
                  if (dropped) onPlayFileChosen(dropped)
                }}
                style={{
                  marginTop: '12px', padding: '12px', textAlign: 'center', cursor: 'pointer',
                  border: `1px dashed ${draggingPlay ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: '8px',
                  background: draggingPlay ? 'rgba(0,212,255,0.06)' : 'transparent',
                  fontSize: '12px', color: 'var(--text-muted)'
                }}
                title="Store a capture file and go straight to publishing it"
              >
                <IconPlay size={13} style={{ verticalAlign: '-2px', marginRight: '6px' }} />
                Drop an edited capture here to store and publish it
              </div>
            )}
          </div>
        </div>

        {/* ==================================================================================== */}
        <div className="card">
          <div className="card-header">
            <h3 className="section-title">
              Capture <span className="section-count">{withCapture}</span>
            </h3>

            {/* THE SUBJECT SWITCH LIVES IN THE HEADER, NOT THE FILTER BAR. It changes WHAT IS
                LISTED rather than narrowing a list, and the counts belong beside it. Same markup
                the Vocabulary panel uses for its standards: `btn btn-sm` with the selected one
                primary, inside a flex `role="tablist"`. */}
            <div
              role="tablist"
              aria-label="Capture subject"
              // 8px, not the 4px this started with: at 4 the two pills read as one segmented
              // control with a hairline in it, which is what a segmented control looks like when
              // it is broken. They are two buttons and should look like two.
              style={{ display: 'flex', gap: '8px', marginLeft: 'auto' }}
            >
              <button
                role="tab"
                aria-selected={subjectKind === 'gateway'}
                className={`btn btn-sm ${subjectKind === 'gateway' ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => { setSubjectKind('gateway'); setSelectedId(null) }}
                title="Record everything one gateway publishes, every device beneath it included"
              >
                Gateways <span className="section-count">{gateways.length}</span>
              </button>
              <button
                role="tab"
                aria-selected={subjectKind === 'device'}
                className={`btn btn-sm ${subjectKind === 'device' ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => { setSubjectKind('device'); setSelectedId(null) }}
                title="Record one device, plus its gateway's birth certificate"
              >
                Devices <span className="section-count">{devices.length}</span>
              </button>
            </div>
          </div>

          <div className="card-body">
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', margin: '0 0 12px' }}>
              Record what a gateway or a single device actually said, and keep it. One capture is
              stored per subject, and a new recording replaces it. Select a row to inspect it,
              upload a capture, or publish one.
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
                  You can read captures and download them. Recording, replacing, publishing and
                  deleting require Administrator or Shopfloor Manager.
                </div>
              </div>
            )}

            <RunningCard job={activeJob} onStop={onStop} stopPending={stopPending} canManage={canManage} />
            <RecentFailures jobs={recentJobs} />

            <div className="filter-bar">
              <select
                className="form-control"
                style={{ width: '190px' }}
                value={storedFilter}
                onChange={e => setStoredFilter(e.target.value)}
                title="Filter by whether a capture is stored for the subject"
                aria-label="Stored capture filter"
              >
                <option value="all">All subjects ({allRows.length})</option>
                <option value="with">With a capture ({withCapture})</option>
                <option value="without">Without a capture ({allRows.length - withCapture})</option>
              </select>

              {/* ONLY ON THE DEVICES TAB, because on the Gateways tab it would filter a list of
                  gateways by gateway. A device's gateway is the one fact about it this page shows
                  that is not its own -- and on a real fleet it is how you find the four devices
                  behind the machine you are actually investigating. */}
              {subjectKind === 'device' && (
                <select
                  className="form-control"
                  style={{ width: '210px' }}
                  value={gatewayFilter}
                  onChange={e => setGatewayFilter(e.target.value)}
                  title="Filter devices by the gateway they publish through"
                  aria-label="Gateway filter"
                >
                  <option value="">All gateways</option>
                  {gateways.map(g => (
                    <option key={g.id} value={g.id}>
                      {g.name} ({devices.filter(d => d.gateway_id === g.id).length})
                    </option>
                  ))}
                </select>
              )}

              <input
                className="form-control"
                style={{ width: '220px' }}
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search name or Sparkplug ID…"
                aria-label="Search subjects"
                title="Filter by display name or wire identity"
              />

              {activeFilterCount > 0 && (
                <button
                  className="btn btn-ghost btn-sm filter-bar-spacer"
                  onClick={() => { setStoredFilter('all'); setSearch(''); setGatewayFilter('') }}
                  title="Clear every filter"
                >
                  <IconX size={13} /> Clear filters ({activeFilterCount})
                </button>
              )}
            </div>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th title={subjectKind === 'gateway'
                    ? 'The edge gateway a capture would record every message from'
                    : 'A single device, recorded with its gateway’s birth certificate'}>
                    {subjectKind === 'gateway' ? 'Gateway' : 'Device'}
                  </th>
                  {subjectKind === 'device' && (
                    <th title="The edge node this device publishes through, and the one a capture of it also records the birth certificate from">
                      Gateway
                    </th>
                  )}
                  <th title="The wire identity. A capture is filed under this, and playback rewrites it onto the target's own assets">
                    Sparkplug ID
                  </th>
                  <th title="The kind of gateway this subject publishes through: Remote (an appliance on the plant network), Host (inside this stack), Simulated (readings generated), Shadow (republishes recorded captures)">
                    Type
                  </th>
                  <th title="The one capture stored for this subject. Recording again replaces it">
                    Stored capture
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={4} style={{ color: 'var(--text-muted)', padding: '14px' }}>
                    {allRows.length === 0
                      ? (subjectKind === 'gateway'
                        ? 'No gateways registered. Create one on the Gateways tab.'
                        : 'No devices bound to a gateway. A device with no gateway has no edge node to record from.')
                      : 'No subject matches these filters.'}
                  </td></tr>
                )}
                {rows.map(row => (
                  <SubjectRow
                    key={row.id}
                    row={row}
                    selected={selectedId === row.id}
                    onSelect={() => setSelectedId(id => id === row.id ? null : row.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ======================================================================================
          THE ACTIONS LEFT THE TABLE AND LIVE HERE.
          Five controls in a last column is what this had, and `.table-wrap` is `overflow-x: auto`,
          so they were the first thing to go off the right-hand edge on a narrow viewport. The panel
          also has room to say WHY an action is unavailable, which a greyed-out icon cannot.
          ====================================================================================== */}
      <ContextPanel
        open={!!selected}
        onClose={() => setSelectedId(null)}
        type={selected?.kind === 'device' ? 'DEVICE' : 'GATEWAY'}
        onCopy={showToast}
        title={selected?.name || ''}
        subtitle={selected && (
          <>
            <span
              className={`badge badge-${gatewayTypeTone(selected.type)}`}
              style={{ fontSize: '11px', marginRight: '6px' }}
              title={gatewayTypeDescription(selected.type)}
            >
              {gatewayTypeLabel(selected.type)}
            </span>
            {capture
              ? `${capture.message_count} message${capture.message_count === 1 ? '' : 's'} stored`
              : 'No capture stored'}
          </>
        )}
        fields={selected ? [
          { label: 'Sparkplug ID', value: selected.sparkplugId, mono: true, copyable: true,
            title: 'The wire identity. A capture is filed under this prefix.' },
          ...(selected.kind === 'device'
            ? [
              { label: 'Via gateway', value: selected.context },
              {
                label: 'Schema',
                // A BUTTON THAT NAVIGATES, not a bare label. The schema is what says which metrics
                // this device is SUPPOSED to publish, and the natural next question from a capture
                // that recorded something unexpected is "what was it meant to send?" -- which lives
                // on the Schemas page. Answering it should not mean copying a name across two tabs.
                value: selectedSchemas.length > 0
                  ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                      {selectedSchemas.map(s => (
                        <button
                          key={s.schema_uuid}
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => onSelectSchema?.(s.schema_uuid)}
                          title={`Open ${s.schema_name} on the Schemas page`}
                          disabled={!onSelectSchema}
                        >
                          {s.schema_name}
                          {s.version ? <span className="section-count" style={{ marginLeft: '6px' }}>v{s.version}</span> : null}
                        </button>
                      ))}
                    </div>
                  )
                  // Not "Not set": a device with no schema is unmodelled, which is a state the
                  // Devices page names and an operator acts on, rather than a blank field.
                  : 'Unmodelled',
                full: true,
                title: selectedSchemas.length > 0
                  ? 'What this device is modelled to publish. Opens on the Schemas page.'
                  : 'No schema is attached, so nothing declares what this device should publish.'
              }
            ]
            : []),
          ...(capture ? [
            { label: 'Recorded', value: formatWhen(capture.recorded_at) },
            { label: 'Size', value: formatSize(capture.size_bytes) },
            { label: 'Messages', value: String(capture.message_count) },
            /* THE RATE IS HERE TO ANSWER "HOW LONG WILL THIS TAKE", which is the question between
               choosing a capture and starting a job. Message count alone does not: 40,000 messages
               is four minutes at 160/s and eleven hours at 1/s, and a playback runs at the recorded
               pace unless the speed multiplier is changed.

               Recorded rather than derived, because the two disagree: this is the rate the plant
               actually published at, while message_count over the window would flatten a burst
               followed by silence into an average that describes neither. */
            ...(typeof capture.manifest?.observed_rate_hz === 'number' ? [{
              label: 'Recorded rate',
              value: `${capture.manifest.observed_rate_hz} msg/s`,
              title: capture.message_count && capture.manifest.observed_rate_hz > 0
                ? `About ${Math.round(capture.message_count / capture.manifest.observed_rate_hz)}s of wall clock to replay at speed 1.`
                : 'The rate the recording was published at. A playback follows it unless the speed is changed.',
            }] : []),
            { label: 'Source', value: capture.source === 'uploaded' ? 'Uploaded' : 'Recorded here' },
            { label: 'Note', value: capture.note, full: true },
            {
              label: 'Birth certificate',
              // The one field on this panel that changes what an operator does next.
              value: capture.manifest?.birth_captured === false
                ? (capture.manifest?.uses_aliases ? 'Not captured — aliases unresolvable' : 'Not captured')
                : 'Captured',
              // Danger only when it actually costs something. A birthless capture of a fleet that
              // publishes full metric names replays fine, and colouring it red said otherwise.
              danger: capture.manifest?.birth_captured === false && !!capture.manifest?.uses_aliases,
              title: capture.manifest?.birth_captured === false
                ? (capture.manifest?.uses_aliases
                  ? 'No birth certificate, and this capture uses metric aliases — a playback cannot resolve them, so every aliased metric is dropped on ingest.'
                  : 'No birth certificate. Every metric carries its full name, so a playback resolves them; it will not announce the devices, which stay OFFLINE until they birth on their own.')
                /* WHERE THE BIRTH CAME FROM, when the recorder had to ask for it. A capture that
                   waited for a natural NBIRTH and one that requested a rebirth are both complete,
                   but only the second interrupted the plant to get there -- which is worth knowing
                   when the same subject is recorded repeatedly. */
                : capture.manifest?.rebirth_requested
                  ? 'The recording contains a birth certificate, obtained by requesting a rebirth from the edge node. A playback can resolve metric aliases and announce the devices.'
                  : 'The recording contains a birth certificate, so a playback can resolve metric aliases and announce the devices.',
              full: true
            }
          ] : [])
        ] : []}
        beforeActions={(capture?.manifest?.metric_names?.length > 0
          || capture?.manifest?.device_ids?.length > 0) && (
          <>
          {/* WHAT A REPLAY WILL CREATE, ANSWERED BEFORE ONE IS STARTED.
              `ensure_shadow_devices()` mints one lane per device THIS CAPTURE recorded, so this
              list is exactly the set of shadow devices a playback will bring into being -- and the
              only place to see it without starting a job and counting what appears.

              IT IS ALSO HOW YOU TELL TWO CAPTURES APART. A gateway's recording and one of its
              devices' recordings have the same subject name, the same schema and similar sizes;
              the device list is what distinguishes "the whole cell" from "one machine".

              Edge nodes are shown beside them because an UPLOADED capture can carry a node this
              stack has never seen. `start_playback_job()` will still replay it under the target
              gateway, so the recorded ids are the only evidence of where the file came from. */}
          {capture?.manifest?.device_ids?.length > 0 && (
            <div style={{ marginBottom: '12px' }}>
              <div className="context-panel-section-label">
                Devices In This Capture
                <span className="section-count" style={{ marginLeft: '6px' }}>
                  {capture.manifest.device_ids.length}
                </span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                {capture.manifest.device_ids.map(id => (
                  <span key={id} className="badge badge-neutral mono" style={{ fontSize: '11px' }}
                        title={`A playback of this capture creates one replay lane for ${id}`}>
                    {id}
                  </span>
                ))}
              </div>
              {capture.manifest.edge_node_ids?.length > 0 && (
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
                  Recorded under{' '}
                  <span className="mono">{capture.manifest.edge_node_ids.join(', ')}</span>
                  {/* Named rather than implied: a replay publishes as the PLAYBACK gateway, not as
                      whatever recorded it, which is the whole reason a recording cannot be mistaken
                      for live plant data. */}
                  {' '}— a replay republishes under the Playback gateway, not under this.
                </div>
              )}
            </div>
          )}
          {capture?.manifest?.metric_names?.length > 0 && (
          <div>
            <div className="context-panel-section-label">
              Captured Metrics
              <span className="section-count" style={{ marginLeft: '6px' }}>
                {capture.manifest.metric_name_count ?? capture.manifest.metric_names.length}
              </span>
            </div>
            {/* PILLS RATHER THAN A COMMA-SEPARATED RUN. A Sparkplug metric name is a path --
                `Axes/X/POSITION` -- so a comma list of them is a wall of slashes in which the
                boundary between one name and the next is the least visible character. Each pill is
                one metric, which is the unit an operator is scanning for. */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
              {capture.manifest.metric_names.map(name => (
                <span
                  key={name}
                  className="badge badge-neutral"
                  style={{ fontSize: '11px' }}
                  title={name}
                >
                  {name}
                </span>
              ))}
              {/* The cap is the database's, not this list's -- see capped_capture_manifest(). Said
                  out loud so a short list is not read as a short capture. */}
              {capture.manifest.metric_name_count > capture.manifest.metric_names.length && (
                <span
                  className="badge"
                  style={{ fontSize: '11px', color: 'var(--text-dim)' }}
                  title="capped_capture_manifest() keeps the first 50 names and records the true total beside them, so a chatty device cannot put a thousand into one column"
                >
                  +{capture.manifest.metric_name_count - capture.manifest.metric_names.length} more
                </span>
              )}
            </div>
          </div>
          )}
          </>
        )}
        actions={selected ? [
          canManage && {
            label: capture ? 'Record again' : 'Record capture',
            icon: <IconRecord size={13} />,
            primary: true,
            disabled: !!activeJob,
            title: activeJob
              ? 'A capture is already running. One at a time on this stack.'
              : capture
                ? 'Record again — this replaces the stored capture'
                : 'Record this subject',
            onClick: () => setStartFor(selected)
          },
          canManage && capture && {
            label: 'Play back…',
            icon: <IconPlay size={13} />,
            disabled: !!activePlayback,
            title: activePlayback
              ? 'A playback is already running'
              : 'Publish this capture onto a simulated gateway',
            onClick: () => setPlayFor(capture)
          },
          capture && {
            label: 'Download',
            icon: <IconDownload size={13} />,
            pending: busyId === capture.id,
            pendingLabel: 'Preparing…',
            title: 'Download the capture file',
            onClick: () => onDownload(capture)
          },
          canManage && capture && {
            label: 'Delete capture',
            icon: <IconTrash size={13} />,
            danger: true,
            title: 'Remove this capture and its file',
            onClick: () => setDeleteFor(capture)
          }
        ].filter(Boolean) : []}
      >
        {/* THE DROP ZONE KNOWS ITS SUBJECT, which the page-level one it replaces did not — that one
            had to ask afterwards. This is the Model3DUploader gesture on the Devices page: a
            control that belongs to the entity the panel is describing. */}
        {canManage && selected && (
          <div>
            <div className="context-panel-section-label">
              {capture ? 'Replace by upload' : 'Upload a capture'}
            </div>
            <div
              role="button"
              tabIndex={0}
              aria-label={`Upload a capture for ${selected.name}`}
              onClick={() => fileRef.current?.click()}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') fileRef.current?.click() }}
              onDragOver={e => { e.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={e => {
                e.preventDefault()
                setDragging(false)
                const dropped = e.dataTransfer?.files?.[0]
                if (dropped) setUploadFile({ file: dropped, preset: { kind: selected.kind, id: selected.id } })
              }}
              style={{
                padding: '12px', textAlign: 'center', cursor: 'pointer',
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
          </div>
        )}
      </ContextPanel>

      {/* TWO INPUTS, because the two drop zones do different things with what they are given: one
          stores a capture against the selected subject, the other stores it and then publishes it.
          Sharing one input would mean a flag deciding which errand a file was on, set by whichever
          zone was clicked last -- and a stale flag would silently publish a file somebody meant
          only to store. */}
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        style={{ display: 'none' }}
        onChange={onFilePicked}
      />
      <input
        ref={playFileRef}
        type="file"
        accept=".json,application/json"
        style={{ display: 'none' }}
        onChange={onPlayFilePicked}
      />

      {uploadFile && (
        <UploadCaptureModal
          file={uploadFile.file}
          subjects={allSubjects}
          presetSubject={uploadFile.preset
            ? allSubjects.find(s => s.kind === uploadFile.preset.kind && s.id === uploadFile.preset.id)
            : null}
          onConfirm={onUpload}
          onCancel={() => { setUploadFile(null); setPlayAfterUpload(false) }}
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
    </div>
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
    <div className="callout" style={{ borderColor: 'var(--accent)', marginBottom: '12px' }}>
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
          <>
            {/* A BAR FOR THE CLOCK, NUMBERS FOR THE OTHER TWO CAPS, and the split is the point.
                A recording stops at whichever of THREE limits binds first -- duration, 100,000
                messages, 50 MiB -- so a single bar at 10% would promise 90% remaining when the
                message cap might fire in two seconds. The bar is labelled as the DURATION only and
                the other two stay as figures beside it, which is the same reason this card counts
                up rather than down. */}
            <div
              style={{
                height: '4px', borderRadius: '2px', background: 'var(--bg-glass)',
                overflow: 'hidden', margin: '8px 0 6px'
              }}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={job.max_seconds}
              aria-valuenow={Math.min(job.elapsed_seconds, job.max_seconds)}
              aria-label="Elapsed against the duration cap"
              // The caps are NOT NULL columns, so they are always present on a real row -- but the
              // title is cosmetic and must not be the thing that throws if one is ever absent.
              title={`${job.elapsed_seconds}s of the ${job.max_seconds}s duration cap.`
                + (job.max_messages && job.max_bytes
                  ? ` The recording also stops at ${job.max_messages.toLocaleString()} messages or ${formatSize(job.max_bytes)}, whichever comes first.`
                  : '')}
            >
              <div
                style={{
                  width: `${Math.min(100, (job.elapsed_seconds / Math.max(job.max_seconds, 1)) * 100)}%`,
                  height: '100%', background: 'var(--accent)', transition: 'width 1s linear'
                }}
              />
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
              {job.elapsed_seconds}s of {job.max_seconds}s ·{' '}
              {job.messages} message{job.messages === 1 ? '' : 's'} · {formatSize(job.bytes)}
              {' · '}
              {job.birth_captured ? 'birth certificate captured' : 'no birth certificate yet'}
            </div>
          </>
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
 * The playback in flight, or the reason there is not one.
 *
 * IT RENDERS AN EMPTY STATE RATHER THAN NOTHING, unlike the capture card above it. This one owns a
 * card of its own, and a card whose body disappears entirely reads as a broken section rather than
 * an idle one — and the empty state is where the two-step "select a capture, then publish it"
 * gets explained.
 */
function PlaybackCard({ job, onStop, stopPending, canManage }) {
  if (!job) {
    return (
      <div style={{ color: 'var(--text-dim)', fontSize: '12px', padding: '10px 0' }}>
        Nothing is publishing. Select a subject with a stored capture below, then choose
        <strong> Play back</strong> — the dialog asks which simulated gateway to publish as, and
        maps each captured device onto one of that gateway's own.
      </div>
    )
  }

  const target = job.gateways?.name || job.target_edge_node_id
  const pending = job.status === 'PENDING'
  const total = job.messages_total || 0

  return (
    <div className="callout" style={{ borderColor: 'var(--accent)' }}>
      <IconPlay size={14} className="callout-icon" />
      <div style={{ flex: 1 }}>
        <div>
          <strong>{pending ? 'Queued' : 'Publishing'} as {target}</strong>
          <span style={{ color: 'var(--text-muted)' }}> · {job.speed}× speed</span>
        </div>
        {/* A BAR IS UNAMBIGUOUS HERE, WHICH IT IS NOT ON THE CAPTURE CARD ABOVE.
            A recording stops at whichever of three caps binds first, so a single bar there would
            promise remaining time the message cap might take away. A playback has exactly one
            total -- the messages in the plan -- so the fraction means what it looks like.

            RENDERED ONLY WHEN THE TOTAL IS KNOWN AND THE JOB HAS STARTED. `messages_total` is
            written by the worker's first progress call, so a queued job has none; a bar at 0% with
            no denominator would say "nothing has happened" when the truth is "nothing has been
            measured yet", and the line below already says which. */}
        {!pending && total > 0 && (
          <div
            style={{
              height: '4px', borderRadius: '2px', background: 'var(--bg-glass)',
              overflow: 'hidden', margin: '8px 0 6px'
            }}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={Math.min(job.messages_sent, total)}
            aria-label="Messages published against the capture's total"
            title={`${job.messages_sent} of ${total} messages published at ${job.speed}× speed.`}
          >
            <div
              style={{
                width: `${Math.min(100, (job.messages_sent / Math.max(total, 1)) * 100)}%`,
                height: '100%', background: 'var(--accent)', transition: 'width 1s linear'
              }}
            />
          </div>
        )}
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

/**
 * How long a finished failure stays on the page.
 *
 * IT USED TO BE FOREVER, and that was wrong in a way a screenshot made obvious: the query takes the
 * last four finished jobs, so a failure sat at the top of the page until four more jobs pushed it
 * out — which on a stack where nobody captures daily is indefinitely. It read as a live fault.
 *
 * This banner exists to explain "the thing you just did failed", because the running card clears on
 * failure and the table otherwise looks exactly as it did before. That job is minutes old. Anything
 * older is history, and history belongs in the job record rather than shouting from a card.
 */
const FAILURE_VISIBLE_MS = 15 * 60 * 1000

/**
 * Which failures this viewer has already read.
 *
 * DISMISSAL HAS TO SURVIVE A RELOAD, which is the whole complaint: a banner that comes back when
 * the page does has not been dismissed, it has been hidden until the next render. `localStorage`
 * is the right home -- "I have read this" is a fact about one person at one browser, not about the
 * job, and putting it in the database would mean one operator's acknowledgement silently clearing
 * the notice for everybody else.
 *
 * Every accessor is wrapped: a private window, cleared site data, or a browser set to refuse
 * storage all throw here rather than returning empty, and a page that fails to render a table
 * because it could not read a dismissal list would be a far worse bug than the one being fixed.
 */
const DISMISSED_KEY = 'acs-cymru.capture.dismissed-failures'

function readDismissed() {
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY)
    return new Set(raw ? JSON.parse(raw) : [])
  } catch {
    return new Set()
  }
}

function writeDismissed(ids) {
  try {
    // CAPPED, because this list is only ever appended to. A stack that has run for a year would
    // otherwise carry every failure id it has ever shown, and the 15-minute window means anything
    // older than the last few is unreachable anyway.
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids].slice(-50)))
  } catch {
    // Nothing to do and nothing worth saying: the banner simply reappears on the next load.
  }
}

/**
 * A failure that has just happened, until it is read.
 *
 * TWO WAYS OUT, AND BOTH ARE DELIBERATE. The 15-minute window handles the operator who never
 * returns to this page; the dismiss button handles the one who is looking at it now and wants it
 * gone. Neither alone is enough -- the window left a notice sitting there for a quarter of an hour
 * with no way to say "seen it", and dismissal alone would leave a year-old failure waiting for
 * somebody to click it.
 *
 * NOT A MODAL, which is what was asked for, and the reason is when these arrive. A capture fails
 * asynchronously and the page may not be open; a dialog would then be waiting to block whatever
 * the operator came to the page to do, for something that happened ten minutes ago. Worse, three
 * failures would be three dialogs. Dismissal is the acknowledgement a modal was for, without
 * seizing the page to get it.
 */
function RecentFailures({ jobs, kind = 'capture' }) {
  const [dismissed, setDismissed] = useState(readDismissed)

  const dismiss = (id) => setDismissed(prev => {
    const next = new Set(prev)
    next.add(id)
    writeDismissed(next)
    return next
  })

  const cutoff = Date.now() - FAILURE_VISIBLE_MS
  const failed = (jobs || []).filter(j => {
    if (j.status !== 'FAILED' && j.status !== 'CANCELLED') return false
    if (dismissed.has(j.id)) return false
    // No finished_at means it has only just been written; show it rather than hiding a fresh one.
    if (!j.finished_at) return true
    const at = new Date(j.finished_at).getTime()
    return Number.isNaN(at) || at >= cutoff
  })
  if (failed.length === 0) return null

  return (
    <div style={{ marginBottom: '12px' }}>
      {failed.map(job => (
        <div key={job.id} className="callout" style={{ borderColor: 'var(--danger)', marginTop: '6px' }}>
          <IconShieldAlert size={14} className="callout-icon" />
          <div style={{ fontSize: '12px', flex: 1 }}>
            <strong>
              {job.devices?.name || job.gateways?.name
                || job.subject_sparkplug_id || job.target_edge_node_id}
            </strong>
            {' — '}{kind === 'playback' ? 'playback ' : ''}
            {job.status === 'CANCELLED' ? 'cancelled' : 'failed'}
            {job.error ? `: ${job.error}` : '.'}
          </div>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => dismiss(job.id)}
            title="Dismiss this notice. It will not come back, on this browser."
            aria-label={`Dismiss the ${kind} failure notice`}
          >
            <IconX size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}

function SubjectRow({ row, selected, onSelect }) {
  const capture = row.capture
  return (
    <tr
      className={`row-selectable${selected ? ' row-selected' : ''}`}
      onClick={rowSelectHandler(onSelect)}
      title="Click to inspect this subject in the details panel"
    >
      <td>{row.name}</td>
      {row.kind === 'device' && (
        <td style={{ color: 'var(--text-muted)', fontSize: '12px' }}>{row.context}</td>
      )}
      <td><CopyableId value={row.sparkplugId} label="Sparkplug ID" /></td>
      {/* A COLUMN RATHER THAN A BADGE ON THE NAME, matching the Gateways page. The badge said
          SIMULATED or nothing, which left three of the four kinds looking identical -- and on this
          page the kind decides something: only a simulated gateway may be a playback target, and a
          shadow one is where a playback lands. */}
      <td>
        <span
          className={`badge badge-${gatewayTypeTone(row.type)}`}
          style={{ fontSize: '11px' }}
          title={gatewayTypeDescription(row.type)}
        >
          {gatewayTypeLabel(row.type)}
        </span>
      </td>
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
              {/* THE ONE BADGE IN THIS TABLE THAT CHANGES A DECISION. Everything else here is
                  provenance; this says whether the file will actually replay. */}
              {/* THE OLD TOOLTIP SAID THIS CAPTURE "drops every metric", AND THAT WAS NOT TRUE.
                  A missing birth certificate costs metrics only when the recording actually depends
                  on the alias table -- a metric carrying an alias and no name. This fleet publishes
                  full names, so its birthless captures replay perfectly well, and the warning was
                  telling operators their good capture was broken. `uses_aliases` is recorded at
                  capture time so the two cases can be told apart instead of assumed. */}
              {capture.manifest?.birth_captured === false && (
                <span
                  className={`badge ${capture.manifest?.uses_aliases ? 'badge-warning' : 'badge-neutral'}`}
                  style={{ fontSize: '11px', marginLeft: '6px' }}
                  title={capture.manifest?.uses_aliases
                    ? 'No NBIRTH or DBIRTH was recorded and this capture uses metric aliases, so a playback cannot resolve them: every aliased metric is dropped on ingest.'
                    : 'No NBIRTH or DBIRTH was recorded. Every metric here carries its full name, so a playback still resolves them — but it will not announce the devices, which stay OFFLINE until they birth on their own.'}
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
