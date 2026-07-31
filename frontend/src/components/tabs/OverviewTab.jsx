import React, { useState, useCallback, useMemo } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS, REALTIME_ENABLED, STALENESS_TICK_MS, refreshInterval } from '../../constants'
import { usePolling } from '../../hooks/usePolling'
import { useRealtimeTable } from '../../hooks/useRealtimeTable'
import { useClockTick } from '../../hooks/useClockTick'
import { gatewayLiveStatus, isGatewayOnline, formatHeartbeat } from '../../utils/gatewayStatus'
import { effectiveSparkplugId } from '../../utils/sparkplugId'
import {
  IconMap,
  IconFactory,
  IconRadio,
  IconCpu,
  IconArchive,
  IconExternalLink,
  IconLock,
  IconZap,
  IconCog
} from '../common/Icons'

export function OverviewTab({ onSelectDevice, onSelectGateway, showToast, hasPermission, onNavigateTab }) {
  const [stats, setStats]     = useState({ cells: 0, gateways: 0, assets: 0, telemetry: 0 })
  const [cells, setCells]     = useState([])
  const [gwList, setGwList]   = useState([])
  const [assets, setAssets]   = useState([])
  const [telemetry, setTelemetry] = useState([])
  const [loading, setLoading] = useState(true)

  const loadAll = useCallback(async (signal) => {
    try {
      const [c, g, a, t, s] = await Promise.all([
        api.get('/api/v1/cells', { signal }),
        api.get('/api/v1/gateways', { signal }),
        api.get('/api/v1/devices', { signal }),
        // The map only needs the current value of each metric, not history -- and this
        // runs on a 3s poll, so it must stay bounded.
        api.get('/api/v1/telemetry/latest?minutes=60', { signal }).catch(() => []),
        api.get('/api/v1/stats', { signal }).catch(() => ({ quarantine_pending: 0, documents_attached: 0 })),
      ])
      setStats({ cells: c.length, gateways: g.length, assets: a.length, telemetry: t.length, quarantine: s.quarantine_pending, docs: s.documents_attached })
      setCells(c); setGwList(g); setAssets(a); setTelemetry(t)
      setLoading(false)
    } catch (err) {
      if (err.name !== 'AbortError') {
        setLoading(false)
      }
      throw err
    }
  }, [])

  // Reconciliation loop, not the primary refresh: Realtime carries the updates and this
  // catches whatever a dropped socket missed. Falls back to the 3s poll when Realtime is off.
  usePolling(loadAll, refreshInterval())
  // Telemetry is deliberately absent -- it is a postgres_fdw foreign table and can never emit
  // Postgres changes here. The telemetry count on this page therefore refreshes on the loop
  // above, not on notification.
  useRealtimeTable(['cells', 'gateways', 'devices'], loadAll, { enabled: REALTIME_ENABLED })
  // This page renders gatewayLiveStatus()/isGatewayOnline() too, so it needs the same
  // wall-clock tick as GatewaysTab to notice a gateway that has simply gone quiet.
  useClockTick(STALENESS_TICK_MS)

  const canManageDevice = hasPermission(PERMISSION_UUIDS.DEVICE_MANAGE)

  const handleDragStart = (e, asset) => {
    if (!canManageDevice || asset.status === 'OFFLINE') return
    e.dataTransfer.setData('application/json', JSON.stringify(asset))
  }

  const handleDragOver = (e) => {
    if (!canManageDevice) return
    e.preventDefault()
  }

  const handleDrop = async (e, targetCellId) => {
    e.preventDefault()
    if (!canManageDevice) return
    try {
      const assetData = JSON.parse(e.dataTransfer.getData('application/json'))
      if (assetData.cell_id === targetCellId) return

      // Devices have no cell_id column -- a device joins a cell by being served by one
      // of that cell's gateways. Writing cell_id here used to be silently discarded by
      // PostgREST, so the drop reported success and changed nothing.
      const targetGateways = gwList.filter(g => g.cell_id === targetCellId && !g.is_archived)
      const targetCellName = cells.find(c => c.cell_id === targetCellId)?.cell_name || 'the target cell'

      if (targetGateways.length === 0) {
        showToast(`'${targetCellName}' has no active edge gateway — assign a gateway to this cell first`, 'error')
        return
      }
      if (targetGateways.length > 1) {
        showToast(`'${targetCellName}' has ${targetGateways.length} gateways — pick one on the Devices page`, 'error')
        return
      }

      const targetGateway = targetGateways[0]
      await api.put(`/api/v1/devices/${assetData.asset_id}`, {
        asset_name: assetData.asset_name,
        active_gateway_id: targetGateway.gateway_id,
      })

      await loadAll()
      showToast(`Device '${assetData.asset_name}' reassigned to '${targetCellName}' via gateway '${targetGateway.gateway_name}'`, 'success')
    } catch (err) {
      showToast(err.message, 'error')
    }
  }

  // Pre-build Map for O(1) telemetry lookups per asset instead of O(N) array filter on
  // every render. Telemetry is keyed by the device's immutable `sparkplug_id` (what the
  // hypertable stores in asset_id), not by the device UUID or its editable name.
  const telemetryBySparkplugId = useMemo(() => {
    const map = new Map()
    for (let i = 0; i < telemetry.length; i++) {
      const t = telemetry[i]
      if (!map.has(t.asset_id)) {
        map.set(t.asset_id, [])
      }
      map.get(t.asset_id).push(t)
    }
    return map
  }, [telemetry])

  const getDeviceStatusColor = useCallback((asset) => {
    if (asset.is_archived) return 'chip-warning'
    if (asset.status === 'OFFLINE') return 'chip-offline'
    const latest = telemetryBySparkplugId.get(effectiveSparkplugId(asset)) || []
    // MTConnect vocabularies (migration 20260101000019): EXECUTION is
    // READY/ACTIVE/INTERRUPTED/FEED_HOLD/STOPPED/…, EMERGENCY_STOP is ARMED/TRIGGERED. The latter
    // is a string, not the boolean safety_ok it replaced -- reading val_bool here would compare
    // undefined and silently never show the danger state.
    const executionMetric = latest.find(t => t.metric_name === 'Controller/EXECUTION')
    if (executionMetric && executionMetric.val_string === 'STOPPED') return 'chip-offline'

    const tempMetric = latest.find(t => t.metric_name === 'Systems/TEMPERATURE')
    const estopMetric = latest.find(t => t.metric_name === 'Controller/EMERGENCY_STOP')

    if (estopMetric && estopMetric.val_string === 'TRIGGERED') return 'chip-danger'
    if (executionMetric && executionMetric.val_string === 'INTERRUPTED') return 'chip-danger'
    if (tempMetric && tempMetric.val_double > 80.0) return 'chip-danger'
    if (executionMetric && (executionMetric.val_string === 'FEED_HOLD' || executionMetric.val_string === 'READY')) return 'chip-warning'
    return 'chip-success'
  }, [telemetryBySparkplugId])

  if (loading) return <div className="loading-wrap"><div className="spinner" /> Loading shopfloor overview…</div>

  const activeCellsCount = cells.filter(c => !c.is_archived).length
  const archivedCellsCount = cells.filter(c => c.is_archived).length

  // A gateway is only "online" while its heartbeat is fresh -- an edge node that stops
  // publishing never writes an OFFLINE status, it just goes quiet.
  const onlineGwCount = gwList.filter(g => !g.is_archived && isGatewayOnline(g)).length
  const offlineGwCount = gwList.filter(g => !g.is_archived && !isGatewayOnline(g)).length
  const archivedGwCount = gwList.filter(g => g.is_archived).length

  const onlineAssetsCount = assets.filter(a => (a.status === 'ONLINE' || !a.status) && !a.is_archived).length
  const offlineAssetsCount = assets.filter(a => a.status === 'OFFLINE' && !a.is_archived).length
  const archivedAssetsCount = assets.filter(a => a.is_archived).length

  return (
    <>
      <div className="section-header" style={{ marginBottom: '8px' }}>
        <h2 className="section-title">System Overview</h2>
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '20px' }}>
        Interactive shopfloor spatial map and high-level operational metric summaries across cells, edge gateways, devices, and real-time telemetry streams.
      </p>
      
      <div className="stats-row">
        <div className="stat-card" style={{ cursor: 'pointer' }} onClick={() => onNavigateTab && onNavigateTab('cells')} title="Total active cell zones configured. Click to view Cells."><div className="stat-label">Cells</div><div className="stat-value">{stats.cells}</div><div className="stat-sub">{activeCellsCount} Active / {archivedCellsCount} Archived</div></div>
        <div className="stat-card" style={{ cursor: 'pointer' }} onClick={() => onNavigateTab && onNavigateTab('gateways')} title="Total registered edge gateways. Click to view Gateways."><div className="stat-label">Total Gateways</div><div className="stat-value">{stats.gateways}</div><div className="stat-sub">{onlineGwCount} Online / {offlineGwCount} Offline / {archivedGwCount} Archived</div></div>
        <div className="stat-card" style={{ cursor: 'pointer' }} onClick={() => onNavigateTab && onNavigateTab('devices')} title="Total registered shopfloor devices. Click to view Devices."><div className="stat-label">Total Devices</div><div className="stat-value">{stats.assets}</div><div className="stat-sub">{onlineAssetsCount} Online / {offlineAssetsCount} Offline / {archivedAssetsCount} Archived</div></div>
        <div className="stat-card" style={{ cursor: 'pointer' }} onClick={() => onNavigateTab && onNavigateTab('devices')} title="Devices pending zero-touch quarantine approval. Click to view Devices."><div className="stat-label">Pending Quarantine</div><div className="stat-value">{stats.quarantine || 0}</div><div className="stat-sub">Awaiting onboarding</div></div>
      </div>

      <div className="shopfloor-map-card">
        <div className="shopfloor-map-bg">
          <div className="shopfloor-header">
            <div className="shopfloor-title">
              <IconMap size={18} />
              <span>Shopfloor Dashboard</span>
            </div>
            <div className="shopfloor-legend">
              <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }} title="Normal operating condition"><span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--success)' }} /> Green: Normal</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }} title="Device in idle or maintenance state"><span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--warning)' }} /> Amber: Archived</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }} title="Critical alarm or temperature limit exceeded"><span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--danger)' }} /> Red: Alarm</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }} title="Device offline (Sparkplug B DDEATH payload received)"><span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--text-muted)' }} /> Muted Gray: Offline (DDEATH)</span>
              {!canManageDevice && (
                <span style={{ color: 'var(--danger)', fontSize: '11px', marginLeft: '10px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                  <IconLock size={11} /> Drag-and-Drop locked (Requires Admin permissions)
                </span>
              )}
            </div>
          </div>

          <div className="shopfloor-grid">
            {cells.length === 0 ? (
              <div className="empty-state" style={{ gridColumn: '1 / -1' }}>
                <div className="empty-icon"><IconFactory size={36} /></div>
                <div className="empty-text">No active cells configured to display on the shopfloor blueprint.</div>
              </div>
            ) : (
              cells.map(c => {
                // Cells own gateways; gateways own devices. Deriving the gateway list
                // from the devices instead hid every gateway that has no device yet.
                const cellGateways = gwList.filter(g => g.cell_id === c.cell_id)
                const cellAssets = c.devices || []

                return (
                  <div
                    key={c.cell_id}
                    className="shopfloor-zone"
                    onDragOver={handleDragOver}
                    onDrop={(e) => handleDrop(e, c.cell_id)}
                    style={{ minHeight: '180px', borderStyle: 'dashed', borderColor: c.is_archived ? 'var(--warning)' : undefined, background: c.is_archived ? 'rgba(255,179,0,0.03)' : undefined, opacity: c.is_archived ? 0.85 : 1 }}
                    title={c.is_archived ? `Cell Zone #${c.cell_id} (Archived / Out of Commission)` : `Cell Zone #${c.cell_id}: Drag device node here to reassign`}
                  >
                    <div className="zone-header">
                      <div className="zone-title" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '6px' }} onClick={() => onNavigateTab && onNavigateTab('cells')} title={`Click to view Cell '${c.cell_name}' on Cells page`}>
                        <IconFactory size={16} /> <span>{c.cell_name}</span>
                        {c.is_archived && (
                          <span className="badge badge-warning" style={{ background: 'rgba(255,179,0,0.15)', color: 'var(--warning)', border: '1px solid var(--warning)', padding: '1px 6px', fontSize: '9px', display: 'inline-flex', alignItems: 'center', gap: '3px' }} title="Shopfloor Cell zone archived">
                            <IconArchive size={10} /> ARCHIVED
                          </span>
                        )}
                      </div>
                      {c.access_url ? (
                        <a href={c.access_url} target="_blank" rel="noopener noreferrer" className="btn btn-primary btn-sm" style={{ textDecoration: 'none', gap: '4px', background: 'var(--accent)', color: '#000', padding: '2px 8px', fontSize: '11px' }} title="Open Cell Dashboard / Grafana UI">
                          <IconExternalLink size={11} /> Dashboard
                        </a>
                      ) : (
                        <span className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Zone #{c.cell_id}</span>
                      )}
                    </div>

                    <div className="zone-body">
                      <div>
                        <div className="zone-section-title" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <IconRadio size={12} /> Active Edge Gateways ({cellGateways.length})
                        </div>
                        {cellGateways.length === 0 ? (
                          <div style={{ fontSize: '11px', color: 'var(--text-dim)', fontStyle: 'italic' }}>No active gateways serving this zone.</div>
                        ) : (
                          <div className="zone-chips">
                            {cellGateways.map(g => {
                              const isGwArch = g.is_archived
                              const gwStatus = gatewayLiveStatus(g)
                              return (
                                <span key={g.gateway_id} className="chip chip-gw" title={`Gateway ${g.gateway_name} ${g.is_virtual ? '(Virtual Gateway)' : ''} ${isGwArch ? '(Archived)' : `(${gwStatus}, heartbeat ${formatHeartbeat(g.last_heartbeat)})`} — ${g.device_count} device(s) — Click to view on Gateways page`} onClick={() => onSelectGateway(g.gateway_id)} style={{ cursor: 'pointer', borderColor: isGwArch ? 'var(--warning)' : g.is_virtual ? 'var(--accent)' : undefined, opacity: isGwArch ? 0.75 : 1 }}>
                                  {isGwArch ? <IconArchive size={11} style={{ color: 'var(--warning)' }} /> : <span className={`badge-dot ${gwStatus === 'ONLINE' ? 'badge-online' : 'badge-offline'}`} />}
                                  <span className="mono">{g.gateway_name}</span> ({g.device_count} devices)
                                  {g.is_virtual && !isGwArch && <span className="badge badge-warning" style={{ background: 'rgba(0,212,255,0.15)', color: 'var(--accent)', border: '1px solid var(--accent)', padding: '1px 5px', fontSize: '9px', marginLeft: '4px', display: 'inline-flex', alignItems: 'center', gap: '2px' }}><IconZap size={9} /> VIRTUAL</span>}
                                  {isGwArch && <span className="badge badge-warning" style={{ background: 'rgba(255,179,0,0.15)', color: 'var(--warning)', border: '1px solid var(--warning)', padding: '1px 5px', fontSize: '9px', marginLeft: '4px' }}>ARCHIVED</span>}
                                </span>
                              )
                            })}
                          </div>
                        )}
                      </div>

                      <div>
                        <div className="zone-section-title" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <IconCpu size={12} /> Operating Devices ({cellAssets.length})
                        </div>
                        {cellAssets.length === 0 ? (
                          <div style={{ fontSize: '11px', color: 'var(--text-dim)', fontStyle: 'italic', border: '1px dashed var(--border)', padding: '12px', borderRadius: '6px', textAlign: 'center' }}>
                            Drag & drop device node here to assign
                          </div>
                        ) : (
                          <div className="zone-chips">
                            {cellAssets.map(a => {
                              const colorCls = getDeviceStatusColor(a)
                              const isOff = a.status === 'OFFLINE'
                              const isArch = a.is_archived
                              const isInactive = isOff || isArch
                              return (
                                <span
                                  key={a.asset_id}
                                  className={`chip ${colorCls}`}
                                  draggable={canManageDevice && !isInactive}
                                  onDragStart={(e) => handleDragStart(e, a)}
                                  onClick={() => onSelectDevice(a.asset_id)}
                                  style={{ cursor: isInactive ? 'pointer' : canManageDevice ? 'grab' : 'pointer', userSelect: 'none', opacity: isArch ? 0.7 : 1 }}
                                  title={isArch ? 'Device Archived (Out of Commission) — Click to view on Devices page' : isOff ? 'Device Offline (DDEATH Received) — Click to view on Devices page' : canManageDevice ? 'Drag to reassign Cell or Click to view on Devices page' : 'Click to view on Devices page'}
                                >
                                  {isArch ? <IconArchive size={12} /> : <IconCog size={12} />}
                                  <span>{a.asset_name}</span>
                                  <span className="mono" style={{ fontSize: '10px' }}>[{a.asset_id}]</span>
                                  {isArch && <span style={{ fontSize: '10px', fontWeight: 600, color: 'var(--warning)', marginLeft: '2px' }}>(ARCHIVED)</span>}
                                  {isOff && !isArch && <span style={{ fontSize: '10px', fontWeight: 600, color: 'var(--text-muted)', marginLeft: '2px' }}>(OFFLINE)</span>}
                                </span>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>
      </div>
    </>
  )
}
