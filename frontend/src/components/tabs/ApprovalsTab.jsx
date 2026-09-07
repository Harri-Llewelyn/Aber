import React, { useState, useCallback, useMemo } from 'react'
import { api } from '../../api'
import { POLL_INTERVAL_MS, PERMISSION_UUIDS } from '../../constants'
import { usePolling } from '../../hooks/usePolling'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { ContextPanel, rowSelectHandler } from '../common/ContextPanel'
import { IconPlus, IconPencil, IconCheck, IconX, IconArchive } from '../common/Icons'

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
export const LANES = [
  {
    id: 'devices',
    label: 'Device details',
    blurb: 'Name, description, type, connection and location. Not the gateway it reports through, '
      + 'and not what ingestion observed about it.'
  },
  {
    id: 'device_nameplate',
    label: 'Device nameplate',
    blurb: 'The IDTA Digital Nameplate a person asserts about a machine — manufacturer, serial, '
      + 'versions. Where the device publishes its own answer, the exporter prefers that one.'
  },
  {
    id: 'schemas',
    label: 'Schema publication',
    blurb: 'Publish a draft schema version. Approving archives its predecessor and repoints every '
      + 'attached device in the same transaction — and only an Administrator may approve it.'
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
 * ONE INBOX, TWO GATES: a `Shopfloor_Manager` decides the asset lanes and an `Administrator` alone
 * decides a schema publication, because `0069` withdrew `schema:manage` from that role and `0087`
 * made the RPC enforce it.
 *
 * THIS IS A MIRROR AND IT IS ALLOWED TO BE WRONG. The database is asked again on every call, so the
 * cost of a divergence here is a button that returns a refusal -- not an approval that should not
 * have happened. It is written against the ROLE rather than the permission because that is what the
 * session carries; the permission is what the database resolves.
 */
export function canDecide(entityType, userRole) {
  if (entityType === 'schemas') return userRole === 'Administrator'
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

/** The proposer, named as far as this page honestly can. */
function ActorLabel({ id, currentUserId }) {
  if (!id) return <span className="context-field-empty">—</span>
  if (id === currentUserId) return <strong>you</strong>
  // The same shape the Digital Thread uses. `auth.users` is not readable from the browser, so a
  // display name would have to come from somewhere that does not exist yet.
  return <span className="mono" title={id}>{String(id).slice(0, 8)}</span>
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

/**
 * The composer.
 *
 * ITS FIELD LIST COMES FROM THE DATABASE, through `proposable_columns()`. A hardcoded list here
 * would be a second allowlist, and the failure would be a form offering a field every proposal is
 * then refused for -- or worse, quietly omitting one the database would have accepted.
 */
function Composer({ devices, drafts, editing, onCancel, onSubmit, busy, refusal, onOpenExisting }) {
  const [lane, setLane] = useState(editing?.entity_type || 'devices')
  const [target, setTarget] = useState(editing?.entity_id || '')
  const [values, setValues] = useState(() => {
    if (!editing) return {}
    const seed = {}
    for (const [k, v] of Object.entries(editing.patch || {})) seed[k] = v === null ? '' : String(v)
    return seed
  })
  const [rationale, setRationale] = useState(editing?.rationale || '')
  const [allowed, setAllowed] = useState([])

  React.useEffect(() => {
    let cancelled = false
    api.get(`/api/v1/proposals/allowed-keys/${encodeURIComponent(lane)}`)
      .then(keys => { if (!cancelled) setAllowed(keys) })
      .catch(() => { if (!cancelled) setAllowed([]) })
    return () => { cancelled = true }
  }, [lane])

  const laneDef = LANE_BY_ID.get(lane)
  const nothingToPropose = lane !== 'schemas' && Object.keys(values).length === 0

  /**
   * WHY THE BUTTON IS DISABLED, IN WORDS.
   *
   * A control that is greyed out with no explanation is one a person tries twice and then reports
   * as broken -- which is exactly what happened here: pressing Propose with no device chosen did
   * nothing at all, correctly, and said nothing about why. The button stays disabled because the
   * proposal would be refused; this is the part that was missing.
   */
  const missing = []
  if (!target) missing.push(lane === 'schemas' ? 'a draft to publish' : 'a device')
  if (nothingToPropose) missing.push('at least one field to change')

  const submit = () => {
    // The schema lane's patch is the ACT and takes no arguments, so the form does not collect one.
    const patch = lane === 'schemas'
      ? { publish: true }
      : Object.fromEntries(
          Object.entries(values)
            .filter(([, v]) => v !== undefined)
            // An empty box means "clear this field", which is a real proposal -- so it is sent as
            // null rather than dropped. Dropping it would silently turn "clear the serial number"
            // into a proposal that changes nothing.
            .map(([k, v]) => [k, v === '' ? null : v])
        )
    onSubmit({ entity_type: lane, entity_id: target, patch, rationale })
  }

  return (
    <div className="card-body">
      {refusal && (
        <div className="empty-state" role="alert">
          <div className="empty-text">{refusal.message}</div>
          {refusal.openExisting && (
            <button type="button" className="btn btn-sm" onClick={onOpenExisting}>
              Open the proposal you already have
            </button>
          )}
        </div>
      )}

      {/* THE LANE AND TARGET ARE FIXED WHILE EDITING. The transition guard refuses a change to
          either, so offering them would be a control the database declines. */}
      <div className="form-group">
        <label className="form-label" htmlFor="lane">What kind of change</label>
        <select id="lane" className="form-control" value={lane} disabled={Boolean(editing)}
                onChange={e => { setLane(e.target.value); setTarget(''); setValues({}) }}>
          {LANES.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
        </select>
        {laneDef && <p className="approvals-hint">{laneDef.blurb}</p>}
      </div>

      <div className="form-group">
        <label className="form-label" htmlFor="target">
          {lane === 'schemas' ? 'Draft to publish' : 'Device'}
        </label>
        <select id="target" className="form-control" value={target} disabled={Boolean(editing)}
                onChange={e => setTarget(e.target.value)}>
          <option value="">Choose…</option>
          {lane === 'schemas'
            ? drafts.map(d => (
                <option key={d.id} value={d.id}>{d.schema_name} v{d.version}</option>
              ))
            : devices.map(d => (
                <option key={d.device_id || d.id} value={d.device_id || d.id}>{d.name}</option>
              ))}
        </select>
        {lane === 'schemas' && drafts.length === 0 && (
          <p className="approvals-hint">
            There are no draft schemas. A draft is created by forking an active schema on the
            Schemas page, which an Administrator does.
          </p>
        )}
      </div>

      {lane !== 'schemas' && allowed.map(key => (
        <div className="form-group" key={key}>
          <label className="form-label" htmlFor={`field-${key}`}>{keyLabel(key)}</label>
          <input
            id={`field-${key}`}
            className="form-control"
            value={values[key] ?? ''}
            placeholder="Leave blank to propose no change to this field"
            onChange={e => {
              const next = { ...values }
              // A box the user never touched is NOT part of the patch. Only a box they typed in
              // -- including one they cleared -- becomes a proposed value, which is what keeps
              // this a patch rather than a whole-row snapshot.
              if (e.target.value === '' && !(key in next)) delete next[key]
              else next[key] = e.target.value
              setValues(next)
            }}
          />
        </div>
      ))}

      <div className="form-group">
        <label className="form-label" htmlFor="rationale">Why (optional)</label>
        <textarea id="rationale" className="form-control" rows={2} value={rationale}
                  onChange={e => setRationale(e.target.value)} />
      </div>

      <div className="approvals-composer-actions">
        {missing.length > 0 && (
          <span className="approvals-hint" role="status">
            Choose {missing.join(' and ')} before proposing.
          </span>
        )}
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-primary"
                disabled={busy || missing.length > 0}
                title={missing.length ? `Choose ${missing.join(' and ')} first` : undefined}
                onClick={submit}>
          {editing ? 'Save changes' : 'Propose'}
        </button>
      </div>
    </div>
  )
}

/**
 * One list of proposals, as a table.
 *
 * A TABLE RATHER THAN A STACK OF CARDS, and the drawer rather than per-row buttons, because that is
 * the shape every other list page settled on: a card per row put the detail of three proposals in
 * a viewport and made the queue unscannable at the size a queue actually reaches. The row carries
 * what you triage on -- what, which asset, who, how long -- and the drawer carries the diff and
 * every action.
 */
function ProposalTable({ rows, selectedId, onSelect, currentUserId, emptyText }) {
  if (rows.length === 0) {
    return <div className="empty-state"><div className="empty-text">{emptyText}</div></div>
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th title="The asset or schema this proposal is about">Subject</th>
            <th title="Which lane, and therefore who may decide it">Change</th>
            <th title="What the proposal would change">Summary</th>
            <th title="Who filed it">Proposed by</th>
            <th title="Its state, and when it was last moved">Status</th>
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
                <td><ActorLabel id={p.proposed_by} currentUserId={currentUserId} /></td>
                <td>
                  <StatusBadge status={p.status} />{' '}
                  <span className="text-muted">{ageLabel(p.decided_at || p.proposed_at)}</span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export function ApprovalsTab({ showToast, hasPermission, userRole, currentUserId }) {
  const [proposals, setProposals] = useState([])
  const [devices, setDevices]     = useState([])
  const [drafts, setDrafts]       = useState([])
  const [loading, setLoading]     = useState(true)
  const [composing, setComposing] = useState(false)
  const [editing, setEditing]     = useState(null)
  const [rejecting, setRejecting] = useState(null)
  const [busyId, setBusyId]       = useState(null)
  const [refusal, setRefusal]     = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [decidedLane, setDecidedLane] = useState('all')
  const [decidedQuery, setDecidedQuery] = useState('')

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

  const decidedFiltered = useMemo(() => {
    const needle = decidedQuery.trim().toLowerCase()
    return decided.filter(p => {
      if (decidedLane !== 'all' && p.entity_type !== decidedLane) return false
      if (!needle) return true
      // The subject, the reason and the rationale: the three things somebody remembers about a
      // decision they are trying to find again.
      return [p.target_label, p.decision_reason, p.rationale]
        .some(v => String(v || '').toLowerCase().includes(needle))
    })
  }, [decided, decidedLane, decidedQuery])

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

  const submitProposal = async (payload) => {
    setBusyId('composer')
    setRefusal(null)
    try {
      if (editing) await api.put(`/api/v1/proposals/${editing.id}`, payload)
      else await api.post('/api/v1/proposals', payload)
      showToast?.(editing ? 'Proposal updated.' : 'Proposed. An approver decides from here.', 'success')
      setComposing(false)
      setEditing(null)
      await refresh()
    } catch (e) {
      // The row the per-asset cap is complaining about, so the refusal can offer to open it.
      const existing = proposals.find(p =>
        p.status === 'open'
        && p.entity_type === payload.entity_type
        && p.entity_id === payload.entity_id
        && p.proposed_by === currentUserId)
      setRefusal({ ...refusalFor(e, existing), existing })
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
    ...(mine && selected.status === 'open' ? [
      {
        label: 'Edit', icon: <IconPencil size={13} />,
        title: 'Add to this proposal rather than opening a second one',
        onClick: () => { setEditing(selected); setComposing(false) }
      },
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

        {/* ONE CARD PER SUBJECT, each with a title and a description, which is how every other page
            in this app is composed. The primary action sits in the header beside the title, where
            "create a thing" belongs -- not loose above the page. */}
        <div className="card">
          <div className="card-header">
            {/* THE HEADING SAYS WHICH IT IS. Editing an existing proposal and starting a new one
                are the same form with the lane and target locked, and a card that said "Propose a
                change" in both states left the one difference that matters -- that this will add
                to a proposal somebody may already be reading -- to be inferred from a button
                label at the far end of the form. */}
            <h3 className="section-title">{editing ? 'Edit your proposal' : 'Propose a change'}</h3>
            {canPropose && !composing && !editing && (
              <button
                className="btn btn-primary btn-sm"
                style={{ marginLeft: 'auto' }}
                onClick={() => { setComposing(true); setRefusal(null) }}
                title="Ask for a change to a device, a nameplate or a schema"
              >
                <IconPlus size={14} /> Propose a change
              </button>
            )}
          </div>
          {(composing || editing) ? (
            <Composer
              devices={devices}
              drafts={drafts}
              editing={editing}
              busy={busyId === 'composer'}
              refusal={refusal}
              onOpenExisting={() => {
                // THE CAP IS ONLY LIVABLE IF THIS IS ONE CLICK. Told "you already have an open
                // proposal on this device", a person has to be able to open that one and add to
                // it -- otherwise the constraint reads as a wall and they propose against a
                // neighbouring asset instead, or stop proposing.
                setEditing(refusal.existing)
                setComposing(false)
                setRefusal(null)
              }}
              onCancel={() => { setComposing(false); setEditing(null); setRefusal(null) }}
              onSubmit={submitProposal}
            />
          ) : (
            <div className="card-body">
              <p className="approvals-blurb">
                A proposal is a request, not a change: nothing is written until somebody who may
                make it approves. {canPropose
                  ? 'Fill in only the fields you want changed — anything left alone stays as it is.'
                  : 'Your role can decide proposals but not file them.'}
              </p>
            </div>
          )}
        </div>

        <div className="card">
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
          </div>
          <ProposalTable
            rows={open}
            selectedId={selectedId}
            onSelect={setSelectedId}
            currentUserId={currentUserId}
            emptyText="Nothing is waiting. A proposal appears here when somebody asks for a change they cannot make themselves."
          />
        </div>

        <div className="card">
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
            <div className="filter-bar">
              <select
                className="form-control"
                style={{ width: '190px' }}
                value={decidedLane}
                onChange={e => setDecidedLane(e.target.value)}
                title="Filter by the kind of change"
              >
                <option value="all">All kinds ({decided.length})</option>
                {LANES.map(l => (
                  <option key={l.id} value={l.id}>
                    {l.label} ({decided.filter(p => p.entity_type === l.id).length})
                  </option>
                ))}
              </select>
              <input
                className="form-control"
                style={{ width: '260px' }}
                value={decidedQuery}
                onChange={e => setDecidedQuery(e.target.value)}
                placeholder="Search subject, reason or rationale…"
                title="Filter decided proposals by what they were about or why they were decided"
              />
              {(decidedLane !== 'all' || decidedQuery) && (
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => { setDecidedLane('all'); setDecidedQuery('') }}
                >
                  Clear filters
                </button>
              )}
            </div>
          </div>
          <ProposalTable
            rows={decidedFiltered}
            selectedId={selectedId}
            onSelect={setSelectedId}
            currentUserId={currentUserId}
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
          { label: 'Proposed by', value: <ActorLabel id={selected.proposed_by} currentUserId={currentUserId} /> },
          { label: 'Proposed', value: ageLabel(selected.proposed_at), title: selected.proposed_at },
          ...(selected.decided_at ? [{
            label: selected.status === 'expired' ? 'Expired' : `${selected.status} by`,
            // AN EXPIRED PROPOSAL NAMES NOBODY, and that is deliberate rather than missing data:
            // the timer has no session and is not a person.
            value: selected.decided_by
              ? <ActorLabel id={selected.decided_by} currentUserId={currentUserId} />
              : 'the expiry timer, which is not a person',
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
