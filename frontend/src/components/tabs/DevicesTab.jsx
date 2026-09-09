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
  SCOPE_CELL, SCOPE_SITE_WIDE, SOURCE_EXPLICIT, SOURCE_SITE_WIDE, NON_CELL_SOURCES,
  resolveDeviceLocation, needsCellAssignment, unassignedHint,
  locationSourceLabel, gatewayAcceptsCell, noCellReason
} from '../../utils/cellResolution'
import {
  unmodelledMetrics, schemasForDevice, deviceTagList, deviceHasTag, availableTags, UNMODELLED_TAG
} from '../../utils/deviceTags'
import { assignableSchemas, isAssignableSchema, schemaStatus, statusLabel } from '../../utils/schemaVersion'
import { suggestMatches } from '../../utils/quarantineMatching'
import { patchFromForm, formFromPatch, submitProposal, nonProposableFields } from '../../utils/proposeFromForm'
import { gatewayAcceptsDevices, noDeviceAssignmentReason } from '../../utils/gatewayType'
import {
  IconShieldCheck,
  IconCpu,
  IconDrive,
  IconMap,
  IconFileText,
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
  IconX
} from '../common/Icons'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { useArrivalSelection } from '../../hooks/useArrivalSelection'

// Sentinel values for the cell filter's two derived lanes. Prefixed so they can never collide
// with a cell UUID, and kept out of `cells` because neither lane is a row in that table.
const CELL_FILTER_UNASSIGNED = '__unassigned__'
const CELL_FILTER_SITE_WIDE = '__site_wide__'

export function DevicesTab({ showToast, onSelectDevice, onSelectGateway, onSelectCell, onSelectSchema, onViewThread, onPropose, onViewApprovals, hasPermission, initialSearchFilter, onClearFilter, initialSchemaFilter, onClearSchemaFilter, activeAlerts = [] }) {
  /**
   * Firing alerts, indexed by the two keys a device can be matched on.
   *
   * BOTH KEYS, because the webhook resolves `device_id` best-effort: an alert whose sparkplug_id
   * matched no device row is still recorded, with a null device_id. Indexing on sparkplug_id alone
   * would be enough today and would silently stop matching the moment a device is re-registered
   * under a new UUID with the same wire id, which is exactly what a re-provision does.
   *
   * Severity ordering matters: a device with a critical AND a warning is a device with a critical on
   * it, so the reduce keeps the worst rather than the last one seen.
   */
  /**
   * Which devices have an alert firing on them.
   *
   * MOVED TO utils/deviceAlerts.js, not deleted (issue #34). This page resolved alerts against
   * devices correctly long before Overview, Cells and Gateways were asked to do the same -- and
   * copying the rules to three more call sites is how four pages end up disagreeing about which
   * device an alert belongs to. The reasoning that used to sit here now sits with the helper: it
   * indexes on BOTH `sparkplug_id` and `device_id` because a rename must not lose an alert and a
   * nullable `device_id` must not be the only key, and it keeps the WORST severity rather than the
   * last one seen.
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
  // Bumped when EntityLinksModal closes. It also drove a document-link count that nothing has
  // rendered since the row accordions retired into the context drawer; that count and its request
  // are gone. This survives because the telemetry/catalog read below keys on it too, and that one
  // is live -- a document edit is a reasonable moment to re-read, and it is the only signal here
  // that a human touched something.
  const [docRefreshKey, setDocRefreshKey] = useState(0)
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
  // (archived migration 0036), so a device registered without anyone choosing a location follows its
  // gateway rather than being pinned wherever the form happened to default.
  const [blank]                 = useState({ asset_id: '', asset_name: '', connection_method: 'Sparkplug B', active_gateway_id: '', schema_id: '', cell_id: '', location_scope: SCOPE_CELL })
  const [form, setForm]         = useState(blank)
  const [filterMode, setFilterMode] = useState('all')

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

  /**
   * A device row, shaped for the edit form.
   *
   * The only transformation is `schema_id`, and it is here rather than inline because the drawer and
   * the row's Edit action both open the same form and both used to seed it from the raw row.
   *
   * THE DROPDOWN MANAGES `devices.schema_id`, WHICH IS ONE OF THE TWO ROUTES A SCHEMA ARRIVES BY.
   * Seeding it with the resolved schema makes the control show what is actually attached, so saving
   * an unrelated field no longer silently clears the picker's apparent value. It also means saving
   * WRITES that id into `devices.schema_id` for a device that previously carried it only through
   * `device_submodels` -- which is harmless: schemasForDevice prefers the submodels either way, so
   * the two agreeing changes nothing about what is displayed or evaluated.
   *
   * AN EXPLICIT `schema_id` WINS OVER A SUBMODEL, which is the conservative precedence and not the
   * obvious one. This control edits that column, so a device that already carries a value there has
   * already answered the question the dropdown asks -- seeding from a submodel instead would show a
   * different schema and then WRITE it on the next save, silently reassigning a device because
   * somebody edited its description. The fallback only fills a hole; it never overrules an answer.
   *
   * A device with several submodels is the case this cannot represent, so it does not pretend to:
   * the form renders a note naming them. Silently dropping them would turn a save into a data loss
   * the operator had no way to see coming. Not hypothetical -- Sim_CNC_Mill_01 carries two.
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

      /* WHAT IS WAITING ON THESE MACHINES, so a device can say so on its own page rather than
         only on the Approvals page. RLS decides what comes back and this code does not
         second-guess it: a proposer sees their own requests, an approver sees the ones they may
         decide, and an empty list is a truthful answer for somebody entitled to neither. It is
         tolerated rather than required -- the devices page must not fail to load because the
         proposals endpoint did. */
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
      // Edit only, matching the control above: a device being created takes the column's own
      // default. Sending it on create would write 'audit' explicitly, which is the same value by
      // a longer route and makes the form look like it decided something it did not.
      if (editing) payload.conformance_policy = form.conformance_policy || 'audit'

      /* THE FORK IS HERE AND NOWHERE ELSE. Everything above -- the fields, their validation, the
         null handling -- is shared, which is the whole point: a second form for proposing was what
         drifted. Only the last step differs, and it differs by who is asking. */
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
      // AN UNREACHABLE MODEL URL OUTRANKS AN UNMAPPED METRIC, so it is reported first when both
      // are true. An unmapped semantic id degrades what a consumer can INFER from the shell; a
      // loopback 3D reference is a link that resolves to the exporter's own machine and nowhere
      // else -- discoverable otherwise only by opening the shell somewhere it does not work.
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
  const canPropose = hasPermission(PERMISSION_UUIDS.PROPOSAL_CREATE)

  /* THE FORM ENDS IN A PROPOSAL RATHER THAN A WRITE, for somebody who may not make the change.
     Derived, never stored: a second piece of state saying "this dialog is in propose mode" could
     disagree with the permission that decides whether the write would be accepted, and the form
     would offer Save to somebody the database then refuses.

     `editingProposal` is the open proposal this form is ADDING TO, if any. 0086 allows one open
     proposal per asset per person, so somebody changing a second field on the same machine has to
     extend the request they already have -- and this form, seeded with their earlier patch, is the
     only sane place to do it. */
  const proposeMode = !canManage && canPropose

  /**
   * The note under a field a proposal may not name.
   *
   * WITHHELD, NOT HIDDEN. Hiding these would make two different dialogs out of one -- the drift
   * this whole restructure removes -- and would conceal that a gateway assignment exists at all.
   * The control is disabled and the reason is printed, so the reader learns where the boundary is
   * instead of wondering why their change did not stick.
   */
  const Withheld = ({ field }) => (
    proposeMode && withheldFields[field]
      ? <div className="form-hint-locked">{withheldFields[field]}</div>
      : null
  )
  const [editingProposal, setEditingProposal] = useState(null)
  const withheldFields = nonProposableFields('device')
  const canReadThread = hasPermission(PERMISSION_UUIDS.DIGITAL_THREAD_READ)

  // Metrics the device declared at its last birth that its schema does not account for.
  // Derived, not stored: adding the metric to the schema clears this on the next poll rather
  // than waiting for the device to rebirth. See utils/deviceTags.js.
  const unmodelledFor = useCallback(
    (a) => unmodelledMetrics(a, schemasForDevice(a, schemas)),
    [schemas]
  )

  // ---------------------------------------------------------------------------------------------
  // INDEXES, NOT `Array.find`, for the two lookups that happen PER DEVICE ROW.
  //
  // `needsAttention` and the filter predicate below each resolve a device's gateway and its
  // effective cell, and both were doing it with `gateways.find(...)` / `cells.find(...)` -- a
  // linear scan inside a loop over every device, so the work was devices x gateways on every
  // render. On a four-cell demo that is invisible; on a real fleet it is the search box going
  // sticky, and the cause is nowhere near the search box.
  //
  // Built with useMemo so they survive renders that changed neither list -- which is most of them,
  // since this component holds thirty-odd pieces of state and any one of them re-renders it.
  // ---------------------------------------------------------------------------------------------
  const gatewayById = useMemo(
    () => new Map(gateways.map(g => [g.gateway_id, g])),
    [gateways]
  )
  const cellById = useMemo(
    () => new Map(cells.map(c => [c.cell_id, c])),
    [cells]
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
    !!a.effective_cell_id && !!cellById.get(a.effective_cell_id)?.is_archived

  const needsAttention = (a) =>
    a.is_quarantined || isProvisioningOverdue(a) || a.identity_source === 'legacy_name' ||
    unmodelledFor(a).length > 0 ||
    // Location findings. Unassigned is the work queue that should drain; a mismatch and an
    // archived cell are both "this resolved to something, but look at it".
    needsCellAssignment(a, gatewayById.get(a.active_gateway_id) || null) ||
    a.cell_mismatch || pointsAtArchivedCell(a)

  // ---------------------------------------------------------------------------------------------
  // MEMOISED, because this is the hot path and this component re-renders constantly.
  //
  // The predicate below is not cheap -- it resolves the device's schemas, its tags, its gateway and
  // its effective cell -- and it ran on every render, for every device. This component holds thirty
  // pieces of state; opening a modal, receiving a Realtime tick or typing one character in the
  // search box all re-ran the whole thing, and only the last of those actually changes the answer.
  //
  // THE DEPENDENCY LIST IS THE CONTRACT. Every value the predicate reads is named: miss one and the
  // table silently stops responding to that filter, which is a worse bug than the slowness this
  // fixes. They are listed in the order the predicate uses them so the two can be read together.
  // ---------------------------------------------------------------------------------------------
  const filteredAssets = useMemo(() => assets.filter(a => {
    // Quarantined devices belong to the Zero-Touch Onboarding Quarantine Queue above and
    // nowhere else. They used to appear here as well, so every pending device was listed
    // twice on the same screen -- once with approve/reject actions, once with the ordinary
    // edit/archive actions that do not apply to a device which has not been admitted yet.
    //
    // The two lists come from different sources (this filters `assets`; the banner renders
    // the `quarantine` state loaded from /api/v1/quarantine), so this is the only place the
    // separation can be enforced.
    if (a.is_quarantined) return false

    // REPLAY LANES ARE OUT BY DEFAULT, for the reason quarantined devices are: they are a different
    // KIND of row rendered by the same table, and mixing them silently is worse than either showing
    // or hiding them deliberately.
    //
    // `ensure_shadow_devices()` (0060) mints one per device a capture recorded, at the moment a
    // playback starts. So a stack that has never replayed has none, and the first playback would
    // otherwise double the device list -- six machines becoming twelve rows, the new ones
    // indistinguishable from the real ones and sitting next to the machines they replay.
    //
    // NOT FOLDED INTO `filterMode`, which is about the ARCHIVED lifecycle. A shadow device can be
    // archived or not, so it is an orthogonal axis and a four-way active/archived/shadow/all would
    // make one of those combinations unreachable.
    if (!showShadows && a.shadow_of) return false

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

  // Counts only what the "Needs attention" filter can actually reveal in the table below.
  // Quarantined devices are excluded because they are no longer rendered there -- they are
  // counted by the quarantine banner's own badge instead. Including them here would make the
  // number disagree with the rows shown the moment the filter is switched on, and would
  // double-count every pending device across the two badges.
  // `needsAttention` is a plain function rebuilt on every render, so naming IT here would defeat
  // the memo entirely. Its own inputs are named instead -- the two Maps and `unmodelledFor` are
  // everything it closes over that can change. (There is no eslint in this project to check that
  // for us, which is exactly why it is written down.)
  const attentionCount = useMemo(
    () => assets.filter(a => !a.is_quarantined && needsAttention(a)).length,
    [assets, gatewayById, cellById, unmodelledFor]
  )
  // COUNTED ACROSS EVERY DEVICE, not across the filtered list: it is the number the toggle reveals,
  // so counting the rows already on screen would report zero exactly when the button is most worth
  // pressing. Quarantined lanes are excluded for the same reason attentionCount excludes them --
  // they are rendered by the onboarding banner and not by this table.
  const shadowCount = useMemo(
    () => assets.filter(a => !a.is_quarantined && a.shadow_of).length,
    [assets]
  )
  // Walks every device's schemas and last-birth metrics to build the tag dropdown. Memoised for
  // the same reason as the filter: nothing about it changes when a modal opens.
  // Same reasoning: `latestFor` is rebuilt every render and closes over `latestBySparkplugId`,
  // which is the dependency that actually moves and is named here in its place.
  const tagOptions = useMemo(
    () => availableTags(assets, schemas, latestFor, catalog),
    [assets, schemas, latestBySparkplugId, catalog]
  )
  const activeFilterCount =
    [schemaFilter, statusFilter, tagFilter, gatewayFilter, cellFilter, searchQuery].filter(Boolean).length +
    (attentionOnly ? 1 : 0) + (showShadows ? 1 : 0) + (filterMode !== 'all' ? 1 : 0)
  const schemaName = schemas.find(s => s.schema_uuid === schemaFilter)?.schema_name

  // Arriving from a gateway's device chip, a schema's device chip, an alert row or the shopfloor
  // map: the caller named ONE device, so open it rather than leaving a one-row table to be clicked.
  // Identifier equality only -- typing a name into the search box opens nothing. See the hook.
  useArrivalSelection(
    searchQuery,
    assets,
    (a, term) => a.asset_id === term || effectiveSparkplugId(a) === term,
    (a) => setSelectedId(a.asset_id)
  )

  // Resolved fresh every render -- see the note on selectedId. A device that is archived out of
  // the current filter, or deleted, resolves to null and the drawer closes itself.
  const selectedDevice = assets.find(a => a.asset_id === selectedId) || null

  /* BOTH DEVICE LANES COUNT. `devices` and `device_nameplate` are two kinds of change to one
     machine, and both are keyed by the device's id -- so a nameplate request waiting on this
     device is a request waiting on this device, and hiding it here because it is filed under a
     different lane would be an accounting distinction, not a useful one. */
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

      {/* One card: title, description, primary action, filters, table. See CellsTab's note on why
          the filter bar came inside rather than floating above.

          The onboarding queue below stays INSIDE the body rather than above the card, and the
          reading order is the argument: what this page is, how to narrow it, the devices waiting to
          be let in, then the ones that are in. */}
      <div className="card">
        <div className="card-header">
          <h3 className="section-title">
            Devices <span className="section-count">{assets.length}</span>
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
          <p style={{ color: 'var(--text-muted)', fontSize: '13px', margin: '0 0 12px' }}>
            A device is an asset that publishes telemetry through a gateway. What it is MODELLED to
            publish comes from its schema; what it actually publishes is what the historian records,
            and the two disagreeing is the thing this page exists to surface — as a quarantine, an
            unmodelled metric, or a device that has never birthed at all.
          </p>

      {/* Filters live on their own row within the card: the header outgrew a single line once
          schema, status and relationship filters arrived. */}
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

        {/* SHOWN ONLY WHEN THERE ARE ANY, like the Archived toggle on the Access Control page. A
            permanent "Show shadow devices (0)" on every stack that has never played anything back would be
            a control for a feature most operators will not use, taking width from the filters they
            do. It appears the moment a playback mints the first lane, which is also the moment
            somebody wonders where the extra devices came from. */}
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

      {quarantine.length > 0 && (
        <div style={{ marginBottom: 'var(--stack)', background: 'rgba(255,179,0,0.08)', border: '1px solid var(--warning)', borderRadius: 'var(--radius)', padding: '12px var(--inset)' }}>
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

        </div>{/* .card-body */}

        {loading ? <div className="loading-wrap"><div className="spinner" /> Loading devices…</div> :
         filteredAssets.length === 0 ? (
           <div className="empty-state">
             <div className="empty-icon"><IconCpu size={36} /></div>
             <div className="empty-text">No devices match the selected filter.</div>
           </div>
         ) : (
          <div className="table-wrap">
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
                          {/* MARKED WHENEVER IT IS SHOWN, because the toggle that revealed it is a
                              filter and filters are forgotten. A replay lane sits beside the machine
                              it replays, with the same schema and similar readings, and the one
                              question a reader has about a number here is whether it happened.
                              A badge on the row answers that wherever the row is later seen. */}
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
                            // the drawer's subtitle and the shopfloor chip cannot disagree about
                            // the same row. Three states and no fourth: ONLINE, OFFLINE,
                            // QUARANTINED.
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
                                  {/* THE ALERT SITS BESIDE THE LIFECYCLE STATE, NOT INSTEAD OF IT.
                                      They answer different questions -- "is this machine talking to
                                      us" and "is Grafana unhappy about what it said" -- and an
                                      overheating machine is emphatically still ONLINE. Collapsing
                                      the two into one badge is what the withdrawn client-side alarm
                                      did, and it made a hot device indistinguishable from a
                                      disconnected one. */}
                                  {/* A LUCIDE GLYPH, NOT AN EMOJI. 🚨 and ⚠️ rendered at whatever
                                      size, weight and hue the operating system's emoji font chose:
                                      a full-colour raster on Windows, a flat outline on Linux, and
                                      neither inherits `currentColor`, so the badge's text went red
                                      or amber and the icon beside it did not follow. These are
                                      stroked SVGs at 11px that take their colour from the badge --
                                      the same treatment as the ARCHIVED and AWAITING FIRST BIRTH
                                      badges above, which is the other half of the reason: three
                                      badges in one column drawn from two different icon systems. */}
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

                            return <TagList limit={4} tags={entries}/>
                          })()}
                        </td>
                        <td style={{ maxWidth: '170px' }}>
                          {(() => {
                            // The resolved cell, plus how it was resolved. "Inherited" and
                            // "set on device" render the same name but behave differently when
                            // the gateway is reassigned, so the distinction has to be visible.
                            const gw = gatewayById.get(a.active_gateway_id) || null
                            const cellName = cellById.get(a.effective_cell_id)?.cell_name

                            // EVERY LANE THAT RESOLVES TO NO CELL, not just Site-Wide.
                            //
                            // This tested one source by hand and let the rest fall through to
                            // `!cellName`, which is how a fleet of simulated devices came to be
                            // reported as Unassigned: `device_locations` had answered `simulated`
                            // for all of them, and simulated resolves to a null cell exactly as
                            // Site-Wide does. The warning triangle then promised a queue to drain
                            // that could never drain -- unassignedHint() has no advice for a
                            // synthetic asset, because there is none to give.
                            //
                            // NON_CELL_SOURCES is the set cellResolution.js keeps for precisely
                            // this: its own comment warns that every consumer counting "devices
                            // with no cell" had grown a hand-written list, and this was the last
                            // one still carrying it.
                            if (NON_CELL_SOURCES.has(a.location_source)) {
                              return (
                                <span className="badge badge-neutral" style={{ fontSize: '11px' }}
                                      title={a.location_source === SOURCE_SITE_WIDE
                                        ? 'Asserted to have no single cell — facility-wide or mobile'
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

      {showForm && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-title">{editing ? 'Edit Device Configuration' : 'Register New Device'}</div>
            
            {/* EVERY FIELD IN HERE IS EDITABLE, WHICH IT WAS NOT BEFORE.
                The Sparkplug ID and Internal UUID blocks that used to sit under the name are gone.
                They were three of the form's five rows and none of them could be changed -- an edit
                dialog whose majority is read-only teaches the reader that its controls are decorative,
                and both identifiers are on the context drawer beside every other fact about the
                device, where they are copyable and where somebody looking for an identifier actually
                goes. The publish-topic helper went with them for the same reason: it is a fact to
                read, not a value to set, and the drawer is where facts live. */}
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
                {/* A REPLAY LANE IS LISTED BUT DISABLED, not filtered out. Issue 144.
                    Filtering would be a quieter control and a worse one: a device that IS a
                    replay lane would open this form with its own gateway absent from the list,
                    the select would fall back to "Unassigned", and saving would silently move it
                    off the lane. The disabled option keeps an existing lane displaying correctly
                    and still cannot be chosen. migration 0083 refuses the write either way. */}
                {gateways.filter(g => !g.is_archived).map(g => (
                  <option key={g.gateway_id} value={g.gateway_id} disabled={!gatewayAcceptsDevices(g)}>
                    {g.gateway_name} ({g.gateway_id}) — Status: {g.status}
                    {gatewayAcceptsDevices(g) ? '' : ' — replay lane, not assignable'}
                  </option>
                ))}
              </select>
              {/* Shown ALWAYS rather than only when a lane is selected: the question this answers
                  is "why can I not pick Playback", which is asked while something else is
                  selected. */}
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                {noDeviceAssignmentReason({ is_shadow: true })}
              </div>
            </div>

            {/* WHERE the device is, which is not the same question as how its data reaches us.
                Leaving the picker on "Inherit" is the normal case and stores NULL; picking a cell
                stores an override that wins over the gateway's. See archived migration 0036. */}
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
              // Whether a cell means anything for this device at all, decided by its GATEWAY. See
              // gatewayAcceptsCell(): there is no CHECK on the device side, so a cell stored here
              // would be accepted and then ignored -- device_locations resolves the synthetic lanes
              // ahead of every cell arm.
              const acceptsCell = gatewayAcceptsCell(formGateway)

              return (
                <div className="form-group">
                  <label className="form-label" htmlFor="device-cell-zone">Shopfloor Cell Zone</label>
                  {/* SITE-WIDE IS AN OPTION HERE, NOT A CHECKBOX BELOW.
                      One question, one control -- and `devices_site_wide_has_no_cell` makes the
                      answers exclusive in the database, so a tick box that had to reach over and
                      clear the select was modelling that exclusion twice. Its option value is
                      SCOPE_SITE_WIDE, which cannot collide with a cell id: those are UUIDs. */}
                  <select
                    id="device-cell-zone"
                    className="form-control"
                    value={siteWide ? SCOPE_SITE_WIDE : (form.cell_id || '')}
                    disabled={!acceptsCell}
                    onChange={e => setForm(f => (e.target.value === SCOPE_SITE_WIDE
                      ? { ...f, location_scope: SCOPE_SITE_WIDE, cell_id: '' }
                      : { ...f, location_scope: SCOPE_CELL, cell_id: e.target.value }))}
                    title={acceptsCell
                      ? 'Where this device physically sits. Leave on Inherit to follow its gateway.'
                      : 'Its gateway generates or replays this telemetry, so the device resolves to a lane rather than to a cell'}
                  >
                    {/* Named after what it resolves to, not "None" -- the empty value is a
                        deliberate "follow the gateway", not an absence. */}
                    <option value="">
                      {inheritedName ? `— Inherit from gateway (${inheritedName}) —` : '— Inherit from gateway (gateway has no cell) —'}
                    </option>
                    <option value={SCOPE_SITE_WIDE}>Site-Wide — no single cell</option>
                    {cells.filter(c => !c.is_archived).map(c => (
                      <option key={c.cell_id} value={c.cell_id}>{c.cell_name}</option>
                    ))}
                    {/* An archived cell is not offered, but one already stored stays visible:
                        silently dropping it would relocate the device on the next save. */}
                    {chosenCell?.is_archived && (
                      <option value={chosenCell.cell_id}>{chosenCell.cell_name} (archived)</option>
                    )}
                  </select>

                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
                    {!acceptsCell
                      /* DELIBERATELY DOES NOT CLEAR `cell_id`. Unlike the gateway form, nothing
                         here would be refused on save -- so a stored cell is kept and simply not
                         in force, and it comes back into force by itself if the gateway stops
                         being synthetic. Clearing it would destroy an operator's filing to enforce
                         a rule the database does not have. */
                      ? `${noCellReason(formGateway)} Any cell already set on it is kept, and applies again if that changes.`
                      : siteWide
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
              <Withheld field="schema_id" />
              {/* ARCHIVED VERSIONS ARE NOT OFFERED (issue #167). assignableSchemas() keeps the one
                  this device already carries so an unfinished migration still renders as itself;
                  everything else archived is gone from the list. The label carries the status for
                  the kept one, because an option reading `Test_Schema` beside `Test_Schema_v2`
                  gives no reason not to pick it -- which is exactly how the bug was reported.
                  The database refuses the write as well (0093); this is the half that stops an
                  operator being offered the mistake in the first place. */}
              <select className="form-control" disabled={proposeMode} value={form.schema_id || ''} onChange={e => setForm(f => ({ ...f, schema_id: e.target.value }))} title={proposeMode ? withheldFields.schema_id : "Expected metric schema, from the Schemas registry. Archived versions are not offered — publish a version instead of reattaching the one it replaced."}>
                <option value="">— No schema assigned —</option>
                {assignableSchemas(schemas, form.schema_id).map(s => (
                  <option key={s.schema_uuid} value={s.schema_uuid}>
                    {isAssignableSchema(s) ? s.schema_name : `${s.schema_name} · ${statusLabel(schemaStatus(s))}`}
                  </option>
                ))}
              </select>
              {/* WHAT THIS FIELD IS FOR, IN THE ORDER IT MATTERS. This read "Used to suggest a
                  match if a differently-named device shows up in quarantine..." and named ONLY
                  that -- which is true, and is the smaller of the two things a schema does. It
                  is the contract every DDATA value from this device is judged against, and under
                  Schema Conformance = Enforce that judgement DROPS readings. Describing the
                  quarantine hint and not the drop let somebody attach a schema believing it was a
                  labelling aid. The quarantine sentence stays, second, because suggestMatches()
                  really does weight a required-metric overlap above a name similarity. */}
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                The contract this device's metrics are judged against — see Schema Conformance below,
                which decides whether a violation is recorded or the reading is dropped. Optional:
                with none attached nothing is judged. It also helps identify this device if it turns
                up in quarantine under another name, by matching the metrics it reports against the
                schema's required fields.
              </div>
              {/* Said only when it applies, and it says what to do rather than what happened.
                  Reaching this means the device is on a version its lineage has moved past, which
                  is a migration to finish rather than a setting to change here. */}
              {form.schema_id && !isAssignableSchema(schemas.find(s => s.schema_uuid === form.schema_id)) && (
                <div style={{ fontSize: '11px', color: 'var(--warning-text)', marginTop: '6px' }}>
                  This device is still on an archived version. It is kept selectable so saving does not
                  silently detach it — move it forward by publishing from the Schemas page, not from here.
                </div>
              )}
              {/* THE ONE CASE A SINGLE-SELECT CANNOT STATE. A device may carry several submodels
                  (device_submodels, archived migration 0034) and this control writes the 1:1 devices.schema_id.
                  Selecting the first and saying nothing would let somebody press Save believing they
                  had seen the whole picture and quietly disagree with the drawer beside them, which
                  lists all of them. Naming the others is the smallest honest version of that. */}
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

            {/* Only when editing. A device being created has no schema attached yet, so the
                control would offer a choice that cannot do anything, and the column defaults to
                'audit' server-side anyway (0050). */}
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

                {/* THE STATE THAT LOOKS LIKE IT WORKED AND DOES NOTHING. With no schema attached
                    the daemon has nothing to judge against, so 'enforce' is inert -- and an
                    operator who set it would reasonably believe they had switched something on.
                    Same instinct as the multi-submodel note above the Schema picker. */}
                {form.conformance_policy === 'enforce'
                  && schemasForDevice(editing, schemas).length === 0 && (
                  <div style={{ fontSize: '11px', color: 'var(--warning-text)', marginTop: '6px' }}>
                    This device has no schema attached, so enforcing does nothing — there is
                    nothing to judge a value against. Attach a schema above first.
                  </div>
                )}

                {/* THE WARNING IS SHOWN ON THE CHANGE, not on the state. Somebody reopening a
                    device that already enforces does not need to be told again; somebody about to
                    turn it on does, because what it discards cannot be fetched back from anywhere.
                    Telemetry is not like a schema edit, which can be reverted. */}
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

            {/* THE CONNECTION METHOD PICKER IS GONE, and it was the field most likely to be believed.
                It offered OPC-UA, Modbus TCP and HTTP REST beside Sparkplug B as though choosing one
                changed how the device is read. Nothing acts on the column: ingestion is a Sparkplug B
                MQTT subscriber and has no other transport, so picking Modbus recorded a claim the
                platform then contradicted on every message. The value still displays in the drawer,
                where it reads as a fact about the asset rather than as a setting.

                Adding a second transport means adding an ingestion path for it. The picker can come
                back then, and it will mean something. */}

            {/* THE RATIONALE, ONLY WHEN THERE IS SOMEBODY TO READ IT. A person saving their own
                change has nobody to explain it to; a person proposing one is writing to an
                approver who has to decide without having stood in front of the machine. */}
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
                title={proposeMode
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
            // A LINK, NOT A PICKER. This was an inline <select> for rebinding the device to another
            // edge node -- a write almost nobody performs, sitting in the panel people open to READ,
            // one mis-scroll away from silently moving a device's data path. Reassignment still
            // exists in Edit Details, where a destructive change belongs behind an explicit save.
            //
            // What the field is asked ninety-nine times out of a hundred is "which gateway is this,
            // and take me to it", so that is what it now does.
            label: 'Serving Gateway',
            full: true,
            value: selectedDevice.active_gateway_id ? (
              <button
                className="chip chip-link"
                onClick={() => onSelectGateway?.(selectedDevice.active_gateway_id)}
                title="Open this gateway on the Gateways page"
              >
                <IconDrive size={11} />
                <span className="chip-name">
                  {gateways.find(g => g.gateway_id === selectedDevice.active_gateway_id)?.gateway_name
                    || selectedDevice.gateway_name || selectedDevice.active_gateway_id}
                </span>
              </button>
            ) : null,
            title: "The edge node carrying this device's data. Reassign it in Edit Details."
          },
          {
            // RESOLVED, not the explicit override -- the two read the same in the common case and
            // showing the wrong one is the exact confusion archived migration 0036 exists to prevent.
            //
            // Site-Wide is deliberately NOT a link. It is the assertion that this device belongs to
            // no cell, so there is nowhere for the link to go -- and a chip that looked identical to
            // the others and did nothing would be worse than plain text.
            label: 'Cell Zone (resolved)',
            value: selectedLocation?.location_scope === SCOPE_SITE_WIDE
              ? 'Site-Wide'
              : (() => {
                  const cell = cells.find(c => c.cell_id === selectedLocation?.effective_cell_id)
                  if (!cell) return null
                  return (
                    <button
                      className="chip chip-link"
                      onClick={() => onSelectCell?.(cell.cell_id)}
                      title="Open this cell on the Cells page"
                    >
                      <IconMap size={11} />
                      <span className="chip-name">{cell.cell_name}</span>
                    </button>
                  )
                })(),
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
          {
            // RESOLVED THROUGH schemasForDevice, NOT OFF selectedDevice.schema_id, and that was a
            // real bug rather than a tidy-up. A schema reaches a device by either of two routes: the
            // 1:1 `devices.schema_id`, or a row in `device_submodels` (archived migration 0034, surfaced by
            // api.js as `submodel_schema_ids`). This field read only the first, so every device
            // the retired class-schema migration attached a schema to -- which was all six on the demo floor --
            // showed "Not set" in the drawer while the table beside it, which has always used
            // schemasForDevice, listed the schema's tags. Two views of one row disagreeing.
            //
            // ALL OF THEM, not the first. A device may carry several submodels; rendering one chip
            // would restate the same bug one submodel later.
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
                      <IconFileText size={11} />
                      <span className="chip-name">{schema.schema_name}</span>
                    </button>
                  ))}
                </div>
              )
            })(),
            full: true,
            title: 'The metric contract(s) this device is judged against. Opens on the Schemas page.'
          },
          /* CONNECTION METHOD IS GONE FROM HERE TOO, which finishes what removing the picker
             started. Dropping the form control but keeping the read-only field left the drawer
             stating a transport as though it were a fact about the device -- and it is not one.
             Ingestion is a Sparkplug B MQTT subscriber with no other transport, so a device row
             reading "Modbus TCP" describes nothing that happens: the column is a leftover claim
             that the platform contradicts on every message it receives. A field nothing writes and
             nothing acts on is not documentation, it is a second answer to a question that already
             has one. The column itself is left in place; this is a UI removal, not a migration. */
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
            icon: <IconPencil size={13} />,
            // THE FORM IS SEEDED WITH THE RESOLVED SCHEMA, not with the raw row. `setForm(device)`
            // copied `schema_id` straight across, which is null for every device whose schema
            // arrives through `device_submodels` -- so the dropdown read "No schema assigned" for a
            // device the rest of the page correctly showed as schema'd, and saving that form
            // silently confirmed the wrong answer.
            label: proposeMode ? 'Propose a Change' : 'Edit Details',
            onClick: () => {
              setEditing(selectedDevice)
              // SEEDED WITH THE OPEN PROPOSAL'S PATCH ALREADY APPLIED, when there is one. Otherwise
              // adding a second field to a request would silently drop the first -- the new
              // proposal would replace it, and the per-asset cap would refuse it anyway.
              const mine = proposeMode ? openForSelected.find(pr => pr.entity_type === 'devices') : null
              setEditingProposal(mine || null)
              setForm({ ...editFormFor(selectedDevice), ...formFromPatch('device', mine?.patch) })
              setShowForm(true)
            },
            disabled: (!canManage && !canPropose) || selectedDevice.status === 'OFFLINE',
            // NOT `primary`, which is the change. It was the one filled button in a drawer whose
            // other five actions are ghosts, which read as a recommendation -- and "edit this" is not
            // what anybody opens a device panel to do. The Gateways and Cells drawers already style
            // their edit action as a secondary; this matches them.
            title: selectedDevice.status === 'OFFLINE'
              ? 'Device is offline (DDEATH received)'
              : proposeMode
                ? 'Ask for a change to this device — an approver applies it, or says why not'
                : !canManage && !canPropose
                  ? 'Requires Admin permissions'
                  : 'Edit device parameters'
          },
          /* NO SEPARATE "PROPOSE A CHANGE" ACTION, and its absence is the point of the whole
             restructure. It used to sit here and route to a composer on the Approvals page -- a
             SECOND form listing the same columns as the dialog directly above it, as bare text
             inputs, with no idea that `cell_id` had a dropdown behind it. Two forms describing one
             device is a drift generator, and the drift is silent.

             The dialog above is now the only form. For somebody who may not save it, it opens
             under the label "Propose a Change" and its footer files a proposal instead of writing
             -- see `proposeMode`. One form, one set of fields, one place to change them. */
          /* WHAT IS ALREADY WAITING ON THIS MACHINE, and only when something is.
             A device with an open request is the one case where the queue is part of this
             device's state rather than a separate page, and both readers need it: a proposer
             about to file a second request that the per-asset cap will refuse, and an approver
             who arrived here from an alert. The count comes from RLS, so it is what THIS person
             may see rather than a number they cannot act on. */
          openForSelected.length > 0 && {
            label: openForSelected.length === 1
              ? '1 change awaiting decision'
              : `${openForSelected.length} changes awaiting decision`,
            icon: <IconShieldCheck size={13} />,
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
            // A read of what the device declared at birth, so it is deliberately NOT gated on
            // device:manage and not refused for an archived device -- same reasoning as the AAS
            // export and the schema download.
            label: 'Configuration Parameters', icon: <IconClipboardList size={13} />,
            onClick: () => setConfigAsset(selectedDevice),
            title: 'Inspect the DBIRTH metric parameters this device reported'
          },
          /* WITHDRAWN FROM A REPLAY LANE, and 0060 makes the argument rather than taste:
             "NO NAMEPLATE. device_nameplate (0011) is IDTA Nameplate -- manufacturer, SERIAL
             NUMBER, year of construction. A serial number identifies one physical object. Copying
             it would leave the platform holding two rows claiming to be serial XYZ-4471, and the
             AAS Part 5 export would emit two Asset Administration Shells asserting the same asset
             identity, which is the exact thing AAS identity exists to prevent."

             So offering the editor here offers to create precisely the row the migration exists to
             prevent -- and it would be created by hand, one field at a time, with nothing to stop
             it. A shadow is a recording of an asset, not a second asset. */
          !selectedDevice.shadow_of && {
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
          /* ALSO WITHDRAWN FROM A REPLAY LANE, for 0060's second rule: "NO LINKS. `links` are
             documents ABOUT the machine, and a copy goes stale the moment someone edits the
             original. `shadow_of` resolves them at read time instead."

             A lane's documents ARE the machine's documents, reached through shadow_of. Attaching
             one here would create the second copy that rule exists to prevent -- and it would go
             stale silently, which is the failure mode that makes a duplicated document worse than
             no document. */
          !selectedDevice.shadow_of && {
            // The accordion below lists the links; this is how a new one gets attached. Both are
            // needed now that the accordion no longer carries its own Manage button.
            label: 'Manage Links', icon: <IconBookOpen size={13} />,
            onClick: () => setDocsForDevice(selectedDevice),
            title: 'Attach or edit links for this device — documents, an asset register, a file repository, any URL'
          },
          /* WITHHELD FROM A READER WHO MAY NOT OPEN THE PAGE. The nav hides Digital Thread
             without `digital_thread:read`; a drawer button that navigated there anyway would be
             the one route into a page the app has decided not to show, landing them on an empty
             table that explains nothing. `.filter(Boolean)` below drops it. */
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
        {/* The two row accordions, relocated. They are unchanged components -- both still fetch
            lazily on first expand -- but they now belong to ONE device instead of being mounted
            once per row. On a a hundred-device page that is a hundred collapsed drawers replaced
            by one, and the table below is a table again rather than alternating data and drawers. */}
        {selectedDevice && (
          <>
            {/* The links accordion is gone -- a cramped list inside a 360px column, and the
                Manage Links action above opens the full editor.

                THE 3D MODEL STAYS, because it was the accordion's footer and has nowhere else to
                go. It is an attachment like a link, which is why it does not belong in
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
