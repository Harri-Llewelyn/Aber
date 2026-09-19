import React, { useState, useCallback, useMemo } from 'react'
import { api } from '../../api'
import { POLL_INTERVAL_MS, PERMISSION_UUIDS } from '../../constants'
import { usePolling } from '../../hooks/usePolling'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { ContextPanel, rowSelectHandler } from '../common/ContextPanel'
import { IconPencil, IconCheck, IconX, IconArchive, IconHistory, IconInbox } from '../common/Icons'
import { HelpTip } from '../common/HelpTip'
import { PageHeading } from '../common/PageHeading'

/**
 * The Approvals page: one inbox for every change somebody proposed but may not apply.
 *
 * It is not an authority: every control mirrors what the database would allow, the RPC re-checks
 * the caller's role, and RLS refuses an INSERT this page would send. Being wrong shows up as a
 * readable refusal.
 */

/**
 * The lanes and their labels. `entity_type` holds the table name, the vocabulary `digital_thread`
 * speaks; the label is presentation only.
 */
/**
 * The lanes the queue admits, mirroring the CHECK constraint and `proposable_columns()`. No schema
 * lane: creating a draft needs `schema:manage`, so the only person who could propose a publication
 * could also perform it. Historical rows in that lane still render through the `entity_type`
 * fallback below. The form for each lane is the asset's own Edit Details dialog.
 */
export const LANES = [
  {
    id: 'devices',
    label: 'Device details',
    blurb: 'Name, description, type, connection and location.'
  },
  {
    id: 'device_nameplate',
    label: 'Device nameplate',
    blurb: 'The IDTA Digital Nameplate a person asserts about a machine — manufacturer, serial, '
      + 'versions.'
  },
  {
    id: 'areas',
    label: 'Area details',
    blurb: 'An area’s name, its description and its icon. The name is also the <area> segment of '
      + 'every uns/ topic beneath it.'
  },
  {
    id: 'cells',
    label: 'Cell details',
    blurb: 'A cell’s name, its Grafana dashboard and its icon.'
  },
  {
    id: 'gateways',
    label: 'Gateway details',
    blurb: 'Name, description, access URL and where the gateway sits. Not what it IS, and not what '
      + 'the platform observed about its health.'
  },
  /* No link lanes. 0108 withdrew `cell_links`, `gateway_links` and `device_links`: no UI ever filed
     one, and a link is attached directly through `link:manage`. LANE_BY_ID falls back rather than
     filtering, so a decided row left over from before still renders under its raw lane name. */
]

const LANE_BY_ID = new Map(LANES.map(l => [l.id, l]))

/**
 * A readable label for a proposable key. Presentation only, and it falls back rather than filters:
 * a key the database accepts and this map does not know renders as its raw column name.
 */
const KEY_LABELS = {
  name: 'Name',
  description: 'Description',
  asset_type: 'Asset type',
  connection_method: 'Connection method',
  cell_id: 'Cell',
  area_id: 'Area',
  plan_x: 'Place on the plan (x)',
  plan_y: 'Place on the plan (y)',
  location_scope: 'Location scope',
  model_3d_path: '3D model path',
  grafana_url: 'Grafana dashboard',
  access_url: 'Access URL',
  icon: 'Icon',
  manufacturer_name: 'Manufacturer',
  manufacturer_product_designation: 'Product designation',
  manufacturer_product_type: 'Product type',
  serial_number: 'Serial number',
  year_of_construction: 'Year of construction',
  date_of_manufacture: 'Date of manufacture',
  hardware_version: 'Hardware version',
  firmware_version: 'Firmware version',
  software_version: 'Software version',
  country_of_origin: 'Country of origin',
  uri_of_the_product: 'Product URI',
  publish: 'Publish this draft'
}

export function keyLabel(key) {
  return KEY_LABELS[key] || key
}

/**
 * Whether this session may decide this lane, mirroring `may_decide_proposal()`. The live lanes are
 * gated on `cell:manage`, `gateway:manage` and `link:manage`, held by exactly these two roles
 * today; the withdrawn schema lane is false for everybody. A mirror that is allowed to be wrong:
 * the database decides again on every call.
 */
export function canDecide(entityType, userRole) {
  if (entityType === 'schemas') return false
  return userRole === 'Administrator' || userRole === 'Shopfloor_Manager'
}

/** How long a proposal has been waiting, in the coarsest unit that is still true. */
export function ageLabel(iso, now = Date.now()) {
  const ms = now - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return ''
  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** `null` renders as an explicit word rather than as a blank a reader would take for "unchanged". */
function displayValue(v) {
  if (v === null || v === undefined || v === '') return '—'
  if (v === true) return 'yes'
  if (v === false) return 'no'
  return String(v)
}

/**
 * Every id a proposal can name, against the name a person would recognise. `cell_id` and
 * `area_id` are proposable columns, so the before/after table renders uuids unless something
 * resolves them, and "move this device to 6f2a…" does not say what the change would do.
 *
 * Built from both lists because neither is complete on its own: `/api/v1/areas` embeds an area's
 * cells, and a cell filed under no area appears only in `/api/v1/cells`.
 */
export function locationNameMap(cells, areas) {
  const names = new Map()
  const addCell = c => { if (c?.cell_id) names.set(c.cell_id, c.cell_name || c.name) }
  for (const c of cells || []) addCell(c)
  for (const a of areas || []) {
    if (a?.area_id) names.set(a.area_id, a.area_name || a.name)
    for (const c of a.cells || []) addCell(c)
  }
  return names
}

/**
 * One before/after value. A resolved id shows its name and keeps the uuid in the tooltip; an id
 * nothing resolves falls back to the uuid rather than being hidden, which is the same rule the
 * lane and key labels follow -- an archived or deleted cell is a real state, and a reviewer
 * seeing a raw uuid is better served than one seeing a blank.
 */
function ValueCell({ value, names }) {
  const named = typeof value === 'string' ? names?.get(value) : undefined
  if (named) return <span title={value}>{named}</span>
  return <>{displayValue(value)}</>
}

/**
 * What a proposal would change, as before / after pairs. The schema lane's patch names an act
 * (`{publish: true}`), not a column, so it gets a sentence instead of a diff.
 */
export function diffRows(proposal) {
  const patch = proposal?.patch || {}
  if (proposal?.entity_type === 'schemas') return []
  const current = proposal?.current || {}
  return Object.keys(patch).map(key => ({
    key,
    from: current[key],
    to: patch[key],
    // A key whose proposed value already matches is worth marking rather than hiding: it tells the
    // approver this part of the proposal is a no-op, which is a reason to ask about it.
    unchanged: JSON.stringify(current[key] ?? null) === JSON.stringify(patch[key] ?? null)
  }))
}

/**
 * The message for a refused INSERT and the repair each needs. `23505` is the per-asset cap, and the
 * repair is to open the proposal you already have, so the caller is handed the row. `23514` is the
 * per-person ceiling.
 */
export function refusalFor(error, existing) {
  const code = error?.code
  if (code === '23505') {
    return {
      message: existing
        ? 'You already have an open proposal on this asset. Add to that one rather than opening a second.'
        : 'You already have an open proposal on this asset.',
      openExisting: Boolean(existing)
    }
  }
  if (code === '23514') {
    return { message: error?.message || 'You are at your limit for open proposals.', openExisting: false }
  }
  if (code === '42501') {
    return { message: 'You are not permitted to do that.', openExisting: false }
  }
  return { message: error?.message || 'The proposal was refused.', openExisting: false }
}

function StatusBadge({ status }) {
  const cls = {
    open: 'badge-pending',
    applied: 'badge-online',
    rejected: 'badge-offline',
    withdrawn: 'badge-neutral',
    expired: 'badge-warning'
  }[status] || 'badge-neutral'
  return <span className={`badge ${cls}`}>{status}</span>
}

/**
 * The proposer. `proposed_by_email` is stamped from the signed access token on INSERT, so it is
 * evidence rather than a typed name; the uuid is the fallback, because a token without an email is
 * a real state.
 */
function ActorLabel({ id, email, currentUserId }) {
  if (!id) return <span className="context-field-empty">—</span>
  if (id === currentUserId) return <strong>you</strong>
  if (email) return <span title={id}>{email}</span>
  return <span className="mono" title={id}>{String(id).slice(0, 8)}</span>
}

/**
 * An absolute timestamp in the viewer's locale and zone, beside the relative one: 31m ago is for
 * triage, the wall-clock time is for a ticket.
 */
export function absoluteTime(iso) {
  if (!iso) return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  return at.toLocaleString()
}

/** The before/after table, shared by the drawer and by nothing else -- see `diffRows`. */
function DiffTable({ proposal, names }) {
  const rows = diffRows(proposal)
  if (proposal.entity_type === 'schemas') {
    return (
      <p style={{ margin: 0 }}>
        Publish this draft. Approving activates it, archives its predecessor and repoints every
        attached device — in one transaction.
      </p>
    )
  }
  if (rows.length === 0) return <p style={{ margin: 0 }}>This proposal changes nothing.</p>
  return (
    <table className="modal-table">
      <thead>
        <tr><th>Field</th><th>Now</th><th>Proposed</th></tr>
      </thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.key}>
            <td>{keyLabel(r.key)}</td>
            <td className="text-muted"><ValueCell value={r.from} names={names} /></td>
            <td>
              <strong><ValueCell value={r.to} names={names} /></strong>
              {r.unchanged && <span className="badge badge-neutral"> unchanged</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function RejectDialog({ onCancel, onConfirm, busy }) {
  const [reason, setReason] = useState('')
  const blank = reason.trim() === ''
  // On the shared stack rather than a listener of its own: Escape must close the topmost layer and
  // only that one, or answering "no" to a confirmation would take the page's other state with it.
  useEscapeKey(onCancel)
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
        <div className="modal-header-row">
          <h3 className="modal-title">Reject this proposal</h3>
        </div>
        <div className="card-body">
          {/* The reason is required by a CHECK constraint: a rejected proposal frees its slot at
              once, so the reason is what makes a second attempt different from the first. */}
          <label className="form-label" htmlFor="reject-reason">
            Why? The proposer sees this, and it is the only thing they get other than “no”.
          </label>
          <textarea
            id="reject-reason"
            className="form-control"
            rows={3}
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="That machine is being retired next month."
          />
        </div>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={blank || busy}
            onClick={() => onConfirm(reason.trim())}
          >
            Reject
          </button>
        </div>
      </div>
    </div>
  )
}

/* There is no composer on this page. The form that writes a proposal is the asset's own Edit
   Details dialog, whose footer files a proposal for somebody who may not save it
   (utils/proposeFromForm.js). This page is a queue: what is waiting, what was decided, and the
   drawer that decides one. Editing your own open proposal hands over to the asset's page. */


/**
 * One list of proposals, as a table. The row carries what you triage on; the drawer carries the
 * diff and every action.
 */
function ProposalTable({ rows, selectedId, onSelect, emptyText }) {
  if (rows.length === 0) {
    /* With the glyph every other page's empty state carries: words alone in a card that usually
       holds a table read as a load that failed rather than a queue that is clear. */
    return (
      <div className="empty-state">
        <div className="empty-icon"><IconInbox size={36} /></div>
        <div className="empty-text">{emptyText}</div>
      </div>
    )
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          {/* No Proposed by column: a uuid resolves to nobody at a glance, and the drawer names the
              proposer by email. Status and time are two columns because they are two facts. */}
          <tr>
            <th title="The asset or schema this proposal is about">Subject</th>
            <th title="Which lane, and therefore who may decide it">Change</th>
            <th title="The fields this proposal would change">Field(s) changed</th>
            <th title="Its current state">Status</th>
            <th title="When it was filed, or when it was decided">When</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(p => {
            const lane = LANE_BY_ID.get(p.entity_type)
            const diff = diffRows(p)
            const summary = p.entity_type === 'schemas'
              ? 'Publish this draft'
              : diff.length === 0
                ? 'Nothing'
                : diff.map(d => keyLabel(d.key)).join(', ')
            return (
              <tr
                key={p.id}
                data-testid="proposal-row"
                className={selectedId === p.id ? 'row-selected' : ''}
                onClick={rowSelectHandler(() => onSelect(p.id))}
                title="Click to inspect this proposal in the details panel"
              >
                <td>
                  <strong>{p.target_label}</strong>
                  {p.target_missing && (
                    <span className="badge badge-warning" style={{ marginLeft: '8px' }}
                          title="The target of this proposal no longer exists, so approving it will fail rather than recreate anything.">
                      MISSING
                    </span>
                  )}
                </td>
                <td><span className="badge badge-neutral">{lane?.label || p.entity_type}</span></td>
                <td className="text-muted">{summary}</td>
                <td><StatusBadge status={p.status} /></td>
                <td className="text-muted" title={absoluteTime(p.decided_at || p.proposed_at)}>
                  {ageLabel(p.decided_at || p.proposed_at)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/**
 * The filter both queues share. `entity_id` is searchable because a route from elsewhere arrives
 * pointed at one subject by uuid.
 */
export function filterProposals(rows, lane, query) {
  const needle = String(query || '').trim().toLowerCase()
  return rows.filter(p => {
    if (lane !== 'all' && p.entity_type !== lane) return false
    if (!needle) return true
    // The fields somebody remembers about a request: subject, reason, rationale, proposer email,
    // and the id.
    return [p.target_label, p.decision_reason, p.rationale, p.proposed_by_email, p.entity_id]
      .some(v => String(v || '').toLowerCase().includes(needle))
  })
}

/** The kind-and-text filter bar, identical over both queues because the queues are one shape. */
function ProposalFilters({ rows, lane, onLane, query, onQuery, placeholder, label }) {
  const activeFilterCount = (lane !== 'all' ? 1 : 0) + (query ? 1 : 0)
  return (
    <div className="filter-bar">
      <select
        className="form-control"
        style={{ width: '190px' }}
        value={lane}
        onChange={e => onLane(e.target.value)}
        title="Filter by the kind of change"
        aria-label={`Filter ${label} by kind`}
      >
        <option value="all">All kinds ({rows.length})</option>
        {LANES.map(l => (
          <option key={l.id} value={l.id}>
            {l.label} ({rows.filter(p => p.entity_type === l.id).length})
          </option>
        ))}
      </select>
      <input
        className="form-control"
        style={{ width: '260px' }}
        value={query}
        onChange={e => onQuery(e.target.value)}
        placeholder={placeholder}
        title={`Filter ${label} by what they are about`}
      />
      {activeFilterCount > 0 && (
        <button
          type="button"
          className="btn btn-ghost btn-sm filter-bar-spacer"
          onClick={() => { onLane('all'); onQuery('') }}
          title="Clear every filter"
        >
          <IconX size={13} /> Clear filters ({activeFilterCount})
        </button>
      )}
    </div>
  )
}

export function ApprovalsTab({
  showToast, hasPermission, userRole, currentUserId, onViewThread,
  // Arrives from another page, one-shot: `initialSubject` points the working queue at one asset.
  // Cleared through `onClearFocus` so returning later does not reapply it.
  initialSubject = '', onClearFocus,
  // Hand back to the asset's page, which is where the form that edits a proposal now lives.
  onOpenSubject
}) {
  const [proposals, setProposals] = useState([])
  const [devices, setDevices]     = useState([])
  // Ids the before/after table resolves to names. Empty is a working state: every value falls back
  // to its uuid, which is what the page did before.
  const [locationNames, setLocationNames] = useState(() => new Map())

  const [loading, setLoading]     = useState(true)

  const [rejecting, setRejecting] = useState(null)
  const [busyId, setBusyId]       = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [decidedLane, setDecidedLane] = useState('all')
  const [decidedQuery, setDecidedQuery] = useState('')
  const [openLane, setOpenLane] = useState('all')
  // Set by the route effect below when the hand-over arrives, and freely editable afterwards --
  // a filter somebody cannot clear is a trap, not a shortcut.
  const [openQuery, setOpenQuery] = useState('')

  const loadAll = useCallback(async (signal) => {
    try {
      const [rows, deviceRows, cellRows, areaRows] = await Promise.all([
        api.get('/api/v1/proposals', { signal }),
        api.get('/api/v1/assets', { signal }).catch(() => []),
        // Names only, and tolerated failures: a reviewer who cannot read the cell list still gets
        // the queue, with ids where names would have been.
        api.get('/api/v1/cells', { signal }).catch(() => []),
        api.get('/api/v1/areas', { signal }).catch(() => [])
      ])
      setProposals(rows)
      setDevices((deviceRows || []).filter(d => !d.is_archived))
      // Archived cells included: a proposal filed before one was archived still names it, and the
      // reviewer deciding it needs to see which cell that was.
      setLocationNames(locationNameMap(cellRows, areaRows))
      setLoading(false)
    } catch (e) {
      if (e.name !== 'AbortError') setLoading(false)
      throw e
    }
  }, [])

  usePolling(loadAll, POLL_INTERVAL_MS)

  /* An effect, not an initial state: every tab stays mounted across navigation, so
     `useState(initialSubject)` would run once and ignore every later hand-over. */
  React.useEffect(() => {
    if (!initialSubject) return
    setOpenQuery(initialSubject)
    // Both queues are narrowed, so a decided proposal about the same device does not sit unfiltered
    // below.
    setDecidedQuery(initialSubject)
    setSelectedId(null)
    onClearFocus?.()
  }, [initialSubject, onClearFocus])

  const refresh = useCallback(async () => {
    try { await loadAll() } catch { /* the poller reports a failing backend */ }
  }, [loadAll])

  // OLDEST FIRST IN THE QUEUE, newest first in the record. A queue is worked from the front; a
  // record is read from the most recent.
  const open = useMemo(
    () => proposals.filter(p => p.status === 'open')
      .sort((a, b) => new Date(a.proposed_at) - new Date(b.proposed_at)),
    [proposals]
  )

  const decided = useMemo(() => proposals.filter(p => p.status !== 'open'), [proposals])

  const decidedFiltered = useMemo(
    () => filterProposals(decided, decidedLane, decidedQuery), [decided, decidedLane, decidedQuery])

  // The working queue filters too: the device drawer routes here with the machine's id as the
  // query.
  const openFiltered = useMemo(
    () => filterProposals(open, openLane, openQuery), [open, openLane, openQuery])

  // Resolved fresh every render, so a proposal that is decided out from under the drawer -- by the
  // poller, or by somebody else -- closes it rather than leaving a stale row on screen.
  const selected = proposals.find(p => p.id === selectedId) || null

  const decide = async (proposal, action, reason) => {
    setBusyId(proposal.id)
    try {
      await api.post(`/api/v1/proposals/${proposal.id}/${action}`, reason ? { reason } : {})
      showToast?.(action === 'approve' ? 'Approved, and applied.' : 'Rejected.', 'success')
      setRejecting(null)
      await refresh()
    } catch (e) {
      // The message is the database's: an approval can fail because the patch violates a CHECK, and
      // that sentence is the one the approver needs.
      showToast?.(e?.message || 'That was refused.', 'error')
    } finally {
      setBusyId(null)
    }
  }

  const withdraw = async (proposal) => {
    setBusyId(proposal.id)
    try {
      await api.post(`/api/v1/proposals/${proposal.id}/withdraw`, {})
      showToast?.('Withdrawn.', 'success')
      await refresh()
    } catch (e) {
      showToast?.(e?.message || 'That was refused.', 'error')
    } finally {
      setBusyId(null)
    }
  }

  const canPropose = hasPermission?.(PERMISSION_UUIDS.PROPOSAL_CREATE)
  const mine = selected && selected.proposed_by === currentUserId
  const decidable = selected && selected.status === 'open' && canDecide(selected.entity_type, userRole)

  const panelActions = !selected ? [] : [
    ...(decidable ? [
      {
        label: 'Approve', primary: true, icon: <IconCheck size={13} />,
        pending: busyId === selected.id,
        pendingLabel: 'Approving…',
        title: 'Apply this change now, as you',
        onClick: () => decide(selected, 'approve')
      },
      {
        label: 'Reject', danger: true, icon: <IconX size={13} />,
        title: 'Refuse it, with a reason the proposer will see',
        onClick: () => setRejecting(selected)
      }
    ] : []),
    // Only when there is a row to open: `applied_thread_id` is set by an approval and by nothing
    // else.
    ...(selected.applied_thread_id && onViewThread ? [{
      label: 'View in Digital Thread', icon: <IconHistory size={13} />,
      title: 'The audit row this approval wrote, naming both the proposer and the approver',
      onClick: () => onViewThread(selected)
    }] : []),
    ...(mine && selected.status === 'open' ? [
      /* Edit is a hand-over, not a dialog: the asset's page opens with Propose a Change seeded from
         this proposal. One open proposal per asset per person, so a second field extends the
         request. */
      ...(onOpenSubject ? [{
        label: 'Add to this proposal', icon: <IconPencil size={13} />,
        title: 'Open this asset, where the same dialog that edits it will extend your request',
        onClick: () => onOpenSubject(selected)
      }] : []),
      {
        label: 'Withdraw', icon: <IconArchive size={13} />,
        pending: busyId === selected.id,
        pendingLabel: 'Withdrawing…',
        title: 'Take your own proposal back',
        onClick: () => withdraw(selected)
      }
    ] : [])
  ]

  if (loading) {
    return <div className="loading-wrap"><div className="spinner" /> Loading proposals…</div>
  }

  return (
    <div className="page-layout">
      <div className="page-main">

        {/* No Propose a Change card: the act starts on the asset's own page. */}
        <PageHeading icon={<IconInbox size={15} />} title="Approvals">
          A proposal is a request, not a change: nothing is written until somebody who may make
          it approves. {canPropose
            ? 'To ask for one, open the asset on its own page and use Propose a Change — the same dialog that edits it.'
            : 'Your role can decide proposals but not file them.'}
        </PageHeading>

        <div className="card approvals-card">
          <div className="card-header">
            <h3 className="section-title">
              Awaiting a decision
              <HelpTip
                label="About the open queue"
                text="The working queue, oldest first. Select a row to see exactly what would change and to decide it. Approving applies the change immediately in one transaction, so a proposal that would break a rule fails here rather than later."
              />
            </h3>
          </div>
          <div className="card-body">
            <ProposalFilters
              rows={open} lane={openLane} onLane={setOpenLane}
              query={openQuery} onQuery={setOpenQuery}
              label="open proposals"
              placeholder="Search subject, proposer or rationale…"
            />
          </div>
          <ProposalTable
            rows={openFiltered}
            selectedId={selectedId}
            onSelect={setSelectedId}
            emptyText={openLane !== 'all' || openQuery
              ? 'Nothing open matches that filter.'
              : 'Nothing is waiting. A proposal appears here when somebody asks for a change they cannot make themselves.'}
          />
        </div>

        <div className="card approvals-card">
          <div className="card-header">
            <h3 className="section-title">
              Decided
              <HelpTip
                label="About decided proposals"
                text="What was applied, rejected, withdrawn or left to expire, kept for the retention period an Administrator sets. What an approval actually changed lives in the Digital Thread, so pruning here destroys no record."
              />
            </h3>
          </div>
          <div className="card-body">
            <ProposalFilters
              rows={decided} lane={decidedLane} onLane={setDecidedLane}
              query={decidedQuery} onQuery={setDecidedQuery}
              label="decided proposals"
              placeholder="Search subject, proposer, reason or rationale…"
            />
          </div>
          <ProposalTable
            rows={decidedFiltered}
            selectedId={selectedId}
            onSelect={setSelectedId}
            emptyText={decided.length === 0
              ? 'Nothing has been decided yet.'
              : 'No decided proposal matches the selected filter.'}
          />
        </div>
      </div>

      <ContextPanel
        open={!!selected}
        onClose={() => setSelectedId(null)}
        type="PROPOSAL"
        subject="proposal"
        onCopy={showToast}
        title={selected?.target_label || ''}
        subtitle={selected && (
          <>
            <span className="badge badge-neutral" style={{ fontSize: '11px' }}>
              {LANE_BY_ID.get(selected.entity_type)?.label || selected.entity_type}
            </span>
            <StatusBadge status={selected.status} />
          </>
        )}
        fields={selected ? [
          {
            label: 'Proposed by',
            value: <ActorLabel id={selected.proposed_by} email={selected.proposed_by_email}
                               currentUserId={currentUserId} />,
            title: 'Taken from the signed access token when the proposal was filed, not from a form.'
          },
          {
            // BOTH READINGS, and the relative one is the parenthetical: this panel is where
            // somebody goes to quote a time into a ticket, and "31m ago" cannot be quoted.
            label: 'Proposed at',
            value: `${absoluteTime(selected.proposed_at)} (${ageLabel(selected.proposed_at)})`,
            title: selected.proposed_at
          },
          ...(selected.decided_at ? [{
            label: selected.status === 'expired' ? 'Expired' : `${selected.status} by`,
            // AN EXPIRED PROPOSAL NAMES NOBODY, and that is deliberate rather than missing data:
            // the timer has no session and is not a person.
            value: selected.decided_by
              ? <ActorLabel id={selected.decided_by} currentUserId={currentUserId} />
              : 'the expiry timer, which is not a person',
            title: selected.decided_at
          }, {
            label: 'Decided at',
            value: `${absoluteTime(selected.decided_at)} (${ageLabel(selected.decided_at)})`,
            title: selected.decided_at
          }] : []),
          ...(selected.decision_reason
            ? [{ label: 'Reason', value: selected.decision_reason, full: true }]
            : []),
          ...(selected.rationale
            ? [{ label: 'Why it was asked for', value: selected.rationale, full: true }]
            : []),
          { label: 'Proposal UUID', value: selected.id, mono: true, copyable: true },
          ...(selected.applied_thread_id ? [{
            label: 'Digital Thread row',
            value: String(selected.applied_thread_id),
            mono: true,
            title: 'The audit row this approval wrote, naming both the proposer and the approver.'
          }] : [])
        ] : []}
        beforeActions={selected && (
          <div>
            <div className="context-panel-section-label">What would change</div>
            <DiffTable proposal={selected} names={locationNames} />
          </div>
        )}
        actions={panelActions}
      />

      {rejecting && (
        <RejectDialog
          busy={busyId === rejecting.id}
          onCancel={() => setRejecting(null)}
          onConfirm={reason => decide(rejecting, 'reject', reason)}
        />
      )}
    </div>
  )
}
