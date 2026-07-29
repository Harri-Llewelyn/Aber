import React, { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../lib/supabaseClient'
import { api } from '../../api'
import { PERMISSION_UUIDS } from '../../constants'
import { usePolling } from '../../hooks/usePolling'
import { downloadCSV } from '../../utils/downloadCSV'
import { edgeFunctionErrorMessage } from '../../utils/edgeFunctionError'
import { describeAuthFailure } from '../../utils/sessionError'
import CopyableId from '../common/CopyableId'
import { effectiveSparkplugId } from '../../utils/sparkplugId'
import { InlineDocumentAccordion } from '../common/InlineDocumentAccordion'
import { ApproveQuarantineModal } from '../modals/ApproveQuarantineModal'
import { ArchiveModal } from '../modals/ArchiveModal'
import { AssetConfigModal } from '../modals/AssetConfigModal'
import { DigitalThreadModal } from '../modals/DigitalThreadModal'
import { EntityDocumentsModal } from '../modals/EntityDocumentsModal'
import { isProvisioningOverdue, isNeverSeen } from '../../utils/deviceProvisioning'
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
  const [blank]                 = useState({ asset_id: '', asset_name: '', asset_type: 'CNC', connection_method: 'Sparkplug B', active_gateway_id: '', schema_id: '' })
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

  usePolling(loadAll, 3000)

  // A device's cell is whatever cell its gateway belongs to; there is no direct link.
  const cellNameForGateway = (gatewayId) => {
    const gw = gateways.find(g => g.gateway_id === gatewayId)
    if (!gw?.cell_id) return ''
    return cells.find(c => c.cell_id === gw.cell_id)?.cell_name || ''
  }

  const save = async () => {
    try {
      const payload = {
        asset_name: form.asset_name,
        asset_type: form.asset_type || null,
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

  // A device an operator needs to act on: held in quarantine, provisioned but never seen, or
  // still being resolved by name because its gateway has not been moved onto Sparkplug IDs yet.
  const needsAttention = (a) =>
    a.is_quarantined || isProvisioningOverdue(a) || a.identity_source === 'legacy_name'

  const filteredAssets = assets.filter(a => {
    if (filterMode === 'active'   && a.is_archived) return false
    if (filterMode === 'archived' && !a.is_archived) return false
    if (schemaFilter && a.schema_id !== schemaFilter) return false
    if (gatewayFilter && (a.active_gateway_id || '') !== gatewayFilter) return false
    if (cellFilter && (a.cell_id || '') !== cellFilter) return false
    if (attentionOnly && !needsAttention(a)) return false

    if (statusFilter === 'online'   && (a.status === 'OFFLINE' || a.is_archived)) return false
    if (statusFilter === 'offline'  && a.status !== 'OFFLINE') return false
    // "Never seen" is distinct from offline: the row exists but no DBIRTH has ever arrived.
    if (statusFilter === 'unborn'   && !isNeverSeen(a)) return false
    if (statusFilter === 'overdue'  && !isProvisioningOverdue(a)) return false

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

  const attentionCount = assets.filter(needsAttention).length
  const activeFilterCount =
    [schemaFilter, statusFilter, gatewayFilter, cellFilter, searchQuery].filter(Boolean).length +
    (attentionOnly ? 1 : 0) + (filterMode !== 'all' ? 1 : 0)
  const schemaName = schemas.find(s => s.schema_uuid === schemaFilter)?.schema_name

  return (
    <>
      <div className="section-header" style={{ marginBottom: '8px' }}>
        <h2 className="section-title">Shopfloor Devices <span className="section-count">{assets.length}</span></h2>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: '4px', background: 'var(--bg-glass)', padding: '3px', borderRadius: '8px', border: '1px solid var(--border)' }}>
            <button className={`btn btn-sm ${filterMode === 'all' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setFilterMode('all')} title="Show all devices">
              All ({assets.length})
            </button>
            <button className={`btn btn-sm ${filterMode === 'active' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setFilterMode('active')} title="Show active devices only">
              Active ({assets.filter(a => !a.is_archived).length})
            </button>
            <button className={`btn btn-sm ${filterMode === 'archived' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setFilterMode('archived')} title="Show decommissioned archived devices">
              Archived ({assets.filter(a => a.is_archived).length})
            </button>
          </div>

          <button className="btn btn-ghost btn-sm" onClick={() => downloadCSV(filteredAssets, 'devices-export.csv')} title="Download the filtered devices list as CSV"><IconDownload size={13} /> Export CSV</button>
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
          title="Show only devices that are quarantined, overdue their first birth, or still matched by legacy name"
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
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', color: 'var(--warning)', fontWeight: 600 }}>
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
                    <td>
                      <strong>{q.asset_name}</strong>
                      {q.quarantine_reason && (
                        <div style={{ fontSize: '10px', color: 'var(--danger)', marginTop: '3px', display: 'flex', alignItems: 'flex-start', gap: '3px' }}>
                          <IconAlertTriangle size={10} style={{ flexShrink: 0, marginTop: '1px' }} /> {q.quarantine_reason}
                        </div>
                      )}
                      {suggestion && (
                        <div style={{ fontSize: '10px', color: 'var(--warning)', marginTop: '3px', display: 'flex', alignItems: 'center', gap: '3px' }} title={suggestion.evidence}>
                          <IconAlertTriangle size={10} /> Possible match: {suggestion.candidateName}
                        </div>
                      )}
                    </td>
                    <td><CopyableId value={q.reported_identity} label="published device id" onNotify={showToast} /></td>
                    <td>{q.gateway_name || <span className="mono">—</span>}</td>
                    <td style={{ fontSize: '11px' }}>{new Date(q.discovered_at).toLocaleString()}</td>
                    <td><code>{q.birth_payload || '{}'}</code></td>
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
                            <span className="badge badge-warning" style={{ background: 'rgba(255,179,0,0.15)', color: 'var(--warning)', border: '1px solid var(--warning)', marginLeft: '8px' }} title="Decommissioned device">
                              <IconArchive size={11} /> ARCHIVED
                            </span>
                          )}
                        </td>
                        <td>
                          <CopyableId value={effectiveSparkplugId(a)} label="Sparkplug device id" onNotify={showToast} />
                          {a.identity_source === 'legacy_name' && (
                            <div style={{ fontSize: '10px', color: 'var(--warning)', marginTop: '3px', display: 'flex', alignItems: 'center', gap: '3px' }} title="This device is still matched by name. Reconfigure its gateway to publish the Sparkplug ID; name matching will be removed.">
                              <IconAlertTriangle size={10} /> Legacy name matching
                            </div>
                          )}
                        </td>
                        <td>
                          {a.is_archived ? (
                            <span className="badge badge-warning" style={{ background: 'rgba(255,179,0,0.15)', color: 'var(--warning)', border: '1px solid var(--warning)', display: 'inline-flex', alignItems: 'center', gap: '4px' }} title="Decommissioned device (Out of Commission)">
                              <IconArchive size={11} /> ARCHIVED (OUT OF COMMISSION)
                            </span>
                          ) : isProvisioningOverdue(a) ? (
                            <span className="badge badge-warning" style={{ background: 'rgba(255,179,0,0.15)', color: 'var(--warning)', border: '1px solid var(--warning)', display: 'inline-flex', alignItems: 'center', gap: '4px' }} title="Provisioned more than 24h ago and has never sent a DBIRTH">
                              <IconAlertTriangle size={11} /> AWAITING FIRST BIRTH
                            </span>
                          ) : (
                            <span className={`badge ${isOff ? 'badge-neutral' : 'badge-online'}`} title={isOff ? 'Sparkplug B DDEATH Received — Device Offline' : 'Device Active'}>
                              <span className="badge-dot" style={{ background: isOff ? 'var(--text-muted)' : 'var(--success)' }} />
                              {isOff ? 'Offline / DDEATH' : 'Online'}
                            </span>
                          )}
                        </td>
                        <td>{a.asset_type || '—'}</td>
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
              <label className="form-label">Device Type / Classification</label>
              <input className="form-control" value={form.asset_type || ''} onChange={e => setForm(f => ({ ...f, asset_type: e.target.value }))} title="Device classification" placeholder="e.g. CNC, PLC, Robot Arm, Sensor" />
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
