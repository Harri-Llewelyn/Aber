import React, { useState, useCallback, useMemo } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS, REALTIME_ENABLED, STALENESS_TICK_MS, refreshInterval } from '../../constants'
import { usePolling } from '../../hooks/usePolling'
import { useRealtimeTable } from '../../hooks/useRealtimeTable'
import { useClockTick } from '../../hooks/useClockTick'
import { gatewayLiveStatus, isGatewayOnline, formatHeartbeat } from '../../utils/gatewayStatus'
import { effectiveSparkplugId } from '../../utils/sparkplugId'
import {
  SCOPE_CELL, SCOPE_SITE_WIDE, SOURCE_UNASSIGNED, SOURCE_SITE_WIDE, groupDevicesByCell
} from '../../utils/cellResolution'
import {
  IconMap,
  IconFactory,
  IconRadio,
  IconCpu,
  IconArchive,
  IconExternalLink,
  IconLock,
  IconPencil,
  IconShieldAlert,
  IconZap,
  IconCog
} from '../common/Icons'

export function OverviewTab({ onSelectDevice, onSelectGateway, onSelectCell, showToast, hasPermission, onNavigateTab }) {
  const [stats, setStats]     = useState({ cells: 0, gateways: 0, assets: 0, telemetry: 0 })
  const [cells, setCells]     = useState([])
  const [gwList, setGwList]   = useState([])
  const [assets, setAssets]   = useState([])
  const [telemetry, setTelemetry] = useState([])
  const [loading, setLoading] = useState(true)

  const loadAll = useCallback(async (signal) => {
    try {
      // /api/v1/stats is deliberately no longer requested. Its only consumers were the
      // Pending Quarantine card's value and a `docs` field nothing ever read. The quarantine
      // figure is now derived from `assets`, which this page already has in full -- so the
      // endpoint was a second round-trip per refresh for a number we could already count,
      // and a second source of truth that could disagree with the list beside it.
      const [c, g, a, t] = await Promise.all([
        api.get('/api/v1/cells', { signal }),
        api.get('/api/v1/gateways', { signal }),
        api.get('/api/v1/devices', { signal }),
        // The map only needs the current value of each metric, not history -- and this
        // runs on a 3s poll, so it must stay bounded.
        api.get('/api/v1/telemetry/latest?minutes=60', { signal }).catch(() => []),
      ])
      setStats({ cells: c.length, gateways: g.length, assets: a.length, telemetry: t.length })
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

  /**
   * Drag-and-drop is OFF until explicitly enabled, and that is a deliberate second gate on top of
   * the permission check.
   *
   * This page is mostly read: it is the one people leave open on a wall display and glance at. A
   * drag is a one-gesture, no-confirmation write to a device's location, so a slipped mouse
   * silently relocated an asset — and every correction is a second row in `digital_thread`, which
   * migration 0006 makes immutable. Those rows are not the problem and must not be suppressed: the
   * move genuinely happened, and an audit trail that hides operator mistakes is worth less than one
   * that does not. The fix is to stop the accidental gesture, not to hide its record.
   *
   * A mode toggle rather than a confirm-on-drop: confirmation turns every deliberate move into two
   * steps and gets clicked through anyway, whereas a mode is paid for once per editing session. It
   * also advertises the feature, which was previously discoverable only by trying it.
   */
  const [rearranging, setRearranging] = useState(false)
  const canRearrange = canManageDevice && rearranging

  const handleDragStart = (e, asset) => {
    if (!canRearrange || asset.status === 'OFFLINE') return
    e.dataTransfer.setData('application/json', JSON.stringify(asset))
  }

  // Without preventDefault the browser refuses the drop outright, so this is what actually makes a
  // zone inert outside rearrange mode -- not just the guard in the drop handlers.
  const handleDragOver = (e) => {
    if (!canRearrange) return
    e.preventDefault()
  }

  const handleDrop = async (e, targetCellId) => {
    e.preventDefault()
    if (!canRearrange) return
    try {
      const assetData = JSON.parse(e.dataTransfer.getData('application/json'))
      // Where it currently resolves to, not its explicit override -- a device inheriting the
      // target cell is already there and dropping it again should stay a no-op.
      if (assetData.effective_cell_id === targetCellId) return

      const targetCellName = cells.find(c => c.cell_id === targetCellId)?.cell_name || 'the target cell'

      // A drop writes devices.cell_id directly (migration 0036). It used to have to rewire the
      // device's GATEWAY to express a move, because location was only inheritable -- which meant
      // the drop was refused outright when the target cell had no gateway or more than one, and
      // when it did work it changed the data path to say something about geography. Dragging a
      // machine across the floor plan says where the machine is; it says nothing about which
      // connector reaches it, so the gateway is deliberately left alone.
      await api.put(`/api/v1/devices/${assetData.asset_id}`, {
        asset_name: assetData.asset_name,
        cell_id: targetCellId,
        location_scope: SCOPE_CELL,
      })

      await loadAll()

      // Worth saying out loud: the device is now pinned to this cell and will no longer follow
      // its gateway. That is what the drop asked for, but it is not visible in the result.
      const servingGateway = gwList.find(g => g.gateway_id === assetData.active_gateway_id)
      const detached = servingGateway && servingGateway.cell_id && servingGateway.cell_id !== targetCellId
      showToast(
        detached
          ? `Device '${assetData.asset_name}' moved to '${targetCellName}' — it now stays there regardless of its gateway`
          : `Device '${assetData.asset_name}' moved to '${targetCellName}'`,
        'success'
      )
    } catch (err) {
      showToast(err.message, 'error')
    }
  }

  // Cell membership, resolved from the device list this page already holds. See
  // groupDevicesByCell() for why the cells endpoint does not supply this.
  const devicesByCell = useMemo(() => groupDevicesByCell(assets), [assets])

  // The two derived lanes. Neither is a row in `cells` -- Unassigned is the absence of a decision
  // and Site-Wide is an operator's assertion that an asset has no single cell, and a magic cell
  // row would put both meanings in a free-text name. They are rendered beside the cells because
  // that is where an operator looks for an asset, and because a queue nobody can see never drains.
  const laneDevices = useMemo(() => ({
    [SOURCE_UNASSIGNED]: assets.filter(a => a.location_source === SOURCE_UNASSIGNED),
    [SOURCE_SITE_WIDE]: assets.filter(a => a.location_source === SOURCE_SITE_WIDE)
  }), [assets])

  /**
   * Drop onto one of the two derived lanes.
   *
   * Site-Wide is an assertion and always takes: it sets the scope and clears the cell, mirroring
   * devices_site_wide_has_no_cell.
   *
   * UNASSIGNED IS NOT SETTABLE, and that is not a limitation to work around -- it is what the
   * word means. Unassigned is the resolution running out of arms, so the drop clears the device's
   * explicit cell and then reports where it actually landed. A device whose gateway serves a cell
   * will inherit that cell again and visibly spring back, which is correct: it is not unassigned,
   * and saying otherwise would be the one lie this model exists to avoid telling. Detaching the
   * gateway to force it would express a location intent by changing the DATA PATH -- exactly the
   * coupling migration 0036 removed.
   */
  const handleLaneDrop = async (e, lane) => {
    e.preventDefault()
    if (!canRearrange) return
    try {
      const assetData = JSON.parse(e.dataTransfer.getData('application/json'))
      if (assetData.location_source === lane) return

      const siteWide = lane === SOURCE_SITE_WIDE
      await api.put(`/api/v1/devices/${assetData.asset_id}`, {
        asset_name: assetData.asset_name,
        cell_id: '',
        location_scope: siteWide ? SCOPE_SITE_WIDE : SCOPE_CELL,
      })
      await loadAll()

      if (siteWide) {
        showToast(`Device '${assetData.asset_name}' marked Site-Wide — it now belongs to no single cell`, 'success')
        return
      }

      const gateway = gwList.find(g => g.gateway_id === assetData.active_gateway_id)
      const inheritedName = gateway?.cell_id
        ? (cells.find(c => c.cell_id === gateway.cell_id)?.cell_name || 'its gateway\'s cell')
        : null

      showToast(
        inheritedName
          ? `Cleared the explicit cell on '${assetData.asset_name}' — it now inherits '${inheritedName}' from gateway '${gateway.gateway_name}'. To leave it unassigned, clear that gateway's cell or mark the device Site-Wide.`
          : `Device '${assetData.asset_name}' moved to Unassigned`,
        inheritedName ? 'warning' : 'success'
      )
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
    // MTConnect vocabularies (archive/20260101000019, now in 0002_seed_data.sql): EXECUTION is
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

  // One renderer for cell cards and both lanes. A device dragged out of Unassigned has to look
  // and behave exactly like one already in a cell, or the lanes read as a different kind of thing
  // rather than as somewhere the same asset currently sits.
  const deviceChip = (a) => {
    const colorCls = getDeviceStatusColor(a)
    const isOff = a.status === 'OFFLINE'
    const isArch = a.is_archived
    const isInactive = isOff || isArch
    return (
      <span
        key={a.asset_id}
        className={`chip ${colorCls}`}
        draggable={canRearrange && !isInactive}
        onDragStart={(e) => handleDragStart(e, a)}
        onClick={() => onSelectDevice(a.asset_id)}
        style={{ cursor: isInactive ? 'pointer' : canRearrange ? 'grab' : 'pointer', userSelect: 'none', opacity: isArch ? 0.7 : 1 }}
        title={isArch ? 'Device Archived (Out of Commission) — Click to view on Devices page' : isOff ? 'Device Offline (DDEATH Received) — Click to view on Devices page' : canRearrange ? 'Drag to reassign Cell or Click to view on Devices page' : 'Click to view on Devices page'}
      >
        {isArch ? <IconArchive size={12} /> : <IconCog size={12} />}
        <span>{a.asset_name}</span>
        <span className="mono" style={{ fontSize: '10px' }}>[{a.asset_id}]</span>
        {isArch && <span style={{ fontSize: '10px', fontWeight: 600, color: 'var(--warning-text)', marginLeft: '2px' }}>(ARCHIVED)</span>}
        {isOff && !isArch && <span style={{ fontSize: '10px', fontWeight: 600, color: 'var(--text-muted)', marginLeft: '2px' }}>(OFFLINE)</span>}
      </span>
    )
  }

  // Shared with the cell zones for the same reason as deviceChip: a gateway in a lane must read
  // as the same object in a different place, not as a different kind of thing.
  const gatewayChip = (g) => {
    const isGwArch = g.is_archived
    const gwStatus = gatewayLiveStatus(g)
    return (
      <span key={g.gateway_id} className="chip chip-gw" title={`Gateway ${g.gateway_name} ${g.is_virtual ? '(Virtual Gateway)' : ''} ${isGwArch ? '(Archived)' : `(${gwStatus}, heartbeat ${formatHeartbeat(g.last_heartbeat)})`} — ${g.device_count} device(s) — Click to view on Gateways page`} onClick={() => onSelectGateway(g.gateway_id)} style={{ cursor: 'pointer', borderColor: isGwArch ? 'var(--warning)' : g.is_virtual ? 'var(--accent)' : undefined, opacity: isGwArch ? 0.75 : 1 }}>
        {isGwArch ? <IconArchive size={11} style={{ color: 'var(--warning-text)' }} /> : <span className={`badge-dot ${gwStatus === 'ONLINE' ? 'badge-online' : 'badge-offline'}`} />}
        <span className="mono">{g.gateway_name}</span> ({g.device_count} devices)
        {g.is_virtual && !isGwArch && <span className="badge badge-warning" style={{ background: 'rgba(0,212,255,0.15)', color: 'var(--accent)', border: '1px solid var(--accent)', padding: '1px 5px', fontSize: '9px', marginLeft: '4px', display: 'inline-flex', alignItems: 'center', gap: '2px' }}><IconZap size={9} /> VIRTUAL</span>}
        {isGwArch && <span className="badge badge-warning" style={{ background: 'rgba(255,179,0,0.15)', color: 'var(--warning-text)', border: '1px solid var(--warning)', padding: '1px 5px', fontSize: '9px', marginLeft: '4px' }}>ARCHIVED</span>}
      </span>
    )
  }

  // Site-Wide first: it is infrastructure and its contents are stable, so it reads as context for
  // the queue below it. Unassigned comes second because it is the thing to act on and empty, and
  // it sits directly above the cells its contents are waiting to be filed into.
  //
  // A gateway's lane is read from its OWN columns, not from the resolution a device goes through
  // -- gateways have no inheritance to resolve. Unassigned means "cell-scoped but no cell yet",
  // which is why it tests both fields: a site-wide gateway has no cell either, and lumping the
  // two together would put a deliberate answer in a queue that is supposed to drain.
  const LANES = [
    {
      key: SOURCE_SITE_WIDE,
      title: 'Site-Wide',
      icon: IconMap,
      colour: 'var(--accent)',
      matchGateway: (g) => g.location_scope === SCOPE_SITE_WIDE,
      emptyGateways: 'No site-wide gateways. Mark a host-run or central connector Site-Wide on the Gateways page.',
      empty: 'No site-wide devices. Drop a BMS, AGV or ambient sensor here.',
      hint: 'A permanent home, not a queue. Facility-wide and mobile assets live here rather than being filed in an arbitrary bay.'
    },
    {
      key: SOURCE_UNASSIGNED,
      title: 'Unassigned',
      icon: IconShieldAlert,
      colour: 'var(--warning)',
      matchGateway: (g) => g.location_scope !== SCOPE_SITE_WIDE && !g.cell_id,
      emptyGateways: 'Every gateway has a cell or is Site-Wide.',
      empty: 'Nothing waiting — every device resolves to a cell or is Site-Wide.',
      hint: 'A work queue, not a location. Drop a device here to clear the cell set on it; if its gateway serves a cell it will inherit that instead.',
      // Collapses to a single line when it holds nothing. This is the one lane where empty is a
      // RESULT rather than a state: the queue has drained, and a full-height card devoted to
      // saying so competes for attention with the cells that actually have contents. Site-Wide
      // deliberately does not do this -- an empty Site-Wide is not an achievement, and shrinking
      // it would just make the pair jump about.
      minimiseWhenEmpty: true,
      minimisedLabel: 'All clear — every asset resolves to a cell or is Site-Wide'
    }
  ]

  // A lane that has collapsed is STILL A DROP TARGET: an empty queue is exactly when someone
  // wants to drag something into it, so shrinking it must not take that away.
  const laneViews = LANES.map(lane => {
    const devices = laneDevices[lane.key] || []
    const gateways = gwList.filter(lane.matchGateway)
    return {
      lane,
      devices,
      gateways,
      minimised: !!lane.minimiseWhenEmpty && devices.length === 0 && gateways.length === 0
    }
  })

  if (loading) return <div className="loading-wrap"><div className="spinner" /> Loading shopfloor overview…</div>

  const activeCellsCount = cells.filter(c => !c.is_archived).length
  const archivedCellsCount = cells.filter(c => c.is_archived).length

  // A gateway is only "online" while its heartbeat is fresh -- an edge node that stops
  // publishing never writes an OFFLINE status, it just goes quiet.
  const onlineGwCount = gwList.filter(g => !g.is_archived && isGatewayOnline(g)).length
  const offlineGwCount = gwList.filter(g => !g.is_archived && !isGatewayOnline(g)).length
  const archivedGwCount = gwList.filter(g => g.is_archived).length

  // Quarantined is its OWN bucket, and Online/Offline exclude it.
  //
  // These used to overlap: a quarantined device is stored with status OFFLINE, so a single
  // pending device was counted as "1 Offline" here AND as "1" on a separate Pending
  // Quarantine card -- the same device reported twice on one screen, and the Offline figure
  // implied a fault where the real state was "waiting to be admitted".
  //
  // The four buckets are now mutually exclusive and sum to the card's total.
  const quarantinedAssetsCount = assets.filter(a => a.is_quarantined && !a.is_archived).length
  const onlineAssetsCount = assets.filter(a => (a.status === 'ONLINE' || !a.status) && !a.is_archived && !a.is_quarantined).length
  const offlineAssetsCount = assets.filter(a => a.status === 'OFFLINE' && !a.is_archived && !a.is_quarantined).length
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
        {/*
          The separate "Pending Quarantine" card was folded in here. It reported the same
          device the Offline figure already counted, and quarantine is a sub-state of the
          device population rather than a population of its own.

          Losing the dedicated card must not lose the prominence, since quarantine is the one
          state on this page that requires an operator to act. The card therefore raises a
          warning treatment while any device is held: a coloured border, an icon beside the
          label, and the count called out in the breakdown. The icon and the word
          "Quarantined" carry the meaning on their own, so the signal does not depend on
          colour alone.
        */}
        <div
          className={`stat-card${quarantinedAssetsCount > 0 ? ' stat-card-alert' : ''}`}
          style={{ cursor: 'pointer' }}
          onClick={() => onNavigateTab && onNavigateTab('devices')}
          title={quarantinedAssetsCount > 0
            ? `${quarantinedAssetsCount} device${quarantinedAssetsCount === 1 ? '' : 's'} awaiting zero-touch onboarding approval. Click to review the quarantine queue.`
            : 'Total registered shopfloor devices. Click to view Devices.'}
        >
          <div className="stat-label" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            Total Devices
            {quarantinedAssetsCount > 0 && (
              <IconShieldAlert size={13} style={{ color: 'var(--warning-text)' }} aria-label="Devices awaiting quarantine approval" />
            )}
          </div>
          <div className="stat-value">{stats.assets}</div>
          <div className="stat-sub">
            {onlineAssetsCount} Online / {offlineAssetsCount} Offline /{' '}
            <span style={quarantinedAssetsCount > 0 ? { color: 'var(--warning-text)', fontWeight: 700 } : undefined}>
              {quarantinedAssetsCount} Quarantined
            </span>
            {' '}/ {archivedAssetsCount} Archived
          </div>
        </div>
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
              {canManageDevice ? (
                <button
                  className={`btn btn-sm ${rearranging ? 'btn-primary' : 'btn-ghost'}`}
                  style={{ marginLeft: '10px' }}
                  onClick={() => setRearranging(v => !v)}
                  aria-pressed={rearranging}
                  title={rearranging
                    ? 'Rearrange mode is ON — drag devices between cells and lanes. Every move is written immediately and recorded in the digital thread. Click to finish.'
                    : 'Turn on Rearrange to drag devices between cells and lanes. Off by default so a stray drag cannot relocate an asset.'}
                >
                  <IconPencil size={12} /> {rearranging ? 'Rearranging — click to finish' : 'Rearrange'}
                </button>
              ) : (
                <span style={{ color: 'var(--danger)', fontSize: '11px', marginLeft: '10px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                  <IconLock size={11} /> Drag-and-Drop locked (Requires Admin permissions)
                </span>
              )}
            </div>
          </div>

          {/* Shown only while the mode is on, so the page carries no standing instruction about a
              gesture that is usually unavailable — and so it is obvious the map is live. */}
          {canRearrange && (
            <div style={{ marginBottom: '16px', fontSize: '11px', color: 'var(--warning-text)', background: 'rgba(255,179,0,0.08)', border: '1px solid var(--warning)', borderRadius: 'var(--radius-sm)', padding: '8px 12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <IconPencil size={12} />
              <span>
                Drag a device onto a cell or lane to move it. Each move is recorded in the digital thread.
              </span>
            </div>
          )}

          {/* THE DERIVED LANES, ABOVE THE PHYSICAL CELLS.
              Site-Wide and Unassigned are not cells, so they do not belong in the cell grid --
              inside it they reflowed between the bays as cells were added and the queue moved
              somewhere new on every stack. Stacked full-width at the top they are always in the
              same place: infrastructure first, then the queue that should drain.

              Each lane holds BOTH gateways and devices. A gateway with no cell is exactly as
              stranded as a device with no cell -- and it is usually the CAUSE of the devices
              beside it being stranded, since they had nothing to inherit. Showing only the
              devices left the reason off-screen. */}
          <div className="shopfloor-lanes">
            {laneViews.map(({ lane, devices: laneAssets, gateways: laneGateways, minimised }) => {
              const LaneIcon = lane.icon
              return (
                <div
                  key={lane.key}
                  className={`shopfloor-zone${minimised ? ' shopfloor-zone-mini' : ''}`}
                  onDragOver={handleDragOver}
                  onDrop={(e) => handleLaneDrop(e, lane.key)}
                  style={{ minHeight: minimised ? 0 : '180px', borderStyle: 'dashed', borderColor: lane.colour, background: 'transparent' }}
                  title={lane.hint}
                >
                  <div className="zone-header">
                    <div className="zone-title" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                      <LaneIcon size={16} /> <span>{lane.title}</span>
                      {!minimised && (
                        <span className="badge badge-neutral" style={{ fontSize: '9px' }} title="A derived lane, not a cell — it has no record in the database">DERIVED</span>
                      )}
                    </div>
                    {minimised ? (
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                        {lane.minimisedLabel}
                      </span>
                    ) : (
                      <span className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                        {laneGateways.length} gw / {laneAssets.length} dev
                      </span>
                    )}
                  </div>

                  {/* The body is dropped entirely when minimised -- two "nothing here" panels are
                      what made an empty queue louder than the cells that have contents. The zone
                      itself stays, so it is still somewhere you can drag an asset to.

                      There is no standing caption either: what a lane means is on the zone's
                      `title`, so the explanation is a hover away rather than a permanent line of
                      prose competing with the assets it describes. */}
                  {!minimised && (
                  <div className="zone-body">
                    <div>
                      <div className="zone-section-title" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <IconRadio size={12} /> Active Edge Gateways ({laneGateways.length})
                      </div>
                      {laneGateways.length === 0 ? (
                        <div style={{ fontSize: '11px', color: 'var(--text-dim)', fontStyle: 'italic' }}>{lane.emptyGateways}</div>
                      ) : (
                        <div className="zone-chips">
                          {laneGateways.map(gatewayChip)}
                        </div>
                      )}
                    </div>

                    <div>
                      <div className="zone-section-title" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <IconCpu size={12} /> Operating Devices ({laneAssets.length})
                      </div>
                      {laneAssets.length === 0 ? (
                        <div style={{ fontSize: '11px', color: 'var(--text-dim)', fontStyle: 'italic', border: '1px dashed var(--border)', padding: '12px', borderRadius: '6px', textAlign: 'center' }}>
                          {lane.empty}
                        </div>
                      ) : (
                        <div className="zone-chips">
                          {laneAssets.map(deviceChip)}
                        </div>
                      )}
                    </div>
                  </div>
                  )}
                </div>
              )
            })}
          </div>

          <div className="shopfloor-section-label">
            <IconFactory size={12} /> Physical Cells ({cells.length})
          </div>

          <div className="shopfloor-grid">
            {cells.length === 0 && (
              <div className="empty-state" style={{ gridColumn: '1 / -1' }}>
                <div className="empty-icon"><IconFactory size={36} /></div>
                <div className="empty-text">No active cells configured to display on the shopfloor blueprint.</div>
              </div>
            )}
            {cells.map(c => {
                // Cells own gateways; gateways own devices. Deriving the gateway list
                // from the devices instead hid every gateway that has no device yet.
                const cellGateways = gwList.filter(g => g.cell_id === c.cell_id)
                // Devices that RESOLVE to this cell, grouped from the list this page already
                // loads. /api/v1/cells no longer returns them -- on a 3s poll, having that
                // endpoint fetch the device table as well meant reading it twice a tick.
                const cellAssets = devicesByCell.get(c.cell_id) || []
                // Same rule as the Unassigned lane: a zone with nothing in it collapses to its
                // header. A newly created cell has no gateway and no device, so a stack in the
                // middle of being set up was mostly full-height cards saying "no gateways
                // serving this zone" three times over -- and the cells that DO have contents,
                // which are the reason to look at this page, were pushed below the fold.
                const cellIsEmpty = cellGateways.length === 0 && cellAssets.length === 0

                return (
                  <div
                    key={c.cell_id}
                    className={`shopfloor-zone${cellIsEmpty ? ' shopfloor-zone-mini' : ''}`}
                    onDragOver={handleDragOver}
                    onDrop={(e) => handleDrop(e, c.cell_id)}
                    style={{ minHeight: cellIsEmpty ? 0 : '180px', borderStyle: 'dashed', borderColor: c.is_archived ? 'var(--warning)' : undefined, background: c.is_archived ? 'rgba(255,179,0,0.03)' : undefined, opacity: c.is_archived ? 0.85 : 1 }}
                    title={c.is_archived ? `Cell Zone #${c.cell_id} (Archived / Out of Commission)` : `Cell Zone #${c.cell_id}: Drag device node here to reassign`}
                  >
                    <div className="zone-header">
                      {/* Hands the cell's id over so the Cells page arrives filtered to it. This
                          used to call onNavigateTab('cells'), which dropped the identity and
                          landed on an unfiltered list -- while the title below promised
                          otherwise. onSelectCell mirrors onSelectDevice/onSelectGateway above;
                          it falls back to a plain navigation so the card still works if a
                          caller wires only the tab handler. */}
                      <div className="zone-title" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '6px' }} onClick={() => onSelectCell ? onSelectCell(c.cell_id) : onNavigateTab && onNavigateTab('cells')} title={`Click to view Cell '${c.cell_name}' on Cells page`}>
                        <IconFactory size={16} /> <span>{c.cell_name}</span>
                        {c.is_archived && (
                          <span className="badge badge-warning" style={{ background: 'rgba(255,179,0,0.15)', color: 'var(--warning-text)', border: '1px solid var(--warning)', padding: '1px 6px', fontSize: '9px', display: 'inline-flex', alignItems: 'center', gap: '3px' }} title="Shopfloor Cell zone archived">
                            <IconArchive size={10} /> ARCHIVED
                          </span>
                        )}
                        {cellIsEmpty && (
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontStyle: 'italic', fontWeight: 400 }}>empty</span>
                        )}
                      </div>
                      {/* The Dashboard link and zone id stay in the collapsed form: they are the
                          only two things an empty cell still offers. */}
                      {c.access_url ? (
                        <a href={c.access_url} target="_blank" rel="noopener noreferrer" className="btn btn-primary btn-sm" style={{ textDecoration: 'none', gap: '4px', padding: '2px 8px', fontSize: '11px' }} title="Open Cell Dashboard / Grafana UI">
                          <IconExternalLink size={11} /> Dashboard
                        </a>
                      ) : (
                        <span className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Zone #{c.cell_id}</span>
                      )}
                    </div>

                    {!cellIsEmpty && (
                    <div className="zone-body">
                      <div>
                        <div className="zone-section-title" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <IconRadio size={12} /> Active Edge Gateways ({cellGateways.length})
                        </div>
                        {cellGateways.length === 0 ? (
                          <div style={{ fontSize: '11px', color: 'var(--text-dim)', fontStyle: 'italic' }}>No active gateways serving this zone.</div>
                        ) : (
                          <div className="zone-chips">
                            {cellGateways.map(gatewayChip)}
                          </div>
                        )}
                      </div>

                      <div>
                        <div className="zone-section-title" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <IconCpu size={12} /> Operating Devices ({cellAssets.length})
                        </div>
                        {cellAssets.length === 0 ? (
                          <div style={{ fontSize: '11px', color: 'var(--text-dim)', fontStyle: 'italic', border: '1px dashed var(--border)', padding: '12px', borderRadius: '6px', textAlign: 'center' }}>
                            {/* Not a standing instruction for a gesture that is off. */}
                            {canRearrange ? 'Drag & drop device node here to assign' : 'No devices in this cell zone.'}
                          </div>
                        ) : (
                          <div className="zone-chips">
                            {cellAssets.map(deviceChip)}
                          </div>
                        )}
                      </div>
                    </div>
                    )}
                  </div>
                )
              })}

          </div>
        </div>
      </div>
    </>
  )
}
