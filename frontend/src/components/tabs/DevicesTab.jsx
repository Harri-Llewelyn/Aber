import { alertIndex, alertForDevice } from '../../utils/deviceAlerts'
import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../../lib/supabaseClient'
import { api } from '../../api'
import { trackRequest } from '../../lib/apiActivity'
import { PERMISSION_UUIDS, REALTIME_ENABLED, refreshInterval } from '../../constants'
import { usePolling } from '../../hooks/usePolling'
import { useRealtimeTable } from '../../hooks/useRealtimeTable'
import { downloadCSV } from '../../utils/downloadCSV'
import { downloadJSON } from '../../utils/downloadJSON'
import { downloadBlob } from '../../utils/downloadBlob'
import { edgeFunctionErrorMessage } from '../../utils/edgeFunctionError'
import { describeAuthFailure } from '../../utils/sessionError'
import CopyableId from '../common/CopyableId'
import { effectiveSparkplugId } from '../../utils/sparkplugId'
import { ActionMenu } from '../common/ActionMenu'
import { ActionButton } from '../common/ActionButton'
import { usePendingAction, usePendingKey } from '../../hooks/usePendingAction'
import { TagList } from '../common/TagList'
import { Model3DUploader } from '../common/Model3DUploader'
import { QuarantinePayloadCell } from '../common/QuarantinePayloadCell'
import { ContextPanel, rowSelectHandler } from '../common/ContextPanel'
import { ApproveQuarantineModal } from '../modals/ApproveQuarantineModal'
import { ArchiveModal } from '../modals/ArchiveModal'
import { AssetConfigModal } from '../modals/AssetConfigModal'
import { DeviceNameplateModal } from '../modals/DeviceNameplateModal'
import { EntityLinksModal } from '../modals/EntityLinksModal'
import { TelemetryExportModal } from '../modals/TelemetryExportModal'
import { TelemetryModal } from '../modals/TelemetryModal'
import { isProvisioningOverdue, isNeverSeen } from '../../utils/deviceProvisioning'
import {
  deviceLifecycleStatus,
  deviceStatusBadgeClass,
  deviceStatusDotColor,
  deviceStatusTitle
} from '../../utils/deviceStatus'
import {
  SCOPE_CELL, SCOPE_AREA_WIDE, SCOPE_SITE_WIDE, SOURCE_EXPLICIT, SOURCE_AREA_WIDE, SOURCE_SITE_WIDE, NON_CELL_SOURCES,
  resolveDeviceLocation, needsCellAssignment, unassignedHint,
  locationSourceLabel, gatewayAcceptsCell, noCellReason
} from '../../utils/cellResolution'
import { AreaIcon } from '../../utils/areaIcon'
import { LocationPicker, locationIncomplete } from '../common/LocationPicker'
import {
  unmodelledMetrics, schemasForDevice, deviceTagList, deviceHasTag, availableTags, UNMODELLED_TAG
} from '../../utils/deviceTags'
import { assignableSchemas, isAssignableSchema, schemaStatus, statusLabel } from '../../utils/schemaVersion'
import { suggestMatches } from '../../utils/quarantineMatching'
import { patchFromForm, formFromPatch, submitProposal, nonProposableFields } from '../../utils/proposeFromForm'
import { gatewayAcceptsDevices, noDeviceAssignmentReason } from '../../utils/gatewayType'
import {
  IconInbox,
  IconCpu,
  IconFileText,
  IconTag,
  IconPlus,
  IconPencil,
  IconArchive,
  IconRefreshCw,
  IconActivity,
  IconHistory,
  IconClipboardList,
  IconBookOpen,
  IconCube,
  IconShieldAlert,
  IconAlertTriangle,
  IconPlay,
  IconAlertCircle,
  IconLock,
  IconDownload,
  IconX,
  IconRadio,
  IconLayoutDashboard
} from '../common/Icons'
import { HelpTip } from '../common/HelpTip'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { useArrivalSelection } from '../../hooks/useArrivalSelection'

// Sentinel values for the cell filter's two derived lanes. Prefixed so they can never collide
// with a cell UUID, and kept out of `cells` because neither lane is a row in that table.
const CELL_FILTER_UNASSIGNED = '__unassigned__'
const CELL_FILTER_SITE_WIDE = '__site_wide__'

export function DevicesTab({ showToast, onSelectDevice, onSelectGateway, onSelectCell, onSelectArea, onSelectSchema, onViewThread, onPropose, onViewApprovals, hasPermission, initialSearchFilter, onClearFilter, initialSchemaFilter, onClearSchemaFilter, activeAlerts = [] }) {
  /**
   * Which devices have an alert firing on them, via utils/deviceAlerts.js so the Site Map, Cells and
   * Gateways resolve alerts the same way.
   */
  const alertsByDevice = React.useMemo(() => alertIndex(activeAlerts), [activeAlerts])

  const alertFor = React.useCallback(
    (device) => alertForDevice(alertsByDevice, device),
    [alertsByDevice]
  )

  const [assets, setAssets]     = useState([])
  const [cells, setCells]       = useState([])
  const [gateways, setGateways] = useState([])
  const [schemas, setSchemas]   = useState([])
  const [quarantine, setQuarantine] = useState([])
  const [loading, setLoading]   = useState(true)
  const [showForm, setShowForm] = useState(false)
  // See GatewaysTab: an inline modal is still a modal, and Escape has to close it.
  useEscapeKey(() => setShowForm(false), showForm)
  const [editing, setEditing]   = useState(null)
  const [approveItem, setApproveItem] = useState(null)
  const [archiveTarget, setArchiveTarget] = useState(null)
  const [configAsset, setConfigAsset] = useState(null)
  const [nameplateFor, setNameplateFor] = useState(null)
  const [openProposals, setOpenProposals] = useState([])
  // An ID, not the device object -- this page polls, so a captured object would freeze while the
  // row beside it kept updating. Resolved against `assets` every render.
  const [selectedId, setSelectedId] = useState(null)
  // The device whose telemetry inspector is open, or null. A modal rather than a panel section:
  // the inspector is a four-column table and the drawer is 360px wide.
  const [telemetryFor, setTelemetryFor] = useState(null)
  const [docsForDevice, setDocsForDevice] = useState(null)
  // Bumped when EntityLinksModal closes; the telemetry and catalog read below keys on it, since a
  // document edit is a reasonable moment to re-read.
  const [docRefreshKey, setDocRefreshKey] = useState(0)
  // sparkplug_id -> { metric_name: last value }, for the Out-of-vocabulary finding. Keyed on the
  // WIRE identity, not the row id: telemetry.asset_id is the sparkplug_id.
  const [latestBySparkplugId, setLatestBySparkplugId] = useState(new Map())
  const [catalog, setCatalog] = useState([])
  // { device, metricNames } while the telemetry CSV export dialog is open.
  const [exportTelemetry, setExportTelemetry] = useState(null)
  // No asset_type: classification is derived from the schema's metric groups (utils/deviceTags.js).
  // `cell_id` starts empty, meaning inherit from the gateway.
  const [blank]                 = useState({ asset_id: '', asset_name: '', connection_method: 'Sparkplug B', active_gateway_id: '', schema_id: '', cell_id: '', area_id: '', location_scope: SCOPE_CELL })
  const [areas, setAreas]       = useState([])
  const [form, setForm]         = useState(blank)
  const [filterMode, setFilterMode] = useState('all')

  /**
   * Latest value per (device, metric), plus the catalog that says which values are legal. Outside
   * loadAll() because `telemetry_latest` is a view over the hypertable and neither side moves fast
   * enough for the 3s poll. Non-fatal: no telemetry loaded means no finding, not a clean bill.
   */
  useEffect(() => {
    let cancelled = false
    Promise.all([
      api.get('/api/v1/telemetry/latest?minutes=1440'),
      api.get('/api/v1/metric-catalog')
    ])
      .then(([rows, cat]) => {
        if (cancelled) return
        const byAsset = new Map()
        for (const row of rows || []) {
          const key = row.asset_id
          if (!byAsset.has(key)) byAsset.set(key, {})
          // telemetry_latest splits the value across three typed columns, as asset_config does.
          // `??` rather than `||`, so a legitimate 0 or false is not read as "no value".
          byAsset.get(key)[row.metric_name] =
            row.val_string ?? row.val_double ?? row.val_bool ?? null
        }
        setLatestBySparkplugId(byAsset)
        setCatalog(cat || [])
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [docRefreshKey])

  /** This device's last reported values, keyed the way telemetry keys them. */
  const latestFor = (device) =>
    latestBySparkplugId.get(effectiveSparkplugId(device)) || null

  /**
   * A device row shaped for the edit form. `schema_id` is seeded with the resolved schema so the
   * picker shows what is attached; an explicit `devices.schema_id` wins over a submodel, and the
   * fallback only fills a hole. A device with several submodels cannot be represented by one
   * select, so the form names them rather than dropping any.
   */
  const editFormFor = (device) => {
    const attached = schemasForDevice(device, schemas)
    return { ...device, schema_id: device.schema_id || attached[0]?.schema_uuid || '' }
  }

  const getInitialSearch = () => {
    const params = new URLSearchParams(window.location.search)
    return params.get('search') || initialSearchFilter || ''
  }

  const getInitialSchema = () => {
    const params = new URLSearchParams(window.location.search)
    return params.get('schema') || initialSchemaFilter || ''
  }

  const [searchQuery, setSearchQuery] = useState(getInitialSearch)
  // Set when arriving from a schema's device count on the Schemas page, or from ?schema=<uuid>.
  const [schemaFilter, setSchemaFilter] = useState(getInitialSchema)
  const [statusFilter, setStatusFilter] = useState('')
  const [tagFilter, setTagFilter] = useState('')
  const [gatewayFilter, setGatewayFilter] = useState('')
  const [cellFilter, setCellFilter] = useState('')
  const [attentionOnly, setAttentionOnly] = useState(false)
  // Shadow devices (0060). Off by default -- see the filter below for why they are not a `filterMode`.
  const [showShadows, setShowShadows] = useState(false)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const urlSearch = params.get('search')
    if (urlSearch) {
      setSearchQuery(urlSearch)
    } else if (initialSearchFilter) {
      setSearchQuery(initialSearchFilter)
    }
  }, [initialSearchFilter])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const urlSchema = params.get('schema')
    if (urlSchema) {
      setSchemaFilter(urlSchema)
    } else if (initialSchemaFilter) {
      setSchemaFilter(initialSchemaFilter)
    }
  }, [initialSchemaFilter])

  // Drops the query string along with the filter, so a reload does not resurrect it.
  const clearUrlQuery = () => {
    if (window.location.search) {
      window.history.replaceState({}, '', window.location.pathname)
    }
  }

  const handleClearSearch = () => {
    setSearchQuery('')
    clearUrlQuery()
    if (onClearFilter) onClearFilter()
  }

  const handleSchemaFilterChange = (val) => {
    setSchemaFilter(val)
    if (!val) {
      clearUrlQuery()
      if (onClearSchemaFilter) onClearSchemaFilter()
    }
  }

  const resetFilters = () => {
    setSearchQuery('')
    setSchemaFilter('')
    setStatusFilter('')
    setTagFilter('')
    setGatewayFilter('')
    setCellFilter('')
    setAttentionOnly(false)
    setFilterMode('all')
    clearUrlQuery()
    if (onClearFilter) onClearFilter()
    if (onClearSchemaFilter) onClearSchemaFilter()
  }

  const loadAll = useCallback(async (signal) => {
    try {
      const [a, c, g, s, ar] = await Promise.all([
        api.get('/api/v1/devices', { signal }),
        api.get('/api/v1/cells', { signal }),
        api.get('/api/v1/gateways', { signal }),
        api.get('/api/v1/schemas', { signal }),
        // Tolerated: without it the picker simply offers no Area-Wide entries.
        api.get('/api/v1/areas', { signal }).catch(() => []),
      ])
      setAssets(a); setCells(c); setGateways(g); setSchemas(s); setAreas(ar)

      try {
        const q = await api.get('/api/v1/quarantine', { signal })
        setQuarantine(q)
      } catch (qErr) {
        if (qErr.name !== 'AbortError') {
          setQuarantine([])
        }
      }

      /* Open proposals on these machines, so a device can say what is waiting on it. RLS decides
         what comes back. Tolerated rather than required, so the page loads if the endpoint fails. */
      try {
        const proposals = await api.get('/api/v1/proposals', { signal })
        setOpenProposals((proposals || []).filter(pr => pr.status === 'open'))
      } catch (pErr) {
        if (pErr.name !== 'AbortError') setOpenProposals([])
      }
      setLoading(false)
    } catch (err) {
      if (err.name !== 'AbortError') {
        setLoading(false)
      }
      throw err
    }
  }, [])

  // Reconciliation loop, not the primary refresh -- see useRealtimeTable for why polling stays.
  usePolling(loadAll, refreshInterval())
  // The quarantine queue is a filtered view of `devices`; `cells` is watched because each row shows
  // its resolved cell.
  useRealtimeTable(['devices', 'gateways', 'cells'], loadAll, { enabled: REALTIME_ENABLED })

  const save = async () => {
    try {
      // asset_type is deliberately not sent: omitting it leaves any legacy value intact
      // (api.js only patches keys present in the body) rather than nulling it on every edit.
      const payload = {
        asset_name: form.asset_name,
        connection_method: form.connection_method || null,
        active_gateway_id: form.active_gateway_id || null,
        schema_id: form.schema_id || null,
        // '' is the inherit option, which api.js turns into NULL. All three keys are always sent
        // because the form always shows the one picker that sets them.
        cell_id: form.cell_id || '',
        area_id: form.area_id || '',
        location_scope: form.location_scope || SCOPE_CELL,
      }
      // Edit only: a device being created takes the column's default rather than an explicit
      // 'audit'.
      if (editing) payload.conformance_policy = form.conformance_policy || 'audit'

      /* The fork is here and nowhere else: fields and validation are shared, and only the last step
         differs by who is asking. */
      if (proposeMode) {
        if (!editing) throw new Error('A device can only be registered by an Administrator.')
        const patch = patchFromForm('device', editFormFor(editing), form)
        await submitProposal({
          kind: 'device',
          entityId: editing.asset_id,
          patch,
          rationale: form.__rationale,
          proposalId: editingProposal?.id
        })
        setShowForm(false); setEditingProposal(null); loadAll()
        showToast(editingProposal
          ? 'Your proposal was updated. An approver decides from here.'
          : 'Proposed. An approver applies it, or says why not.', 'success')
        return
      }

      if (editing) {
        await api.put(`/api/v1/devices/${editing.asset_id}`, payload)
      } else {
        // No asset_id: the devices table generates the UUID (gen_random_uuid()).
        await api.post('/api/v1/devices', payload)
      }
      setShowForm(false); loadAll(); showToast(editing ? 'Device saved successfully' : 'Device created successfully', 'success')
    } catch (e) { showToast(e.message, 'error') }
  }

  // In-flight state for the form and for the row being restored or rejected. Restore and Reject
  // share one key because both reload the list.
  const [saving, runSave] = usePendingAction()
  const [rowBusyId, runRowAction] = usePendingKey()

  // Tracks the device currently exporting, so the row's own button can show progress rather than
  // a page-wide spinner -- composing a shell is a few round trips and the table stays usable.
  const [exportingAas, setExportingAas] = useState(null)

  /**
   * Download this device's Asset Administration Shell (IEC 63278) as AAS V3 JSON. Composed
   * server-side by the `aas-export` edge function, which holds the service role needed to read
   * `asset_config` and the whole catalog.
   */
  const exportAas = async (asset, format = 'json') => {
    setExportingAas(asset.asset_id)
    try {
      const result = await api.post('/api/v1/devices/aas-export', { device_id: asset.asset_id, format })

      if (format === 'aasx') {
        // Already a packaged ZIP; downloadJSON would re-serialise it. Anchor-download the blob
        // directly, the same mechanism downloadJSON/downloadCSV use.
        downloadBlob(result.blob, `${asset.asset_name}.aasx`)
      } else {
        downloadJSON(result.aas, `${asset.asset_name}_aas_v3.json`)
      }

      // An unmapped metric is reported as a warning: `semantic_id` is nullable and a local
      // extension legitimately has none.
      const stats = result.stats || {}
      const unmapped = stats.unmapped_semantic_ids || 0
      const label = format === 'aasx' ? 'AASX package' : 'AAS JSON'
      const summary = `${stats.submodels || 0} submodels, ${stats.telemetry_metrics || 0} metrics`
      // An unreachable model URL outranks an unmapped metric: a loopback 3D reference resolves only
      // on the exporter's own machine.
      if (result.warning) {
        showToast(`${label} exported for '${asset.asset_name}' — ${result.warning}`, 'warning')
      } else if (unmapped > 0) {
        showToast(
          `${label} exported for '${asset.asset_name}' (${summary}) — ${unmapped} metric${unmapped === 1 ? '' : 's'} carried no semantic id`,
          'warning'
        )
      } else {
        showToast(`${label} exported for '${asset.asset_name}' (${summary})`, 'success')
      }
    } catch (e) {
      showToast(e.message, 'error')
    } finally {
      setExportingAas(null)
    }
  }

  const reassignGatewayInline = async (asset, newGwId) => {
    try {
      await api.put(`/api/v1/devices/${asset.asset_id}`, {
        asset_name: asset.asset_name,
        active_gateway_id: newGwId || null
      })
      await loadAll()
      const gwName = gateways.find(g => g.gateway_id === newGwId)?.gateway_name || 'Unassigned'
      showToast(`Device '${asset.asset_name}' gateway reassigned to '${gwName}'`, 'success')
    } catch (e) { showToast(e.message, 'error') }
  }

  const approveQuarantine = async (assetId, body) => {
    const targetGateway = body?.active_gateway_id || body?.gateway_id || null

    try {
      // trackRequest, because this calls the edge function on the supabase client directly and
      // bypasses the `api` wrapper that feeds the activity line.
      const { data, error } = await trackRequest(() => supabase.functions.invoke('approve-quarantine', {
        // `asset_name` is the operator's correction to the announced label. `cell_id` and
        // `location_scope` are the modal's location answer; '' is Inherit, and the edge function
        // writes NULL for it.
        body: {
          device_id: assetId,
          gateway_id: targetGateway,
          asset_name: body?.asset_name,
          cell_id: body?.cell_id ?? '',
          area_id: body?.area_id ?? '',
          location_scope: body?.location_scope || 'cell'
        }
      }))

      if (error) {
        // error.message is always generic on a non-2xx; the real reason (e.g.
        // "Forbidden: Insufficient privileges") lives in the response body.
        const detail = await edgeFunctionErrorMessage(error, 'Quarantine approval denied or failed')
        // Edge functions validate the session with the auth server, so a session PostgREST still
        // accepts first shows up as dead here. Sign out rather than stay half-authenticated.
        showToast(await describeAuthFailure(detail, detail), 'error')
        return
      }

      if (!data?.success) {
        showToast(data?.error || 'Quarantine approval failed', 'error')
        return
      }

      setApproveItem(null)
      loadAll()
      // Report the friendly name, not the UUID the edge function is addressed by.
      showToast(`Device '${approveItem?.asset_name || assetId}' approved and onboarded`, 'success')
    } catch (e) { showToast(e.message, 'error') }
  }

  const mergeQuarantine = async (assetId, candidateId) => {
    try {
      // Tracked for the same reason as approveQuarantine above.
      const { data, error } = await trackRequest(() => supabase.functions.invoke('approve-quarantine', {
        body: { device_id: assetId, merge_into_device_id: candidateId }
      }))

      if (error) {
        const detail = await edgeFunctionErrorMessage(error, 'Quarantine match acceptance denied or failed')
        showToast(await describeAuthFailure(detail, detail), 'error')
        return
      }

      if (!data?.success) {
        showToast(data?.error || 'Quarantine match acceptance failed', 'error')
        return
      }

      setApproveItem(null)
      loadAll()
      showToast(`Device '${approveItem?.asset_name || assetId}' matched and merged into the provisioned device`, 'success')
    } catch (e) { showToast(e.message, 'error') }
  }

  const rejectQuarantine = async (item) => {
    try {
      await api.post(`/api/v1/quarantine/${item.asset_id}/reject`, {})
      loadAll(); showToast(`Quarantined device '${item.asset_name}' rejected`, 'success')
    } catch (e) { showToast(e.message, 'error') }
  }

  const archiveDevice = async (days) => {
    try {
      await api.post(`/api/v1/devices/${archiveTarget.asset_id}/archive`, { auto_delete_days: days })
      setArchiveTarget(null); loadAll(); showToast(`Device '${archiveTarget.asset_name}' archived (Out of Commission)`, 'success')
    } catch (e) { showToast(e.message, 'error') }
  }

  const restoreDevice = async (assetId, name) => {
    try {
      await api.post(`/api/v1/devices/${assetId}/restore`, {})
      loadAll(); showToast(`Device '${name}' restored to active service`, 'success')
    } catch (e) { showToast(e.message, 'error') }
  }

  const canApprove = hasPermission(PERMISSION_UUIDS.QUARANTINE_APPROVE)
  const canReject  = hasPermission(PERMISSION_UUIDS.QUARANTINE_REJECT)
  const canManage  = hasPermission(PERMISSION_UUIDS.DEVICE_MANAGE)
  const canArchive = hasPermission(PERMISSION_UUIDS.ARCHIVE_MANAGE)
  const canPropose = hasPermission(PERMISSION_UUIDS.PROPOSAL_CREATE)

  /* The form ends in a proposal rather than a write for somebody who may not make the change.
     Derived, never stored, so it cannot disagree with the permission. `editingProposal` is the open
     proposal this form adds to: one open proposal per asset per person, so a second change extends
     the first. */
  const proposeMode = !canManage && canPropose

  /**
   * The note under a field a proposal may not name. Disabled with the reason printed, rather than
   * hidden, so the reader learns where the boundary is.
   */
  const Withheld = ({ field }) => (
    proposeMode && withheldFields[field]
      ? <div className="form-hint-locked">{withheldFields[field]}</div>
      : null
  )
  const [editingProposal, setEditingProposal] = useState(null)
  const withheldFields = nonProposableFields('device')
  const canReadThread = hasPermission(PERMISSION_UUIDS.DIGITAL_THREAD_READ)

  // Metrics declared at the last birth that the schema does not model. Derived, so adding the
  // metric to the schema clears it on the next poll. See utils/deviceTags.js.
  const unmodelledFor = useCallback(
    (a) => unmodelledMetrics(a, schemasForDevice(a, schemas)),
    [schemas]
  )

  // Indexes for the two lookups that run per device row; `Array.find` inside the filter was devices
  // x gateways per render. Memoised so they survive renders that changed neither list.
  const gatewayById = useMemo(
    () => new Map(gateways.map(g => [g.gateway_id, g])),
    [gateways]
  )
  const cellById = useMemo(
    () => new Map(cells.map(c => [c.cell_id, c])),
    [cells]
  )
  const areaById = useMemo(
    () => new Map(areas.map(ar => [ar.area_id, ar])),
    [areas]
  )

  // A device an operator needs to act on: quarantined, provisioned but never seen, still resolved
  // by name, or publishing unmodelled metrics. The quarantine arm stays so the predicate is true to
  // its name where the banner is absent. An archived cell is still a valid foreign key, so pointing
  // at one is derived rather than enforced.
  const pointsAtArchivedCell = (a) =>
    !!a.effective_cell_id && !!cellById.get(a.effective_cell_id)?.is_archived

  const needsAttention = (a) =>
    a.is_quarantined || isProvisioningOverdue(a) || a.identity_source === 'legacy_name' ||
    unmodelledFor(a).length > 0 ||
    // Location findings. Unassigned is the work queue that should drain; a mismatch and an
    // archived cell are both "this resolved to something, but look at it".
    needsCellAssignment(a, gatewayById.get(a.active_gateway_id) || null) ||
    a.cell_mismatch || pointsAtArchivedCell(a)

  // Memoised: the predicate resolves schemas, tags, gateway and cell for every device, and this
  // component re-renders on any of thirty pieces of state. The dependency list is the contract:
  // miss a value the predicate reads and that filter stops responding.
  const filteredAssets = useMemo(() => assets.filter(a => {
    // Quarantined devices belong to the queue card below and nowhere else. The two lists come from
    // different sources, so this is the only place the separation is enforced.
    if (a.is_quarantined) return false

    // Replay lanes are out by default: `ensure_shadow_devices()` mints one per captured device when
    // a playback starts, which would otherwise double the list. Not folded into `filterMode`, which
    // is the archived axis; a shadow can be archived or not.
    if (!showShadows && a.shadow_of) return false

    if (filterMode === 'active'   && a.is_archived) return false
    if (filterMode === 'archived' && !a.is_archived) return false
    // Matches either the legacy 1:1 column or any attached submodel, so a device filtered by
    // schema is found however it was provisioned.
    if (schemaFilter && !schemasForDevice(a, schemas).some(s => s.schema_uuid === schemaFilter)) return false
    if (tagFilter && !deviceHasTag(a, schemasForDevice(a, schemas), tagFilter, latestFor(a), catalog)) return false
    if (gatewayFilter && (a.active_gateway_id || '') !== gatewayFilter) return false
    // The resolved cell, not the explicit override, or every inherited device would be hidden.
    // Unassigned and Site-Wide are lanes, not rows in `cells`.
    if (cellFilter === CELL_FILTER_UNASSIGNED) {
      if (!needsCellAssignment(a, gatewayById.get(a.active_gateway_id) || null)) return false
    } else if (cellFilter === CELL_FILTER_SITE_WIDE) {
      if (a.location_source !== SOURCE_SITE_WIDE) return false
    } else if (cellFilter && (a.effective_cell_id || '') !== cellFilter) return false
    if (attentionOnly && !needsAttention(a)) return false

    if (statusFilter === 'online'   && (a.status === 'OFFLINE' || a.is_archived)) return false
    if (statusFilter === 'offline'  && a.status !== 'OFFLINE') return false
    // "Never seen" is distinct from offline: the row exists but no DBIRTH has ever arrived.
    if (statusFilter === 'unborn'   && !isNeverSeen(a)) return false
    if (statusFilter === 'overdue'  && !isProvisioningOverdue(a)) return false
    if (statusFilter === 'unmodelled' && unmodelledFor(a).length === 0) return false

    if (searchQuery) {
      // Searchable by everything an engineer might paste in: the friendly name, the internal
      // UUID (for log correlation) and the Sparkplug id seen on the wire.
      const q = searchQuery.toLowerCase()
      const haystack = [a.asset_name, a.asset_id, effectiveSparkplugId(a)]
        .filter(Boolean).join(' ').toLowerCase()
      if (!haystack.includes(q)) return false
    }
    return true
  }), [
    assets, filterMode, schemaFilter, schemas, tagFilter, latestBySparkplugId, catalog,
    gatewayFilter, cellFilter, gatewayById, attentionOnly, showShadows, statusFilter, searchQuery,
    unmodelledFor, cellById,
  ])

  // Counts only what the Needs attention filter can reveal below; quarantined devices are counted
  // by the banner instead. `needsAttention` is rebuilt every render, so its inputs are the
  // dependencies.
  const attentionCount = useMemo(
    () => assets.filter(a => !a.is_quarantined && needsAttention(a)).length,
    [assets, gatewayById, cellById, unmodelledFor]
  )
  // Counted across every device, not the filtered list: it is the number the toggle reveals.
  // Quarantined lanes are excluded as attentionCount excludes them.
  const shadowCount = useMemo(
    () => assets.filter(a => !a.is_quarantined && a.shadow_of).length,
    [assets]
  )
  // Walks every device's schemas and last-birth metrics for the tag dropdown. `latestFor` is
  // rebuilt every render, so `latestBySparkplugId` is the dependency.
  const tagOptions = useMemo(
    () => availableTags(assets, schemas, latestFor, catalog),
    [assets, schemas, latestBySparkplugId, catalog]
  )
  const activeFilterCount =
    [schemaFilter, statusFilter, tagFilter, gatewayFilter, cellFilter, searchQuery].filter(Boolean).length +
    (attentionOnly ? 1 : 0) + (showShadows ? 1 : 0) + (filterMode !== 'all' ? 1 : 0)
  const schemaName = schemas.find(s => s.schema_uuid === schemaFilter)?.schema_name

  // Arriving from a chip, an alert row or the shopfloor map with one device named: open it rather
  // than leave a one-row table. Identifier equality only; see the hook.
  useArrivalSelection(
    searchQuery,
    assets,
    (a, term) => a.asset_id === term || effectiveSparkplugId(a) === term,
    (a) => setSelectedId(a.asset_id)
  )

  // Resolved fresh every render -- see the note on selectedId. A device that is archived out of
  // the current filter, or deleted, resolves to null and the drawer closes itself.
  const selectedDevice = assets.find(a => a.asset_id === selectedId) || null

  /* Both device lanes count: `devices` and `device_nameplate` are two kinds of change to one
     machine, keyed by the same id. */
  const openForSelected = useMemo(
    () => (selectedDevice
      ? openProposals.filter(p => p.entity_id === selectedDevice.asset_id
          && (p.entity_type === 'devices' || p.entity_type === 'device_nameplate'))
      : []),
    [openProposals, selectedDevice]
  )
  const selectedGateway = selectedDevice
    ? gateways.find(g => g.gateway_id === selectedDevice.active_gateway_id) || null
    : null
  // The panel reports the RESOLVED cell, so it has to run the same resolution the table does
  // rather than reading `cell_id` directly -- an inherited device has none of its own.
  const selectedLocation = selectedDevice ? resolveDeviceLocation(selectedDevice, selectedGateway) : null

  return (
    <div className="page-layout">
      <div className="page-main">

      {/* The roster: title, primary action, filters, table. The onboarding queue is a card of its
          own below -- the devices that are in, then the ones waiting to be let in. */}
      <div className="card">
        <div className="card-header">
          <h3 className="section-title">
            Devices
            <HelpTip
              label="About devices"
              text="A device is an asset that publishes telemetry through a gateway. What it is modelled to publish comes from its schema; what it actually publishes is what the historian records. This page surfaces the two disagreeing: a quarantine, an unmodelled metric, or a device that has never birthed."
            />
          </h3>
          <button
            className={`btn btn-primary btn-sm ${!canManage ? 'btn-disabled' : ''}`}
            style={{ marginLeft: 'auto' }}
            disabled={!canManage}
            onClick={() => canManage && (setEditing(null), setForm(blank), setShowForm(true))}
            title={!canManage ? 'Requires Admin permissions' : 'Register new shopfloor device'}
          >
            <IconPlus size={14} /> New Device
          </button>
        </div>

        <div className="card-body">
      {/* Filters live on their own row within the card: the header outgrew a single line once
          schema, status and relationship filters arrived. */}
      <div className="filter-bar">
        {/* Lifecycle is a filter like the rest; the counts are in the option labels. */}
        <select
          className="form-control"
          style={{ width: '150px' }}
          value={filterMode}
          onChange={e => setFilterMode(e.target.value)}
          title="Filter by lifecycle state"
        >
          <option value="all">All ({assets.length})</option>
          <option value="active">Active ({assets.filter(a => !a.is_archived).length})</option>
          <option value="archived">Archived ({assets.filter(a => a.is_archived).length})</option>
        </select>

        <input
          className="form-control"
          style={{ width: '220px' }}
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Search name, UUID or Sparkplug ID…"
          title="Filter devices by friendly name, internal UUID, or Sparkplug ID"
        />

        <select className="form-control" style={{ width: '170px' }} value={statusFilter} onChange={e => setStatusFilter(e.target.value)} title="Filter by operational state">
          <option value="">Any status</option>
          <option value="online">Online</option>
          <option value="offline">Offline / DDEATH</option>
          <option value="unborn">Never sent a birth</option>
          <option value="overdue">Awaiting first birth (24h+)</option>
          <option value="unmodelled">Publishing unmodelled metrics</option>
        </select>

        <select
          className="form-control"
          style={{ width: '170px' }}
          value={tagFilter}
          onChange={e => setTagFilter(e.target.value)}
          disabled={tagOptions.length === 0}
          title={tagOptions.length === 0
            ? 'No device carries a tag yet — tags come from the metric groups a device\'s schema models'
            : 'Filter by device type, derived from the metric groups the assigned schema models'}
        >
          <option value="">Any type</option>
          {tagOptions.map(t => <option key={t} value={t}>{t}</option>)}
        </select>

        <select className="form-control" style={{ width: '190px' }} value={schemaFilter} onChange={e => handleSchemaFilterChange(e.target.value)} title="Filter by the schema a device was provisioned with">
          <option value="">Any schema</option>
          {schemas.map(s => <option key={s.schema_uuid} value={s.schema_uuid}>{s.schema_name}</option>)}
        </select>

        <select className="form-control" style={{ width: '190px' }} value={gatewayFilter} onChange={e => setGatewayFilter(e.target.value)} title="Filter by serving edge gateway">
          <option value="">Any gateway</option>
          {gateways.map(g => <option key={g.gateway_id} value={g.gateway_id}>{g.gateway_name}</option>)}
        </select>

        {/* Filters on the RESOLVED cell, plus the two derived lanes. */}
        <select className="form-control" style={{ width: '170px' }} value={cellFilter} onChange={e => setCellFilter(e.target.value)} title="Filter by the cell a device resolves to — its own if set, otherwise its gateway's">
          <option value="">Any cell</option>
          <option value={CELL_FILTER_UNASSIGNED}>Unassigned (needs a cell)</option>
          <option value={CELL_FILTER_SITE_WIDE}>Site-Wide</option>
          {cells.map(c => <option key={c.cell_id} value={c.cell_id}>{c.cell_name}</option>)}
        </select>

        <button
          className={`btn btn-sm ${attentionOnly ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setAttentionOnly(v => !v)}
          title="Show only devices that are overdue their first birth, still matched by legacy name, publishing metrics their schema does not model, or needing a cell — unassigned, filed in a cell their gateway does not serve, or pointing at an archived cell. Quarantined devices are listed separately in the onboarding queue below."
        >
          <IconAlertTriangle size={13} /> Needs attention ({attentionCount})
        </button>

        {/* Shown only when there are any, like the Archived toggle on Access Control: it appears
            the moment a playback mints the first lane. */}
        {shadowCount > 0 && (
          <button
            className={`btn btn-sm ${showShadows ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setShowShadows(v => !v)}
            title="Shadow devices created by broker playback (archived migration 0060). One per device a capture recorded, they receive replayed readings so a recording is never mistaken for live plant data. Hidden by default because they are not machines."
          >
            <IconPlay size={13} /> Show shadow devices ({shadowCount})
          </button>
        )}

        {activeFilterCount > 0 && (
          <button className="btn btn-ghost btn-sm filter-bar-spacer" onClick={resetFilters} title="Clear every filter">
            <IconX size={13} /> Clear filters ({activeFilterCount})
          </button>
        )}

      </div>

      {schemaName && (
        <div style={{ marginBottom: '16px', fontSize: '12px', color: 'var(--text-muted)' }}>
          Showing devices provisioned with schema <strong style={{ color: 'var(--accent)' }}>{schemaName}</strong>.
        </div>
      )}

        </div>{/* .card-body */}

        {loading ? <div className="loading-wrap"><div className="spinner" /> Loading devices…</div> :
         filteredAssets.length === 0 ? (
           <div className="empty-state">
             <div className="empty-icon"><IconCpu size={36} /></div>
             <div className="empty-text">No devices match the selected filter.</div>
           </div>
         ) : (
          /* `.table-scroll` caps the height and pins the header row, the way the schema registry
             does: without it a fleet of any size pushes the quarantine queue below it clean off
             the screen, and the queue is the half of this page with work waiting on it. */
          <div className="table-wrap table-scroll">
            <table>
              <thead><tr><th title="Human-readable device name">Name</th><th title="The device's database identifier -- the id to quote in a query, a ticket or an API call. Its Sparkplug id is derived from this, so nothing is lost by showing it here.">Device UUID</th><th title="Device status">Status</th><th style={{ width: 'auto' }} title="Device classification">Type</th><th title="Assigned cell zone">Cell</th></tr></thead>
              <tbody>
                {filteredAssets.map(a => {
                  return (
                    <React.Fragment key={a.asset_id}>
                      {/* Clicks originating on a button, link or input inside the row are ignored
                          -- see rowSelectHandler. Without that, pressing Edit would also select. */}
                      <tr
                        className={`row-selectable${selectedId === a.asset_id ? ' row-selected' : ''}`}
                        style={{ background: a.is_archived ? 'rgba(255,179,0,0.06)' : undefined }}
                        onClick={rowSelectHandler(() => setSelectedId(id => id === a.asset_id ? null : a.asset_id))}
                        title="Click to inspect this device in the details panel"
                      >
                        <td>
                          <strong>{a.asset_name}</strong>
                          {/* Marked whenever shown, because the toggle that revealed it is a filter
                              and filters are forgotten. The badge answers whether a reading
                              happened, wherever the row is seen. */}
                          {a.shadow_of && (
                            <span className="badge badge-neutral" style={{ fontSize: '11px', marginLeft: '8px' }}
                                  title="A shadow device, not a machine. It receives recorded readings republished by broker playback, so its values did happen — on the real device, on the day the capture was taken.">
                              <IconPlay size={11} /> SHADOW
                            </span>
                          )}
                          {a.is_archived && (
                            <span className="badge badge-warning" style={{ background: 'rgba(255,179,0,0.15)', color: 'var(--warning-text)', border: '1px solid var(--warning)', marginLeft: '8px' }} title="Decommissioned device">
                              <IconArchive size={11} /> ARCHIVED
                            </span>
                          )}
                        </td>
                        <td>
                          <CopyableId value={a.asset_id} label="Device UUID" onNotify={showToast} />
                          {a.identity_source === 'legacy_name' && (
                            <div style={{ fontSize: '11px', color: 'var(--warning-text)', marginTop: '3px', display: 'flex', alignItems: 'center', gap: '3px' }} title="This device is still matched by name. Reconfigure its gateway to publish the Sparkplug ID; name matching will be removed.">
                              <IconAlertTriangle size={10} /> Legacy name matching
                            </div>
                          )}
                        </td>
                        <td>
                          {a.is_archived ? (
                            <span className="badge badge-warning" style={{ background: 'rgba(255,179,0,0.15)', color: 'var(--warning-text)', border: '1px solid var(--warning)', display: 'inline-flex', alignItems: 'center', gap: '4px' }} title="Decommissioned device (Out of Commission)">
                              <IconArchive size={11} /> ARCHIVED (OUT OF COMMISSION)
                            </span>
                          ) : isProvisioningOverdue(a) ? (
                            <span className="badge badge-warning" style={{ background: 'rgba(255,179,0,0.15)', color: 'var(--warning-text)', border: '1px solid var(--warning)', display: 'inline-flex', alignItems: 'center', gap: '4px' }} title="Provisioned more than 24h ago and has never sent a DBIRTH">
                              <IconAlertTriangle size={11} /> AWAITING FIRST BIRTH
                            </span>
                          ) : (
                            // The lifecycle badge, resolved by utils/deviceStatus.js so this cell,
                            // the drawer and the shopfloor chip agree. Three states: ONLINE,
                            // OFFLINE, QUARANTINED.
                            (() => {
                              const status = deviceLifecycleStatus(a)
                              const alert = alertFor(a)
                              return (
                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '4px' }}>
                                  <span
                                    className={`badge ${deviceStatusBadgeClass(status)}`}
                                    title={deviceStatusTitle(status)}
                                  >
                                    <span className="badge-dot" style={{ background: deviceStatusDotColor(status) }} />
                                    {status.charAt(0) + status.slice(1).toLowerCase()}
                                  </span>
                                  {/* The alert sits beside the lifecycle state, not instead of it:
                                      an overheating machine is still ONLINE. */}
                                  {/* A stroked SVG rather than an emoji: it takes `currentColor`
                                      from the badge and matches the other badges in the column. */}
                                  {alert && (
                                    <span
                                      className={`badge ${alert.severity === 'critical' ? 'badge-offline' : 'badge-warning'}`}
                                      style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                                      title={`${alert.alert_name}${alert.summary ? ` — ${alert.summary}` : ''} (raised by Grafana)`}
                                    >
                                      {alert.severity === 'critical'
                                        ? <><IconAlertCircle size={11} /> ALARM</>
                                        : <><IconAlertTriangle size={11} /> WARNING</>}
                                    </span>
                                  )}
                                </div>
                              )
                            })()
                          )}
                        </td>
                        <td>
                          {(() => {
                            const schema = schemasForDevice(a, schemas)
                            const tags = deviceTagList(a, schema, latestFor(a), catalog)
                            const extra = unmodelledMetrics(a, schema)
                            if (tags.length === 0 && !a.asset_type) return '—'

                            // Collapsed past two: a tri-standard schema yields six or more tags.
                            // `priority` keeps Unmodelled visible, since deviceTagList() appends it
                            // last.
                            const entries = tags.map(tag => tag === UNMODELLED_TAG ? {
                              key: tag,
                              priority: true,
                              className: 'badge badge-warning',
                              style: { background: 'rgba(255,179,0,0.15)', color: 'var(--warning-text)', border: '1px solid var(--warning)', fontSize: '11px' },
                              title: `Declared at its last birth but absent from schema '${schema?.schema_name}': ${extra.join(', ')}`,
                              content: <><IconAlertTriangle size={10} /> {tag} ({extra.length})</>
                            } : {
                              key: tag,
                              className: 'badge badge-neutral',
                              style: { fontSize: '11px' },
                              title: `This device's schema models ${tag}.* metrics`,
                              content: tag
                            })

                            // Free-text classification from before types were derived. Shown so
                            // the value is not silently lost, but nothing writes it now.
                            if (a.asset_type) {
                              entries.push({
                                key: a.asset_type,
                                style: { fontSize: '11px', color: 'var(--text-dim)', fontStyle: 'italic' },
                                title: 'Legacy free-text classification. Assign a schema to derive this instead.',
                                content: a.asset_type
                              })
                            }

                            return <TagList limit={4} tags={entries}/>
                          })()}
                        </td>
                        <td style={{ maxWidth: '170px' }}>
                          {(() => {
                            // The resolved cell and how it was resolved: inherited and
                            // set-on-device behave differently when the gateway is reassigned.
                            const gw = gatewayById.get(a.active_gateway_id) || null
                            const cellName = cellById.get(a.effective_cell_id)?.cell_name

                            // Every lane that resolves to no cell, not just Site-Wide.
                            // NON_CELL_SOURCES is kept by cellResolution.js for this; a
                            // hand-written list here once reported simulated devices as Unassigned,
                            // a queue that could never drain.
                            if (NON_CELL_SOURCES.has(a.location_source)) {
                              return (
                                <span className="badge badge-neutral" style={{ fontSize: '11px' }}
                                      title={a.location_source === SOURCE_SITE_WIDE
                                        ? 'Asserted to have no single cell — campus-wide or mobile'
                                        : a.location_source === SOURCE_AREA_WIDE
                                          ? `Asserted to have no single cell — serves the whole of ${areaById.get(a.effective_area_id)?.area_name || 'its area'}`
                                          : noCellReason(gw) || 'Resolves to a lane rather than to a cell'}>
                                  {locationSourceLabel(a.location_source)}
                                </span>
                              )
                            }
                            if (!cellName) {
                              return (
                                <span className="badge badge-warning"
                                      style={{ background: 'rgba(255,179,0,0.15)', color: 'var(--warning-text)', border: '1px solid var(--warning)', fontSize: '11px' }}
                                      title={unassignedHint(a, gw) || 'No cell resolved'}>
                                  <IconAlertTriangle size={10} /> Unassigned
                                </span>
                              )
                            }
                            return (
                              <>
                                <div>{cellName}</div>
                                {a.location_source === SOURCE_EXPLICIT && (
                                  <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}
                                       title="Set on the device itself — it will not move if the gateway is reassigned">
                                    Set on device
                                  </div>
                                )}
                                {a.cell_mismatch && (
                                  <div style={{ fontSize: '11px', color: 'var(--warning-text)', display: 'flex', alignItems: 'center', gap: '3px' }}
                                       title={`Its gateway serves ${cellById.get(a.gateway_cell_id)?.cell_name || 'another cell'}`}>
                                    <IconAlertTriangle size={10} /> Gateway elsewhere
                                  </div>
                                )}
                              </>
                            )
                          })()}
                        </td>
                      </tr>
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Its own card, under the roster rather than wedged between the roster's filters and the
          roster itself: a queue that appears and disappears was moving the table down the page by
          a variable amount every time a device arrived. Below, not above, because "what is on this
          floor" is the page's job and the queue is usually empty -- and the rail already carries
          the flag that brings anyone here (useNavSignals). */}
      {quarantine.length > 0 && (
        <div className="card card-attention" style={{ marginTop: 'var(--stack)' }}>
          <div className="card-header">
            <h3 className="section-title" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <IconShieldAlert size={18} />
              Zero-Touch Onboarding Quarantine Queue
              <HelpTip
                label="About the quarantine queue"
                text="A gateway published a birth for a device this platform does not know, so the reading was held rather than recorded against a guess. Approve & Assign admits it as a new device; if it is one already registered under another name, the queue offers the match to accept instead. Reject discards the payload. Nothing here is recorded as plant history until it is approved."
              />
              <span
                className="section-count"
                title={`${quarantine.length} device${quarantine.length === 1 ? '' : 's'} held for a decision`}
              >
                {quarantine.length}
              </span>
            </h3>
            {!canApprove && (
              <span style={{ fontSize: '11px', color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                <IconLock size={11} /> Requires Admin permissions
              </span>
            )}
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th title="Reported device name">Reported Name</th><th title="Sparkplug B id the device published under">Published ID</th><th title="Source gateway">Gateway</th><th title="Discovery timestamp">Discovered At</th><th title="Sparkplug B birth payload">Payload</th><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
              <tbody>
                {quarantine.map(q => {
                  const [suggestion] = suggestMatches(q, assets, schemas)
                  return (
                  <tr key={q.quarantine_id}>
                    {/* Constrained like the payload cell: a MALFORMED_IDENTITY reason is a full
                        sentence and would push the actions off the edge. It wraps rather than
                        truncates. */}
                    <td style={{ maxWidth: '280px' }}>
                      <strong>{q.asset_name}</strong>
                      {q.quarantine_reason && (
                        <div style={{ fontSize: '11px', color: 'var(--danger)', marginTop: '3px', display: 'flex', alignItems: 'flex-start', gap: '3px' }}>
                          <IconAlertTriangle size={10} style={{ flexShrink: 0, marginTop: '1px' }} />
                          <span style={{ minWidth: 0 }}>{q.quarantine_reason}</span>
                        </div>
                      )}
                      {suggestion && (
                        <div style={{ fontSize: '11px', color: 'var(--warning-text)', marginTop: '3px', display: 'flex', alignItems: 'center', gap: '3px' }} title={suggestion.evidence}>
                          <IconAlertTriangle size={10} /> Possible match: {suggestion.candidateName}
                        </div>
                      )}
                    </td>
                    <td><CopyableId value={q.reported_identity} label="published device id" onNotify={showToast} /></td>
                    <td>{q.gateway_name || <span className="mono">—</span>}</td>
                    <td style={{ fontSize: '11px' }}>{new Date(q.discovered_at).toLocaleString()}</td>
                    <QuarantinePayloadCell metrics={q.reported_metrics} fallbackJson={q.birth_payload} />
                    <td style={{ textAlign: 'right' }}>
                      <div className="btn-group" style={{ justifyContent: 'flex-end' }}>
                        <button
                          className={`btn btn-primary btn-sm ${!canApprove ? 'btn-disabled' : ''}`}
                          disabled={!canApprove}
                          onClick={() => canApprove && setApproveItem(q)}
                          title={!canApprove ? 'Requires Admin permissions' : 'Approve and assign to cell zone'}
                        >
                          Approve & Assign
                        </button>
                        {/* Keyed on the row: one boolean would spin every Reject button. */}
                        <ActionButton
                          className={`btn btn-danger btn-sm ${!canReject ? 'btn-disabled' : ''}`}
                          disabled={!canReject}
                          pending={rowBusyId === q.asset_id}
                          pendingLabel="Rejecting…"
                          onClick={() => canReject && runRowAction(q.asset_id, () => rejectQuarantine(q))}
                          title={!canReject ? 'Requires Admin permissions' : 'Reject quarantine payload'}
                        >
                          Reject
                        </ActionButton>
                      </div>
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showForm && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-title">{editing ? 'Edit Device Configuration' : 'Register New Device'}</div>
            
            {/* Every field here is editable. The identifiers and the topic helper are facts, and
                live on the drawer where they are copyable. */}
            <div className="form-group">
              <label className="form-label">Device Name</label>
              <input className="form-control" value={form.asset_name} onChange={e => setForm(f => ({ ...f, asset_name: e.target.value }))} title="Friendly label for this device" placeholder="e.g. Sim_CNC_Mill_01" />
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                A display label only — rename it freely. Identity on the wire is the Sparkplug ID, which is generated from the database key and never moves, so renaming never breaks ingestion or detaches telemetry history.
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Description</label>
              <textarea
                className="form-control"
                rows={2}
                value={form.description || ''}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                title="Optional free-text note about this device"
                placeholder="e.g. Spindle rebuilt 2026-03; runs warmer than its twin"
              />
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                {/* Says what it is NOT for, because the tempting misuse is to encode something here
                    that belongs in a typed field -- and then to start parsing it. */}
                Optional, and read by nothing. For identification a consumer should trust — manufacturer, serial number, firmware — use the Digital Nameplate, whose fields carry published IDTA identifiers.
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Assigned Edge Gateway</label>
              <Withheld field="active_gateway_id" />
              <select className="form-control" disabled={proposeMode} value={form.active_gateway_id || ''} onChange={e => setForm(f => ({ ...f, active_gateway_id: e.target.value }))} title={proposeMode ? withheldFields.active_gateway_id : "Select edge gateway serving this device"}>
                <option value="">— Unassigned Gateway —</option>
                {/* A replay lane is listed but disabled rather than filtered out, so a device that
                    is a lane still opens with its own gateway shown. The database refuses the write
                    either way. */}
                {gateways.filter(g => !g.is_archived).map(g => (
                  <option key={g.gateway_id} value={g.gateway_id} disabled={!gatewayAcceptsDevices(g)}>
                    {g.gateway_name} ({g.gateway_id}) — Status: {g.status}
                    {gatewayAcceptsDevices(g) ? '' : ' — replay lane, not assignable'}
                  </option>
                ))}
              </select>
              {/* Shown always: the question is why Playback cannot be picked, asked while something
                  else is selected. */}
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                {noDeviceAssignmentReason({ is_shadow: true })}
              </div>
            </div>

            {/* Where the device is, which is not how its data reaches us. Inherit stores NULL; a
                cell stores an override that wins over the gateway's. */}
            {(() => {
              const formGateway = gateways.find(g => g.gateway_id === form.active_gateway_id) || null
              const siteWide = form.location_scope === SCOPE_SITE_WIDE
              const areaWide = form.location_scope === SCOPE_AREA_WIDE
              const location = resolveDeviceLocation(
                { cell_id: siteWide || areaWide ? null : form.cell_id, area_id: areaWide ? form.area_id : null, location_scope: form.location_scope },
                formGateway
              )
              const chosenAreaName = areas.find(ar => ar.area_id === form.area_id)?.area_name
              const nameOf = (id) => cells.find(c => c.cell_id === id)?.cell_name
              const inheritedName = nameOf(location.gateway_cell_id)
              // Whether a cell means anything for this device, decided by its gateway. There is no
              // CHECK on the device side; a stored cell would be accepted and ignored.
              const acceptsCell = gatewayAcceptsCell(formGateway)

              return (
                <div className="form-group">
                  <label className="form-label">Location</label>
                  {/* One exclusive choice of scope, then the cell or the area it calls for.
                      The scopes are exclusive by CHECK (`devices_site_wide_has_no_cell` and the
                      area-wide pair), which is what a radio group says. */}
                  <LocationPicker
                    idPrefix="device"
                    form={form}
                    onChange={fields => setForm(f => ({ ...f, ...fields }))}
                    cells={cells}
                    areas={areas}
                    disabled={!acceptsCell}
                    title={acceptsCell
                      ? undefined
                      : 'Its gateway generates or replays this telemetry, so the device resolves to a lane rather than to a cell'}
                    // Named after what it resolves to, not "None": the empty value is a deliberate
                    // "follow the gateway", not an absence.
                    cellEmptyLabel={inheritedName ? `— Inherit from gateway (${inheritedName}) —` : '— Inherit from gateway (gateway has no cell) —'}
                    cellTitle="Where this device physically sits. Leave on Inherit to follow its gateway."
                  />

                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
                    {!acceptsCell
                      /* Deliberately does not clear `cell_id`: nothing here is refused on save, so
                         a stored cell is kept and applies again if the gateway stops being
                         synthetic. */
                      ? `${noCellReason(formGateway)} Any cell already set on it is kept, and applies again if that changes.`
                      : siteWide
                        ? 'Reported as Site-Wide rather than under any cell. Use this for campus-wide or mobile assets.'
                        : areaWide
                          ? `Reported as Area-Wide in ${chosenAreaName || 'this area'} rather than under any cell in it. Use this for a building management system or anything that serves the whole area.`
                          : location.location_source === SOURCE_EXPLICIT
                          ? `Set on this device — it stays in ${nameOf(location.effective_cell_id) || 'this cell'} even if its gateway moves.`
                          : inheritedName
                            ? `Follows the gateway above. Reassigning the gateway moves this device with it.`
                            : 'Neither this device nor its gateway has a cell, so it will appear in the Unassigned queue. Pick a cell here, set one on the gateway, or mark it Site-Wide.'}
                  </div>

                  {location.cell_mismatch && (
                    <div style={{ fontSize: '11px', color: 'var(--warning-text)', marginTop: '6px', display: 'flex', alignItems: 'flex-start', gap: '5px' }}>
                      <IconAlertTriangle size={12} style={{ flexShrink: 0, marginTop: '1px' }} />
                      <span>
                        This device is filed in <strong>{nameOf(location.effective_cell_id)}</strong> but its
                        gateway serves <strong>{inheritedName}</strong>. That is allowed — a shared or host-run
                        connector often reaches across cells — but check it is what you meant.
                      </span>
                    </div>
                  )}
                </div>
              )
            })()}

            <div className="form-group">
              <label className="form-label">Device Type / Classification <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: '11px' }}>(derived)</span></label>
              {/* flexWrap is load-bearing: a tri-standard schema derives six tags, and the count
                  grows with the schema. */}
              <div className="form-control" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px', color: 'var(--text-muted)', background: 'var(--bg-glass)' }} title="Derived from the metric groups the assigned schema models — not typed in by hand">
                {(() => {
                  const preview = deviceTagList(editing, schemas.find(s => s.schema_uuid === form.schema_id) || null)
                  if (preview.length === 0) {
                    return <span style={{ fontSize: '12px' }}>Assign a schema below to classify this device</span>
                  }
                  return preview.map(t => (
                    <span key={t} className="badge badge-neutral" style={{ fontSize: '11px' }}>{t}</span>
                  ))
                })()}
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Schema (optional)</label>
              <Withheld field="schema_id" />
              {/* Archived versions are not offered; assignableSchemas() keeps the one this device
                  already carries, labelled with its status. The database refuses the write as well. */}
              <select className="form-control" disabled={proposeMode} value={form.schema_id || ''} onChange={e => setForm(f => ({ ...f, schema_id: e.target.value }))} title={proposeMode ? withheldFields.schema_id : "Expected metric schema, from the Schemas registry. Archived versions are not offered — publish a version instead of reattaching the one it replaced."}>
                <option value="">— No schema assigned —</option>
                {assignableSchemas(schemas, form.schema_id).map(s => (
                  <option key={s.schema_uuid} value={s.schema_uuid}>
                    {isAssignableSchema(s) ? s.schema_name : `${s.schema_name} · ${statusLabel(schemaStatus(s))}`}
                  </option>
                ))}
              </select>
              {/* What the field is for, in the order it matters: the contract every DDATA value is
                  judged against, and under Enforce that judgement drops readings. The quarantine
                  hint is second because suggestMatches() weights a required-metric overlap above
                  name similarity. */}
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                The contract this device's metrics are judged against — see Schema Conformance below,
                which decides whether a violation is recorded or the reading is dropped. Optional:
                with none attached nothing is judged. It also helps identify this device if it turns
                up in quarantine under another name, by matching the metrics it reports against the
                schema's required fields.
              </div>
              {/* Said only when it applies: the device is on a version its lineage has moved past,
                  which is a migration to finish. */}
              {form.schema_id && !isAssignableSchema(schemas.find(s => s.schema_uuid === form.schema_id)) && (
                <div style={{ fontSize: '11px', color: 'var(--warning-text)', marginTop: '6px' }}>
                  This device is still on an archived version. It is kept selectable so saving does not
                  silently detach it — move it forward by publishing from the Schemas page, not from here.
                </div>
              )}
              {/* The one case a single select cannot state: several submodels. Naming the others is
                  the smallest honest version. */}
              {editing && (() => {
                const attached = schemasForDevice(editing, schemas)
                if (attached.length < 2) return null
                return (
                  <div style={{ fontSize: '11px', color: 'var(--warning-text)', marginTop: '6px' }}>
                    This device has {attached.length} schemas attached
                    ({attached.map(s => s.schema_name).join(', ')}). This picker sets only the primary
                    one; the rest are managed as AAS submodels and are unaffected by saving here.
                  </div>
                )
              })()}
            </div>

            {/* Only when editing: a device being created has no schema yet, and the column defaults
                to 'audit' server-side. */}
            {editing && (
              <div className="form-group">
                <label className="form-label">Schema Conformance</label>
                <select
                  className="form-control"
                  disabled={proposeMode}
                  value={form.conformance_policy || 'audit'}
                  onChange={e => setForm(f => ({ ...f, conformance_policy: e.target.value }))}
                  title="What happens when a metric contradicts this device's bound schema"
                >
                  <option value="audit">Audit — record the violation, keep the reading</option>
                  <option value="enforce">Enforce — record it and DROP the reading</option>
                </select>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                  Applies to DDATA values judged against the schemas bound to this device. Only the
                  offending metric is affected; the rest of the message is written either way.
                </div>

                {/* The state that looks like it worked and does nothing: with no schema attached,
                    'enforce' is inert. */}
                {form.conformance_policy === 'enforce'
                  && schemasForDevice(editing, schemas).length === 0 && (
                  <div style={{ fontSize: '11px', color: 'var(--warning-text)', marginTop: '6px' }}>
                    This device has no schema attached, so enforcing does nothing — there is
                    nothing to judge a value against. Attach a schema above first.
                  </div>
                )}

                {/* Shown on the change, not on the state: what Enforce discards cannot be fetched
                    back. */}
                {form.conformance_policy === 'enforce'
                  && editing.conformance_policy !== 'enforce'
                  && schemasForDevice(editing, schemas).length > 0 && (
                  <div style={{ fontSize: '11px', color: 'var(--danger-text)', marginTop: '6px' }}>
                    From the next message, a value contradicting this device's schema will not be
                    written to the historian and cannot be recovered. The violation is still
                    recorded in the Digital Thread. Schema changes take up to five minutes to take
                    effect.
                  </div>
                )}
              </div>
            )}

            {/* No connection-method picker: ingestion is a Sparkplug B MQTT subscriber and nothing
                acts on the column. */}

            {/* The rationale, only when proposing: it is written to an approver who has not stood
                in front of the machine. */}
            {proposeMode && (
              <div className="form-group">
                <label className="form-label" htmlFor="propose-rationale">Why (optional)</label>
                <textarea
                  id="propose-rationale"
                  className="form-control"
                  rows={2}
                  value={form.__rationale || ''}
                  onChange={e => setForm(f => ({ ...f, __rationale: e.target.value }))}
                  placeholder="e.g. the label on the machine says SPINDLE-4, not SPINDLE-A"
                />
              </div>
            )}

            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => { setShowForm(false); setEditingProposal(null) }} disabled={saving} title="Cancel edits">Cancel</button>
              <ActionButton
                pending={saving}
                pendingLabel={proposeMode ? 'Proposing…' : editing ? 'Saving…' : 'Creating…'}
                onClick={() => runSave(save)}
                // Area-Wide with no area named would be refused by the database; held here.
                disabled={locationIncomplete(form)}
                title={locationIncomplete(form)
                  ? 'Choose which area the device serves'
                  : proposeMode
                    ? 'Ask for these changes — an approver applies them, or says why not'
                    : 'Save device configuration and gateway assignment'}
              >
                {proposeMode
                  ? (editingProposal ? 'Update your proposal' : 'Propose a change')
                  : 'Save Configuration'}
              </ActionButton>
            </div>
          </div>
        </div>
      )}

      {approveItem && (
        <ApproveQuarantineModal
          item={approveItem}
          cells={cells}
          areas={areas}
          gateways={gateways}
          suggestion={suggestMatches(approveItem, assets, schemas)[0] || null}
          onApprove={approveQuarantine}
          onMerge={mergeQuarantine}
          onCancel={() => setApproveItem(null)}
        />
      )}
      {archiveTarget && <ArchiveModal entityType="devices" entityId={archiveTarget.asset_id} displayName={archiveTarget.asset_name} onArchive={archiveDevice} onCancel={() => setArchiveTarget(null)} />}
      {configAsset && (
        <AssetConfigModal
          asset={configAsset}
          schemas={schemas}
          // Read-only now that the 3D uploader has moved to the row's document accordion, so no
          // reload is needed on close -- the uploader reloads for itself when it writes.
          onClose={() => setConfigAsset(null)}
        />
      )}
      {nameplateFor && (
        <DeviceNameplateModal
          asset={nameplateFor}
          canManage={canManage}
          showToast={showToast}
          onClose={() => setNameplateFor(null)}
          /* THE DIALOG FILES ITS OWN PROPOSAL NOW, rather than routing to a composer that listed
             these same eleven columns a second time. It needs the permission, not a destination. */
          canPropose={canPropose}
        />
      )}
      {docsForDevice && (
        <EntityLinksModal entityType="device" entityId={docsForDevice.asset_id} entityName={docsForDevice.asset_name} onClose={() => { setDocsForDevice(null); setDocRefreshKey(k => k + 1) }} showToast={showToast} hasPermission={hasPermission} />
      )}
      {telemetryFor && (
        <TelemetryModal
          device={telemetryFor}
          hasPermission={hasPermission}
          onExport={(dev, names) => setExportTelemetry({ device: dev, metricNames: names })}
          onClose={() => setTelemetryFor(null)}
        />
      )}
      {exportTelemetry && (
        <TelemetryExportModal
          device={exportTelemetry.device}
          metricNames={exportTelemetry.metricNames}
          onClose={() => setExportTelemetry(null)}
          showToast={showToast}
        />
      )}
      </div>

      <ContextPanel
        open={!!selectedDevice}
        onClose={() => setSelectedId(null)}
        type="DEVICE"
        onCopy={showToast}
        alert={selectedDevice ? alertFor(selectedDevice) : null}
        title={selectedDevice?.asset_name || ''}
        subtitle={selectedDevice && (
          <>
            {/* One badge for the lifecycle state. ARCHIVED stays separate because it is a separate
                axis. */}
            {(() => {
              const status = deviceLifecycleStatus(selectedDevice)
              return (
                <span
                  className={`badge ${deviceStatusBadgeClass(status)}`}
                  style={{ fontSize: '11px' }}
                  title={deviceStatusTitle(status)}
                >
                  {status}
                </span>
              )
            })()}
            {selectedDevice.is_archived && <span className="badge badge-warning" style={{ fontSize: '11px' }}>ARCHIVED</span>}
          </>
        )}
        fields={selectedDevice ? [
          { label: 'Device UUID', value: selectedDevice.asset_id, mono: true, copyable: true },
          // The WIRE identity. Distinct from the UUID above and from the editable name: telemetry
          // is keyed on this, so it is what a trace or an export is actually matched by.
          { label: 'Sparkplug Device ID', value: effectiveSparkplugId(selectedDevice), mono: true, copyable: true },
          {
            // The group comes from the serving gateway, so the topic can be pasted into an MQTT
            // client.
            label: 'Sparkplug Topic Path',
            value: `spBv1.0/${selectedGateway?.sparkplug_group || '+'}/DDATA/${selectedGateway ? (selectedGateway.sparkplug_id || selectedGateway.gateway_id) : '+'}/${effectiveSparkplugId(selectedDevice)}`,
            mono: true,
            copyable: true,
            title: !selectedGateway
              ? 'The DDATA topic this device would publish on. It has no serving gateway, so the group and edge node segments are wildcards.'
              : selectedGateway.sparkplug_group
                ? 'The DDATA topic this device publishes on.'
                : "The DDATA topic this device publishes on. No Sparkplug group is recorded on its gateway, so that segment is a wildcard."
          },
          {
            // A link, not a picker: rebinding lives in Edit Details behind an explicit save. What
            // the field is asked is which gateway, and take me to it.
            label: 'Serving Gateway',
            full: true,
            value: selectedDevice.active_gateway_id ? (
              <button
                className="chip chip-link"
                onClick={() => onSelectGateway?.(selectedDevice.active_gateway_id)}
                title="Open this gateway on the Gateways page"
              >
                <IconRadio size={11} />
                <span className="chip-name">
                  {gateways.find(g => g.gateway_id === selectedDevice.active_gateway_id)?.gateway_name
                    || selectedDevice.gateway_name || selectedDevice.active_gateway_id}
                </span>
              </button>
            ) : null,
            title: "The edge node carrying this device's data. Reassign it in Edit Details."
          },
          {
            // Resolved, not the explicit override. Site-Wide is not a link: it asserts the device
            // belongs to no cell.
            label: 'Location (resolved)',
            value: selectedLocation?.location_scope === SCOPE_SITE_WIDE
              ? 'Site-Wide'
              : selectedLocation?.location_scope === SCOPE_AREA_WIDE
                ? `Area-Wide — ${areaById.get(selectedLocation?.effective_area_id)?.area_name || 'its area'}`
              : (() => {
                  const cell = cells.find(c => c.cell_id === selectedLocation?.effective_cell_id)
                  if (!cell) return null
                  return (
                    <button
                      className="chip chip-link"
                      onClick={() => onSelectCell?.(cell.cell_id)}
                      title="Open this cell on the Cells page"
                    >
                      <IconLayoutDashboard size={11} />
                      <span className="chip-name">{cell.cell_name}</span>
                    </button>
                  )
                })(),
            title: selectedLocation?.location_source === SOURCE_EXPLICIT
              ? 'Set on the device itself, so it stays here regardless of its gateway.'
              : selectedLocation?.location_scope === SCOPE_SITE_WIDE
                ? 'Marked Site-Wide: it belongs to no single cell.'
                : selectedLocation?.location_scope === SCOPE_AREA_WIDE
                  ? 'Marked Area-Wide: it belongs to an area rather than to any one cell in it.'
                  : 'Inherited from its gateway. It will follow the gateway if that moves.'
          },
          {
            label: 'Area (resolved)',
            value: selectedLocation?.effective_area_id
              ? (
                <button
                  className="chip chip-link"
                  onClick={() => onSelectArea?.(selectedLocation.effective_area_id)}
                  title="Open this area on the Areas page"
                >
                  <AreaIcon area={areaById.get(selectedLocation.effective_area_id)} size={11} />
                  <span className="chip-name">{areaById.get(selectedLocation.effective_area_id)?.area_name || selectedLocation.effective_area_id}</span>
                </button>
              )
              : null,
            title: 'The ISA-95 area: its cell\'s, or its own when it is Area-Wide. Site-wide and unassigned devices have none.'
          },
          {
            label: 'Location Source',
            value: selectedLocation?.location_source || null,
            title: 'explicit = set on the device; inherited = from its gateway; area_wide = no single cell, one area; site_wide = no single cell, the campus; unassigned = nothing to inherit.'
          },
          {
            // Resolved through schemasForDevice, not `selectedDevice.schema_id`: a schema arrives
            // by either the 1:1 column or a `device_submodels` row (`submodel_schema_ids`). All of
            // them, since a device may carry several.
            label: 'Schema',
            value: (() => {
              const attached = schemasForDevice(selectedDevice, schemas)
              if (attached.length === 0) return null
              return (
                <div className="context-device-list">
                  {attached.map(schema => (
                    <button
                      key={schema.schema_uuid}
                      className="chip chip-link"
                      onClick={() => onSelectSchema?.(schema.schema_uuid)}
                      title={`Open ${schema.schema_name} on the Schemas page`}
                    >
                      <IconClipboardList size={11} />
                      <span className="chip-name">{schema.schema_name}</span>
                    </button>
                  ))}
                </div>
              )
            })(),
            full: true,
            title: 'The metric contract(s) this device is judged against. Opens on the Schemas page.'
          },
          /* Connection method is not shown: nothing writes it and nothing acts on it. The column
             stays; this is a UI omission. */
          {
            label: 'Description',
            value: selectedDevice.description || null,
            full: true,
            title: 'Operator note. Free text, read by nothing.'
          },
          {
            label: 'Classification',
            value: deviceTagList(selectedDevice, schemasForDevice(selectedDevice, schemas), latestFor(selectedDevice), catalog).join(', ') || null,
            full: true,
            title: "Derived from the metric groups this device's schema models, plus any live findings."
          },
        ] : []}
        actions={selectedDevice ? [
          // The old actions column, which applies to one device you have already picked.
          selectedDevice.is_archived ? {
            label: 'Restore Device', icon: <IconRefreshCw size={13} />,
            onClick: () => runRowAction(selectedDevice.asset_id, () => restoreDevice(selectedDevice.asset_id, selectedDevice.asset_name)),
            pending: rowBusyId === selectedDevice.asset_id,
            pendingLabel: 'Restoring…',
            disabled: !canArchive,
            primary: true,
            title: !canArchive ? 'Requires Admin permissions' : 'Restore device back to active service'
          } : {
            icon: <IconPencil size={13} />,
            // Seeded with the resolved schema, not the raw row, whose `schema_id` is null for a
            // device schema'd through `device_submodels`.
            label: proposeMode ? 'Propose a Change' : 'Edit Details',
            onClick: () => {
              setEditing(selectedDevice)
              // Seeded with the open proposal's patch applied, so adding a second field extends the
              // request rather than replacing it.
              const mine = proposeMode ? openForSelected.find(pr => pr.entity_type === 'devices') : null
              setEditingProposal(mine || null)
              setForm({ ...editFormFor(selectedDevice), ...formFromPatch('device', mine?.patch) })
              setShowForm(true)
            },
            disabled: (!canManage && !canPropose) || selectedDevice.status === 'OFFLINE',
            // Not `primary`: the Gateways and Cells drawers style their edit action as a secondary,
            // and editing is not what a device panel is opened to do.
            title: selectedDevice.status === 'OFFLINE'
              ? 'Device is offline (DDEATH received)'
              : proposeMode
                ? 'Ask for a change to this device — an approver applies it, or says why not'
                : !canManage && !canPropose
                  ? 'Requires Admin permissions'
                  : 'Edit device parameters'
          },
          /* No separate Propose a Change action: the dialog above is the only form, and for
             somebody who may not save it its footer files a proposal. See `proposeMode`. */
          /* What is already waiting on this machine, only when something is. The count comes from
             RLS, so it is what this person may see. */
          openForSelected.length > 0 && {
            label: openForSelected.length === 1
              ? '1 change awaiting decision'
              : `${openForSelected.length} changes awaiting decision`,
            icon: <IconInbox size={13} />,
            onClick: () => onViewApprovals?.(selectedDevice),
            title: 'Open the approvals queue, filtered to this device'
          },
          {
            // Opens the modal rather than a section of this panel. The inspector is a four-column
            // table and 360px is not a table -- see TelemetryModal for the full history.
            label: 'View Realtime Telemetry', icon: <IconActivity size={13} />,
            onClick: () => setTelemetryFor(selectedDevice),
            title: "Open this device's metric inspector"
          },
          {
            // A read of what the device declared at birth: not gated on device:manage and not
            // refused for an archived device, like the AAS export.
            label: 'Configuration Parameters', icon: <IconFileText size={13} />,
            onClick: () => setConfigAsset(selectedDevice),
            title: 'Inspect the DBIRTH metric parameters this device reported'
          },
          /* Withheld from a replay lane: a nameplate carries a serial number that identifies one
             physical object, and a shadow is a recording of an asset, not a second asset. */
          !selectedDevice.shadow_of && {
            // Directly above the two exports on purpose: it is the only thing here that changes
            // what they contain.
            label: 'Digital Nameplate…', icon: <IconTag size={13} />,
            onClick: () => setNameplateFor(selectedDevice),
            title: canManage
              ? "Manufacturer, serial number and versions — exported in this device's AAS"
              : "View this device's nameplate (editing requires Admin permissions)"
          },
          {
            label: exportingAas === selectedDevice.asset_id ? 'Exporting AAS…' : 'Export AAS JSON (V3)',
            icon: <IconDownload size={13} />,
            onClick: () => exportAas(selectedDevice, 'json'),
            disabled: exportingAas === selectedDevice.asset_id,
            title: "Download this device's Asset Administration Shell as AAS Part 5 JSON"
          },
          {
            label: exportingAas === selectedDevice.asset_id ? 'Exporting AAS…' : 'Export AASX package',
            icon: <IconDownload size={13} />,
            onClick: () => exportAas(selectedDevice, 'aasx'),
            disabled: exportingAas === selectedDevice.asset_id,
            title: 'Download an AASX (OPC) package, with any attached 3D model bundled in'
          },
          /* Also withheld from a replay lane: links are resolved through `shadow_of` at read time,
             and a copy here would go stale. */
          !selectedDevice.shadow_of && {
            // The accordion below lists the links; this is how a new one gets attached. Both are
            // needed now that the accordion no longer carries its own Manage button.
            label: 'Attached Links', icon: <IconBookOpen size={13} />,
            onClick: () => setDocsForDevice(selectedDevice),
            title: 'Attach or edit links for this device — documents, an asset register, a file repository, any URL'
          },
          /* Withheld from a reader who may not open the page: the nav hides Digital Thread without
             `digital_thread:read`. `.filter(Boolean)` drops it. */
          canReadThread && {
            label: 'View Digital Thread', icon: <IconHistory size={13} />,
            onClick: () => onViewThread?.(selectedDevice),
            title: 'Open the immutable audit trace for this device'
          },
          // Archive only, never beside Restore: the two are mutually exclusive states of the
          // same row, and offering both would make one of them a no-op.
          !selectedDevice.is_archived && {
            label: 'Archive Device', icon: <IconArchive size={13} />,
            onClick: () => setArchiveTarget(selectedDevice),
            disabled: !canArchive,
            danger: true,
            title: !canArchive ? 'Requires Admin permissions' : 'Decommission & Archive Device'
          },
        ].filter(Boolean) : []}
      >
        {/* The two accordions belong to one device rather than being mounted once per row. */}
        {selectedDevice && (
          <>
            {/* The 3D model stays: it is an attachment, and one upload control fits a narrow
                column. onChange reloads so model_3d_path cannot go stale. */}
            <div>
              {/* The icon is what the uploader gave up when its own two-row heading came off --
                  it identified the section at a glance, and a bare text label does not. */}
              <div className="context-panel-section-label context-panel-section-label-icon">
                <IconCube size={13} /> 3D Model
              </div>
              <Model3DUploader
                device={selectedDevice}
                canManage={canManage && !selectedDevice.is_archived}
                showToast={showToast}
                onChange={() => loadAll()}
              />
            </div>

          </>
        )}
      </ContextPanel>
    </div>
  )
}
