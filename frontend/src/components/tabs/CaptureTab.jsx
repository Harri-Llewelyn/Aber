import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Callout } from '../common/Callout'
import { captureJobUrl, captureSubjectUrl, schemaUrl } from '../../routes'
import { api, isMachineMetric } from '../../api'
import { playbackWorkerDeployed } from '../../config'
import { REALTIME_ENABLED } from '../../constants'
import { useRealtimeTable } from '../../hooks/useRealtimeTable'
import { usePendingAction } from '../../hooks/usePendingAction'
import { ActionButton } from '../common/ActionButton'
import CopyableId from '../common/CopyableId'
import { gatewayType, gatewayTypeLabel, gatewayTypeDescription, gatewayTypeTone } from '../../utils/gatewayType'
import { ContextPanel, rowSelectHandler } from '../common/ContextPanel'
import { schemasForDevice } from '../../utils/deviceTags'
import { deviceIdentifiers, deviceIdKey } from '../../utils/sparkplugId'
import { ConfirmModal } from '../modals/ConfirmModal'
import { StartCaptureModal } from '../modals/StartCaptureModal'
import { StartPlaybackModal } from '../modals/StartPlaybackModal'
import { UploadCaptureModal } from '../modals/UploadCaptureModal'
import { JobHistory } from './CaptureHistory'
import {
  IconCpu, IconDownload, IconPlay, IconRadio, IconRecord, IconTrash,
  IconX
} from '../common/Icons'
import { RecordChip } from '../common/RecordChip'
import { DropZone } from '../common/DropZone'
import { HelpTip } from '../common/HelpTip'
import { CardHeading } from '../common/CardHeading'
import { Badge } from '../common/Badge'
import { TabStrip } from '../common/TabStrip'
import { useUrlList, useUrlState, useUrlTab } from '../../hooks/useUrlState'
import { FilterDropdown } from '../common/FilterChecklist'
import { applyFacets } from '../../utils/listFilters'
import { CAPTURE_TABS } from '../../navigation'
import { useSortableRows } from '../../hooks/useTableSort'
import { SearchInput } from '../common/SearchInput'
import { SortHeader } from '../common/SortHeader'
import { Tooltip } from '../common/Tooltip'
import { ClearFilters } from '../common/ClearFilters'
import { EmptyState } from '../common/EmptyState'
import { LoadingState } from '../common/LoadingState'
import { CAPTURE_FILE, CAPTURE_FILE_LIMIT } from '../../utils/captureFile'
import { breakAfterSeparators, formatBytes, formatDateTime, formatDuration, plural } from '../../utils/format'

// Role checks, as the RLS makes them (`has_role`), not a permission; the title names the same list.
const WRITE_ROLES = ['Administrator', 'Shopfloor_Manager']
const DENIED_TITLE = `Requires ${WRITE_ROLES.map(r => r.replace(/_/g, ' ')).join(' or ')}`

/**
 * The page's tabs (navigation.jsx): the two subjects a capture records, then the finished
 * recordings and playbacks. The description is the tab's tooltip.
 */
export const VIEWS = CAPTURE_TABS
/** The tabs that list subjects, by the subject kind each lists. */
const SUBJECT_KINDS = ['gateway', 'device']
/** The tabs that list finished jobs, by the kind of job each lists. */
const JOB_KINDS = { captures: 'capture', playbacks: 'playback' }
/** The subject tables' filters, which the two subject tabs share. */
const SUBJECT_FILTERS = ['stored', 'search']

/**
 * The query keys a tab opens with. The search stays between the two subject tabs, and between the
 * two job tabs; the stored filter is the subject tabs'. Every other key is left behind, so a tab
 * opens on its own defaults, a `job` narrowing included.
 */
const keptOnTabChange = (from, to) => {
  if (SUBJECT_KINDS.includes(to)) return SUBJECT_KINDS.includes(from) ? SUBJECT_FILTERS : []
  return JOB_KINDS[to] && JOB_KINDS[from] ? ['search'] : []
}

/**
 * Recording the broker, and playing a recording back.
 *
 * Nothing on this page records or plays back: a browser cannot open an MQTT subscription, so the
 * page queues a row and the ingestion daemon (capture) or the playback worker (playback) does
 * the work, with results arriving over Realtime. One card: two tabs list the subjects, two the
 * finished recordings and playbacks, and a capture or playback in flight is a strip above the
 * table on every tab. One capture at a time and one stored capture per subject are partial unique
 * indexes, not rules of this component. The role gates mirror the RLS: SELECT for Administrator,
 * Shopfloor_Manager and Auditor, writes for the first two.
 */

/**
 * The Capture filter's two values; both, like neither, is every subject. A link from before reads
 * `stored=all` as neither.
 */
const STORED_OPTIONS = [
  { value: 'with', label: 'With a capture' },
  { value: 'without', label: 'Without a capture' },
]
const NONE = Object.freeze([])
const STORED_ALIASES = Object.freeze({ all: NONE })

export function CaptureTab({ showToast, userRole, onSelectSchema }) {
  // The tab, in the path: `/capture` (gateways), `/capture/device`, `/capture/captures` or
  // `/capture/playbacks`. The search stays between the two tabs of a kind, and the stored filter
  // between the two subject tabs (keptOnTabChange).
  const [view, setView, viewHref] = useUrlTab('capture', VIEWS.map(v => v.id), 'gateway',
    { keep: next => keptOnTabChange(view, next) })
  // The subject kind the open tab lists, or null on a tab of finished jobs; and the job kind.
  const subjectKind = SUBJECT_KINDS.includes(view) ? view : null
  const jobKind = JOB_KINDS[view] || null
  const [gateways, setGateways] = useState([])
  const [devices, setDevices] = useState([])
  const [captures, setCaptures] = useState([])
  const [activeJob, setActiveJob] = useState(null)
  const [recentJobs, setRecentJobs] = useState([])
  const [activePlayback, setActivePlayback] = useState(null)
  const [recentPlaybacks, setRecentPlaybacks] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // The subject whose drawer is open, in the address as `?subject=`.
  const [selectedId, setSelectedId] = useUrlState('subject')
  const [startFor, setStartFor] = useState(null)
  // { capture, subject } while Delete Capture's dialog is open: a capture is named by its subject.
  const [deleteFor, setDeleteFor] = useState(null)
  const [playFor, setPlayFor] = useState(null)
  // The upload dialog while it is open, `{ file, subject, plays }`: the file once it has one, the drawer's
  // subject when it came from there, and whether the file is played back once it is stored. What opened
  // the dialog sets `plays`, and another file chosen in it keeps it, so a file somebody meant only to
  // store is never played back.
  const [upload, setUpload] = useState(null)
  const [busyId, setBusyId] = useState(null)

  const [storedFilter, setStoredFilter] = useUrlList('stored', NONE, { allowed: ['with', 'without'], aliases: STORED_ALIASES })
  const [gatewayFilter, setGatewayFilter] = useUrlList('gateway', NONE, { allowed: loading ? null : gateways.map(g => g.id) })
  const [search, setSearch] = useUrlState('search')
  // The one job a Captures or Playbacks tab lists, as a notification opens it. Typing a search
  // leaves it: that is a person looking for something else.
  const [jobId, setJobId] = useUrlState('job')
  const onSearch = (text) => { setSearch(text); if (jobId) setJobId('') }
  const [draggingPlay, setDraggingPlay] = useState(false)
  const [schemas, setSchemas] = useState([])
  // Every id a device this site has answers to, as deviceIdKey() keys it, replay lanes left out:
  // what a playback can stand in for. Archived and unbound devices count, as
  // ensure_shadow_devices() counts them.
  const [knownDeviceIds, setKnownDeviceIds] = useState(() => new Set())

  // A depth, not a flag: dragenter and dragleave fire for every child the pointer crosses.
  const dragDepth = useRef(0)
  const [stopPending, runStop] = usePendingAction()
  const [stopPlayPending, runStopPlay] = usePendingAction()

  const canManage = WRITE_ROLES.includes(userRole)

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
    // Not capture subjects, decided once here so the counts, the gateway filter and the upload
    // dialog agree with the table: archived rows and the Playback gateway with its replay lanes,
    // since recording one records a recording. The capture gates refuse all of them too.
    setGateways((gws || []).filter(g => !g.is_archived && !g.is_shadow))
    setDevices((devs || []).filter(d => !d.is_archived && d.gateway_id && !d.shadow_of))
    setKnownDeviceIds(new Set((devs || []).filter(d => !d.shadow_of)
      .flatMap(deviceIdentifiers).map(deviceIdKey)))
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
   * Progress arrives over Realtime: both job tables are in the publication with REPLICA IDENTITY
   * FULL. The timer covers a dropped socket, since Realtime has no replay, and runs only while a
   * job is in flight. `captures` is not published: Realtime tells an unauthenticated subscriber
   * when a published table changes (docs/security-model.md), and an Operator may not read it. The
   * list is re-read on every job change and when the upload dialog opens, and the server decides
   * any replace itself.
   */
  useRealtimeTable(['capture_jobs', 'playback_jobs'], refreshAll,
    { enabled: REALTIME_ENABLED, debounceMs: 400 })

  useEffect(() => {
    if (!activeJob && !activePlayback) return
    const timer = setInterval(refreshAll, REALTIME_ENABLED ? 10000 : 2000)
    return () => clearInterval(timer)
  }, [activeJob, activePlayback, refreshAll])

  // The upload dialog shows what it replaces, so it opens, and takes a file, on the list as it is now.
  useEffect(() => {
    if (upload) loadCaptures().catch(() => {})
  }, [upload, loadCaptures])

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

  // The row, not just the name: a device's Type is its gateway's, decided from `is_simulated` and
  // `deployment`.
  const gatewayById = useMemo(() => {
    const map = new Map()
    for (const g of gateways) map.set(g.id, g)
    return map
  }, [gateways])

  const allRows = useMemo(() => {
    const source = subjectKind === 'gateway' ? gateways : subjectKind === 'device' ? devices : []
    return source.map(subject => ({
      id: subject.id,
      kind: subjectKind,
      name: subject.name,
      sparkplugId: subject.sparkplug_id,
      // The gateway a device row sits under; null for a gateway row.
      context: subjectKind === 'device'
        ? (gatewayName.get(subject.gateway_id) || UNBOUND)
        : null,
      gatewayId: subjectKind === 'device' ? subject.gateway_id : subject.id,
      // The type of the gateway, for a device row as much as a gateway one: a device's readings are
      // as synthetic as the edge node publishing them.
      type: gatewayType(
        subjectKind === 'gateway' ? subject : gatewayById.get(subject.gateway_id)
      ),
      // Carried so the panel can name the device's schema without a second lookup per selection.
      device: subjectKind === 'device' ? subject : null,
      capture: captureBySubject.get(`${subjectKind}:${subject.id}`) || null
    }))
  }, [subjectKind, gateways, devices, captureBySubject, gatewayName, gatewayById])

  // Each list filter is any of its values, and the two combine with AND; each value's count is over
  // what the other filter and the search let through. The gateway filter is the Devices tab's alone.
  const { rows: matchingRows, counts: facetCounts } = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return applyFacets(allRows, [
      { key: 'stored', chosen: storedFilter, values: row => [row.capture ? 'with' : 'without'] },
      { key: 'gateway', chosen: subjectKind === 'device' ? gatewayFilter : NONE, values: row => [row.gatewayId] },
    ], row => !needle || row.name.toLowerCase().includes(needle)
      || (row.sparkplugId || '').toLowerCase().includes(needle))
  }, [allRows, storedFilter, gatewayFilter, search, subjectKind])
  const [rows, sort] = useSortableRows(matchingRows, subjectKind === 'device' ? DEVICE_SORT : GATEWAY_SORT)

  // A filter counts only on a tab that shows it -- otherwise switching tabs with one set would show
  // "Clear filters (1)" for a control that is not on screen. The gateway filter is on Devices only.
  const activeFilterCount = subjectKind ? (
    (storedFilter.length ? 1 : 0)
    + (search.trim() ? 1 : 0)
    + (subjectKind === 'device' && gatewayFilter.length ? 1 : 0)
  ) : jobKind ? (search.trim() ? 1 : 0) + (jobId ? 1 : 0) : 0
  const clearFilters = () => { setStoredFilter([]); setSearch(''); setGatewayFilter([]); setJobId('') }

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

  // A played-back capture's subject, named from its Sparkplug ID, for the Playbacks tab.
  const subjectNameById = useMemo(() => new Map(allSubjects.map(s => [s.sparkplugId, s.name])), [allSubjects])
  const subjectName = useCallback(id => subjectNameById.get(id), [subjectNameById])
  // Changes when a job of the kind the tab lists finishes, which reads that tab's list again.
  const finishedKey = jobs => (jobs[0] ? `${jobs[0].id}:${jobs[0].finished_at}` : '')

  // Resolved from the current rows rather than captured on click: this page refreshes on a timer
  // and over Realtime, so a held object would freeze.
  const selected = allRows.find(r => r.id === selectedId) || null
  // A subject the address names and this tab does not list leaves the address once the rows are in.
  useEffect(() => {
    if (!loading && selectedId && !selected) setSelectedId('')
  }, [loading, selectedId, selected, setSelectedId])

  // `schemasForDevice` resolves the device's attached schemas in one place, as the Devices page does.
  const selectedSchemas = useMemo(
    () => (selected?.device ? schemasForDevice(selected.device, schemas) : []),
    [selected, schemas]
  )

  // Actions
  const onStart = async ({ note, seconds, replace }) => {
    const row = startFor
    const job = await api.startCapture({ subjectKind: row.kind, subjectId: row.id, note, seconds, replace })
    setStartFor(null)
    showToast(`Recording ${row.name}…`, 'success', { to: captureJobUrl('capture', job) })
    await refreshAll()
  }

  const onStop = () => runStop(async () => {
    try {
      const stopped = await api.stopCapture(activeJob.id)
      showToast(stopped ? 'Stopping. The recorder finishes within a second or two.' : 'That capture had already finished.', 'success',
        { to: captureJobUrl('capture', activeJob.id) })
      await refreshAll()
    } catch (err) {
      showToast(err.message, 'error')
    }
  })

  const onPlay = async ({ targetGatewayId, deviceMap, speed }) => {
    const job = await api.startPlayback({ captureId: playFor.id, targetGatewayId, deviceMap, speed })
    setPlayFor(null)
    showToast('Playing back the capture…', 'success', { to: captureJobUrl('playback', job) })
    await refreshAll()
  }

  const onStopPlayback = () => runStopPlay(async () => {
    try {
      const stopped = await api.stopPlayback(activePlayback.id)
      showToast(stopped ? 'Stopping the playback.' : 'That playback had already finished.', 'success', { to: captureJobUrl('playback', activePlayback.id) })
      await refreshAll()
    } catch (err) {
      showToast(err.message, 'error')
    }
  })

  const onDownload = async (capture, subject) => {
    setBusyId(capture.id)
    try {
      const url = await api.captureUrl(capture.storage_path)
      // A signed URL in a new tab rather than a fetch-and-blob: the bucket is private, the link is
      // short-lived, and the browser's own download handling is what an operator expects.
      window.open(url, '_blank', 'noopener')
      showToast(`Downloading the capture of ${subject.name}…`, 'success', { to: captureSubjectUrl(subject.kind, subject.id) })
    } catch (err) {
      showToast(err.message, 'error')
    } finally {
      setBusyId(null)
    }
  }

  // Run from Delete Capture's dialog, which shows a refusal and stays open. Read again either way.
  const onDelete = async () => {
    try {
      await api.deleteCapture(deleteFor.capture)
      setDeleteFor(null)
      showToast('Capture deleted.', 'success')
    } finally {
      await refreshAll()
    }
  }

  /** A file given to the drawer's zone: filed against the drawer's subject, and stored only. */
  const storeFile = (file) => setUpload({ file, subject: { kind: selected.kind, id: selected.id }, plays: false })

  /**
   * "Play a File…", with no file yet, or a file dropped on the card: store it, then play it back. The
   * dialog offers the subject the file names, and assumes none.
   */
  const playFile = (file = null) => setUpload({ file, subject: null, plays: true })

  const onUpload = async ({ subject, replace, expectedCaptureId }) => {
    let stored
    try {
      stored = await api.uploadCapture({
        subjectKind: subject.kind,
        subjectId: subject.id,
        file: upload.file,
        note: upload.file.name,
        replace,
        expectedCaptureId
      })
    } catch (err) {
      // A refusal often means the stored captures changed; the dialog then shows them as they are.
      loadCaptures().catch(() => {})
      throw err
    }
    const { id, path, messages, manifest } = stored
    setUpload(null)
    showToast(`Uploaded ${plural(messages, 'message')} for ${subject.name}.`, 'success', { to: captureSubjectUrl(subject.kind, subject.id) })
    await refreshAll()

    // Straight into the playback dialog when the file came in to be played, built from what the
    // upload returned rather than found in the refreshed list.
    if (upload.plays) {
      setPlayFor({
        id,
        subject_sparkplug_id: subject.sparkplugId,
        message_count: messages,
        note: upload.file.name,
        storage_path: path,
        manifest
      })
    }
  }

  // ------------------------------------------------------------------------------------------
  const capture = selected?.capture || null
  // The machine's metrics: a capture recorded before 1.5 also lists Sparkplug plumbing and identity.
  const listedMetrics = capture?.manifest?.metric_names || []
  const machineMetrics = listedMetrics.filter(isMachineMetric)
  const machineMetricCount = (capture?.manifest?.metric_name_count ?? listedMetrics.length)
    - (listedMetrics.length - machineMetrics.length)

  // Only a dragged file lights the card up; a drop is offered to the roles that can store one.
  const hasFiles = e => Array.from(e.dataTransfer?.types || []).includes('Files')
  const cardDrop = canManage ? {
    onDragEnter: e => {
      if (!hasFiles(e)) return
      dragDepth.current += 1
      setDraggingPlay(true)
    },
    onDragOver: e => { if (hasFiles(e)) e.preventDefault() },
    onDragLeave: () => {
      if (dragDepth.current === 0) return
      dragDepth.current -= 1
      if (dragDepth.current === 0) setDraggingPlay(false)
    },
    onDrop: e => {
      e.preventDefault()
      dragDepth.current = 0
      setDraggingPlay(false)
      const dropped = e.dataTransfer?.files?.[0]
      if (dropped) playFile(dropped)
    },
  } : {}

  return (
    <div className="page-layout page-fill">
      <div className="page-main">

        {/* One card. A file dropped anywhere on it is stored and played back, as "Play a File…"
            does: the panel's own drop zone is the one that only stores. */}
        <div className={`card card-fill capture-card${draggingPlay ? ' capture-card-drop' : ''}`} {...cardDrop}>
          <CardHeading
            icon={<IconRecord size={15} />}
            title="Capture"
            description="What the plant actually published, kept verbatim and played back through the real broker as the Playback gateway."
          />

          <TabStrip
            ariaLabel="Capture"
            value={view}
            onChange={next => { setView(next); setSelectedId(null) }}
            hrefFor={viewHref}
            tabs={VIEWS}
          />

          {/* Play a File… is the page's, on every tab; the filters are the subject tables'. The
              search is on every tab: the finished jobs are read a page at a time, newest first, and
              a search reads on through the older ones. */}
          <div className="filter-bar">
            {(subjectKind || jobKind) && (
              <SearchInput
                value={search}
                onChange={onSearch}
                placeholder={subjectKind ? 'Search name or Sparkplug ID…' : 'Search note, subject, person or status…'}
                ariaLabel={subjectKind ? 'Search subjects' : `Search ${view}`}
              />
            )}
            {subjectKind && (
              <>
                <FilterDropdown
                  label="Capture"
                  noun="subject"
                  plural="choices"
                  options={STORED_OPTIONS}
                  value={storedFilter}
                  onChange={setStoredFilter}
                  counts={facetCounts.stored}
                  everyIsAny
                  width="md"
                />

                {/* Only on the Devices tab, where a device's gateway is how the four devices behind
                    one machine are found. */}
                {subjectKind === 'device' && (
                  <FilterDropdown
                    label="Gateway"
                    noun="gateway"
                    plural="gateways"
                    options={gateways.map(g => ({ value: g.id, label: g.name }))}
                    value={gatewayFilter}
                    onChange={setGatewayFilter}
                    counts={facetCounts.gateway}
                    width="lg"
                  />
                )}
              </>
            )}

            <div className="filter-bar-actions">
              <ClearFilters count={activeFilterCount} onClear={clearFilters} />
              {/* Stored first, then played: the worker reads its capture out of Storage. */}
              <ActionButton
                className="btn btn-primary btn-sm"
                permitted={canManage}
                deniedTitle={DENIED_TITLE}
                onClick={() => playFile()}
                title="Store a capture file and play it straight back. Dropping it on this card does the same."
              >
                <IconPlay size={13} /> Play a File…
              </ActionButton>
            </div>
          </div>

          {/* What is in flight or has just failed, on every tab. Each strip renders nothing when
              there is nothing to say, and the container then collapses (:empty in App.css). */}
          <div className="capture-strips">
            {error && (
              <Callout tone="danger">{error}</Callout>
            )}
            <RunningCard job={activeJob} onStop={onStop} stopPending={stopPending} canManage={canManage} />
            <RecentFailures jobs={recentJobs} />
            <PlaybackStrip
              job={activePlayback}
              onStop={onStopPlayback}
              stopPending={stopPlayPending}
              canManage={canManage}
            />
            <RecentFailures jobs={recentPlaybacks} kind="playback" />
            <RecentDiscards jobs={recentPlaybacks} />
          </div>

          {jobKind ? (
            <JobHistory
              key={jobKind}
              kind={jobKind}
              refreshKey={finishedKey(jobKind === 'capture' ? recentJobs : recentPlaybacks)}
              subjectName={subjectName}
              search={search}
              jobId={jobId}
              onShowAll={() => setJobId('')}
            />
          ) : loading ? (
            <LoadingState label="captures" />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<IconRecord size={36} />}
              filtered={allRows.length > 0}
              message={subjectKind === 'gateway'
                ? 'No gateways yet. Create one on the Gateways page.'
                : 'No devices are bound to a gateway. A device with no gateway has no edge node to record from.'}
              filteredMessage="No subjects match these filters."
            />
          ) : (
          <div className="table-wrap">
            {/* Fits its card: a column the card has no room for goes, and the drawer has it (App.css). */}
            <table className="table-fit">
              <thead>
                <tr>
                  <SortHeader sort={sort} column="name" title={subjectKind === 'gateway'
                    ? 'The edge gateway a capture would record every message from'
                    : 'A single device, recorded with its gateway’s birth certificate'}>
                    {subjectKind === 'gateway' ? 'Gateway' : 'Device'}
                  </SortHeader>
                  {subjectKind === 'device' && (
                    <SortHeader sort={sort} column="gateway" className="fit-1100" title="The edge node it publishes through. A capture of the device also records that node's birth certificate.">
                      Gateway
                    </SortHeader>
                  )}
                  <SortHeader sort={sort} column="sparkplug_id" className="fit-id fit-520" title="The ID Aber issued. A capture is filed under it, and playback rewrites it onto the target's own assets">
                    Sparkplug ID
                  </SortHeader>
                  <SortHeader sort={sort} column="type" className="fit-880" title={"Remote: an appliance on the plant network. Third-party: an edge node Aber does not manage. Host: inside this stack. Simulated: generated readings."}>
                    Type
                  </SortHeader>
                  <SortHeader sort={sort} column="stored" title="The one capture stored for this subject. Recording again replaces it">
                    Stored capture
                  </SortHeader>
                </tr>
              </thead>
              <tbody>
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
          )}

          {draggingPlay && (
            <div className="capture-drop-overlay">
              <IconPlay size={20} />
              <span className="drop-zone-line">Drop the file to store it and play it back</span>
            </div>
          )}
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
        icon={selected?.kind === 'device' ? <IconCpu size={15} /> : <IconRadio size={15} />}
        subtitle={selected && (
          <>
            <Badge
              tone={gatewayTypeTone(selected.type)}
              size="sm"
              className="capture-badge-lead"
              title={gatewayTypeDescription(selected.type)}
            >
              {gatewayTypeLabel(selected.type)}
            </Badge>
            {capture
              ? `${plural(capture.message_count, 'message')} stored`
              : 'No capture stored'}
          </>
        )}
        warnings={captureWarnings(capture)}
        recordId={selected && { label: selected.kind === 'device' ? 'Device UUID' : 'Gateway UUID', value: selected.id }}
        fields={selected ? [
          { label: 'Sparkplug ID', value: selected.sparkplugId, mono: true, copyable: true,
            help: 'The ID Aber issued. A capture is filed under this prefix.' },
          ...(selected.kind === 'device'
            ? [
              { label: 'Via gateway', value: selected.context },
              {
                label: 'Schema',
                // A chip that opens the schema, as the Devices drawer draws it: the schema says which
                // metrics this device is supposed to publish, the next question after a capture
                // recorded something unexpected.
                value: selectedSchemas.length > 0
                  ? (
                    <div className="context-device-list">
                      {selectedSchemas.map(s => (
                        <RecordChip
                          key={s.schema_uuid}
                          kind="schemas"
                          to={schemaUrl(s.schema_uuid)}
                          onNavigate={onSelectSchema ? () => onSelectSchema(s.schema_uuid) : undefined}
                          name={s.schema_name}
                        />
                      ))}
                    </div>
                  )
                  // Not "Not set": a device with no schema is unmodelled, which is a state the
                  // Devices page names and an operator acts on, rather than a blank field.
                  : 'Unmodelled',
                full: true,
                help: selectedSchemas.length > 0
                  ? 'What this device is modelled to publish. Opens on the Schemas page.'
                  : 'No schema is attached, so nothing declares what this device should publish.'
              }
            ]
            : []),
          ...(capture ? [
            { label: 'Recorded', value: formatDateTime(capture.recorded_at) },
            { label: 'Size', value: formatBytes(capture.size_bytes) },
            { label: 'Messages', value: String(capture.message_count) },
            /* How long it ran against what was asked for, and why it stopped: a cap that cut a
               recording short must not read as a full one. Absent from captures made before 1.5. */
            ...(typeof capture.manifest?.duration_ms === 'number' ? [{
              label: 'Duration',
              value: capture.manifest.requested_seconds
                ? `${formatDuration(capture.manifest.duration_ms / 1000)} of ${formatDuration(capture.manifest.requested_seconds)}`
                : formatDuration(capture.manifest.duration_ms / 1000),
              help: capture.source === 'uploaded'
                ? 'How long the file spans, from its first message to its last.'
                : 'How long the recording ran, against the length asked for.'
            }] : []),
            ...(STOP_REASONS[capture.manifest?.stop_reason] ? [{
              label: 'Ended',
              value: STOP_REASONS[capture.manifest.stop_reason].label,
              help: STOP_REASONS[capture.manifest.stop_reason].title,
              danger: !!STOP_REASONS[capture.manifest.stop_reason].cutShort
            }] : []),
            /* The rate answers how long a replay will take, which the message count alone does not.
               Recorded rather than derived: an average over the window would flatten a burst
               followed by silence. */
            ...(typeof capture.manifest?.observed_rate_hz === 'number' ? [{
              label: 'Recorded rate',
              value: `${capture.manifest.observed_rate_hz} msg/s`,
              help: capture.message_count && capture.manifest.observed_rate_hz > 0
                ? `About ${Math.round(capture.message_count / capture.manifest.observed_rate_hz)}s of wall clock to replay at speed 1.`
                : 'The rate the recording was published at. A playback follows it unless the speed is changed.',
            }] : []),
            { label: 'Source', value: capture.source === 'uploaded' ? 'Uploaded' : 'Recorded here' },
            { label: 'Note', value: capture.note, full: true },
            {
              label: 'Birth certificate',
              // The one field on this panel that changes what an operator does next.
              value: capture.manifest?.birth_captured === false ? 'Not captured' : 'Captured',
              // A replay opens with the edge node's NBIRTH, so a playback refuses a capture without one.
              danger: capture.manifest?.birth_captured === false,
              help: capture.manifest?.birth_captured === false
                ? 'No birth certificate, so a playback refuses this capture: a replay opens with the edge node’s birth certificate. Record it again; the recorder asks the edge node for one.'
                /* Where the birth came from when the recorder had to ask for it: only a requested
                   rebirth interrupted the plant. */
                : capture.manifest?.rebirth_requested
                  ? 'The recording contains a birth certificate, obtained by requesting a rebirth from the edge node. A playback can resolve metric aliases and announce the devices.'
                  : 'The recording contains a birth certificate, so a playback can resolve metric aliases and announce the devices.',
              full: true
            }
          ] : [])
        ] : []}
        beforeActions={(machineMetrics.length > 0
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
                <span className="section-count capture-label-count">
                  {capture.manifest.device_ids.length}
                </span>
                <HelpTip label="What a playback makes of these" text="A playback of this capture creates one replay lane for each of these devices." />
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                {capture.manifest.device_ids.map(id => (
                  <Badge key={id} size="sm" className="mono">{id}</Badge>
                ))}
              </div>
              {capture.manifest.edge_node_ids?.length > 0 && (
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
                  Recorded under{' '}
                  <span className="mono">{capture.manifest.edge_node_ids.join(', ')}</span>
                  {' '}— a playback publishes under the Playback gateway, not under this.
                </div>
              )}
            </div>
          )}
          {machineMetrics.length > 0 && (
          <div>
            <div className="context-panel-section-label">
              Captured Metrics
              <span className="section-count capture-label-count">
                {machineMetricCount}
              </span>
            </div>
            {/* Pills rather than a comma-separated run: a Sparkplug metric name is a path, and each
                pill is one metric. */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
              {machineMetrics.map(name => (
                <Badge key={name} size="sm">{name}</Badge>
              ))}
              {/* The cap is the database's, not this list's; said out loud so a short list is not read
                  as a short capture. */}
              {machineMetricCount > machineMetrics.length && (
                <Badge
                  size="sm"
                  title="Only the first 50 metric names are listed; the capture holds them all"
                >
                  +{machineMetricCount - machineMetrics.length} more
                </Badge>
              )}
            </div>
          </div>
          )}
          </>
        )}
        actions={selected ? [
          {
            label: capture ? 'Record Again' : 'Record Capture',
            icon: <IconRecord size={13} />,
            // The one primary: Record for a role that can; Download, below, for one that cannot.
            primary: canManage || !capture,
            disabled: !canManage || !!activeJob,
            title: !canManage
              ? DENIED_TITLE
              : activeJob
                ? 'A capture is already running. One at a time on this stack.'
                : capture
                  ? 'Record again — this replaces the stored capture'
                  : 'Record this subject',
            onClick: () => setStartFor(selected)
          },
          capture && {
            label: 'Play Back…',
            icon: <IconPlay size={13} />,
            disabled: !canManage || !!activePlayback,
            title: !canManage
              ? DENIED_TITLE
              : activePlayback
                ? 'A playback is already running'
                : playbackWorkerDeployed()
                  ? 'Play this capture back onto the Playback gateway'
                  : 'The playback worker is not deployed on this site. The dialog says how to turn it on.',
            onClick: () => setPlayFor(capture)
          },
          capture && {
            label: 'Download',
            icon: <IconDownload size={13} />,
            primary: !canManage,
            pending: busyId === capture.id,
            pendingLabel: 'Preparing…',
            title: 'Download the capture file',
            onClick: () => onDownload(capture, selected)
          },
          capture && {
            label: 'Delete Capture',
            icon: <IconTrash size={13} />,
            danger: true,
            disabled: !canManage,
            title: !canManage ? DENIED_TITLE : 'Remove this capture and its file',
            onClick: () => setDeleteFor({ capture, subject: selected })
          }
        ].filter(Boolean) : []}
      >
        {/* The drop zone knows its subject, like the Model3DUploader on the Devices page: a control
            that belongs to the entity the panel describes. */}
        {selected && (
          <div>
            <div className="context-panel-section-label">
              {capture ? 'Replace by upload' : 'Upload a capture'}
            </div>
            {canManage ? (
              <DropZone
                key={selected.id}
                {...CAPTURE_FILE}
                label={`Upload a capture for ${selected.name}`}
                hint={`A .json file recorded elsewhere, up to ${CAPTURE_FILE_LIMIT}`}
                note="To play it back, every device it recorded must exist on this site."
                onFile={storeFile}
                testId="capture-file"
              />
            ) : (
              <p className="form-hint">{DENIED_TITLE}.</p>
            )}
          </div>
        )}
      </ContextPanel>

      {upload && (
        <UploadCaptureModal
          file={upload.file}
          subjects={allSubjects}
          presetSubject={upload.subject
            ? allSubjects.find(s => s.kind === upload.subject.kind && s.id === upload.subject.id)
            : null}
          forPlayback={upload.plays}
          knownDeviceIds={knownDeviceIds}
          onFile={file => setUpload(open => ({ ...open, file }))}
          onConfirm={onUpload}
          onCancel={() => setUpload(null)}
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
          subjectName={subjectName(playFor.subject_sparkplug_id) || playFor.subject_sparkplug_id}
          knownDeviceIds={knownDeviceIds}
          onConfirm={onPlay}
          onCancel={() => setPlayFor(null)}
          showToast={showToast}
        />
      )}

      {deleteFor && (
        <ConfirmModal
          title="Delete Capture"
          subject={deleteFor.subject.name}
          icon={<IconTrash size={18} />}
          message={`Delete the capture of ${deleteFor.subject.name}, recorded ${formatDateTime(deleteFor.capture.recorded_at)}${deleteFor.capture.note ? ` — ${deleteFor.capture.note}` : ''}? The file is removed from storage and cannot be recovered.`}
          requireTyped={deleteFor.subject.name}
          requireTypedLabel={`${deleteFor.subject.kind} name`}
          confirmLabel="Delete Capture"
          pendingLabel="Deleting…"
          onCancel={() => setDeleteFor(null)}
          onConfirm={onDelete}
        />
      )}
    </div>
  )
}

/** How long a recording may go unreported before Stop ends it outright (request_capture_stop()). */
const STALE_RECORDING_SECONDS = 120

/**
 * The one running capture. Counts up rather than down: the recording stops at whichever of three
 * caps binds first, so a countdown would be a promise the message or size cap can break.
 */
function RunningCard({ job, onStop, stopPending, canManage }) {
  if (!job) return null
  const subject = job.devices?.name || job.gateways?.name || job.subject_sparkplug_id
  const pending = job.status === 'PENDING'
  // The daemon reports every second while recording, so started_at plus elapsed_seconds is its last
  // report. Past two minutes request_capture_stop() ends the job rather than asking the daemon.
  const silentFor = !pending && job.started_at
    ? (Date.now() - new Date(job.started_at).getTime()) / 1000 - (job.elapsed_seconds || 0)
    : 0
  const stale = silentFor > STALE_RECORDING_SECONDS

  return (
    <Callout
      tone="info"
      // A running job's strip: its icon names the job.
      icon={IconRecord}
      action={(
        <ActionButton
          className="btn btn-ghost"
          permitted={canManage}
          deniedTitle={DENIED_TITLE}
          pending={stopPending}
          pendingLabel="Stopping…"
          onClick={onStop}
          title={stale
            ? 'End this recording now. The daemon has stopped reporting on it, so nothing from it is stored.'
            : 'Finish this capture now and keep what it has recorded'}
        >
          Stop
        </ActionButton>
      )}
    >
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
              promise 90% remaining when the message cap might fire in two seconds. The caps are
              NOT NULL columns, but the tooltip must not be the thing that throws if one is absent. */}
          <Tooltip text={job.max_messages && job.max_bytes
            ? `The recording also stops at ${job.max_messages.toLocaleString()} messages or ${formatBytes(job.max_bytes)}, whichever comes first.`
            : null}>
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
            >
              <div
                style={{
                  width: `${Math.min(100, (job.elapsed_seconds / Math.max(job.max_seconds, 1)) * 100)}%`,
                  height: '100%', background: 'var(--accent)', transition: 'width 1s linear'
                }}
              />
            </div>
          </Tooltip>
          <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
            {job.elapsed_seconds}s of {job.max_seconds}s ·{' '}
            {plural(job.messages, 'message')} · {formatBytes(job.bytes)}
            {' · '}
            {job.birth_captured ? 'birth certificate captured' : 'no birth certificate yet'}
          </div>
        </>
      )}
      {stale && (
        <div style={{ color: 'var(--warning-text)', fontSize: '12px', marginTop: '4px' }}>
          The ingestion daemon has not reported on this recording for{' '}
          {formatDuration(silentFor)}. Stop ends it here, and nothing from it is stored. Until
          then no other capture can start.
        </div>
      )}
      {/* Settles into `birth_captured` on the finished record. */}
      {!pending && !job.birth_captured && job.elapsed_seconds > 10 && (
        <div style={{ color: 'var(--warning-text)', fontSize: '12px', marginTop: '4px' }}>
          No <code>NBIRTH</code> has arrived. A playback of a capture without the edge node’s
          birth certificate is refused. The finished capture will be marked <strong>no birth</strong>.
        </div>
      )}
    </Callout>
  )
}

/** The playback queued or in flight, beside the capture's strip. Nothing when none is. */
function PlaybackStrip({ job, onStop, stopPending, canManage }) {
  if (!job) return null

  const target = job.gateways?.name || job.target_edge_node_id
  const pending = job.status === 'PENDING'
  const total = job.messages_total || 0

  return (
    <Callout
      tone="info"
      // A running job's strip: its icon names the job.
      icon={IconPlay}
      action={(
        <ActionButton
          className="btn btn-ghost"
          permitted={canManage}
          deniedTitle={DENIED_TITLE}
          pending={stopPending}
          pendingLabel="Stopping…"
          onClick={onStop}
          title="Stop the playback now. What has already been published stays in the historian."
        >
          Stop
        </ActionButton>
      )}
    >
      <div>
        <strong>{pending ? 'Queued' : 'Playing back'} as {target}</strong>
        <span style={{ color: 'var(--text-muted)' }}> · {job.speed}× speed</span>
      </div>
      {/* A bar is unambiguous here, unlike the capture strip: a playback has exactly one total.
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
          aria-label="Messages played back against the capture's total"
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
          ? (playbackWorkerDeployed()
              ? 'Waiting for the playback worker to pick it up. If this does not start within a few seconds, the worker is not running.'
              : 'Stop this, or set playback.enabled: true in the Helm values and upgrade. The playback worker is not deployed on this site, so it will not start.')
          : `${job.messages_sent}${total ? ` of ${total}` : ''} message${job.messages_sent === 1 ? '' : 's'} played back · ${job.elapsed_seconds}s`}
      </div>
    </Callout>
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
 * A failure, or a cancel, that has just happened, until it is read. A cancel is neutral, not red.
 * The 15-minute window covers the operator who never returns; the dismiss button covers the one
 * looking now. Not a modal: failures arrive asynchronously, and a dialog would block whatever the
 * operator came to do.
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
    <>
      {failed.map(job => {
        // An operator's own cancel is an outcome, not a fault: neutral, and a stopped playback
        // says how far it got.
        const cancelled = job.status === 'CANCELLED'
        const outcome = !cancelled ? 'failed' : kind === 'playback' ? 'stopped' : 'cancelled'
        const reached = job.messages_total
          ? `${job.messages_sent || 0} of ${plural(job.messages_total, 'message')}`
          : plural(job.messages_sent || 0, 'message')
        const detail = job.error ? `: ${job.error}`
          : cancelled && kind === 'playback' ? `: ${reached} published before it was stopped.` : '.'
        return (
          <Callout
            key={job.id}
            tone={cancelled ? 'info' : 'danger'}
            action={(
              <Tooltip text="Dismiss this notice. It will not come back, on this browser.">
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => dismiss(job.id)}
                  aria-label={`Dismiss the ${kind} ${cancelled ? 'outcome' : 'failure'} notice`}
                >
                  <IconX size={13} />
                </button>
              </Tooltip>
            )}
          >
            <strong>
              {job.devices?.name || job.gateways?.name
                || job.subject_sparkplug_id || job.target_edge_node_id}
            </strong>
            {' — '}{kind === 'playback' ? 'playback ' : ''}
            {outcome}
            {detail}
          </Callout>
        )
      })}
    </>
  )
}

/**
 * A playback that completed but lost some readings to the ingestion daemon's timestamp window.
 * The worker records how many messages that affects on the job, so this is a warning, not a
 * failure. A playback that would have written nothing is refused and shows in RecentFailures.
 * Shares that component's dismissal store.
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
    <>
      {lossy.map(job => {
        const lost = job.messages_out_of_window
        const total = job.messages_sent || job.messages_total || 0
        return (
          <Callout
            key={job.id}
            tone="warning"
            action={(
              <Tooltip text="Dismiss this notice. It will not come back, on this browser.">
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => dismiss(job.id)}
                  aria-label="Dismiss the discarded-readings notice"
                >
                  <IconX size={13} />
                </button>
              </Tooltip>
            )}
          >
            <strong>{job.gateways?.name || job.target_edge_node_id}</strong>
            {' — '}
            {lost} of {plural(total, 'published message')} carried timestamps too old or too
            far in the future for the historian, and those readings were discarded on ingest. The
            playback itself succeeded.
            {' '}
            <HelpTip label="Why readings were discarded" text="Playback keeps the gap between a reading's timestamp and its message's arrival. A reading already old when recorded, or stamped by a fast device clock, stays outside the window. A slow speed stretches the gap: try 1x." />
          </Callout>
        )
      })}
    </>
  )
}

/**
 * Why a recording stopped, from the manifest's `stop_reason`. A cap that ended it before the length
 * asked for is `cutShort`: the rest of the window is not in the file.
 */
const STOP_REASONS = {
  duration: { label: 'Ran its full length', title: 'The recording ran for the length asked for.' },
  operator: { label: 'Stopped by an operator', title: 'Someone pressed Stop before the length asked for was up.' },
  message_cap: {
    label: 'Cut short by the message cap',
    title: 'The recording reached its message cap before the length asked for was up, so the rest of that window is not in it.',
    cutShort: true
  },
  size_cap: {
    label: 'Cut short by the size cap',
    title: 'The recording reached its size cap before the length asked for was up, so the rest of that window is not in it.',
    cutShort: true
  },
  restart: {
    label: 'Cut short by a restart',
    title: 'The ingestion service restarted before the length asked for was up. It stored what it had recorded, so the rest of that window is not in it.',
    cutShort: true
  }
}

/** What the drawer's top says is wrong with a stored capture: no birth, or a recording cut short. */
const captureWarnings = (capture) => {
  if (!capture) return []
  const stopped = STOP_REASONS[capture.manifest?.stop_reason]
  return [
    capture.manifest?.birth_captured === false && {
      id: 'no-birth',
      tone: 'danger',
      text: 'No birth certificate, so a playback refuses this capture. Record it again; the recorder asks the edge node for one.'
    },
    stopped?.cutShort && { id: 'cut-short', tone: 'danger', text: `${stopped.label}. ${stopped.title}` },
  ]
}

/** What a device row's Gateway column says when the device is bound to no gateway. */
const UNBOUND = 'Unbound'

/**
 * The subject table's sortable columns. Stored capture sorts by when the capture was recorded, and
 * a subject with none goes last, as does a device bound to no gateway.
 */
const GATEWAY_SORT = {
  name: { type: 'text', value: row => row.name },
  sparkplug_id: { type: 'text', value: row => row.sparkplugId },
  type: { type: 'text', value: row => gatewayTypeLabel(row.type) },
  stored: { type: 'time', value: row => row.capture?.recorded_at }
}
const DEVICE_SORT = { ...GATEWAY_SORT, gateway: { type: 'text', value: row => (row.context === UNBOUND ? null : row.context) } }

function SubjectRow({ row, selected, onSelect }) {
  const capture = row.capture
  return (
    <tr
      className={`row-selectable${selected ? ' row-selected' : ''}`}
      tabIndex={0}
      onClick={rowSelectHandler(onSelect)}
      // Enter or Space on the row itself; a key pressed on the copy chip inside it stays the chip's.
      onKeyDown={e => {
        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
        e.preventDefault()
        onSelect()
      }}
    >
      <td>{breakAfterSeparators(row.name)}</td>
      {row.kind === 'device' && (
        <td className="fit-1100" style={{ color: 'var(--text-muted)', fontSize: '12px' }}>{breakAfterSeparators(row.context)}</td>
      )}
      <td className="fit-id fit-520"><CopyableId value={row.sparkplugId} label="Sparkplug ID" /></td>
      {/* A column rather than a badge on the name, matching the Gateways page. */}
      <td className="fit-880">
        <Badge tone={gatewayTypeTone(row.type)} size="sm">
          {gatewayTypeLabel(row.type)}
        </Badge>
      </td>
      <td>
        {!capture && <span style={{ color: 'var(--text-dim)' }}>—</span>}
        {capture && (
          <div style={{ fontSize: '12px' }}>
            <div>
              {plural(capture.message_count, 'message')} ·{' '}
              {formatBytes(capture.size_bytes)}
              {capture.source === 'uploaded' && (
                <Badge size="sm" className="badge-follow">UPLOADED</Badge>
              )}
              {/* The one badge here that changes a decision: a capture with no birth certificate
                  cannot be played back. */}
              {capture.manifest?.birth_captured === false && (
                <Badge
                  tone="warning"
                  size="sm"
                  className="badge-follow"
                  title="No NBIRTH was recorded, so a playback refuses this capture. Record it again to replace it."
                >
                  NO BIRTH
                </Badge>
              )}
            </div>
            <div style={{ color: 'var(--text-muted)' }}>
              {formatDateTime(capture.recorded_at)}{capture.note ? ` — ${capture.note}` : ''}
            </div>
          </div>
        )}
      </td>
    </tr>
  )
}
