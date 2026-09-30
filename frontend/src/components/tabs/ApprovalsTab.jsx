import React, { useState, useCallback, useMemo } from 'react'
import { api } from '../../api'
import { POLL_INTERVAL_MS, ENTITY_KIND_BY_TABLE } from '../../constants'
import { usePolling } from '../../hooks/usePolling'
import { ContextPanel, rowSelectHandler } from '../common/ContextPanel'
import { IconPencil, IconCheck, IconX, IconArchive, IconHistory, IconInbox } from '../common/Icons'
import { HelpTip } from '../common/HelpTip'
import { PageHeading } from '../common/PageHeading'
import { Badge } from '../common/Badge'
import { SectionCount } from '../common/SectionCount'
import { SearchInput } from '../common/SearchInput'
import { ClearFilters } from '../common/ClearFilters'
import { LoadingState } from '../common/LoadingState'
import { EmptyState } from '../common/EmptyState'
import { Modal } from '../common/Modal'
import { formatDateTime, formatRelative } from '../../utils/format'

/**
 * The Approvals page: one inbox for every change somebody proposed but may not apply.
 *
 * It is not an authority: every control mirrors what the database would allow, the RPC re-checks
 * the caller's role, and RLS refuses an INSERT this page would send. Being wrong shows up as a
 * readable refusal.
 */

/**
 * The kinds of change the queue admits, mirroring the CHECK constraint and `proposable_columns()`.
 * `entity_type` holds the table name, the vocabulary `audit_trail` speaks; the label is
 * presentation only. There is no schema kind: creating a draft needs `schema:manage`, so whoever
 * could propose a publication could also perform it. A decided row left in a withdrawn kind still
 * renders through the `entity_type` fallback. The form for each kind is the entity's own Edit
 * Details dialog.
 */
export const LANES = [
  { id: 'devices', label: 'Device details' },
  { id: 'device_nameplate', label: 'Device nameplate' },
  { id: 'areas', label: 'Area details' },
  { id: 'cells', label: 'Cell details' },
  { id: 'gateways', label: 'Gateway details' },
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
 * Whether this session may decide this kind of change, mirroring `may_decide_proposal()`. Every
 * live kind resolves to these two roles for a person; a decided-only schema row is false for
 * everybody. A mirror that is allowed to be wrong: the database decides again on every call.
 */
export function canDecide(entityType, userRole) {
  if (entityType === 'schemas') return false
  return userRole === 'Administrator' || userRole === 'Shopfloor_Manager'
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
 * kind and key labels follow -- an archived or deleted cell is a real state, and a reviewer
 * seeing a raw uuid is better served than one seeing a blank.
 */
function ValueCell({ value, names }) {
  const named = typeof value === 'string' ? names?.get(value) : undefined
  if (named) return <span title={value}>{named}</span>
  return <>{displayValue(value)}</>
}

/**
 * What a proposal would change, as before / after pairs. A schema row's patch names an act
 * (`{publish: true}`), not a column, so it gets no diff.
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

const STATUS_TONE = {
  open: 'pending',
  applied: 'success',
  rejected: 'danger',
  withdrawn: 'neutral',
  expired: 'warning'
}

/** A proposal's status through the shared Badge. An unknown status renders neutral. */
function ProposalStatus({ status }) {
  return <Badge tone={STATUS_TONE[status] || 'neutral'} size="sm" dot>{status}</Badge>
}

/**
 * The proposer. `proposed_by_email` is stamped from the signed access token on INSERT, so it is
 * evidence rather than a typed name. A machine identity has no email; `machineName` is the name an
 * Administrator gave it, from `list_proposer_names()`. The uuid is the fallback for a principal
 * with neither.
 */
export function ActorLabel({ id, email, machineName, currentUserId }) {
  if (!id) return <span className="context-field-empty">—</span>
  if (id === currentUserId) return <strong>you</strong>
  if (email) return <span title={id}>{email}</span>
  if (machineName) {
    return (
      <span title={`A machine identity, ${id}`}>
        {machineName} <span className="badge badge-neutral">machine</span>
      </span>
    )
  }
  return <span className="mono" title={id}>{String(id).slice(0, 8)}</span>
}

/** The before/after table, drawn in the drawer. */
function DiffTable({ proposal, names }) {
  const rows = diffRows(proposal)
  if (proposal.entity_type === 'schemas') {
    return (
      <p className="form-hint">
        A request to publish a schema draft. That kind of proposal is withdrawn: it can no longer be
        approved here, and the draft is published on the Schemas page.
      </p>
    )
  }
  if (rows.length === 0) return <p className="form-hint">This proposal changes nothing.</p>
  return (
    <table className="modal-table">
      <thead>
        <tr><th>Field</th><th>Now</th><th>Proposed</th></tr>
      </thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.key}>
            <td>{keyLabel(r.key)}</td>
            <td className="cell-meta"><ValueCell value={r.from} names={names} /></td>
            <td>
              <strong><ValueCell value={r.to} names={names} /></strong>
              {r.unchanged && <Badge size="sm" className="badge-follow">unchanged</Badge>}
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
  return (
    <Modal
      title="Reject this proposal"
      icon={<IconX size={18} />}
      size="sm"
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={blank || busy}
            onClick={() => onConfirm(reason.trim())}
          >
            Reject
          </button>
        </>
      }
    >
      {/* A CHECK constraint requires the reason: a rejected proposal frees its slot at once, so
          the reason is what makes a second attempt different from the first. */}
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
    </Modal>
  )
}

/* There is no composer on this page. The form that writes a proposal is the entity's own Edit
   Details dialog, whose footer files a proposal for somebody who may not save it
   (utils/proposeFromForm.js). This page is a queue: what is waiting, what was decided, and the
   drawer that decides one. Editing your own open proposal hands over to the entity's page. */

/**
 * One list of proposals, as a table. The row carries what you triage on; the drawer carries the
 * diff and every action. `loading` shows the first load in place of the rows.
 */
function ProposalTable({ rows, selectedId, onSelect, loading, filtered, emptyMessage, filteredMessage }) {
  if (loading) return <LoadingState label="proposals" />
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<IconInbox size={36} />}
        filtered={filtered}
        message={emptyMessage}
        filteredMessage={filteredMessage}
      />
    )
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          {/* The drawer names the proposer. Status and time are two columns because they are two
              facts. */}
          <tr>
            <th title="The device, area, cell or gateway this proposal is about">Subject</th>
            <th title="Which kind of change this is">Change</th>
            <th title="The fields this proposal would change">Field(s) changed</th>
            <th title="Its current state">Status</th>
            <th title="When it was decided, or when it was filed while it is still open">When</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(p => {
            const kind = LANE_BY_ID.get(p.entity_type)
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
                className={`row-selectable${selectedId === p.id ? ' row-selected' : ''}`}
                onClick={rowSelectHandler(() => onSelect(p.id))}
                title="Click to inspect this proposal in the details panel"
              >
                <td>
                  <strong>{p.target_label}</strong>
                  {p.target_missing && (
                    <Badge tone="warning" size="sm" className="badge-follow"
                           title="The target of this proposal no longer exists, so approving it will fail rather than recreate anything.">
                      MISSING
                    </Badge>
                  )}
                </td>
                <td><Badge size="sm">{kind?.label || p.entity_type}</Badge></td>
                <td className="cell-meta">{summary}</td>
                <td><ProposalStatus status={p.status} /></td>
                <td className="cell-meta" title={formatDateTime(p.decided_at || p.proposed_at)}>
                  {formatRelative(p.decided_at || p.proposed_at)}
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
export function filterProposals(rows, kind, query) {
  const needle = String(query || '').trim().toLowerCase()
  return rows.filter(p => {
    if (kind !== 'all' && p.entity_type !== kind) return false
    if (!needle) return true
    // The fields somebody remembers about a request: subject, reason, rationale, the proposer's
    // email or machine name, and the id.
    return [p.target_label, p.decision_reason, p.rationale, p.proposed_by_email,
      p.proposed_by_machine_name, p.entity_id]
      .some(v => String(v || '').toLowerCase().includes(needle))
  })
}

/** The kind-and-text filter bar, identical over both queues because the queues are one shape. */
function ProposalFilters({ rows, kind, onKind, query, onQuery, placeholder, label }) {
  const activeFilterCount = (kind !== 'all' ? 1 : 0) + (query ? 1 : 0)
  return (
    <div className="filter-bar">
      <select
        className="form-control control-md"
        value={kind}
        onChange={e => onKind(e.target.value)}
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
      <SearchInput
        width="lg"
        value={query}
        onChange={onQuery}
        placeholder={placeholder}
        ariaLabel={`Filter ${label} by what they are about`}
      />
      <ClearFilters count={activeFilterCount} onClear={() => { onKind('all'); onQuery('') }} />
    </div>
  )
}

export function ApprovalsTab({
  showToast, userRole, currentUserId, onViewTrail,
  // Arrives from another page, one-shot: `initialSubject` points the working queue at one entity.
  // Cleared through `onClearFocus` so returning later does not reapply it.
  initialSubject = '', onClearFocus,
  // Hand back to the entity's page, where the form that edits a proposal lives.
  onOpenSubject
}) {
  const [proposals, setProposals] = useState([])
  // Ids the before/after table resolves to names. Empty is a working state: every value falls back
  // to its uuid, which is what the page did before.
  const [locationNames, setLocationNames] = useState(() => new Map())

  const [loading, setLoading] = useState(true)

  const [rejecting, setRejecting] = useState(null)
  const [busyId, setBusyId]       = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [decidedKind, setDecidedKind] = useState('all')
  const [decidedQuery, setDecidedQuery] = useState('')
  const [openKind, setOpenKind] = useState('all')
  // Set by the route effect below when the hand-over arrives, and freely editable afterwards --
  // a filter somebody cannot clear is a trap, not a shortcut.
  const [openQuery, setOpenQuery] = useState('')

  const loadAll = useCallback(async (signal) => {
    try {
      const [rows, cellRows, areaRows] = await Promise.all([
        api.get('/api/v1/proposals', { signal }),
        // Names only, and tolerated failures: a reviewer who cannot read the cell list still gets
        // the queue, with ids where names would have been.
        api.get('/api/v1/cells', { signal }).catch(() => []),
        api.get('/api/v1/areas', { signal }).catch(() => [])
      ])
      setProposals(rows)
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

  // Oldest first in the queue, which is worked from the front; newest decision first in the
  // record, which is read from the most recent.
  const open = useMemo(
    () => proposals.filter(p => p.status === 'open')
      .sort((a, b) => new Date(a.proposed_at) - new Date(b.proposed_at)),
    [proposals]
  )

  const decided = useMemo(
    () => proposals.filter(p => p.status !== 'open')
      .sort((a, b) => new Date(b.decided_at || b.proposed_at) - new Date(a.decided_at || a.proposed_at)),
    [proposals]
  )

  const decidedFiltered = useMemo(
    () => filterProposals(decided, decidedKind, decidedQuery), [decided, decidedKind, decidedQuery])

  // The working queue filters too: the device drawer routes here with the device's id as the query.
  const openFiltered = useMemo(
    () => filterProposals(open, openKind, openQuery), [open, openKind, openQuery])

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
    // Only when there is a row to open: `applied_trail_id` is set by an approval and by nothing
    // else.
    ...(selected.applied_trail_id && onViewTrail ? [{
      label: 'View in Audit Trail', icon: <IconHistory size={13} />,
      title: 'The audit row this approval wrote, naming both the proposer and the approver',
      // Filtered to the subject's own kind: `audit_trail_page()` compares `entity_type` exactly,
      // and the approval row is filed under that kind's table. A deleted subject's rows are hidden
      // by default, so the trail is asked to show them.
      onClick: () => onViewTrail({
        id: selected.entity_id,
        type: ENTITY_KIND_BY_TABLE[selected.entity_type] || '',
        purged: Boolean(selected.target_missing)
      })
    }] : []),
    ...(mine && selected.status === 'open' ? [
      /* Edit is a hand-over, not a dialog: the entity's page opens with Propose a Change seeded
         from this proposal. One open proposal per entity per person, so a second field extends
         the request. */
      ...(onOpenSubject ? [{
        label: 'Add to this proposal', icon: <IconPencil size={13} />,
        title: 'Open this entity, where the same dialog that edits it will extend your request',
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

  return (
    <div className="page-layout">
      <div className="page-main">

        {/* No Propose a Change card: the act starts on the entity's own page. */}
        <PageHeading icon={<IconInbox size={15} />} title="Approvals">
          A proposal is a request, not a change: nothing is written until somebody who may make
          it approves. To ask for one, open the entity on its own page and use Propose a Change —
          the same dialog that edits it.
        </PageHeading>

        <div className={`card approvals-card${open.length > 0 ? ' card-attention' : ''}`}>
          <div className="card-header">
            <h3 className="section-title">
              Awaiting a decision
              <HelpTip
                label="About the open queue"
                text="The working queue, oldest first. Select a row to see exactly what would change. Approving applies it in one transaction, so a proposal that breaks a rule fails here rather than later."
              />
              <SectionCount total={open.length} shown={openFiltered.length} />
            </h3>
          </div>
          <div className="card-body">
            <ProposalFilters
              rows={open} kind={openKind} onKind={setOpenKind}
              query={openQuery} onQuery={setOpenQuery}
              label="open proposals"
              placeholder="Search subject, proposer or rationale…"
            />
          </div>
          <ProposalTable
            rows={openFiltered}
            selectedId={selectedId}
            onSelect={setSelectedId}
            loading={loading}
            filtered={openKind !== 'all' || Boolean(openQuery)}
            emptyMessage="Nothing is waiting. A proposal appears here when somebody asks for a change they cannot make themselves."
            filteredMessage="Nothing open matches these filters."
          />
        </div>

        <div className="card approvals-card">
          <div className="card-header">
            <h3 className="section-title">
              Decided
              <HelpTip
                label="About decided proposals"
                text="What was applied, rejected, withdrawn or left to expire, newest decision first, kept for the retention period an Administrator sets. What an approval changed lives in the Audit Trail."
              />
              <SectionCount total={decided.length} shown={decidedFiltered.length} />
            </h3>
          </div>
          <div className="card-body">
            <ProposalFilters
              rows={decided} kind={decidedKind} onKind={setDecidedKind}
              query={decidedQuery} onQuery={setDecidedQuery}
              label="decided proposals"
              placeholder="Search subject, proposer or reason…"
            />
          </div>
          <ProposalTable
            rows={decidedFiltered}
            selectedId={selectedId}
            onSelect={setSelectedId}
            loading={loading}
            filtered={decidedKind !== 'all' || Boolean(decidedQuery)}
            emptyMessage="Nothing has been decided yet."
            filteredMessage="No decided proposal matches these filters."
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
            <Badge size="sm">
              {LANE_BY_ID.get(selected.entity_type)?.label || selected.entity_type}
            </Badge>
            <ProposalStatus status={selected.status} />
          </>
        )}
        fields={selected ? [
          {
            label: 'Proposed by',
            value: <ActorLabel id={selected.proposed_by} email={selected.proposed_by_email}
                               machineName={selected.proposed_by_machine_name}
                               currentUserId={currentUserId} />,
            title: selected.proposed_by_email || !selected.proposed_by_machine_name
              ? 'Taken from the signed access token when the proposal was filed, not from a form.'
              : 'The name an Administrator gave this machine identity on the Access Control page.'
          },
          {
            // Both readings, the relative one in brackets: "31m ago" cannot be quoted in a ticket.
            label: 'Proposed at',
            value: `${formatDateTime(selected.proposed_at)} (${formatRelative(selected.proposed_at)})`,
            title: selected.proposed_at
          },
          ...(selected.decided_at ? [{
            label: selected.status === 'expired' ? 'Expired' : `${selected.status} by`,
            // An expired proposal names nobody: the timer has no session and is not a person.
            value: selected.decided_by
              ? <ActorLabel id={selected.decided_by} currentUserId={currentUserId} />
              : 'the expiry timer, which is not a person',
            title: selected.decided_at
          }, {
            label: 'Decided at',
            value: `${formatDateTime(selected.decided_at)} (${formatRelative(selected.decided_at)})`,
            title: selected.decided_at
          }] : []),
          ...(selected.decision_reason
            ? [{ label: 'Reason', value: selected.decision_reason, full: true }]
            : []),
          ...(selected.rationale
            ? [{ label: 'Why it was asked for', value: selected.rationale, full: true }]
            : []),
          { label: 'Proposal UUID', value: selected.id, mono: true, copyable: true },
          ...(selected.applied_trail_id ? [{
            label: 'Audit Trail row',
            value: String(selected.applied_trail_id),
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
