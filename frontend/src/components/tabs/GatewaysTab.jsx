import React, { useState, useEffect, useCallback } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS, REALTIME_ENABLED, STALENESS_TICK_MS, refreshInterval } from '../../constants'
import { usePolling } from '../../hooks/usePolling'
import { useRealtimeTable } from '../../hooks/useRealtimeTable'
import { useClockTick } from '../../hooks/useClockTick'
import {
  gatewayLiveStatus, isGatewayPending, formatHeartbeat,
  formatCertExpiry, isCertExpiring, formatBytes, CERT_EXPIRY_WARN_DAYS
} from '../../utils/gatewayStatus'
import { gatewaySparkplugId } from '../../utils/sparkplugId'
import {
  GATEWAY_TYPES, SELECTABLE_TYPES, gatewayType, gatewayTypeFields,
  gatewayTypeLabel, gatewayTypeDescription, gatewayTypeTone,
} from '../../utils/gatewayType'
import { deviceLifecycleStatus, deviceStatusDotColor, deviceStatusTitle, deviceDotColor } from '../../utils/deviceStatus'
import { alertIndex, alertForDevice } from '../../utils/deviceAlerts'
import { SCOPE_CELL, SCOPE_SITE_WIDE, gatewayAcceptsCell } from '../../utils/cellResolution'
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
import { FlowBackupUploader } from '../common/FlowBackupUploader'
import {
  IconRadio,
  IconPlus,
  IconPencil,
  IconArchive,
  IconRefreshCw,
  IconHistory,
  IconBookOpen,
  IconExternalLink,
  IconZap,
  IconShieldAlert,
  IconMap,
  IconX,
  IconDownload,
  IconLock
} from '../common/Icons'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { useArrivalSelection } from '../../hooks/useArrivalSelection'

export function GatewaysTab({ showToast, onViewThread, onSelectCell, onSelectDevice, hasPermission, initialSearchFilter, onClearFilter, onBugReport, activeAlerts = [] }) {
  /** Devices Grafana currently has an alert firing on -- see utils/deviceAlerts.js (issue #34). */
  const alerts = React.useMemo(() => alertIndex(activeAlerts), [activeAlerts])
  const [gateways, setGateways] = useState([])
  const [assets, setAssets]     = useState([])
  const [cells, setCells]       = useState([])
  const [loading, setLoading]   = useState(true)
  const [showForm, setShowForm] = useState(false)
  // The create/edit form is a modal like any other, even though it is written inline here rather
  // than extracted into components/modals. Escape closes it, through the shared stack so the
  // ArchiveModal that can open over it is the one that answers first.
  useEscapeKey(() => setShowForm(false), showForm)
  const [editing, setEditing]   = useState(null)
  const [archiveTarget, setArchiveTarget] = useState(null)
  // The context panel holds an ID, not the gateway object.
  //
  // This page polls, so a captured object would freeze at the moment it was clicked -- the panel
  // would show a heartbeat that stopped ageing and a status that never changed, beside a table row
  // updating normally. Resolving the id against the current list every render means the drawer is
  // as live as the row it came from, and it closes itself if the entity disappears.
  const [selectedId, setSelectedId] = useState(null)
  // location_scope defaults to 'cell' -- an edge node belongs in some cell until someone says
  // otherwise. `deployment` is deliberately NOT the same question: it says where the connector
  // RUNS, site-wide is a claim about where the assets ARE. A host-run gateway is usually
  // site-wide, but conflating them would relocate assets on a checkbox.
  //
  // 'remote' is the default because it is the case that needs setup: a remote gateway leaves this
  // form with a bundle to install, and defaulting to the one that finishes on save would let an
  // operator create a gateway that silently never gets an appliance.
  const blank = { gateway_id: '', gateway_name: '', status: 'OFFLINE', deployment: 'remote', is_simulated: false, access_url: '', cell_id: '', location_scope: SCOPE_CELL }
  const [form, setForm]         = useState(blank)
  // DERIVED, NOT A SECOND PIECE OF STATE. The form carries `deployment` and `is_simulated` because
  // that is what the API takes; the select carries one word. Storing both would be two things to
  // keep in step for one decision -- the bug class this whole item is about.
  const formType = gatewayType(form)
  // Derived the same way and for the same reason, off the flags rather than off `formType`: the
  // rule belongs to `gateways_synthetic_has_no_cell`, which is written in terms of the two
  // columns, so reading them keeps this true if a fourth type is ever added.
  const formAcceptsCell = gatewayAcceptsCell(form)
  const [docsForGw, setDocsForGw] = useState(null)
  // The gateway whose bundle modal is open. Held as the OBJECT rather than an id: the modal needs
  // the name and sparkplug_id, and it stays open across a poll that may reorder the list.
  const [bundleForGw, setBundleForGw] = useState(null)
  // The HOST-RUN counterpart to bundleForGw. Separate state rather than a mode flag on one
  // modal: the two are authorised differently, destroy different things, and only one of them
  // ever puts a password on screen.
  const [credentialForGw, setCredentialForGw] = useState(null)
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
    setFilterMode('all')
    handleClearSearch()
  }

  const load = useCallback(async (signal) => {
    try {
      // Each gateway arrives with its devices embedded (gateways?select=*,devices(...)),
      // so an assignment made anywhere shows up on the next poll. The flat device list
      // is still needed to surface devices that belong to no gateway at all.
      const [g, a, c] = await Promise.all([
        api.get('/api/v1/gateways', { signal }),
        api.get('/api/v1/devices', { signal }),
        api.get('/api/v1/cells', { signal })
      ])
      setGateways(g); setAssets(a); setCells(c)

      /* WHAT THIS PERSON HAS ALREADY ASKED FOR, so the edit dialog can seed itself with an open
         proposal's patch rather than silently replacing it. Tolerated rather than required: this
         page must not fail to load because the proposals endpoint did. */
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

  // Reconciliation loop, not the primary refresh -- see useRealtimeTable for why polling stays.
  //
  // Worth knowing: ingestion stamps gateways.last_heartbeat on every NBIRTH/NDATA/NDEATH, so
  // this page receives a change event roughly every 30s per gateway from the simulator alone.
  // That is the highest-traffic subscription in the app and the reason the hook debounces.
  //
  usePolling(load, refreshInterval())
  useRealtimeTable(['gateways', 'devices', 'cells'], load, { enabled: REALTIME_ENABLED })
  // Heartbeat staleness is derived from the wall clock by gatewayLiveStatus(), and a gateway
  // going quiet produces no database change and therefore no Realtime event. Without this
  // tick, a silent gateway would keep its last-rendered status until the 60s reconciliation
  // poll. Re-renders only; issues no requests.
  useClockTick(STALENESS_TICK_MS)

  // In-flight state for the form's Save and for whichever gateway is restoring.
  const [saving, runSave] = usePendingAction()
  const [restoringId, runRestore] = usePendingKey()
  // Keyed rather than a single flag: the panel resolves its gateway every render, so a bare boolean
  // would spin the button for whichever gateway happened to be selected when the request settled.
  const [rebirthingId, runRebirth] = usePendingKey()

  const save = async () => {
    try {
      /* THE FORK IS AT THE END. Everything above is shared; only the last step differs, and it
         differs by who is asking. A gateway can only be REGISTERED by an Administrator -- the
         remote branch below mints a bundle, which is not a thing to queue. */
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
       * THE REMOTE BRANCH. A host-run gateway is finished the moment its row exists -- it is a
       * connector running on the app host, and nothing has to be carried anywhere. A REMOTE one has
       * only just started: it needs a bundle, on a machine, before it can publish at all.
       *
       * So the bundle modal opens immediately rather than leaving the operator to find a button. The
       * alternative is a row that says AWAITING SETUP with no indication of what the setup IS, which
       * is the state this whole flow exists to remove.
       *
       * AND IT DOWNLOADS WITHOUT CONFIRMING, which the drawer's route into the same modal does not.
       * The row is seconds old, so there is no earlier bundle for this one to invalidate -- the
       * whole reason that confirmation exists is absent here. See GatewayBundleModal.
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

  /* ONE FORM, TWO ENDINGS -- see frontend/src/utils/proposeFromForm.js. Derived rather than
     stored, so it cannot disagree with the permission that decides whether the write would be
     accepted. */
  const proposeMode = !canManage && canPropose
  const [editingProposal, setEditingProposal] = useState(null)
  const [openProposals, setOpenProposals] = useState([])
  const withheldFields = nonProposableFields('gateway')

  /**
   * The note under a field a proposal may not name.
   *
   * WITHHELD, NOT HIDDEN. `deployment` says where this gateway's connector RUNS and `is_simulated`
   * is what it IS -- neither is a label, and moving one re-points a broker topic namespace. Hiding
   * the controls would make two different dialogs out of one, which is the drift this restructure
   * removes.
   */
  const Withheld = ({ field }) => (
    proposeMode && withheldFields[field]
      ? <div className="form-hint-locked">{withheldFields[field]}</div>
      : null
  )
  /**
   * Flow-backup authority, mirroring supabase/storage-policies.sql rather than reimplementing it.
   *
   * WRITE is GATEWAY_MANAGE, which only Administrator and Shopfloor_Manager hold. READ additionally
   * admits DIGITAL_THREAD_READ, which is the AUDITOR's single permission -- seeing what the edge was
   * configured to do, and when it changed, is the whole of that role. Operator holds neither
   * (QUARANTINE_VIEW and TELEMETRY_READ only), so they get nothing, which is what the bucket's RLS
   * grants them too.
   */
  const canManageBackups = canManage
  const canReadBackups = canManage || hasPermission(PERMISSION_UUIDS.DIGITAL_THREAD_READ)

  const unassignedDevices = assets.filter(a => !a.is_archived && !a.active_gateway_id)

  // Built from the flat device list rather than the embedded one: ingestion records the arriving
  // edge node on a quarantined device, so a device held on a gateway is attributable even though
  // it has not been approved onto it yet.
  const gatewaysWithQuarantine = new Set(
    assets.filter(a => a.is_quarantined && a.active_gateway_id).map(a => a.active_gateway_id)
  )

  const filteredGateways = gateways.filter(g => {
    // HIDDEN BY DEFAULT, matching the Devices page's treatment of the shadow devices this gateway
    // publishes as. It is one row on every stack, it is seeded rather than created, and almost
    // every action on it has been withdrawn -- so it sits in the fleet list offering nothing while
    // reading, to anyone scanning for a real connector, as a gateway that is permanently offline.
    //
    // NOT REMOVED FROM THE PAGE. It has to stay reachable: minting its broker credential is the one
    // act an operator must perform on it, and 0060's NOTICE names this page as where. The toggle
    // is what keeps it findable while keeping it out of the way.
    //
    // TYPE-FILTERED SEPARATELY. Choosing Simulated in the Type control should not surface it either
    // -- Shadow is its own type, and a filter that quietly widened to include the playback gateway
    // would be the "Simulated means three things" problem returning by the back door.
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

  // Counted across the whole fleet, not the filtered list: it is what the toggle reveals, so
  // counting what is already shown would read zero exactly when the button matters.
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

      {/* One card: title, description, primary action, filters, table. See CellsTab's note on why
          the filter bar came inside rather than floating above. */}
      <div className="card">
        <div className="card-header">
          <h3 className="section-title">
            Edge Gateways <span className="section-count">{gateways.length}</span>
          </h3>
          <button
            className={`btn btn-primary btn-sm ${!canManage ? 'btn-disabled' : ''}`}
            style={{ marginLeft: 'auto' }}
            disabled={!canManage}
            onClick={() => canManage && (setEditing(null), setForm(blank), setShowForm(true))}
            title={!canManage ? 'Requires Admin permissions' : 'Register new edge gateway'}
          >
            <IconPlus size={14} /> New Gateway
          </button>
        </div>

        <div className="card-body">
          <p style={{ color: 'var(--text-muted)', fontSize: '13px', margin: '0 0 12px' }}>
            A gateway is an edge node: the thing that publishes to the broker, and the identity every
            topic beneath it is pinned to. Its devices reach the platform through it, so a gateway
            that goes quiet takes their telemetry with it — which is why status here is derived from
            the last heartbeat rather than from anything the gateway asserts about itself.
          </p>

      <div className="filter-bar">
        {/* Lifecycle lives here rather than as a separate segmented control in the header: it is
            a filter like the rest, and having two filter surfaces on one page meant the header
            row also crowded out the primary action. Counts are kept in the option labels. */}
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

        {/* FILTERS ON THE SAME VALUE THE Type COLUMN PRINTS, through the same helper. It used to
            filter on `deployment` alone and offer "On an appliance" / "On this host", which could
            not express Simulated at all: a simulated gateway is host-run, so "On this host"
            returned it alongside the real connectors and there was no way to separate them --
            while the column beside it had been telling them apart since 0064. */}
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

        {/* SHOWN ONLY WHEN ONE EXISTS, like the Devices page's shadow toggle. 0060 seeds exactly
            one, so on a stack that has it this is a single button; on one that somehow does not,
            a control for an absent row would be a puzzle rather than a filter. */}
        {shadowGatewayCount > 0 && (
          <button
            className={`btn btn-sm ${showShadowGateways ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setShowShadowGateways(v => !v)}
            title="The Playback gateway (archived migration 0060). It publishes recorded captures as shadow devices and is not a connector to any machine, so it is hidden by default — but it stays reachable, because minting its broker credential is the one act an operator must perform on it."
          >
            <IconRadio size={13} /> Show playback gateway ({shadowGatewayCount})
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
             <div className="empty-text">No edge gateways match the selected filter.</div>
           </div>
         ) : (
           <div className="table-wrap">
             <table>
               <thead>
                 <tr>
                   <th title="Human-readable gateway name">Gateway Name</th>
                   <th title="The gateway's database identifier -- the id to quote in a query, a ticket or an API call. Its Sparkplug edge node id is derived from this, so nothing is lost by showing it here.">Gateway UUID</th>
                   <th title="Where this gateway's connector runs, and whether its readings are real: Remote (an appliance on the plant network), Host (inside this stack), Simulated (host-run, readings generated), Shadow (republishes recorded captures)">Type</th>
                   <th title="Shopfloor cell zone this gateway serves">Cell Zone</th>
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
                           {/* THE KIND OF GATEWAY IS A COLUMN NOW, not two badges beside the name.
                               They were VIRTUAL and SIMULATED, could both appear at once, and
                               between them said three things -- where it runs, whether the numbers
                               are real, and (in the tooltip) "Cloud", which contradicted the first.
                               One Type column answers the question once, and sorts.

                               ARCHIVED STAYS HERE, because it is not a kind: a gateway of any type
                               can be decommissioned, and it is the state that changes what the row
                               MEANS rather than what the gateway IS. */}
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
                           {/* FOUR STATES, AND THE FIRST ONE IS "THE QUESTION DOES NOT APPLY".
                               A synthetic gateway cannot hold a cell -- gateways_synthetic_has_no_cell
                               (0059) -- so `location_scope` on one is inert: `device_locations`
                               resolves simulated and shadow AHEAD of it, and the value changes
                               nothing about where anything lands.

                               It was still being PRINTED, which is how four simulated gateways came
                               to report three different cell zones between them: the one seeded
                               `site_wide` read "Site-Wide" and the others read "No cell", a
                               difference with no behaviour behind it. Worse, "No cell" is rendered
                               as a warning promising devices in the Unassigned queue, and theirs
                               are in the Simulated lane. Both were answering a question this row
                               does not have.

                               Site-Wide is still an answer for every other gateway, and must not
                               read as the unanswered case, or nobody ever stops trying to fix it. */}
                           {!gatewayAcceptsCell(g)
                             ? <span style={{ fontSize: '11px', color: 'var(--text-dim)' }} title={`${gatewayTypeLabel(gatewayType(g))} gateways have no cell: their devices resolve to the ${gatewayTypeLabel(gatewayType(g))} lane, which takes precedence over cell membership.`}>—</span>
                             : g.location_scope === SCOPE_SITE_WIDE
                               ? <span className="badge badge-neutral" style={{ fontSize: '11px' }} title="Serves the whole facility rather than one cell. Its devices need their own cell.">Site-Wide</span>
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
                             /* Collapsed past three, as the Devices Type column is. A gateway
                                serving twenty devices rendered twenty-one chips and a row several
                                lines tall -- and the count is unbounded, since it grows with the
                                fleet rather than with a fixed vocabulary.

                                TWO KINDS OF ENTRY ARE PINNED. The Online/Offline summary is the
                                answer to "is this gateway healthy", which is the question the
                                column exists to answer, so hiding it behind a "+18" would defeat
                                the column. A QUARANTINED device is pinned for the same reason
                                Unmodelled is on Devices: it is the one entry that calls for
                                action, and it would otherwise be lost among the healthy ones. */
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
            {/* THE READ-ONLY IDENTIFIER BLOCKS ARE GONE, same as in the device form. Sparkplug ID,
                the publish-topic helper and the internal UUID were three of this dialog's rows and
                none of them could be edited; all three are on the context drawer, copyable, where
                somebody hunting an identifier actually looks. A form whose majority is read-only
                teaches the reader that its controls are decorative. */}
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
            {/* ONE CONTROL, NOT TWO CHECKBOXES, AND THE SCHEMA STILL HOLDS TWO FACTS.

                It was "Runs on this host" plus "Telemetry is simulated or replayed", which offered
                four combinations where the database permits three: `gateways_simulated_is_host`
                (0064) forbids a remote simulator, so one of the four was a write that would be
                refused after the operator had ticked it. A select over the legal states cannot
                express the refused one.

                This is a rendering of the constraint rather than a collapse of the model -- see
                utils/gatewayType.js. If a remote simulator is ever wanted, the CHECK relaxes in one
                line and a fourth option appears here with no data migration behind it.

                IT COMES BEFORE THE CELL ZONE BECAUSE IT GOVERNS IT. Choosing Simulated makes the
                field below unavailable, and a control that disables the one above it makes an
                operator re-read a decision they had already taken. */}
            <div className="form-group">
              <label className="form-label" htmlFor="gateway-type">Type</label>
              <select
                id="gateway-type"
                className="form-control"
                value={formType}
                onChange={e => setForm(f => ({
                  ...f,
                  ...gatewayTypeFields(e.target.value),
                  // CLEARED HERE, NOT LEFT FOR THE SAVE TO DISCOVER.
                  // `gateways_synthetic_has_no_cell` (0059) refuses a simulated gateway that holds
                  // a cell, so carrying a stale cell_id through this change turns the Save button
                  // into a constraint violation -- with the offending field disabled and the
                  // operator unable to see, let alone clear, the value being rejected.
                  ...(e.target.value === GATEWAY_TYPES.SIMULATED
                    ? { cell_id: '', location_scope: SCOPE_CELL }
                    : {})
                }))}
                title="Where this gateway's connector runs, and whether its readings are real"
              >
                {SELECTABLE_TYPES.map(t => (
                  <option key={t} value={t}>{gatewayTypeLabel(t)}</option>
                ))}
              </select>
            </div>
            {/* THE CONSEQUENCE, SAID BEFORE IT IS CHOSEN. Remote means a bundle to download and
                hardware to run it on; the other two mean the row is finished on save. That
                difference used to be invisible until after the gateway existed.

                Shown for every type rather than only on create, unlike the note it replaces: the
                Simulated description is about what the READINGS are, which an operator editing an
                existing row has as much reason to read as one creating it. */}
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '-6px', marginBottom: '12px' }}>
              {gatewayTypeDescription(formType)}
              {!editing && formType === GATEWAY_TYPES.REMOTE
                && ' On save you will be given a bundle to copy to that machine; it enrols itself and appears here as online.'}
            </div>
            {/* SITE-WIDE IS AN OPTION IN THIS LIST, NOT A CHECKBOX BESIDE IT.

                The two controls answered ONE question -- where does this gateway sit -- and the
                answers are mutually exclusive by CHECK (`gateways_site_wide_has_no_cell`): "it is
                in no particular cell" and "it is in Bay 4" cannot both be true. Splitting one
                question across a select and a tick box made the exclusion something the form had
                to enforce by clearing the other control, and made Site-Wide look like a modifier
                on a cell choice rather than an alternative to it.

                Its option value is SCOPE_SITE_WIDE, which cannot collide with a cell id: those are
                UUIDs. */}
            <div className="form-group">
              <label className="form-label" htmlFor="gateway-cell-zone">Shopfloor Cell Zone</label>
              <select
                id="gateway-cell-zone"
                className="form-control"
                // READS AS "NO CELL" FOR A SYNTHETIC GATEWAY WHATEVER IS STORED, which is the
                // reported bug in its other half: the seeded BMS simulator carries
                // `location_scope = 'site_wide'` from before 0059 made the flag win, so a disabled
                // box would have shown "Site-Wide" directly above a note saying simulated gateways
                // have no cell. The stored value is inert -- device_locations resolves `simulated`
                // ahead of it -- and this is a display fallback, not a write: nothing is cleared
                // here, only on the type change that would make the row unsavable.
                value={!formAcceptsCell
                  ? ''
                  : form.location_scope === SCOPE_SITE_WIDE ? SCOPE_SITE_WIDE : (form.cell_id || '')}
                disabled={!formAcceptsCell}
                onChange={e => setForm(f => (e.target.value === SCOPE_SITE_WIDE
                  ? { ...f, location_scope: SCOPE_SITE_WIDE, cell_id: '' }
                  : { ...f, location_scope: SCOPE_CELL, cell_id: e.target.value }))}
                title={formAcceptsCell
                  ? 'Cell this gateway serves — its devices inherit this cell unless they carry one of their own'
                  : 'A simulated gateway belongs to the Simulated lane, which resolves ahead of any cell'}
              >
                <option value="">— No cell assigned —</option>
                <option value={SCOPE_SITE_WIDE}>Site-Wide — serves no single cell</option>
                {cells.filter(c => !c.is_archived).map(c => (
                  <option key={c.cell_id} value={c.cell_id}>{c.cell_name}</option>
                ))}
              </select>

              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
                {!formAcceptsCell
                  /* Says which lane it lands in instead, so the disabled control reads as an
                     answer already given rather than as a field that failed to load. */
                  ? 'Simulated gateways have no cell: their devices resolve to the Simulated lane, which takes precedence over cell membership. gateways_synthetic_has_no_cell (0059) refuses the pairing outright.'
                  : form.location_scope === SCOPE_SITE_WIDE
                    ? 'Its devices inherit nothing from it, so each one needs its own cell — or its own Site-Wide mark. Scope is not inherited: a machine reached through a host-run connector is still in a cell.'
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
                title={proposeMode
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
            // The REAL group id where the gateway carries one. archived migration 0008 made the edge node
            // address (group, node) rather than node alone, so a wildcard here was throwing away
            // half of an address the row already knows -- and a topic you cannot paste into an MQTT
            // client without editing it first is not much of an answer. Falls back to `+` only
            // where the group is genuinely unrecorded.
            label: 'Sparkplug Topic Path',
            value: `spBv1.0/${selected.sparkplug_group || '+'}/NDATA/${selected.sparkplug_id || gatewaySparkplugId(selected.gateway_id)}`,
            mono: true,
            copyable: true,
            title: selected.sparkplug_group
              ? 'The NDATA topic this edge node publishes on.'
              : 'The NDATA topic this edge node publishes on. No Sparkplug group is recorded for it, so that segment is a wildcard.'
          },
          {
            label: 'Cell Zone',
            // A LINK when there is a cell to open. Site-Wide is deliberately left as plain text --
            // it is the assertion that this gateway belongs to no cell, so a chip styled like the
            // others but leading nowhere would promise an affordance that cannot exist.
            // Same three-way as the column, for the same reason: on a synthetic gateway the stored
            // scope is inert, so printing it here would contradict the row it was opened from.
            value: !gatewayAcceptsCell(selected)
              ? `${gatewayTypeLabel(gatewayType(selected))} — no cell`
              : selected.location_scope === SCOPE_SITE_WIDE
                ? 'Site-Wide'
                : selectedCell
                  ? (
                      <button
                        className="chip chip-link"
                        onClick={() => onSelectCell?.(selectedCell.cell_id)}
                        title="Open this cell on the Cells page"
                      >
                        <IconMap size={11} />
                        <span className="chip-name">{selectedCell.cell_name}</span>
                      </button>
                    )
                  : (selected.cell_id || null),
            title: !gatewayAcceptsCell(selected)
              ? `Its devices resolve to the ${gatewayTypeLabel(gatewayType(selected))} lane, which takes precedence over cell membership. gateways_synthetic_has_no_cell (0059) refuses the pairing.`
              : selected.location_scope === SCOPE_SITE_WIDE
                ? 'A host-run or central connector serving the whole facility. Its devices inherit no cell from it.'
                : 'Devices served by this gateway resolve to this cell unless they carry one of their own.'
          },
          { label: 'Last Heartbeat', value: formatHeartbeat(selected.last_heartbeat), title: 'Age of the last NBIRTH/NDATA/NDEATH. STALE after 90 seconds of silence.' },
          /**
           * WHAT THE APPLIANCE SAYS ABOUT ITSELF (archived migration 0035).
           *
           * SHOWN ONLY WHEN IT HAS REPORTED, and `health_reported_at` is what decides -- not the
           * individual values. A gateway that has never reported health is a virtual one or an
           * appliance on an older bundle, and six rows of "--" would read as six faults rather than
           * as a capability it does not have. A gateway that reported once and stopped keeps its
           * last values AND its reporting age, which is the pair that says so.
           *
           * These are CURRENT VALUES WITH NO HISTORY -- the trend lives in Grafana's Gateway Fleet
           * Health dashboard, off Prometheus gauges. So there is deliberately no sparkline here:
           * one drawn from a single value would be a straight line implying a stability nothing
           * measured.
           */
          ...(selected.health_reported_at ? [
            {
              label: 'Health Reported',
              value: formatHeartbeat(selected.health_reported_at),
              title: 'Age of the last heartbeat that carried appliance health. Separate from Last '
                + 'Heartbeat on purpose: a gateway can keep beating while its collector has stopped.'
            },
            {
              label: 'CA Expires',
              value: formatCertExpiry(selected.cert_expires_at),
              danger: isCertExpiring(selected.cert_expires_at),
              title: 'When the broker CA THIS appliance trusts expires, as it reported. The CA is '
                + 'distributed by hand into every trust store, so re-issuing it is a fleet '
                + `operation -- Grafana alerts at ${CERT_EXPIRY_WARN_DAYS} days.`
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
            {
              label: 'Flow',
              value: selected.flow_hash ? selected.flow_hash.slice(0, 12) : null,
              title: 'First 12 characters of the SHA-256 of the flow this appliance was '
                + 'provisioned with. Identifies which bundle\'s flow is installed; it does NOT '
                + 'detect edits made afterwards in the Node-RED editor.'
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
           * ASK THE NODE TO SAY WHO IT IS AGAIN.
           *
           * `Node Control/Rebirth` republishes the birth certificate: the metric list, the datatypes
           * and the ALIAS TABLE every subsequent DDATA is resolved against. The daemon already sends
           * this on its own -- at startup, on every sequence gap, at the start of every capture --
           * because that table is in-memory and a stable device may not birth again for weeks. This
           * is the same publish with a person as the reason, and until now the only way to get one
           * was to nudge a node in the Node-RED editor and redeploy.
           *
           * IT IS THE ONLY COMMAND THIS DASHBOARD SENDS, and the distinction is worth keeping in
           * view: a rebirth asks a node to RESTATE WHAT IT ALREADY IS. Sparkplug's same NCMD channel
           * can write metric values, which is actuation, and that is deliberately not reachable from
           * here -- see 0058.
           *
           * NOT ON AN ARCHIVED GATEWAY, where nothing is listening.
           *
           * AND NOT ON A SHADOW GATEWAY, where nothing is listening either -- for a different
           * reason worth keeping distinct. The playback worker only PUBLISHES: it holds no
           * subscription (see playback_worker.py, which says so at the top and explains that this
           * is why the `seq` objection that kept capture inside the daemon does not apply to it).
           * So an NCMD addressed to the playback edge node is received by nobody, and the request
           * would sit in `rebirth_requests` recording something that can never be answered.
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
           * SETUP COMES FIRST WHILE IT IS UNFINISHED, above Launch UI and Edit.
           *
           * A physical gateway that has never enrolled has no UI to launch and nothing worth editing
           * -- the only useful action is "give me the bundle". Shown for AWAITING_BIRTH too, because
           * an appliance that enrolled and then never published is the case where an operator needs to
           * re-issue and start again, and that is otherwise a dead end.
           *
           * Absent once the gateway is ONLINE: re-issuing then would invalidate the credential a
           * working appliance is using, which is a destructive act dressed as a convenience.
           *
           * CONFIRM FIRST ON THIS ROUTE, unlike the one straight after creation. This gateway is not
           * new: it may already hold a live token somebody downloaded, or -- at AWAITING_BIRTH -- a
           * broker credential an appliance is holding. Issuing destroys whichever it has, so the
           * modal asks for the gateway's name before it mints anything.
           */
          !selected.is_archived && selected.deployment === 'remote' && isGatewayPending(selected) && canManage && {
            label: selected.status === 'AWAITING_BIRTH' ? 'Re-issue Bundle' : 'Download Setup Bundle',
            icon: <IconDownload size={13} />,
            primary: true,
            onClick: () => setBundleForGw({
              gateway_id: selected.gateway_id,
              gateway_name: selected.gateway_name,
              sparkplug_id: selected.sparkplug_id,
              status: selected.status,
              confirmFirst: true
            }),
            title: selected.status === 'AWAITING_BIRTH'
              ? 'This appliance enrolled but has not published. Re-issuing invalidates its current credential.'
              : 'Generate the bootstrap bundle for this gateway and download it'
          },
          /*
           * THE HOST-RUN COUNTERPART, AND THE CONDITIONS ARE THE MIRROR OF THE ONE ABOVE.
           *
           * `deployment === 'host'` instead of `'remote'`, and no `isGatewayPending()`: enrolment is
           * a lifecycle a remote appliance passes through, and a host-run gateway has none -- there
           * is no appliance to wait for, so there is no state in which minting is premature or too
           * late. The two RPCs behind these buttons are mirror images on the same axis, which is
           * why the column is named for that axis.
           *
           * NOT SHOWN ON AN ARCHIVED GATEWAY, matching the bundle action and 0041's own refusal.
           * 0037 found that a bundle downloaded before archiving stayed redeemable afterwards and
           * resurrected the row; minting directly is the same hole reached in one step.
           *
           * THIS IS THE ONLY PLACE A PASSWORD APPEARS IN THE PRODUCT. Everything else either hands
           * out a claim (the bundle) or never reveals a secret at all, which is why the modal
           * confirms unconditionally rather than taking the bundle modal's create-time exemption.
           */
          !selected.is_archived && selected.deployment === 'host' && canManage && {
            label: 'Generate Broker Credential',
            icon: <IconLock size={13} />,
            primary: true,
            onClick: () => setCredentialForGw({
              gateway_id: selected.gateway_id,
              gateway_name: selected.gateway_name,
              sparkplug_id: selected.sparkplug_id
            }),
            // NAMED BY THE CONDITION THE ACTION IS GATED ON, which is `deployment === 'host'`. It
            // said "this virtual gateway", a word this codebase does not use because it meant
            // three things at once -- and the one it meant HERE is the one this tooltip needs: no
            // appliance, so the credential is minted in the browser instead of on the box.
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
            /* WITHDRAWN FROM THE PLAYBACK GATEWAY, and not merely because there is no reason to
               edit it -- the form OFFERS WRITES THE DATABASE REFUSES on this row.

               `gateways_shadow_is_simulated` (0059) is `NOT is_shadow OR is_simulated`, and this
               gateway is the one row where is_shadow is true. So choosing Remote or Host in the
               Type control sets is_simulated = false and the save comes back a CHECK violation:
               two of the three options are dead ends. That is precisely the failure the two
               checkboxes had before 0064 -- a combination an operator can pick and then have
               rejected -- reappearing on one row because the form cannot express "this one is
               already a fourth type".

               Nothing here needs changing anyway. 0060 seeds the row, its name and description are
               its own, it has no appliance to give an access URL, and gateways_synthetic_has_no_cell
               forbids the cell. The remaining editable field is a label on a gateway nobody browses
               to. Withdrawing the whole action is smaller and clearer than a form that disables
               four of its five fields.

               Renaming is still possible from the database for anyone who genuinely needs it, which
               is the right amount of friction for a row the platform depends on by flag. */
            label: proposeMode ? 'Propose a Change' : 'Edit Details', icon: <IconPencil size={13} />,
            onClick: () => {
              setEditing(selected)
              const mine = proposeMode
                ? openProposals.find(pr => pr.entity_type === 'gateways' && pr.entity_id === selected.gateway_id)
                : null
              setEditingProposal(mine || null)
              setForm({ ...selected, ...formFromPatch('gateway', mine?.patch) })
              setShowForm(true)
            },
            disabled: !canManage && !canPropose,
            title: proposeMode
              ? 'Ask for a change to this gateway — an approver applies it, or says why not'
              : !canManage && !canPropose
                ? 'Requires Admin permissions'
                : 'Edit gateway configuration'
          },
          /* WITHHELD FROM A READER WHO MAY NOT OPEN THE PAGE. The nav hides Digital Thread
             without `digital_thread:read`; a drawer button that navigated there anyway would be
             the one route into a page the app has decided not to show, landing them on an empty
             table that explains nothing. `.filter(Boolean)` below drops it. */
          canReadThread && {
            label: 'View Digital Thread', icon: <IconHistory size={13} />,
            onClick: () => onViewThread?.(selected),
            title: 'Open the immutable audit trace for this gateway'
          },
          {
            label: 'Manage Links', icon: <IconBookOpen size={13} />,
            onClick: () => setDocsForGw(selected),
            title: 'Attach or edit links for this gateway — documents, an asset register, a file repository, any URL'
          },
          /* NOT OFFERED FOR THE PLAYBACK GATEWAY, and 0067 refuses it in the database as well --
             this only stops an operator being shown a button whose failure is a database error.

             Archiving the last shadow gateway leaves broker playback with no edge node to publish
             as, and `ensure_shadow_devices()` finds it by flag, so the failure surfaces weeks later
             at the moment somebody starts a job. The archive itself reports success and reads as
             ordinary housekeeping. Swapping in a second shadow gateway first is legitimate and is
             allowed; the database is where that distinction is enforced. */
          !selected.is_archived && !selected.is_shadow && {
            label: 'Archive Gateway', icon: <IconArchive size={13} />,
            onClick: () => setArchiveTarget(selected),
            disabled: !canArchive,
            danger: true,
            title: !canArchive ? 'Requires Admin permissions' : 'Decommission & Archive Gateway'
          },
        ].filter(Boolean) : []}
        /* WITH THE METADATA, ABOVE THE ACTIONS. "Which devices" is a fact about this gateway
           rather than an action on it -- it is the question the row's Connected Devices count
           raises and cannot answer, so it belongs with Last Heartbeat and the topic path, not
           below a list of buttons where it read as an afterthought. */
        beforeActions={selected && (
          <div>
            <div className="context-panel-section-label">Connected Devices ({selectedDevices.length})</div>
            {selectedDevices.length === 0
              ? <div className="context-field-empty" style={{ fontSize: '11px' }}>No devices assigned</div>
              : (
                /* CHIPS THAT GO SOMEWHERE, not status badges. This list answers "which devices" and
                   then stranded you: the next question is always "what is wrong with that one", and
                   the only way through was to read a name off here, switch tab and search for it.
                   Now it is a click, matching the Cell Zone and Schema chips elsewhere in this
                   drawer -- one navigation idiom across all four pages rather than three.

                   THE LIFECYCLE STATE SURVIVES THE CHANGE, as a dot rather than as the chip's own
                   colour. A chip coloured by status would collide with `chip-link`'s hover, and the
                   two facts are independent: where this goes, and how the device is doing. */
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

            {/* WITH THE METADATA FOR THE SAME REASON AS THE DEVICE LIST: "what is saved for this
                appliance" is a fact about the gateway, and it is the question the AWAITING SETUP
                badge raises. Hidden entirely from a role with no read authority -- see the
                component's header for why an empty list cannot stand in for a denial. */}
            {!selected.is_archived && (
              <div style={{ marginTop: '14px' }}>
                <FlowBackupUploader
                  gateway={selected}
                  canRead={canReadBackups}
                  canManage={canManageBackups}
                  showToast={showToast}
                />
              </div>
            )}

            {/* THE CAPTURE LIBRARY THAT WAS HERE MOVED TO THE CAPTURE PAGE, and it had to rather
                than merely being tidier there. This panel listed the bucket directly: objects with
                a name, a size and a timestamp. 0055 stores ONE capture per subject at a
                deterministic path, with the note, the message count and the manifest -- including
                `birth_captured`, which decides whether a capture will replay at all -- in a table.
                Left here it would have shown a single row called `capture.json` and none of the
                facts that matter, which is worse than not showing it.

                It also only ever covered GATEWAYS. Captures are filed by the subject recorded, and
                a device is now a subject in its own right; a per-gateway panel has nowhere to put
                that. */}
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
        />
      )}
    </div>
  )
}
