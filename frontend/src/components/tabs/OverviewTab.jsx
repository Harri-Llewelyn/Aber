import React, { useState, useCallback, useMemo, useEffect } from 'react'
import { alertIndex, alertForDevice } from '../../utils/deviceAlerts'
import { api } from '../../api'
import { PERMISSION_UUIDS, REALTIME_ENABLED, STALENESS_TICK_MS, refreshInterval } from '../../constants'
import { usePolling } from '../../hooks/usePolling'
import { useRealtimeTable } from '../../hooks/useRealtimeTable'
import { useClockTick } from '../../hooks/useClockTick'
import { gatewayLiveStatus, isGatewayOnline, isGatewayPending, formatHeartbeat } from '../../utils/gatewayStatus'
import { gatewayFleetCounts } from '../../utils/fleetCounts'
import { useSetting } from '../../hooks/useSettings'
import { HelpTip } from '../common/HelpTip'
import {
  SCOPE_CELL, SCOPE_AREA_WIDE, SCOPE_SITE_WIDE, SOURCE_UNASSIGNED, SOURCE_AREA_WIDE, SOURCE_SITE_WIDE,
  SOURCE_SIMULATED, groupDevicesByCell, groupCellsByFloor, applyStagedMoves
} from '../../utils/cellResolution'
import { cellIconComponent } from '../../utils/cellIcon'
import { areaIconComponent } from '../../utils/areaIcon'
import {
  DEVICE_STATUS,
  deviceLifecycleStatus,
  deviceStatusChipClass,
  deviceChipClass,
  deviceStatusTitle,
  rollupDeviceStatus
} from '../../utils/deviceStatus'
import {
  IconMap,
  IconLayoutDashboard,
  IconChevronRight,
  IconArchive,
  IconExternalLink,
  IconLock,
  IconPencil,
  IconShieldAlert,
  IconBot,
  IconAlertTriangle,
  IconAlertCircle,
  IconZap,
  IconCog
} from '../common/Icons'

export function OverviewTab({ onSelectDevice, onSelectGateway, onSelectCell, showToast, hasPermission, onNavigateTab, activeAlerts = [] }) {
  const [cells, setCells]     = useState([])
  const [areas, setAreas]     = useState([])
  const [gwList, setGwList]   = useState([])
  const [assets, setAssets]   = useState([])
  const [telemetry, setTelemetry] = useState([])
  const [loading, setLoading] = useState(true)

  const loadAll = useCallback(async (signal) => {
    try {
      // /api/v1/stats is not requested: the quarantine figure is derived from `assets`, which this
      // page already holds.
      const [c, g, a, t, ar] = await Promise.all([
        api.get('/api/v1/cells', { signal }),
        api.get('/api/v1/gateways', { signal }),
        api.get('/api/v1/devices', { signal }),
        // The map only needs the current value of each metric, not history -- and this
        // runs on a 3s poll, so it must stay bounded.
        api.get('/api/v1/telemetry/latest?minutes=60', { signal }).catch(() => []),
        // Tolerated: with no areas the map is the flat grid it always was.
        api.get('/api/v1/areas', { signal }).catch(() => []),
      ])
      setCells(c); setGwList(g); setAssets(a); setTelemetry(t); setAreas(ar)
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
  // Telemetry is absent: a postgres_fdw foreign table emits no Postgres changes, so its count
  // refreshes on the poll above.
  useRealtimeTable(['cells', 'gateways', 'devices'], loadAll, { enabled: REALTIME_ENABLED })
  // This page renders gatewayLiveStatus()/isGatewayOnline() too, so it needs the same
  // wall-clock tick as GatewaysTab to notice a gateway that has simply gone quiet.
  useClockTick(STALENESS_TICK_MS)

  const canManageDevice = hasPermission(PERMISSION_UUIDS.DEVICE_MANAGE)

  // The ISA-95 site, one setting (`site.name`, 0097). Empty until an administrator names it.
  const siteName = useSetting('site.name', '')

  /**
   * Which area the map shows: '' is every area, the flat grid grouped by area. A view is
   * a filter on the cells and on the Area-Wide lane; Site-Wide and Unassigned stay as context,
   * because an area's operator still wants the campus BMS and the queue.
   */
  const [areaView, setAreaView] = useState('')
  // An area deleted underneath the view falls back to every area rather than to an empty map.
  useEffect(() => {
    if (areaView && !areas.some(ar => ar.area_id === areaView)) setAreaView('')
  }, [areas, areaView])
  const viewedArea = areas.find(ar => ar.area_id === areaView) || null
  // The cycle: every area first, then each area in name order.
  const areaCycle = ['', ...areas.map(ar => ar.area_id)]
  const stepArea = (delta) => {
    const at = areaCycle.indexOf(areaView)
    setAreaView(areaCycle[(at + delta + areaCycle.length) % areaCycle.length])
  }
  const cellsById = useMemo(() => new Map(cells.map(c => [c.cell_id, c])), [cells])

  /**
   * Drag-and-drop is off until enabled, a second gate on top of the permission: this page is left
   * open on wall displays, and a slipped mouse would relocate an asset with no confirmation. A mode
   * rather than a confirm-on-drop, paid for once per editing session.
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
   * The moves an operator has made but not yet applied: device id to { cell_id, location_scope }.
   * Applied as one batch through `relocate_devices`, so a rearrangement is one transaction with one
   * `causation_id`. Keyed by device, because the RPC refuses a batch naming a device twice.
   */
  const [staged, setStaged] = useState(() => new Map())
  const [applying, setApplying] = useState(false)

  /**
   * The floor as it would look once applied. Every consumer below reads this rather than `assets`,
   * so a staged device moves the instant it is dropped; the `staged` flag keeps staged visibly
   * distinct from saved.
   */
  const stagedAssets = useMemo(
    () => applyStagedMoves(assets, gwList, staged, cellsById),
    [assets, gwList, staged, cellsById]
  )

  /**
   * Stage one move, or unstage it if it puts the device back where its committed row already has
   * it, so the batch never carries a move the RPC would report as unchanged.
   */
  const stageMove = useCallback((assetId, cellId, scope, areaId = null) => {
    setStaged(prev => {
      const next = new Map(prev)
      const committed = assets.find(a => a.asset_id === assetId)
      // `explicit_cell_id` first: `cell_id` on these rows is the device's own column, but the
      // view fields merged alongside it are the ones that survive a re-resolution.
      const wasCell = committed?.explicit_cell_id ?? committed?.cell_id ?? null
      const wasArea = committed?.explicit_area_id ?? committed?.area_id ?? null
      const wasScope = committed?.location_scope || SCOPE_CELL
      const nowCell = cellId || null
      const nowArea = areaId || null
      if (nowCell === wasCell && nowArea === wasArea && scope === wasScope) next.delete(assetId)
      else next.set(assetId, { cell_id: nowCell, area_id: nowArea, location_scope: scope })
      return next
    })
  }, [assets])

  const handleDrop = (e, targetCellId) => {
    e.preventDefault()
    if (!canRearrange) return
    // The drag event's dataTransfer is cleared once the handler yields, so this is read first
    // even though nothing here awaits any more.
    let assetData
    try {
      assetData = JSON.parse(e.dataTransfer.getData('application/json'))
    } catch (err) {
      showToast(err.message, 'error')
      return
    }

    // Where it currently resolves to, not its explicit override: a device inheriting the target
    // cell is already there. `assetData` comes off the staged view.
    if (assetData.effective_cell_id === targetCellId) return

    const targetCellName = cells.find(c => c.cell_id === targetCellId)?.cell_name || 'the target cell'

    // A move sets `devices.cell_id` directly. Dragging a machine across the floor says where it is,
    // not which connector reaches it, so the gateway is left alone.
    stageMove(assetData.asset_id, targetCellId, SCOPE_CELL)

    // Said at staging time, when the operator can still change their mind: the device will be
    // pinned to this cell and stop following its gateway.
    const servingGateway = gwList.find(g => g.gateway_id === assetData.active_gateway_id)
    const detached = servingGateway && servingGateway.cell_id && servingGateway.cell_id !== targetCellId
    showToast(
      detached
        ? `Staged: '${assetData.asset_name}' → '${targetCellName}' — it will stay there regardless of its gateway`
        : `Staged: '${assetData.asset_name}' → '${targetCellName}'`,
      'success'
    )
  }

  // Cell membership, resolved from the device list this page already holds. See
  // groupDevicesByCell() for why the cells endpoint does not supply this.
  const devicesByCell = useMemo(() => groupDevicesByCell(stagedAssets), [stagedAssets])

  // The derived lanes that belong to no area. None is a row in `cells`: Unassigned is the
  // absence of a decision, Site-Wide an assertion, Simulated a fact about the gateway. Area-Wide
  // is not here: it is one tile per area, in the grid beside that area's cells. Shadow is
  // not here either: this map answers what the plant is doing now, and a replay is not now; a
  // running playback is visible on the Capture page.
  const laneDevices = useMemo(() => ({
    [SOURCE_UNASSIGNED]: stagedAssets.filter(a => a.location_source === SOURCE_UNASSIGNED),
    [SOURCE_SITE_WIDE]: stagedAssets.filter(a => a.location_source === SOURCE_SITE_WIDE),
    [SOURCE_SIMULATED]: stagedAssets.filter(a => a.location_source === SOURCE_SIMULATED)
  }), [stagedAssets])

  /** The payload of a drop, or null with the error already shown. */
  const droppedAsset = (e) => {
    e.preventDefault()
    if (!canRearrange) return null
    try {
      return JSON.parse(e.dataTransfer.getData('application/json'))
    } catch (err) {
      showToast(err.message, 'error')
      return null
    }
  }

  /**
   * Drop onto an area's Area-Wide tile. An assertion that always takes: it sets the scope, names
   * the area the tile belongs to and clears the cell (`devices_area_wide_has_no_cell`,
   * `devices_area_wide_names_its_area`).
   */
  const handleAreaWideDrop = (e, area) => {
    const assetData = droppedAsset(e)
    if (!assetData) return
    if (assetData.location_source === SOURCE_AREA_WIDE && assetData.effective_area_id === area.area_id) return
    stageMove(assetData.asset_id, null, SCOPE_AREA_WIDE, area.area_id)
    showToast(`Staged: '${assetData.asset_name}' → Area-Wide in ${area.area_name} — it will belong to no single cell there`, 'success')
  }

  /**
   * Drop onto one of the campus lanes. Site-Wide is an assertion and always takes: it sets the
   * scope and clears the cell (`devices_site_wide_has_no_cell`). Unassigned is not settable: the
   * drop clears the explicit cell and reports where the device actually resolves, which may be
   * the inherited cell again.
   */
  const handleLaneDrop = (e, lane) => {
    const assetData = droppedAsset(e)
    if (!assetData) return

    if (assetData.location_source === lane) return

    const siteWide = lane === SOURCE_SITE_WIDE
    stageMove(assetData.asset_id, null, siteWide ? SCOPE_SITE_WIDE : SCOPE_CELL)

    if (siteWide) {
      showToast(`Staged: '${assetData.asset_name}' → Site-Wide — it will belong to no single cell`, 'success')
      return
    }

    // The spring-back is visible at the drop: staging re-runs the resolution locally, so a device
    // that re-inherits its gateway's cell lands back there immediately, and the message says why.
    const gateway = gwList.find(g => g.gateway_id === assetData.active_gateway_id)
    const inheritedName = gateway?.cell_id
      ? (cells.find(c => c.cell_id === gateway.cell_id)?.cell_name || 'its gateway\'s cell')
      : null

    showToast(
      inheritedName
        ? `Staged: cleared the explicit cell on '${assetData.asset_name}' — it inherits '${inheritedName}' from gateway '${gateway.gateway_name}'. To leave it unassigned, clear that gateway's cell or mark the device Site-Wide.`
        : `Staged: '${assetData.asset_name}' → Unassigned`,
      inheritedName ? 'warning' : 'success'
    )
  }

  /**
   * Apply the whole rearrangement as one RPC, so the thread records one act and a failure cannot
   * leave half the batch applied.
   */
  const applyStaged = async () => {
    if (staged.size === 0 || applying) return
    setApplying(true)
    try {
      const moves = [...staged.entries()].map(([device_id, move]) => ({ device_id, ...move }))
      const result = await api.relocateDevices(moves)
      // Cleared only AFTER the RPC resolves. Clearing optimistically would drop the operator's
      // work on a failed apply, which is the one outcome staging exists to prevent.
      setStaged(new Map())
      await loadAll()
      const unchanged = result.unchanged
        ? ` ${result.unchanged} move(s) changed nothing and were not recorded.`
        : ''
      showToast(
        `Applied ${result.applied} move(s) as one transaction — they share a single entry in the digital thread.${unchanged}`,
        'success'
      )
    } catch (err) {
      // The batch is left staged. It was refused in full, so the floor is exactly as it was and
      // the operator can fix the cause or discard.
      showToast(`${err.message} — no moves were applied; they are still staged.`, 'error')
    } finally {
      setApplying(false)
    }
  }

  const discardStaged = () => {
    if (staged.size === 0) return
    if (!window.confirm(`Discard ${staged.size} staged move(s)? The shopfloor returns to how it is saved.`)) return
    setStaged(new Map())
    showToast('Staged moves discarded — nothing was written.', 'success')
  }

  /**
   * Leaving the mode with work staged asks, because silently discarding is the one thing it must
   * not do.
   */
  const toggleRearrange = () => {
    if (rearranging && staged.size > 0) {
      if (!window.confirm(
        `${staged.size} staged move(s) have not been applied. Leave Rearrange mode and discard them?`
      )) return
      setStaged(new Map())
    }
    setRearranging(v => !v)
  }

  /**
   * A reload or a closed tab throws the staged batch away with nothing server-side to recover, so
   * the browser asks. In-app navigation keeps this component's state while the tab is mounted.
   */
  useEffect(() => {
    if (staged.size === 0) return undefined
    const warn = (e) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [staged.size])


  /**
   * The tile's health dot: the state of the devices resolving to it. It reports connectivity, not
   * process condition; metric thresholds are Grafana's job (see utils/deviceStatus.js).
   */
  const rollupStatus = useCallback((devices) => rollupDeviceStatus(devices), [])

  /**
   * Which devices Grafana has an alert firing on, indexed once per render rather than searched per
   * chip.
   */
  const alerts = useMemo(() => alertIndex(activeAlerts), [activeAlerts])

  const STATUS_LABEL = {
    attention: 'Needs attention — a device here is quarantined, waiting to be admitted',
    normal: 'Normal — at least one device here is online',
    idle: 'Nothing live — no device here is currently reporting',
    // Says who raised it: the map relays a Grafana verdict and evaluates no threshold of its own
    // (see deviceChipClass()).
    alert: 'Alert firing — Grafana has raised an alert against a device in this tile. The device '
      + 'chip turns red and is flagged ALARM or WARN'
  }

  // One renderer for cell cards and both lanes, so a device dragged out of Unassigned looks and
  // behaves like one already in a cell.
  const deviceChip = (a) => {
    const status = deviceLifecycleStatus(a)
    const isArch = a.is_archived
    // Archived reads as inert regardless of lifecycle state, and archived still wins over an alert:
    // an alert against something taken out of service is noise about a decision already made.
    const alert = alertForDevice(alerts, a)
    const colorCls = deviceChipClass(a, alert)
    const isOff = status !== DEVICE_STATUS.ONLINE
    const isInactive = isOff || isArch
    return (
      <span
        key={a.asset_id}
        className={`chip ${colorCls}`}
        draggable={canRearrange && !isInactive}
        onDragStart={(e) => handleDragStart(e, a)}
        onClick={() => onSelectDevice(a.asset_id)}
        style={{
          cursor: isInactive ? 'pointer' : canRearrange ? 'grab' : 'pointer',
          userSelect: 'none',
          opacity: isArch ? 0.7 : 1,
          // Staged must not look saved: a dashed outline reads as provisional, and colour on these
          // chips already means device status.
          ...(a.staged ? { outline: '1px dashed var(--accent)', outlineOffset: '1px' } : null)
        }}
        title={`${a.asset_name} [${a.asset_id}] — ${isArch ? 'Device Archived (Out of Commission)' : alert ? `ALERT: ${alert.alert_name}${alert.summary ? ` — ${alert.summary}` : ''}` : deviceStatusTitle(status)}${a.staged ? ' — STAGED: this move has not been applied yet' : ''} — ${canRearrange && !isInactive ? 'Drag to reassign Cell, or click' : 'Click'} to view on Devices page`}
      >
        {isArch ? <IconArchive size={11} /> : <IconCog size={11} />}
        {/* Name only. The full id is on the `title`. */}
        <span className="chip-name">{a.asset_name}</span>
        {a.staged && <span className="chip-flag" style={{ color: 'var(--accent)' }} title="Staged move — not applied yet">STAGED</span>}
        {isArch && <span className="chip-flag" style={{ color: 'var(--warning-text)' }}>ARCH</span>}
        {/* Quarantined and offline get different flags: only one of them is waiting on a decision. */}
        {!isArch && status === DEVICE_STATUS.QUARANTINED && (
          <span className="chip-flag" style={{ color: 'var(--warning-text)' }}>QUAR</span>
        )}
        {!isArch && status === DEVICE_STATUS.OFFLINE && (
          <span className="chip-flag" style={{ color: 'var(--text-muted)' }}>OFF</span>
        )}
        {/* An alert carries a flag as well as a hue, like every other chip state: never colour
            alone. Archived wins, matching deviceChipClass(). The glyph and wording are
            DevicesTab's, so a device does not answer to two names on two pages. */}
        {!isArch && alert && (
          <span
            className="chip-flag"
            style={{ color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', gap: '3px' }}
            title={`${alert.alert_name}${alert.summary ? ` — ${alert.summary}` : ''} (raised by Grafana)`}
          >
            {alert.severity === 'critical'
              ? <><IconAlertCircle size={10} /> ALARM</>
              : <><IconAlertTriangle size={10} /> WARN</>}
          </span>
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
        title={`Gateway ${g.gateway_name} [${g.gateway_id}] ${g.deployment === 'host' ? '(Host-run gateway)' : ''} ${isGwArch ? '(Archived)' : `(${gwStatus}, heartbeat ${formatHeartbeat(g.last_heartbeat)})`} — ${g.device_count} device(s) — Click to view on Gateways page`}
        onClick={() => onSelectGateway(g.gateway_id)}
        style={{ cursor: 'pointer', borderColor: isGwArch ? 'var(--warning)' : g.deployment === 'host' ? 'var(--accent)' : undefined, opacity: isGwArch ? 0.75 : 1 }}
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
        {/* Name only, like the device chip; the per-gateway count is on the title, and the tile
            header totals the zone. */}
        <span className="chip-name mono">{g.gateway_name}</span>
        {g.deployment === 'host' && !isGwArch && <span className="chip-flag" style={{ color: 'var(--accent)' }} title="Runs on this host"><IconZap size={9} /></span>}
        {isGwArch && <span className="chip-flag" style={{ color: 'var(--warning-text)' }}>ARCH</span>}
      </span>
    )
  }

  /**
   * The one tile shape, used by the derived lanes and the physical cells alike; they differ only in
   * the props below.
   */
  const floorTile = ({ key, className, name, nameTitle, description, Icon, status, gateways, devices, counts, hint, onDrop, onNameClick, headerRight, empty, badge }) => {
    // A tile is pending when something staged is sitting in it.
    const pending = devices.some(d => d.staged)
    // A tile with no onDrop must not accept dragover either: preventDefault() there is what tells
    // the browser the target is valid, and refusing shows a no-entry cursor before the operator
    // commits.
    const droppable = !!onDrop
    return (
    <div
      key={key}
      className={`shopfloor-zone${className ? ' ' + className : ''}${pending ? ' shopfloor-zone-pending' : ''}`}
      data-droppable={droppable ? 'true' : undefined}
      onDragOver={droppable ? handleDragOver : undefined}
      onDrop={onDrop}
      title={pending ? `${hint} — contains staged moves that have not been applied yet` : hint}
    >
      <div className="zone-header">
        <span className={`tile-dot tile-dot-${status}`} title={STATUS_LABEL[status]} />
        <div
          className="zone-title"
          style={onNameClick ? { cursor: 'pointer' } : undefined}
          onClick={onNameClick}
        >
          {Icon && <Icon size={13} style={{ flexShrink: 0 }} />}
          {/* Titled as well as truncated. Where the name is also a link, the title carries the
              destination. */}
          <span className="zone-name" title={nameTitle || name}>{name}</span>
          {/* A cell's description, read on demand beside its name; nothing when there is none. The
              click is stopped so opening the tip does not also open the Cells page. */}
          {description && (
            <span onClick={e => e.stopPropagation()}>
              <HelpTip label={`About ${name}`} text={description} size={12} />
            </span>
          )}
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

  // Site-Wide first as stable context, Unassigned second as the thing to act on; both pinned to the
  // front of the grid by CSS `order`. A gateway's lane is read from its own columns, since gateways
  // have no inheritance: Unassigned is cell-scoped with no cell yet, so it tests both fields.
  const LANES = [
    {
      key: SOURCE_SITE_WIDE,
      title: 'Site-Wide',
      icon: IconMap,
      className: 'shopfloor-lane shopfloor-lane-site',
      matchGateway: (g) => !g.is_simulated && !g.is_shadow && g.location_scope === SCOPE_SITE_WIDE,
      empty: 'No site-wide assets.',
      hint: 'A permanent home, not a queue. Campus-wide and mobile assets live here rather than being filed in an arbitrary bay.'
    },
    {
      // Context like Site-Wide rather than a queue, so it sits between the two: stable contents an
      // operator reads to know what NOT to trust, ahead of the queue they are meant to act on.
      key: SOURCE_SIMULATED,
      title: 'Simulated',
      icon: IconBot,
      className: 'shopfloor-lane shopfloor-lane-simulated',
      matchGateway: (g) => !g.is_shadow && g.is_simulated,
      // Not droppable: this lane is a statement about the gateway's provenance, not a location the
      // operator can assert.
      droppable: false,
      empty: 'No Simulated Assets.',
      hint: 'Telemetry generated rather than observed — a simulator, or a broker playback target. Set on the gateway; its devices inherit it and cannot be filed into a cell.'
    },
    {
      key: SOURCE_UNASSIGNED,
      title: 'Unassigned',
      icon: IconShieldAlert,
      className: 'shopfloor-lane shopfloor-lane-queue',
      // Synthetic gateways are excluded: they are cell-scoped with no cell, and
      // `gateways_synthetic_has_no_cell` refuses every suggested fix, so they would sit in a queue
      // that cannot drain.
      matchGateway: (g) => !g.is_simulated && !g.is_shadow
        && g.location_scope !== SCOPE_SITE_WIDE && !g.cell_id,
      // Empty here is a result, the queue has drained, so it says so. The tile keeps its full
      // height so the grid row has no hole.
      empty: 'No Unassigned Assets',
      hint: 'A work queue, not a location. Drop a device here to clear the cell set on it; if its gateway serves a cell it will inherit that instead.'
    }
  ]

  const laneViews = LANES.map(lane => ({
    lane,
    devices: laneDevices[lane.key] || [],
    gateways: gwList.filter(lane.matchGateway)
  }))

  /**
   * An area's Area-Wide tile: the first tile among that area's cells, in the grid rather
   * than in the lane row, because unlike the lanes it belongs to an area. One per area, so a
   * drop always knows which area it names; the tile shares the Site-Wide hue, being the
   * same kind of home one level down.
   */
  const areaWideTile = (ar) => {
    const assets = stagedAssets.filter(a => a.location_source === SOURCE_AREA_WIDE && a.effective_area_id === ar.area_id)
    const areaGateways = gwList.filter(g => !g.is_simulated && !g.is_shadow
      && g.location_scope === SCOPE_AREA_WIDE && g.area_id === ar.area_id)
    return floorTile({
      key: `area-wide:${ar.area_id}`,
      className: 'shopfloor-lane shopfloor-lane-area',
      name: `Area-Wide — ${ar.area_name}`,
      nameTitle: `Area-Wide in ${ar.area_name} — a derived lane, not a cell: assets that serve the whole area`,
      Icon: areaIconComponent(ar.icon),
      status: rollupStatus(assets),
      gateways: areaGateways,
      devices: assets,
      counts: `GW: ${areaGateways.length} | Dev: ${assets.length}`,
      hint: 'A permanent home one level below Site-Wide: assets that serve this whole area rather than one cell in it, such as its building management system.',
      onDrop: (e) => handleAreaWideDrop(e, ar),
      empty: `No area-wide assets in ${ar.area_name}.`
    })
  }

  if (loading) return <div className="loading-wrap"><div className="spinner" /> Loading shopfloor overview…</div>


  /**
   * The cell grid in sections. An area view is its floors, led by the area's Area-Wide
   * tile; the every-area view is one section per area, each led by its Area-Wide tile, with
   * unfiled cells last; a plant with no areas is the flat grid, one unlabelled section. Headings
   * span the grid row, so the tiles keep flowing as one grid. An area with no cells yet still
   * gets its section: its Area-Wide tile is where its BMS shows.
   */
  const visibleCells = areaView ? cells.filter(c => c.area_id === areaView) : cells
  const cellSections = areaView
    ? groupCellsByFloor(visibleCells).map(f => ({ key: `floor:${f.floor}`, label: f.label, cells: f.cells }))
    : areas.length > 0
      ? [
          ...areas.map(ar => ({ key: `area:${ar.area_id}`, label: ar.area_name, area: ar, cells: cells.filter(c => c.area_id === ar.area_id) })),
          ...(cells.some(c => !c.area_id)
            ? [{ key: 'area:none', label: 'Unfiled — in no area yet', cells: cells.filter(c => !c.area_id) }]
            : [])
        ]
      : [{ key: 'all', label: null, cells }]

  // The shadow lane is not part of the fleet; the rule and the returned `shadow` figure are in
  // fleetCounts.js. Only the shadow figure is read here: the fleet counts the ribbon used to print
  // are now the rail's signals (hooks/useNavSignals.js).
  const gw = gatewayFleetCounts(gwList)

  // The ISA-95 enterprise is the Sparkplug group the gateways publish under, which is already data;
  // several groups are all named. The playback gateway is not a member of the plant.
  const enterprise = [...new Set(gwList.filter(g => !g.is_shadow && g.sparkplug_group).map(g => g.sparkplug_group))].join(' / ')

  return (
    <>
      {/* No page heading or description: the rail names the page, and the map states the rest. */}
      <div className="shopfloor-map-card">
        <div className="shopfloor-map-bg">
          <div className="shopfloor-header">
            <div className="shopfloor-title">
              <IconMap size={18} />
              <span>Site Map</span>
              {/* The sentence that says what a tile is, read on demand; the legend decodes the
                  dots. */}
              <HelpTip
                label="About the site map"
                text="Every cell on the site, with the devices that resolve to it. A device sits in its own cell if it names one and in its gateway's otherwise, so this is where the two disagreeing becomes visible. The lanes at the top hold what belongs to no area — site-wide assets, simulated ones, and anything still waiting to be placed. Below them, each area's Area-Wide tile leads its cells."
              />
            </div>
            {/* The legend describes the tile dots, which are the only thing a reader has to decode
                to scan the grid; chip meanings are on each chip's `title`. */}
            <div className="shopfloor-legend">
              <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }} title={STATUS_LABEL.normal}><span className="tile-dot tile-dot-normal" /> Online</span>
              {/* Needs attention, not Quarantined: a tile state, described by the dot rather than
                  by today's one cause. The title says which. */}
              <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }} title={STATUS_LABEL.attention}><span className="tile-dot tile-dot-attention" /> Needs attention</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }} title={STATUS_LABEL.idle}><span className="tile-dot tile-dot-idle" /> Nothing live</span>
              {/* The fourth category is a chip, not a dot: the dots roll up connectivity for a
                  whole tile, and an alert belongs to one device inside it (rollupDeviceStatus() has
                  no alert input). */}
              <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }} title={STATUS_LABEL.alert}><span className="legend-chip legend-chip-danger" /> Alert firing</span>
              {canManageDevice ? (
                <button
                  className={`btn btn-sm ${rearranging ? 'btn-primary' : 'btn-ghost'}`}
                  style={{ marginLeft: '10px' }}
                  onClick={toggleRearrange}
                  aria-pressed={rearranging}
                  title={rearranging
                    ? 'Rearrange mode is ON — drag devices between cells and lanes. Moves are staged and applied together as one transaction. Click to finish.'
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

          {/* The rungs above the lanes, so the page shows the whole ISA-95 ladder: enterprise and
              site here, the areas and cells beneath. The site is the setting the Unified
              Namespace publishes under, and its absence is said rather than left blank. */}
          <div className="site-hierarchy" role="group" aria-label="Hierarchy">
            <div className="site-hierarchy-level" title="The ISA-95 enterprise: the Sparkplug group the gateways publish under">
              <span className="site-hierarchy-label">Enterprise</span>
              {enterprise
                ? <span className="site-hierarchy-value">{enterprise}</span>
                : <span className="site-hierarchy-unset">Not known yet — it is the Sparkplug group of the first gateway</span>}
            </div>
            <IconChevronRight size={12} className="site-hierarchy-sep" aria-hidden="true" />
            <div className="site-hierarchy-level" title="The ISA-95 site: this campus, named on the Settings page under Site">
              <span className="site-hierarchy-label">Site</span>
              {siteName
                ? <span className="site-hierarchy-value">{siteName}</span>
                : <span className="site-hierarchy-unset">Not set — name it on the Settings page under Site</span>}
            </div>
          </div>

          {/* Shown only while the mode is on, so the page carries no standing instruction about a
              gesture that is usually unavailable — and so it is obvious the map is live. */}
          {canRearrange && (
            <div style={{ marginBottom: '16px', fontSize: '11px', color: 'var(--warning-text)', background: 'rgba(255,179,0,0.08)', border: '1px solid var(--warning)', borderRadius: 'var(--radius-sm)', padding: '8px 12px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <IconPencil size={12} />
              {/* The count and the actions live in the banner that already says the map is live, so
                  there is one place to look. */}
              {staged.size === 0 ? (
                <span>
                  Drag a device onto a cell or lane to stage a move. Nothing is written until you apply.
                </span>
              ) : (
                <>
                  <span style={{ flex: 1, minWidth: '260px' }}>
                    <strong>{staged.size} staged move{staged.size === 1 ? '' : 's'}</strong> — not yet
                    written. Applying sends them as one transaction, so they share a single entry in
                    the digital thread.
                  </span>
                  <span style={{ display: 'flex', gap: '6px' }}>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={applyStaged}
                      disabled={applying}
                      title="Write every staged move in one transaction"
                    >
                      {applying ? 'Applying…' : `Apply ${staged.size} move${staged.size === 1 ? '' : 's'}`}
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={discardStaged}
                      disabled={applying}
                      title="Throw the staged moves away — nothing has been written"
                    >
                      Discard
                    </button>
                  </span>
                </>
              )}
            </div>
          )}

          {/* Two grids: the lanes are assets that belong to no area, so they get a row of their
              own above the area selector, and the plant reads as the grid beneath. Each lane
              holds gateways as well as devices, because a gateway with no cell is usually why its
              devices have none. */}
          <div className="shopfloor-lanes">
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
              onDrop: lane.droppable === false ? undefined : (e) => handleLaneDrop(e, lane.key),
              empty: lane.empty,
              // The word derived is on the name's title rather than a badge, which took the
              // header's width and truncated the name. The colour and border carry not a cell.
              nameTitle: `${lane.title} — a derived lane, not a cell: it has no record in the database`
            }))}
          </div>

          {/* The area selector, between the campus lanes and the areas they are not part
              of, and only once there is an area to select. Every area first, then one button
              per area; the arrows cycle through the same list. */}
          {areas.length > 0 && (
            <div className="shopfloor-areas" role="group" aria-label="Area">
              {/* The icon set has one chevron; the other is it turned round. */}
              <button className="btn btn-ghost btn-sm" onClick={() => stepArea(-1)} title="Previous area" aria-label="Previous area">
                <IconChevronRight size={13} style={{ transform: 'rotate(180deg)' }} />
              </button>
              <button
                className={`btn btn-sm ${areaView === '' ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setAreaView('')}
                aria-pressed={areaView === ''}
                title="Every area, grouped"
              >
                All areas
              </button>
              {areas.map(ar => {
                const AreaGlyph = areaIconComponent(ar.icon)
                return (
                  <button
                    key={ar.area_id}
                    className={`btn btn-sm ${areaView === ar.area_id ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => setAreaView(ar.area_id)}
                    aria-pressed={areaView === ar.area_id}
                    title={`Show only ${ar.area_name}, by floor`}
                  >
                    <AreaGlyph size={12} /> {ar.area_name}
                  </button>
                )
              })}
              <button className="btn btn-ghost btn-sm" onClick={() => stepArea(1)} title="Next area" aria-label="Next area">
                <IconChevronRight size={13} />
              </button>
            </div>
          )}

          {/* THE PLANT ITSELF, BELOW THE LANES. In an area view its Area-Wide tile leads, above
              the floors, since it belongs to the area and to no floor of it. */}
          <div className="shopfloor-grid">
            {viewedArea && areaWideTile(viewedArea)}

            {visibleCells.length === 0 && (
              /* An empty state of its own, since this grid can be empty while the lanes are full (a
                 stack running only the simulator has no cells). Three cases: assets in the lanes
                 above, nothing at all, or only the seeded Playback gateway, which matches no lane
                 and is named with the Capture page. */
              <div className="empty-state" style={{ gridColumn: '1 / -1' }}>
                <div className="empty-icon"><IconLayoutDashboard size={36} /></div>
                <div className="empty-text">
                  {viewedArea
                    ? `No cells filed in ${viewedArea.area_name} yet. File them on the Areas page.`
                    : laneViews.some(v => v.gateways.length > 0 || v.devices.length > 0)
                    ? 'No cell zones configured — every asset resolves to one of the lanes above.'
                    : gw.shadow > 0
                      ? 'Nothing on the floor yet. The only gateway on this stack is the replay '
                        + 'lane, which is not part of the fleet and is driven from the Capture page.'
                      : 'No active cells configured to display on the shopfloor blueprint.'}
                </div>
              </div>
            )}

            {cellSections.map(section => [
              section.label && (
                <div key={section.key} className="shopfloor-floor-heading" title={areaView ? 'Floor' : 'Area'}>
                  {section.label}
                </div>
              ),
              // An area's section opens with its Area-Wide tile, first beside its cells.
              section.area && areaWideTile(section.area),
              ...section.cells.map(c => {
              // Cells own gateways; gateways own devices. Deriving the gateway list
              // from the devices instead hid every gateway that has no device yet.
              const cellGateways = gwList.filter(g => g.cell_id === c.cell_id)
              // Devices that resolve to this cell, grouped from the list this page already loads.
              const cellAssets = devicesByCell.get(c.cell_id) || []

              return floorTile({
                key: c.cell_id,
                // `shopfloor-cell` marks the physical bays apart from the derived lanes, in CSS and
                // in the tests.
                className: `shopfloor-cell${c.is_archived ? ' shopfloor-zone-archived' : ''}`,
                name: c.cell_name,
                nameTitle: `Cell '${c.cell_name}' (Zone #${c.cell_id}) — Click to view on Cells page`,
                description: c.description,
                // Per-cell icon, falling back to the default for one this build does not know
                // (utils/cellIcon.jsx).
                Icon: cellIconComponent(c.icon),
                status: rollupStatus(cellAssets),
                gateways: cellGateways,
                devices: cellAssets,
                counts: `GW: ${cellGateways.length} | Dev: ${cellAssets.length}`,
                hint: c.is_archived
                  ? `Cell Zone #${c.cell_id} (Archived / Out of Commission)`
                  : `Cell Zone #${c.cell_id}: Drag device node here to reassign`,
                onDrop: (e) => handleDrop(e, c.cell_id),
                // Hands the cell's id over so the Cells page arrives filtered; falls back to a
                // plain navigation if only the tab handler is wired.
                onNameClick: () => onSelectCell ? onSelectCell(c.cell_id) : onNavigateTab && onNavigateTab('cells'),
                empty: canRearrange ? 'Drag & drop a device node here to assign.' : 'No gateways or devices in this cell zone.',
                badge: c.is_archived
                  ? <span className="chip-flag" style={{ color: 'var(--warning-text)' }} title="Shopfloor Cell zone archived">ARCH</span>
                  : null,
                // The Dashboard link displaces the count pair, which stays on the tile's `title`.
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
              })
            ])}
          </div>
        </div>
      </div>
    </>
  )
}
