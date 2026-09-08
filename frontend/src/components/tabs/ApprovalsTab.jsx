import React, { useState, useCallback, useMemo } from 'react'
import { api } from '../../api'
import { POLL_INTERVAL_MS, PERMISSION_UUIDS } from '../../constants'
import { usePolling } from '../../hooks/usePolling'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { ContextPanel, rowSelectHandler } from '../common/ContextPanel'
import { IconPlus, IconPencil, IconCheck, IconX, IconArchive, IconHistory } from '../common/Icons'

/**
 * ==================================================================================================
 * THE APPROVALS PAGE -- one inbox for every change somebody proposed but may not apply.
 * ==================================================================================================
 *
 * `0086` built the queue and the asset lanes; `0088` added the schema lane. This is the surface
 * that makes any of it reachable: until now an `Operator` had a write policy and no way to use it.
 *
 * WHAT THIS PAGE IS NOT. It is not an authority. Every control here is drawn from what the database
 * would allow, and every one of them can be wrong without being dangerous -- the RPC re-checks the
 * caller's role for itself, and the RLS policy refuses an INSERT this page would happily send. A
 * hidden button is a courtesy, exactly as `tabIsVisible` says of the navigation. The page is
 * written so that being wrong shows up as a refusal the user can read, rather than as a control
 * that quietly does nothing.
 */

/**
 * The three lanes, and what each is called where a person can see it.
 *
 * `entity_type` holds the TABLE NAME, because that is the vocabulary `digital_thread` and
 * `audit_domain_for()` already speak. Nobody should have to read that in a heading, so the label
 * lives here -- presentation only, and the id is what every call carries.
 */
/**
 * The lanes the queue admits, mirroring 0090's CHECK constraint and `proposable_columns()`.
 *
 * NO SCHEMA LANE. 0088 built one and 0090 withdrew it: a draft is created by `fork_schema()`,
 * which needs `schema:manage` -- so the only person who could create the draft was the only person
 * who could publish it, and an Operator "proposing" a publication was endorsing somebody else's
 * work rather than asking for a change they could not make. Historical rows in that lane still
 * render, through the `entity_type` fallback below.
 *
 * THE LABELS ARE READ BY THE FILTERS AND THE TABLE, not by a form: the form for each of these is
 * the asset's own Edit Details dialog. See the block comment above ProposalTable.
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
  {
    id: 'device_links',
    label: 'Device document',
    blurb: 'A document to attach to a machine — a risk assessment, a schematic, an asset register.'
  },
  {
    id: 'cell_links',
    label: 'Cell document',
    blurb: 'A document to attach to a cell.'
  },
  {
    id: 'gateway_links',
    label: 'Gateway document',
    blurb: 'A document to attach to a gateway.'
  }
]

export const LANE_BY_ID = new Map(LANES.map(l => [l.id, l]))

/**
 * A readable label for a proposable key.
 *
 * PRESENTATION ONLY, AND IT FALLS BACK RATHER THAN FILTERS. The authoritative list comes from
 * `proposable_columns()` at runtime, so a key added to the database and not to this map still
 * renders -- as its raw column name, which is ugly and correct. A map that decided what to SHOW
 * would be a second allowlist, and the day the two disagree the form silently omits a field the
 * database would have accepted.
 */
const KEY_LABELS = {
  name: 'Name',
  description: 'Description',
  asset_type: 'Asset type',
  connection_method: 'Connection method',
  cell_id: 'Cell',
  location_scope: 'Location scope',
  model_3d_path: '3D model path',
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
 * Whether this session may decide this lane, mirroring `may_decide_proposal()`.
 *
 * 0090 gates the five lanes it added on `cell:manage`, `gateway:manage` and `link:manage` rather
 * than on role names -- so a lane closes when a grant is withdrawn rather than outliving it. All
 * three are held by exactly these two roles today, which is why one line answers for every live
 * lane; the day that stops being true, the database is still the one that decides.
 *
 * THE WITHDRAWN SCHEMA LANE IS FALSE FOR EVERYBODY, matching 0090: nothing new can be filed in it
 * and nothing left in it can be decided.
 *
 * THIS IS A MIRROR AND IT IS ALLOWED TO BE WRONG. The database is asked again on every call, so the
 * cost of a divergence here is a button that returns a refusal -- not an approval that should not
 * have happened. It is written against the ROLE rather than the permission because that is what the
 * session carries; the permission is what the database resolves.
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
 * What a proposal would change, as before/after pairs.
 *
 * THE SCHEMA LANE HAS NO BEFORE. Its patch names an ACT rather than a column -- `{publish: true}`
 * -- so a two-column diff would invent a "current value" for something that is not a value. It gets
 * a sentence instead, which is what the act actually is.
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
 * The message for a refused INSERT, and the repair each one needs.
 *
 * THE TWO CAPS FAIL DIFFERENTLY AND NEED DIFFERENT REPAIRS. `23505` is the per-asset cap -- one
 * open proposal per asset per person -- and the repair is to OPEN THE ONE YOU HAVE, which is why
 * the caller is handed the row rather than only a sentence. `23514` is the per-person ceiling and
 * the repair is to decide or withdraw something else. A single "could not create proposal" would
 * send both people to an administrator.
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
 * The proposer, named as far as this page honestly can.
 *
 * THE EMAIL FIRST, AND IT IS NOT SELF-DECLARED. `0089` stamps `proposed_by_email` from the signed
 * access token on INSERT, discarding anything the client sent -- so it is evidence rather than a
 * name somebody typed. The uuid stays the fallback, because a token carrying no email is a real
 * state and a blank cell would read as a missing proposer.
 */
function ActorLabel({ id, email, currentUserId }) {
  if (!id) return <span className="context-field-empty">—</span>
  if (id === currentUserId) return <strong>you</strong>
  if (email) return <span title={id}>{email}</span>
  return <span className="mono" title={id}>{String(id).slice(0, 8)}</span>
}

/**
 * An absolute timestamp, in the viewer's own locale and zone.
 *
 * BESIDE THE RELATIVE ONE RATHER THAN INSTEAD OF IT. "31m ago" is what triage reads and is useless
 * in a ticket or a conversation with a night shift; a wall-clock time is the opposite. The column
 * carries the exact time and the drawer carries both, so neither reader has to do arithmetic.
 */
export function absoluteTime(iso) {
  if (!iso) return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  return at.toLocaleString()
}

/** The before/after table, shared by the drawer and by nothing else -- see `diffRows`. */
function DiffTable({ proposal }) {
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
            <td className="text-muted">{displayValue(r.from)}</td>
            <td>
              <strong>{displayValue(r.to)}</strong>
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
          {/* THE REASON IS REQUIRED BY A CHECK CONSTRAINT, not only by this form. A rejected
              proposal frees its slot at once and the same change may be proposed again
              immediately -- so the reason, not a cooldown, is what makes the second attempt
              different from the first. It is also the only thing the proposer gets other than a
              refusal. */}
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

/*
 * ==================================================================================================
 * THERE IS NO COMPOSER HERE ANY MORE, AND ITS ABSENCE IS THE DESIGN.
 * ==================================================================================================
 *
 * This page used to carry a form of its own: a lane picker, a subject picker, and one text input
 * per key returned by `proposable_columns()`. It worked, and it was a drift generator. It listed
 * the same columns as the Edit Details dialog for the same asset, as BARE TEXT INPUTS -- so
 * proposing a relocation meant typing a uuid that the real dialog offers in a dropdown, and the day
 * somebody added a field, a hint or a validation rule to Edit Details, the two dialogs started
 * quietly disagreeing about what a device is.
 *
 * There is one form per asset now, and it is the one that was always there. For somebody who may
 * not save it, its footer button files a proposal instead of writing -- see
 * `frontend/src/utils/proposeFromForm.js`, and `proposeMode` in DevicesTab, CellsTab and
 * GatewaysTab.
 *
 * SO THIS PAGE IS A QUEUE AND NOTHING ELSE: what is waiting, what was decided, and the drawer that
 * decides one. Editing your own open proposal is a hand-over back to the asset's page, because
 * that is where the form lives -- the drawer's Edit action opens the asset there, and its
 * "Propose a Change" dialog seeds itself from the proposal you already have.
 */


/**
 * One list of proposals, as a table.
 *
 * A TABLE RATHER THAN A STACK OF CARDS, and the drawer rather than per-row buttons, because that is
 * the shape every other list page settled on: a card per row put the detail of three proposals in
 * a viewport and made the queue unscannable at the size a queue actually reaches. The row carries
 * what you triage on -- what, which asset, who, how long -- and the drawer carries the diff and
 * every action.
 */
function ProposalTable({ rows, selectedId, onSelect, emptyText }) {
  if (rows.length === 0) {
    return <div className="empty-state"><div className="empty-text">{emptyText}</div></div>
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          {/* NO "PROPOSED BY" COLUMN. It held a truncated uuid, which nothing in this stack can
              resolve into a person -- so it cost a column and answered nothing. The drawer names
              the proposer properly, by the email 0089 stamps from the token, and "you" on your own
              rows is the part that was ever readable at a glance.

              STATUS AND TIME ARE TWO COLUMNS, because they were one doing two jobs: a state that
              takes a badge and a moment that takes a clock, sharing a heading that described only
              the first. */}
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
 * The filter both queues share.
 *
 * `entity_id` IS SEARCHABLE and that is not padding: it is how a route from somewhere else in the
 * app arrives pointed at one subject. The device drawer sends the machine's uuid, which matches
 * nothing a person would type but matches exactly the rows that drawer was talking about.
 */
export function filterProposals(rows, lane, query) {
  const needle = String(query || '').trim().toLowerCase()
  return rows.filter(p => {
    if (lane !== 'all' && p.entity_type !== lane) return false
    if (!needle) return true
    // The subject, the reason, the rationale, who asked, and the id underneath: the things
    // somebody remembers about a request they are trying to find again. The proposer joined the
    // list the moment there was a readable name to search for -- a uuid nobody can resolve is not
    // one, which is why `proposed_by_email` is here and `proposed_by` is not.
    return [p.target_label, p.decision_reason, p.rationale, p.proposed_by_email, p.entity_id]
      .some(v => String(v || '').toLowerCase().includes(needle))
  })
}

/** The kind-and-text filter bar, identical over both queues because the queues are one shape. */
function ProposalFilters({ rows, lane, onLane, query, onQuery, placeholder, label }) {
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
      {(lane !== 'all' || query) && (
        <button type="button" className="btn btn-sm btn-ghost"
                onClick={() => { onLane('all'); onQuery('') }}>
          Clear filters
        </button>
      )}
    </div>
  )
}

export function ApprovalsTab({
  showToast, hasPermission, userRole, currentUserId, onViewThread,
  // ARRIVES FROM ANOTHER PAGE, and is one-shot: `initialSubject` points the working queue at one
  // asset, so a drawer's "N changes awaiting decision" lands on that asset's requests rather than
  // on every open request on the site. Cleared through `onClearFocus`, so returning to this tab
  // later does not silently reapply a filter the person has moved on from.
  //
  // THERE IS NO `initialCompose` ANY MORE. It used to open the composer on a device handed over
  // from its drawer; the composer is gone and the asset's own dialog does that job in place.
  initialSubject = '', onClearFocus,
  // Hand back to the asset's page, which is where the form that edits a proposal now lives.
  onOpenSubject
}) {
  const [proposals, setProposals] = useState([])
  const [devices, setDevices]     = useState([])

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
      const [rows, deviceRows, draftRows] = await Promise.all([
        api.get('/api/v1/proposals', { signal }),
        api.get('/api/v1/assets', { signal }).catch(() => []),
        api.get('/api/v1/proposals/publishable-schemas', { signal }).catch(() => [])
      ])
      setProposals(rows)
      setDevices((deviceRows || []).filter(d => !d.is_archived))
      setDrafts(draftRows || [])
      setLoading(false)
    } catch (e) {
      if (e.name !== 'AbortError') setLoading(false)
      throw e
    }
  }, [])

  usePolling(loadAll, POLL_INTERVAL_MS)

  /*
   * AN EFFECT, NOT AN INITIAL STATE, and that distinction is the bug it exists to avoid: every tab
   * in this app stays mounted across navigation, so `useState(initialSubject)` runs exactly once --
   * on the first visit to this page, which for most people is not the visit that arrived from a
   * device. The second and every later hand-over would have set the prop and changed nothing.
   */
  React.useEffect(() => {
    if (!initialSubject) return
    setOpenQuery(initialSubject)
    // Nothing is hidden by accident: a subject filter that narrowed only the open queue would
    // leave a decided proposal about the same device sitting unfiltered below it, which reads as
    // the filter having missed something.
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

  // THE WORKING QUEUE FILTERS TOO, and not only for symmetry: the device drawer routes here with
  // the machine's id as the query, so an approver arrives looking at that device's requests rather
  // than at every open request on the site.
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
      // THE MESSAGE IS THE DATABASE'S. An approval can fail because the change itself is invalid --
      // a patch that violates a CHECK aborts the approval -- and that sentence is the one the
      // approver needs. Replacing it with "could not approve" would hide the only useful part.
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
    // ONLY WHEN THERE IS A ROW TO OPEN. `applied_thread_id` is set by the approval and by nothing
    // else, so a rejected, withdrawn or still-open proposal offers nothing here -- none of them
    // changed anything, and this record is of what happened to the plant rather than what was
    // asked for. Offering a dead button on those three would teach the reader the control lies.
    ...(selected.applied_thread_id && onViewThread ? [{
      label: 'View in Digital Thread', icon: <IconHistory size={13} />,
      title: 'The audit row this approval wrote, naming both the proposer and the approver',
      onClick: () => onViewThread(selected)
    }] : []),
    ...(mine && selected.status === 'open' ? [
      /* EDIT IS A HAND-OVER, NOT A DIALOG. The form that writes a proposal is the asset's own
         Edit Details dialog -- one form per asset, which is the whole point of removing the
         composer -- so this opens the asset on its page, where "Propose a Change" seeds itself
         from the open proposal it finds. One extra click, and no second form to keep in step.

         The per-asset cap is what makes this matter: 0086 allows one open proposal per asset per
         person, so adding a second field means EXTENDING this request rather than filing another,
         and the seeded dialog is the only place that can be done. */
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

        {/* NO "PROPOSE A CHANGE" CARD. The act starts on the asset's own page now -- see the
            block comment above -- so a button here would be a second entrance to a form this page
            no longer owns. What is left is the queue itself, which is what an approver opens this
            page for. */}
        <div className="card approvals-card">
          <div className="card-header">
            <h3 className="section-title">Approvals</h3>
          </div>
          <div className="card-body">
            <p className="approvals-blurb">
              A proposal is a request, not a change: nothing is written until somebody who may make
              it approves. {canPropose
                ? 'To ask for one, open the asset on its own page and use Propose a Change — the same dialog that edits it.'
                : 'Your role can decide proposals but not file them.'}
            </p>
          </div>
        </div>

        <div className="card approvals-card">
          <div className="card-header">
            <h3 className="section-title">
              Awaiting a decision <span className="section-count">{open.length}</span>
            </h3>
          </div>
          <div className="card-body">
            <p className="approvals-blurb">
              The working queue, oldest first, because a queue is worked from the front. Select a
              row to see exactly what would change and to decide it. Approving applies the change
              immediately, in one transaction — so a proposal that would break a rule fails here
              rather than being accepted and going wrong later.
            </p>
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
              Decided <span className="section-count">{decidedFiltered.length}</span>
            </h3>
          </div>
          <div className="card-body">
            <p className="approvals-blurb">
              What was applied, rejected, withdrawn or left to expire. Kept for as long as the
              retention setting an Administrator owns; what an approval actually CHANGED lives in
              the Digital Thread under its own policy, so pruning here destroys no record of what
              happened.
            </p>
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
            <DiffTable proposal={selected} />
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
