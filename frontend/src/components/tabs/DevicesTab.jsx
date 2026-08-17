import React, { useState, useEffect, useCallback } from 'react'
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
import { EntityDocumentsModal } from '../modals/EntityDocumentsModal'
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
  SCOPE_CELL, SCOPE_SITE_WIDE, SOURCE_EXPLICIT, SOURCE_SITE_WIDE,
  resolveDeviceLocation, needsCellAssignment, unassignedHint
} from '../../utils/cellResolution'
import {
  unmodelledMetrics, schemasForDevice, deviceTagList, deviceHasTag, availableTags, UNMODELLED_TAG
} from '../../utils/deviceTags'
import { suggestMatches } from '../../utils/quarantineMatching'
import {
  IconCpu,
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
  IconLock,
  IconDownload,
  IconX
} from '../common/Icons'
import { useEscapeKey } from '../../hooks/useEscapeKey'

// Sentinel values for the cell filter's two derived lanes. Prefixed so they can never collide
// with a cell UUID, and kept out of `cells` because neither lane is a row in that table.
const CELL_FILTER_UNASSIGNED = '__unassigned__'
const CELL_FILTER_SITE_WIDE = '__site_wide__'

export function DevicesTab({ showToast, onSelectDevice, onViewThread, hasPermission, initialSearchFilter, onClearFilter, initialSchemaFilter, onClearSchemaFilter }) {
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
  // An ID, not the device object -- this page polls, so a captured object would freeze while the
  // row beside it kept updating. Resolved against `assets` every render.
  const [selectedId, setSelectedId] = useState(null)
  // The device whose telemetry inspector is open, or null. A modal rather than a panel section:
  // the inspector is a four-column table and the drawer is 360px wide.
  const [telemetryFor, setTelemetryFor] = useState(null)
  const [docsForDevice, setDocsForDevice] = useState(null)
  const [docRefreshKey, setDocRefreshKey] = useState(0)
  // Document link counts for the collapsed accordion badge, keyed by device id. One request for
  // the whole page -- /api/v1/documents accepts entity_type on its own.
  const [docCounts, setDocCounts] = useState({})
  // sparkplug_id -> { metric_name: last value }, for the Out-of-vocabulary finding. Keyed on the
  // WIRE identity, not the row id: telemetry.asset_id is the sparkplug_id.
  const [latestBySparkplugId, setLatestBySparkplugId] = useState(new Map())
  const [catalog, setCatalog] = useState([])
  // { device, metricNames } while the telemetry CSV export dialog is open.
  const [exportTelemetry, setExportTelemetry] = useState(null)
  // No asset_type: a device's classification is now derived from the metric groups its schema
  // models (see utils/deviceTags.js), not typed in by hand. The column is left in place so
  // legacy values keep displaying, but nothing writes it any more.
  // cell_id starts EMPTY, not at some default cell: empty means "inherit from the gateway"
  // (migration 0036), so a device registered without anyone choosing a location follows its
  // gateway rather than being pinned wherever the form happened to default.
  const [blank]                 = useState({ asset_id: '', asset_name: '', connection_method: 'Sparkplug B', active_gateway_id: '', schema_id: '', cell_id: '', location_scope: SCOPE_CELL })
  const [form, setForm]         = useState(blank)
  const [filterMode, setFilterMode] = useState('all')

  /**
   * Document-link counts for the collapsed accordion badges.
   *
   * Deliberately not part of loadAll(): that runs on the poll and on every Realtime event for
   * devices, gateways and cells, whereas this number changes only when a human edits a link.
   * Keyed on docRefreshKey -- once on mount, again when EntityDocumentsModal closes.
   *
   * Non-fatal: a failure leaves the badges at zero rather than failing the device list.
   */
  useEffect(() => {
    let cancelled = false
    api.get('/api/v1/documents?entity_type=device')
      .then(docs => {
        if (cancelled) return
        const counts = {}
        for (const d of docs || []) counts[d.entity_id] = (counts[d.entity_id] || 0) + 1
        setDocCounts(counts)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [docRefreshKey])

  /**
   * Latest reported value per (device, metric), plus the catalog that says which values are legal.
   *
   * DELIBERATELY OUTSIDE loadAll(), which runs on a 3s poll and on every Realtime event. This
   * finding compares a last-known value against a vocabulary; neither side moves fast enough to
   * justify re-reading the whole fleet's telemetry at that rate, and `telemetry_latest` is a view
   * over the hypertable rather than a cheap table scan.
   *
   * Non-fatal: a failure leaves the finding unavailable rather than failing the device list, and
   * deviceTagList treats "no telemetry loaded" as "no finding" rather than as a clean bill.
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
      const [a, c, g, s] = await Promise.all([
        api.get('/api/v1/devices', { signal }),
        api.get('/api/v1/cells', { signal }),
        api.get('/api/v1/gateways', { signal }),
        api.get('/api/v1/schemas', { signal }),
      ])
      setAssets(a); setCells(c); setGateways(g); setSchemas(s)

      try {
        const q = await api.get('/api/v1/quarantine', { signal })
        setQuarantine(q)
      } catch (qErr) {
        if (qErr.name !== 'AbortError') {
          setQuarantine([])
        }
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
  // The quarantine queue rendered on this page is a filtered view of `devices`, so it arrives
  // on the same subscription. `cells` is watched because each row shows its device's cell,
  // resolved through the gateway.
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
        // '' is the inherit option, which api.js turns into NULL. Both keys are always sent
        // from this form because the form always shows both -- a partial send would be a
        // silent no-op on whichever one the user had just changed.
        cell_id: form.cell_id || '',
        location_scope: form.location_scope || SCOPE_CELL,
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

  // In-flight state for the device form, and for whichever row is restoring or being rejected.
  // Restore and Reject share one key space on purpose: they are both row mutations that reload the
  // list, and two of them overlapping is two reloads racing.
  const [saving, runSave] = usePendingAction()
  const [rowBusyId, runRowAction] = usePendingKey()

  // Tracks the device currently exporting, so the row's own button can show progress rather than
  // a page-wide spinner -- composing a shell is a few round trips and the table stays usable.
  const [exportingAas, setExportingAas] = useState(null)

  /**
   * Download this device's Asset Administration Shell (IEC 63278) as AAS V3 JSON.
   *
   * The document is composed server-side by the `aas-export` edge function; the browser only names
   * the file. That split is deliberate — the shell needs the service role to read `asset_config`
   * and the whole `metric_catalog`, and building it client-side would mean granting every signed-in
   * browser that read surface.
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

      // An unmapped metric is a real gap in the export's usefulness, so it is reported rather than
      // left to be discovered by diffing the payload. It is a warning, not an error: `semantic_id`
      // is nullable on purpose and a local extension legitimately has none.
      const stats = result.stats || {}
      const unmapped = stats.unmapped_semantic_ids || 0
      const label = format === 'aasx' ? 'AASX package' : 'AAS JSON'
      const summary = `${stats.submodels || 0} submodels, ${stats.telemetry_metrics || 0} metrics`
      if (unmapped > 0) {
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
      // trackRequest, because this goes to the Edge Function on the supabase client directly and
      // so never passes the `api` wrapper that feeds the top bar's activity line. Approving a
      // quarantined device is among the slowest mutations here -- it is the last one that should
      // leave the indicator dark.
      const { data, error } = await trackRequest(() => supabase.functions.invoke('approve-quarantine', {
        // asset_name carries the operator's correction to the label the device announced
        // itself under. It was collected by the modal and then dropped on the floor here.
        //
        // cell_id/location_scope are the modal's location answer. '' is the Inherit option and
        // is forwarded as such -- the edge function writes NULL for it, which is what keeps the
        // device following its gateway.
        body: {
          device_id: assetId,
          gateway_id: targetGateway,
          asset_name: body?.asset_name,
          cell_id: body?.cell_id ?? '',
          location_scope: body?.location_scope || 'cell'
        }
      }))

      if (error) {
        // error.message is always generic on a non-2xx; the real reason (e.g.
        // "Forbidden: Insufficient privileges") lives in the response body.
        const detail = await edgeFunctionErrorMessage(error, 'Quarantine approval denied or failed')
        // Edge Functions validate the session with the auth server, so they are where a
        // session that PostgREST still accepts first shows up as dead. Sign out rather
        // than leaving the user half-authenticated.
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

  // Metrics the device declared at its last birth that its schema does not account for.
  // Derived, not stored: adding the metric to the schema clears this on the next poll rather
  // than waiting for the device to rebirth. See utils/deviceTags.js.
  const unmodelledFor = useCallback(
    (a) => unmodelledMetrics(a, schemasForDevice(a, schemas)),
    [schemas]
  )

  // A device an operator needs to act on: held in quarantine, provisioned but never seen,
  // still being resolved by name because its gateway has not been moved onto Sparkplug IDs
  // yet, or publishing metrics its schema does not model.
  //
  // The is_quarantined arm is kept as the definition of "needs attention" even though the
  // table below never renders a quarantined device -- both callers now exclude them first.
  // It stays so this predicate remains true to its name if it is ever reused somewhere the
  // quarantine banner is not present.
  // A cell that has been archived is still a valid foreign key, so a device can go on pointing
  // at a decommissioned cell indefinitely with nothing to show for it. Derived, not enforced:
  // archiving a cell should not fail because something still references it.
  const pointsAtArchivedCell = (a) =>
    !!a.effective_cell_id && !!cells.find(c => c.cell_id === a.effective_cell_id)?.is_archived

  const needsAttention = (a) =>
    a.is_quarantined || isProvisioningOverdue(a) || a.identity_source === 'legacy_name' ||
    unmodelledFor(a).length > 0 ||
    // Location findings. Unassigned is the work queue that should drain; a mismatch and an
    // archived cell are both "this resolved to something, but look at it".
    needsCellAssignment(a, gateways.find(g => g.gateway_id === a.active_gateway_id) || null) ||
    a.cell_mismatch || pointsAtArchivedCell(a)

  const filteredAssets = assets.filter(a => {
    // Quarantined devices belong to the Zero-Touch Onboarding Quarantine Queue above and
    // nowhere else. They used to appear here as well, so every pending device was listed
    // twice on the same screen -- once with approve/reject actions, once with the ordinary
    // edit/archive actions that do not apply to a device which has not been admitted yet.
    //
    // The two lists come from different sources (this filters `assets`; the banner renders
    // the `quarantine` state loaded from /api/v1/quarantine), so this is the only place the
    // separation can be enforced.
    if (a.is_quarantined) return false

    if (filterMode === 'active'   && a.is_archived) return false
    if (filterMode === 'archived' && !a.is_archived) return false
    // Matches either the legacy 1:1 column or any attached submodel, so a device filtered by
    // schema is found however it was provisioned.
    if (schemaFilter && !schemasForDevice(a, schemas).some(s => s.schema_uuid === schemaFilter)) return false
    if (tagFilter && !deviceHasTag(a, schemasForDevice(a, schemas), tagFilter, latestFor(a), catalog)) return false
    if (gatewayFilter && (a.active_gateway_id || '') !== gatewayFilter) return false
    // The resolved cell, not the explicit override -- filtering on cell_id would match only
    // devices someone had explicitly filed and silently hide every inherited one. The two
    // synthetic values are lanes, not cells: Unassigned is the queue that should drain and
    // Site-Wide is a permanent home, and neither is a row in `cells`.
    if (cellFilter === CELL_FILTER_UNASSIGNED) {
      if (!needsCellAssignment(a, gateways.find(g => g.gateway_id === a.active_gateway_id) || null)) return false
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
  })

  // Counts only what the "Needs attention" filter can actually reveal in the table below.
  // Quarantined devices are excluded because they are no longer rendered there -- they are
  // counted by the quarantine banner's own badge instead. Including them here would make the
  // number disagree with the rows shown the moment the filter is switched on, and would
  // double-count every pending device across the two badges.
  const attentionCount = assets.filter(a => !a.is_quarantined && needsAttention(a)).length
  const tagOptions = availableTags(assets, schemas, latestFor, catalog)
  const activeFilterCount =
    [schemaFilter, statusFilter, tagFilter, gatewayFilter, cellFilter, searchQuery].filter(Boolean).length +
    (attentionOnly ? 1 : 0) + (filterMode !== 'all' ? 1 : 0)
  const schemaName = schemas.find(s => s.schema_uuid === schemaFilter)?.schema_name

  // Resolved fresh every render -- see the note on selectedId. A device that is archived out of
  // the current filter, or deleted, resolves to null and the drawer closes itself.
  const selectedDevice = assets.find(a => a.asset_id === selectedId) || null
  const selectedGateway = selectedDevice
    ? gateways.find(g => g.gateway_id === selectedDevice.active_gateway_id) || null
    : null
  // The panel reports the RESOLVED cell, so it has to run the same resolution the table does
  // rather than reading `cell_id` directly -- an inherited device has none of its own.
  const selectedLocation = selectedDevice ? resolveDeviceLocation(selectedDevice, selectedGateway) : null

  return (
    <div className="page-layout">
      <div className="page-main">

      {/* Filters live on their own row: the header outgrew a single line once schema, status and
          relationship filters arrived, and the primary actions were being pushed off screen. */}
      <div className="filter-bar">
        {/* Lifecycle lives here rather than as a separate segmented control in the header: it is
            a filter like the rest, and having two filter surfaces on one page meant the header
            row also crowded out the primary action. Counts are kept in the option labels. */}
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
          title="Show only devices that are overdue their first birth, still matched by legacy name, publishing metrics their schema does not model, or needing a cell — unassigned, filed in a cell their gateway does not serve, or pointing at an archived cell. Quarantined devices are listed separately in the onboarding queue above."
        >
          <IconAlertTriangle size={13} /> Needs attention ({attentionCount})
        </button>

        {activeFilterCount > 0 && (
          <button className="btn btn-ghost btn-sm filter-bar-spacer" onClick={resetFilters} title="Clear every filter">
            <IconX size={13} /> Clear filters ({activeFilterCount})
          </button>
        )}

        {/* The page's one primary action, at the far end of the row it shares with the filters.
            It had a row of its own -- a 34px band holding a single button, above a filter bar that
            was already the page's control surface. `.filter-bar-spacer` pushes it right. */}
        <button
          className={`btn btn-primary btn-sm ${activeFilterCount > 0 ? '' : 'filter-bar-spacer'} ${!canManage ? 'btn-disabled' : ''}`}
          disabled={!canManage}
          onClick={() => canManage && (setEditing(null), setForm(blank), setShowForm(true))}
          title={!canManage ? 'Requires Admin permissions' : 'Register new shopfloor device'}
        >
          <IconPlus size={14} /> New Device
        </button>
      </div>

      {schemaName && (
        <div style={{ marginBottom: '16px', fontSize: '12px', color: 'var(--text-muted)' }}>
          Showing devices provisioned with schema <strong style={{ color: 'var(--accent)' }}>{schemaName}</strong>.
        </div>
      )}

      {quarantine.length > 0 && (
        <div style={{ marginBottom: '24px', background: 'rgba(255,179,0,0.08)', border: '1px solid var(--warning)', borderRadius: 'var(--radius)', padding: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', color: 'var(--warning-text)', fontWeight: 600 }}>
              <IconShieldAlert size={20} />
              <span>Zero-Touch Onboarding Quarantine Queue <span className="section-count">{quarantine.length}</span></span>
            </div>
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
                    {/* Constrained for the same reason as the payload cell: a MALFORMED_IDENTITY
                        reason is a full diagnostic sentence (~200 characters), so left to size
                        itself it pushes the action buttons off the right-hand edge on exactly the
                        rows where an operator most needs to act. It wraps instead of truncating —
                        the whole point of that message is that it is readable. */}
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
                        {/* Keyed on the row, not on the table: the quarantine list is often a
                            dozen rows deep after a bad birth, and one boolean would spin every
                            Reject button for a click on one of them. */}
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

      <div className="card">
        {loading ? <div className="loading-wrap"><div className="spinner" /> Loading devices…</div> :
         filteredAssets.length === 0 ? (
           <div className="empty-state">
             <div className="empty-icon"><IconCpu size={36} /></div>
             <div className="empty-text">No devices match the selected filter.</div>
           </div>
         ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th title="Human-readable device name">Name</th><th title="Sparkplug B id this device publishes under">Sparkplug ID</th><th title="Device status">Status</th><th style={{ width: 'auto' }} title="Device classification">Type</th><th title="Assigned cell zone">Cell</th></tr></thead>
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
                          {a.is_archived && (
                            <span className="badge badge-warning" style={{ background: 'rgba(255,179,0,0.15)', color: 'var(--warning-text)', border: '1px solid var(--warning)', marginLeft: '8px' }} title="Decommissioned device">
                              <IconArchive size={11} /> ARCHIVED
                            </span>
                          )}
                        </td>
                        <td>
                          <CopyableId value={effectiveSparkplugId(a)} label="Sparkplug device id" onNotify={showToast} />
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
                            // the drawer's subtitle and the shopfloor chip cannot disagree about
                            // the same row. Three states and no fourth: ONLINE, OFFLINE,
                            // QUARANTINED.
                            (() => {
                              const status = deviceLifecycleStatus(a)
                              return (
                                <span
                                  className={`badge ${deviceStatusBadgeClass(status)}`}
                                  title={deviceStatusTitle(status)}
                                >
                                  <span className="badge-dot" style={{ background: deviceStatusDotColor(status) }} />
                                  {status.charAt(0) + status.slice(1).toLowerCase()}
                                </span>
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

                            // Collapsed past two: a tri-standard schema yields six or more tags,
                            // which was making every row three lines tall. `priority` keeps
                            // Unmodelled visible -- deviceTagList() appends it LAST, so a plain
                            // truncation would hide the only tag that calls for action.
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

                            return <TagList limit={4} tags={entries} limit={2} />
                          })()}
                        </td>
                        <td style={{ maxWidth: '170px' }}>
                          {(() => {
                            // The resolved cell, plus how it was resolved. "Inherited" and
                            // "set on device" render the same name but behave differently when
                            // the gateway is reassigned, so the distinction has to be visible.
                            const gw = gateways.find(g => g.gateway_id === a.active_gateway_id) || null
                            const cellName = cells.find(c => c.cell_id === a.effective_cell_id)?.cell_name

                            if (a.location_source === SOURCE_SITE_WIDE) {
                              return <span className="badge badge-neutral" style={{ fontSize: '11px' }} title="Asserted to have no single cell — facility-wide or mobile">Site-Wide</span>
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
                                       title={`Its gateway serves ${cells.find(c => c.cell_id === a.gateway_cell_id)?.cell_name || 'another cell'}`}>
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

      {showForm && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-title">{editing ? 'Edit Device Configuration' : 'Register New Device'}</div>
            
            {/* Name first: it is the human handle. The identifiers below are machine-issued
                and read-only, and only matter when configuring the physical gateway. */}
            <div className="form-group">
              <label className="form-label">Device Name</label>
              <input className="form-control" value={form.asset_name} onChange={e => setForm(f => ({ ...f, asset_name: e.target.value }))} title="Friendly label for this device" placeholder="e.g. Simulated_CNC_01" />
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                A display label only — rename it freely. Identity on the wire is the Sparkplug ID below, so renaming never breaks ingestion or detaches telemetry history.
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Sparkplug ID</label>
              {editing ? (
                <>
                  <CopyableId value={effectiveSparkplugId(editing)} label="Sparkplug device id" onNotify={showToast} />
                  {/* The topic is its own copy target. It used to be a plain <span> with the words
                      "Click to copy" beneath it, which promised an affordance that did not exist --
                      only the id above was ever clickable, and the sentence sat under the topic.
                      The edge node segment is filled in from the assigned gateway when there is
                      one, so what gets copied is a topic you can actually use rather than a
                      template with two holes in it. */}
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px', marginBottom: '4px' }}>
                    Configure the gateway to publish this device on:
                  </div>
                  <CopyableId
                    value={`spBv1.0/<group>/DDATA/${
                      gateways.find(g => g.gateway_id === form.active_gateway_id)?.sparkplug_id || '<edge node>'
                    }/${effectiveSparkplugId(editing)}`}
                    label="Sparkplug topic"
                    onNotify={showToast}
                    className="copyable-id-wrap"
                  />
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                    Replace <span className="mono">&lt;group&gt;</span> with the Sparkplug group id configured on the edge node.
                  </div>
                </>
              ) : (
                <input className="form-control" value="— issued on save —" disabled readOnly title="Derived from the device's database id once the record exists" />
              )}
            </div>

            <div className="form-group">
              <label className="form-label">Internal UUID</label>
              {editing
                ? <CopyableId value={form.asset_id} label="device UUID" onNotify={showToast} />
                : <input className="form-control" value="— assigned on save —" disabled readOnly title="Database-generated UUID; not editable" />}
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                Database primary key. Needed only for correlating with server logs and the digital thread.
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Assigned Edge Gateway</label>
              <select className="form-control" value={form.active_gateway_id || ''} onChange={e => setForm(f => ({ ...f, active_gateway_id: e.target.value }))} title="Select edge gateway serving this device">
                <option value="">— Unassigned Gateway —</option>
                {gateways.filter(g => !g.is_archived).map(g => (
                  <option key={g.gateway_id} value={g.gateway_id}>
                    {g.gateway_name} ({g.gateway_id}) — Status: {g.status}
                  </option>
                ))}
              </select>
            </div>

            {/* WHERE the device is, which is not the same question as how its data reaches us.
                Leaving the picker on "Inherit" is the normal case and stores NULL; picking a cell
                stores an override that wins over the gateway's. See migration 0036. */}
            {(() => {
              const formGateway = gateways.find(g => g.gateway_id === form.active_gateway_id) || null
              const siteWide = form.location_scope === SCOPE_SITE_WIDE
              const location = resolveDeviceLocation(
                { cell_id: siteWide ? null : form.cell_id, location_scope: form.location_scope },
                formGateway
              )
              const nameOf = (id) => cells.find(c => c.cell_id === id)?.cell_name
              const inheritedName = nameOf(location.gateway_cell_id)
              const chosenCell = cells.find(c => c.cell_id === form.cell_id)

              return (
                <div className="form-group">
                  <label className="form-label">Shopfloor Cell Zone</label>
                  <select
                    className="form-control"
                    value={siteWide ? '' : (form.cell_id || '')}
                    disabled={siteWide}
                    onChange={e => setForm(f => ({ ...f, cell_id: e.target.value }))}
                    title="Where this device physically sits. Leave on Inherit to follow its gateway."
                  >
                    {/* Named after what it resolves to, not "None" -- the empty value is a
                        deliberate "follow the gateway", not an absence. */}
                    <option value="">
                      {inheritedName ? `— Inherit from gateway (${inheritedName}) —` : '— Inherit from gateway (gateway has no cell) —'}
                    </option>
                    {cells.filter(c => !c.is_archived).map(c => (
                      <option key={c.cell_id} value={c.cell_id}>{c.cell_name}</option>
                    ))}
                    {/* An archived cell is not offered, but one already stored stays visible:
                        silently dropping it would relocate the device on the next save. */}
                    {chosenCell?.is_archived && (
                      <option value={chosenCell.cell_id}>{chosenCell.cell_name} (archived)</option>
                    )}
                  </select>

                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '8px', fontSize: '12px', cursor: 'pointer' }}
                         title="For assets with no single cell — a BMS, an AGV, an ambient sensor. Different from leaving it unassigned.">
                    <input
                      type="checkbox"
                      checked={siteWide}
                      onChange={e => setForm(f => ({
                        ...f,
                        location_scope: e.target.checked ? SCOPE_SITE_WIDE : SCOPE_CELL,
                        // Cleared together, mirroring devices_site_wide_has_no_cell: "it is in no
                        // particular cell" and "it is in Bay 4" cannot both be true.
                        cell_id: e.target.checked ? '' : f.cell_id
                      }))}
                    />
                    <span>Site-Wide — this asset has no single cell</span>
                  </label>

                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
                    {siteWide
                      ? 'Reported as Site-Wide rather than under any cell. Use this for facility-wide or mobile assets.'
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
              {/* flexWrap is load-bearing, not tidiness: the tri-standard schema derives six tags
                  (Axes, Controller, Machine, MotionDevice, OEE, Systems) and an unwrapped row
                  pushed the last of them outside the modal, where it was unreadable and could not
                  be scrolled to. The count grows with the schema, so there is no width at which
                  a single row is safe. */}
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
              <select className="form-control" value={form.schema_id || ''} onChange={e => setForm(f => ({ ...f, schema_id: e.target.value }))} title="Expected metric schema, from the Schemas registry">
                <option value="">— No schema assigned —</option>
                {schemas.map(s => <option key={s.schema_uuid} value={s.schema_uuid}>{s.schema_name}</option>)}
              </select>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                Used to suggest a match if a differently-named device shows up in quarantine reporting metrics that overlap this schema's required fields.
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Connection Method</label>
              <select className="form-control" value={form.connection_method || 'Sparkplug B'} onChange={e => setForm(f => ({ ...f, connection_method: e.target.value }))} title="Protocol connection method">
                <option value="Sparkplug B">Sparkplug B MQTT</option>
                <option value="OPC-UA">OPC-UA TCP</option>
                <option value="Modbus-TCP">Modbus TCP</option>
                <option value="HTTP-REST">HTTP REST API</option>
              </select>
            </div>

            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setShowForm(false)} disabled={saving} title="Cancel edits">Cancel</button>
              <ActionButton
                pending={saving}
                pendingLabel={editing ? 'Saving…' : 'Creating…'}
                onClick={() => runSave(save)}
                title="Save device configuration and gateway assignment"
              >
                Save Configuration
              </ActionButton>
            </div>
          </div>
        </div>
      )}

      {approveItem && (
        <ApproveQuarantineModal
          item={approveItem}
          cells={cells}
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
        />
      )}
      {docsForDevice && (
        <EntityDocumentsModal entityType="device" entityId={docsForDevice.asset_id} entityName={docsForDevice.asset_name} onClose={() => { setDocsForDevice(null); setDocRefreshKey(k => k + 1) }} showToast={showToast} hasPermission={hasPermission} />
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
        title={selectedDevice?.asset_name || ''}
        subtitle={selectedDevice && (
          <>
            {/* ONE badge for the lifecycle state, not a status badge plus a QUARANTINED badge
                beside it -- a quarantined device used to be labelled OFFLINE and QUARANTINED at
                once, which reads as two facts and is one. ARCHIVED stays separate because it is a
                separate axis: a decommissioned device still has a last known lifecycle state. */}
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
            // The group comes from the SERVING GATEWAY, because that is where it lives: migration
            // 0008 put `sparkplug_group` on gateways, and a device's address is its edge node's
            // address plus its own id. Reading it here rather than printing `+` is the difference
            // between a topic you can paste into an MQTT client and one you have to finish first.
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
            // The inline <select> that used to be a whole table column, moved here and kept as a
            // control rather than flattened to text. It was ~170px of every row spent on a write
            // almost nobody performs, and a dropdown in a row someone is trying to READ is one
            // mis-scroll away from silently rebinding a device.
            label: 'Serving Gateway',
            full: true,
            value: (
              <select
                className="form-control form-control-sm"
                style={{ width: '100%' }}
                value={selectedDevice.active_gateway_id || ''}
                onChange={e => reassignGatewayInline(selectedDevice, e.target.value)}
                disabled={!canManage || selectedDevice.is_archived}
                title={!canManage
                  ? 'Requires Admin permissions'
                  : "Rebind this device to another edge node. This changes the DATA PATH, not the device's location."}
              >
                <option value="">Unassigned</option>
                {gateways.map(g => <option key={g.gateway_id} value={g.gateway_id}>{g.gateway_name}</option>)}
              </select>
            ),
            title: "The edge node carrying this device's data. Changing it changes the data path, not the location."
          },
          {
            // RESOLVED, not the explicit override -- the two read the same in the common case and
            // showing the wrong one is the exact confusion migration 0036 exists to prevent.
            label: 'Cell Zone (resolved)',
            value: selectedLocation?.location_scope === SCOPE_SITE_WIDE
              ? 'Site-Wide'
              : (cells.find(c => c.cell_id === selectedLocation?.effective_cell_id)?.cell_name || null),
            title: selectedLocation?.location_source === SOURCE_EXPLICIT
              ? 'Set on the device itself, so it stays here regardless of its gateway.'
              : selectedLocation?.location_scope === SCOPE_SITE_WIDE
                ? 'Marked Site-Wide: it belongs to no single cell.'
                : 'Inherited from its gateway. It will follow the gateway if that moves.'
          },
          {
            label: 'Location Source',
            value: selectedLocation?.location_source || null,
            title: 'explicit = set on the device; inherited = from its gateway; site_wide = no single cell; unassigned = nothing to inherit.'
          },
          { label: 'Schema', value: schemas.find(s => s.schema_uuid === selectedDevice.schema_id)?.schema_name || null },
          { label: 'Connection Method', value: selectedDevice.connection_method || null },
          {
            label: 'Classification',
            value: deviceTagList(selectedDevice, schemasForDevice(selectedDevice, schemas), latestFor(selectedDevice), catalog).join(', ') || null,
            full: true,
            title: "Derived from the metric groups this device's schema models, plus any live findings."
          },
        ] : []}
        actions={selectedDevice ? [
          // THE WHOLE OF THE OLD ACTIONS COLUMN, which was two visible buttons plus a six-item
          // overflow menu occupying the right-hand quarter of every row. All of it applies to one
          // device you have already picked, which is exactly what this drawer is.
          selectedDevice.is_archived ? {
            label: 'Restore Device', icon: <IconRefreshCw size={13} />,
            onClick: () => runRowAction(selectedDevice.asset_id, () => restoreDevice(selectedDevice.asset_id, selectedDevice.asset_name)),
            pending: rowBusyId === selectedDevice.asset_id,
            pendingLabel: 'Restoring…',
            disabled: !canArchive,
            primary: true,
            title: !canArchive ? 'Requires Admin permissions' : 'Restore device back to active service'
          } : {
            label: 'Edit Details', icon: <IconPencil size={13} />,
            onClick: () => { setEditing(selectedDevice); setForm(selectedDevice); setShowForm(true) },
            disabled: !canManage || selectedDevice.status === 'OFFLINE',
            primary: true,
            title: !canManage
              ? 'Requires Admin permissions'
              : selectedDevice.status === 'OFFLINE'
                ? 'Device is offline (DDEATH received)'
                : 'Edit device parameters'
          },
          {
            // Opens the modal rather than a section of this panel. The inspector is a four-column
            // table and 360px is not a table -- see TelemetryModal for the full history.
            label: 'View Realtime Telemetry', icon: <IconActivity size={13} />,
            onClick: () => setTelemetryFor(selectedDevice),
            title: "Open this device's metric inspector"
          },
          {
            // A read of what the device declared at birth, so it is deliberately NOT gated on
            // device:manage and not refused for an archived device -- same reasoning as the AAS
            // export and the schema download.
            label: 'Configuration Parameters', icon: <IconClipboardList size={13} />,
            onClick: () => setConfigAsset(selectedDevice),
            title: 'Inspect the DBIRTH metric parameters this device reported'
          },
          {
            // Directly above the two exports on purpose: it is the only thing here that changes
            // what they contain.
            label: 'Digital Nameplate…', icon: <IconClipboardList size={13} />,
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
          {
            // The accordion below lists the links; this is how a new one gets attached. Both are
            // needed now that the accordion no longer carries its own Manage button.
            label: 'Manage Documents', icon: <IconBookOpen size={13} />,
            onClick: () => setDocsForDevice(selectedDevice),
            title: 'Attach or edit external document links for this device'
          },
          {
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
        {/* The two row accordions, relocated. They are unchanged components -- both still fetch
            lazily on first expand -- but they now belong to ONE device instead of being mounted
            once per row. On a a hundred-device page that is a hundred collapsed drawers replaced
            by one, and the table below is a table again rather than alternating data and drawers. */}
        {selectedDevice && (
          <>
            {/* The documents accordion is gone -- a cramped list inside a 360px column, and the
                Manage Documents action above opens the full editor.

                THE 3D MODEL STAYS, because it was the accordion's footer and has nowhere else to
                go. It is an attachment like a document link, which is why it does not belong in
                the Configuration modal (a read-only view of what the device REPORTED) -- and
                unlike a list of links, one upload control fits a narrow column perfectly well.
                onChange reloads so model_3d_path cannot go stale. */}
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
