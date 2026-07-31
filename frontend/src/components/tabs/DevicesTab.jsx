import React, { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../lib/supabaseClient'
import { api } from '../../api'
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
import { InlineDocumentAccordion } from '../common/InlineDocumentAccordion'
import { QuarantinePayloadCell } from '../common/QuarantinePayloadCell'
import { ApproveQuarantineModal } from '../modals/ApproveQuarantineModal'
import { ArchiveModal } from '../modals/ArchiveModal'
import { AssetConfigModal } from '../modals/AssetConfigModal'
import { DigitalThreadModal } from '../modals/DigitalThreadModal'
import { EntityDocumentsModal } from '../modals/EntityDocumentsModal'
import { isProvisioningOverdue, isNeverSeen } from '../../utils/deviceProvisioning'
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
  IconFileText,
  IconChevronDown,
  IconChevronUp,
  IconShieldAlert,
  IconAlertTriangle,
  IconLock,
  IconDownload,
  IconX
} from '../common/Icons'

export function DevicesTab({ showToast, onSelectDevice, hasPermission, initialSearchFilter, onClearFilter, initialSchemaFilter, onClearSchemaFilter }) {
  const [assets, setAssets]     = useState([])
  const [cells, setCells]       = useState([])
  const [gateways, setGateways] = useState([])
  const [schemas, setSchemas]   = useState([])
  const [quarantine, setQuarantine] = useState([])
  const [loading, setLoading]   = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing]   = useState(null)
  const [approveItem, setApproveItem] = useState(null)
  const [archiveTarget, setArchiveTarget] = useState(null)
  const [configAsset, setConfigAsset] = useState(null)
  const [threadFor, setThreadFor] = useState(null)
  const [docsForDevice, setDocsForDevice] = useState(null)
  const [expandedDeviceDocs, setExpandedDeviceDocs] = useState({})
  const [docRefreshKey, setDocRefreshKey] = useState(0)
  // No asset_type: a device's classification is now derived from the metric groups its schema
  // models (see utils/deviceTags.js), not typed in by hand. The column is left in place so
  // legacy values keep displaying, but nothing writes it any more.
  const [blank]                 = useState({ asset_id: '', asset_name: '', connection_method: 'Sparkplug B', active_gateway_id: '', schema_id: '' })
  const [form, setForm]         = useState(blank)
  const [filterMode, setFilterMode] = useState('all')

  const toggleDeviceDocExpand = id => setExpandedDeviceDocs(prev => ({ ...prev, [id]: !prev[id] }))

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

  // A device's cell is whatever cell its gateway belongs to; there is no direct link.
  const cellNameForGateway = (gatewayId) => {
    const gw = gateways.find(g => g.gateway_id === gatewayId)
    if (!gw?.cell_id) return ''
    return cells.find(c => c.cell_id === gw.cell_id)?.cell_name || ''
  }

  const save = async () => {
    try {
      // asset_type is deliberately not sent: omitting it leaves any legacy value intact
      // (api.js only patches keys present in the body) rather than nulling it on every edit.
      const payload = {
        asset_name: form.asset_name,
        connection_method: form.connection_method || null,
        active_gateway_id: form.active_gateway_id || null,
        schema_id: form.schema_id || null,
      }
      if (editing) {
        await api.put(`/api/v1/devices/${editing.asset_id}`, payload)
      } else {
        // No asset_id: the devices table generates the UUID (gen_random_uuid()).
        await api.post('/api/v1/devices', payload)
      }
      setShowForm(false); loadAll(); showToast('Device saved successfully', 'success')
    } catch (e) { showToast(e.message, 'error') }
  }

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
      const { data, error } = await supabase.functions.invoke('approve-quarantine', {
        // asset_name carries the operator's correction to the label the device announced
        // itself under. It was collected by the modal and then dropped on the floor here.
        body: { device_id: assetId, gateway_id: targetGateway, asset_name: body?.asset_name }
      })

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
      const { data, error } = await supabase.functions.invoke('approve-quarantine', {
        body: { device_id: assetId, merge_into_device_id: candidateId }
      })

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
  const needsAttention = (a) =>
    a.is_quarantined || isProvisioningOverdue(a) || a.identity_source === 'legacy_name' ||
    unmodelledFor(a).length > 0

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
    if (tagFilter && !deviceHasTag(a, schemasForDevice(a, schemas), tagFilter)) return false
    if (gatewayFilter && (a.active_gateway_id || '') !== gatewayFilter) return false
    if (cellFilter && (a.cell_id || '') !== cellFilter) return false
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
  const tagOptions = availableTags(assets, schemas)
  const activeFilterCount =
    [schemaFilter, statusFilter, tagFilter, gatewayFilter, cellFilter, searchQuery].filter(Boolean).length +
    (attentionOnly ? 1 : 0) + (filterMode !== 'all' ? 1 : 0)
  const schemaName = schemas.find(s => s.schema_uuid === schemaFilter)?.schema_name

  return (
    <>
      <div className="section-header" style={{ marginBottom: '8px' }}>
        <h2 className="section-title">Shopfloor Devices <span className="section-count">{assets.length}</span></h2>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          {/* Tags are derived at render time, so a raw row dump would export a device list with
              no classification in it at all -- the one column an engineer reading the export
              most likely wants. Projected in explicitly. */}
          <button className="btn btn-ghost btn-sm" onClick={() => downloadCSV(filteredAssets.map(a => ({
            ...a,
            device_tags: deviceTagList(a, schemasForDevice(a, schemas)).join(' ')
          })), 'devices-export.csv')} title="Download the filtered devices list as CSV"><IconDownload size={13} /> Export CSV</button>
          <button
            className={`btn btn-primary ${!canManage ? 'btn-disabled' : ''}`}
            disabled={!canManage}
            onClick={() => canManage && (setEditing(null), setForm(blank), setShowForm(true))}
            title={!canManage ? 'Requires Admin permissions' : 'Register new shopfloor device'}
          >
            <IconPlus size={14} /> New Device
          </button>
        </div>
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '16px' }}>
        Manage shopfloor manufacturing devices, review Zero-Touch onboarding quarantine queue, inspect DBIRTH configuration parameters, and decommission assets.
      </p>

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

        {/* A device's cell is its gateway's cell -- there is no devices.cell_id column. */}
        <select className="form-control" style={{ width: '170px' }} value={cellFilter} onChange={e => setCellFilter(e.target.value)} title="Filter by cell zone, derived from the device's gateway">
          <option value="">Any cell</option>
          {cells.map(c => <option key={c.cell_id} value={c.cell_id}>{c.cell_name}</option>)}
        </select>

        <button
          className={`btn btn-sm ${attentionOnly ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setAttentionOnly(v => !v)}
          title="Show only devices that are overdue their first birth, still matched by legacy name, or publishing metrics their schema does not model. Quarantined devices are listed separately in the onboarding queue above."
        >
          <IconAlertTriangle size={13} /> Needs attention ({attentionCount})
        </button>

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
                        <div style={{ fontSize: '10px', color: 'var(--danger)', marginTop: '3px', display: 'flex', alignItems: 'flex-start', gap: '3px' }}>
                          <IconAlertTriangle size={10} style={{ flexShrink: 0, marginTop: '1px' }} />
                          <span style={{ minWidth: 0 }}>{q.quarantine_reason}</span>
                        </div>
                      )}
                      {suggestion && (
                        <div style={{ fontSize: '10px', color: 'var(--warning-text)', marginTop: '3px', display: 'flex', alignItems: 'center', gap: '3px' }} title={suggestion.evidence}>
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
                        <button
                          className={`btn btn-danger btn-sm ${!canReject ? 'btn-disabled' : ''}`}
                          disabled={!canReject}
                          onClick={() => canReject && rejectQuarantine(q)}
                          title={!canReject ? 'Requires Admin permissions' : 'Reject quarantine payload'}
                        >
                          Reject
                        </button>
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
              <thead><tr><th title="Human-readable device name">Name</th><th title="Sparkplug B id this device publishes under">Sparkplug ID</th><th title="Device status">Status</th><th title="Device classification">Type</th><th title="Assigned cell zone">Cell</th><th title="Serving edge gateway (reassignable)">Serving Edge Gateway</th><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
              <tbody>
                {filteredAssets.map(a => {
                  const isOff = a.status === 'OFFLINE'
                  return (
                    <React.Fragment key={a.asset_id}>
                      <tr style={{ background: a.is_archived ? 'rgba(255,179,0,0.06)' : undefined }}>
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
                            <div style={{ fontSize: '10px', color: 'var(--warning-text)', marginTop: '3px', display: 'flex', alignItems: 'center', gap: '3px' }} title="This device is still matched by name. Reconfigure its gateway to publish the Sparkplug ID; name matching will be removed.">
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
                            <span className={`badge ${isOff ? 'badge-neutral' : 'badge-online'}`} title={isOff ? 'Sparkplug B DDEATH Received — Device Offline' : 'Device Active'}>
                              <span className="badge-dot" style={{ background: isOff ? 'var(--text-muted)' : 'var(--success)' }} />
                              {isOff ? 'Offline / DDEATH' : 'Online'}
                            </span>
                          )}
                        </td>
                        <td>
                          {(() => {
                            const schema = schemasForDevice(a, schemas)
                            const tags = deviceTagList(a, schema)
                            const extra = unmodelledMetrics(a, schema)
                            if (tags.length === 0 && !a.asset_type) return '—'
                            return (
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center' }}>
                                {tags.map(tag => tag === UNMODELLED_TAG ? (
                                  <span
                                    key={tag}
                                    className="badge badge-warning"
                                    style={{ background: 'rgba(255,179,0,0.15)', color: 'var(--warning-text)', border: '1px solid var(--warning)', fontSize: '10px' }}
                                    title={`Declared at its last birth but absent from schema '${schema?.schema_name}': ${extra.join(', ')}`}
                                  >
                                    <IconAlertTriangle size={10} /> {tag} ({extra.length})
                                  </span>
                                ) : (
                                  <span key={tag} className="badge badge-neutral" style={{ fontSize: '10px' }} title={`This device's schema models ${tag}.* metrics`}>
                                    {tag}
                                  </span>
                                ))}
                                {/* Free-text classification from before types were derived. Shown
                                    so the value is not silently lost, but nothing writes it now. */}
                                {a.asset_type && (
                                  <span style={{ fontSize: '10px', color: 'var(--text-dim)', fontStyle: 'italic' }} title="Legacy free-text classification. Assign a schema to derive this instead.">
                                    {a.asset_type}
                                  </span>
                                )}
                              </div>
                            )
                          })()}
                        </td>
                        <td>{cells.find(c => c.cell_id == a.cell_id)?.cell_name || '—'}</td>
                        <td>
                          <select className="form-control form-control-sm" style={{ width: '100%' }} value={a.active_gateway_id || ''} onChange={e => reassignGatewayInline(a, e.target.value)} disabled={!canManage || a.is_archived}>
                            <option value="">Unassigned</option>
                            {gateways.map(g => <option key={g.gateway_id} value={g.gateway_id}>{g.gateway_name}</option>)}
                          </select>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <div className="btn-group" style={{ justifyContent: 'flex-end' }}>
                            <button className="btn btn-ghost btn-sm" onClick={() => toggleDeviceDocExpand(a.asset_id)} title="Toggle attached document links accordion">
                              <IconFileText size={13} /> Docs {expandedDeviceDocs[a.asset_id] ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
                            </button>
                            <button className="btn btn-ghost btn-sm" onClick={() => onSelectDevice(a.asset_id)} title="View live telemetry for this device">
                              <IconActivity size={13} /> Telemetry
                            </button>
                            <button className="btn btn-ghost btn-sm" onClick={() => setThreadFor(a)} title="View device Digital Thread audit trace"><IconHistory size={13} /> Thread</button>
                            {/* Read-only and available to every role that can see the device: an
                                export is a read, and handing a partner a shell is the point.
                                Two formats, one control: JSON is the AAS Part 5 Environment every
                                tool reads, AASX the OPC package it is normally shipped in. A
                                select rather than two buttons keeps the already-crowded row from
                                growing, and makes them read as one action with a choice. */}
                            <select
                              className="form-control form-control-sm"
                              style={{ width: 'auto', display: 'inline-block' }}
                              value=""
                              disabled={exportingAas === a.asset_id}
                              onChange={e => { if (e.target.value) { exportAas(a, e.target.value); e.target.value = '' } }}
                              title="Download this device's Asset Administration Shell (IEC 63278)"
                            >
                              <option value="">
                                {exportingAas === a.asset_id ? 'Exporting…' : 'Export AAS ▾'}
                              </option>
                              <option value="json">Export JSON (AAS V3)</option>
                              <option value="aasx">Export AASX Package</option>
                            </select>
                            <button
                              className={`btn btn-ghost btn-sm ${!canManage || a.is_archived ? 'btn-disabled' : ''}`}
                              disabled={!canManage || a.is_archived}
                              onClick={() => canManage && !a.is_archived && setConfigAsset(a)}
                              title={!canManage ? 'Requires Admin permissions' : a.is_archived ? 'Device is archived' : 'Inspect DBIRTH metric parameters'}
                            >
                              <IconClipboardList size={13} /> Config
                            </button>

                            {a.is_archived ? (
                              <button
                                className={`btn btn-primary btn-sm ${!canArchive ? 'btn-disabled' : ''}`}
                                disabled={!canArchive}
                                onClick={() => canArchive && restoreDevice(a.asset_id, a.asset_name)}
                                title={!canArchive ? 'Requires Admin permissions' : 'Restore device back to active service'}
                              >
                                <IconRefreshCw size={12} /> Restore
                              </button>
                            ) : (
                              <button
                                className={`btn btn-ghost btn-sm ${!canArchive ? 'btn-disabled' : ''}`}
                                disabled={!canArchive}
                                onClick={() => canArchive && setArchiveTarget(a)}
                                title={!canArchive ? 'Requires Admin permissions' : 'Decommission & Archive Device'}
                              >
                                <IconArchive size={13} /> Archive
                              </button>
                            )}

                            <button
                              className={`btn btn-ghost btn-sm ${!canManage || isOff || a.is_archived ? 'btn-disabled' : ''}`}
                              disabled={!canManage || isOff || a.is_archived}
                              onClick={() => canManage && !isOff && !a.is_archived && (setEditing(a), setForm(a), setShowForm(true))}
                              title={!canManage ? 'Requires Admin permissions' : a.is_archived ? 'Device is archived' : isOff ? 'Device is offline (DDEATH received)' : 'Edit device parameters'}
                            >
                              <IconPencil size={13} /> Edit
                            </button>
                          </div>
                        </td>
                      </tr>
                      {expandedDeviceDocs[a.asset_id] && (
                        <tr key={`docs-${a.asset_id}`} style={{ background: 'rgba(0,0,0,0.2)' }}>
                          <td colSpan={7} style={{ padding: '8px 16px' }}>
                            <InlineDocumentAccordion
                              entityType="device"
                              entityId={a.asset_id}
                              entityName={a.asset_name}
                              onOpenModal={() => setDocsForDevice(a)}
                              hasPermission={hasPermission}
                              refreshKey={docRefreshKey}
                              documentCount={a.document_count}
                            />
                          </td>
                        </tr>
                      )}
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
          <div className="modal" style={{ maxWidth: 480 }}>
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
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                    Configure the gateway to publish this device on <span className="mono">spBv1.0/&lt;group&gt;/DDATA/&lt;edge node&gt;/{effectiveSparkplugId(editing)}</span>. Click to copy.
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

            <div className="form-group">
              <label className="form-label">Shopfloor Cell Zone</label>
              {/* Derived, not editable: a device's cell is the cell of its gateway.
                  This used to be a select whose value PostgREST silently discarded,
                  because devices have no cell_id column. */}
              <input
                className="form-control"
                value={cellNameForGateway(form.active_gateway_id) || '— follows the assigned gateway —'}
                disabled
                readOnly
                title="A device belongs to the cell its edge gateway is assigned to"
              />
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                Set by the gateway above. To move this device to another cell, pick a gateway in that cell — or assign this gateway to a cell on the Gateways page.
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Device Type / Classification <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: '11px' }}>(derived)</span></label>
              <div className="form-control" style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-muted)', background: 'var(--bg-glass)' }} title="Derived from the metric groups the assigned schema models — not typed in by hand">
                {(() => {
                  const preview = deviceTagList(editing, schemas.find(s => s.schema_uuid === form.schema_id) || null)
                  if (preview.length === 0) {
                    return <span style={{ fontSize: '12px' }}>Assign a schema below to classify this device</span>
                  }
                  return preview.map(t => (
                    <span key={t} className="badge badge-neutral" style={{ fontSize: '10px' }}>{t}</span>
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
              <button className="btn btn-ghost" onClick={() => setShowForm(false)} title="Cancel edits">Cancel</button>
              <button className="btn btn-primary" onClick={save} title="Save device configuration and gateway assignment">Save Configuration</button>
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
      {configAsset && <AssetConfigModal asset={configAsset} schemas={schemas} onClose={() => setConfigAsset(null)} />}
      {threadFor && <DigitalThreadModal entityType="devices" entityId={threadFor.asset_id} displayName={threadFor.asset_name} onClose={() => setThreadFor(null)} />}
      {docsForDevice && (
        <EntityDocumentsModal entityType="device" entityId={docsForDevice.asset_id} entityName={docsForDevice.asset_name} onClose={() => { setDocsForDevice(null); setDocRefreshKey(k => k + 1) }} showToast={showToast} hasPermission={hasPermission} />
      )}
    </>
  )
}
