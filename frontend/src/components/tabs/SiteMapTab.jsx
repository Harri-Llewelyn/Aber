import React, { useState, useCallback, useMemo, useEffect } from 'react'
import { alertIndex, alertForDevice } from '../../utils/deviceAlerts'
import { api } from '../../api'
import { REALTIME_ENABLED, STALENESS_TICK_MS, refreshInterval } from '../../constants'
import { usePolling } from '../../hooks/usePolling'
import { useRealtimeTable } from '../../hooks/useRealtimeTable'
import { useClockTick } from '../../hooks/useClockTick'
import { gatewayLiveStatus, formatHeartbeat } from '../../utils/gatewayStatus'
import { gatewayFleetCounts } from '../../utils/fleetCounts'
import { useSetting } from '../../hooks/useSettings'
import { HelpTip } from '../common/HelpTip'
import { CardHeading } from '../common/CardHeading'
import { Badge, ArchivedBadge } from '../common/Badge'
import { LoadingState } from '../common/LoadingState'
import { EmptyState } from '../common/EmptyState'
import { plural } from '../../utils/format'
import { ContextPanel } from '../common/ContextPanel'
import { AreaPlan, AreaPlanPin } from '../common/AreaPlan'
import {
  SCOPE_AREA_WIDE, SCOPE_SITE_WIDE, WIDE_SCOPES, SOURCE_UNASSIGNED, SOURCE_AREA_WIDE,
  SOURCE_SITE_WIDE, SOURCE_SIMULATED, groupDevicesByCell
} from '../../utils/cellResolution'
import { isPlaced, formatPlace } from '../../utils/areaPlans'
import { cellIconComponent } from '../../utils/cellIcon'
import { areaIconComponent } from '../../utils/areaIcon'
import {
  DEVICE_STATUS,
  deviceLifecycleStatus,
  deviceChipClass,
  deviceStatusTitle,
  deviceDotColor,
  rollupDeviceStatus
} from '../../utils/deviceStatus'
import {
  IconMap,
  IconLayoutDashboard,
  IconChevronRight,
  IconArchive,
  IconExternalLink,
  IconShieldAlert,
  IconBot,
  IconAlertTriangle,
  IconAlertCircle,
  IconZap,
  IconRadio,
  IconCpu
} from '../common/Icons'

/**
 * How wide the grid runs and how big a pin is drawn on it: one area takes the width, two split it,
 * and three or more settle on thirds. The pin scales with the tile because this is the only view
 * of the map -- at the narrowest tile a pin is still above the 24px a pointer needs.
 */
const COLUMNS_FOR = (n) => Math.min(3, Math.max(1, n))
const PIN_SIZE = { 1: 44, 2: 36, 3: 28 }
const PIN_ICON = { 1: 20, 2: 16, 3: 12 }

/**
 * The Site Map, one card: the ISA-95 ladder and the legend, the three lanes that belong to no
 * area, then every area as its own plan with every one of its cells pinned on it. Read only:
 * assets are filed on their own pages, and cells are placed on the plan from the Cells page. One
 * context panel serves the lanes, the areas and the pins: whichever was clicked last.
 */
export function SiteMapTab({ onSelectDevice, onSelectGateway, onSelectCell, onSelectArea, showToast, onNavigateTab, activeAlerts = [] }) {
  const [cells, setCells]     = useState([])
  const [areas, setAreas]     = useState([])
  const [gwList, setGwList]   = useState([])
  const [assets, setAssets]   = useState([])
  const [loading, setLoading] = useState(true)

  const loadAll = useCallback(async (signal) => {
    try {
      const [c, g, a, ar] = await Promise.all([
        api.get('/api/v1/cells', { signal }),
        api.get('/api/v1/gateways', { signal }),
        api.get('/api/v1/devices', { signal }),
        // Tolerated: with no areas the map has nothing to draw and says so.
        api.get('/api/v1/areas', { signal }).catch(() => []),
      ])
      setCells(c); setGwList(g); setAssets(a); setAreas(ar)
      setLoading(false)
    } catch (err) {
      if (err.name !== 'AbortError') setLoading(false)
      throw err
    }
  }, [])

  // Reconciliation loop, not the primary refresh: Realtime carries the updates and this catches
  // whatever a dropped socket missed. Falls back to the poll when Realtime is off.
  usePolling(loadAll, refreshInterval())
  useRealtimeTable(['cells', 'gateways', 'devices', 'areas'], loadAll, { enabled: REALTIME_ENABLED })
  // Renders gatewayLiveStatus() too, so it needs the same wall-clock tick as GatewaysTab.
  useClockTick(STALENESS_TICK_MS)

  // The ISA-95 site, one setting. Empty until an administrator names it.
  const siteName = useSetting('site.name', '')
  const sparkplugGroup = useSetting('sparkplug.group_id', '')

  /**
   * What the panel shows: a lane by key, an area by id, or a cell by id. Ids rather than objects
   * because this page polls, and an object would go stale. Choosing one clears the others: there
   * is one panel.
   */
  const [openLane, setOpenLane] = useState(null)
  const [selectedCellId, setSelectedCellId] = useState(null)
  const [selectedAreaId, setSelectedAreaId] = useState(null)
  const selectedCell = cells.find(c => c.cell_id === selectedCellId) || null
  const selectedArea = areas.find(a => a.area_id === selectedAreaId) || null
  useEffect(() => {
    if (selectedCellId && !selectedCell) setSelectedCellId(null)
  }, [selectedCellId, selectedCell])
  useEffect(() => {
    if (selectedAreaId && !selectedArea) setSelectedAreaId(null)
  }, [selectedAreaId, selectedArea])
  const toggleCell = (cellId) => {
    setOpenLane(null); setSelectedAreaId(null)
    setSelectedCellId(id => id === cellId ? null : cellId)
  }
  const toggleArea = (areaId) => {
    setOpenLane(null); setSelectedCellId(null)
    setSelectedAreaId(id => id === areaId ? null : areaId)
  }
  const toggleLane = (key) => {
    setSelectedCellId(null); setSelectedAreaId(null)
    setOpenLane(open => open === key ? null : key)
  }
  const closePanel = () => { setOpenLane(null); setSelectedCellId(null); setSelectedAreaId(null) }

  // Cell membership, resolved from the device list this page already holds.
  const devicesByCell = useMemo(() => groupDevicesByCell(assets), [assets])
  const alerts = useMemo(() => alertIndex(activeAlerts), [activeAlerts])

  // The derived lanes that belong to no area. None is a row in `cells`: Unassigned is the absence
  // of a decision, Site-Wide an assertion, Simulated a fact about the gateway. Replay lanes are not
  // here: a replay is not now.
  const laneDevices = useMemo(() => ({
    [SOURCE_UNASSIGNED]: assets.filter(a => a.location_source === SOURCE_UNASSIGNED),
    [SOURCE_SITE_WIDE]: assets.filter(a => a.location_source === SOURCE_SITE_WIDE),
    [SOURCE_SIMULATED]: assets.filter(a => a.location_source === SOURCE_SIMULATED)
  }), [assets])

  const STATUS_LABEL = {
    attention: 'Needs attention — a device here is quarantined, waiting to be admitted',
    normal: 'Normal — at least one device here is online',
    idle: 'Nothing live — no device here is currently reporting',
    // Says who raised it: the map relays a Grafana verdict and evaluates no threshold of its own.
    alert: 'Alert firing — Grafana has raised an alert against a device here'
  }
  const STATUS_WORD = { attention: 'Needs attention', normal: 'Online', idle: 'Nothing live', alert: 'Alert firing' }

  /** The pin state of a set of devices: the connectivity rollup, or alert when Grafana says so. */
  const stateOf = (devices) => {
    const alert = devices.some(d => !d.is_archived && alertForDevice(alerts, d))
    const status = rollupDeviceStatus(devices)
    return { status, alert, pin: alert ? 'alert' : status }
  }

  const cellGatewaysOf = (cell) => gwList.filter(g => g.cell_id === cell.cell_id)
  const cellDevicesOf = (cell) => devicesByCell.get(cell.cell_id) || []
  const areaWideOf = (area) => ({
    devices: assets.filter(a => a.location_source === SOURCE_AREA_WIDE && a.effective_area_id === area.area_id),
    gateways: gwList.filter(g => !g.is_simulated && !g.is_shadow && g.location_scope === SCOPE_AREA_WIDE && g.area_id === area.area_id)
  })
  const cellsOf = (area) => cells.filter(c => c.area_id === area.area_id && !c.is_archived)

  const deviceChip = (a) => {
    const status = deviceLifecycleStatus(a)
    const isArch = a.is_archived
    const alert = alertForDevice(alerts, a)
    return (
      <span
        key={a.asset_id}
        className={`chip ${deviceChipClass(a, alert)}`}
        onClick={() => onSelectDevice?.(a.asset_id)}
        style={{ cursor: 'pointer', userSelect: 'none', opacity: isArch ? 0.7 : 1 }}
        title={`${a.asset_name} [${a.asset_id}] — ${isArch ? 'Device Archived' : alert ? `ALERT: ${alert.alert_name}${alert.summary ? ` — ${alert.summary}` : ''}` : deviceStatusTitle(status)} — Click to view on Devices page`}
      >
        {isArch ? <IconArchive size={11} /> : <IconCpu size={11} />}
        <span className="chip-name">{a.asset_name}</span>
        {isArch && <span className="chip-flag" style={{ color: 'var(--warning-text)' }}>ARCH</span>}
        {!isArch && status === DEVICE_STATUS.QUARANTINED && (
          <span className="chip-flag" style={{ color: 'var(--warning-text)' }}>QUAR</span>
        )}
        {!isArch && status === DEVICE_STATUS.OFFLINE && (
          <span className="chip-flag" style={{ color: 'var(--text-muted)' }}>OFF</span>
        )}
        {/* An alert carries a flag as well as a hue: never colour alone. The glyph and wording are
            DevicesTab's, so a device does not answer to two names on two pages. */}
        {!isArch && alert && (
          <span
            className="chip-flag"
            style={{ color: 'var(--danger-text)', display: 'inline-flex', alignItems: 'center', gap: '3px' }}
            title={`${alert.alert_name}${alert.summary ? ` — ${alert.summary}` : ''} (raised by Grafana)`}
          >
            {alert.severity === 'critical'
              ? <><IconAlertCircle size={10} /> ALARM</>
              : <><IconAlertTriangle size={10} /> WARNING</>}
          </span>
        )}
      </span>
    )
  }

  const gatewayChip = (g) => {
    const isGwArch = g.is_archived
    const gwStatus = gatewayLiveStatus(g)
    return (
      <span
        key={g.gateway_id}
        className="chip chip-gw"
        title={`Gateway ${g.gateway_name} [${g.gateway_id}] ${g.deployment === 'host' ? '(Host-run gateway)' : ''} ${isGwArch ? '(Archived)' : `(${gwStatus}, heartbeat ${formatHeartbeat(g.last_heartbeat)})`} — ${g.device_count} device(s) — Click to view on Gateways page`}
        onClick={() => onSelectGateway?.(g.gateway_id)}
        style={{ cursor: 'pointer', borderColor: isGwArch ? 'var(--warning)' : g.deployment === 'host' ? 'var(--accent)' : undefined, opacity: isGwArch ? 0.75 : 1 }}
      >
        {/* Three outcomes, not two: a red dot on a gateway nobody has installed yet is a fault
            report on an unfinished task. */}
        {isGwArch
          ? <IconArchive size={11} style={{ color: 'var(--warning-text)' }} />
          : <span className={`badge-dot ${
              gwStatus === 'ONLINE' ? 'badge-online'
                : gwStatus === 'PENDING_ENROLLMENT' ? 'badge-pending'
                  : gwStatus === 'AWAITING_BIRTH' ? 'badge-provisioned'
                    : 'badge-danger'}`} />}
        <span className="chip-name mono">{g.gateway_name}</span>
        {g.deployment === 'host' && !isGwArch && <span className="chip-flag" style={{ color: 'var(--accent-text)' }} title="Runs on this host"><IconZap size={9} /></span>}
        {isGwArch && <span className="chip-flag" style={{ color: 'var(--warning-text)' }}>ARCH</span>}
      </span>
    )
  }

  /** A cell as a chip that selects it, for the cells with no place on the plan. */
  const cellChip = (c, note) => {
    const state = stateOf(cellDevicesOf(c))
    const Icon = cellIconComponent(c.icon)
    return (
      <button
        key={c.cell_id}
        type="button"
        className={`chip chip-link${selectedCellId === c.cell_id ? ' is-selected' : ''}`}
        onClick={() => toggleCell(c.cell_id)}
        title={`${c.cell_name} — ${STATUS_WORD[state.pin]} — ${note}`}
      >
        <span className="badge-dot" style={{ background: state.pin === 'alert' ? 'var(--danger)' : state.status === 'normal' ? 'var(--success)' : state.status === 'attention' ? 'var(--warning)' : 'var(--text-dim)' }} />
        <Icon size={11} />
        <span className="chip-name">{c.cell_name}</span>
      </button>
    )
  }

  // Site-Wide first as stable context, Simulated as what not to trust, Unassigned last as the
  // thing to act on. A gateway's lane is read from its own columns: gateways have no inheritance.
  // The class carries each lane's hue; the tints are the stylesheet's.
  const LANES = [
    {
      key: SOURCE_SITE_WIDE,
      title: 'Site-Wide',
      icon: IconMap,
      className: 'site-lane-site',
      matchGateway: (g) => !g.is_simulated && !g.is_shadow && g.location_scope === SCOPE_SITE_WIDE,
      empty: 'No Site-Wide assets.',
      hint: 'A permanent home, not a queue. Campus-wide and mobile assets live here rather than being filed in an arbitrary bay. Set on the Devices and Gateways pages.'
    },
    {
      key: SOURCE_SIMULATED,
      title: 'Simulated',
      icon: IconBot,
      className: 'site-lane-simulated',
      matchGateway: (g) => !g.is_shadow && g.is_simulated,
      empty: 'No simulated assets.',
      hint: 'Telemetry generated rather than observed — a simulator, or a broker playback target. Set on the gateway; its devices inherit it and cannot be filed into a cell.'
    },
    {
      key: SOURCE_UNASSIGNED,
      title: 'Unassigned',
      icon: IconShieldAlert,
      className: 'site-lane-queue',
      // Synthetic gateways are excluded: they cannot be given a cell. A wide scope is an answer, not
      // an absence: Area-Wide and Site-Wide gateways store no cell, so a bare `!g.cell_id` would
      // count a filed gateway here as well as under its area.
      matchGateway: (g) => !g.is_simulated && !g.is_shadow && !WIDE_SCOPES.has(g.location_scope) && !g.cell_id,
      empty: 'No unassigned assets.',
      hint: 'A work queue, not a location: nobody has said where these are. File each on the Devices or Gateways page, or mark it Site-Wide or Area-Wide.',
      queue: true
    }
  ]
  const laneViews = LANES.map(lane => ({
    lane,
    devices: laneDevices[lane.key] || [],
    gateways: gwList.filter(lane.matchGateway)
  }))
  const openLaneView = laneViews.find(v => v.lane.key === openLane) || null

  const gw = gatewayFleetCounts(gwList)
  // The ISA-95 enterprise is the `sparkplug.group_id` setting named at install. The gateways' own
  // groups answer only when the setting cannot be read; several are all named, and the playback
  // gateway is not a member of the plant.
  const enterprise = sparkplugGroup
    || [...new Set(gwList.filter(g => !g.is_shadow && g.sparkplug_group).map(g => g.sparkplug_group))].join(' / ')

  const unfiledCells = cells.filter(c => !c.area_id && !c.is_archived)
  const columns = COLUMNS_FOR(areas.length)

  /** A cell as a pin, or nothing when it has no place. */
  const cellPin = (c) => {
    if (!isPlaced(c)) return null
    const state = stateOf(cellDevicesOf(c))
    const gateways = cellGatewaysOf(c)
    const devices = cellDevicesOf(c)
    return (
      <AreaPlanPin
        key={c.cell_id}
        x={c.plan_x}
        y={c.plan_y}
        status={c.is_archived ? 'muted' : state.pin}
        Icon={c.is_archived ? IconArchive : cellIconComponent(c.icon)}
        label={c.cell_name}
        iconSize={PIN_ICON[columns]}
        selected={selectedCellId === c.cell_id}
        onClick={() => toggleCell(c.cell_id)}
        title={`${c.cell_name} — ${c.is_archived ? 'archived' : STATUS_WORD[state.pin]} — ${gateways.length} gateway(s), ${devices.length} device(s) — click for details`}
      />
    )
  }

  /**
   * One area, drawn as its plan with every cell it holds pinned on it. The whole card opens the
   * area's panel and each pin opens its cell's, so nothing is hidden behind a view you have to
   * enter. The card carries no role of its own: a role="button" around the name button and the
   * pins would be a lie to a screen reader, so the click is a shortcut to the name below it and
   * the keyboard still goes through the real controls.
   */
  const areaCard = (ar) => {
    const areaCells = cellsOf(ar)
    const unplaced = areaCells.filter(c => !isPlaced(c))
    const wide = areaWideOf(ar)
    const devices = [...areaCells.flatMap(cellDevicesOf), ...wide.devices]
    const gateways = [...areaCells.flatMap(cellGatewaysOf), ...wide.gateways]
    const state = stateOf(devices)
    const AreaGlyph = areaIconComponent(ar.icon)
    const wideCount = wide.gateways.length + wide.devices.length
    // Archived: drawn muted with its plan and its pins kept, as an archived cell's pin is.
    const archived = !!ar.is_archived
    return (
      <div
        key={ar.area_id}
        className={`area-card${state.alert ? ' area-card-alerting' : ''}${archived ? ' area-card-archived' : ''}${selectedAreaId === ar.area_id ? ' is-selected' : ''}`}
        data-area={ar.area_id}
        /* A pin stops its own click (AreaPlanPin), so a click that reaches here is the area's. */
        onClick={() => toggleArea(ar.area_id)}
      >
        <div className="area-card-header">
          {/* The one dot that goes red: an alert against a device here outranks the rollup. An
              archived area shows the archive glyph where the dot would be. */}
          {archived
            ? <IconArchive size={12} style={{ color: 'var(--warning-text)', flexShrink: 0 }} title="Archived" />
            : <span className={`tile-dot tile-dot-${state.pin}`} title={STATUS_LABEL[state.pin]} />}
          <AreaGlyph size={14} style={{ flexShrink: 0 }} />
          <button
            type="button"
            className="zone-name area-card-name"
            /* Stopped, or the card behind it toggles the panel straight back shut. */
            onClick={e => { e.stopPropagation(); toggleArea(ar.area_id) }}
            aria-pressed={selectedAreaId === ar.area_id}
            title={`${ar.area_name} — ${archived ? 'archived' : STATUS_WORD[state.pin]}. Click for its assets and its plan.`}
          >
            {ar.area_name}
          </button>
          {archived && <ArchivedBadge size="sm" title="Archived: its cells are still filed here and its topics are unchanged" />}
          {/* The area's description, only when it has one. */}
          {ar.description && (
            <HelpTip
              label={`About ${ar.area_name}`}
              text={ar.description}
              size={12}
            />
          )}
          {/* The Area-Wide tally is a breakdown, not an addition: the gateway and device figures
              beside it already include these. */}
          <span
            className="area-card-counts mono"
            title={`${areaCells.length} cell(s), ${gateways.length} gateway(s), ${devices.length} device(s)`
              + (wideCount > 0 ? `, of which ${wideCount} belong(s) to the area rather than to a cell in it` : '')}
          >
            {plural(areaCells.length, 'Cell')} · {plural(gateways.length, 'Gateway')} · {plural(devices.length, 'Device')}
            {wideCount > 0 && <> · <span className="area-card-wide">{wideCount} Area-Wide</span></>}
          </span>
        </div>
        <AreaPlan area={ar} title={`${ar.area_name}${ar.plan_path ? '' : ' — no plan uploaded'}`}>
          {areaCells.map(cellPin)}
        </AreaPlan>
        {/* A cell filed here that the plan does not draw: a job, not a tally, so it keeps its line. */}
        {unplaced.length > 0 && (
          <button
            type="button"
            className="area-card-aside"
            onClick={e => { e.stopPropagation(); toggleArea(ar.area_id) }}
            title={`Open ${ar.area_name} to see which cells have no place on the plan`}
          >
            <span className="area-card-aside-warn">{plural(unplaced.length, 'cell')} not placed</span>
          </button>
        )}
      </div>
    )
  }

  const selectedState = selectedCell ? stateOf(cellDevicesOf(selectedCell)) : null
  const selectedCellArea = selectedCell ? areas.find(a => a.area_id === selectedCell.area_id) : null
  const selectedAlerts = selectedCell
    ? cellDevicesOf(selectedCell).map(d => ({ device: d, alert: alertForDevice(alerts, d) })).filter(x => x.alert && !x.device.is_archived)
    : []

  /** The status badge of a drawer's subtitle: an alert firing outranks the connectivity rollup. */
  const stateBadge = (state, devices) => {
    const critical = state.alert && devices.some(d => !d.is_archived && alertForDevice(alerts, d)?.severity === 'critical')
    const tone = state.pin === 'alert' ? (critical ? 'danger' : 'warning') : state.status === 'normal' ? 'success' : 'neutral'
    return <Badge tone={tone} size="sm" title={STATUS_LABEL[state.pin]}>{STATUS_WORD[state.pin]}</Badge>
  }

  /** The panel's contents for the open lane: what it is, and its assets as chips. */
  const lanePanel = openLaneView ? (() => {
    const { lane, devices: laneAssets, gateways: laneGateways } = openLaneView
    return {
      type: 'LANE',
      title: lane.title,
      subtitle: (
        <>
          {stateBadge(stateOf(laneAssets), laneAssets)}
          <Badge size="sm">{plural(laneGateways.length, 'Gateway')} · {plural(laneAssets.length, 'Device')}</Badge>
        </>
      ),
      fields: [
        { label: 'What this lane holds', value: lane.hint, full: true },
        laneGateways.length === 0 && laneAssets.length === 0 && { label: 'Assets', value: lane.empty, full: true },
        laneGateways.length > 0 && {
          label: `Gateways (${laneGateways.length})`,
          value: <div className="context-device-list">{laneGateways.map(gatewayChip)}</div>,
          full: true,
          title: 'Click one to open it on the Gateways page'
        },
        laneAssets.length > 0 && {
          label: `Devices (${laneAssets.length})`,
          value: <div className="context-device-list">{laneAssets.map(deviceChip)}</div>,
          full: true,
          title: 'Click one to open it on the Devices page'
        }
      ].filter(Boolean),
      // Each action is offered only while the lane holds something to act on.
      actions: onNavigateTab ? [
        laneAssets.length > 0 && { label: 'Open Devices page', icon: <IconCpu size={13} />, onClick: () => onNavigateTab('devices'), title: `File these ${laneAssets.length} device(s) on the Devices page` },
        laneGateways.length > 0 && { label: 'Open Gateways page', icon: <IconRadio size={13} />, onClick: () => onNavigateTab('gateways'), title: `File these ${laneGateways.length} gateway(s) on the Gateways page` }
      ].filter(Boolean) : []
    }
  })() : null

  /** The panel's contents for the selected area: what it holds that the plan does not show. */
  const areaPanel = selectedArea ? (() => {
    const areaCells = cellsOf(selectedArea)
    const unplaced = areaCells.filter(c => !isPlaced(c))
    const wide = areaWideOf(selectedArea)
    const devices = [...areaCells.flatMap(cellDevicesOf), ...wide.devices]
    const gateways = [...areaCells.flatMap(cellGatewaysOf), ...wide.gateways]
    const state = stateOf(devices)
    return {
      type: 'AREA',
      title: selectedArea.area_name,
      subtitle: (
        <>
          {stateBadge(state, devices)}
          {/* The card's own tally, which a narrow card drops. */}
          <Badge size="sm">{plural(areaCells.length, 'Cell')} · {plural(gateways.length, 'Gateway')} · {plural(devices.length, 'Device')}</Badge>
        </>
      ),
      fields: [
        { label: 'Description', value: selectedArea.description || null, full: true },
        {
          label: 'Plan',
          value: selectedArea.plan_path
            ? 'An SVG plan is uploaded; cells with a place are pinned on it.'
            : 'No plan uploaded — the Site Map draws the default outline. Upload one from this area on the Areas page.',
          full: true
        },
        unplaced.length > 0 && {
          label: `Not placed (${unplaced.length})`,
          value: <div className="context-device-list">{unplaced.map(c => cellChip(c, 'no place on the plan yet; set one in Edit Details on the Cells page'))}</div>,
          full: true,
          title: 'Filed in this area, but with no place on its plan, so nothing pins them'
        },
        {
          label: 'Area-Wide assets',
          value: wide.gateways.length + wide.devices.length
            ? <div className="context-device-list">{wide.gateways.map(gatewayChip)}{wide.devices.map(deviceChip)}</div>
            : null,
          full: true,
          title: 'Assets that serve this whole area rather than one cell in it, such as its building management system. They have no place on a plan.'
        }
      ].filter(Boolean),
      actions: [
        {
          label: 'Open on Areas page', icon: <IconLayoutDashboard size={13} />,
          onClick: () => onSelectArea ? onSelectArea(selectedArea.area_id) : onNavigateTab?.('areas'),
          title: 'Edit this area, or upload its plan, on the Areas page'
        }
      ]
    }
  })() : null

  /** The panel's contents for the selected cell: where it is, and what resolves to it. */
  const cellPanel = {
    type: 'CELL',
    title: selectedCell?.cell_name || '',
    subtitle: selectedCell && (
      <>
        {stateBadge(selectedState, cellDevicesOf(selectedCell))}
        <Badge size="sm">{plural(cellGatewaysOf(selectedCell).length, 'Gateway')} · {plural(cellDevicesOf(selectedCell).length, 'Device')}</Badge>
        {selectedCell.is_archived && <ArchivedBadge size="sm" />}
      </>
    ),
    fields: selectedCell ? [
      {
        label: 'Where',
        value: selectedCellArea ? selectedCellArea.area_name : 'Unfiled — in no area yet',
        full: true,
        title: 'The area this cell is filed in, as set on the Cells page'
      },
      selectedCell.area_id && {
        label: 'Place on plan',
        value: formatPlace(selectedCell) || 'Not placed — set a place in Edit Details on the Cells page',
        full: true
      },
      { label: 'Description', value: selectedCell.description || null, full: true },
      selectedAlerts.length > 0 && {
        label: `Alerts firing (${selectedAlerts.length})`,
        value: (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {selectedAlerts.map(({ device, alert }) => (
              <div key={device.asset_id} style={{ fontSize: '12px' }}>
                <strong style={{ color: 'var(--danger-text)' }}>{alert.alert_name}</strong> — {device.asset_name}{alert.summary ? `: ${alert.summary}` : ''}
              </div>
            ))}
          </div>
        ),
        full: true,
        title: 'Raised by Grafana against devices in this cell'
      },
      {
        label: 'Gateways',
        value: cellGatewaysOf(selectedCell).length
          ? (
            <div className="context-device-list">
              {cellGatewaysOf(selectedCell).map(g => (
                <button key={g.gateway_id} className="chip chip-link chip-gw" onClick={() => onSelectGateway?.(g.gateway_id)} title={`Open ${g.gateway_name} on the Gateways page`}>
                  <IconRadio size={11} /><span className="chip-name">{g.gateway_name}</span>
                </button>
              ))}
            </div>
          )
          : null,
        full: true,
        title: 'Edge nodes serving this cell'
      },
      {
        label: cellDevicesOf(selectedCell).length
          ? `Devices (${cellDevicesOf(selectedCell).filter(a => a.status !== 'OFFLINE' && !a.is_archived).length}/${cellDevicesOf(selectedCell).length} online)`
          : 'Devices',
        value: cellDevicesOf(selectedCell).length
          ? (
            <div className="context-device-list">
              {cellDevicesOf(selectedCell).map(d => {
                const status = deviceLifecycleStatus(d)
                const alert = alertForDevice(alerts, d)
                return (
                  <button key={d.asset_id} className="chip chip-link" onClick={() => onSelectDevice?.(d.asset_id)} title={`Open ${d.asset_name} on the Devices page — ${alert ? `ALERT: ${alert.alert_name}` : deviceStatusTitle(status)}`}>
                    <span className="badge-dot" style={{ background: deviceDotColor(d, alert) }} />
                    <IconCpu size={11} />
                    <span className="chip-name">{d.asset_name}</span>
                    {!d.is_archived && alert && (
                      <span className="chip-flag" style={{ color: 'var(--danger-text)' }}>{alert.severity === 'critical' ? 'ALARM' : 'WARNING'}</span>
                    )}
                  </button>
                )
              })}
            </div>
          )
          : null,
        full: true,
        title: 'Devices that resolve to this cell: its gateways\' devices, plus any filed here explicitly'
      },
      { label: 'Dashboard URL', value: selectedCell.access_url || null, mono: true, copyable: true, full: true }
    ].filter(Boolean) : [],
    actions: selectedCell ? [
      selectedCell.access_url && {
        label: 'Open Dashboard', icon: <IconExternalLink size={13} />, href: selectedCell.access_url, primary: true,
        title: 'Open Cell Dashboard / Grafana UI'
      },
      {
        label: 'Open on Cells page', icon: <IconLayoutDashboard size={13} />,
        onClick: () => onSelectCell ? onSelectCell(selectedCell.cell_id) : onNavigateTab?.('cells'),
        title: 'Edit this cell, or place it on its area plan, on the Cells page'
      }
    ].filter(Boolean) : []
  }

  const panel = openLaneView ? lanePanel : selectedArea ? areaPanel : cellPanel

  return (
    <div className="page-layout">
      <div className="page-main">
        {/* One card: the ladder, the lanes, then the plans. The page scrolls, not the card: it is a
            map, not a list. */}
        <div className="card">
          <CardHeading
            icon={<IconMap size={15} />}
            title="Site Map"
            description="Every area drawn as its plan, with its cells pinned and coloured by device state; the lanes hold whatever belongs to no area."
            actions={(
              <>
                {/* The legend decodes the pin colours below and the tile dots in the lanes. */}
                <div className="shopfloor-legend">
                  <span title={STATUS_LABEL.normal}><span className="tile-dot tile-dot-normal" /> Online</span>
                  <span title={STATUS_LABEL.attention}><span className="tile-dot tile-dot-attention" /> Needs attention</span>
                  <span title={STATUS_LABEL.idle}><span className="tile-dot tile-dot-idle" /> Nothing live</span>
                  {/* A chip swatch, not a dot: an alert belongs to one device, and a pin turns red
                      for it while the dots roll up a whole tile. */}
                  <span title={STATUS_LABEL.alert}><span className="legend-chip legend-chip-danger" /> Alert firing</span>
                </div>
              </>
            )}
          />

          <div className="card-body site-map-body">
            {loading ? <LoadingState label="site map" /> : (
              <>
                {/* The rungs: enterprise, then site. */}
                <div className="site-hierarchy" role="group" aria-label="Hierarchy">
                  <div className="site-hierarchy-level" title="The ISA-95 enterprise: the Sparkplug group the gateways publish under">
                    <span className="site-hierarchy-label">Enterprise</span>
                    {enterprise
                      ? <span className="site-hierarchy-value">{enterprise}</span>
                      : <span className="site-hierarchy-unset">Not set — it is the Sparkplug group named at install (the sparkplug.group_id setting)</span>}
                  </div>
                  <IconChevronRight size={12} className="site-hierarchy-sep" aria-hidden="true" />
                  <div className="site-hierarchy-level" title="The ISA-95 site: this campus, named on the Settings page under Site">
                    <span className="site-hierarchy-label">Site</span>
                    {siteName
                      ? <span className="site-hierarchy-value">{siteName}</span>
                      : <span className="site-hierarchy-unset">Not set — name it on the Settings page under Site</span>}
                  </div>
                </div>

                {/* The lanes, three across, sharing the width; each opens into the panel. */}
                <div className="site-lanes" role="group" aria-label="Campus lanes">
                  {laneViews.map(({ lane, devices: laneAssets, gateways: laneGateways }) => {
                    const open = openLane === lane.key
                    const status = stateOf(laneAssets).status
                    const LaneIcon = lane.icon
                    const holds = laneAssets.length + laneGateways.length > 0
                    // A narrow card hides the name and the counts, so the button says them itself.
                    const tally = `${lane.title}: ${plural(laneGateways.length, 'gateway')}, ${plural(laneAssets.length, 'device')}`
                    return (
                      <button
                        key={lane.key}
                        type="button"
                        /* A lane wears its hue only while it holds something: an empty Unassigned
                           queue is the good state, so it keeps its outline and drops the fill. */
                        className={`site-lane ${lane.className}${holds ? '' : ' is-empty'}${open ? ' is-open' : ''}`}
                        onClick={() => toggleLane(lane.key)}
                        aria-pressed={open}
                        aria-label={tally}
                        title={`${tally}. ${lane.hint} ${open ? 'Click to close.' : 'Click to list its assets.'}`}
                      >
                        {/* No dot on an empty lane: grey next to zero says nothing. */}
                        {holds && <span className={`tile-dot tile-dot-${status}`} title={STATUS_LABEL[status]} />}
                        <LaneIcon size={13} style={{ flexShrink: 0 }} />
                        <span className="site-lane-name">{lane.title}</span>
                        <span className="site-lane-counts mono" title={`${plural(laneGateways.length, 'gateway')}, ${plural(laneAssets.length, 'device')}`}>
                          {plural(laneGateways.length, 'Gateway')} · {plural(laneAssets.length, 'Device')}
                        </span>
                      </button>
                    )
                  })}
                </div>

                {areas.length === 0 ? (
                  <EmptyState
                    icon={<IconMap size={36} />}
                    message={cells.length > 0
                      ? 'No areas yet. Add one on the Areas page and file the cells into it; each area is drawn as its own plan here.'
                      : laneViews.some(v => v.gateways.length > 0 || v.devices.length > 0)
                        ? 'No areas or cells configured — every asset resolves to one of the lanes above.'
                        : gw.shadow > 0
                          ? 'Nothing on the map yet. The only gateway on this stack is the playback gateway, which is not part of the fleet and is driven from the Capture page.'
                          : 'No areas or cells configured. Add an area on the Areas page to start the map.'}
                  />
                ) : (
                  <>
                    <div className="shopfloor-grid" style={{ '--map-columns': columns, '--pin-size': `${PIN_SIZE[columns]}px` }}>
                      {areas.map(areaCard)}
                    </div>
                    {unfiledCells.length > 0 && (
                      <div className="site-map-tray">
                        <div className="site-map-tray-group" data-tray="unfiled">
                          <span className="site-map-tray-title" title="Cells in no area yet; file them on the Areas page">
                            <IconShieldAlert size={12} /> Unfiled — in no area yet
                          </span>
                          <div className="context-device-list">
                            {unfiledCells.map(c => cellChip(c, 'in no area; file it on the Areas page'))}
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <ContextPanel
        open={!!(openLaneView || selectedArea || selectedCell)}
        onClose={closePanel}
        onCopy={showToast}
        {...panel}
      />
    </div>
  )
}
