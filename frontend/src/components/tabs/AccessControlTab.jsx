import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import CopyableId from '../common/CopyableId'
import { GatewayBundleModal } from '../modals/GatewayBundleModal'
import { GatewayCredentialModal } from '../modals/GatewayCredentialModal'
import { IconArchive, IconDownload, IconLock, IconRefreshCw, IconShieldAlert } from '../common/Icons'
import {
  CREDENTIAL_STATES,
  credentialAction,
  credentialState,
  credentialStateExplanation,
  credentialStateLabel,
  credentialStateTone,
} from '../../utils/credentialState'
import {
  BROKER_PRINCIPALS,
  GATEWAY_ACL_PATTERN,
  describePrincipal,
  roleReach,
} from '../../utils/serviceIdentities'

/**
 * Access Control — broker credentials, and where they came from.
 *
 * =================================================================================================
 * THE GAP THIS CLOSES, in roadmap §13's words: "the only way to see what credentials exist today is
 * to read `.env` and `.env.gateways` on the machine that generated them, which is a file, not a
 * view — and a file that the hand-off checklist explicitly tells you to delete."
 *
 * =================================================================================================
 * WHAT IT DELIBERATELY DOES NOT CLAIM, WHICH IS THE HARDEST PART OF THE PAGE
 *
 * It is not an inventory of the broker. Mosquitto's accounts live in a file reachable only by
 * `gateway-credential-service`, which is add-only and cannot list anything back -- and giving it a
 * LIST verb would hand whoever holds one bearer token the whole account table, which is precisely
 * the drift its header forbids.
 *
 * So this shows what the PLATFORM issued and recorded. The difference shows up immediately on a
 * demonstration stack: `npm run provision:gateways` mints four working credentials through a script,
 * and `record_gateway_credential_issued()` cannot be called on its behalf because `has_role()`
 * resolves through `auth.uid()`, which is NULL for the service-role key. Those four gateways read
 * `No platform record` here and connect perfectly well.
 *
 * THAT IS WHY THE STATE IS NAMED FOR THE RECORD AND NOT FOR THE CREDENTIAL. "No credential" would
 * be a claim about the broker; "No platform record" is a claim about this database, which is the
 * only thing the page can actually see.
 *
 * =================================================================================================
 * ADMINISTRATOR ONLY, gated the same way Settings is -- on the ROLE, not on a permission. The
 * database gates the two RPCs behind this page on `has_role(ARRAY['Administrator',
 * 'Shopfloor_Manager'])`, and the page is narrower than the API on purpose: reading who holds what
 * is an access-control question, and `authz:manage` is the permission that names it.
 */
export function AccessControlTab({ showToast }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [showArchived, setShowArchived] = useState(false)
  const [bundleForGw, setBundleForGw] = useState(null)
  const [credentialForGw, setCredentialForGw] = useState(null)
  const [principals, setPrincipals] = useState([])
  // ITS OWN ERROR, not folded into loadError. The two reads have DIFFERENT authority -- gateway
  // credentials accept Shopfloor_Manager, service principals are Administrator-only (0042) -- so a
  // single error state would blame the whole page for a refusal that applies to one section.
  const [principalError, setPrincipalError] = useState(null)

  const load = useCallback((isInitial = false) => {
    if (isInitial) setLoading(true)
    api.listGatewayCredentials()
      .then(d => { setRows(d); setLoadError(null); setLoading(false) })
      .catch(e => { setLoadError(e?.message || 'Could not read gateway credentials.'); setLoading(false) })

    // NOT AWAITED WITH THE OTHER, and not allowed to fail the page. This section is supplementary:
    // an Administrator who can see it should, and everyone else should still get the credential
    // inventory rather than a blank tab.
    api.listServicePrincipals()
      .then(d => { setPrincipals(d); setPrincipalError(null) })
      .catch(e => { setPrincipals([]); setPrincipalError(e?.message || 'Could not list service principals.') })
  }, [])

  useEffect(() => { load(true) }, [load])

  // NOT REALTIME, and not polled. Nothing on this page changes on its own: a credential changes
  // when somebody on this page changes it, or when a gateway is archived from another tab. A 3s
  // poll would re-read the audit table forever to show the same six rows.
  const visible = useMemo(
    () => rows.filter(r => showArchived || !r.is_archived),
    [rows, showArchived]
  )

  const summary = useMemo(() => {
    const counts = { issued: 0, revoked: 0, unrecorded: 0, awaiting: 0 }
    for (const r of rows.filter(x => !x.is_archived)) {
      const state = credentialState(r, r.issued_at)
      if (state === CREDENTIAL_STATES.ISSUED) counts.issued += 1
      else if (state === CREDENTIAL_STATES.REVOKED) counts.revoked += 1
      else if (state === CREDENTIAL_STATES.AWAITING_ENROLMENT) counts.awaiting += 1
      else counts.unrecorded += 1
    }
    return counts
  }, [rows])

  const archivedCount = useMemo(() => rows.filter(r => r.is_archived).length, [rows])

  const afterAction = useCallback(() => {
    setCredentialForGw(null)
    setBundleForGw(null)
    load()
  }, [load])

  if (loading) {
    return (
      <div className="page-layout"><div className="page-main">
        <div className="card" style={{ padding: '16px' }}>
          <div className="loading-wrap"><div className="spinner" /> Loading credentials…</div>
        </div>
      </div></div>
    )
  }

  return (
    <div className="page-layout">
      <div className="page-main">
        {/* ONE CARD FOR ONE LIST -- title, description, controls and rows -- which is the Schemas
            page's shape and the one the rest of the app uses. This was three stacked cards for a
            single table: three borders, three sets of padding, and a heading separated from the
            rows it describes by a control bar in its own box.

            THE PAGE STILL STATES ITS OWN LIMIT BEFORE THE FIRST ROW, which is the part that has to
            survive the tidying: somebody arriving to answer "does this gateway have a credential"
            needs to know what this page can and cannot see BEFORE they read a row, not after they
            have acted on one. */}
        <div className="card" style={{ overflowX: 'auto' }}>
          <div style={{ padding: '14px 14px 0' }}>
            <div className="settings-preamble-title" style={{ marginBottom: '8px' }}>
              <IconLock size={15} /> Broker credentials
            </div>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '0 0 6px' }}>
              Every gateway authenticates to the broker as its own Sparkplug ID — the ACL pins the
              topic’s edge-node segment to the connecting username, so no two gateways can share a
              connection. This page shows what the platform has issued, and gives you the two ways
              to issue one.
            </p>
            <p className="settings-preamble-warning" style={{ fontSize: '12px', margin: 0 }}>
              <strong>This is not an inventory of the broker.</strong> Mosquitto’s account file can
              only be added to, never read back, so a gateway showing{' '}
              <em>No platform record</em> may still hold a working credential — the ones{' '}
              <code>npm run provision:gateways</code> creates are issued outside the dashboard and
              leave no record here.
            </p>
          </div>

          {loadError && (
            <div style={{ padding: '10px 14px', color: 'var(--danger)', fontSize: '12px' }}>
              <IconShieldAlert size={13} /> {loadError}
            </div>
          )}

          {/* THE SHAPE EVERY OTHER PAGE USES: what you are looking at on the left, what you are
              looking for on the right. The archived toggle is the Devices page's "Needs attention"
              control -- a btn-sm switching between btn-primary and btn-ghost and carrying its own
              count -- rather than a bare checkbox, which was the only control of its kind in the
              app and read as a form field rather than as a filter. */}
          <div className="filter-bar" style={{ marginTop: '10px' }}>
            <div style={{ display: 'flex', gap: '14px', fontSize: '12px', color: 'var(--text-muted)' }}>
              <span><strong style={{ color: 'var(--text-primary)' }}>{summary.issued}</strong> issued</span>
              <span><strong style={{ color: 'var(--text-primary)' }}>{summary.awaiting}</strong> bundle outstanding</span>
              <span><strong style={{ color: 'var(--text-primary)' }}>{summary.revoked}</strong> revoked</span>
              <span><strong style={{ color: 'var(--text-primary)' }}>{summary.unrecorded}</strong> no record</span>
            </div>

            <div className="filter-bar-spacer" style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              <button
                className={`btn btn-sm ${showArchived ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setShowArchived(v => !v)}
                aria-pressed={showArchived}
                title="Archived gateways keep their row and their history, and 0038 has already rotated their broker credential to a password nobody holds. They can be issued a new one only after being restored."
              >
                <IconArchive size={13} /> Archived ({archivedCount})
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => load()} title="Re-read credentials">
                <IconRefreshCw size={13} /> Refresh
              </button>
            </div>
          </div>

          <table className="data-table">
            <thead>
              <tr>
                <th>Gateway</th>
                <th>Kind</th>
                <th>MQTT username</th>
                <th>Credential</th>
                <th style={{ textAlign: 'right' }}>Issue</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr><td colSpan={5} style={{ color: 'var(--text-muted)', padding: '14px' }}>
                  No gateways registered. Create one on the Gateways tab, or run{' '}
                  <code>npm run provision:gateways</code> for the demonstration shopfloor.
                </td></tr>
              )}
              {visible.map(g => {
                const state = credentialState(g, g.issued_at)
                const action = credentialAction(g)
                return (
                  <tr key={g.id}>
                    <td>
                      <div>{g.name}</div>
                      {g.is_archived && (
                        <span className="badge badge-neutral" style={{ fontSize: '11px' }}>ARCHIVED</span>
                      )}
                    </td>
                    <td>
                      <span className="badge badge-neutral" style={{ fontSize: '11px' }}>
                        {g.is_virtual ? '⚡ VIRTUAL' : 'PHYSICAL'}
                      </span>
                    </td>
                    {/* THE USERNAME IS THE WIRE IDENTITY, not a display name -- and it is the one
                        value on this page an operator retypes elsewhere, into a broker node's
                        credential pair. Click-to-copy for the same reason every other identifier in
                        the app has it: a 24-character string transcribed by eye is a gateway that
                        authenticates and then has every publish silently dropped by the ACL. */}
                    <td>
                      <CopyableId
                        value={g.sparkplug_id}
                        label="MQTT username"
                        title={`Copy ${g.sparkplug_id} — the username this gateway authenticates as`}
                        onNotify={showToast}
                      />
                    </td>
                    <td>
                      {/* The badge carries the explanation as its title as well, so the meaning is
                          reachable from the row without the legend having to be on screen. */}
                      <span
                        className={`badge badge-${credentialStateTone(state)}`}
                        style={{ fontSize: '11px' }}
                        title={credentialStateExplanation(state, g)}
                      >
                        {credentialStateLabel(state)}
                      </span>
                      {(g.issued_at || g.enrolled_at) && state !== CREDENTIAL_STATES.REVOKED && (
                        <div style={{ color: 'var(--text-muted)', fontSize: '11px', marginTop: '4px' }}>
                          {new Date(g.issued_at || g.enrolled_at).toLocaleString()}
                        </div>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {action === 'mint' && (
                        <button
                          className="btn btn-ghost"
                          onClick={() => setCredentialForGw({
                            gateway_id: g.id, gateway_name: g.name, sparkplug_id: g.sparkplug_id
                          })}
                          title="Mint a broker credential and show it once"
                        >
                          <IconLock size={13} /> Generate
                        </button>
                      )}
                      {action === 'bundle' && (
                        <button
                          className="btn btn-ghost"
                          onClick={() => setBundleForGw({
                            gateway_id: g.id,
                            gateway_name: g.name,
                            sparkplug_id: g.sparkplug_id,
                            status: g.status,
                            confirmFirst: true
                          })}
                          title="Generate the bootstrap bundle; the appliance mints its own credential"
                        >
                          <IconDownload size={13} /> Bundle
                        </button>
                      )}
                      {!action && (
                        <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
                          Restore to issue
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* =========================================================================================
            SERVICE IDENTITIES -- the second half of the page, and the half that is TWO LISTS rather
            than one. Nothing holds an identity on both planes, which is the fact worth showing: the
            ingestion daemon connects to the broker as `factoryplus_ingestion` and reaches the
            database with the service-role key, which is not an identity at all.
            ========================================================================================= */}
        <div className="settings-preamble card" style={{ marginTop: '20px' }}>
          <div className="settings-preamble-title">
            <IconLock size={15} /> Service identities
          </div>
          <p>
            The non-human clients that can reach this stack. They are two separate lists because they
            live on two separate planes — a database identity is a role, a broker identity is an ACL
            entry, and nothing here holds both.
          </p>
        </div>

        {/* THE SAME COLUMN RHYTHM AS THE CREDENTIALS TABLE ABOVE, because it is the same kind of
            question: an identity, what it holds, what that reaches, and where it comes from. These
            were stacked prose, which meant every row repeated the label words ("The identity…",
            "Reaches:", "Token minted by") that one header says once. */}
        <div className="card" style={{ marginTop: '12px', overflowX: 'auto' }}>
          <div style={{ fontWeight: 600, fontSize: '13px', padding: '12px 12px 0' }}>Database principals</div>
          {principalError && (
            <div style={{ color: 'var(--text-muted)', fontSize: '12px', padding: '8px 12px 12px' }}>
              <IconShieldAlert size={12} /> {principalError}
            </div>
          )}
          {!principalError && (
            <table className="data-table" style={{ marginTop: '8px' }}>
              <thead>
                <tr>
                  <th>Identity</th>
                  {/* ITS OWN COLUMN, matching how the Schemas page treats a schema UUID. It was
                      stacked under the name, which made it read as a subtitle rather than as the
                      value a JWT's `sub` claim has to equal. */}
                  <th>Principal ID</th>
                  <th>Holds</th>
                  <th>Reaches</th>
                  <th>Token minted by</th>
                </tr>
              </thead>
              <tbody>
                {principals.length === 0 && (
                  <tr><td colSpan={5} style={{ color: 'var(--text-muted)', padding: '14px' }}>
                    No machine identities are registered. Every account on this stack belongs to a person.
                  </td></tr>
                )}
                {principals.map(p => {
                  const meta = describePrincipal(p.principal_id)
                  return (
                    <tr key={p.principal_id}>
                      {/* THE PURPOSE IS A TOOLTIP NOW. It is three lines of background on a row whose
                          other four columns are the answer -- what it holds, what that reaches, and
                          where its token comes from. Read once and then in the way every time after,
                          which is what a tooltip is for.

                          The dotted underline is what says there is something to hover. A title on a
                          plain span is invisible, and an affordance nobody can see is not one. */}
                      <td>
                        <span
                          title={meta.purpose}
                          style={{
                            fontWeight: 600,
                            textDecoration: 'underline dotted var(--text-muted)',
                            textUnderlineOffset: '3px',
                            cursor: 'help',
                          }}
                        >
                          {meta.name}
                        </span>
                      </td>
                      <td>
                        <CopyableId
                          value={p.principal_id}
                          label="principal id"
                          title={`Copy ${p.principal_id} — the subject a token for this identity must name`}
                          onNotify={showToast}
                        />
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                          {(p.roles || []).map(r => (
                            <span key={r} className="badge badge-neutral" style={{ fontSize: '11px' }}>{r}</span>
                          ))}
                          {/* STATED, NOT ASSUMED. It is the property that makes listing these safe,
                              and 0042 returns it rather than letting the page infer it from the
                              predicate it selected on. */}
                          {p.can_sign_in === false && (
                            <span className="badge badge-ok" style={{ fontSize: '11px' }}>CANNOT SIGN IN</span>
                          )}
                        </div>
                      </td>
                      <td style={{ fontSize: '12px', color: 'var(--text-muted)', maxWidth: '46ch' }}>
                        {roleReach(p.roles)}
                      </td>
                      <td className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                        {meta.mintedBy || '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="card" style={{ marginTop: '12px', overflowX: 'auto' }}>
          <div style={{ fontWeight: 600, fontSize: '13px', padding: '12px 12px 0' }}>Broker principals</div>
          {/* DECLARED IN THE REPOSITORY, NOT FETCHED, and the page says so rather than implying a
              live read. Mosquitto has no API that lists its principals; check-docs-drift asserts
              this list against mosquitto.acl, in both directions and including the topic rules. */}
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '6px 12px 0' }}>
            Read from <code>mosquitto.acl</code> in the repository — the broker has no API that lists
            these, so they are declared alongside the file and checked against it at build time.
          </div>
          <table className="data-table" style={{ marginTop: '8px' }}>
            <thead>
              <tr>
                <th>Principal</th>
                <th>Access</th>
                <th>Topic rules</th>
                <th>Purpose</th>
              </tr>
            </thead>
            <tbody>
              {BROKER_PRINCIPALS.map(bp => (
                <tr key={bp.username}>
                  <td className="mono" style={{ fontSize: '12px' }}>{bp.username}</td>
                  <td>
                    <span className={`badge badge-${bp.writes ? 'pending' : 'ok'}`} style={{ fontSize: '11px' }}>
                      {bp.writes ? 'CAN PUBLISH' : 'READ ONLY'}
                    </span>
                  </td>
                  {/* THE ACL'S OWN STRINGS, not a paraphrase: somebody comparing this page against
                      the file should be reading the same text on both sides. */}
                  <td className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'pre-line' }}>
                    {bp.topics.join('\n')}
                  </td>
                  <td style={{ fontSize: '12px', color: 'var(--text-muted)', maxWidth: '46ch' }}>{bp.purpose}</td>
                </tr>
              ))}
              {/* A ROW, NOT A TRAILING BLOCK. It is not a principal -- there is no account by this
                  name -- but it IS an entry in the same file granting the same kind of thing, and
                  rendering it as an orphaned paragraph made it read as a footnote rather than as
                  the rule most of the fleet actually connects under. The badge says what it is. */}
              <tr>
                <td style={{ fontWeight: 600 }}>Every gateway</td>
                <td>
                  <span className="badge badge-neutral" style={{ fontSize: '11px' }}>ACL PATTERN</span>
                </td>
                <td className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  pattern {GATEWAY_ACL_PATTERN.pattern}
                </td>
                <td style={{ fontSize: '12px', color: 'var(--text-muted)', maxWidth: '46ch' }}>
                  {GATEWAY_ACL_PATTERN.purpose}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {credentialForGw && (
        <GatewayCredentialModal
          gateway={credentialForGw}
          onClose={afterAction}
          showToast={showToast}
        />
      )}

      {bundleForGw && (
        <GatewayBundleModal
          gateway={bundleForGw}
          confirmFirst={bundleForGw.confirmFirst}
          onClose={afterAction}
          showToast={showToast}
        />
      )}
    </div>
  )
}
