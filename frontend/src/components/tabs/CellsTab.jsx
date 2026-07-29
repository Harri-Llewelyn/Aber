import React, { useState, useCallback } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS } from '../../constants'
import { usePolling } from '../../hooks/usePolling'
import { gatewayLiveStatus, formatHeartbeat } from '../../utils/gatewayStatus'
import { effectiveSparkplugId, gatewaySparkplugId } from '../../utils/sparkplugId'
import CopyableId from '../common/CopyableId'
import { InlineDocumentAccordion } from '../common/InlineDocumentAccordion'
import { StatusBadge } from '../common/StatusBadge'
import { ArchiveModal } from '../modals/ArchiveModal'
import { DigitalThreadModal } from '../modals/DigitalThreadModal'
import { EntityDocumentsModal } from '../modals/EntityDocumentsModal'
import {
  IconFactory,
  IconPlus,
  IconPencil,
  IconArchive,
  IconRefreshCw,
  IconBookOpen,
  IconHistory,
  IconActivity,
  IconExternalLink,
  IconShieldAlert,
  IconX
} from '../common/Icons'

export function CellsTab({ showToast, onSelectDevice, hasPermission }) {
  const [cells, setCells]       = useState([])
  const [assets, setAssets]     = useState([])
  const [loading, setLoading]   = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing]   = useState(null)
  const blank = { cell_name: '', access_url: '' }
  const [formVal, setFormVal]   = useState(blank)
  const [archiveTarget, setArchiveTarget] = useState(null)
  const [threadFor, setThreadFor] = useState(null)
  const [docsForCell, setDocsForCell] = useState(null)
  const [docRefreshKey, setDocRefreshKey] = useState(0)
  const [filterMode, setFilterMode] = useState('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [attentionOnly, setAttentionOnly] = useState(false)
  const [emptyOnly, setEmptyOnly] = useState(false)

  const loadAll = useCallback(async (signal) => {
    try {
      // /api/v1/cells embeds each cell's gateways and, through them, its devices --
      // devices have no cell_id of their own, so the relationship only exists via the
      // gateway. `assets` stays loaded for the unassigned-device counter below.
      const [c, a] = await Promise.all([
        api.get('/api/v1/cells', { signal }),
        api.get('/api/v1/devices', { signal }),
      ])
      setCells(c); setAssets(a)
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
      if (editing) await api.put(`/api/v1/cells/${editing.cell_id}`, formVal)
      else         await api.post('/api/v1/cells', formVal)
      setShowForm(false); loadAll(); showToast('Cell saved', 'success')
    } catch (e) { showToast(e.message, 'error') }
  }

  const archiveCell = async (days) => {
    try {
      await api.post(`/api/v1/cells/${archiveTarget.cell_id}/archive`, { auto_delete_days: days })
      setArchiveTarget(null); loadAll(); showToast(`Cell '${archiveTarget.cell_name}' archived (Out of Commission)`, 'success')
    } catch (e) { showToast(e.message, 'error') }
  }

  const restoreCell = async (cellId, name) => {
    try {
      await api.post(`/api/v1/cells/${cellId}/restore`, {})
      loadAll(); showToast(`Cell '${name}' restored to active service`, 'success')
    } catch (e) { showToast(e.message, 'error') }
  }

  const canManage = hasPermission(PERMISSION_UUIDS.CELL_MANAGE)
  const canArchive = hasPermission(PERMISSION_UUIDS.ARCHIVE_MANAGE)

  // A device with no gateway -- or whose gateway is not assigned to a cell -- appears on
  // no cell card at all. Surface those rather than letting them silently vanish.
  const unlinkedDevices = assets.filter(a => !a.is_archived && !a.cell_id)

  // Cell-level rollups. A cell has no state of its own worth filtering on -- what matters is the
  // condition of the gateways and devices reachable through it. /api/v1/cells already embeds both
  // (see the comment on loadAll), so these read straight off the cell rather than re-querying.
  const liveGateways = (c) => (c.gateways || []).filter(g => !g.is_archived)
  const liveDevices = (c) => (c.devices || []).filter(a => !a.is_archived)

  const cellNeedsAttention = (c) =>
    liveGateways(c).some(g => gatewayLiveStatus(g) !== 'ONLINE') ||
    liveDevices(c).some(a => a.is_quarantined)

  // Either no gateways at all, or gateways serving nothing -- usually a provisioning mistake or a
  // decommissioned area nobody cleaned up.
  const cellIsEmpty = (c) => liveGateways(c).length === 0 || liveDevices(c).length === 0

  const filteredCells = cells.filter(c => {
    if (filterMode === 'active'   && c.is_archived) return false
    if (filterMode === 'archived' && !c.is_archived) return false
    if (attentionOnly && !cellNeedsAttention(c)) return false
    if (emptyOnly && !cellIsEmpty(c)) return false
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      if (!String(c.cell_id).toLowerCase().includes(q) && !c.cell_name.toLowerCase().includes(q)) return false
    }
    return true
  })

  const attentionCount = cells.filter(c => !c.is_archived && cellNeedsAttention(c)).length
  const emptyCount = cells.filter(c => !c.is_archived && cellIsEmpty(c)).length
  const activeFilterCount =
    (searchQuery ? 1 : 0) + (attentionOnly ? 1 : 0) + (emptyOnly ? 1 : 0) + (filterMode !== 'all' ? 1 : 0)

  return (
    <>
      <div className="section-header" style={{ marginBottom: '8px' }}>
        <h2 className="section-title">Shopfloor Cells <span className="section-count">{cells.length}</span></h2>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: '4px', background: 'var(--bg-glass)', padding: '3px', borderRadius: '8px', border: '1px solid var(--border)' }}>
            <button className={`btn btn-sm ${filterMode === 'all' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setFilterMode('all')} title="Show all cells">
              All ({cells.length})
            </button>
            <button className={`btn btn-sm ${filterMode === 'active' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setFilterMode('active')} title="Show active cells only">
              Active ({cells.filter(c => !c.is_archived).length})
            </button>
            <button className={`btn btn-sm ${filterMode === 'archived' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setFilterMode('archived')} title="Show decommissioned archived cells">
              Archived ({cells.filter(c => c.is_archived).length})
            </button>
          </div>

          <button
            className={`btn btn-primary ${!canManage ? 'btn-disabled' : ''}`}
            disabled={!canManage}
            onClick={() => canManage && (setEditing(null), setFormVal(blank), setShowForm(true))}
            title={!canManage ? 'Requires Admin permissions' : 'Configure new shopfloor cell zone'}
          >
            <IconPlus size={14} /> New Cell
          </button>
        </div>
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '16px' }}>
        Manage physical and logical shopfloor cell zones, inspect assigned edge gateways and devices, and monitor zone lifecycle audit history.
        A device belongs to a cell through its edge gateway.
      </p>

      <div className="filter-bar">
        <input
          className="form-control"
          style={{ width: '220px' }}
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Search by Cell ID or name…"
          title="Filter cells by ID or name"
        />

        <button
          className={`btn btn-sm ${attentionOnly ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setAttentionOnly(v => !v)}
          title="Cells containing an offline or stale gateway, or any quarantined device"
        >
          <IconShieldAlert size={13} /> Needs attention ({attentionCount})
        </button>

        <button
          className={`btn btn-sm ${emptyOnly ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setEmptyOnly(v => !v)}
          title="Cells with no gateways, or gateways serving no devices"
        >
          Empty ({emptyCount})
        </button>

        {activeFilterCount > 0 && (
          <button
            className="btn btn-ghost btn-sm filter-bar-spacer"
            onClick={() => { setSearchQuery(''); setAttentionOnly(false); setEmptyOnly(false); setFilterMode('all') }}
            title="Clear every filter"
          >
            <IconX size={13} /> Clear filters ({activeFilterCount})
          </button>
        )}
      </div>

      {unlinkedDevices.length > 0 && (
        <div style={{ marginBottom: '20px', background: 'rgba(255,179,0,0.08)', border: '1px solid var(--warning)', borderRadius: 'var(--radius)', padding: '12px 16px', fontSize: '13px', color: 'var(--warning)', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <IconShieldAlert size={18} />
          <div>
            <strong>{unlinkedDevices.length} device{unlinkedDevices.length === 1 ? '' : 's'} not linked to any cell zone:</strong>{' '}
            {unlinkedDevices.slice(0, 5).map(a => a.asset_name).join(', ')}{unlinkedDevices.length > 5 ? ', …' : ''}.
            Assign each device to a gateway on the Devices page, and assign that gateway to a cell on the Gateways page.
          </div>
        </div>
      )}

      {loading ? (
        <div className="loading-wrap"><div className="spinner" /> Loading shopfloor cells…</div>
      ) : filteredCells.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-icon"><IconFactory size={36} /></div>
            <div className="empty-text">No shopfloor cells match the selected filter.</div>
          </div>
        </div>
      ) : (
        filteredCells.map(c => {
          const cellGateways = c.gateways || []
          const cellAssets = c.devices || []

          return (
            <div key={c.cell_id} className="cell-card" style={{ opacity: c.is_archived ? 0.9 : 1, border: c.is_archived ? '1px solid var(--warning)' : '1px solid var(--border)' }}>
              <div className="cell-card-header" style={{ background: c.is_archived ? 'rgba(255,179,0,0.06)' : 'var(--bg-glass)' }}>
                <div className="cell-card-title">
                  <IconFactory size={18} />
                  <span>{c.cell_name}</span>
                  <span className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>ID: {c.cell_id}</span>
                  <span className="badge badge-neutral" title="Count of edge gateways assigned to this cell">{cellGateways.length} Gateways</span>
                  <span className="badge badge-neutral" title="Count of devices reachable through this cell's gateways">{cellAssets.length} Devices</span>
                  {c.is_archived && (
                    <span className="badge badge-warning" style={{ background: 'rgba(255,179,0,0.15)', color: 'var(--warning)', border: '1px solid var(--warning)', display: 'inline-flex', alignItems: 'center', gap: '4px' }} title="Cell decommissioned and archived">
                      <IconArchive size={11} /> ARCHIVED (OUT OF COMMISSION)
                    </span>
                  )}
                </div>

                <div className="btn-group">
                  {c.access_url && (
                    <a href={c.access_url} target="_blank" rel="noopener noreferrer" className="btn btn-primary btn-sm" style={{ textDecoration: 'none', gap: '4px', background: 'var(--accent)', color: '#000', padding: '4px 10px' }} title="Open Cell Dashboard / Grafana UI">
                      <IconExternalLink size={12} /> Dashboard
                    </a>
                  )}
                  <button className="btn btn-ghost btn-sm" onClick={() => setDocsForCell(c)} title="View & attach external documents for this cell">
                    <IconBookOpen size={13} /> Docs
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setThreadFor(c)} title="View Digital Thread audit trace for this cell">
                    <IconHistory size={13} /> Thread
                  </button>
                  {c.is_archived ? (
                    <button
                      className={`btn btn-primary btn-sm ${!canArchive ? 'btn-disabled' : ''}`}
                      disabled={!canArchive}
                      onClick={() => canArchive && restoreCell(c.cell_id, c.cell_name)}
                      title={!canArchive ? 'Requires Admin permissions' : 'Restore cell back to active service'}
                    >
                      <IconRefreshCw size={13} /> Restore
                    </button>
                  ) : (
                    <button
                      className={`btn btn-ghost btn-sm ${!canArchive ? 'btn-disabled' : ''}`}
                      disabled={!canArchive}
                      onClick={() => canArchive && setArchiveTarget(c)}
                      title={!canArchive ? 'Requires Admin permissions' : 'Decommission & Archive Cell'}
                    >
                      <IconArchive size={13} /> Archive
                    </button>
                  )}
                  <button
                    className={`btn btn-ghost btn-sm ${!canManage || c.is_archived ? 'btn-disabled' : ''}`}
                    disabled={!canManage || c.is_archived}
                    onClick={() => canManage && !c.is_archived && (setEditing(c), setFormVal({ cell_name: c.cell_name, access_url: c.access_url || '' }), setShowForm(true))}
                    title={!canManage ? 'Requires Admin permissions' : c.is_archived ? 'Cell is archived' : 'Edit cell name'}
                  >
                    <IconPencil size={13} /> Edit
                  </button>
                </div>
              </div>

              <div className="cell-card-body">
                {c.is_archived && (
                  <div style={{ background: 'rgba(255,179,0,0.08)', border: '1px solid var(--warning)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', fontSize: '13px', color: 'var(--warning)', display: 'flex', alignItems: 'center', gap: '10px', width: '100%' }}>
                    <IconShieldAlert size={18} />
                    <div>
                      <strong>Cell Zone Out of Commission:</strong> This shopfloor cell is decommissioned and archived. {c.auto_delete_at ? `Retention purge timer active (auto-purges on ${new Date(c.auto_delete_at).toLocaleDateString()}).` : 'Permanent retention active (no auto-purge).'}
                    </div>
                  </div>
                )}

                <div className="nested-box">
                  <div className="nested-box-title">Assigned Edge Gateways ({cellGateways.length})</div>
                  {cellGateways.length === 0 ? (
                    <div style={{ fontStyle: 'italic', fontSize: '12px', color: 'var(--text-dim)' }}>
                      No gateways assigned to this cell zone. Assign a gateway to this cell on the Gateways page — devices reach a cell through their gateway.
                    </div>
                  ) : (
                    <div className="table-wrap">
                      <table>
                        <thead><tr><th title="Gateway Name">Name</th><th title="Sparkplug B edge node id">Sparkplug ID</th><th title="Connectivity status">Status</th><th title="Last Sparkplug B node heartbeat">Last Heartbeat</th><th title="Devices served by this gateway">Devices</th></tr></thead>
                        <tbody>
                          {cellGateways.map(g => (
                            <tr key={g.gateway_id} style={{ background: g.is_archived ? 'rgba(255,179,0,0.06)' : undefined }}>
                              <td><strong>{g.gateway_name}</strong></td>
                              <td><CopyableId value={g.sparkplug_id || gatewaySparkplugId(g.gateway_id)} label="Sparkplug edge node id" onNotify={showToast} /></td>
                              <td>
                                {g.is_archived
                                  ? <span className="badge badge-warning" style={{ background: 'rgba(255,179,0,0.15)', color: 'var(--warning)' }}>DECOMMISSIONED</span>
                                  : <StatusBadge status={gatewayLiveStatus(g)} />}
                              </td>
                              <td style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{formatHeartbeat(g.last_heartbeat)}</td>
                              <td><span className="badge badge-neutral">{g.device_count}</span></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                <div className="nested-box">
                  <div className="nested-box-title">Assigned Devices ({cellAssets.length})</div>
                  {cellAssets.length === 0 ? <div style={{ fontStyle: 'italic', fontSize: '12px', color: 'var(--text-dim)' }}>No devices reachable through this cell zone's gateways.</div> : (
                    <div className="table-wrap">
                      <table>
                        <thead><tr><th title="Device Name">Name</th><th title="Sparkplug B device id">Sparkplug ID</th><th title="Status">Status</th><th title="Connected Edge Gateway">Gateway</th><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
                        <tbody>
                          {cellAssets.map(a => {
                            const isOff = a.status === 'OFFLINE'
                            const isArch = a.is_archived
                            return (
                              <tr key={a.asset_id} style={{ background: isArch ? 'rgba(255,179,0,0.06)' : undefined }}>
                                <td>
                                  <strong>{a.asset_name}</strong>
                                  {isArch && (
                                    <span className="badge badge-warning" style={{ background: 'rgba(255,179,0,0.15)', color: 'var(--warning)', border: '1px solid var(--warning)', marginLeft: '8px' }} title="Decommissioned device">
                                      <IconArchive size={11} /> ARCHIVED
                                    </span>
                                  )}
                                </td>
                                <td><CopyableId value={effectiveSparkplugId(a)} label="Sparkplug device id" onNotify={showToast} /></td>
                                <td>
                                  {isArch ? (
                                    <span className="badge badge-warning" style={{ background: 'rgba(255,179,0,0.15)', color: 'var(--warning)', border: '1px solid var(--warning)', display: 'inline-flex', alignItems: 'center', gap: '4px' }} title="Decommissioned device (Out of Commission)">
                                      <IconArchive size={11} /> ARCHIVED (OUT OF COMMISSION)
                                    </span>
                                  ) : (
                                    <span className={`badge ${isOff ? 'badge-neutral' : 'badge-online'}`} title={isOff ? 'Sparkplug B DDEATH Received — Device Offline' : 'Device Active'}>
                                      <span className="badge-dot" style={{ background: isOff ? 'var(--text-muted)' : 'var(--success)' }} />
                                      {isOff ? 'OFFLINE / DDEATH' : 'ONLINE'}
                                    </span>
                                  )}
                                </td>
                                <td><span className="mono" style={{ color: 'var(--warning)' }} title={a.active_gateway_id || 'No gateway assigned'}>{a.gateway_name || a.active_gateway_id || '—'}</span></td>
                                <td style={{ textAlign: 'right' }}>
                                  <button className="btn btn-ghost btn-sm" onClick={() => onSelectDevice(a.asset_id)} title="View live telemetry for this device">
                                    <IconActivity size={12} /> Telemetry
                                  </button>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                <InlineDocumentAccordion
                  entityType="cell"
                  entityId={c.cell_id}
                  entityName={c.cell_name}
                  onOpenModal={() => setDocsForCell(c)}
                  hasPermission={hasPermission}
                  refreshKey={docRefreshKey}
                  documentCount={c.document_count}
                />
              </div>
            </div>
          )
        })
      )}

      {showForm && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-title">{editing ? 'Edit Cell' : 'New Cell'}</div>
            <div className="form-group">
              <label className="form-label">Cell Name</label>
              <input className="form-control" value={formVal.cell_name} onChange={e => setFormVal(f => ({ ...f, cell_name: e.target.value }))} placeholder="e.g. Assembly Line 1" title="Enter descriptive cell zone name" />
            </div>
            <div className="form-group">
              <label className="form-label">Dashboard / UI URL (Optional)</label>
              <input className="form-control" value={formVal.access_url || ''} onChange={e => setFormVal(f => ({ ...f, access_url: e.target.value }))} placeholder="e.g. http://localhost:3002/d/cell-1" title="Enter Grafana dashboard or UI management URL" />
            </div>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setShowForm(false)} title="Cancel">Cancel</button>
              <button className="btn btn-primary" onClick={save} title="Save cell zone">Save</button>
            </div>
          </div>
        </div>
      )}

      {archiveTarget && (
        <ArchiveModal
          entityType="cells" entityId={archiveTarget.cell_id} displayName={archiveTarget.cell_name}
          onArchive={archiveCell} onCancel={() => setArchiveTarget(null)}
        />
      )}

      {threadFor && (
        <DigitalThreadModal entityType="cells" entityId={threadFor.cell_id} displayName={threadFor.cell_name} onClose={() => setThreadFor(null)} />
      )}

      {docsForCell && (
        <EntityDocumentsModal entityType="cell" entityId={docsForCell.cell_id} entityName={docsForCell.cell_name} onClose={() => { setDocsForCell(null); setDocRefreshKey(k => k + 1) }} showToast={showToast} hasPermission={hasPermission} />
      )}
    </>
  )
}
