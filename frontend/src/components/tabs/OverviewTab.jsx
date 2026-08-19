import React, { useState, useCallback, useMemo } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS, REALTIME_ENABLED, STALENESS_TICK_MS, refreshInterval } from '../../constants'
import { usePolling } from '../../hooks/usePolling'
import { useRealtimeTable } from '../../hooks/useRealtimeTable'
import { useClockTick } from '../../hooks/useClockTick'
import { gatewayLiveStatus, isGatewayOnline, isGatewayPending, formatHeartbeat } from '../../utils/gatewayStatus'
import {
  SCOPE_CELL, SCOPE_SITE_WIDE, SOURCE_UNASSIGNED, SOURCE_SITE_WIDE, groupDevicesByCell
} from '../../utils/cellResolution'
import { cellIconComponent } from '../../utils/cellIcon'
import {
  DEVICE_STATUS,
  deviceLifecycleStatus,
  deviceStatusChipClass,
  deviceStatusTitle,
  rollupDeviceStatus
} from '../../utils/deviceStatus'
import {
  IconMap,
  IconFactory,
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

  /**
   * The tile a drop is currently being written to, keyed by the tile's own id -- a cell_id for a
   * bay, or the lane key for one of the two derived lanes.
   *
   * Needed because a drop is the one mutation here with NO optimistic feedback of its own: the
   * device keeps rendering in the tile it came from until the reload lands, so between the mouse
   * release and the api.put resolving the map looks exactly as it did before the drag. On a slow
   * link that is indistinguishable from a refused drop, and the reliable response is to drag it
   * again -- which is how one move became two writes.
   */
  const [pendingZone, setPendingZone] = useState(null)

  const handleDrop = async (e, targetCellId) => {
    e.preventDefault()
    if (!canRearrange) return
    // Read BEFORE the first await: the drag event's dataTransfer is cleared once the handler
    // yields, so parsing after setting the pending state would read an empty payload.
    let assetData
    try {
      assetData = JSON.parse(e.dataTransfer.getData('application/json'))
    } catch (err) {
      showToast(err.message, 'error')
      return
    }

    setPendingZone(targetCellId)
    try {
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
    } finally {
      setPendingZone(null)
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
    // Parsed before the first await, for the reason given in handleDrop.
    let assetData
    try {
      assetData = JSON.parse(e.dataTransfer.getData('application/json'))
    } catch (err) {
      showToast(err.message, 'error')
      return
    }

    setPendingZone(lane)
    try {
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
    } finally {
      setPendingZone(null)
    }
  }

  // The per-asset telemetry index that used to live here is GONE, along with the only thing that
  // read it. Nothing on this page inspects metric VALUES any more -- `telemetry` is still fetched,
  // but only for the row count on the stats card. Keeping the Map would have been a per-render
  // rebuild of an index with no consumer.

  /**
   * The tile's health dot: the state of the devices resolving to it.
   *
   * This is what makes an eight-column grid scannable at all. Without it you have to read the
   * chips inside every tile to find the one that needs attention.
   *
   * IT REPORTS CONNECTIVITY, NOT PROCESS CONDITION. This used to evaluate the latest telemetry
   * against hardcoded rules -- `Systems/TEMPERATURE > 80.0` among them -- and paint an Alarm
   * state. See utils/deviceStatus.js for the four reasons that was wrong; the short version is
   * that the threshold was a literal while every device publishes its own, and a React render
   * pass is not an alerting engine. Metric thresholds are Grafana's job.
   */
  const rollupStatus = useCallback((devices) => rollupDeviceStatus(devices), [])

  const STATUS_LABEL = {
    attention: 'Needs attention — a device here is quarantined, waiting to be admitted',
    normal: 'Normal — at least one device here is online',
    idle: 'Nothing live — no device here is currently reporting'
  }

  // One renderer for cell cards and both lanes. A device dragged out of Unassigned has to look
  // and behave exactly like one already in a cell, or the lanes read as a different kind of thing
  // rather than as somewhere the same asset currently sits.
  const deviceChip = (a) => {
    const status = deviceLifecycleStatus(a)
    const isArch = a.is_archived
    // Archived reads as inert regardless of the last lifecycle state it held -- a decommissioned
    // machine that happens to still be publishing must not look like a running one.
    const colorCls = isArch ? 'chip-offline' : deviceStatusChipClass(status)
    const isOff = status !== DEVICE_STATUS.ONLINE
    const isInactive = isOff || isArch
    return (
      <span
        key={a.asset_id}
        className={`chip ${colorCls}`}
        draggable={canRearrange && !isInactive}
        onDragStart={(e) => handleDragStart(e, a)}
        onClick={() => onSelectDevice(a.asset_id)}
        style={{ cursor: isInactive ? 'pointer' : canRearrange ? 'grab' : 'pointer', userSelect: 'none', opacity: isArch ? 0.7 : 1 }}
        title={`${a.asset_name} [${a.asset_id}] — ${isArch ? 'Device Archived (Out of Commission)' : deviceStatusTitle(status)} — ${canRearrange && !isInactive ? 'Drag to reassign Cell, or click' : 'Click'} to view on Devices page`}
      >
        {isArch ? <IconArchive size={11} /> : <IconCog size={11} />}
        {/* NAME ONLY. The UUID used to sit inline beside it, capped at ~72px, and it was buying
            almost nothing: six characters of an opaque identifier are not enough to recognise a
            device by, and they were the reason a name as ordinary as "Sim_CNC_Mill_01" clipped.
            The full id is on the `title` above, where it is actually readable. */}
        <span className="chip-name">{a.asset_name}</span>
        {isArch && <span className="chip-flag" style={{ color: 'var(--warning-text)' }}>ARCH</span>}
        {/* QUARANTINED AND OFFLINE GET DIFFERENT FLAGS. Both are "not running", but only one of
            them is waiting on a decision somebody has to make, and labelling a pending device OFF
            says it went away rather than that it was never let in. */}
        {!isArch && status === DEVICE_STATUS.QUARANTINED && (
          <span className="chip-flag" style={{ color: 'var(--warning-text)' }}>QUAR</span>
        )}
        {!isArch && status === DEVICE_STATUS.OFFLINE && (
          <span className="chip-flag" style={{ color: 'var(--text-muted)' }}>OFF</span>
        )}
      </span>
    )
  }

  // Shared with the cell zones for the same reason as deviceChip: a gateway in a lane must read
  // as the same object in a different place, not as a different kind of thing.
  const gatewayChip = (g) => {
    const isGwArch = g.is_archived
    const gwStatus = gatewayLiveStatus(g)
    return (
      <span
        key={g.gateway_id}
        className="chip chip-gw"
        title={`Gateway ${g.gateway_name} [${g.gateway_id}] ${g.is_virtual ? '(Virtual Gateway)' : ''} ${isGwArch ? '(Archived)' : `(${gwStatus}, heartbeat ${formatHeartbeat(g.last_heartbeat)})`} — ${g.device_count} device(s) — Click to view on Gateways page`}
        onClick={() => onSelectGateway(g.gateway_id)}
        style={{ cursor: 'pointer', borderColor: isGwArch ? 'var(--warning)' : g.is_virtual ? 'var(--accent)' : undefined, opacity: isGwArch ? 0.75 : 1 }}
      >
        {/* THREE OUTCOMES, NOT TWO. A red dot on a gateway nobody has installed yet is a fault report
            on an unfinished task -- see the .badge-pending block in App.css. */}
        {isGwArch
          ? <IconArchive size={11} style={{ color: 'var(--warning-text)' }} />
          : <span className={`badge-dot ${
              gwStatus === 'ONLINE' ? 'badge-online'
                : gwStatus === 'PENDING_ENROLLMENT' ? 'badge-pending'
                  : gwStatus === 'AWAITING_BIRTH' ? 'badge-provisioned'
                    : 'badge-offline'}`} />}
        {/* Name only, same as the device chip. The per-gateway "N dev" that used to sit here went
            with the UUIDs: the tile header already totals GW and Dev for the whole zone, and the
            per-gateway figure is on this chip's title. The VIRTUAL and ARCHIVED badges are down to
            single flags for the same reason -- a bordered pill left no room for the name it
            describes. */}
        <span className="chip-name mono">{g.gateway_name}</span>
        {g.is_virtual && !isGwArch && <span className="chip-flag" style={{ color: 'var(--accent)' }} title="Virtual Gateway"><IconZap size={9} /></span>}
        {isGwArch && <span className="chip-flag" style={{ color: 'var(--warning-text)' }}>ARCH</span>}
      </span>
    )
  }

  /**
   * THE ONE TILE SHAPE, used by the derived lanes and the physical cells alike.
   *
   * They were separate blocks of near-identical JSX, which is how the lanes ended up with a
   * "DERIVED" badge and the cells with a Dashboard link but neither had the other's spacing. A
   * lane has to read as the same kind of object in a different place -- that is the whole premise
   * of dragging a device from one into the other -- so they now differ only in the props below.
   */
  const floorTile = ({ key, className, name, nameTitle, Icon, status, gateways, devices, counts, hint, onDrop, onNameClick, headerRight, empty, badge }) => {
    // Every tile is a drop target, so `key` doubles as the identity a pending drop is tracked
    // under -- there is no second id to invent.
    const pending = pendingZone !== null && pendingZone === key
    return (
    <div
      key={key}
      className={`shopfloor-zone${className ? ' ' + className : ''}${pending ? ' shopfloor-zone-pending' : ''}`}
      onDragOver={handleDragOver}
      onDrop={onDrop}
      // Replaces the hint outright while the write is outstanding: the resting hint invites a
      // drag ("Drag device node here to reassign"), which is the one thing this tile will not
      // accept right now.
      title={pending ? 'Saving this move…' : hint}
      aria-busy={pending || undefined}
    >
      <div className="zone-header">
        <span className={`tile-dot tile-dot-${status}`} title={STATUS_LABEL[status]} />
        <div
          className="zone-title"
          style={onNameClick ? { cursor: 'pointer' } : undefined}
          onClick={onNameClick}
        >
          {Icon && <Icon size={13} style={{ flexShrink: 0 }} />}
          {/* Titled as well as truncated -- a long cell name still outruns a ~296px tile
              and the ellipsis has to lead somewhere. Where the name is also a link, its title
              carries the destination too, so one hover answers both questions. */}
          <span className="zone-name" title={nameTitle || name}>{name}</span>
          {badge}
        </div>
        {headerRight || <span className="zone-counts" title={`${gateways.length} gateway(s), ${devices.length} device(s)`}>{counts}</span>}
      </div>

      <div className="zone-body">
        {gateways.length === 0 && devices.length === 0
          ? <div className="zone-empty">{empty}</div>
          : (
            <div className="zone-chips">
              {gateways.map(gatewayChip)}
              {devices.map(deviceChip)}
            </div>
          )}
      </div>
    </div>
    )
  }

  // Site-Wide first: it is infrastructure and its contents are stable, so it reads as context for
  // the queue beside it. Unassigned comes second because it is the thing to act on, and it sits
  // directly before the cells its contents are waiting to be filed into. Both are pinned to the
  // front of the grid by CSS `order` -- see .shopfloor-lane in App.css.
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
      className: 'shopfloor-lane shopfloor-lane-site',
      matchGateway: (g) => g.location_scope === SCOPE_SITE_WIDE,
      empty: 'No site-wide assets. Drop a BMS, AGV or ambient sensor here.',
      hint: 'A permanent home, not a queue. Facility-wide and mobile assets live here rather than being filed in an arbitrary bay.'
    },
    {
      key: SOURCE_UNASSIGNED,
      title: 'Unassigned',
      icon: IconShieldAlert,
      className: 'shopfloor-lane shopfloor-lane-queue',
      matchGateway: (g) => g.location_scope !== SCOPE_SITE_WIDE && !g.cell_id,
      // Empty here is a RESULT, not a state -- the queue has drained -- so it says so rather than
      // describing what could go in it. The tile no longer collapses to a single line to make the
      // point: in a grid of uniform tiles a half-height one leaves a hole in the row, and at
      // ~296px there is no longer enough height at stake to be worth it.
      empty: 'All clear — every asset resolves to a cell or is Site-Wide.',
      hint: 'A work queue, not a location. Drop a device here to clear the cell set on it; if its gateway serves a cell it will inherit that instead.'
    }
  ]

  const laneViews = LANES.map(lane => ({
    lane,
    devices: laneDevices[lane.key] || [],
    gateways: gwList.filter(lane.matchGateway)
  }))

  if (loading) return <div className="loading-wrap"><div className="spinner" /> Loading shopfloor overview…</div>

  const activeCellsCount = cells.filter(c => !c.is_archived).length
  const archivedCellsCount = cells.filter(c => c.is_archived).length

  // A gateway is only "online" while its heartbeat is fresh -- an edge node that stops
  // publishing never writes an OFFLINE status, it just goes quiet.
  const onlineGwCount = gwList.filter(g => !g.is_archived && isGatewayOnline(g)).length
  // AWAITING SETUP IS ITS OWN BUCKET, AND OFFLINE EXCLUDES IT -- for exactly the reason the
  // quarantine note below gives. A physical gateway sits in PENDING_ENROLLMENT from the moment it is
  // created until somebody carries its bundle to a machine, and in AWAITING_BIRTH until that machine
  // publishes. Counted as "offline" it reports a fault on every appliance still in its box, so
  // ordering four gateways on a Monday shows four faults on the overview.
  const pendingGwCount = gwList.filter(g => !g.is_archived && isGatewayPending(g)).length
  const offlineGwCount = gwList.filter(
    g => !g.is_archived && !isGatewayPending(g) && !isGatewayOnline(g)
  ).length
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
      {/* No page heading and no description paragraph. The top bar's active tab already names this
          page, and the paragraph that used to sit here cost 41px on every load to say what the
          stat cards and the map below state directly. */}
      {/* Every figure and every click target the three stat cards carried, in 48px instead of 154.
          The headline is "live / total" rather than a bare total: the question this bar answers
          from across a room is "is everything up?", which a total alone cannot answer. The
          breakdown the cards printed underneath moves onto each item's `title`. */}
      <div className="kpi-ribbon">
        <button
          className="kpi-item"
          onClick={() => onNavigateTab && onNavigateTab('cells')}
          title={`${activeCellsCount} active / ${stats.cells} total cell zones (${archivedCellsCount} archived). Click to view Cells.`}
        >
          <span className="kpi-label">Cells</span>
          <span className="kpi-value">{activeCellsCount}<span className="kpi-total">/{stats.cells}</span></span>
          <span className="kpi-unit">Active</span>
        </button>

        <button
          className="kpi-item"
          onClick={() => onNavigateTab && onNavigateTab('gateways')}
          title={`${onlineGwCount} online / ${pendingGwCount} awaiting setup / ${offlineGwCount} offline / ${archivedGwCount} archived, of ${stats.gateways} registered edge gateways. Click to view Gateways.`}
        >
          <span className="kpi-label">Gateways</span>
          <span className="kpi-value">{onlineGwCount}<span className="kpi-total">/{stats.gateways}</span></span>
          <span className="kpi-unit">Online</span>
        </button>

        {/*
          The separate "Pending Quarantine" card was folded in here. It reported the same
          device the Offline figure already counted, and quarantine is a sub-state of the
          device population rather than a population of its own.

          Losing the dedicated card must not lose the prominence, since quarantine is the one
          state on this page that requires an operator to act. The item therefore raises a
          warning treatment while any device is held: a coloured left bar and tint, plus an icon
          and the word "Quarantined" spelled out beside the figure. The icon and the word carry
          the meaning on their own, so the signal does not depend on colour alone.
        */}
        <button
          className={`kpi-item${quarantinedAssetsCount > 0 ? ' kpi-item-alert' : ''}`}
          onClick={() => onNavigateTab && onNavigateTab('devices')}
          title={quarantinedAssetsCount > 0
            ? `${quarantinedAssetsCount} device${quarantinedAssetsCount === 1 ? '' : 's'} awaiting zero-touch onboarding approval. ${onlineAssetsCount} online / ${offlineAssetsCount} offline / ${archivedAssetsCount} archived, of ${stats.assets}. Click to review the quarantine queue.`
            : `${onlineAssetsCount} online / ${offlineAssetsCount} offline / ${archivedAssetsCount} archived, of ${stats.assets} registered shopfloor devices. Click to view Devices.`}
        >
          <span className="kpi-label">Devices</span>
          <span className="kpi-value">{onlineAssetsCount}<span className="kpi-total">/{stats.assets}</span></span>
          <span className="kpi-unit">Online</span>
          {quarantinedAssetsCount > 0 && (
            <span className="kpi-alert-flag">
              <IconShieldAlert size={12} aria-hidden="true" />
              {quarantinedAssetsCount} Quarantined
            </span>
          )}
        </button>
      </div>

      <div className="shopfloor-map-card">
        <div className="shopfloor-map-bg">
          <div className="shopfloor-header">
            <div className="shopfloor-title">
              <IconMap size={18} />
              <span>Shopfloor Dashboard</span>
            </div>
            {/* The legend now describes the TILE DOTS, which are new and are the only thing a
                reader has to decode to scan the grid. It used to describe the chips, whose
                meaning is on each chip's own `title` and in its icon -- and one of its four
                entries ("Amber: Archived") did not match what amber meant on a chip anyway. */}
            <div className="shopfloor-legend">
              <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }} title={STATUS_LABEL.normal}><span className="tile-dot tile-dot-normal" /> Online</span>
              {/* "Needs attention", not "Quarantined". This is a TILE state, and the tile is
                  reporting that something inside it wants a decision -- which today is only ever a
                  quarantined device, but the label should describe the dot rather than enumerate
                  today's one cause. The title says which. */}
              <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }} title={STATUS_LABEL.attention}><span className="tile-dot tile-dot-attention" /> Needs attention</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }} title={STATUS_LABEL.idle}><span className="tile-dot tile-dot-idle" /> Nothing live</span>
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

          {/* ONE GRID. The derived lanes are its first two tiles, pinned there by CSS `order`
              (see .shopfloor-lane) so they cannot drift as cells are added -- which is the
              guarantee the separate full-width stack above the grid used to buy, at the cost of a
              section label and a row of its own.

              Each lane holds BOTH gateways and devices. A gateway with no cell is exactly as
              stranded as a device with no cell -- and it is usually the CAUSE of the devices
              beside it being stranded, since they had nothing to inherit. Showing only the
              devices left the reason off-screen. */}
          <div className="shopfloor-grid">
            {cells.length === 0 && laneViews.every(v => v.gateways.length === 0 && v.devices.length === 0) && (
              <div className="empty-state" style={{ gridColumn: '1 / -1' }}>
                <div className="empty-icon"><IconFactory size={36} /></div>
                <div className="empty-text">No active cells configured to display on the shopfloor blueprint.</div>
              </div>
            )}

            {laneViews.map(({ lane, devices: laneAssets, gateways: laneGateways }) => floorTile({
              key: lane.key,
              className: lane.className,
              name: lane.title,
              Icon: lane.icon,
              // A lane's dot reports the health of what is PARKED in it, exactly as a cell's does.
              // An Unassigned device in alarm is still in alarm.
              status: rollupStatus(laneAssets),
              gateways: laneGateways,
              devices: laneAssets,
              counts: `GW: ${laneGateways.length} | Dev: ${laneAssets.length}`,
              hint: lane.hint,
              onDrop: (e) => handleLaneDrop(e, lane.key),
              empty: lane.empty,
              // THE "DERIVED" BADGE IS GONE FROM THE TILE, and the word moved onto the name's
              // title instead. It was a `flex-shrink: 0` element sharing a narrow header with the
              // name, so it took its width first and left "Site-Wide" and "Unassigned" rendering
              // as "S..." and "U..." -- a badge explaining what a tile is, at the cost of the
              // tile's name. The colour and the border now carry "not a cell" on their own.
              nameTitle: `${lane.title} — a derived lane, not a cell: it has no record in the database`
            }))}

            {cells.map(c => {
              // Cells own gateways; gateways own devices. Deriving the gateway list
              // from the devices instead hid every gateway that has no device yet.
              const cellGateways = gwList.filter(g => g.cell_id === c.cell_id)
              // Devices that RESOLVE to this cell, grouped from the list this page already
              // loads. /api/v1/cells no longer returns them -- on a 3s poll, having that
              // endpoint fetch the device table as well meant reading it twice a tick.
              const cellAssets = devicesByCell.get(c.cell_id) || []

              return floorTile({
                key: c.cell_id,
                // `shopfloor-cell` marks the physical bays apart from the two derived lanes now
                // that they share one grid -- it is what "every tile except the lanes" selects on,
                // in CSS and in the tests.
                className: `shopfloor-cell${c.is_archived ? ' shopfloor-zone-archived' : ''}`,
                name: c.cell_name,
                nameTitle: `Cell '${c.cell_name}' (Zone #${c.cell_id}) — Click to view on Cells page`,
                // Per-cell now rather than one glyph for every zone: a floor of six identical
                // rectangles is read name-by-name, which is the thing a map is meant to avoid.
                // Falls back to the default for an icon this build does not know -- see
                // utils/cellIcon.jsx.
                Icon: cellIconComponent(c.icon),
                status: rollupStatus(cellAssets),
                gateways: cellGateways,
                devices: cellAssets,
                counts: `GW: ${cellGateways.length} | Dev: ${cellAssets.length}`,
                hint: c.is_archived
                  ? `Cell Zone #${c.cell_id} (Archived / Out of Commission)`
                  : `Cell Zone #${c.cell_id}: Drag device node here to reassign`,
                onDrop: (e) => handleDrop(e, c.cell_id),
                // Hands the cell's id over so the Cells page arrives filtered to it. This used to
                // call onNavigateTab('cells'), which dropped the identity and landed on an
                // unfiltered list. onSelectCell mirrors onSelectDevice/onSelectGateway; it falls
                // back to a plain navigation so the tile still works if a caller wires only the
                // tab handler.
                onNameClick: () => onSelectCell ? onSelectCell(c.cell_id) : onNavigateTab && onNavigateTab('cells'),
                empty: canRearrange ? 'Drag & drop a device node here to assign.' : 'No gateways or devices in this cell zone.',
                badge: c.is_archived
                  ? <span className="chip-flag" style={{ color: 'var(--warning-text)' }} title="Shopfloor Cell zone archived">ARCH</span>
                  : null,
                // The Dashboard link displaces the count pair when a cell has one: it is the only
                // action a tile offers, and at this width there is room for one or the other. The
                // counts stay reachable on the tile's own `title`.
                headerRight: c.access_url ? (
                  <a
                    href={c.access_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-primary btn-sm"
                    style={{ textDecoration: 'none', gap: '3px', padding: '1px 6px', fontSize: '11px', flexShrink: 0 }}
                    title={`Open Cell Dashboard / Grafana UI — ${cellGateways.length} gateway(s), ${cellAssets.length} device(s)`}
                  >
                    <IconExternalLink size={10} /> Dash
                  </a>
                ) : null
              })
            })}
          </div>
        </div>
      </div>
    </>
  )
}
