import React, { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../lib/supabaseClient'
import { api } from '../../api'
import { PERMISSION_UUIDS } from '../../constants'
import { usePolling } from '../../hooks/usePolling'
import { downloadCSV } from '../../utils/downloadCSV'
import { InlineDocumentAccordion } from '../common/InlineDocumentAccordion'
import { ApproveQuarantineModal } from '../modals/ApproveQuarantineModal'
import { ArchiveModal } from '../modals/ArchiveModal'
import { AssetConfigModal } from '../modals/AssetConfigModal'
import { DigitalThreadModal } from '../modals/DigitalThreadModal'
import { EntityDocumentsModal } from '../modals/EntityDocumentsModal'
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
  IconLock,
  IconDownload,
  IconX
} from '../common/Icons'

export function DevicesTab({ showToast, onSelectDevice, hasPermission, initialSearchFilter, onClearFilter }) {
  const [assets, setAssets]     = useState([])
  const [cells, setCells]       = useState([])
  const [gateways, setGateways] = useState([])
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
  const [blank]                 = useState({ asset_id: '', asset_name: '', asset_type: 'CNC', cell_id: '', connection_method: 'OPC-UA', active_gateway_id: '' })
  const [form, setForm]         = useState(blank)
  const [filterMode, setFilterMode] = useState('all')

  const toggleDeviceDocExpand = id => setExpandedDeviceDocs(prev => ({ ...prev, [id]: !prev[id] }))

  const getInitialSearch = () => {
    const params = new URLSearchParams(window.location.search)
    return params.get('search') || initialSearchFilter || ''
  }

  const [searchQuery, setSearchQuery] = useState(getInitialSearch)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const urlSearch = params.get('search')
    if (urlSearch) {
      setSearchQuery(urlSearch)
    } else if (initialSearchFilter) {
      setSearchQuery(initialSearchFilter)
    }
  }, [initialSearchFilter])

  const handleClearSearch = () => {
    setSearchQuery('')
    if (window.location.search) {
      window.history.replaceState({}, '', window.location.pathname)
    }
    if (onClearFilter) onClearFilter()
  }

  const loadAll = useCallback(async (signal) => {
    try {
      const [a, c, g] = await Promise.all([
        api.get('/api/v1/devices', { signal }),
        api.get('/api/v1/cells', { signal }),
        api.get('/api/v1/gateways', { signal }),
      ])
      setAssets(a); setCells(c); setGateways(g)

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

  const save = async () => {
    try {
      const payload = {
        asset_name: form.asset_name,
        asset_type: form.asset_type || null,
        cell_id: form.cell_id ? parseInt(form.cell_id, 10) : null,
        connection_method: form.connection_method || 'Sparkplug B',
        active_gateway_id: form.active_gateway_id || null,
      }
      if (editing) {
        await api.put(`/api/v1/devices/${editing.asset_id}`, payload)
      } else {
        await api.post('/api/v1/devices', { asset_id: form.asset_id, ...payload })
      }
      setShowForm(false); loadAll(); showToast('Device saved successfully', 'success')
    } catch (e) { showToast(e.message, 'error') }
  }

  const reassignGatewayInline = async (asset, newGwId) => {
    try {
      await api.put(`/api/v1/devices/${asset.asset_id}`, {
        asset_name: asset.asset_name,
        asset_type: asset.asset_type,
        cell_id: asset.cell_id,
        connection_method: asset.connection_method,
        active_gateway_id: newGwId || null
      })
      loadAll()
      showToast(`Device '${asset.asset_name}' gateway reassigned to '${newGwId || 'Unassigned'}'`, 'success')
    } catch (e) { showToast(e.message, 'error') }
  }

  const approveQuarantine = async (assetId, body) => {
    const targetGateway = body?.active_gateway_id || body?.gateway_id || null

    try {
      const { data, error } = await supabase.functions.invoke('approve-quarantine', {
        body: { device_id: assetId, gateway_id: targetGateway }
      })

      if (error) {
        showToast(error.message || 'Quarantine approval denied or failed', 'error')
        return
      }

      if (!data?.success) {
        showToast(data?.error || 'Quarantine approval failed', 'error')
        return
      }

      setApproveItem(null)
      loadAll()
      showToast(`Device '${assetId}' approved and onboarded`, 'success')
    } catch (e) { showToast(e.message, 'error') }
  }

  const rejectQuarantine = async (assetId) => {
    try {
      await api.post(`/api/v1/quarantine/${assetId}/reject`, {})
      loadAll(); showToast(`Quarantined device '${assetId}' rejected`, 'success')
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

  const filteredAssets = assets.filter(a => {
    if (filterMode === 'active'   && a.is_archived) return false
    if (filterMode === 'archived' && !a.is_archived) return false
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      if (!a.asset_id.toLowerCase().includes(q) && !a.asset_name.toLowerCase().includes(q)) return false
    }
    return true
  })

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

          <input
            className="form-control"
            style={{ width: '200px' }}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search by Device ID or name…"
            title="Filter devices by ID or name"
          />
          {searchQuery && (
            <button className="btn btn-ghost btn-sm" onClick={handleClearSearch} title="Clear search"><IconX size={13} /> Clear</button>
          )}

          <button className="btn btn-ghost btn-sm" onClick={() => downloadCSV(filteredAssets, 'devices-export.csv')} title="Download devices list as CSV"><IconDownload size={13} /> Export CSV</button>
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
      <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '20px' }}>
        Manage shopfloor manufacturing devices, review Zero-Touch onboarding quarantine queue, inspect DBIRTH configuration parameters, and decommission assets.
      </p>

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
              <thead><tr><th title="Discovered Device ID">Device ID</th><th title="Source Gateway ID">Gateway</th><th title="Discovery timestamp">Discovered At</th><th title="Sparkplug B birth payload">Payload</th><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
              <tbody>
                {quarantine.map(q => (
                  <tr key={q.quarantine_id}>
                    <td><span className="mono">{q.asset_id}</span></td>
                    <td><span className="mono">{q.gateway_id}</span></td>
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
                          onClick={() => canReject && rejectQuarantine(q.asset_id)}
                          title={!canReject ? 'Requires Admin permissions' : 'Reject quarantine payload'}
                        >
                          Reject
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
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
              <thead><tr><th title="Device Asset ID">Device ID</th><th title="Human-readable device name">Name</th><th title="Device status">Status</th><th title="Device classification">Type</th><th title="Assigned cell zone">Cell</th><th title="Serving edge gateway (reassignable)">Serving Edge Gateway</th><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
              <tbody>
                {filteredAssets.map(a => {
                  const isOff = a.status === 'OFFLINE'
                  return (
                    <React.Fragment key={a.asset_id}>
                      <tr style={{ background: a.is_archived ? 'rgba(255,179,0,0.06)' : undefined }}>
                        <td><span className="mono">{a.asset_id}</span></td>
                        <td>
                          <strong>{a.asset_name}</strong>
                          {a.is_archived && (
                            <span className="badge badge-warning" style={{ background: 'rgba(255,179,0,0.15)', color: 'var(--warning)', border: '1px solid var(--warning)', marginLeft: '8px' }} title="Decommissioned device">
                              <IconArchive size={11} /> ARCHIVED
                            </span>
                          )}
                        </td>
                        <td>
                          {a.is_archived ? (
                            <span className="badge badge-warning" style={{ background: 'rgba(255,179,0,0.15)', color: 'var(--warning)', border: '1px solid var(--warning)', display: 'inline-flex', alignItems: 'center', gap: '4px' }} title="Decommissioned device (Out of Commission)">
                              <IconArchive size={11} /> ARCHIVED (OUT OF COMMISSION)
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
            
            <div className="form-group">
              <label className="form-label">Device ID</label>
              <input className="form-control" value={form.asset_id} disabled={!!editing} onChange={e => setForm(f => ({ ...f, asset_id: e.target.value }))} title="Unique device asset ID" placeholder="e.g. CNC_Machine_02" />
            </div>

            <div className="form-group">
              <label className="form-label">Device Name</label>
              <input className="form-control" value={form.asset_name} onChange={e => setForm(f => ({ ...f, asset_name: e.target.value }))} title="Descriptive device name" placeholder="e.g. 5-Axis CNC Milling Center" />
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
              <select className="form-control" value={form.cell_id || ''} onChange={e => setForm(f => ({ ...f, cell_id: e.target.value }))} title="Select shopfloor cell zone assignment">
                <option value="">— Unassigned Zone —</option>
                {cells.map(c => (
                  <option key={c.cell_id} value={c.cell_id}>
                    {c.cell_name} (Zone #{c.cell_id})
                  </option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label className="form-label">Device Type / Classification</label>
              <input className="form-control" value={form.asset_type || ''} onChange={e => setForm(f => ({ ...f, asset_type: e.target.value }))} title="Device classification" placeholder="e.g. CNC, PLC, Robot Arm, Sensor" />
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

      {approveItem && <ApproveQuarantineModal item={approveItem} cells={cells} gateways={gateways} onApprove={approveQuarantine} onCancel={() => setApproveItem(null)} />}
      {archiveTarget && <ArchiveModal entityType="devices" entityId={archiveTarget.asset_id} displayName={archiveTarget.asset_name} onArchive={archiveDevice} onCancel={() => setArchiveTarget(null)} />}
      {configAsset && <AssetConfigModal asset={configAsset} onClose={() => setConfigAsset(null)} />}
      {threadFor && <DigitalThreadModal entityType="devices" entityId={threadFor.asset_id} displayName={threadFor.asset_name} onClose={() => setThreadFor(null)} />}
      {docsForDevice && (
        <EntityDocumentsModal entityType="device" entityId={docsForDevice.asset_id} entityName={docsForDevice.asset_name} onClose={() => { setDocsForDevice(null); setDocRefreshKey(k => k + 1) }} showToast={showToast} hasPermission={hasPermission} />
      )}
    </>
  )
}
