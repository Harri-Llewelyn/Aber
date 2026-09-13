import React, { useState, useCallback, useMemo, useEffect, useLayoutEffect, useRef } from 'react'
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
import { ContextPanel } from '../common/ContextPanel'
import { FloorPlan, FloorPin } from '../common/FloorPlan'
import {
  SCOPE_AREA_WIDE, SCOPE_SITE_WIDE, SOURCE_UNASSIGNED, SOURCE_AREA_WIDE, SOURCE_SITE_WIDE,
  SOURCE_SIMULATED, groupDevicesByCell
} from '../../utils/cellResolution'
import { groundFloor, sortFloors, isPlaced, formatPlace } from '../../utils/floorPlans'
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
  IconChevronUp,
  IconChevronDown,
  IconArchive,
  IconExternalLink,
  IconShieldAlert,
  IconBot,
  IconAlertTriangle,
  IconAlertCircle,
  IconZap,
  IconCog,
  IconRadio,
  IconCpu,
  IconImage
} from '../common/Icons'

/**
 * The Site Map, one card: the ISA-95 ladder and the legend, the three lanes that belong to no
 * area, then the areas — every area as one of its floors in a thumbnail, or one area's floor plan
 * with its cells pinned on it. Read only: assets are filed on their own pages, and cells are placed
 * on the plan from the Cells page. One context panel serves the lanes and the pins: whichever was
 * clicked last.
 */
export function OverviewTab({ onSelectDevice, onSelectGateway, onSelectCell, showToast, hasPermission, onNavigateTab, activeAlerts = [] }) {
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
  useRealtimeTable(['cells', 'gateways', 'devices', 'areas', 'area_floors'], loadAll, { enabled: REALTIME_ENABLED })
  // Renders gatewayLiveStatus() too, so it needs the same wall-clock tick as GatewaysTab.
  useClockTick(STALENESS_TICK_MS)

  // The ISA-95 site, one setting. Empty until an administrator names it.
  const siteName = useSetting('site.name', '')

  /** Which area the map shows: '' is every area as thumbnails. */
  const [areaView, setAreaView] = useState('')
  // An area deleted underneath the view falls back to every area rather than to an empty map.
  useEffect(() => {
    if (areaView && !areas.some(ar => ar.area_id === areaView)) setAreaView('')
  }, [areas, areaView])
  const viewedArea = areas.find(ar => ar.area_id === areaView) || null

  /** The floor each thumbnail shows, by area id: the ground floor until stepped. */
  const [thumbFloors, setThumbFloors] = useState({})
  // Each selector's track is slid so its pressed floor sits in the middle of the strip. The strip
  // is clipped rather than scrollable, so this is the only thing that moves it.
  useEffect(() => {
    const centre = () => {
      document.querySelectorAll('.area-thumb-floors-scroll').forEach(strip => {
        const track = strip.querySelector('.area-thumb-floors-track')
        const pressed = strip.querySelector('[aria-pressed="true"]')
        if (!track || !pressed) return
        const shift = strip.clientWidth / 2 - (pressed.offsetLeft + pressed.offsetWidth / 2)
        track.style.transform = `translateX(${Math.round(shift)}px)`
      })
    }
    centre()
    window.addEventListener('resize', centre)
    return () => window.removeEventListener('resize', centre)
  }, [thumbFloors, areaView, areas])

  /** The floor shown in an area view: the ground floor until one is chosen. */
  const [floorChoice, setFloorChoice] = useState({ area: '', floor: '' })
  const viewedFloors = useMemo(() => sortFloors(viewedArea?.floors || []), [viewedArea])
  const viewedFloor = (floorChoice.area === areaView && viewedFloors.find(f => f.floor_id === floorChoice.floor))
    || groundFloor(viewedFloors)
  const chooseFloor = (floorId) => setFloorChoice({ area: areaView, floor: floorId })
  const stepFloor = (delta) => {
    if (!viewedFloor) return
    const at = viewedFloors.findIndex(f => f.floor_id === viewedFloor.floor_id)
    const next = viewedFloors[at - delta]
    if (next) chooseFloor(next.floor_id)
  }

  /** The plan's magnification in the area view: 1 fits the page. */
  const [zoom, setZoom] = useState(1)
  useEffect(() => { setZoom(1) }, [areaView])

  /**
   * The height the plan may take at zoom 1: the room left in the scrolling column below the
   * stage's top edge, so the whole page fits without scrolling. Measured, not guessed: the
   * Overview card above it varies with the hierarchy row and the lanes.
   */
  const stageRef = useRef(null)
  const [fitHeight, setFitHeight] = useState(null)
  useLayoutEffect(() => {
    const measure = () => {
      const el = stageRef.current
      if (!el) return
      const scroller = el.closest('.content')
      const card = el.closest('.shopfloor-map-card')
      const rect = el.getBoundingClientRect()
      const top = scroller
        ? rect.top - scroller.getBoundingClientRect().top + scroller.scrollTop
        : rect.top + window.scrollY
      const tail = (card ? card.getBoundingClientRect().bottom - rect.bottom : 0)
        + (scroller ? parseFloat(getComputedStyle(scroller).paddingBottom) || 0 : 0)
      const room = (scroller ? scroller.clientHeight : window.innerHeight) - top - tail
      setFitHeight(Math.max(240, Math.floor(room)))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [areaView, viewedFloor?.floor_id, areas.length])

  /**
   * What the panel shows: a lane by key, or a cell by id. Ids rather than objects because this
   * page polls, and an object would go stale. Choosing one clears the other: there is one panel.
   */
  const [openLane, setOpenLane] = useState(null)
  const [selectedCellId, setSelectedCellId] = useState(null)
  const selectedCell = cells.find(c => c.cell_id === selectedCellId) || null
  useEffect(() => {
    if (selectedCellId && !selectedCell) setSelectedCellId(null)
  }, [selectedCellId, selectedCell])
  const toggleCell = (cellId) => {
    setOpenLane(null)
    setSelectedCellId(id => id === cellId ? null : cellId)
  }
  const toggleLane = (key) => {
    setSelectedCellId(null)
    setOpenLane(open => open === key ? null : key)
  }
  const closePanel = () => { setOpenLane(null); setSelectedCellId(null) }

  // Cell membership, resolved from the device list this page already holds.
  const devicesByCell = useMemo(() => groupDevicesByCell(assets), [assets])
  const alerts = useMemo(() => alertIndex(activeAlerts), [activeAlerts])

  // The derived lanes that belong to no area. None is a row in `cells`: Unassigned is the absence
  // of a decision, Site-Wide an assertion, Simulated a fact about the gateway. Shadow is not here:
  // a replay is not now.
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
        title={`${a.asset_name} [${a.asset_id}] — ${isArch ? 'Device Archived (Out of Commission)' : alert ? `ALERT: ${alert.alert_name}${alert.summary ? ` — ${alert.summary}` : ''}` : deviceStatusTitle(status)} — Click to view on Devices page`}
      >
        {isArch ? <IconArchive size={11} /> : <IconCog size={11} />}
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
                    : 'badge-offline'}`} />}
        <span className="chip-name mono">{g.gateway_name}</span>
        {g.deployment === 'host' && !isGwArch && <span className="chip-flag" style={{ color: 'var(--accent)' }} title="Runs on this host"><IconZap size={9} /></span>}
        {isGwArch && <span className="chip-flag" style={{ color: 'var(--warning-text)' }}>ARCH</span>}
      </span>
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
      empty: 'No site-wide assets.',
      hint: 'A permanent home, not a queue. Campus-wide and mobile assets live here rather than being filed in an arbitrary bay. Set on the Devices and Gateways pages.'
    },
    {
      key: SOURCE_SIMULATED,
      title: 'Simulated',
      icon: IconBot,
      className: 'site-lane-simulated',
      matchGateway: (g) => !g.is_shadow && g.is_simulated,
      empty: 'No Simulated Assets.',
      hint: 'Telemetry generated rather than observed — a simulator, or a broker playback target. Set on the gateway; its devices inherit it and cannot be filed into a cell.'
    },
    {
      key: SOURCE_UNASSIGNED,
      title: 'Unassigned',
      icon: IconShieldAlert,
      className: 'site-lane-queue',
      // Synthetic gateways are excluded: `gateways_synthetic_has_no_cell` refuses every fix.
      matchGateway: (g) => !g.is_simulated && !g.is_shadow && g.location_scope !== SCOPE_SITE_WIDE && !g.cell_id,
      empty: 'No Unassigned Assets',
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

  if (loading) return <div className="loading-wrap"><div className="spinner" /> Loading overview…</div>

  const gw = gatewayFleetCounts(gwList)
  // The ISA-95 enterprise is the Sparkplug group the gateways publish under; several groups are
  // all named. The playback gateway is not a member of the plant.
  const enterprise = [...new Set(gwList.filter(g => !g.is_shadow && g.sparkplug_group).map(g => g.sparkplug_group))].join(' / ')

  const unfiledCells = cells.filter(c => !c.area_id && !c.is_archived)

  /** A cell as a pin, or nothing when it has no place. */
  const cellPin = (c, { small = false } = {}) => {
    if (!isPlaced(c)) return null
    const state = stateOf(cellDevicesOf(c))
    const gateways = cellGatewaysOf(c)
    const devices = cellDevicesOf(c)
    return (
      <FloorPin
        key={c.cell_id}
        x={c.plan_x}
        y={c.plan_y}
        status={c.is_archived ? 'muted' : state.pin}
        Icon={c.is_archived ? IconArchive : cellIconComponent(c.icon)}
        label={c.cell_name}
        small={small}
        selected={!small && selectedCellId === c.cell_id}
        onClick={small ? undefined : () => toggleCell(c.cell_id)}
        title={`${c.cell_name} — ${c.is_archived ? 'archived' : STATUS_WORD[state.pin]} — ${gateways.length} gateway(s), ${devices.length} device(s)${small ? '' : ' — click for details'}`}
      />
    )
  }

  /**
   * One area as a thumbnail of one of its floors, the ground floor until stepped, with its counts
   * and a status dot. Opening the area lands on the floor the thumbnail was showing.
   */
  const areaThumb = (ar) => {
    const floors = sortFloors(ar.floors || [])
    const shown = floors.find(f => f.floor_id === thumbFloors[ar.area_id]) || groundFloor(floors)
    const at = shown ? floors.findIndex(f => f.floor_id === shown.floor_id) : -1
    const areaCells = cells.filter(c => c.area_id === ar.area_id && !c.is_archived)
    const shownCells = shown ? areaCells.filter(c => c.floor_id === shown.floor_id) : []
    const wide = areaWideOf(ar)
    const devices = [...areaCells.flatMap(cellDevicesOf), ...wide.devices]
    const gateways = [...areaCells.flatMap(cellGatewaysOf), ...wide.gateways]
    const state = stateOf(devices)
    const AreaGlyph = areaIconComponent(ar.icon)
    const open = () => {
      if (shown) setFloorChoice({ area: ar.area_id, floor: shown.floor_id })
      setAreaView(ar.area_id)
    }
    // The selector's clicks are its own, not the thumbnail's: stopped before they open the area.
    const show = (e, floor) => {
      e.stopPropagation()
      if (floor) setThumbFloors(m => ({ ...m, [ar.area_id]: floor.floor_id }))
    }
    // A div with the button role, not a <button>: the small pins and the stepper inside are
    // buttons themselves, and a button may not contain another.
    return (
      <div
        key={ar.area_id}
        role="button"
        tabIndex={0}
        className={`area-thumb${state.alert ? ' area-thumb-alerting' : ''}`}
        onClick={open}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } }}
        aria-label={ar.area_name}
        title={`${ar.area_name} — ${STATUS_WORD[state.pin]} — ${floors.length} floor(s), ${areaCells.length} cell(s). Click to open its floor plans.`}
        data-area={ar.area_id}
      >
        <div className="area-thumb-header">
          {/* The one dot that goes red: an alert against a device here outranks the rollup. */}
          <span className={`tile-dot tile-dot-${state.pin}`} title={STATUS_LABEL[state.pin]} />
          <AreaGlyph size={14} style={{ flexShrink: 0 }} />
          <span className="zone-name">{ar.area_name}</span>
          <span className="area-thumb-counts mono" title={`${areaCells.length} cell(s), ${gateways.length} gateway(s), ${devices.length} device(s), Area-Wide included`}>
            {areaCells.length} cell{areaCells.length === 1 ? '' : 's'} · GW {gateways.length} · Dev {devices.length}
          </span>
        </div>
        <FloorPlan floor={shown} compact title={shown ? `${shown.name} of ${ar.area_name}` : `${ar.area_name} has no floors`}>
          {shownCells.map(c => cellPin(c, { small: true }))}
        </FloorPlan>
        <div className="area-thumb-footer">
          {/* The floors left to right from the lowest, so the right arrow goes up a floor. */}
          {shown ? (
            <span className="area-thumb-floors" role="group" aria-label={`Floor of ${ar.area_name}`}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={e => show(e, floors[at + 1])} disabled={at >= floors.length - 1} title="The floor below" aria-label="Floor below">
                <IconChevronRight size={12} style={{ transform: 'rotate(180deg)' }} />
              </button>
              {/* The floors scroll between the arrows when there are more than fit; the pressed one
                  is kept in view by the effect above. */}
              <span className="area-thumb-floors-scroll">
                <span className="area-thumb-floors-track">
                  {[...floors].reverse().map(f => (
                    <button
                      key={f.floor_id}
                      type="button"
                      className={`btn btn-sm ${f.floor_id === shown.floor_id ? 'btn-primary' : 'btn-ghost'}`}
                      onClick={e => show(e, f)}
                      aria-pressed={f.floor_id === shown.floor_id}
                      title={`${f.name} (level ${f.level})${f.plan_path ? '' : ' — default outline, no plan uploaded'}`}
                    >
                      <span className="floor-rail-level">{f.level}</span> {f.name}
                      {f.plan_path && <span className="floor-plan-flag" title="A plan is uploaded for this floor" aria-label="plan uploaded"><IconImage size={10} /></span>}
                    </button>
                  ))}
                </span>
              </span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={e => show(e, floors[at - 1])} disabled={at <= 0} title="The floor above" aria-label="Floor above">
                <IconChevronRight size={12} />
              </button>
            </span>
          ) : <span>No floors</span>}
        </div>
      </div>
    )
  }

  /** The tray under the floor rail: unplaced cells of this floor, cells on no floor, Area-Wide assets. */
  const areaTray = (ar, floor) => {
    const areaCells = cells.filter(c => c.area_id === ar.area_id && !c.is_archived)
    const unplaced = floor ? areaCells.filter(c => c.floor_id === floor.floor_id && !isPlaced(c)) : []
    const noFloor = areaCells.filter(c => !c.floor_id)
    const wide = areaWideOf(ar)
    const cellChip = (c) => {
      const state = stateOf(cellDevicesOf(c))
      const Icon = cellIconComponent(c.icon)
      return (
        <button
          key={c.cell_id}
          type="button"
          className={`chip chip-link${selectedCellId === c.cell_id ? ' is-selected' : ''}`}
          onClick={() => toggleCell(c.cell_id)}
          title={`${c.cell_name} — ${STATUS_WORD[state.pin]} — no place on the plan yet; set one in Edit Details on the Cells page`}
        >
          <span className="badge-dot" style={{ background: state.pin === 'alert' ? 'var(--danger)' : state.status === 'normal' ? 'var(--success)' : state.status === 'attention' ? 'var(--warning)' : 'var(--text-dim)' }} />
          <Icon size={11} />
          <span className="chip-name">{c.cell_name}</span>
        </button>
      )
    }
    return (
      <div className="site-map-tray">
        {unplaced.length > 0 && (
          <div className="site-map-tray-group" data-tray="unplaced">
            <span className="site-map-tray-title" title="On this floor, but with no place on its plan yet">
              <IconLayoutDashboard size={12} /> Not placed on {floor.name}
            </span>
            <div className="context-device-list">{unplaced.map(cellChip)}</div>
          </div>
        )}
        {noFloor.length > 0 && (
          <div className="site-map-tray-group" data-tray="no-floor">
            <span className="site-map-tray-title" title="Filed in this area, but on no floor of it">
              <IconLayoutDashboard size={12} /> On no floor
            </span>
            <div className="context-device-list">{noFloor.map(cellChip)}</div>
          </div>
        )}
        <div className="site-map-tray-group" data-tray="area-wide">
          <span className="site-map-tray-title" title="Assets that serve this whole area rather than one cell in it, such as its building management system. They have no place on a plan.">
            <IconMap size={12} /> Area-Wide — {ar.area_name}
          </span>
          {wide.gateways.length === 0 && wide.devices.length === 0
            ? <span className="zone-empty">No area-wide assets in {ar.area_name}.</span>
            : <div className="context-device-list">{wide.gateways.map(gatewayChip)}{wide.devices.map(deviceChip)}</div>}
        </div>
      </div>
    )
  }

  const selectedState = selectedCell ? stateOf(cellDevicesOf(selectedCell)) : null
  const selectedArea = selectedCell ? areas.find(a => a.area_id === selectedCell.area_id) : null
  const selectedFloor = selectedArea ? (selectedArea.floors || []).find(f => f.floor_id === selectedCell.floor_id) : null
  const selectedAlerts = selectedCell
    ? cellDevicesOf(selectedCell).map(d => ({ device: d, alert: alertForDevice(alerts, d) })).filter(x => x.alert && !x.device.is_archived)
    : []

  /** The panel's contents for the open lane: what it is, and its assets as chips. */
  const lanePanel = openLaneView ? (() => {
    const { lane, devices: laneAssets, gateways: laneGateways } = openLaneView
    const status = stateOf(laneAssets).status
    return {
      type: 'LANE',
      title: lane.title,
      subtitle: (
        <>
          <span className={`badge ${status === 'normal' ? 'badge-online' : 'badge-neutral'}`} style={{ fontSize: '11px' }} title={STATUS_LABEL[status]}>
            {STATUS_WORD[status]}
          </span>
          <span className="badge badge-neutral" style={{ fontSize: '11px' }}>
            GW: {laneGateways.length} · Dev: {laneAssets.length}
          </span>
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
      actions: onNavigateTab ? [
        { label: 'Open Devices page', icon: <IconCpu size={13} />, onClick: () => onNavigateTab('devices'), title: 'File devices on the Devices page' },
        { label: 'Open Gateways page', icon: <IconRadio size={13} />, onClick: () => onNavigateTab('gateways'), title: 'File gateways on the Gateways page' }
      ] : []
    }
  })() : null

  /** The panel's contents for the selected cell: where it is, and what resolves to it. */
  const cellPanel = {
    type: 'CELL',
    title: selectedCell?.cell_name || '',
    subtitle: selectedCell && (
      <>
        <span
          className={`badge ${selectedState.pin === 'alert' ? 'badge-warning' : selectedState.status === 'normal' ? 'badge-online' : 'badge-neutral'}`}
          style={selectedState.pin === 'alert' ? { color: 'var(--danger)', borderColor: 'var(--danger)', background: 'rgba(255, 77, 109, 0.15)' } : { fontSize: '11px' }}
          title={STATUS_LABEL[selectedState.pin]}
        >
          {STATUS_WORD[selectedState.pin]}
        </span>
        <span className="badge badge-neutral" style={{ fontSize: '11px' }}>
          GW: {cellGatewaysOf(selectedCell).length} · Dev: {cellDevicesOf(selectedCell).length}
        </span>
        {selectedCell.is_archived && <span className="badge badge-warning" style={{ fontSize: '11px' }}>ARCHIVED</span>}
      </>
    ),
    fields: selectedCell ? [
      {
        label: 'Where',
        value: selectedArea
          ? `${selectedArea.area_name}${selectedFloor ? ` · ${selectedFloor.name}` : ' · on no floor'}`
          : 'Unfiled — in no area yet',
        full: true,
        title: 'Area and floor, as filed on the Cells page'
      },
      selectedCell.floor_id && {
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
                <strong style={{ color: 'var(--danger)' }}>{alert.alert_name}</strong> — {device.asset_name}{alert.summary ? `: ${alert.summary}` : ''}
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
                      <span className="chip-flag" style={{ color: 'var(--danger)' }}>{alert.severity === 'critical' ? 'ALARM' : 'WARN'}</span>
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
        title: 'Edit this cell, or place it on its floor plan, on the Cells page'
      }
    ].filter(Boolean) : []
  }

  const allAreasButton = (
    <button className="btn btn-ghost btn-sm" onClick={() => setAreaView('')} title="Back to every area">
      <IconChevronRight size={13} style={{ transform: 'rotate(180deg)' }} /> All areas
    </button>
  )

  return (
    <div className="page-layout">
      <div className="page-main">
        {/* ---- One card: the ladder, the lanes, then the plans ---- */}
        <div className="shopfloor-map-card">
          <div className="shopfloor-map-bg">
            <div className="shopfloor-header">
              <div className="shopfloor-title">
                <IconMap size={18} />
                <span>Site Map</span>
                <HelpTip
                  label="About the site map"
                  text="The plant from the top: the enterprise and site the Unified Namespace publishes under, the lanes for what belongs to no area — site-wide, simulated, and anything still waiting to be placed — then every area drawn as one of its floors. Open an area to walk its floors; a cell is a pin on its floor's plan, coloured by the state of the devices that resolve to it, and a click opens its details. Cells with no place on the plan and the area's Area-Wide assets are listed beside it. Plans are uploaded per floor on the Areas page; a cell is placed from the Cells page."
                />
              </div>
              {/* The legend decodes the pin colours below and the tile dots in the lanes. */}
              <div className="shopfloor-legend">
                <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }} title={STATUS_LABEL.normal}><span className="tile-dot tile-dot-normal" /> Online</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }} title={STATUS_LABEL.attention}><span className="tile-dot tile-dot-attention" /> Needs attention</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }} title={STATUS_LABEL.idle}><span className="tile-dot tile-dot-idle" /> Nothing live</span>
                {/* A chip swatch, not a dot: an alert belongs to one device, and a pin turns red
                    for it while the dots roll up a whole tile. */}
                <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }} title={STATUS_LABEL.alert}><span className="legend-chip legend-chip-danger" /> Alert firing</span>
              </div>
            </div>

            {/* The rungs: enterprise, site, and the area when one is open. */}
            <div className="site-hierarchy" role="group" aria-label="Hierarchy">
              <div className="site-hierarchy-level" title="The ISA-95 enterprise: the Sparkplug group the gateways publish under">
                <span className="site-hierarchy-label">Enterprise</span>
                {enterprise
                  ? <span className="site-hierarchy-value">{enterprise}</span>
                  : <span className="site-hierarchy-unset">Not known yet — it is the Sparkplug group of the first enrolled gateway. The Playback lane does not count</span>}
              </div>
              <IconChevronRight size={12} className="site-hierarchy-sep" aria-hidden="true" />
              <div className="site-hierarchy-level" title="The ISA-95 site: this campus, named on the Settings page under Site">
                <span className="site-hierarchy-label">Site</span>
                {siteName
                  ? <span className="site-hierarchy-value">{siteName}</span>
                  : <span className="site-hierarchy-unset">Not set — name it on the Settings page under Site</span>}
              </div>
              {viewedArea && (
                <>
                  <IconChevronRight size={12} className="site-hierarchy-sep" aria-hidden="true" />
                  <div className="site-hierarchy-level" title="The ISA-95 area the Site Map is showing">
                    <span className="site-hierarchy-label">Area</span>
                    <span className="site-hierarchy-value">{viewedArea.area_name}</span>
                  </div>
                </>
              )}
            </div>

            {/* The lanes, three across, sharing the width; each opens into the panel. */}
            <div className="site-lanes" role="group" aria-label="Campus lanes">
              {laneViews.map(({ lane, devices: laneAssets, gateways: laneGateways }) => {
                const open = openLane === lane.key
                const status = stateOf(laneAssets).status
                const LaneIcon = lane.icon
                return (
                  <button
                    key={lane.key}
                    type="button"
                    className={`site-lane ${lane.className}${open ? ' is-open' : ''}`}
                    onClick={() => toggleLane(lane.key)}
                    aria-pressed={open}
                    title={`${lane.hint} ${open ? 'Click to close.' : 'Click to list its assets.'}`}
                  >
                    {/* No dot on an empty lane: grey next to zero says nothing, and its absence
                        lets a lane that holds something stand out. */}
                    {laneAssets.length + laneGateways.length > 0 && (
                      <span className={`tile-dot tile-dot-${status}`} title={STATUS_LABEL[status]} />
                    )}
                    <LaneIcon size={13} style={{ flexShrink: 0 }} />
                    <span className="site-lane-name">{lane.title}</span>
                    <span className="site-lane-counts mono" title={`${laneGateways.length} gateway(s), ${laneAssets.length} device(s)`}>
                      GW {laneGateways.length} · Dev {laneAssets.length}
                    </span>
                  </button>
                )
              })}
            </div>

            {areas.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon"><IconMap size={36} /></div>
                <div className="empty-text">
                  {cells.length > 0
                    ? 'No areas yet. Add one on the Areas page and file the cells into it; each area is drawn as its floor plans here.'
                    : laneViews.some(v => v.gateways.length > 0 || v.devices.length > 0)
                      ? 'No areas or cells configured — every asset resolves to one of the lanes above.'
                      : gw.shadow > 0
                        ? 'Nothing on the floor yet. The only gateway on this stack is the replay lane, which is not part of the fleet and is driven from the Capture page.'
                        : 'No areas or cells configured. Add an area on the Areas page to start the map.'}
                </div>
              </div>
            ) : !viewedArea ? (
              <>
                <div className="shopfloor-grid">
                  {areas.map(areaThumb)}
                </div>
                {unfiledCells.length > 0 && (
                  <div className="site-map-tray">
                    <div className="site-map-tray-group" data-tray="unfiled">
                      <span className="site-map-tray-title" title="Cells in no area yet; file them on the Areas page">
                        <IconShieldAlert size={12} /> Unfiled — in no area yet
                      </span>
                      <div className="context-device-list">
                        {unfiledCells.map(c => {
                          const Icon = cellIconComponent(c.icon)
                          return (
                            <button key={c.cell_id} type="button" className="chip chip-link" onClick={() => toggleCell(c.cell_id)} title={`${c.cell_name} — in no area; file it on the Areas page`}>
                              <Icon size={11} /><span className="chip-name">{c.cell_name}</span>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <>
                {viewedFloors.length === 0 ? (
                  <>
                    <div className="site-map-toolbar">{allAreasButton}</div>
                    <div className="empty-state">
                      <div className="empty-icon"><IconLayoutDashboard size={36} /></div>
                      <div className="empty-text">{viewedArea.area_name} has no floors. Add one from its details on the Areas page.</div>
                    </div>
                  </>
                ) : (
                  <div className="site-map-view">
                    <div className="site-map-side">
                      {/* The way back and the zoom, above the floors. The area's name is on the
                          hierarchy row; the floor is the pressed button below. */}
                      <div className="site-map-toolbar">
                        {allAreasButton}
                        <span style={{ display: 'inline-flex', gap: '4px' }} role="group" aria-label="Zoom">
                          <button className="btn btn-ghost btn-sm" onClick={() => setZoom(z => Math.max(1, Number((z - 0.25).toFixed(2))))} disabled={zoom <= 1} title="Zoom out" aria-label="Zoom out">−</button>
                          <button className="btn btn-ghost btn-sm" onClick={() => setZoom(1)} disabled={zoom === 1} title="Fit the plan to the page">Fit</button>
                          <button className="btn btn-ghost btn-sm" onClick={() => setZoom(z => Math.min(4, Number((z + 0.25).toFixed(2))))} disabled={zoom >= 4} title="Zoom in" aria-label="Zoom in">+</button>
                        </span>
                      </div>
                      <div className="floor-rail" role="group" aria-label="Floor">
                        <button className="btn btn-ghost btn-sm" onClick={() => stepFloor(1)} disabled={viewedFloors[0]?.floor_id === viewedFloor?.floor_id} title="The floor above" aria-label="Floor above">
                          <IconChevronUp size={13} />
                        </button>
                        {viewedFloors.map(f => (
                          <button
                            key={f.floor_id}
                            className={`btn btn-sm ${viewedFloor?.floor_id === f.floor_id ? 'btn-primary' : 'btn-ghost'}`}
                            onClick={() => chooseFloor(f.floor_id)}
                            aria-pressed={viewedFloor?.floor_id === f.floor_id}
                            title={`${f.name} (level ${f.level})${f.plan_path ? '' : ' — default outline, no plan uploaded'}`}
                          >
                            <span className="floor-rail-level">{f.level}</span> {f.name}
                            {f.plan_path && <span className="floor-plan-flag" title="A plan is uploaded for this floor" aria-label="plan uploaded"><IconImage size={10} /></span>}
                          </button>
                        ))}
                        <button className="btn btn-ghost btn-sm" onClick={() => stepFloor(-1)} disabled={viewedFloors[viewedFloors.length - 1]?.floor_id === viewedFloor?.floor_id} title="The floor below" aria-label="Floor below">
                          <IconChevronDown size={13} />
                        </button>
                      </div>
                      {areaTray(viewedArea, viewedFloor)}
                    </div>
                    {/* The plan fits the room below the stage at zoom 1; past that it scrolls. The
                        variables size the plan from the stylesheet, so the aspect stays the floor's. */}
                    <div
                      className="site-map-stage"
                      ref={stageRef}
                      style={{ '--map-fit-height': fitHeight ? `${fitHeight}px` : '72vh', '--map-zoom': zoom }}
                    >
                      <div className="site-map-stage-inner" style={{ width: `${zoom * 100}%` }}>
                        <FloorPlan floor={viewedFloor} title={`${viewedFloor.name} of ${viewedArea.area_name}`}>
                          {cells.filter(c => c.floor_id === viewedFloor.floor_id).map(c => cellPin(c))}
                        </FloorPlan>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <ContextPanel
        open={!!(openLaneView || selectedCell)}
        onClose={closePanel}
        onCopy={showToast}
        {...(openLaneView ? lanePanel : cellPanel)}
      />
    </div>
  )
}
