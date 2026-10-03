import React, { useState, useEffect, useCallback } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS, REALTIME_ENABLED, STALENESS_TICK_MS, refreshInterval } from '../../constants'
import { usePolling } from '../../hooks/usePolling'
import { requiresRolesTitle } from '../../hooks/usePermissions'
import { useRealtimeTable } from '../../hooks/useRealtimeTable'
import { useClockTick } from '../../hooks/useClockTick'
import {
  gatewayDisplayStatus, isGatewayOnline, isGatewayPending, formatHeartbeat, formatUptime,
  formatCertExpiry, isCertExpiring, holdsOlderRoot, formatBytes, CERT_EXPIRY_WARN_DAYS
} from '../../utils/gatewayStatus'
import { gatewaySparkplugId } from '../../utils/sparkplugId'
import {
  GATEWAY_TYPES, SELECTABLE_TYPES, LISTED_TYPES, gatewayType, gatewayTypeFields,
  gatewayTypeLabel, gatewayTypeDescription, gatewayTypeTone,
} from '../../utils/gatewayType'
import { deviceLifecycleStatus, deviceStatusTitle, deviceDotColor } from '../../utils/deviceStatus'
import { alertIndex, alertForDevice } from '../../utils/deviceAlerts'
import { SCOPE_CELL, SCOPE_AREA_WIDE, SCOPE_SITE_WIDE, gatewayAcceptsCell } from '../../utils/cellResolution'
import { isShadowGateway } from '../../utils/fleetCounts'
import { flowDriftState, flowDriftLabel, isFlowDrift, flowEditedOnAppliance, FLOW_DRIFT_GRACE_MS } from '../../utils/flowDrift'
import { LocationPicker, locationIncomplete } from '../common/LocationPicker'
import CopyableId from '../common/CopyableId'
import { TagList } from '../common/TagList'
import { StatusBadge } from '../common/StatusBadge'
import { Badge, ArchivedBadge } from '../common/Badge'
import { SearchInput } from '../common/SearchInput'
import { ClearFilters } from '../common/ClearFilters'
import { EmptyState } from '../common/EmptyState'
import { LoadingState } from '../common/LoadingState'
import { Modal } from '../common/Modal'
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
  IconAlertTriangle,
  IconLayoutDashboard,
  IconDownload,
  IconLock
} from '../common/Icons'
import { CardHeading } from '../common/CardHeading'
import { useArrivalSelection } from '../../hooks/useArrivalSelection'

export function GatewaysTab({ showToast, onViewTrail, onSelectCell, onSelectDevice, hasPermission, userRole, initialSearchFilter, onClearFilter, activeAlerts = [] }) {
  /** Devices Grafana currently has an alert firing on -- see utils/deviceAlerts.js (issue #34). */
  const alerts = React.useMemo(() => alertIndex(activeAlerts), [activeAlerts])
  const [gateways, setGateways] = useState([])
  const [assets, setAssets]     = useState([])
  const [cells, setCells]       = useState([])
  const [loading, setLoading]   = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing]   = useState(null)
  const [archiveTarget, setArchiveTarget] = useState(null)
  // The drawer holds an id, not the object: resolving it every render keeps it as live as the row.
  const [selectedId, setSelectedId] = useState(null)
  // `location_scope` defaults to 'cell'. `deployment` is where the connector runs, not where its
  // devices are; 'remote' is the default because it is the type that needs setup.
  const blank = { gateway_id: '', gateway_name: '', status: 'OFFLINE', deployment: 'remote', is_simulated: false, access_url: '', cell_id: '', area_id: '', location_scope: SCOPE_CELL }
  const [areas, setAreas]       = useState([])
  const [form, setForm]         = useState(blank)
  // Derived: the form carries `deployment` and `is_simulated` (what the API takes); the select one word.
  const formType = gatewayType(form)
  // Derived off the two flags: a simulated gateway cannot hold a cell.
  const formAcceptsCell = gatewayAcceptsCell(form)
  const [docsForGw, setDocsForGw] = useState(null)
  // The gateway whose setup dialog is open, held as the object: the dialog stays open across a poll.
  const [bundleForGw, setBundleForGw] = useState(null)
  // The Host and Simulated counterpart to bundleForGw: only this one puts a password on screen.
  const [credentialForGw, setCredentialForGw] = useState(null)
  // Whether this deployment can enrol an appliance, from gateway-bundle's GET. null until answered
  // or when the probe failed: an unknown never blocks.
  const [enrolment, setEnrolment] = useState(null)
  const [filterMode, setFilterMode] = useState('active')

  const getInitialSearch = () => {
    const params = new URLSearchParams(window.location.search)
    return params.get('search') || initialSearchFilter || ''
  }

  const [searchQuery, setSearchQuery] = useState(getInitialSearch)
  const [liveStatusFilter, setLiveStatusFilter] = useState('')
  const [kindFilter, setKindFilter] = useState('')
  const [quarantineOnly, setQuarantineOnly] = useState(false)

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
    setFilterMode('active')
    handleClearSearch()
  }

  const load = useCallback(async (signal) => {
    try {
      // Each gateway arrives with its devices embedded; the flat device list surfaces the unassigned.
      const [g, a, c, ar] = await Promise.all([
        api.get('/api/v1/gateways', { signal }),
        api.get('/api/v1/devices', { signal }),
        api.get('/api/v1/cells', { signal }),
        // Tolerated: without it the picker simply offers no Area-Wide entries.
        api.get('/api/v1/areas', { signal }).catch(() => [])
      ])
      setGateways(g); setAssets(a); setCells(c); setAreas(ar)

      // This person's open proposals, so the edit dialog can seed from an open patch. Optional.
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

  // Realtime is debounced by the hook: `last_heartbeat` is stamped on every node message, so this
  // is the busiest subscription in the app.
  usePolling(load, refreshInterval())
  useRealtimeTable(['gateways', 'devices', 'cells'], load, { enabled: REALTIME_ENABLED })
  // Staleness is derived from the clock and a quiet gateway produces no event. Re-renders only.
  useClockTick(STALENESS_TICK_MS)

  // In-flight state for the form's Save and for whichever gateway is restoring.
  const [saving, runSave] = usePendingAction()
  const [restoringId, runRestore] = usePendingKey()
  // Keyed: a bare boolean would spin the button of whichever gateway is selected when the request settles.
  const [rebirthingId, runRebirth] = usePendingKey()

  const save = async () => {
    try {
      // Proposing changes an existing gateway only: registering one issues setup, which cannot be queued.
      if (proposeMode) {
        if (!editing) throw new Error(`${requiresRolesTitle(PERMISSION_UUIDS.GATEWAY_MANAGE)} to register a gateway.`)
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

      // A Remote gateway needs setup on a machine before it can publish, so the setup dialog opens at
      // once and issues without confirming: the row is seconds old, so there is nothing to replace.
      if (form.deployment === 'remote') {
        setBundleForGw({
          gateway_id: created.id || created.gateway_id,
          gateway_name: created.name || form.gateway_name,
          sparkplug_id: created.sparkplug_id,
          confirmFirst: false
        })
        showToast('Remote gateway created — issue its install command, or a bundle, to finish setup', 'success')
      } else {
        showToast('Gateway created', 'success')
      }
    } catch (e) { showToast(e.message, 'error') }
  }

  const archiveGateway = async (days) => {
    try {
      await api.post(`/api/v1/gateways/${archiveTarget.gateway_id}/archive`, { auto_delete_days: days })
      // Closes after the request, so ArchiveModal holds its pending state for the whole round trip.
      setArchiveTarget(null); load(); showToast(`Gateway '${archiveTarget.gateway_name}' archived`, 'success')
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
  const canReadTrail = hasPermission(PERMISSION_UUIDS.AUDIT_TRAIL_READ)
  const canPropose = hasPermission(PERMISSION_UUIDS.PROPOSAL_CREATE)

  // One form, two endings (utils/proposeFromForm.js): derived, so it cannot disagree with the permission.
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
  // Save is withheld for a gateway that would need setup this deployment cannot issue: a new Remote
  // one, or an existing gateway moved to Remote. Renaming a Remote gateway is not that.
  const remoteWithheld = !proposeMode && enrolmentBlocked && formType === GATEWAY_TYPES.REMOTE
    && (!editing || editing.deployment !== 'remote')
  const [editingProposal, setEditingProposal] = useState(null)
  const [openProposals, setOpenProposals] = useState([])
  const withheldFields = nonProposableFields('gateway')

  /** The note under a field a proposal may not name: disabled with the reason rather than hidden. */
  const Withheld = ({ field }) => (
    proposeMode && withheldFields[field]
      ? <div className="form-hint-locked">{withheldFields[field]}</div>
      : null
  )
  // Mirrors the `forge` listener in supabase/envoy.yaml, which admits these two roles.
  const canOpenForge = userRole === 'Administrator' || userRole === 'Shopfloor_Manager'

  const unassignedDevices = assets.filter(a => !a.is_archived && !a.active_gateway_id)
  // The gateways that should be reporting and are not: the rail's amber, by the rule of
  // gatewayFleetCounts(). Awaiting setup is not a fault, and the Playback gateway serves no machine.
  const offlineGateways = gateways.filter(g => !g.is_archived && !isShadowGateway(g) && !isGatewayPending(g) && !isGatewayOnline(g))

  // From the flat device list: ingestion records the arriving edge node on a quarantined device.
  const gatewaysWithQuarantine = new Set(
    assets.filter(a => a.is_quarantined && a.active_gateway_id).map(a => a.active_gateway_id)
  )

  const filteredGateways = gateways.filter(g => {
    if (filterMode === 'active'   && g.is_archived) return false
    if (filterMode === 'archived' && !g.is_archived) return false
    if (searchQuery) {
      // Matches the friendly name, the internal UUID and the Sparkplug edge node id.
      const q = searchQuery.toLowerCase()
      const haystack = [g.gateway_name, g.gateway_id, g.sparkplug_id || gatewaySparkplugId(g.gateway_id)]
        .filter(Boolean).join(' ').toLowerCase()
      if (!haystack.includes(q)) return false
    }
    if (liveStatusFilter && gatewayDisplayStatus(g) !== liveStatusFilter) return false
    // The derived type, not `deployment`: Simulated and Host share a deployment.
    if (kindFilter && gatewayType(g) !== kindFilter) return false
    if (quarantineOnly && !gatewaysWithQuarantine.has(g.gateway_id)) return false
    return true
  })

  const activeFilterCount =
    [searchQuery, liveStatusFilter, kindFilter].filter(Boolean).length +
    (quarantineOnly ? 1 : 0) + (filterMode !== 'active' ? 1 : 0)

  // Arriving from a cell's gateway chip or a device's Serving Gateway chip names ONE gateway: open it.
  useArrivalSelection(
    searchQuery,
    gateways,
    (g, term) => g.gateway_id === term || (g.sparkplug_id || gatewaySparkplugId(g.gateway_id)) === term,
    (g) => setSelectedId(g.gateway_id)
  )

  // Resolved fresh every render; a gateway that disappears resolves to null and the drawer closes.
  const selected = gateways.find(g => g.gateway_id === selectedId) || null
  const selectedDevices = selected?.devices || []
  const selectedCell = selected ? cells.find(c => c.cell_id === selected.cell_id) : null

  // "None yet" only when the stack holds no gateway of its own; anything else is a filter's doing.
  // The seeded Playback gateway does not count, so a new install still prompts under its row.
  const hasOwnGateway = gateways.some(g => !isShadowGateway(g))
  const isFiltered = hasOwnGateway || activeFilterCount > 0
  // With the drawer open, the columns it repeats are dropped so the table fits beside it.
  const compact = !!selected

  // The panel's one primary: setup while pending, else the console, else Restore when archived,
  // else Edit. The Playback gateway cannot be edited, so its credential takes Edit's place.
  const selectedPending = !!selected && isGatewayPending(selected)
  const offersSetup = !!selected && !selected.is_archived && selected.deployment === 'remote' && selectedPending && canManage
  const offersCredential = !!selected && !selected.is_archived && selected.deployment === 'host' && canManage
  const primaryAction = !selected ? null
    : offersSetup ? 'setup'
    : offersCredential && selectedPending ? 'credential'
    : selected.access_url ? 'launch'
    : selected.is_archived ? 'restore'
    : !selected.is_shadow ? 'edit'
    : offersCredential ? 'credential'
    : null

  return (
    <div className="page-layout page-fill">
      <div className="page-main">

      {unassignedDevices.length > 0 && (
        <div className="callout callout-warning callout-page">
          <IconAlertTriangle size={18} className="callout-icon" />
          <span>
            <strong>{unassignedDevices.length} device{unassignedDevices.length === 1 ? '' : 's'} not assigned to any gateway:</strong>{' '}
            {unassignedDevices.slice(0, 5).map(a => a.asset_name).join(', ')}{unassignedDevices.length > 5 ? ', …' : ''}.
            Assign them from the Devices page.
          </span>
        </div>
      )}

      {/* Says what the rail's colour means before the table is read. */}
      {offlineGateways.length > 0 && (
        <div className="callout callout-warning callout-page">
          <IconShieldAlert size={18} className="callout-icon" />
          <span>
            <strong>{offlineGateways.length} gateway{offlineGateways.length === 1 ? '' : 's'} offline:</strong>{' '}
            {offlineGateways.slice(0, 5).map(g => g.gateway_name).join(', ')}{offlineGateways.length > 5 ? ', …' : ''}.
            Every device underneath is silent with it. Check the appliance, its network, and its broker credential.
          </span>
        </div>
      )}

      {/* Said before a Remote gateway is created, because the refusal otherwise arrives from the
          setup dialog after the row exists. Only for those who could create one. */}
      {enrolmentBlocked && canManage && (
        <div className="callout callout-warning callout-page">
          <IconShieldAlert size={18} className="callout-icon" />
          <span>
            <strong>Remote gateways cannot be enrolled on this deployment:</strong>{' '}
            {enrolmentProblems.join('; ')}. An appliance dials these addresses, so they are set on
            the deployment rather than here: set <span className="mono">global.publicBaseDomain</span>{' '}
            in the chart&rsquo;s values and restart the functions service (docs/remote-gateways.md,
            section 7). Host and Simulated gateways are unaffected.
          </span>
        </div>
      )}

      <div className="card card-fill">
        <CardHeading
          icon={<IconRadio size={15} />}
          title="Gateways"
          description="The edge nodes that publish to the broker, each with its own broker credential, and the status each last reported."
          actions={(
            <>
              <ActionButton
                className="btn btn-primary btn-sm"
                permitted={canManage}
                deniedTitle={requiresRolesTitle(PERMISSION_UUIDS.GATEWAY_MANAGE)}
                onClick={() => { setEditing(null); setForm(blank); setShowForm(true) }}
                title="Register new gateway"
              >
                <IconPlus size={14} /> New Gateway
              </ActionButton>
            </>
          )}
        />

        <div className="card-body">
      <div className="filter-bar">
        {/* Lifecycle is a filter like the rest; the counts are in the option labels. */}
        <select
          className="form-control control-sm"
          value={filterMode}
          onChange={e => setFilterMode(e.target.value)}
          title="Filter by lifecycle state"
        >
          <option value="active">Active ({gateways.filter(g => !g.is_archived).length})</option>
          <option value="archived">Archived ({gateways.filter(g => g.is_archived).length})</option>
          <option value="all">All ({gateways.length})</option>
        </select>

        <SearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="Search name, UUID or Sparkplug ID…"
          ariaLabel="Search gateways by name, UUID or Sparkplug ID"
        />

        {/* Derived from heartbeat age as well as the stored status: STALE is never stored. */}
        <select className="form-control control-sm" value={liveStatusFilter} onChange={e => setLiveStatusFilter(e.target.value)} title="Filter by status; Stale is a heartbeat older than 90 seconds">
          <option value="">Any status</option>
          <option value="ONLINE">Online</option>
          <option value="STALE">Stale</option>
          <option value="OFFLINE">Offline</option>
        </select>

        {/* The same value the Type column prints, through the same helper. */}
        <select className="form-control control-sm" value={kindFilter} onChange={e => setKindFilter(e.target.value)} title="Filter by the Type column: Remote (an appliance on the plant network), Host (a connector inside this stack), Simulated (host-run, readings generated), or Playback (republishes recorded captures)">
          <option value="">Any type</option>
          {LISTED_TYPES.map(t => (
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

        <ClearFilters count={activeFilterCount} onClear={resetFilters} />
      </div>

        </div>{/* .card-body */}

        {loading ? <LoadingState label="gateways" /> :
         filteredGateways.length === 0 ? (
           <EmptyState
             icon={<IconRadio size={36} />}
             filtered={isFiltered}
             message="No gateways yet."
             filteredMessage="No gateways match these filters."
           />
         ) : (
           <>
           <div className="table-wrap">
             <table>
               <thead>
                 <tr>
                   <th title="Human-readable gateway name">Gateway Name</th>
                   {!compact && <th title="The gateway's database identifier -- the id to quote in a query, a ticket or an API call. Its Sparkplug edge node id is derived from this, so nothing is lost by showing it here.">Gateway UUID</th>}
                   <th title="Where this gateway's connector runs, and whether its readings are real: Remote (an appliance on the plant network), Host (inside this stack), Simulated (host-run, readings generated), Playback (republishes recorded captures)">Type</th>
                   <th title="Where this gateway serves: a cell, a whole area, or the whole site">Location</th>
                   <th title="What the gateway last reported, shown as Stale once its heartbeat is over 90 seconds old">Gateway Status</th>
                   <th title="Age of the last Sparkplug B node heartbeat (NBIRTH/NDATA/NDEATH)">Last Heartbeat</th>
                   {!compact && <th title="Devices assigned to this gateway">Connected Devices</th>}
                 </tr>
               </thead>
               <tbody>
                 {filteredGateways.map(g => {
                   const gwAssets = g.devices || []
                   const onlineCount = gwAssets.filter(a => a.status === 'ONLINE' || !a.status).length
                   const offlineCount = gwAssets.filter(a => a.status === 'OFFLINE').length
                   const liveStatus = gatewayDisplayStatus(g)
                   const type = gatewayType(g)

                   return (
                     <React.Fragment key={g.gateway_id}>
                       {/* The row selects and contains buttons, so the click is filtered by
                           rowSelectHandler. */}
                       <tr
                         className={`row-selectable${selectedId === g.gateway_id ? ' row-selected' : ''}${g.is_archived ? ' row-archived' : ''}`}
                         onClick={rowSelectHandler(() => setSelectedId(id => id === g.gateway_id ? null : g.gateway_id))}
                         // Focusable, and Enter or Space on the row itself does what a click does.
                         tabIndex={0}
                         onKeyDown={e => {
                           if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
                           e.preventDefault()
                           setSelectedId(id => id === g.gateway_id ? null : g.gateway_id)
                         }}
                         title="Click to inspect this gateway in the details panel"
                       >
                         <td>
                           <strong>{g.gateway_name}</strong>
                           {/* A state, not a kind: a gateway of any type can be archived. */}
                           {g.is_archived && (
                             <ArchivedBadge size="sm" className="gateway-name-badge" title="Archived: out of service. Restore it from its drawer." />
                           )}
                         </td>
                         {!compact && <td><CopyableId value={g.gateway_id} label="Gateway UUID" onNotify={showToast} /></td>}
                         <td>
                           <Badge tone={gatewayTypeTone(type)} size="sm" title={gatewayTypeDescription(type)}>
                             {gatewayTypeLabel(type)}
                           </Badge>
                         </td>
                         <td>
                           {/* Four answers, the first being that the question does not apply: a
                               simulated gateway cannot hold a cell, so its stored scope is inert and
                               not printed. Site-Wide is an answer for every other gateway and must
                               not read as the unanswered case. */}
                           {!gatewayAcceptsCell(g)
                             ? <span className="cell-meta" title={`${gatewayTypeLabel(type)} gateways have no cell: their devices resolve to the ${gatewayTypeLabel(type)} lane, which takes precedence over cell membership.`}>—</span>
                             : g.location_scope === SCOPE_SITE_WIDE
                               ? <Badge tone="neutral" size="sm" title="Serves the whole campus rather than one cell. Its devices need their own cell.">Site-Wide</Badge>
                               : g.location_scope === SCOPE_AREA_WIDE
                                 ? <Badge tone="neutral" size="sm" title={`Serves the whole of ${areas.find(ar => ar.area_id === g.area_id)?.area_name || 'its area'} rather than one cell. Its devices need their own cell.`}>Area-Wide</Badge>
                               : g.cell_id
                                 ? (cells.find(c => c.cell_id === g.cell_id)?.cell_name || <span className="mono">{g.cell_id}</span>)
                                 : <span className="cell-meta gateway-cell-warning" title="Devices on this gateway inherit no cell, so they land in the Unassigned queue">No cell</span>}
                         </td>
                         <td>
                           {g.is_archived
                             ? <span className="cell-meta">—</span>
                             : <StatusBadge status={liveStatus} />}
                         </td>
                         <td
                           className={`cell-meta${liveStatus === 'STALE' ? ' gateway-cell-warning' : ''}`}
                           title={g.last_heartbeat ? new Date(g.last_heartbeat).toLocaleString() : 'No Sparkplug B node message has ever been received from this edge node'}
                         >
                           {formatHeartbeat(g.last_heartbeat)}
                         </td>
                         {!compact && <td>
                           {g.is_archived ? (
                             <span className="cell-meta">—</span>
                           ) : gwAssets.length === 0 ? (
                             <span className="cell-meta gateway-cell-italic">No devices assigned</span>
                           ) : (
                             /* Collapsed past three (the TagList limit; the summary counts as one).
                                The Online / Offline summary is pinned because it is the question
                                the column answers, and a QUARANTINED device because it calls for
                                action. */
                             <TagList
                               limit={3}
                               tags={[
                                 {
                                   key: '__summary__',
                                   priority: true,
                                   className: 'badge badge-sm badge-neutral',
                                   title: 'Connected devices breakdown',
                                   content: `${onlineCount} Online / ${offlineCount} Offline`
                                 },
                                 ...gwAssets.map(a => ({
                                   key: a.asset_id,
                                   // The tooltip on "+N" lists names, not the UUIDs these are keyed by.
                                   label: a.asset_name,
                                   priority: a.is_quarantined,
                                   className: `badge badge-sm ${a.status === 'OFFLINE' ? 'badge-neutral' : 'badge-online'}`,
                                   title: `${a.asset_name} — ${a.is_quarantined ? 'QUARANTINED' : a.status || 'ONLINE'}`,
                                   content: `${a.asset_name}${a.is_quarantined ? ' (quarantined)' : ''}`
                                 }))
                               ]}
                             />
                           )}
                         </td>}
                       </tr>
                     </React.Fragment>
                   )
                 })}
               </tbody>
             </table>
           </div>
           {!hasOwnGateway && (
             <EmptyState icon={<IconRadio size={36} />} message="No gateways yet besides the Playback gateway." />
           )}
           </>
         )}
      </div>

      {showForm && (
        <Modal
          title={editing ? 'Edit Gateway' : 'Register Gateway'}
          size="md"
          onClose={() => { setShowForm(false); setEditingProposal(null) }}
          footer={
            <>
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
            </>
          }
        >
        <div className="form-group">
          <label className="form-label">Gateway Name</label>
          <input className="form-control" value={form.gateway_name} onChange={e => setForm(f => ({ ...f, gateway_name: e.target.value }))} title="Friendly label for this gateway" placeholder="e.g. Sim_Gateway_Cell1_Machining" />
          <div className="form-hint">
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
          <div className="form-hint">
            Optional, and read by nothing — a note for whoever comes to this next.
          </div>
        </div>
        {/* One select over the legal states rather than two checkboxes, ahead of Location because
            it governs it. */}
        <div className="form-group">
          <label className="form-label" htmlFor="gateway-type">Type</label>
          <Withheld field="deployment" />
          <select
            id="gateway-type"
            className="form-control"
            disabled={proposeMode}
            value={formType}
            onChange={e => setForm(f => ({
              ...f,
              ...gatewayTypeFields(e.target.value),
              // A simulated gateway cannot hold a cell, so it is cleared here and the picker is disabled.
              ...(e.target.value === GATEWAY_TYPES.SIMULATED
                ? { cell_id: '', area_id: '', location_scope: SCOPE_CELL }
                : {})
            }))}
            title={proposeMode ? withheldFields.deployment : "Where this gateway's connector runs, and whether its readings are real"}
          >
            {SELECTABLE_TYPES.map(t => (
              <option key={t} value={t}>{gatewayTypeLabel(t)}</option>
            ))}
          </select>
          {/* The consequence, said before it is chosen. */}
          <div className="form-hint">
            {gatewayTypeDescription(formType)}
            {remoteWithheld
              ? <> <strong className="gateway-withheld">This deployment cannot issue an install command or bundle yet:</strong> {enrolmentProblems.join('; ')}. Save is withheld for a Remote gateway until it can; Host and Simulated gateways are unaffected.</>
              : !editing && formType === GATEWAY_TYPES.REMOTE
                && ' On save you will be given an install command, or a bundle, to run on that machine; it enrols itself and appears here as online.'}
          </div>
        </div>
        {/* One exclusive scope, then the cell or area it calls for. A simulated gateway reads as In a
            cell with none chosen whatever is stored, since its lane resolves ahead of the stored
            scope; the stored value is cleared only on the type change that would make it unsaveable. */}
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

          <div className="form-hint">
            {!formAcceptsCell
              /* Says which lane it lands in instead, so the disabled control reads as an answer. */
              ? 'Simulated gateways have no cell: their devices resolve to the Simulated lane, which takes precedence over cell membership.'
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
        </Modal>
      )}

      {archiveTarget && (
        <ArchiveModal
          entityId={archiveTarget.gateway_id} displayName={archiveTarget.gateway_name}
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
        icon={<IconRadio size={16} />}
        title={selected?.gateway_name || ''}
        subtitle={selected && (
          <>
            <StatusBadge status={gatewayDisplayStatus(selected)} />
            <Badge tone={gatewayTypeTone(gatewayType(selected))} title={gatewayTypeDescription(gatewayType(selected))}>
              {gatewayTypeLabel(gatewayType(selected))}
            </Badge>
            {selected.is_archived && <ArchivedBadge title="Archived: out of service. Restore it below." />}
          </>
        )}
        fields={selected ? [
          { label: 'Gateway UUID', value: selected.gateway_id, mono: true, copyable: true },
          // The id it publishes under: what a Sparkplug trace or an MQTT subscription is keyed on.
          { label: 'Sparkplug Edge Node ID', value: selected.sparkplug_id || gatewaySparkplugId(selected.gateway_id), mono: true, copyable: true },
          {
            // The real group id where recorded, so the topic can be pasted into an MQTT client; else `+`.
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
            // A link when there is a cell to open. Site-Wide stays plain text. Same cases as the
            // column, since a simulated gateway's stored scope is inert.
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
              ? `Its devices resolve to the ${gatewayTypeLabel(gatewayType(selected))} lane, which takes precedence over cell membership.`
              : selected.location_scope === SCOPE_SITE_WIDE
                ? 'A host-run or central connector serving the whole campus. Its devices inherit no cell from it.'
                : selected.location_scope === SCOPE_AREA_WIDE
                  ? 'A connector serving one whole area. Its devices inherit no cell from it.'
                  : 'Devices served by this gateway resolve to this cell unless they carry one of their own.'
          },
          { label: 'Last Heartbeat', value: formatHeartbeat(selected.last_heartbeat), title: 'Age of the last NBIRTH/NDATA/NDEATH. STALE after 90 seconds of silence.' },
          // What the appliance reports about itself, once `health_reported_at` is set: a gateway that
          // never reported would show a dozen rows of dashes. Current values only; the trend is in
          // Grafana's Gateway Fleet Health dashboard.
          ...(selected.health_reported_at ? [
            {
              label: 'Health Reported',
              value: formatHeartbeat(selected.health_reported_at),
              title: 'Age of the last heartbeat that carried appliance health. Separate from Last '
                + 'Heartbeat on purpose: a gateway can keep beating while its collector has stopped.'
            },
            // The root this appliance holds, beside the one the platform publishes. Behind means it has
            // not converged since the root was re-issued.
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
              value: formatUptime(selected.uptime_seconds),
              title: 'How long the appliance\'s Node-RED runtime has been up. PROCESS uptime, not '
                + 'host uptime: a restarted container resets it while the machine stays up.'
            },
            {
              label: 'Bundle',
              value: selected.agent_version || null,
              title: 'The bundle version the appliance reports. Refreshed on every heartbeat, so an '
                + 'appliance upgraded in place shows its new version without re-enrolling.'
            },
            // The drift check: `flow_hash` (what the appliance last deployed) against
            // `forge_head_flow_sha256` (the head of main). Within the grace period of a push it is
            // the puller not having ticked yet; beyond that it is drift, and the appliance's
            // flow-sync log says why.
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
            // Where main is, as the forge reported it on the last push.
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
            // What the appliance says it is running, from the head of its own branch. A digest that
            // differs from the heartbeat's is an edit made in the appliance's editor since the deploy.
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
            // What the last hourly convergence did, from converged.json on the appliance branch: which
            // playbook version this appliance is on, so a fleet mid-rollout reads one gateway at a time.
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
                + '(journalctl -u aber-gateway-converge) says why. The tag is changed by a pull '
                + 'request on platform.yml in this gateway\'s repository, so a fleet mid-rollout '
                + 'shows different tags here. Empty on an appliance that runs the bundle alone.'
            },
            // A bespoke adapter has no heartbeat of its own: a gateway whose adapter is crash-looping
            // still publishes and reads ONLINE, so this row is the only place it shows.
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
          // Ask the node to republish its birth certificate (`Node Control/Rebirth`): the only command
          // this dashboard sends. Not on an archived gateway, nor the Playback gateway, which holds
          // no subscription.
          !selected.is_archived && !selected.is_shadow && canManage && {
            label: 'Request Rebirth',
            icon: <IconRefreshCw size={13} />,
            // Withheld until the first birth: before it there is nothing to restate.
            disabled: selectedPending,
            title: selectedPending
              ? 'Available once this gateway has published: it has not sent a birth certificate yet, so there is none to restate.'
              : 'Ask this edge node to republish its birth certificate. Harmless — it restates '
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
          // Setup while it is unfinished, and for AWAITING_BIRTH so an appliance that enrolled and never
          // published can be re-issued. Absent once ONLINE, since re-issuing invalidates a working
          // credential. Confirms first, unlike the dialog straight after creation.
          offersSetup && {
            label: selected.status === 'AWAITING_BIRTH' ? 'Re-issue Setup' : 'Set Up Gateway',
            icon: <IconDownload size={13} />,
            primary: primaryAction === 'setup',
            // Withheld, not hidden, while the deployment cannot issue setup: the banner says why.
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
                : 'Issue an install command, or a bundle, to set this gateway up on its appliance'
          },
          // Host and Simulated gateways (`deployment === 'host'`) have no enrolment lifecycle. Not on an
          // archived gateway, since a credential issued then would resurrect the row. This is the only
          // place a password appears in the product.
          offersCredential && {
            label: 'Generate Broker Credential',
            icon: <IconLock size={13} />,
            primary: primaryAction === 'credential',
            onClick: () => setCredentialForGw({
              gateway_id: selected.gateway_id,
              gateway_name: selected.gateway_name,
              sparkplug_id: selected.sparkplug_id,
              is_shadow: selected.is_shadow
            }),
            title: 'Issue this Host or Simulated gateway a broker account and show the password once. A Remote gateway enrols itself instead, and its credential never passes through a browser.'
          },
          selected.access_url && {
            label: 'Launch UI', icon: <IconExternalLink size={13} />, href: selected.access_url, primary: primaryAction === 'launch',
            title: 'Open this gateway’s own console — Node-RED for a host-run connector, the appliance’s web UI for a Remote one'
          },
          // Restore replaces Edit on an archived gateway: editing one is refused anyway.
          selected.is_archived ? {
            label: 'Restore Gateway', icon: <IconRefreshCw size={13} />,
            onClick: () => runRestore(selected.gateway_id, () => restoreGateway(selected.gateway_id, selected.gateway_name)),
            pending: restoringId === selected.gateway_id,
            pendingLabel: 'Restoring…',
            disabled: !canArchive,
            primary: primaryAction === 'restore',
            title: !canArchive ? requiresRolesTitle(PERMISSION_UUIDS.ARCHIVE_MANAGE) : 'Restore gateway back to active service'
          } : !selected.is_shadow && {
            // Not offered for the Playback gateway: two of the three Type options are refused on it.
            label: proposeMode ? 'Propose a Change' : 'Edit Details', icon: <IconPencil size={13} />,
            primary: primaryAction === 'edit',
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
                ? requiresRolesTitle(PERMISSION_UUIDS.PROPOSAL_CREATE)
                : 'Edit gateway configuration'
          },
          // Withheld from a reader who may not open the Audit Trail page.
          canReadTrail && {
            label: 'View Audit Trail', icon: <IconHistory size={13} />,
            onClick: () => onViewTrail?.(selected),
            title: 'Open the immutable audit trace for this gateway'
          },
          {
            label: 'Attached Links', icon: <IconBookOpen size={13} />,
            onClick: () => setDocsForGw(selected),
            title: 'Attach or edit links for this gateway — documents, an asset register, a file repository, any URL'
          },
          // Not offered for the Playback gateway, and the database refuses it too: playback would be
          // left with no edge node.
          !selected.is_archived && !selected.is_shadow && {
            label: 'Archive Gateway', icon: <IconArchive size={13} />,
            onClick: () => setArchiveTarget(selected),
            disabled: !canArchive,
            danger: true,
            title: !canArchive
              ? requiresRolesTitle(PERMISSION_UUIDS.ARCHIVE_MANAGE)
              : 'Archive this gateway: its broker account is disabled and any unused setup token is burned'
          },
        ].filter(Boolean) : []}
        // With the metadata, above the actions.
        beforeActions={selected && (
          <div>
            <div className="context-panel-section-label">Connected Devices ({selectedDevices.length})</div>
            {selectedDevices.length === 0
              ? <div className="context-field-empty" style={{ fontSize: '11px' }}>No devices assigned</div>
              : (
                /* Chips that navigate. The lifecycle state is a dot, since a status colour would
                   collide with `chip-link`'s hover. */
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

            {/* Withheld from an archived gateway; renders nothing for a role the forge would refuse. */}
            {!selected.is_archived && (
              <div style={{ marginTop: '14px' }}>
                <GatewayRepositoryPanel
                  gateway={selected}
                  canOpenForge={canOpenForge}
                />
              </div>
            )}

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
          // Whether this deployment can issue the install command. Null until asked: the bundle then.
          installer={enrolment?.installer || null}
        />
      )}
    </div>
  )
}
