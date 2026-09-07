import React, { useState, useCallback, useMemo } from 'react'
import { api } from '../../api'
import { POLL_INTERVAL_MS, PERMISSION_UUIDS } from '../../constants'
import { usePolling } from '../../hooks/usePolling'
import { useEscapeKey } from '../../hooks/useEscapeKey'

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
  if (!id) return <span className="text-muted">—</span>
  if (id === currentUserId) return <strong>you</strong>
  // The same shape the Digital Thread uses. `auth.users` is not readable from the browser, so a
  // display name would have to come from somewhere that does not exist yet.
  return <span className="mono" title={id}>{String(id).slice(0, 8)}</span>
}

function RejectDialog({ proposal, onCancel, onConfirm, busy }) {
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
 * One proposal, with the controls this session may actually use.
 */
function ProposalCard({ proposal, currentUserId, userRole, onDecide, onWithdraw, onEdit, busyId }) {
  const lane = LANE_BY_ID.get(proposal.entity_type)
  const mine = proposal.proposed_by === currentUserId
  const open = proposal.status === 'open'
  const decidable = open && canDecide(proposal.entity_type, userRole)
  const rows = diffRows(proposal)
  const busy = busyId === proposal.id

  return (
    <div className="card proposal-card" data-testid="proposal-card">
      <div className="card-header">
        <h3 className="section-title">
          {proposal.target_label}{' '}
          <span className="badge badge-neutral">{lane?.label || proposal.entity_type}</span>{' '}
          <StatusBadge status={proposal.status} />
        </h3>
        <span className="text-muted">{ageLabel(proposal.proposed_at)}</span>
      </div>

      <div className="card-body">
        {proposal.target_missing && (
          <p className="text-muted">
            The target of this proposal no longer exists. Approving it will fail rather than
            recreate anything.
          </p>
        )}

        {proposal.entity_type === 'schemas' ? (
          <p>
            Publish this draft. Approving activates it, archives its predecessor and repoints every
            attached device — in one transaction.
          </p>
        ) : rows.length === 0 ? (
          <p className="text-muted">This proposal changes nothing.</p>
        ) : (
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
        )}

        {proposal.rationale && <p className="proposal-rationale">“{proposal.rationale}”</p>}

        <p className="text-muted">
          Proposed by <ActorLabel id={proposal.proposed_by} currentUserId={currentUserId} />
          {proposal.decided_at && (
            <>
              {' · '}{proposal.status} by{' '}
              {/* An EXPIRED proposal names nobody, and that is deliberate rather than missing
                  data: the timer has no session and is not a person. */}
              {proposal.decided_by
                ? <ActorLabel id={proposal.decided_by} currentUserId={currentUserId} />
                : <span title="Closed by the expiry timer, which is not a person">the expiry timer</span>}
            </>
          )}
        </p>

        {proposal.decision_reason && (
          <p className="proposal-reason"><strong>Reason:</strong> {proposal.decision_reason}</p>
        )}
      </div>

      {(decidable || (mine && open)) && (
        <div className="modal-actions">
          {mine && open && (
            <>
              <button type="button" className="btn btn-ghost" disabled={busy}
                      onClick={() => onEdit(proposal)}>Edit</button>
              <button type="button" className="btn btn-ghost" disabled={busy}
                      onClick={() => onWithdraw(proposal)}>Withdraw</button>
            </>
          )}
          {decidable && (
            <>
              <button type="button" className="btn btn-danger" disabled={busy}
                      onClick={() => onDecide(proposal, 'reject')}>Reject</button>
              <button type="button" className="btn btn-primary" disabled={busy}
                      onClick={() => onDecide(proposal, 'approve')}>Approve</button>
            </>
          )}
        </div>
      )}
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

  const nothingToPropose = lane !== 'schemas' && Object.keys(values).length === 0

  return (
    <div className="card">
      <div className="card-header">
        <h3 className="section-title">{editing ? 'Edit your proposal' : 'Propose a change'}</h3>
      </div>
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
          {laneDef && <p className="text-muted">{laneDef.blurb}</p>}
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
            <p className="text-muted">
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
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-primary"
                disabled={busy || !target || nothingToPropose}
                onClick={submit}>
          {editing ? 'Save changes' : 'Propose'}
        </button>
      </div>
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

  const open    = useMemo(() => proposals.filter(p => p.status === 'open'), [proposals])
  const decided = useMemo(() => proposals.filter(p => p.status !== 'open'), [proposals])

  // OLDEST FIRST IN THE INBOX, newest first in the history. A queue is worked from the front; a
  // record is read from the most recent.
  const openOrdered = useMemo(
    () => [...open].sort((a, b) => new Date(a.proposed_at) - new Date(b.proposed_at)),
    [open]
  )

  const decide = async (proposal, action, reason) => {
    setBusyId(proposal.id)
    try {
      await api.post(`/api/v1/proposals/${proposal.id}/${action}`, reason ? { reason } : {})
      showToast?.(
        action === 'approve' ? 'Approved, and applied.' : 'Rejected.',
        'success'
      )
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

  if (loading) {
    return <div className="loading-wrap"><div className="spinner" /> Loading proposals…</div>
  }

  return (
    <>
      {(composing || editing) ? (
        <Composer
          devices={devices}
          drafts={drafts}
          editing={editing}
          busy={busyId === 'composer'}
          refusal={refusal}
          onOpenExisting={() => {
            // THE CAP IS ONLY LIVABLE IF THIS IS ONE CLICK. Told "you already have an open
            // proposal on this device", a person has to be able to open that one and add to it --
            // otherwise the constraint reads as a wall and they propose against a neighbouring
            // asset instead, or stop proposing.
            setEditing(refusal.existing)
            setComposing(false)
            setRefusal(null)
          }}
          onCancel={() => { setComposing(false); setEditing(null); setRefusal(null) }}
          onSubmit={submitProposal}
        />
      ) : canPropose && (
        <div className="card-filter-bar">
          <button type="button" className="btn btn-primary" onClick={() => setComposing(true)}>
            Propose a change
          </button>
        </div>
      )}

      <div className="card-header">
        <h3 className="section-title">
          Awaiting a decision <span className="section-count">{openOrdered.length}</span>
        </h3>
      </div>

      {openOrdered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-text">
            Nothing is waiting. A proposal appears here when somebody asks for a change they cannot
            make themselves.
          </div>
        </div>
      ) : openOrdered.map(p => (
        <ProposalCard
          key={p.id}
          proposal={p}
          currentUserId={currentUserId}
          userRole={userRole}
          busyId={busyId}
          onDecide={(proposal, action) => {
            if (action === 'reject') setRejecting(proposal)
            else decide(proposal, 'approve')
          }}
          onWithdraw={withdraw}
          onEdit={proposal => { setEditing(proposal); setComposing(false) }}
        />
      ))}

      {decided.length > 0 && (
        <>
          <div className="card-header">
            <h3 className="section-title">
              Decided <span className="section-count">{decided.length}</span>
            </h3>
          </div>
          {decided.map(p => (
            <ProposalCard
              key={p.id}
              proposal={p}
              currentUserId={currentUserId}
              userRole={userRole}
              busyId={busyId}
              onDecide={() => {}}
              onWithdraw={() => {}}
              onEdit={() => {}}
            />
          ))}
        </>
      )}

      {rejecting && (
        <RejectDialog
          proposal={rejecting}
          busy={busyId === rejecting.id}
          onCancel={() => setRejecting(null)}
          onConfirm={reason => decide(rejecting, 'reject', reason)}
        />
      )}
    </>
  )
}
