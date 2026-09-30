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
import { HelpTip } from '../common/HelpTip'
import { PageHeading } from '../common/PageHeading'

/**
 * Recording the broker, and publishing a recording back.
 *
 * Nothing on this page records or publishes: a browser cannot open an MQTT subscription, so the
 * page queues a row and the ingestion daemon (capture) or the playback worker (publication) does
 * the work, with results arriving over Realtime. Two cards, because capture reads the wire and
 * playback writes into the historian under a gateway's identity. One capture at a time and one
 * stored capture per subject are partial unique indexes, not rules of this component. The role
 * gates mirror the RLS: SELECT for Administrator, Shopfloor_Manager and Auditor, writes for the
 * first two.
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

  // Loading
  const loadSubjects = useCallback(async () => {
    const [gws, devs, schemaList] = await Promise.all([
      api.get('/api/v1/gateways'),
      api.get('/api/v1/devices'),
      // Read only to name a device's schema in the panel; defaulted rather than allowed to reject
      // the batch.
      api.get('/api/v1/schemas').catch(() => [])
    ])
    setSchemas(schemaList || [])
    // WHAT IS NOT A CAPTURE SUBJECT, decided once here rather than per consumer -- the tab counts,
    // the gateway filter and the upload dialog all read these two lists and must agree with the
    // table. Archived: `start_capture_job()` refuses them, since an archived gateway publishes
    // nothing. The playback lane: a shadow gateway publishes only while a playback runs, and its
    // shadow devices exist to receive a replay, so recording one records a recording.
    // `playbackTargets()` is a different query for a different question, and the RPC does not
    // refuse a shadow subject -- this is the only thing that keeps one off the page.
    setGateways((gws || []).filter(g => !g.is_archived && !g.is_shadow))
    setDevices((devs || []).filter(d => !d.is_archived && d.gateway_id && !d.shadow_of))
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
   * Progress arrives over Realtime, which is why both job tables are in the publication with
   * REPLICA IDENTITY FULL. Paired with a timer because Realtime has no replay: a job finishing
   * during a dropped socket would otherwise count up forever. The timer runs only while something
   * is in flight.
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

  // Rows
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
    const source = subjectKind === 'gateway' ? gateways : devices
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
      // The type of the gateway, for a device row as much as a gateway one: a device's readings are
      // as synthetic as the edge node publishing them. `gatewayType()` applies the lane precedence
      // so Shadow does not present as Simulated.
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

  // Resolved from the current rows rather than captured on click: this page refreshes on a timer
  // and over Realtime, so a held object would freeze.
  const selected = allRows.find(r => r.id === selectedId) || null

  // `schemasForDevice` handles both attachment paths -- the device_submodels join and the legacy
  // 1:1 `schema_id` -- in one place, which is why it is used rather than reading either directly.
  const selectedSchemas = useMemo(
    () => (selected?.device ? schemasForDevice(selected.device, schemas) : []),
    [selected, schemas]
  )

  // Actions
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
   * A file dropped on the Playback card: store it, then publish it. The subject is inferred from
   * the file's `identities` and offered, not assumed. The file is read twice on purpose:
   * UploadCaptureModal does the validation, so this guess is not a second definition of a valid
   * capture.
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

    // Straight into the playback dialog when the file arrived on the Playback card. Built from what
    // the upload returned rather than found in the refreshed list.
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

        <PageHeading icon={<IconRecord size={15} />} title="Capture and playback">
          What the plant actually published, kept verbatim and replayed on demand. A capture is one
          recording per subject, so a new one replaces it; a playback republishes a stored capture
          through the real broker and the real ingestion path, as a simulated gateway.
        </PageHeading>

        {/* Playback in a card of its own, above capture: it writes into the historian under a
            gateway's identity. */}
        <div className="card" style={{ marginBottom: 'var(--stack)' }}>
          <div className="card-header">
            <h3 className="section-title">
              Playback
              <HelpTip
                label="About playback"
                text="Publish a stored capture back into the stack as a simulated gateway, through the real broker and ingestion path, rebased onto now. Captured identities are rewritten onto the target's own assets."
              />
            </h3>
          </div>

          <div className="card-body">
            <PlaybackCard
              job={activePlayback}
              onStop={onStopPlayback}
              stopPending={stopPlayPending}
              canManage={canManage}
            />
            <RecentFailures jobs={recentPlaybacks} kind="playback" />
            <RecentDiscards jobs={recentPlaybacks} />

            {/* Publish a file straight from disk, chaining the two dialogs: file in, subject
                confirmed, then the playback dialog with the new capture selected. It cannot skip
                the storing step, because a playback reads its capture out of Storage and the worker
                is confined by RLS to the object its job names. */}
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
              Capture
              <HelpTip
                label="About capture"
                text="Record what a gateway or a single device actually said, and keep it. One capture per subject; recording again replaces it. Select a row to inspect, upload or publish."
              />
            </h3>

            {/* The subject switch lives in the header because it changes what is listed rather than
                narrowing it. Same markup the Vocabulary panel uses for its standards. */}
            <div
              role="tablist"
              aria-label="Capture subject"
              // 8px, so the two pills read as two buttons rather than a broken segmented control.
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

              {/* Only on the Devices tab, where a device's gateway is how the four devices behind
                  one machine are found. */}
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

      {/* The actions left the table and live here: five controls in a last column went off the
          right-hand edge on a narrow viewport, and the panel has room to say why an action is
          unavailable. */}
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
                // A button that navigates: the schema says which metrics this device is supposed to
                // publish, which is the next question after a capture recorded something
                // unexpected.
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
                          {s.version ? <span className="badge badge-neutral" style={{ marginLeft: '6px' }}>v{s.version}</span> : null}
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
            /* The rate answers how long a replay will take, which the message count alone does not.
               Recorded rather than derived: an average over the window would flatten a burst
               followed by silence. */
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
                /* Where the birth came from when the recorder had to ask for it: only a requested
                   rebirth interrupted the plant. */
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
          {/* What a replay will create: `ensure_shadow_devices()` mints one lane per device this
              capture recorded. It is also how a gateway's recording and one of its devices'
              recordings are told apart. Edge nodes are shown because an uploaded capture can carry
              a node this stack has never seen. */}
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
                  {/* Named rather than implied: a replay publishes as the Playback gateway, not as
                      whatever recorded it. */}
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
            {/* Pills rather than a comma-separated run: a Sparkplug metric name is a path, and each
                pill is one metric. */}
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
        {/* The drop zone knows its subject, like the Model3DUploader on the Devices page: a control
            that belongs to the entity the panel describes. */}
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

      {/* Two inputs, because the two drop zones do different things with a file: one stores it, the
          other stores and publishes it. A shared input with a flag could publish a file somebody
          meant only to store. */}
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
 * The one running capture. Counts up rather than down: the recording stops at whichever of three
 * caps binds first, so a countdown would be a promise the message or size cap can break.
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
            {/* A bar for the clock and numbers for the other two caps: a single bar at 10% would
                promise 90% remaining when the message cap might fire in two seconds. */}
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
        {/* The banner settles rather than vanishing: it also resolves into `birth_captured` on the
            finished record, where a file that cannot replay properly stops looking identical to one
            that can. */}
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
 * The playback in flight, or the reason there is not one. It renders an empty state rather than
 * nothing: this card owns its own box, and the empty state explains the select-then-publish step.
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
        {/* A bar is unambiguous here, unlike the capture card: a playback has exactly one total.
            Rendered only once `messages_total` is written by the worker's first progress call, so a
            queued job shows no bar at 0%. */}
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
 * How long a finished failure stays on the page. This banner explains that the thing you just did
 * failed; anything older is history in the job record.
 */
const FAILURE_VISIBLE_MS = 15 * 60 * 1000

/**
 * Which failures this viewer has already read. Dismissal must survive a reload, and it is a fact
 * about one person at one browser, so `localStorage` rather than the database. Every accessor is
 * wrapped because a private window or a browser refusing storage throws.
 */
const DISMISSED_KEY = 'aber.capture.dismissed-failures'

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
    // Capped: the list is only appended to, and the 15-minute window makes older ids unreachable.
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids].slice(-50)))
  } catch {
    // Nothing to do and nothing worth saying: the banner simply reappears on the next load.
  }
}

/**
 * A failure that has just happened, until it is read. The 15-minute window covers the operator who
 * never returns; the dismiss button covers the one looking now. Not a modal: failures arrive
 * asynchronously, and a dialog would block whatever the operator came to do.
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

/**
 * A playback that succeeded and lost some of its readings on the way in.
 *
 * WHY THIS IS NOT A FAILURE AND NOT NOTHING. The ingestion daemon discards a metric stamped outside
 * its sanity window by COUNTING it, not by refusing it, and nothing travels back to the publisher.
 * So the worker computes, from the plan it is about to publish, how many messages will lose a
 * reading to it, and records that on the job (0109). The job genuinely completed and some readings genuinely
 * arrived — reporting it red would be wrong, and reporting it as an unqualified success is what
 * issue #216 was about. A playback that would have written NOTHING never reaches here: the worker
 * refuses it, and it shows in RecentFailures above with the reason.
 *
 * Shares the dismissal store with RecentFailures, so one notice per job however it is categorised.
 */
function RecentDiscards({ jobs }) {
  const [dismissed, setDismissed] = useState(readDismissed)

  const dismiss = (id) => setDismissed(prev => {
    const next = new Set(prev)
    next.add(id)
    writeDismissed(next)
    return next
  })

  const cutoff = Date.now() - FAILURE_VISIBLE_MS
  const lossy = (jobs || []).filter(j => {
    if (j.status !== 'COMPLETED') return false
    if (!(j.messages_out_of_window > 0)) return false
    if (dismissed.has(j.id)) return false
    if (!j.finished_at) return true
    const at = new Date(j.finished_at).getTime()
    return Number.isNaN(at) || at >= cutoff
  })
  if (lossy.length === 0) return null

  return (
    <div style={{ marginBottom: '12px' }}>
      {lossy.map(job => {
        const lost = job.messages_out_of_window
        const total = job.messages_sent || job.messages_total || 0
        return (
          <div key={job.id} className="callout" style={{ borderColor: 'var(--warning)', marginTop: '6px' }}>
            <IconShieldAlert size={14} className="callout-icon" />
            <div style={{ fontSize: '12px', flex: 1 }}>
              <strong>{job.gateways?.name || job.target_edge_node_id}</strong>
              {' — '}
              {lost} of {total} published message{total === 1 ? '' : 's'} carried timestamps too old
              for the historian, and those readings were discarded on ingest. The playback itself
              succeeded.
              {' '}
              <HelpTip label="Why readings were discarded" text="Playback rebases timestamps onto now but keeps each one's distance from the capture's epoch, so a reading already old when recorded stays too old. Speed is not the cause; correct the capture's timestamps." />
            </div>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => dismiss(job.id)}
              title="Dismiss this notice. It will not come back, on this browser."
              aria-label="Dismiss the discarded-readings notice"
            >
              <IconX size={13} />
            </button>
          </div>
        )
      })}
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
      {/* A column rather than a badge on the name, matching the Gateways page: on this page the
          kind decides something, since only a simulated gateway may be a playback target. */}
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
              {/* A missing birth certificate costs metrics only when the recording depends on the
                  alias table; `uses_aliases` is recorded at capture time so the two cases are told
                  apart rather than assumed. */}
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

/** Bytes → a short human string. Local rather than shared: the only other one is the 3D uploader's,
 *  and that is tuned for megabyte models. */
function formatSize(bytes) {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** A timestamp an operator can compare with their own memory of the shift. */
function formatWhen(iso) {
  if (!iso) return 'at an unknown time'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'at an unknown time'
  return date.toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
  })
}
