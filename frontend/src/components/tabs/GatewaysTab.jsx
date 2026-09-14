import React, { useState, useEffect, useCallback } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS, REALTIME_ENABLED, STALENESS_TICK_MS, refreshInterval } from '../../constants'
import { usePolling } from '../../hooks/usePolling'
import { useRealtimeTable } from '../../hooks/useRealtimeTable'
import { useClockTick } from '../../hooks/useClockTick'
import {
  gatewayLiveStatus, isGatewayOnline, isGatewayPending, formatHeartbeat,
  formatCertExpiry, isCertExpiring, holdsOlderRoot, formatBytes, CERT_EXPIRY_WARN_DAYS
} from '../../utils/gatewayStatus'
import { gatewaySparkplugId } from '../../utils/sparkplugId'
import {
  GATEWAY_TYPES, SELECTABLE_TYPES, gatewayType, gatewayTypeFields,
  gatewayTypeLabel, gatewayTypeDescription, gatewayTypeTone,
} from '../../utils/gatewayType'
import { deviceLifecycleStatus, deviceStatusDotColor, deviceStatusTitle, deviceDotColor } from '../../utils/deviceStatus'
import { alertIndex, alertForDevice } from '../../utils/deviceAlerts'
import { SCOPE_CELL, SCOPE_AREA_WIDE, SCOPE_SITE_WIDE, gatewayAcceptsCell } from '../../utils/cellResolution'
import { isShadowGateway } from '../../utils/fleetCounts'
import { flowDriftState, flowDriftLabel, isFlowDrift, flowEditedOnAppliance, FLOW_DRIFT_GRACE_MS } from '../../utils/flowDrift'
import { LocationPicker, locationIncomplete } from '../common/LocationPicker'
import CopyableId from '../common/CopyableId'
import { TagList } from '../common/TagList'
import { StatusBadge } from '../common/StatusBadge'
import { ActionButton } from '../common/ActionButton'
import { usePendingAction, usePendingKey } from '../../hooks/usePendingAction'
import { ContextPanel, rowSelectHandler } from '../common/ContextPanel'
import { patchFromForm, formFromPatch, submitProposal, nonProposableFields } from '../../utils/proposeFromForm'
import { ArchiveModal } from '../modals/ArchiveModal'
import { EntityLinksModal } from '../modals/EntityLinksModal'
import { GatewayBundleModal } from '../modals/GatewayBundleModal'
import { GatewayCredentialModal } from '../modals/GatewayCredentialModal'
import { GatewayRepositoryPanel } from '../common/GatewayRepositoryPanel'
import {
  IconRadio,
  IconPlus,
  IconPencil,
  IconArchive,
  IconRefreshCw,
  IconHistory,
  IconBookOpen,
  IconExternalLink,
  IconShieldAlert,
  IconLayoutDashboard,
  IconX,
  IconDownload,
  IconLock
} from '../common/Icons'
import { HelpTip } from '../common/HelpTip'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { useArrivalSelection } from '../../hooks/useArrivalSelection'

export function GatewaysTab({ showToast, onViewThread, onSelectCell, onSelectDevice, hasPermission, userRole, initialSearchFilter, onClearFilter, onBugReport, activeAlerts = [] }) {
  /** Devices Grafana currently has an alert firing on -- see utils/deviceAlerts.js (issue #34). */
  const alerts = React.useMemo(() => alertIndex(activeAlerts), [activeAlerts])
  const [gateways, setGateways] = useState([])
  const [assets, setAssets]     = useState([])
  const [cells, setCells]       = useState([])
  const [loading, setLoading]   = useState(true)
  const [showForm, setShowForm] = useState(false)
  // The create/edit form is a modal written inline. Escape closes it through the shared stack, so
  // an ArchiveModal opened over it answers first.
  useEscapeKey(() => setShowForm(false), showForm)
  const [editing, setEditing]   = useState(null)
  const [archiveTarget, setArchiveTarget] = useState(null)
  // The context panel holds an id, not the gateway object: this page polls, and resolving the id
  // every render keeps the drawer as live as the row. It closes itself if the entity disappears.
  const [selectedId, setSelectedId] = useState(null)
  // `location_scope` defaults to 'cell'. `deployment` is a different question: where the connector
  // runs, not where the assets are. 'remote' is the default because it is the case that needs
  // setup, and it finishes with a bundle to install.
  const blank = { gateway_id: '', gateway_name: '', status: 'OFFLINE', deployment: 'remote', is_simulated: false, access_url: '', cell_id: '', area_id: '', location_scope: SCOPE_CELL }
  const [areas, setAreas]       = useState([])
  const [form, setForm]         = useState(blank)
  // Derived, not a second piece of state: the form carries `deployment` and `is_simulated` because
  // that is what the API takes; the select carries one word.
  const formType = gatewayType(form)
  // Derived off the flags rather than `formType`: the rule belongs to
  // `gateways_synthetic_has_no_cell`, which is written in terms of the two columns.
  const formAcceptsCell = gatewayAcceptsCell(form)
  const [docsForGw, setDocsForGw] = useState(null)
  // The gateway whose bundle modal is open. Held as the OBJECT rather than an id: the modal needs
  // the name and sparkplug_id, and it stays open across a poll that may reorder the list.
  const [bundleForGw, setBundleForGw] = useState(null)
  // The host-run counterpart to bundleForGw. Separate state: the two are authorised differently,
  // destroy different things, and only one puts a password on screen.
  const [credentialForGw, setCredentialForGw] = useState(null)
  // Whether this deployment can enrol an appliance, from gateway-bundle's GET. null until
  // answered, and null when the probe failed: an unknown never blocks, since the function's own
  // refusal still stands behind it.
  const [enrolment, setEnrolment] = useState(null)
  const [filterMode, setFilterMode] = useState('all')

  const getInitialSearch = () => {
    const params = new URLSearchParams(window.location.search)
    return params.get('search') || initialSearchFilter || ''
  }

  const [searchQuery, setSearchQuery] = useState(getInitialSearch)
  const [liveStatusFilter, setLiveStatusFilter] = useState('')
  const [kindFilter, setKindFilter] = useState('')
  const [quarantineOnly, setQuarantineOnly] = useState(false)
  // The Playback gateway (0060). Off by default -- see the filter for why it is not a Type option.
  const [showShadowGateways, setShowShadowGateways] = useState(false)

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

  const resetFilters = () => {
    setSearchQuery('')
    setLiveStatusFilter('')
    setKindFilter('')
    setQuarantineOnly(false)
    setShowShadowGateways(false)
    setFilterMode('all')
    handleClearSearch()
  }

  const load = useCallback(async (signal) => {
    try {
      // Each gateway arrives with its devices embedded, so an assignment made anywhere shows on the
      // next poll. The flat device list still surfaces devices that belong to no gateway.
      const [g, a, c, ar] = await Promise.all([
        api.get('/api/v1/gateways', { signal }),
        api.get('/api/v1/devices', { signal }),
        api.get('/api/v1/cells', { signal }),
        // Tolerated: without it the picker simply offers no Area-Wide entries.
        api.get('/api/v1/areas', { signal }).catch(() => [])
      ])
      setGateways(g); setAssets(a); setCells(c); setAreas(ar)

      /* This person's open proposals, so the edit dialog can seed itself with an open patch rather
         than replace it. Tolerated rather than required. */
      try {
        const proposals = await api.get('/api/v1/proposals', { signal })
        setOpenProposals((proposals || []).filter(pr => pr.status === 'open'))
      } catch (pErr) {
        if (pErr.name !== 'AbortError') setOpenProposals([])
      }
      setLoading(false)
    } catch (e) {
      if (e.name !== 'AbortError') {
        setLoading(false)
      }
      throw e
    }
  }, [])

  // Reconciliation loop, not the primary refresh (see useRealtimeTable). Ingestion stamps
  // `last_heartbeat` on every NBIRTH / NDATA / NDEATH, so this is the highest-traffic subscription
  // in the app and the reason the hook debounces.
  usePolling(load, refreshInterval())
  useRealtimeTable(['gateways', 'devices', 'cells'], load, { enabled: REALTIME_ENABLED })
  // Heartbeat staleness is derived from the wall clock by gatewayLiveStatus(), and a gateway going
  // quiet produces no Realtime event. Re-renders only; issues no requests.
  useClockTick(STALENESS_TICK_MS)

  // In-flight state for the form's Save and for whichever gateway is restoring.
  const [saving, runSave] = usePendingAction()
  const [restoringId, runRestore] = usePendingKey()
  // Keyed rather than a single flag: the panel resolves its gateway every render, so a bare boolean
  // would spin the button for whichever gateway happened to be selected when the request settled.
  const [rebirthingId, runRebirth] = usePendingKey()

  const save = async () => {
    try {
      /* The fork is at the end: everything above is shared. A gateway can only be registered by an
         Administrator, since the remote branch mints a bundle, which is not a thing to queue. */
      if (proposeMode) {
        if (!editing) throw new Error('A gateway can only be registered by an Administrator.')
        const patch = patchFromForm('gateway', editing, form)
        await submitProposal({
          kind: 'gateway', entityId: editing.gateway_id, patch,
          rationale: form.__rationale, proposalId: editingProposal?.id
        })
        setShowForm(false); setEditingProposal(null); load()
        showToast(editingProposal
          ? 'Your proposal was updated. An approver decides from here.'
          : 'Proposed. An approver applies it, or says why not.', 'success')
        return
      }

      if (editing) {
        await api.put(`/api/v1/gateways/${editing.gateway_id}`, form)
        setShowForm(false); load(); showToast('Gateway saved', 'success')
        return
      }

      const created = await api.post('/api/v1/gateways', form)
      setShowForm(false); load()

      /**
       * The remote branch. A host-run gateway is finished when its row exists; a remote one needs a
       * bundle on a machine before it can publish, so the bundle modal opens immediately. It
       * downloads without confirming: the row is seconds old, so there is no earlier bundle to
       * invalidate. See GatewayBundleModal.
       */
      if (form.deployment === 'remote') {
        setBundleForGw({
          gateway_id: created.id || created.gateway_id,
          gateway_name: created.name || form.gateway_name,
          sparkplug_id: created.sparkplug_id,
          confirmFirst: false
        })
        showToast('Remote gateway created — download its bundle to finish setup', 'success')
      } else {
        showToast('Gateway created', 'success')
      }
    } catch (e) { showToast(e.message, 'error') }
  }

  const archiveGateway = async (days) => {
    try {
      await api.post(`/api/v1/gateways/${archiveTarget.gateway_id}/archive`, { auto_delete_days: days })
      // Closes after the request, which is what lets ArchiveModal hold its pending state for the
      // whole round trip -- see the note on CellsTab.archiveCell.
      setArchiveTarget(null); load(); showToast(`Gateway '${archiveTarget.gateway_name}' archived (Out of Commission)`, 'success')
    } catch (e) { showToast(e.message, 'error') }
  }

  const restoreGateway = async (gatewayId, name) => {
    try {
      await api.post(`/api/v1/gateways/${gatewayId}/restore`, {})
      load(); showToast(`Gateway '${name}' restored to active service`, 'success')
    } catch (e) { showToast(e.message, 'error') }
  }

  const canManage = hasPermission(PERMISSION_UUIDS.GATEWAY_MANAGE)
  const canArchive = hasPermission(PERMISSION_UUIDS.ARCHIVE_MANAGE)
  const canReadThread = hasPermission(PERMISSION_UUIDS.DIGITAL_THREAD_READ)
  const canPropose = hasPermission(PERMISSION_UUIDS.PROPOSAL_CREATE)

  /* One form, two endings (utils/proposeFromForm.js). Derived rather than stored, so it cannot
     disagree with the permission. */
  const proposeMode = !canManage && canPropose

  // Asked by whoever could create a remote gateway, on mount and again each time the form opens,
  // so a deployment fixed and restarted is noticed without a reload.
  useEffect(() => {
    if (!canManage) return undefined
    let cancelled = false
    Promise.resolve()
      .then(() => api.enrolmentReadiness())
      .then(r => { if (!cancelled && r && typeof r.ready === 'boolean') setEnrolment(r) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [canManage, showForm])
  const enrolmentBlocked = enrolment !== null && !enrolment.ready
  const enrolmentProblems = enrolmentBlocked
    ? (enrolment.addresses || []).filter(a => a.problem).map(a => `${a.variable} is ${a.problem}`)
    : []
  // Save is withheld for a gateway that would need a bundle this deployment cannot issue: a new
  // Remote one, or an existing gateway being moved to Remote. Renaming a remote gateway is not
  // that, and a proposal changes nothing until an approver acts.
  const remoteWithheld = !proposeMode && enrolmentBlocked && formType === GATEWAY_TYPES.REMOTE
    && (!editing || editing.deployment !== 'remote')
  const [editingProposal, setEditingProposal] = useState(null)
  const [openProposals, setOpenProposals] = useState([])
  const withheldFields = nonProposableFields('gateway')

  /**
   * The note under a field a proposal may not name. Disabled with the reason rather than hidden:
   * `deployment` says where the connector runs, and moving it re-points a broker topic namespace.
   */
  const Withheld = ({ field }) => (
    proposeMode && withheldFields[field]
      ? <div className="form-hint-locked">{withheldFields[field]}</div>
      : null
  )
  /**
   * Who may open the forge: a role, mirroring the `forge` listener in supabase/envoy.yaml, which
   * admits Administrator and Shopfloor_Manager by the role in the verified token. The UI agrees
   * with the boundary; it does not implement it.
   */
  const canOpenForge = userRole === 'Administrator' || userRole === 'Shopfloor_Manager'

  const unassignedDevices = assets.filter(a => !a.is_archived && !a.active_gateway_id)
  // The gateways that should be reporting and are not: the rail's amber for this page, and the
  // same rule as gatewayFleetCounts(). Awaiting setup is an unfinished task, not a fault, and the
  // playback lane is not a connector to any machine.
  const offlineGateways = gateways.filter(g => !g.is_archived && !isShadowGateway(g) && !isGatewayPending(g) && !isGatewayOnline(g))

  // Built from the flat device list: ingestion records the arriving edge node on a quarantined
  // device, so a device held on a gateway is attributable before it is approved.
  const gatewaysWithQuarantine = new Set(
    assets.filter(a => a.is_quarantined && a.active_gateway_id).map(a => a.active_gateway_id)
  )

  const filteredGateways = gateways.filter(g => {
    // Hidden by default, like the Devices page's shadow devices: one seeded row on every stack with
    // almost every action withdrawn. Not removed, because minting its broker credential happens
    // here. Filtered separately from Type, since Shadow is its own type.
    if (!showShadowGateways && g.is_shadow) return false
    if (filterMode === 'active'   && g.is_archived) return false
    if (filterMode === 'archived' && !g.is_archived) return false
    if (searchQuery) {
      // Matches the friendly name, the internal UUID and the Sparkplug edge node id.
      const q = searchQuery.toLowerCase()
      const haystack = [g.gateway_name, g.gateway_id, g.sparkplug_id || gatewaySparkplugId(g.gateway_id)]
        .filter(Boolean).join(' ').toLowerCase()
      if (!haystack.includes(q)) return false
    }
    if (liveStatusFilter && gatewayLiveStatus(g) !== liveStatusFilter) return false
    // Compared against the derived type, not against `deployment`: Simulated and Host are the same
    // deployment and differ only in the flag beside it.
    if (kindFilter && gatewayType(g) !== kindFilter) return false
    if (quarantineOnly && !gatewaysWithQuarantine.has(g.gateway_id)) return false
    return true
  })

  // Counted across the whole fleet, not the filtered list: the toggle is offered when one exists,
  // hidden or not. The count is not printed, since a stack holds one Playback gateway.
  const shadowGatewayCount = gateways.filter(g => g.is_shadow).length

  const activeFilterCount =
    [searchQuery, liveStatusFilter, kindFilter].filter(Boolean).length +
    (quarantineOnly ? 1 : 0) + (showShadowGateways ? 1 : 0) + (filterMode !== 'all' ? 1 : 0)

  // Arriving from a cell's gateway chip, a device's Serving Gateway chip or the shopfloor map: the
  // caller named ONE gateway, so open it. Identifier equality only -- see the hook.
  useArrivalSelection(
    searchQuery,
    gateways,
    (g, term) => g.gateway_id === term || gatewaySparkplugId(g) === term,
    (g) => setSelectedId(g.gateway_id)
  )

  // Resolved fresh every render -- see the note on selectedId. A gateway that has been archived
  // out of the current filter, or deleted, resolves to null and the drawer simply closes.
  const selected = gateways.find(g => g.gateway_id === selectedId) || null
  const selectedDevices = selected?.devices || []
  const selectedCell = selected ? cells.find(c => c.cell_id === selected.cell_id) : null

  return (
    <div className="page-layout">
      <div className="page-main">

      {/* Above the card: a page-level finding, and the first thing worth knowing on arrival. See
          CellsTab's note on why it is not in the card body. */}
      {unassignedDevices.length > 0 && (
        <div style={{ marginBottom: 'var(--stack)', background: 'rgba(255,179,0,0.08)', border: '1px solid var(--warning)', borderRadius: 'var(--radius)', padding: '10px var(--inset)', fontSize: '13px', color: 'var(--warning-text)' }}>
          <strong>{unassignedDevices.length} device{unassignedDevices.length === 1 ? '' : 's'} not assigned to any gateway:</strong>{' '}
          {unassignedDevices.slice(0, 5).map(a => a.asset_name).join(', ')}{unassignedDevices.length > 5 ? ', …' : ''}.
          Assign them from the Devices page.
        </div>
      )}

      {/* Says what the rail's colour means before the table is read: which gateways are silent,
          and that their devices are silent with them. */}
      {offlineGateways.length > 0 && (
        <div style={{ marginBottom: 'var(--stack)', background: 'rgba(255,179,0,0.08)', border: '1px solid var(--warning)', borderRadius: 'var(--radius)', padding: '10px var(--inset)', fontSize: '13px', color: 'var(--warning-text)', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <IconShieldAlert size={18} style={{ flexShrink: 0 }} />
          <span>
            <strong>{offlineGateways.length} gateway{offlineGateways.length === 1 ? '' : 's'} offline:</strong>{' '}
            {offlineGateways.slice(0, 5).map(g => g.gateway_name).join(', ')}{offlineGateways.length > 5 ? ', …' : ''}.
            Every device underneath is silent with it. Check the appliance, its network, and its broker credential.
          </span>
        </div>
      )}

      {/* Said here, before a remote gateway is created, because the refusal otherwise arrives from
          the bundle modal after the row exists. Only for those who could create one. */}
      {enrolmentBlocked && canManage && (
        <div role="status" style={{ marginBottom: 'var(--stack)', background: 'rgba(255,179,0,0.08)', border: '1px solid var(--warning)', borderRadius: 'var(--radius)', padding: '10px var(--inset)', fontSize: '13px', color: 'var(--warning-text)', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <IconShieldAlert size={18} style={{ flexShrink: 0 }} />
          <span>
            <strong>Remote gateways cannot be enrolled on this deployment:</strong>{' '}
            {enrolmentProblems.join('; ')}. An appliance dials these addresses, so they are set on
            the deployment rather than here: on Compose, <span className="mono">npm run setup</span> asks
            for the host on a fresh .env, or set both and restart (docs/physical-gateways.md, section 7).
            Host-run and simulated gateways are unaffected.
          </span>
        </div>
      )}

      {/* One card: title, description, primary action, filters, table. See CellsTab's note on why
          the filter bar came inside rather than floating above. */}
      <div className="card">
        <div className="card-header">
          <h3 className="section-title">
            Gateways
            <HelpTip
              label="About gateways"
              text="A gateway is an edge node: the thing that publishes to the broker, and the identity every topic beneath it is pinned to. Its devices reach the platform through it, so status here is derived from the last heartbeat rather than from anything the gateway asserts about itself."
            />
          </h3>
          <button
            className={`btn btn-primary btn-sm ${!canManage ? 'btn-disabled' : ''}`}
            style={{ marginLeft: 'auto' }}
            disabled={!canManage}
            onClick={() => canManage && (setEditing(null), setForm(blank), setShowForm(true))}
            title={!canManage ? 'Requires Admin permissions' : 'Register new gateway'}
          >
            <IconPlus size={14} /> New Gateway
          </button>
        </div>

        <div className="card-body">
      <div className="filter-bar">
        {/* Lifecycle is a filter like the rest; the counts are in the option labels. */}
        <select
          className="form-control"
          style={{ width: '150px' }}
          value={filterMode}
          onChange={e => setFilterMode(e.target.value)}
          title="Filter by lifecycle state"
        >
          <option value="all">All ({gateways.length})</option>
          <option value="active">Active ({gateways.filter(g => !g.is_archived).length})</option>
          <option value="archived">Archived ({gateways.filter(g => g.is_archived).length})</option>
        </select>

        <input
          className="form-control"
          style={{ width: '220px' }}
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Search name, UUID or Sparkplug ID…"
          title="Filter gateways by friendly name, internal UUID, or Sparkplug ID"
        />

        {/* Live status is derived from heartbeat age, not the stored `status` column -- a gateway
            that died without sending NDEATH still reads ONLINE in the database. */}
        <select className="form-control" style={{ width: '160px' }} value={liveStatusFilter} onChange={e => setLiveStatusFilter(e.target.value)} title="Filter by live heartbeat status (90s staleness threshold)">
          <option value="">Any status</option>
          <option value="ONLINE">Online</option>
          <option value="STALE">Stale</option>
          <option value="OFFLINE">Offline</option>
        </select>

        {/* Filters on the same value the Type column prints, through the same helper, so Simulated
            can be separated from the real host-run connectors. */}
        <select className="form-control" style={{ width: '160px' }} value={kindFilter} onChange={e => setKindFilter(e.target.value)} title="Filter by the Type column: Remote (an appliance on the plant network), Host (a connector inside this stack), or Simulated (host-run, readings generated)">
          <option value="">Any type</option>
          {SELECTABLE_TYPES.map(t => (
            <option key={t} value={t}>{gatewayTypeLabel(t)}</option>
          ))}
        </select>

        <button
          className={`btn btn-sm ${quarantineOnly ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setQuarantineOnly(v => !v)}
          title="Show only gateways currently reporting devices held in quarantine — points at the misconfigured edge node when several devices fail at once"
        >
          <IconShieldAlert size={13} /> Has quarantined devices ({gatewaysWithQuarantine.size})
        </button>

        {/* Shown only when one exists, like the Devices page's shadow toggle. */}
        {shadowGatewayCount > 0 && (
          <button
            className={`btn btn-sm ${showShadowGateways ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setShowShadowGateways(v => !v)}
            title="The Playback gateway (archived migration 0060). It publishes recorded captures as shadow devices and is not a connector to any machine, so it is hidden by default — but it stays reachable, because minting its broker credential is the one act an operator must perform on it."
          >
            <IconRadio size={13} /> Show playback gateway
          </button>
        )}

        {activeFilterCount > 0 && (
          <button className="btn btn-ghost btn-sm filter-bar-spacer" onClick={resetFilters} title="Clear every filter">
            <IconX size={13} /> Clear filters ({activeFilterCount})
          </button>
        )}

      </div>

        </div>{/* .card-body */}

        {loading ? <div className="loading-wrap"><div className="spinner" /> Loading gateways…</div> :
         filteredGateways.length === 0 ? (
           <div className="empty-state">
             <div className="empty-icon"><IconRadio size={36} /></div>
             <div className="empty-text">No gateways match the selected filter.</div>
           </div>
         ) : (
           <div className="table-wrap">
             <table>
               <thead>
                 <tr>
                   <th title="Human-readable gateway name">Gateway Name</th>
                   <th title="The gateway's database identifier -- the id to quote in a query, a ticket or an API call. Its Sparkplug edge node id is derived from this, so nothing is lost by showing it here.">Gateway UUID</th>
                   <th title="Where this gateway's connector runs, and whether its readings are real: Remote (an appliance on the plant network), Host (inside this stack), Simulated (host-run, readings generated), Shadow (republishes recorded captures)">Type</th>
                   <th title="Where this gateway serves: a cell, a whole area, or the whole site">Location</th>
                   <th title="Network connectivity status">Gateway Status</th>
                   <th title="Age of the last Sparkplug B node heartbeat (NBIRTH/NDATA/NDEATH)">Last Heartbeat</th>
                   <th title="Devices assigned to this gateway">Connected Devices</th>
                 </tr>
               </thead>
               <tbody>
                 {filteredGateways.map(g => {
                   const gwAssets = g.devices || []
                   const onlineCount = gwAssets.filter(a => a.status === 'ONLINE' || !a.status).length
                   const offlineCount = gwAssets.filter(a => a.status === 'OFFLINE').length
                   const liveStatus = gatewayLiveStatus(g)

                   return (
                     <React.Fragment key={g.gateway_id}>
                       {/* The row is both a selector and a container of buttons, so the click is
                           filtered -- see rowSelectHandler. Clicking Edit must not also select. */}
                       <tr
                         className={`row-selectable${selectedId === g.gateway_id ? ' row-selected' : ''}`}
                         style={{ background: g.is_archived ? 'rgba(255,179,0,0.06)' : undefined }}
                         onClick={rowSelectHandler(() => setSelectedId(id => id === g.gateway_id ? null : g.gateway_id))}
                         title="Click to inspect this gateway in the details panel"
                       >
                         <td>
                           <strong>{g.gateway_name}</strong>
                           {/* The kind of gateway is a column, and sorts. ARCHIVED stays a badge
                               because it is a state, not a kind: a gateway of any type can be
                               decommissioned. */}
                           {g.is_archived && (
                             <span className="badge badge-warning" style={{ background: 'rgba(255,179,0,0.15)', color: 'var(--warning-text)', border: '1px solid var(--warning)', marginLeft: '8px' }} title="Decommissioned gateway">
                               <IconArchive size={11} /> ARCHIVED
                             </span>
                           )}
                         </td>
                         <td><CopyableId value={g.gateway_id} label="Gateway UUID" onNotify={showToast} /></td>
                         <td>
                           <span
                             className={`badge badge-${gatewayTypeTone(gatewayType(g))}`}
                             style={{ fontSize: '11px' }}
                             title={gatewayTypeDescription(gatewayType(g))}
                           >
                             {gatewayTypeLabel(gatewayType(g))}
                           </span>
                         </td>
                         <td>
                           {/* Four states, and the first is that the question does not apply: a
                               synthetic gateway cannot hold a cell
                               (`gateways_synthetic_has_no_cell`), so its stored `location_scope` is
                               inert and is not printed. Site-Wide is still an answer for every
                               other gateway and must not read as the unanswered case. */}
                           {!gatewayAcceptsCell(g)
                             ? <span style={{ fontSize: '11px', color: 'var(--text-dim)' }} title={`${gatewayTypeLabel(gatewayType(g))} gateways have no cell: their devices resolve to the ${gatewayTypeLabel(gatewayType(g))} lane, which takes precedence over cell membership.`}>—</span>
                             : g.location_scope === SCOPE_SITE_WIDE
                               ? <span className="badge badge-neutral" style={{ fontSize: '11px' }} title="Serves the whole campus rather than one cell. Its devices need their own cell.">Site-Wide</span>
                               : g.location_scope === SCOPE_AREA_WIDE
                                 ? <span className="badge badge-neutral" style={{ fontSize: '11px' }} title={`Serves the whole of ${areas.find(ar => ar.area_id === g.area_id)?.area_name || 'its area'} rather than one cell. Its devices need their own cell.`}>Area-Wide</span>
                               : g.cell_id
                                 ? (cells.find(c => c.cell_id === g.cell_id)?.cell_name || <span className="mono">{g.cell_id}</span>)
                                 : <span style={{ fontSize: '11px', color: 'var(--warning-text)', fontStyle: 'italic' }} title="Devices on this gateway inherit no cell, so they land in the Unassigned queue">No cell</span>}
                         </td>
                         <td>
                           {g.is_archived ? (
                             <span className="badge badge-warning" style={{ background: 'rgba(255,179,0,0.15)', color: 'var(--warning-text)' }}>DECOMMISSIONED</span>
                           ) : (
                             <StatusBadge status={liveStatus} />
                           )}
                         </td>
                         <td
                           style={{ fontSize: '11px', color: liveStatus === 'STALE' ? 'var(--warning)' : 'var(--text-muted)' }}
                           title={g.last_heartbeat ? new Date(g.last_heartbeat).toLocaleString() : 'No Sparkplug B node message has ever been received from this edge node'}
                         >
                           {formatHeartbeat(g.last_heartbeat)}
                         </td>
                         <td>
                           {g.is_archived ? (
                             <span className="badge badge-neutral">Archived (Inaccessible)</span>
                           ) : gwAssets.length === 0 ? (
                             <span style={{ fontSize: '11px', color: 'var(--text-dim)', fontStyle: 'italic' }}>No devices assigned</span>
                           ) : (
                             /* Collapsed past three, as the Devices Type column is. The Online /
                                Offline summary is pinned because it is the question the column
                                answers; a QUARANTINED device is pinned because it calls for action. */
                             <TagList
                               limit={3}
                               tags={[
                                 {
                                   key: '__summary__',
                                   priority: true,
                                   className: 'badge badge-neutral',
                                   title: 'Connected devices breakdown',
                                   content: `${onlineCount} Online / ${offlineCount} Offline`
                                 },
                                 ...gwAssets.map(a => ({
                                   key: a.asset_id,
                                   // The tooltip on "+N" lists names, not the UUIDs these are keyed by.
                                   label: a.asset_name,
                                   priority: a.is_quarantined,
                                   className: `badge ${a.status === 'OFFLINE' ? 'badge-neutral' : 'badge-online'}`,
                                   style: { fontSize: '11px' },
                                   title: `${a.asset_name} — ${a.is_quarantined ? 'QUARANTINED' : a.status || 'ONLINE'}`,
                                   content: `${a.asset_name}${a.is_quarantined ? ' (quarantined)' : ''}`
                                 }))
                               ]}
                             />
                           )}
                         </td>
                       </tr>
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
          <div className="modal">
            <div className="modal-title">{editing ? 'Edit Gateway' : 'Register Gateway'}</div>
            {/* The identifiers are facts, not fields, and live on the context drawer where they are
                copyable. */}
            <div className="form-group">
              <label className="form-label">Gateway Name</label>
              <input className="form-control" value={form.gateway_name} onChange={e => setForm(f => ({ ...f, gateway_name: e.target.value }))} title="Friendly label for this gateway" placeholder="e.g. Sim_Gateway_Cell1_Machining" />
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                A display label only — rename it freely. Heartbeats are matched on the Sparkplug ID, which is generated from the database key and never moves.
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Description</label>
              <textarea
                className="form-control"
                rows={2}
                value={form.description || ''}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                title="Optional free-text note about this gateway"
                placeholder="e.g. Panel-mounted IPC in the machining cell, north wall"
              />
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                Optional, and read by nothing — a note for whoever comes to this next.
              </div>
            </div>
            {/* One control, not two checkboxes: `gateways_simulated_is_host` forbids a remote
                simulator, so a select over the legal states cannot express the refused one
                (utils/gatewayType.js). It comes before the cell zone because it governs it. */}
            <div className="form-group">
              <label className="form-label" htmlFor="gateway-type">Type</label>
              <select
                id="gateway-type"
                className="form-control"
                value={formType}
                onChange={e => setForm(f => ({
                  ...f,
                  ...gatewayTypeFields(e.target.value),
                  // Cleared here rather than left for the save: `gateways_synthetic_has_no_cell`
                  // refuses a simulated gateway holding a cell, and the offending field is disabled
                  // below.
                  ...(e.target.value === GATEWAY_TYPES.SIMULATED
                    ? { cell_id: '', area_id: '', location_scope: SCOPE_CELL }
                    : {})
                }))}
                title="Where this gateway's connector runs, and whether its readings are real"
              >
                {SELECTABLE_TYPES.map(t => (
                  <option key={t} value={t}>{gatewayTypeLabel(t)}</option>
                ))}
              </select>
            </div>
            {/* The consequence, said before it is chosen: Remote means a bundle to download and
                hardware to run it on. Shown for every type, since the Simulated description is
                about what the readings are. */}
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '-6px', marginBottom: '12px' }}>
              {gatewayTypeDescription(formType)}
              {remoteWithheld
                ? <> <strong style={{ color: 'var(--warning-text)' }}>This deployment cannot issue a bundle yet:</strong> {enrolmentProblems.join('; ')}. Save is withheld for a Remote gateway until it can; Host and Simulated are unaffected.</>
                : !editing && formType === GATEWAY_TYPES.REMOTE
                  && ' On save you will be given a bundle to copy to that machine; it enrols itself and appears here as online.'}
            </div>
            {/* One exclusive choice of scope, then the cell or the area it calls for. The
                scopes are exclusive by CHECK (`gateways_site_wide_has_no_cell` and the area-wide
                pair), which is what a radio group says. Reads as In a cell with none chosen for
                a synthetic gateway whatever is stored: `device_locations` resolves `simulated`
                ahead of the stored scope. A display fallback, not a write; clearing happens only
                on the type change that would make the row unsavable. */}
            <div className="form-group">
              <label className="form-label">Location</label>
              <LocationPicker
                idPrefix="gateway"
                form={form}
                onChange={fields => setForm(f => ({ ...f, ...fields }))}
                cells={cells}
                areas={areas}
                disabled={!formAcceptsCell}
                title={formAcceptsCell
                  ? undefined
                  : 'A simulated gateway belongs to the Simulated lane, which resolves ahead of any cell'}
                cellEmptyLabel="— No cell assigned —"
                cellTitle="Cell this gateway serves — its devices inherit this cell unless they carry one of their own"
              />

              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
                {!formAcceptsCell
                  /* Says which lane it lands in instead, so the disabled control reads as an
                     answer already given rather than as a field that failed to load. */
                  ? 'Simulated gateways have no cell: their devices resolve to the Simulated lane, which takes precedence over cell membership. gateways_synthetic_has_no_cell (0059) refuses the pairing outright.'
                  : form.location_scope === SCOPE_SITE_WIDE || form.location_scope === SCOPE_AREA_WIDE
                    ? 'Its devices inherit nothing from it, so each one needs its own cell — or its own Site-Wide or Area-Wide mark. Scope is not inherited: a machine reached through a host-run connector is still in a cell.'
                    : form.cell_id
                      ? 'Devices served by this gateway appear under this cell, unless a device carries a cell of its own.'
                      : null}
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Gateway Access URL (Optional UI Console)</label>
              <input className="form-control" value={form.access_url || ''} onChange={e => setForm(f => ({ ...f, access_url: e.target.value }))} placeholder="e.g. http://localhost:1880" title="Web Console / Management URL for this gateway" />
            </div>
            {proposeMode && (
              <div className="form-group">
                <label className="form-label" htmlFor="gw-propose-rationale">Why (optional)</label>
                <textarea
                  id="gw-propose-rationale"
                  className="form-control"
                  rows={2}
                  value={form.__rationale || ''}
                  onChange={e => setForm(f => ({ ...f, __rationale: e.target.value }))}
                  placeholder="e.g. this gateway moved to the finishing cell in March"
                />
              </div>
            )}

            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => { setShowForm(false); setEditingProposal(null) }} disabled={saving} title="Cancel">Cancel</button>
              <ActionButton
                pending={saving}
                pendingLabel={proposeMode ? 'Proposing…' : editing ? 'Saving…' : 'Creating…'}
                onClick={() => runSave(save)}
                // Area-Wide with no area named would be refused by the database; held here.
                disabled={locationIncomplete(form) || remoteWithheld}
                title={remoteWithheld
                  ? 'Remote gateways cannot be enrolled on this deployment yet'
                  : locationIncomplete(form)
                  ? 'Choose which area the gateway serves'
                  : proposeMode
                    ? 'Ask for these changes — an approver applies them, or says why not'
                    : 'Save gateway configuration'}
              >
                {proposeMode ? (editingProposal ? 'Update your proposal' : 'Propose a change') : 'Save'}
              </ActionButton>
            </div>
          </div>
        </div>
      )}

      {archiveTarget && (
        <ArchiveModal
          entityType="gateways" entityId={archiveTarget.gateway_id} displayName={archiveTarget.gateway_name}
          onArchive={archiveGateway} onCancel={() => setArchiveTarget(null)}
        />
      )}

      {docsForGw && (
        <EntityLinksModal entityType="gateway" entityId={docsForGw.gateway_id} entityName={docsForGw.gateway_name} onClose={() => setDocsForGw(null)} showToast={showToast} hasPermission={hasPermission} />
      )}
      </div>

      <ContextPanel
        open={!!selected}
        onClose={() => setSelectedId(null)}
        type="GATEWAY"
        onCopy={showToast}
        title={selected?.gateway_name || ''}
        subtitle={selected && (
          <>
            <StatusBadge status={gatewayLiveStatus(selected)} />
            {selected.deployment === 'host' && <span className="badge badge-neutral" style={{ fontSize: '11px' }}>HOST-RUN</span>}
            {selected.is_simulated && <span className="badge badge-neutral" style={{ fontSize: '11px' }} title="Telemetry from this gateway is generated, not observed">SIMULATED</span>}
            {selected.is_archived && <span className="badge badge-warning" style={{ fontSize: '11px' }}>ARCHIVED</span>}
          </>
        )}
        fields={selected ? [
          { label: 'Gateway UUID', value: selected.gateway_id, mono: true, copyable: true },
          // The id it publishes under, which is what a Sparkplug trace or an MQTT subscription is
          // keyed on -- and the one identifier here that is not the UUID above it.
          { label: 'Sparkplug Edge Node ID', value: selected.sparkplug_id || gatewaySparkplugId(selected.gateway_id), mono: true, copyable: true },
          {
            // The real group id where the gateway carries one, so the topic can be pasted into an
            // MQTT client. Falls back to `+` only where the group is unrecorded.
            label: 'Sparkplug Topic Path',
            value: `spBv1.0/${selected.sparkplug_group || '+'}/NDATA/${selected.sparkplug_id || gatewaySparkplugId(selected.gateway_id)}`,
            mono: true,
            copyable: true,
            title: selected.sparkplug_group
              ? 'The NDATA topic this edge node publishes on.'
              : 'The NDATA topic this edge node publishes on. No Sparkplug group is recorded for it, so that segment is a wildcard.'
          },
          {
            label: 'Location',
            // A link when there is a cell to open. Site-Wide stays plain text: it asserts the
            // gateway belongs to no cell. Same three-way as the column, since on a synthetic
            // gateway the stored scope is inert.
            value: !gatewayAcceptsCell(selected)
              ? `${gatewayTypeLabel(gatewayType(selected))} — no cell`
              : selected.location_scope === SCOPE_SITE_WIDE
                ? 'Site-Wide'
                : selected.location_scope === SCOPE_AREA_WIDE
                  ? `Area-Wide — ${areas.find(ar => ar.area_id === selected.area_id)?.area_name || selected.area_id}`
                : selectedCell
                  ? (
                      <button
                        className="chip chip-link"
                        onClick={() => onSelectCell?.(selectedCell.cell_id)}
                        title="Open this cell on the Cells page"
                      >
                        <IconLayoutDashboard size={11} />
                        <span className="chip-name">{selectedCell.cell_name}</span>
                      </button>
                    )
                  : (selected.cell_id || null),
            title: !gatewayAcceptsCell(selected)
              ? `Its devices resolve to the ${gatewayTypeLabel(gatewayType(selected))} lane, which takes precedence over cell membership. gateways_synthetic_has_no_cell (0059) refuses the pairing.`
              : selected.location_scope === SCOPE_SITE_WIDE
                ? 'A host-run or central connector serving the whole campus. Its devices inherit no cell from it.'
                : selected.location_scope === SCOPE_AREA_WIDE
                  ? 'A connector serving one whole area. Its devices inherit no cell from it.'
                  : 'Devices served by this gateway resolve to this cell unless they carry one of their own.'
          },
          { label: 'Last Heartbeat', value: formatHeartbeat(selected.last_heartbeat), title: 'Age of the last NBIRTH/NDATA/NDEATH. STALE after 90 seconds of silence.' },
          /**
           * What the appliance says about itself. Shown only once `health_reported_at` is set: a
           * gateway that never reported is virtual or on an older bundle, and six rows of dashes
           * would read as six faults. Current values with no history; the trend is in Grafana's
           * Gateway Fleet Health dashboard.
           */
          ...(selected.health_reported_at ? [
            {
              label: 'Health Reported',
              value: formatHeartbeat(selected.health_reported_at),
              title: 'Age of the last heartbeat that carried appliance health. Separate from Last '
                + 'Heartbeat on purpose: a gateway can keep beating while its collector has stopped.'
            },
            /**
             * The root this appliance holds, beside the one the platform publishes. Behind means
             * it has not converged since the root was re-issued; the broker's leaf must not be
             * switched to the new root until nothing is behind.
             */
            {
              label: 'CA Expires',
              value: [
                formatCertExpiry(selected.cert_expires_at),
                holdsOlderRoot(selected.cert_expires_at, enrolment?.ca?.not_after)
                  ? 'holds an older root' : null,
              ].filter(Boolean).join(' — ') || null,
              danger: isCertExpiring(selected.cert_expires_at)
                || holdsOlderRoot(selected.cert_expires_at, enrolment?.ca?.not_after),
              title: 'When the broker root THIS appliance trusts expires, as it reported. The '
                + 'platform publishes the current root to every appliance and each installs it at '
                + 'its next hourly convergence, so a gateway can be behind for an hour by design'
                + (enrolment?.ca?.not_after
                  ? `. The platform's root expires ${new Date(enrolment.ca.not_after).toISOString().slice(0, 10)}`
                  : '')
                + `. Grafana alerts at ${CERT_EXPIRY_WARN_DAYS} days.`
            },
            {
              label: 'Disk Free',
              value: formatBytes(selected.disk_free_bytes),
              title: 'Free space on the appliance\'s root filesystem, from node_exporter. An '
                + 'appliance that fills its disk stops publishing and reports nothing about why.'
            },
            {
              label: 'Memory Available',
              value: formatBytes(selected.mem_available_bytes),
              title: 'Host MemAvailable -- available rather than free, so it counts reclaimable '
                + 'cache. That is the number that predicts whether an allocation will succeed.'
            },
            {
              label: 'Load (1m)',
              value: selected.load_1m === null || selected.load_1m === undefined
                ? null
                : Number(selected.load_1m).toFixed(2),
              title: 'Host 1-minute load average. NOT normalised by core count -- compare this '
                + 'gateway against itself over time, not against another gateway.'
            },
            {
              label: 'Runtime Uptime',
              value: selected.uptime_seconds === null || selected.uptime_seconds === undefined
                ? null
                : formatHeartbeat(new Date(Date.now() - selected.uptime_seconds * 1000).toISOString())
                  .replace(' ago', ''),
              title: 'How long the appliance\'s Node-RED runtime has been up. PROCESS uptime, not '
                + 'host uptime: a restarted container resets it while the machine stays up.'
            },
            {
              label: 'Bundle',
              value: selected.agent_version || null,
              title: 'The bundle version the appliance reports. Refreshed on every heartbeat since '
                + '0035, so an appliance upgraded in place shows its new version without '
                + 're-enrolling.'
            },
            /**
             * The drift check. `flow_hash` is what the appliance last deployed, reported on every
             * heartbeat from the record flow-sync.mjs writes; `forge_head_flow_sha256` is the
             * same digest at the head of main, recorded by forge-events on every push. Equal is
             * convergence; different inside two sync intervals of the push is the puller not
             * having ticked yet; beyond that it is drift, and `docker compose logs flow-sync` on
             * the appliance says why (a refused commit, an unreachable forge).
             */
            {
              label: 'Flow',
              value: selected.flow_hash
                ? [selected.flow_hash.slice(0, 12), flowDriftLabel(flowDriftState(selected))].filter(Boolean).join(' · ')
                : null,
              danger: isFlowDrift(flowDriftState(selected)),
              title: 'First 12 characters of the SHA-256 of the flow this appliance last deployed, '
                + 'compared with the same digest at the head of main. "matches main" is '
                + 'convergence. "main moved, deploying" is a push younger than '
                + `${FLOW_DRIFT_GRACE_MS / 60000} minutes that the appliance has not pulled yet. `
                + '"differs from main" past that is drift: the appliance refused the commit or '
                + 'cannot reach the forge, and its flow-sync log says which. An edit made in the '
                + 'Node-RED editor is not reflected here; the next approved deploy overwrites it.'
            },
            /**
             * Where main is, from the forge: forge-events records it on every push. The Flow row
             * above is the comparison against it.
             */
            {
              label: 'Committed',
              value: selected.forge_head_sha
                ? `${selected.forge_head_sha.slice(0, 12)} · ${formatHeartbeat(selected.forge_head_at)}`
                : null,
              title: 'The head of main in this gateway\'s repository, as the forge reported it on '
                + 'the last push'
                + (selected.forge_head_message ? `: "${selected.forge_head_message}"` : '')
                + (selected.forge_head_by ? ` by ${selected.forge_head_by}` : '')
                + '. The appliance deploys it on its next tick. Empty until the first push after '
                + 'the repository got its webhook.'
            },
            /**
             * What the appliance says it is running, from the head of its own branch: forge-events
             * records it on every push there, and only the appliance's key can push there. The
             * flows.json on that branch is the one Node-RED is running, so a digest that differs
             * from the heartbeat's is an edit made in the appliance's editor since the last deploy.
             */
            {
              label: 'Reported',
              value: selected.forge_appliance_sha
                ? [
                  `${selected.forge_appliance_sha.slice(0, 12)} · ${formatHeartbeat(selected.forge_appliance_at)}`,
                  flowEditedOnAppliance(selected) ? 'edited on the appliance' : null,
                ].filter(Boolean).join(' · ')
                : null,
              danger: flowEditedOnAppliance(selected) === true,
              title: 'The head of the appliance branch in this gateway\'s repository: the flow and '
                + 'the deploy record the appliance last pushed, which only its own key can do. '
                + '"edited on the appliance" means the running flow differs from the one the puller '
                + 'last deployed: somebody changed it in the appliance\'s editor, and the next '
                + 'approved deploy overwrites that. The repository panel links the forge\'s diff '
                + 'between the two branches. Empty until the appliance has reported once.'
            },
            /**
             * What the last hourly convergence did, from converged.json on the same branch (0106).
             * The platform half says which version of the playbook this appliance is actually on,
             * which is how a fleet mid-rollout is read one gateway at a time.
             */
            {
              label: 'Platform',
              value: selected.forge_appliance_platform_tag
                ? [
                  selected.forge_appliance_platform_tag,
                  selected.forge_appliance_platform_outcome === 'converged'
                    ? `converged ${formatHeartbeat(selected.forge_appliance_converged_at)}`
                    : selected.forge_appliance_platform_outcome,
                ].filter(Boolean).join(' · ')
                : null,
              danger: Boolean(selected.forge_appliance_platform_outcome)
                && selected.forge_appliance_platform_outcome !== 'converged',
              title: 'The platform playbook tag this appliance last converged to, and how that run '
                + 'ended. It converges hourly and after boot. "failed" means ansible-pull did not '
                + 'complete and the timer will try again; the appliance\'s own journal '
                + '(journalctl -u acs-gateway-converge) says why. The tag is changed by a pull '
                + 'request on platform.yml in this gateway\'s repository, so a fleet mid-rollout '
                + 'shows different tags here. Empty on an appliance that runs the bundle alone.'
            },
            /**
             * The failure this lane is most likely to produce and least likely to notice: a
             * bespoke adapter is a container on somebody else's hardware with no heartbeat of its
             * own, and a gateway whose adapter is crash-looping still publishes and reads ONLINE.
             */
            {
              label: 'Custom',
              value: selected.forge_appliance_custom_outcome
                ? [
                  selected.forge_appliance_custom_outcome,
                  selected.forge_appliance_custom_revision
                    ? `at ${selected.forge_appliance_custom_revision.slice(0, 7)}`
                    : null,
                ].filter(Boolean).join(' ')
                : null,
              danger: selected.forge_appliance_custom_outcome === 'failed',
              title: 'How this gateway\'s own custom.yml ended on the last convergence, and the '
                + 'commit it ran from. A gateway whose repository carries a playbook of its own -- '
                + 'a bespoke adapter for machinery no standard node reaches -- runs it after the '
                + 'platform playbook. "failed" is the adapter not running: the gateway keeps '
                + 'publishing everything else, so nothing else here turns amber. Empty when this '
                + 'repository carries no playbook of its own.'
            },
          ] : []),
          {
            label: 'Description',
            value: selected.description || null,
            full: true,
            title: 'Operator note. Free text, read by nothing.'
          },
        ] : []}
        actions={selected ? [
          /**
           * Ask the node to restate its birth certificate: `Node Control/Rebirth` republishes the
           * metric list, datatypes and alias table. The only command this dashboard sends; metric
           * writes over NCMD are actuation and are deliberately not reachable from here. Not on an
           * archived gateway, and not on the shadow gateway, whose playback worker only publishes
           * and holds no subscription.
           */
          !selected.is_archived && !selected.is_shadow && canManage && {
            label: 'Request Rebirth',
            icon: <IconRefreshCw size={13} />,
            title: 'Ask this edge node to republish its birth certificate. Harmless — it restates '
              + 'the metric names and aliases it already publishes, and briefly appears in the live '
              + 'stream for every subscriber. The daemon sends it within a few seconds.',
            onClick: () => runRebirth(selected.gateway_id, async () => {
              try {
                await api.requestRebirth(selected.gateway_id)
                showToast(`Rebirth requested for '${selected.gateway_name}'. The daemon sends it within a few seconds.`, 'success')
              } catch (err) {
                showToast(err.message, 'error')
              }
            }),
            pending: rebirthingId === selected.gateway_id,
            pendingLabel: 'Requesting…'
          },
          /**
           * Setup comes first while it is unfinished, above Launch UI and Edit; shown for
           * AWAITING_BIRTH too, so an appliance that enrolled and never published can be re-issued.
           * Absent once ONLINE, since re-issuing invalidates a working credential. Confirms first
           * on this route, unlike the one straight after creation, because this gateway may already
           * hold a live token.
           */
          !selected.is_archived && selected.deployment === 'remote' && isGatewayPending(selected) && canManage && {
            label: selected.status === 'AWAITING_BIRTH' ? 'Re-issue Bundle' : 'Download Setup Bundle',
            icon: <IconDownload size={13} />,
            primary: true,
            // Withheld, not hidden, while the deployment cannot issue one: the notice above the
            // table says why, and the action returns when it can.
            disabled: enrolmentBlocked,
            onClick: () => setBundleForGw({
              gateway_id: selected.gateway_id,
              gateway_name: selected.gateway_name,
              sparkplug_id: selected.sparkplug_id,
              status: selected.status,
              confirmFirst: true
            }),
            title: enrolmentBlocked
              ? 'Remote gateways cannot be enrolled on this deployment yet'
              : selected.status === 'AWAITING_BIRTH'
                ? 'This appliance enrolled but has not published. Re-issuing invalidates its current credential.'
                : 'Generate the bootstrap bundle for this gateway and download it'
          },
          /* The host-run counterpart, mirrored: `deployment === 'host'` and no
             `isGatewayPending()`, because a host-run gateway has no enrolment lifecycle. Not on an
             archived gateway, since a credential minted then would resurrect the row. This is the
             only place a password appears in the product, so the modal confirms unconditionally. */
          !selected.is_archived && selected.deployment === 'host' && canManage && {
            label: 'Generate Broker Credential',
            icon: <IconLock size={13} />,
            primary: true,
            onClick: () => setCredentialForGw({
              gateway_id: selected.gateway_id,
              gateway_name: selected.gateway_name,
              sparkplug_id: selected.sparkplug_id
            }),
            // Named by the condition the action is gated on, `deployment === 'host'`: no appliance,
            // so the credential is minted in the browser.
            title: 'Mint this host-run gateway a broker account and show the password once. A Remote gateway enrols itself instead, and its credential never reaches a browser.'
          },
          selected.access_url && {
            label: 'Launch UI', icon: <IconExternalLink size={13} />, href: selected.access_url, primary: true,
            title: 'Open this gateway’s own console — Node-RED for a host-run connector, the appliance’s web UI for a Remote one'
          },
          // Restore REPLACES Edit on an archived gateway: editing one is refused anyway, and
          // Restore is the only action that means anything there.
          selected.is_archived ? {
            label: 'Restore Gateway', icon: <IconRefreshCw size={13} />,
            onClick: () => runRestore(selected.gateway_id, () => restoreGateway(selected.gateway_id, selected.gateway_name)),
            pending: restoringId === selected.gateway_id,
            pendingLabel: 'Restoring…',
            disabled: !canArchive,
            primary: !selected.access_url,
            title: !canArchive ? 'Requires Admin permissions' : 'Restore gateway back to active service'
          } : !selected.is_shadow && {
            /* Withdrawn from the playback gateway: `gateways_shadow_is_simulated` refuses two of
               the three Type options on this row, and nothing else on it needs editing. Renaming is
               possible from the database. */
            label: proposeMode ? 'Propose a Change' : 'Edit Details', icon: <IconPencil size={13} />,
            onClick: () => {
              setEditing(selected)
              const mine = proposeMode
                ? openProposals.find(pr => pr.entity_type === 'gateways' && pr.entity_id === selected.gateway_id)
                : null
              setEditingProposal(mine || null)
              // The picker wants '' for no area, not null.
              setForm({ ...selected, area_id: selected.area_id || '', ...formFromPatch('gateway', mine?.patch) })
              setShowForm(true)
            },
            disabled: !canManage && !canPropose,
            title: proposeMode
              ? 'Ask for a change to this gateway — an approver applies it, or says why not'
              : !canManage && !canPropose
                ? 'Requires Admin permissions'
                : 'Edit gateway configuration'
          },
          /* Withheld from a reader who may not open the page: the nav hides Digital Thread without
             `digital_thread:read`. `.filter(Boolean)` drops it. */
          canReadThread && {
            label: 'View Digital Thread', icon: <IconHistory size={13} />,
            onClick: () => onViewThread?.(selected),
            title: 'Open the immutable audit trace for this gateway'
          },
          {
            label: 'Attached Links', icon: <IconBookOpen size={13} />,
            onClick: () => setDocsForGw(selected),
            title: 'Attach or edit links for this gateway — documents, an asset register, a file repository, any URL'
          },
          /* Not offered for the playback gateway; the database refuses it as well. Archiving the
             last shadow gateway would leave playback with no edge node, failing weeks later when a
             job starts. */
          !selected.is_archived && !selected.is_shadow && {
            label: 'Archive Gateway', icon: <IconArchive size={13} />,
            onClick: () => setArchiveTarget(selected),
            disabled: !canArchive,
            danger: true,
            title: !canArchive ? 'Requires Admin permissions' : 'Decommission & Archive Gateway'
          },
        ].filter(Boolean) : []}
        /* With the metadata, above the actions: which devices is a fact about this gateway. */
        beforeActions={selected && (
          <div>
            <div className="context-panel-section-label">Connected Devices ({selectedDevices.length})</div>
            {selectedDevices.length === 0
              ? <div className="context-field-empty" style={{ fontSize: '11px' }}>No devices assigned</div>
              : (
                /* Chips that navigate, matching the Cell Zone and Schema chips elsewhere in this
                   drawer. The lifecycle state is a dot rather than the chip's colour, because
                   status colour would collide with `chip-link`'s hover. */
                <div className="context-device-list">
                  {selectedDevices.map(d => {
                    const status = deviceLifecycleStatus(d)
                    return (
                      <button
                        key={d.asset_id}
                        className="chip chip-link"
                        onClick={() => onSelectDevice?.(d.asset_id)}
                        title={`Open ${d.asset_name} on the Devices page — ${alertForDevice(alerts, d) ? `ALERT: ${alertForDevice(alerts, d).alert_name}` : deviceStatusTitle(status)}`}
                      >
                        <span className="badge-dot" style={{ background: deviceDotColor(d, alertForDevice(alerts, d)) }} />
                        <span className="chip-name">{d.asset_name}</span>
                      </button>
                    )
                  })}
                </div>
              )}

            {/* With the device list: what this appliance is asked to run is a fact about the
                gateway. Withheld from an archived gateway, and rendered as nothing for a role the
                forge would refuse. */}
            {!selected.is_archived && (
              <div style={{ marginTop: '14px' }}>
                <GatewayRepositoryPanel
                  gateway={selected}
                  canOpenForge={canOpenForge}
                />
              </div>
            )}

            {/* The capture library lives on the Capture page, where captures are filed by subject
                (gateway or device) with note, message count and manifest. */}
          </div>
        )}
      />

      {credentialForGw && (
        <GatewayCredentialModal
          gateway={credentialForGw}
          onClose={() => setCredentialForGw(null)}
          showToast={showToast}
        />
      )}

      {bundleForGw && (
        <GatewayBundleModal
          gateway={bundleForGw}
          confirmFirst={bundleForGw.confirmFirst}
          onClose={() => { setBundleForGw(null); load() }}
          showToast={showToast}
          // Whether this deployment can mint the one-liner, from the same readiness answer that
          // says whether it can enrol at all. Null until asked; the modal then offers the bundle.
          installer={enrolment?.installer || null}
        />
      )}
    </div>
  )
}
