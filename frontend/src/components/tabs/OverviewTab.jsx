import React, { useState, useCallback, useMemo, useEffect } from 'react'
import { alertIndex, alertForDevice } from '../../utils/deviceAlerts'
import { api } from '../../api'
import { PERMISSION_UUIDS, REALTIME_ENABLED, STALENESS_TICK_MS, refreshInterval } from '../../constants'
import { usePolling } from '../../hooks/usePolling'
import { useRealtimeTable } from '../../hooks/useRealtimeTable'
import { useClockTick } from '../../hooks/useClockTick'
import { gatewayLiveStatus, isGatewayOnline, isGatewayPending, formatHeartbeat } from '../../utils/gatewayStatus'
import { gatewayFleetCounts, deviceFleetCounts } from '../../utils/fleetCounts'
import {
  SCOPE_CELL, SCOPE_SITE_WIDE, SOURCE_UNASSIGNED, SOURCE_SITE_WIDE, SOURCE_SIMULATED, groupDevicesByCell,
  applyStagedMoves
} from '../../utils/cellResolution'
import { cellIconComponent } from '../../utils/cellIcon'
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
  IconFactory,
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
   * archived migration 0006 makes immutable. Those rows are not the problem and must not be suppressed: the
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
   * The moves an operator has made but not yet applied: device id -> { cell_id, location_scope }.
   *
   * REARRANGE MODE IS NOW A TRANSACTION, not just a mode. Every drop used to issue its own
   * `PUT /api/v1/devices/{id}` on mouse release, so reassigning six machines -- one decision,
   * taken once -- landed as six independent UPDATEs: six transactions, six `causation_id`s, six
   * rows in the Digital Thread that look like six unrelated acts. Staging them here and applying
   * the batch through `relocate_devices` (0033) makes it one transaction and therefore one
   * causation, which is exactly what the event drawer's "Same transaction" control exists to show.
   *
   * KEYED BY DEVICE, so dragging the same chip three times before applying collapses to one
   * entry rather than three conflicting instructions -- and the RPC refuses a batch naming a
   * device twice, so this is the guard rather than a convenience.
   */
  const [staged, setStaged] = useState(() => new Map())
  const [applying, setApplying] = useState(false)

  /**
   * The floor as it would look once applied.
   *
   * Every consumer below -- the cell buckets, both lanes, the tile dots -- reads this rather than
   * `assets`, so a staged device moves the instant it is dropped. That inverts what `pendingZone`
   * used to compensate for: a drop had NO optimistic feedback, the chip stayed put until the
   * reload landed, and on a slow link that was indistinguishable from a refused drop -- which is
   * how one move became two writes. Now the chip moves immediately and nothing has been written,
   * so the burden moves the other way: staged must be visibly distinct from saved, which is what
   * the `staged` flag applyStagedMoves() sets is for.
   */
  const stagedAssets = useMemo(
    () => applyStagedMoves(assets, gwList, staged),
    [assets, gwList, staged]
  )

  /**
   * Stage one move, or UNSTAGE it if it puts the device back where it already is.
   *
   * The comparison is against the device's committed row in `assets`, never against the staged
   * view -- dragging a chip out to another cell and then back again must leave nothing staged at
   * all. Without this the batch carries a move the RPC correctly reports as `unchanged`, the
   * commit bar offers to apply work that does nothing, and the operator is told N moves were
   * applied when the thread recorded fewer.
   */
  const stageMove = useCallback((assetId, cellId, scope) => {
    setStaged(prev => {
      const next = new Map(prev)
      const committed = assets.find(a => a.asset_id === assetId)
      // `explicit_cell_id` first: `cell_id` on these rows is the device's own column, but the
      // view fields merged alongside it are the ones that survive a re-resolution.
      const wasCell = committed?.explicit_cell_id ?? committed?.cell_id ?? null
      const wasScope = committed?.location_scope || SCOPE_CELL
      const nowCell = cellId || null
      if (nowCell === wasCell && scope === wasScope) next.delete(assetId)
      else next.set(assetId, { cell_id: nowCell, location_scope: scope })
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

    // Where it currently resolves to, not its explicit override -- a device inheriting the target
    // cell is already there, and dropping it again should stay a no-op. `assetData` comes off the
    // STAGED view, so this is correct for a chip that has already been moved once.
    if (assetData.effective_cell_id === targetCellId) return

    const targetCellName = cells.find(c => c.cell_id === targetCellId)?.cell_name || 'the target cell'

    // A move sets devices.cell_id directly (archived migration 0036). It used to have to rewire
    // the device's GATEWAY to express a move, because location was only inheritable -- which meant
    // the drop was refused outright when the target cell had no gateway or more than one, and
    // when it did work it changed the data path to say something about geography. Dragging a
    // machine across the floor plan says where the machine is; it says nothing about which
    // connector reaches it, so the gateway is deliberately left alone.
    stageMove(assetData.asset_id, targetCellId, SCOPE_CELL)

    // Said at STAGING time, not on apply, because this is when the operator can still change
    // their mind. The device will be pinned to this cell and will stop following its gateway --
    // what the drop asked for, but not something the result makes visible.
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

  // The derived lanes. None is a row in `cells` -- Unassigned is the absence of a decision,
  // Site-Wide is an operator's assertion that an asset has no single cell, and Simulated is a fact
  // about the gateway; a magic cell row would put all three meanings in a free-text name. They are
  // rendered beside the cells because that is where an operator looks for an asset, and because a
  // queue nobody can see never drains.
  //
  // SHADOW IS NOT HERE, and its absence is deliberate rather than an oversight. This map answers
  // "what is my plant doing now", and a replay is not now -- a lane of stand-ins for machines
  // invites exactly the miscount the lanes exist to prevent. A running playback is visible on the
  // Capture page, which is where a job belongs. Note this is NOT a rule that derived lanes are
  // hidden here: Simulated shows, because on a stack running the simulator the simulated fleet is
  // the plant, and hiding it would empty the page.
  const laneDevices = useMemo(() => ({
    [SOURCE_UNASSIGNED]: stagedAssets.filter(a => a.location_source === SOURCE_UNASSIGNED),
    [SOURCE_SITE_WIDE]: stagedAssets.filter(a => a.location_source === SOURCE_SITE_WIDE),
    [SOURCE_SIMULATED]: stagedAssets.filter(a => a.location_source === SOURCE_SIMULATED)
  }), [stagedAssets])

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
   * coupling archived migration 0036 removed.
   */
  const handleLaneDrop = (e, lane) => {
    e.preventDefault()
    if (!canRearrange) return
    let assetData
    try {
      assetData = JSON.parse(e.dataTransfer.getData('application/json'))
    } catch (err) {
      showToast(err.message, 'error')
      return
    }

    if (assetData.location_source === lane) return

    const siteWide = lane === SOURCE_SITE_WIDE
    stageMove(assetData.asset_id, null, siteWide ? SCOPE_SITE_WIDE : SCOPE_CELL)

    if (siteWide) {
      showToast(`Staged: '${assetData.asset_name}' → Site-Wide — it will belong to no single cell`, 'success')
      return
    }

    // AND THE SPRING-BACK IS NOW VISIBLE AT THE DROP, not after a write. Staging clears the
    // explicit cell and re-runs the resolution locally, so a device whose gateway serves a cell
    // re-inherits it and the chip lands back in that cell immediately. Under the old immediate
    // write the operator saw the chip stay put, then jump somewhere unexpected once the reload
    // arrived. The message explains what they just watched happen.
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
   * Apply the whole rearrangement as one transaction.
   *
   * ONE RPC, not one request per staged move. Firing them separately from here would still be one
   * transaction each -- the thread would look exactly as it did before this work -- and it would
   * reintroduce the half-applied batch: a failure on the fourth of six leaves three machines
   * moved with no record the other three were ever meant to be.
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
   * Leaving the mode with work staged has to MEAN something, and silently discarding is the one
   * thing it must not mean. With immediate writes the only undo was dragging the device back,
   * which wrote again; staging replaces that with an explicit choice, so the exit asks.
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
   * The browser-level half of "must not lose the work silently". A reload or a closed tab throws
   * the staged batch away with no server state to recover it from, so the browser is asked to
   * confirm. In-app navigation is covered differently -- this component keeps its state while the
   * tab is mounted, and the commit bar below is what stops the batch being forgotten.
   */
  useEffect(() => {
    if (staged.size === 0) return undefined
    const warn = (e) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [staged.size])

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

  /**
   * Which devices Grafana currently has an alert firing on (issue #34).
   *
   * Indexed once per render of the page rather than searched per chip: a cell with forty devices
   * would otherwise walk the alert list forty times to draw one row.
   */
  const alerts = useMemo(() => alertIndex(activeAlerts), [activeAlerts])

  const STATUS_LABEL = {
    attention: 'Needs attention — a device here is quarantined, waiting to be admitted',
    normal: 'Normal — at least one device here is online',
    idle: 'Nothing live — no device here is currently reporting',
    // Says WHO raised it, because that is the difference between this red and the red this
    // dashboard withdrew. The map relays a Grafana verdict; it does not evaluate a threshold of
    // its own. See deviceChipClass() for why that distinction is what permits red at all.
    alert: 'Alert firing — Grafana has raised an alert against a device in this tile. The device '
      + 'chip turns red and is flagged ALARM or WARN'
  }

  // One renderer for cell cards and both lanes. A device dragged out of Unassigned has to look
  // and behave exactly like one already in a cell, or the lanes read as a different kind of thing
  // rather than as somewhere the same asset currently sits.
  const deviceChip = (a) => {
    const status = deviceLifecycleStatus(a)
    const isArch = a.is_archived
    // Archived reads as inert regardless of the last lifecycle state it held -- a decommissioned
    // machine that happens to still be publishing must not look like a running one.
    // ARCHIVED STILL WINS, which is why this is one helper rather than a ternary per site: an
    // alert firing against something taken out of service is noise about a decision already made.
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
          // STAGED MUST NOT LOOK SAVED. The chip moves the moment it is dropped now, so without
          // a mark the only difference between "moved" and "moved and durable" is whether the
          // operator remembers pressing Apply. A dashed outline reads as provisional in a way a
          // colour change would not -- colour on these chips already means device status.
          ...(a.staged ? { outline: '1px dashed var(--accent)', outlineOffset: '1px' } : null)
        }}
        title={`${a.asset_name} [${a.asset_id}] — ${isArch ? 'Device Archived (Out of Commission)' : alert ? `ALERT: ${alert.alert_name}${alert.summary ? ` — ${alert.summary}` : ''}` : deviceStatusTitle(status)}${a.staged ? ' — STAGED: this move has not been applied yet' : ''} — ${canRearrange && !isInactive ? 'Drag to reassign Cell, or click' : 'Click'} to view on Devices page`}
      >
        {isArch ? <IconArchive size={11} /> : <IconCog size={11} />}
        {/* NAME ONLY. The UUID used to sit inline beside it, capped at ~72px, and it was buying
            almost nothing: six characters of an opaque identifier are not enough to recognise a
            device by, and they were the reason a name as ordinary as "Sim_CNC_Mill_01" clipped.
            The full id is on the `title` above, where it is actually readable. */}
        <span className="chip-name">{a.asset_name}</span>
        {a.staged && <span className="chip-flag" style={{ color: 'var(--accent)' }} title="Staged move — not applied yet">STAGED</span>}
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
        {/* AN ALERT IS THE ONE CHIP STATE THAT WAS COLOUR ALONE. Every other treatment on this map
            carries a mark as well as a hue -- ARCH, QUAR, OFF, STAGED, and the tile dot's `title` --
            because `.tile-dot` states the rule outright: never colour alone. A red chip with no
            flag broke it, and issue #59 asks the legend to name a category the map could not
            actually spell out.

            ARCHIVED WINS, matching deviceChipClass()'s precedence exactly rather than restating it:
            the chip is already grey by then, and a flag contradicting its own colour is worse than
            no flag. The glyph and wording are DevicesTab's -- circle/ALARM for critical, triangle
            for anything else -- so a device does not answer to two different names on two pages. */}
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
        {/* Name only, same as the device chip. The per-gateway "N dev" that used to sit here went
            with the UUIDs: the tile header already totals GW and Dev for the whole zone, and the
            per-gateway figure is on this chip's title. The HOST and ARCHIVED badges are down to
            single flags for the same reason -- a bordered pill left no room for the name it
            describes. */}
        <span className="chip-name mono">{g.gateway_name}</span>
        {g.deployment === 'host' && !isGwArch && <span className="chip-flag" style={{ color: 'var(--accent)' }} title="Runs on this host"><IconZap size={9} /></span>}
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
    // A TILE IS PENDING WHEN SOMETHING STAGED IS SITTING IN IT, which is a different question
    // from the one this used to answer. It used to track the single tile with an outstanding
    // `api.put` -- a drop is no longer a write, so there is nothing outstanding to track. What
    // there is instead is a tile holding devices that only look like they are there, and that is
    // the thing an operator must be able to see at a glance before applying the batch.
    const pending = devices.some(d => d.staged)
    // A TILE WITH NO onDrop MUST NOT ACCEPT DRAGOVER EITHER. handleDragOver calls
    // preventDefault(), which is precisely what tells the browser "this is a valid drop target" --
    // so wiring it unconditionally gave the Simulated lane a drop cursor over a tile that then
    // silently swallowed the drop. Refusing at dragover shows a no-entry cursor instead, which
    // says the same thing before the operator commits to the gesture.
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
      matchGateway: (g) => !g.is_simulated && !g.is_shadow && g.location_scope === SCOPE_SITE_WIDE,
      empty: 'No site-wide assets. Drop a BMS, AGV or ambient sensor here.',
      hint: 'A permanent home, not a queue. Facility-wide and mobile assets live here rather than being filed in an arbitrary bay.'
    },
    {
      // Context like Site-Wide rather than a queue, so it sits between the two: stable contents an
      // operator reads to know what NOT to trust, ahead of the queue they are meant to act on.
      key: SOURCE_SIMULATED,
      title: 'Simulated',
      icon: IconBot,
      className: 'shopfloor-lane shopfloor-lane-simulated',
      matchGateway: (g) => !g.is_shadow && g.is_simulated,
      // NOT DROPPABLE. Every other lane is reachable by a drop because it is a statement about
      // location, and location is the operator's to assert. This one is a statement about the
      // gateway's provenance -- dragging a real machine into it would be claiming its readings are
      // invented, which is not a placement and is not settable from a map.
      droppable: false,
      empty: 'Nothing synthetic. Every asset here reports from real hardware.',
      hint: 'Telemetry generated rather than observed — a simulator, or a broker playback target. Set on the gateway; its devices inherit it and cannot be filed into a cell.'
    },
    {
      key: SOURCE_UNASSIGNED,
      title: 'Unassigned',
      icon: IconShieldAlert,
      className: 'shopfloor-lane shopfloor-lane-queue',
      // SYNTHETIC GATEWAYS ARE EXCLUDED, which is the whole point of the lane beside it. They have
      // no cell and are cell-scoped, so they matched here until 0059 -- sitting in a queue whose
      // every suggested fix ("set a cell on the Gateways page") is refused by
      // gateways_synthetic_has_no_cell. A queue that cannot drain is one an operator learns to
      // ignore, which costs the real entries their only signal.
      matchGateway: (g) => !g.is_simulated && !g.is_shadow
        && g.location_scope !== SCOPE_SITE_WIDE && !g.cell_id,
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

  // THE SHADOW LANE IS NOT PART OF THE FLEET, and this ribbon was the last surface that disagreed.
  // The rule, why it is one rule rather than three, and what the returned `shadow` figure is for
  // are all in fleetCounts.js -- it is the only place that sentence is written now.
  const gw = gatewayFleetCounts(gwList)
  const dev = deviceFleetCounts(assets)

  // Appended to the tooltips rather than folded into the buckets, which go on summing to the
  // headline total -- the property the quarantine note protects.
  const shadowGwNote = gw.shadow > 0
    ? ` Plus ${gw.shadow} playback gateway, which publishes recorded captures and is not a connector to any machine.`
    : ''
  const shadowAssetNote = dev.shadow > 0
    ? ` Plus ${dev.shadow} shadow device${dev.shadow === 1 ? '' : 's'} — stand-ins that receive replayed readings, not machines.`
    : ''

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
          title={`${gw.online} online / ${gw.pending} awaiting setup / ${gw.offline} offline / ${gw.archived} archived, of ${gw.total} registered edge gateways.${shadowGwNote} Click to view Gateways.`}
        >
          <span className="kpi-label">Gateways</span>
          <span className="kpi-value">{gw.online}<span className="kpi-total">/{gw.total}</span></span>
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
          className={`kpi-item${dev.quarantined > 0 ? ' kpi-item-alert' : ''}`}
          onClick={() => onNavigateTab && onNavigateTab('devices')}
          title={dev.quarantined > 0
            ? `${dev.quarantined} device${dev.quarantined === 1 ? '' : 's'} awaiting zero-touch onboarding approval. ${dev.online} online / ${dev.offline} offline / ${dev.archived} archived, of ${dev.total}.${shadowAssetNote} Click to review the quarantine queue.`
            : `${dev.online} online / ${dev.offline} offline / ${dev.archived} archived, of ${dev.total} registered shopfloor devices.${shadowAssetNote} Click to view Devices.`}
        >
          <span className="kpi-label">Devices</span>
          <span className="kpi-value">{dev.online}<span className="kpi-total">/{dev.total}</span></span>
          <span className="kpi-unit">Online</span>
          {dev.quarantined > 0 && (
            <span className="kpi-alert-flag">
              <IconShieldAlert size={12} aria-hidden="true" />
              {dev.quarantined} Quarantined
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
              {/* THE FOURTH CATEGORY IS A CHIP, NOT A DOT (issue #59), and the swatch says so.
                  Red arrived on this map with issue #34 and the legend never grew an entry for it,
                  so the one colour that means "somebody look now" was the only one undocumented.

                  It is drawn as a miniature chip rather than a fourth dot on purpose: the dots roll
                  up CONNECTIVITY for a whole tile, and an alert belongs to one device inside it. A
                  red dot in this row would promise a tile-level state the grid does not paint --
                  see rollupDeviceStatus(), which has no alert input and deliberately none. */}
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

          {/* A DESCRIPTION, LIKE EVERY OTHER CARD ON THE STACK. This one had a title and a legend
              and no sentence saying what it is showing -- and it is the one card where that costs
              most, because a grid of tiles is the least self-explanatory thing here. The legend
              decodes the dots; this says what a tile IS. */}
          <p style={{ color: 'var(--text-muted)', fontSize: '12px', margin: '0 0 16px' }}>
            Every cell on the shopfloor, with the devices that resolve to it. A device sits in its
            own cell if it names one and in its gateway's otherwise, so this is where the two
            disagreeing becomes visible. The lanes at the front hold what belongs to no single
            cell — site-wide assets, and anything still waiting to be placed.
          </p>

          {/* Shown only while the mode is on, so the page carries no standing instruction about a
              gesture that is usually unavailable — and so it is obvious the map is live. */}
          {canRearrange && (
            <div style={{ marginBottom: '16px', fontSize: '11px', color: 'var(--warning-text)', background: 'rgba(255,179,0,0.08)', border: '1px solid var(--warning)', borderRadius: 'var(--radius-sm)', padding: '8px 12px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <IconPencil size={12} />
              {/* THE COUNT AND THE ACTIONS LIVE IN THE SAME BANNER the mode already showed, rather
                  than in a new floating bar. This banner is the thing that says the map is live;
                  a second element saying the map is also unsaved would be two places to look for
                  one answer, and the one that scrolled off screen would be the one that mattered. */}
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

          {/* TWO GRIDS, BECAUSE LANES AND CELLS ARE DIFFERENT KINDS OF THING.
              The lanes held positions 1-3 of a single grid by CSS `order`, which pinned them but
              did not SEPARATE them: at most widths they sat on the same row as the first cells, so
              the map read as one run of tiles in which three happened to be coloured differently.
              A reader had to already know which were derived to see the boundary.

              A row of their own draws it structurally instead. The lanes are the assets that
              belong to NO cell -- and every one of them is a fact about the data path, not a place
              on the floor -- so the plant reads as the grid beneath them.

              This reverses the merge that put them in one grid, and the reason it is now the
              cheaper choice is that there are three lanes rather than two: three tiles fill a row
              on their own, so the height that merging saved is no longer there to save.

              Each lane holds BOTH gateways and devices. A gateway with no cell is exactly as
              stranded as a device with no cell -- and it is usually the CAUSE of the devices
              beside it being stranded, since they had nothing to inherit. Showing only the
              devices left the reason off-screen. */}
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
              // THE "DERIVED" BADGE IS GONE FROM THE TILE, and the word moved onto the name's
              // title instead. It was a `flex-shrink: 0` element sharing a narrow header with the
              // name, so it took its width first and left "Site-Wide" and "Unassigned" rendering
              // as "S..." and "U..." -- a badge explaining what a tile is, at the cost of the
              // tile's name. The colour and the border now carry "not a cell" on their own.
              nameTitle: `${lane.title} — a derived lane, not a cell: it has no record in the database`
            }))}
          </div>

          {/* THE PLANT ITSELF, BELOW THE LANES. */}
          <div className="shopfloor-grid">
            {cells.length === 0 && (
              /* AN EMPTY STATE OF ITS OWN, now that this grid can be empty while the lanes above
                 are full -- which is the ordinary state of a stack running only the simulator,
                 since gateways_synthetic_has_no_cell (0059) means the demonstration floor has no
                 cells at all. Under one grid that case rendered nothing here and the section
                 simply stopped, reading as a map that had failed to load.

                 It says where the assets went, because the previous wording ("No active cells
                 configured") answered a question nobody had asked while leaving the obvious one
                 -- then where is everything? -- to the tiles above it. */
              <div className="empty-state" style={{ gridColumn: '1 / -1' }}>
                <div className="empty-icon"><IconFactory size={36} /></div>
                <div className="empty-text">
                  {laneViews.some(v => v.gateways.length > 0 || v.devices.length > 0)
                    ? 'No cell zones configured — every asset resolves to one of the lanes above.'
                    : 'No active cells configured to display on the shopfloor blueprint.'}
                </div>
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
